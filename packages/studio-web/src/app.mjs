// The Lilac editor. It holds a read-only copy of the open project's document and never
// changes it on its own: every edit goes to the studio host as one history transaction, and
// the copy advances only by applying the host's committed change events (from the edit's
// response or the event stream, whichever arrives first), in revision order. A gap or a
// change that does not apply means the copy is out of date, and it is fetched again.

import { mountCanvas, insertNode, removeNodes, setStyle, setText } from "/packages/canvas/src/index.mjs";
import { applyTransaction } from "/packages/history/src/index.mjs";
import { HostError, connect, forgetToken } from "/packages/studio-web/src/client.mjs";

const $ = (id) => document.getElementById(id);
const el = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    if (name === "class") node.className = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
};

const MAX_HISTORY_SHOWN = 200;
const STYLE_FIELDS = [
  ["left", "X"], ["top", "Y"], ["width", "Width"], ["height", "Height"],
  ["background", "Fill"], ["color", "Text colour"], ["font-size", "Font size"],
];

const state = {
  client: null,
  user: { actorId: "local-user", displayName: "You" },
  project: null,
  revision: 0,
  document: null,
  selection: [],
  canUndo: false,
  canRedo: false,
  history: [],
  seen: new Set(),
  collapsed: new Set(),
  focusedLayer: null,
  queue: Promise.resolve(),
  events: null,
};
let canvas = null;

// ---------- status and dialogs ----------

function setStatus(message) {
  $("status").textContent = message;
}

function describeError(error) {
  return error instanceof HostError ? error.message : "The studio host could not be reached.";
}

/** Show a modal dialog; `build(close)` returns its content. Focus returns where it was. */
function showDialog(title, build, { dismissable = true } = {}) {
  const dialog = $("dialog");
  const returnFocus = document.activeElement;
  const close = () => {
    if (dialog.open) dialog.close();
  };
  dialog.replaceChildren(el("h2", { id: "dialog-title" }, title), el("div", { id: "dialog-body" }, build(close)));
  dialog.oncancel = (event) => {
    if (!dismissable) event.preventDefault();
  };
  dialog.onclose = () => {
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
  };
  if (!dialog.open) dialog.showModal();
  const first = dialog.querySelector("[autofocus], input, button");
  first?.focus();
  return close;
}

function closeDialog() {
  const dialog = $("dialog");
  if (dialog.open) dialog.close();
}

// ---------- projects ----------

async function openProjectsDialog() {
  let projects = [];
  let loadError = null;
  try {
    projects = (await state.client.get("/api/projects")).projects;
  } catch (error) {
    loadError = describeError(error);
  }
  showDialog("Projects", (close) => {
    const error = el("p", { class: "error", role: "alert" });
    const name = el("input", { id: "new-project-name", name: "name", required: true, autocomplete: "off", pattern: "[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}", "aria-describedby": "new-project-hint" });
    const create = el("form", {
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = "";
        try {
          await state.client.post("/api/projects/create", { name: name.value.trim() });
          close();
          await loadProject();
        } catch (failure) {
          error.textContent = describeError(failure);
        }
      },
    },
    el("label", { for: "new-project-name" }, "New project name", name),
    el("small", { id: "new-project-hint" }, "Letters, digits, dots, dashes and underscores."),
    el("div", { class: "actions" }, el("button", { type: "submit", class: "primary" }, "Create project")));
    const list = projects.length === 0
      ? el("p", {}, loadError ?? "There are no projects yet.")
      : el("ul", { class: "project-list", "aria-label": "Existing projects" }, projects.map((project) => el("li", {},
        el("button", { type: "button", "data-project": project, onclick: () => openProject(project, error, close) }, project))));
    return [list, create, error, el("div", { class: "actions" }, el("button", { type: "button", onclick: close }, "Close"))];
  });
}

async function openProject(name, errorNode, close, breakStaleLock) {
  errorNode.textContent = "";
  try {
    await state.client.post("/api/projects/open", { name, ...(breakStaleLock ? { breakStaleLock } : {}) });
    close();
    await loadProject();
  } catch (error) {
    if (error instanceof HostError && error.code === "project-locked") {
      close();
      showLockDialog(name);
    } else {
      errorNode.textContent = describeError(error);
    }
  }
}

function showLockDialog(name) {
  showDialog("This project is open elsewhere", (close) => {
    const error = el("p", { class: "error", role: "alert" });
    const reason = el("input", { id: "lock-reason", name: "reason", required: true, autocomplete: "off" });
    return [
      el("p", {}, `“${name}” is locked by another Lilac session. If that session has crashed or its computer is gone, you can take over the project. The takeover and your reason are recorded with the project.`),
      el("form", {
        onsubmit: async (event) => {
          event.preventDefault();
          if (reason.value.trim() === "") {
            error.textContent = "Give a reason for taking over the project.";
            reason.focus();
            return;
          }
          await openProject(name, error, close, { reason: reason.value.trim() });
        },
      },
      el("label", { for: "lock-reason" }, "Reason for taking over", reason),
      el("div", { class: "actions" },
        el("button", { type: "button", onclick: close }, "Cancel"),
        el("button", { type: "submit", class: "danger" }, "Take over project"))),
      error,
    ];
  });
}

function recoveryNotes(recovery) {
  if (!recovery) return [];
  const notes = [];
  if (recovery.tornTailBytes > 0) notes.push(`An unfinished write at the end of the project's history was discarded (${recovery.tornTailBytes} bytes). Every completed change is intact.`);
  if (recovery.staleTemporaryFiles > 0) notes.push(`${recovery.staleTemporaryFiles} temporary file(s) left by an interrupted save were removed.`);
  if (recovery.migratedFrom !== null && recovery.migratedFrom !== undefined) notes.push(`The project was upgraded from format version ${recovery.migratedFrom}.`);
  if (recovery.lockOverride) notes.push(`A stale lock held by ${recovery.lockOverride.previous?.owner ?? "another session"} was taken over: ${recovery.lockOverride.reason}.`);
  return notes;
}

function showRecovery(recovery) {
  const notes = recoveryNotes(recovery);
  if (notes.length === 0) return;
  showDialog("Lilac recovered this project", (close) => [
    el("ul", { class: "report" }, notes.map((note) => el("li", {}, note))),
    el("div", { class: "actions" }, el("button", { type: "button", class: "primary", onclick: close }, "Continue")),
  ]);
}

function showReopen(message) {
  showDialog("Reopen the project", (close) => {
    const error = el("p", { class: "error", role: "alert" });
    return [
      el("p", {}, message ?? "The project's files changed outside Lilac or could not be written. Reopen it to continue; every change that was saved is kept."),
      error,
      el("div", { class: "actions" },
        el("button", { type: "button", onclick: () => { close(); openProjectsDialog(); } }, "Projects"),
        el("button", { type: "button", class: "primary", onclick: () => openProject(state.project, error, close) }, "Reopen")),
    ];
  }, { dismissable: false });
}

// ---------- loading and applying changes ----------

async function loadProject() {
  const session = await state.client.get("/api/session");
  state.user = session.user ?? state.user;
  if (session.project === null) {
    clearProject();
    return session;
  }
  state.project = session.project;
  if (session.failure) {
    renderChrome();
    showReopen(session.failure);
    return session;
  }
  await resync();
  showRecovery(session.recovery);
  return session;
}

function clearProject() {
  state.project = null;
  state.document = null;
  state.revision = 0;
  state.selection = [];
  state.history = [];
  state.seen.clear();
  canvas.setDocument({ schemaVersion: 1, id: "none", name: "", revision: 0, rootIds: [], nodes: {}, metadata: {} });
  renderAll();
}

/** Fetch the document and history again: the copy is replaced, never merged. */
async function resync() {
  const [{ revision, document: next }, { entries }, session] = await Promise.all([
    state.client.get("/api/document"),
    state.client.get("/api/history"),
    state.client.get("/api/session"),
  ]);
  state.revision = revision;
  state.document = next;
  state.history = entries.slice(-MAX_HISTORY_SHOWN);
  state.seen = new Set(entries.map((entry) => entry.transactionId));
  state.canUndo = Boolean(session.canUndo);
  state.canRedo = Boolean(session.canRedo);
  canvas.setDocument(next);
  state.selection = canvas.selection;
  renderAll();
}

let resyncing = null;
function requestResync() {
  resyncing ??= resync().catch((error) => setStatus(describeError(error))).finally(() => {
    resyncing = null;
  });
  return resyncing;
}

/** Apply one committed change event to the local copy, in revision order. */
function applyChange(event) {
  if (state.document === null || event.revision <= state.revision) return; // already applied
  if (event.revision !== state.revision + 1) {
    requestResync();
    return;
  }
  let result;
  try {
    result = applyTransaction(state.document, { id: event.transactionId, actor: event.actor, operations: event.operations }, { enforceBaseRevision: false });
  } catch {
    requestResync();
    return;
  }
  state.document = result.document;
  state.revision = event.revision;
  if (!state.seen.has(event.transactionId)) {
    state.seen.add(event.transactionId);
    const { operations: _operations, ...summary } = event;
    state.history.push(summary);
    if (state.history.length > MAX_HISTORY_SHOWN) state.history.shift();
  }
  canvas.update(state.document, result.affectedNodeIds);
  state.selection = canvas.selection;
  if (event.actor === state.user.actorId) {
    // Only this user's own changes move this user's undo and redo stacks.
    refreshUndoState();
  }
  renderAll();
}

async function refreshUndoState() {
  try {
    const session = await state.client.get("/api/session");
    state.canUndo = Boolean(session.canUndo);
    state.canRedo = Boolean(session.canRedo);
    renderToolbar();
  } catch {
    // The next change refreshes it.
  }
}

/** Run host calls one at a time, so each edit's base revision is the latest applied one. */
function enqueue(task) {
  const run = state.queue.then(task, task);
  state.queue = run.catch(() => {});
  return run;
}

function handleEditError(error) {
  if (error instanceof HostError) {
    if (error.code === "project-needs-reopen") {
      showReopen(error.message);
      return;
    }
    if (error.code === "stale-revision") {
      setStatus("The project changed before your edit arrived, so it was not applied. Try it again.");
      requestResync();
      return;
    }
    if (error.code === "undo-conflict" || error.code === "redo-conflict") {
      setStatus("A later change touches the same layers, so this cannot be undone or redone now.");
      return;
    }
  }
  setStatus(describeError(error));
  requestResync();
}

/**
 * Commit `operations` (computed from the document at `computedAt`) as one transaction. An
 * edit computed from a copy that has since moved on is dropped rather than sent.
 */
function commit(operations, intent, computedAt = state.document?.revision) {
  if (operations.length === 0) return Promise.resolve(null);
  return enqueue(async () => {
    if (state.document === null || computedAt !== state.document.revision) {
      setStatus("The project changed while you were editing, so that edit was not applied. Try it again.");
      return null;
    }
    try {
      const event = await state.client.post("/api/edit", { baseRevision: state.revision, operations, intent });
      applyChange(event);
      setStatus(intent ? `${intent}.` : "Changed.");
      return event;
    } catch (error) {
      handleEditError(error);
      return null;
    }
  });
}

function undoRedo(kind) {
  return enqueue(async () => {
    if (state.document === null) return;
    try {
      const event = await state.client.post(`/api/${kind}`);
      applyChange(event);
      setStatus(event.intent ? `${event.intent}.` : kind === "undo" ? "Undone." : "Redone.");
    } catch (error) {
      if (error instanceof HostError && (error.code === "nothing-to-undo" || error.code === "nothing-to-redo")) {
        setStatus(kind === "undo" ? "Nothing to undo." : "Nothing to redo.");
        refreshUndoState();
      } else {
        handleEditError(error);
      }
    }
  });
}

function save() {
  return enqueue(async () => {
    if (state.document === null) return;
    try {
      const { revision } = await state.client.post("/api/checkpoint");
      setStatus(`Saved. Every change is kept in the project's history; this saved a snapshot at revision ${revision}.`);
    } catch (error) {
      handleEditError(error);
    }
  });
}

function listenForChanges() {
  state.events?.close();
  const events = state.client.events();
  state.events = events;
  let dropped = false;
  events.addEventListener("change", (message) => {
    try {
      applyChange(JSON.parse(message.data));
    } catch {
      requestResync();
    }
  });
  events.addEventListener("project", (message) => {
    let info;
    try {
      info = JSON.parse(message.data);
    } catch {
      return;
    }
    if (info.failure && info.project === state.project) showReopen(info.failure);
    else if (info.project !== state.project) loadProject().catch((error) => setStatus(describeError(error)));
  });
  events.addEventListener("error", () => {
    dropped = true;
  });
  events.addEventListener("open", () => {
    // Changes may have been missed while the stream was down.
    if (dropped && state.document !== null) requestResync();
    dropped = false;
  });
}

// ---------- editing commands ----------

let counter = 0;
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function insert(kind) {
  if (state.document === null) return;
  const doc = state.document;
  const operations = [];
  let parentId = null;
  const selected = state.selection.length === 1 ? doc.nodes[state.selection[0]] : null;
  if (selected && selected.type !== "text") parentId = selected.id;
  else if (doc.rootIds.length > 0) parentId = doc.rootIds[0];
  else {
    // An empty project gets a page to hold its first layer.
    const pageId = newId("page");
    operations.push(...insertNode(null, 0, { id: pageId, type: "frame", tag: "main", style: { position: "relative", width: "800px", height: "600px", background: "#ffffff" } }));
    parentId = pageId;
  }
  const index = parentId === null ? doc.rootIds.length : (doc.nodes[parentId]?.children.length ?? 0);
  const id = newId(kind === "text" ? "text" : "box");
  operations.push(...(kind === "text"
    ? insertNode(parentId, index, { id, type: "text", tag: "p", text: "Text", style: { position: "absolute", left: "32px", top: "32px", margin: "0px", "font-size": "16px" } })
    : insertNode(parentId, index, { id, type: "element", tag: "div", style: { position: "absolute", left: "32px", top: "32px", width: "160px", height: "100px", background: "#d9d2ff" } })));
  commit(operations, kind === "text" ? "Insert text" : "Insert box").then((event) => {
    if (event) selectLayers([id]);
  });
}

function deleteSelection() {
  if (state.document === null || state.selection.length === 0) return;
  commit(removeNodes(state.document, state.selection), state.selection.length === 1 ? "Delete layer" : "Delete layers");
}

function selectLayers(ids) {
  canvas.select(ids);
  state.selection = canvas.selection;
  if (state.selection.length > 0) state.focusedLayer = state.selection.at(-1);
  renderLayers();
  renderInspector();
  renderToolbar();
}

// ---------- rendering ----------

function layerLabel(node) {
  const name = typeof node.props?.name === "string" && node.props.name.trim() !== "" ? node.props.name : null;
  if (name) return name;
  const text = typeof node.props?.text === "string" && node.props.text.trim() !== "" ? ` “${node.props.text.trim().slice(0, 24)}”` : "";
  const tag = typeof node.props?.tag === "string" ? node.props.tag : node.type;
  return `${tag}${text}`;
}

/** The visible layers in tree order: [{ id, level, parentId, hasChildren }]. */
function visibleLayers() {
  const out = [];
  const doc = state.document;
  if (doc === null) return out;
  const walk = (ids, level, parentId) => {
    for (const id of ids) {
      const node = doc.nodes[id];
      if (!node) continue;
      out.push({ id, level, parentId, hasChildren: node.children.length > 0 });
      if (node.children.length > 0 && !state.collapsed.has(id)) walk(node.children, level + 1, id);
    }
  };
  walk(doc.rootIds, 1, null);
  return out;
}

function renderLayers() {
  const tree = $("layers");
  const hadFocus = tree.contains(document.activeElement);
  const doc = state.document;
  const visible = visibleLayers();
  $("layers-empty").hidden = doc === null || doc.rootIds.length > 0;
  if (doc === null) {
    tree.replaceChildren();
    return;
  }
  if (!visible.some((layer) => layer.id === state.focusedLayer)) state.focusedLayer = state.selection.find((id) => visible.some((layer) => layer.id === id)) ?? visible[0]?.id ?? null;
  const selected = new Set(state.selection);
  const build = (ids, level) => ids.filter((id) => doc.nodes[id]).map((id) => {
    const node = doc.nodes[id];
    const expanded = node.children.length > 0 ? !state.collapsed.has(id) : null;
    const item = el("li", {
      role: "treeitem",
      id: `layer-${id}`,
      "data-node-id": id,
      "aria-level": level,
      "aria-selected": selected.has(id) ? "true" : "false",
      "aria-expanded": expanded === null ? null : String(expanded),
      tabindex: id === state.focusedLayer ? "0" : "-1",
    }, el("span", { class: "row", style: `padding-left:${6 + (level - 1) * 14}px` },
      el("span", { class: "twisty", "aria-hidden": "true" }, expanded === null ? "" : expanded ? "▾" : "▸"),
      el("span", { class: "label" }, layerLabel(node))));
    if (expanded) item.append(el("ul", { role: "group", class: "children" }, build(node.children, level + 1)));
    return item;
  });
  tree.replaceChildren(...build(doc.rootIds, 1));
  if (hadFocus && state.focusedLayer !== null) $(`layer-${state.focusedLayer}`)?.focus();
}

function focusLayer(id) {
  state.focusedLayer = id;
  for (const item of $("layers").querySelectorAll("[role=treeitem]")) item.tabIndex = item.dataset.nodeId === id ? 0 : -1;
  $(`layer-${id}`)?.focus();
}

function onLayersKey(event) {
  const visible = visibleLayers();
  const at = visible.findIndex((layer) => layer.id === state.focusedLayer);
  if (at < 0) return;
  const current = visible[at];
  const handled = () => {
    event.preventDefault();
    event.stopPropagation();
  };
  switch (event.key) {
    case "ArrowDown":
      handled();
      if (at + 1 < visible.length) focusLayer(visible[at + 1].id);
      break;
    case "ArrowUp":
      handled();
      if (at > 0) focusLayer(visible[at - 1].id);
      break;
    case "Home":
      handled();
      focusLayer(visible[0].id);
      break;
    case "End":
      handled();
      focusLayer(visible.at(-1).id);
      break;
    case "ArrowRight":
      handled();
      if (current.hasChildren && state.collapsed.has(current.id)) {
        state.collapsed.delete(current.id);
        renderLayers();
      } else if (current.hasChildren) focusLayer(visible[at + 1].id);
      break;
    case "ArrowLeft":
      handled();
      if (current.hasChildren && !state.collapsed.has(current.id)) {
        state.collapsed.add(current.id);
        renderLayers();
      } else if (current.parentId !== null) focusLayer(current.parentId);
      break;
    case "Enter":
    case " ": {
      handled();
      const extend = event.shiftKey || event.ctrlKey || event.metaKey;
      const ids = extend
        ? (state.selection.includes(current.id) ? state.selection.filter((id) => id !== current.id) : [...state.selection, current.id])
        : [current.id];
      selectLayers(ids);
      focusLayer(current.id);
      break;
    }
    case "Delete":
    case "Backspace":
      handled();
      deleteSelection();
      break;
    default:
  }
}

function onLayersClick(event) {
  const item = event.target.closest("[role=treeitem]");
  if (!item) return;
  const id = item.dataset.nodeId;
  const extend = event.shiftKey || event.ctrlKey || event.metaKey;
  selectLayers(extend ? (state.selection.includes(id) ? state.selection.filter((other) => other !== id) : [...state.selection, id]) : [id]);
  focusLayer(id);
}

function renderInspector() {
  const form = $("inspector");
  const doc = state.document;
  // Keep what someone is typing when a change from elsewhere redraws the inspector.
  const active = form.contains(document.activeElement) ? document.activeElement : null;
  const typing = active && active.dataset.original !== undefined && active.value !== active.dataset.original
    ? { field: active.name, value: active.value, node: form.dataset.nodeId }
    : null;
  const activeField = active?.name ?? null;
  if (doc === null || state.selection.length !== 1 || !doc.nodes[state.selection[0]]) {
    delete form.dataset.nodeId;
    form.replaceChildren(el("p", {}, doc === null ? "Open a project to start." : state.selection.length > 1 ? `${state.selection.length} layers selected.` : "Select a layer to edit it."));
    return;
  }
  const node = doc.nodes[state.selection[0]];
  form.dataset.nodeId = node.id;
  const style = node.props?.style && typeof node.props.style === "object" ? node.props.style : {};
  const field = (name, label, value, multiline = false) => {
    const id = `inspect-${name}`;
    const input = multiline
      ? el("textarea", { id, name, rows: 3 })
      : el("input", { id, name, type: "text", autocomplete: "off", spellcheck: "false" });
    input.value = value ?? "";
    input.dataset.original = input.value;
    return el("label", { for: id }, label, input);
  };
  const children = [field("name", "Layer name", typeof node.props?.name === "string" ? node.props.name : "")];
  if (node.type === "text" || typeof node.props?.text === "string") children.push(field("text", "Text", typeof node.props?.text === "string" ? node.props.text : "", true));
  const styleFields = STYLE_FIELDS.map(([name, label]) => field(`style:${name}`, label, typeof style[name] === "string" ? style[name] : ""));
  children.push(el("div", { class: "pair" }, styleFields.slice(0, 2)), el("div", { class: "pair" }, styleFields.slice(2, 4)), ...styleFields.slice(4));
  form.replaceChildren(...children);
  if (typing && typing.node === node.id) {
    const input = form.elements.namedItem(typing.field);
    if (input) input.value = typing.value;
  }
  if (activeField) form.elements.namedItem(activeField)?.focus();
}

function onInspectorChange(event) {
  const input = event.target;
  const nodeId = $("inspector").dataset.nodeId;
  if (!nodeId || !state.document?.nodes[nodeId] || input.value === input.dataset.original) return;
  const value = input.value.trim();
  input.dataset.original = input.value;
  if (input.name === "name") commit([{ type: "set-props", nodeId, ...(value === "" ? { set: {}, unset: ["name"] } : { set: { name: value } }) }], "Rename layer");
  else if (input.name === "text") commit(setText(nodeId, input.value), "Edit text");
  else if (input.name.startsWith("style:")) {
    const property = input.name.slice(6);
    const normalized = /^-?\d+(\.\d+)?$/u.test(value) && property !== "background" && property !== "color" ? `${value}px` : value;
    commit(setStyle(state.document, nodeId, { [property]: normalized === "" ? null : normalized }), "Change style");
  }
}

function actorLabel(entry) {
  if (entry.actor === state.user.actorId) return state.user.displayName ?? "You";
  return entry.actor;
}

function renderHistory() {
  const list = $("history");
  if (state.document === null) {
    list.replaceChildren();
    return;
  }
  list.replaceChildren(...[...state.history].reverse().map((entry) => el("li", { class: entry.actorKind === "agent" ? "agent" : "user", "data-transaction": entry.transactionId },
    el("span", { class: "intent" }, entry.intent ?? "Edit"),
    el("span", { class: "who" },
      actorLabel(entry),
      entry.actorKind === "agent" ? el("span", { class: "kind" }, " · agent") : null,
      entry.tool && !entry.tool.startsWith("lilac:") ? ` · ${entry.tool}` : null,
      ` · revision ${entry.revision}`))));
  if (state.history.length === 0) list.replaceChildren(el("li", {}, el("span", { class: "who" }, "No changes since this project was opened.")));
}

function renderToolbar() {
  const open = state.document !== null;
  $("project-name").textContent = state.project ?? "No project open";
  $("action-undo").disabled = !open || !state.canUndo;
  $("action-redo").disabled = !open || !state.canRedo;
  $("action-insert-box").disabled = !open;
  $("action-insert-text").disabled = !open;
  $("action-delete").disabled = !open || state.selection.length === 0;
  $("action-save").disabled = !open;
  $("zoom-level").textContent = `${Math.round(canvas.viewport.zoom * 100)}%`;
  $("revision").textContent = open ? `Revision ${state.revision}` : "";
  document.title = state.project ? `${state.project} — Lilac` : "Lilac";
}

function renderChrome() {
  renderToolbar();
}

function renderAll() {
  renderToolbar();
  renderLayers();
  renderInspector();
  renderHistory();
}

// ---------- wiring ----------

function isTextInput(target) {
  return target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
}

function onGlobalKey(event) {
  if ($("dialog").open) return;
  const mod = event.ctrlKey || event.metaKey;
  if (!mod || isTextInput(event.target)) return;
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) {
    event.preventDefault();
    undoRedo("undo");
  } else if ((key === "z" && event.shiftKey) || key === "y") {
    event.preventDefault();
    undoRedo("redo");
  } else if (key === "s") {
    event.preventDefault();
    save();
  }
}

async function main() {
  canvas = await mountCanvas($("canvas"), {
    onCommit: (operations, intent, meta) => commit(operations, intent, meta?.revision),
    onSelect: (ids) => {
      state.selection = ids;
      if (ids.length > 0) state.focusedLayer = ids.at(-1);
      renderLayers();
      renderInspector();
      renderToolbar();
    },
  });
  canvas.stage.addEventListener("wheel", () => requestAnimationFrame(renderToolbar), { passive: true });
  canvas.stage.addEventListener("keyup", renderToolbar);
  $("action-projects").addEventListener("click", openProjectsDialog);
  $("action-undo").addEventListener("click", () => undoRedo("undo"));
  $("action-redo").addEventListener("click", () => undoRedo("redo"));
  $("action-insert-box").addEventListener("click", () => insert("box"));
  $("action-insert-text").addEventListener("click", () => insert("text"));
  $("action-delete").addEventListener("click", deleteSelection);
  $("action-zoom-in").addEventListener("click", () => { canvas.zoomBy(1.25); renderToolbar(); });
  $("action-zoom-out").addEventListener("click", () => { canvas.zoomBy(0.8); renderToolbar(); });
  $("action-fit").addEventListener("click", () => { canvas.fit(); renderToolbar(); });
  $("action-save").addEventListener("click", save);
  $("layers").addEventListener("keydown", onLayersKey);
  $("layers").addEventListener("click", onLayersClick);
  $("inspector").addEventListener("change", onInspectorChange);
  $("inspector").addEventListener("submit", (event) => event.preventDefault());
  document.addEventListener("keydown", onGlobalKey);
  renderAll();

  state.client = await connect(window);
  if (state.client === null) {
    showDialog("Open Lilac from its launcher", () => [el("p", {}, "This page needs the link Lilac prints or opens when it starts. Start Lilac again to get a new one.")], { dismissable: false });
    return;
  }
  let session;
  try {
    session = await loadProject();
  } catch (error) {
    if (error instanceof HostError && error.status === 401) {
      forgetToken(window);
      showDialog("This Lilac session has ended", () => [el("p", {}, "Lilac was restarted or the link expired. Open Lilac again from its launcher.")], { dismissable: false });
      return;
    }
    setStatus(describeError(error));
    return;
  }
  listenForChanges();
  if (session.project === null) openProjectsDialog();
  else setStatus(`Opened ${session.project}.`);
  document.documentElement.dataset.ready = "true";
}

main().catch((error) => setStatus(`Lilac could not start: ${error?.message ?? error}`));
