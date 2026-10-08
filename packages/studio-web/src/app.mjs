// The Lilac editor. It holds a read-only copy of the open project's document and never
// changes it on its own: every edit goes to the studio host as one history transaction, and
// the copy advances only by applying the host's committed change events (from the edit's
// response or the event stream, whichever arrives first), in revision order. A gap or a
// change that does not apply means the copy is out of date, and it is fetched again.

import { mountCanvas, insertNode, removeNodes, setStyle, setText } from "/packages/canvas/src/index.mjs";
import { applyCommittedTransaction } from "/packages/history/src/index.mjs";
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
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child);
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
  confirmations: [],
};
let canvas = null;

// ---------- status and dialogs ----------

function setStatus(message) {
  $("status").textContent = message;
}

function describeError(error) {
  return error instanceof HostError ? error.message : "Lilac could not be reached. If it has stopped, start it again and open the new link it gives you.";
}

/** Show a modal dialog; `build(close)` returns its content. Focus returns where it was. */
// The one modal dialog is shared by every flow. Each showing gets a generation, so a flow
// closes only its own dialog, and is told (onReplaced) when another flow takes it over.
let dialogGeneration = 0;
let onDialogReplaced = null;
function showDialog(title, build, { dismissable = true, onReplaced = null } = {}) {
  const dialog = $("dialog");
  const returnFocus = document.activeElement;
  const generation = ++dialogGeneration;
  const replaced = onDialogReplaced;
  onDialogReplaced = onReplaced;
  if (dialog.open) replaced?.();
  const close = () => {
    if (dialogGeneration === generation && dialog.open) dialog.close();
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
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = "";
        try {
          await state.client.post("/api/projects/create", { name: name.value.trim() });
          close();
          await requestLoad();
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
    await requestLoad();
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
        novalidate: true,
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
  if (recovery.legacyProject) notes.push("This project was made before the rename to Ninerr. It was copied into the Ninerr format; the original copy is unchanged next to it.");
  else if (recovery.migratedFrom !== null && recovery.migratedFrom !== undefined) notes.push(`The project was upgraded from format version ${recovery.migratedFrom}.`);
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

// ---------- agents and their confirmations ----------

async function openAgentsDialog() {
  let listing = { agents: [], mcpUrl: "" };
  let loadError = null;
  try {
    listing = await state.client.get("/api/agents");
  } catch (error) {
    if (handleSessionEnded(error)) return;
    loadError = describeError(error);
  }
  showDialog("Agents", (close) => {
    const error = el("p", { class: "error", role: "alert" });
    const name = el("input", { id: "agent-name", name: "agentName", autocomplete: "off", maxlength: 60 });
    const problem = listing.problem ? el("p", { class: "error" }, `The list of connected agents could not be read (${listing.problem}), so none is connected. Connect them again.`) : null;
    const list = listing.agents.length === 0
      ? el("p", {}, loadError ?? "No agents are connected. A connected agent can read and edit the open project through MCP; every change it makes is attributed to it and can be undone, and it must ask you before deleting anything.")
      : el("ul", { class: "project-list", "aria-label": "Connected agents" }, listing.agents.map((agent) => el("li", { class: "agent-row" },
        el("span", {}, agent.displayName),
        el("button", {
          type: "button",
          class: "danger",
          "aria-label": `Disconnect ${agent.displayName}`,
          onclick: async () => {
            try {
              await state.client.post("/api/agents/revoke", { agentId: agent.agentId });
              close();
              openAgentsDialog();
            } catch (failure) {
              error.textContent = describeError(failure);
            }
          },
        }, "Disconnect"))));
    const form = el("form", {
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = "";
        try {
          const created = await state.client.post("/api/agents/create", { name: name.value });
          close();
          showAgentCredential(created);
        } catch (failure) {
          error.textContent = describeError(failure);
        }
      },
    },
    el("label", { for: "agent-name" }, "Agent name (for example, the MCP client's name)", name),
    el("div", { class: "actions" }, el("button", { type: "submit", class: "primary" }, "Connect agent")));
    return [problem, list, form, error, el("div", { class: "actions" }, el("button", { type: "button", onclick: close }, "Close"))];
  });
}

function showAgentCredential({ agent, token, mcpUrl }) {
  showDialog(`Connect ${agent.displayName}`, (close) => {
    const credential = el("input", { id: "agent-credential", readonly: true, value: token, "aria-describedby": "agent-credential-note", spellcheck: "false" });
    return [
      el("p", { id: "agent-credential-note" }, "This credential is shown once. Give it to the agent's MCP client; anyone who has it can act as this agent until you disconnect it."),
      el("label", { for: "agent-credential" }, "Agent credential", credential),
      el("p", {}, "For an MCP client that runs a command (stdio), use:"),
      el("pre", { class: "setup" }, "node scripts/ninerr-mcp.mjs --projects <your Ninerr projects folder>\nwith NINERR_MCP_TOKEN set to the credential"),
      el("p", {}, "For an MCP client that connects over HTTP, use this address, with the credential as a Bearer token (it changes each time Ninerr starts):"),
      el("pre", { class: "setup" }, mcpUrl),
      el("div", { class: "actions" }, el("button", { type: "button", class: "primary", onclick: close }, "Done")),
    ];
  });
  $("agent-credential").select();
}

let confirming = null;
let closeConfirmation = null;
function showConfirmations(pending) {
  state.confirmations = pending;
  if (confirming !== null && !pending.some((item) => item.id === confirming)) {
    // The request was withdrawn (it expired, or its agent or project went away).
    confirming = null;
    closeConfirmation?.();
    closeConfirmation = null;
  }
  const next = pending[0];
  if (next === undefined || confirming === next.id) return;
  if ($("dialog").open && confirming === null) {
    // Another dialog is open; ask once it closes.
    $("dialog").addEventListener("close", () => showConfirmations(state.confirmations), { once: true });
    return;
  }
  confirming = next.id;
  closeConfirmation = showDialog(`${next.agentName} asks for your approval`, (close) => {
    const error = el("p", { class: "error", role: "alert" });
    // Close only this request's dialog: by the time the decision is answered, the dialog may
    // already show the next request.
    const finish = () => {
      if (confirming !== next.id) return;
      confirming = null;
      close();
      showConfirmations(state.confirmations);
    };
    const decide = async (approve) => {
      for (const button of $("dialog").querySelectorAll("button")) button.disabled = true;
      try {
        await state.client.post("/api/confirmations/decide", { id: next.id, approve });
        setStatus(approve ? `Approved: ${next.summary}.` : `Declined: ${next.summary}.`);
      } catch (failure) {
        if (!handleSessionEnded(failure)) setStatus(describeError(failure));
      }
      finish();
    };
    return [
      el("p", {}, `The agent ${next.agentName} wants to make a change that needs your approval:`),
      el("p", { class: "request" }, next.summary),
      el("p", {}, "You can revert it afterwards from the history."),
      error,
      el("div", { class: "actions" },
        el("button", { type: "button", onclick: () => decide(false) }, "Decline"),
        el("button", { type: "button", class: "danger", onclick: () => decide(true) }, "Approve")),
    ];
  }, {
    dismissable: false,
    // Another flow took the dialog over: show this request again once that one closes.
    onReplaced: () => {
      confirming = null;
      closeConfirmation = null;
      $("dialog").addEventListener("close", () => showConfirmations(state.confirmations), { once: true });
    },
  });
}

let selectionTimer = null;
function shareSelection() {
  // MCP's get_selection reads what is selected here; send it after the selection settles.
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    if (state.client !== null && state.document !== null) state.client.post("/api/selection", { nodeIds: state.selection }).catch(() => {});
  }, 100);
}

// ---------- importing ----------

// The import stack's offline limit for one HTML page.
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

function openImportDialog() {
  if (state.document === null) return;
  showDialog("Import HTML", (close) => {
    const error = el("p", { class: "error", role: "alert" });
    const file = el("input", { id: "import-file", type: "file", accept: ".html,.htm,text/html" });
    const pasted = el("textarea", { id: "import-html", rows: 6, spellcheck: "false", placeholder: "<main>…</main>" });
    const form = el("form", {
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = "";
        let html = pasted.value;
        let name = "Pasted HTML";
        const chosen = file.files?.[0];
        if (chosen) {
          if (chosen.size > MAX_IMPORT_BYTES) {
            error.textContent = "That file is larger than 2 MiB, the most Lilac imports at once.";
            return;
          }
          html = await chosen.text();
          name = chosen.name.replace(/\.html?$/iu, "") || "Imported page";
        }
        if (html.trim() === "") {
          error.textContent = "Choose an HTML file or paste HTML.";
          return;
        }
        try {
          const review = await state.client.post("/api/import", { html, name });
          close();
          showImportReview(review);
        } catch (failure) {
          if (!handleSessionEnded(failure)) error.textContent = describeError(failure);
        }
      },
    },
    el("p", {}, "Lilac reads the HTML on this computer and removes scripts, event handlers and unsafe links. Nothing it links to is fetched. You review the result before anything is added."),
    el("label", { for: "import-file" }, "HTML file", file),
    el("label", { for: "import-html" }, "Or paste HTML", pasted),
    el("div", { class: "actions" }, el("button", { type: "button", onclick: close }, "Cancel"), el("button", { type: "submit", class: "primary" }, "Review import")));
    return [form, error];
  });
}

function showImportReview(review) {
  const KINDS = { scriptsRemoved: "script", eventHandlersRemoved: "event handler", dangerousUrlsRemoved: "unsafe link", dangerousElementsRemoved: "unsafe element", unsafeStylesRemoved: "unsafe style" };
  const removed = Object.entries(review.security).filter(([kind, count]) => count > 0 && Object.hasOwn(KINDS, kind)).map(([kind, count]) => `${count} ${KINDS[kind]}${count === 1 ? "" : "s"} removed`);
  showDialog(`Review import: ${review.name}`, (close) => {
    const error = el("p", { class: "error", role: "alert" });
    const discard = async () => {
      close();
      await state.client.post("/api/import/discard", { proposalId: review.proposalId }).catch(() => {});
    };
    const commit = () => enqueue(async () => {
      try {
        const event = await state.client.post("/api/import/commit", { proposalId: review.proposalId });
        close();
        applyChange(event);
        selectLayers([event.frameId]);
        canvas.fit();
        renderToolbar();
        setStatus(`${event.intent}: ${review.counts.nodes} layers added.`);
      } catch (failure) {
        // The review is kept when a commit fails, so Import can be pressed again; a project
        // that must be reopened is handled as for any edit.
        if (failure instanceof HostError && failure.code === "project-needs-reopen") {
          close();
          handleEditError(failure);
        } else if (!handleSessionEnded(failure)) error.textContent = describeError(failure);
      }
    });
    return [
      el("ul", { class: "report", id: "import-review" },
        el("li", {}, `${review.counts.nodes} layers in ${review.counts.roots} top-level group${review.counts.roots === 1 ? "" : "s"}`),
        removed.length > 0 ? el("li", {}, `For safety: ${removed.join(", ")}`) : el("li", {}, "Nothing unsafe was found."),
        review.accessibilityFindings > 0 ? el("li", {}, `${review.accessibilityFindings} accessibility finding${review.accessibilityFindings === 1 ? "" : "s"} to look at after importing`) : null,
        review.notes.map((note) => el("li", {}, note)),
        review.blockingReasons.map((reason) => el("li", { class: "error" }, `Cannot import: ${reason}`))),
      error,
      el("div", { class: "actions" },
        el("button", { type: "button", onclick: discard }, "Discard"),
        el("button", { type: "button", class: "primary", disabled: !review.commitReady, onclick: commit }, "Import")),
    ];
  }, { dismissable: false });
}

// ---------- design and code ----------

async function openCodeDialog() {
  if (state.document === null) return;
  const selected = state.selection.length === 1 ? state.selection[0] : null;
  let exported = null;
  let exportError = null;
  if (selected !== null) {
    try {
      exported = await state.client.post("/api/code/export", { nodeId: selected });
    } catch (error) {
      if (handleSessionEnded(error)) return;
      exportError = describeError(error);
    }
  }
  // The connected codebase (PC11): its folder and components, if one is connected.
  let codebase = null;
  let codebaseError = null;
  try {
    codebase = await state.client.get("/api/codebase");
  } catch (error) {
    if (handleSessionEnded(error)) return;
    codebaseError = describeError(error);
  }
  // The selected layer's source in the codebase, if it came from there.
  const boundNode = (() => {
    if (selected === null) return null;
    const doc = state.document;
    const stack = [selected];
    while (stack.length > 0) {
      const node = doc.nodes[stack.pop()];
      if (!node) continue;
      if (node.props?.codeSource && typeof node.props.codeSource.file === "string") return node;
      stack.push(...node.children);
    }
    return null;
  })();
  showDialog("Design and code", (close) => {
    const error = el("p", { class: "error", role: "alert" });
    const codebasePart = buildCodebasePart({ codebase, codebaseError, boundNode, close, error });
    const output = exported === null ? null : el("textarea", { id: "code-export", rows: 10, readonly: true, spellcheck: "false", "aria-describedby": "code-export-note" });
    if (output) output.value = exported.code;
    const source = el("textarea", { id: "code-import", rows: 8, spellcheck: "false", placeholder: "export function Card() {\n  return <section>…</section>;\n}" });
    const exportPart = exported === null
      ? el("p", {}, exportError ?? "Select one layer to see it as code.")
      : [
        el("p", { id: "code-export-note" }, `The selected layer (${exported.layers} layer${exported.layers === 1 ? "" : "s"}) as the JSX component ${exported.componentName}, exactly as the canvas draws it.`),
        el("label", { for: "code-export" }, "JSX", output),
        el("div", { class: "actions" }, el("button", { type: "button", onclick: async () => {
          try {
            await navigator.clipboard.writeText(exported.code);
            setStatus("Code copied.");
          } catch {
            output.select();
            setStatus("Select the code and copy it.");
          }
        } }, "Copy code")),
      ];
    const importForm = el("form", {
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        error.textContent = "";
        if (source.value.trim() === "") {
          error.textContent = "Paste a JSX function component.";
          return;
        }
        enqueue(async () => {
          try {
            const result = await state.client.post("/api/code/import", { code: source.value });
            close();
            applyChange(result);
            selectLayers([result.frameId]);
            canvas.fit();
            renderToolbar();
            setStatus(`${result.intent}: ${result.layers} layers added.`);
          } catch (failure) {
            if (failure instanceof HostError && failure.code === "project-needs-reopen") {
              close();
              handleEditError(failure);
            } else if (!handleSessionEnded(failure)) error.textContent = describeError(failure);
          }
        });
      },
    },
    el("h3", {}, "Bring code into the design"),
    el("label", { for: "code-import" }, "A JSX function component (elements, text, literal props, className and a style string)", source),
    el("div", { class: "actions" }, el("button", { type: "submit", class: "primary" }, "Add to design")));
    return [el("h3", {}, "Selected layer as code"), exportPart, importForm, codebasePart, error, el("div", { class: "actions" }, el("button", { type: "button", onclick: close }, "Close"))];
  });
}

// The Code dialog's codebase section: connect a local folder, bring its components in,
// and write a component's edits back to its file after previewing them (PC11).
function buildCodebasePart({ codebase, codebaseError, boundNode, close, error }) {
  const section = el("section", { id: "codebase", "aria-labelledby": "codebase-title" }, el("h3", { id: "codebase-title" }, "Codebase"));
  const busy = (button, task) => async () => {
    error.textContent = "";
    button.disabled = true;
    try {
      await task();
    } catch (failure) {
      if (!handleSessionEnded(failure)) error.textContent = describeError(failure);
    } finally {
      button.disabled = false;
    }
  };
  const connectForm = () => {
    const folder = el("input", { id: "codebase-folder", name: "folder", autocomplete: "off", spellcheck: "false", placeholder: "/home/you/my-app/src" });
    const connect = el("button", { type: "submit", class: "primary" }, "Connect folder");
    return el("form", {
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        busy(connect, async () => {
          const result = await state.client.post("/api/codebase/connect", { folder: folder.value.trim() });
          close();
          setStatus(`Connected ${result.folder}: ${result.components.length} component${result.components.length === 1 ? "" : "s"} found.`);
          openCodeDialog();
        })();
      },
    },
    el("label", { for: "codebase-folder" }, "A folder with your JSX or TSX components (its full path)", folder),
    el("div", { class: "actions" }, connect));
  };
  if (codebaseError !== null) {
    section.append(el("p", {}, `The connected folder cannot be read: ${codebaseError}`));
    const disconnect = el("button", { type: "button" }, "Disconnect");
    disconnect.addEventListener("click", busy(disconnect, async () => {
      await state.client.post("/api/codebase/disconnect", {});
      close();
      openCodeDialog();
    }));
    section.append(el("div", { class: "actions" }, disconnect));
    return section;
  }
  if (codebase === null || codebase.folder === null) {
    section.append(el("p", {}, "Connect a folder of your code to bring its components into the design, and write your edits back to their files."), connectForm());
    return section;
  }
  const disconnect = el("button", { type: "button" }, "Disconnect");
  disconnect.addEventListener("click", busy(disconnect, async () => {
    await state.client.post("/api/codebase/disconnect", {});
    close();
    setStatus("The codebase is disconnected.");
  }));
  section.append(el("p", {}, "Connected: ", el("code", { id: "codebase-path" }, codebase.folder)), el("div", { class: "actions" }, disconnect));
  if (codebase.components.length === 0) section.append(el("p", {}, "No exported function components were found in its .jsx and .tsx files."));
  else {
    section.append(el("ul", { class: "project-list", id: "codebase-components", "aria-label": "Components in the codebase" }, codebase.components.map(({ file, component }) => {
      const bring = el("button", { type: "button", "data-file": file, "data-component": component, "aria-label": `Bring in ${component} from ${file}` }, "Bring in");
      bring.addEventListener("click", () => {
        error.textContent = "";
        bring.disabled = true;
        enqueue(async () => {
          try {
            const result = await state.client.post("/api/codebase/import", { file, component });
            close();
            applyChange(result);
            selectLayers([result.frameId]);
            canvas.fit();
            renderToolbar();
            setStatus(`${result.intent}: ${result.layers} layers added.`);
          } catch (failure) {
            bring.disabled = false;
            if (failure instanceof HostError && failure.code === "project-needs-reopen") {
              close();
              handleEditError(failure);
            } else if (!handleSessionEnded(failure)) error.textContent = describeError(failure);
          }
        });
      });
      return el("li", { class: "codebase-row" }, el("span", {}, el("strong", {}, component), ` ${file}`), bring);
    })));
  }
  if (codebase.truncated) section.append(el("p", {}, `Only the first ${codebase.files} source files were read.`));
  if (boundNode !== null) {
    const file = boundNode.props.codeSource.file;
    const preview = el("div", { id: "codebase-preview", "aria-live": "polite" });
    const review = el("button", { type: "button", id: "codebase-review" }, `Write changes back to ${file}`);
    review.addEventListener("click", busy(review, async () => {
      const plan = await state.client.post("/api/codebase/preview", { nodeId: boundNode.id });
      const items = (entries, render) => (entries.length === 0 ? [] : [el("ul", {}, entries.map((entry) => el("li", {}, render(entry))))]);
      preview.replaceChildren(
        plan.changes.length === 0 ? el("p", {}, "There is nothing to write back: the file already has these values.") : el("p", {}, `${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"} to ${plan.file}:`),
        ...(plan.diff === "" ? [] : [el("pre", { class: "diff", id: "codebase-diff", tabindex: "0", "aria-label": `Changes to ${plan.file}` }, plan.diff)]),
        ...(plan.conflicts.length === 0 ? [] : [el("p", {}, "Changed both here and in the file, so not written:")]),
        ...items(plan.conflicts, (conflict) => `${conflict.field}: ${conflict.reason}`),
        ...(plan.notWritten.length === 0 ? [] : [el("p", {}, "Not written back:")]),
        ...items(plan.notWritten, (entry) => entry.reason),
      );
      if (plan.changes.length > 0) {
        const write = el("button", { type: "button", class: "primary", id: "codebase-write" }, "Write to file");
        write.addEventListener("click", () => {
          error.textContent = "";
          write.disabled = true;
          enqueue(async () => {
            try {
              const result = await state.client.post("/api/codebase/write", { nodeId: boundNode.id, token: plan.token });
              close();
              applyChange(result);
              setStatus(`Wrote ${result.written} change${result.written === 1 ? "" : "s"} to ${result.file}.`);
            } catch (failure) {
              write.disabled = false;
              if (failure instanceof HostError && failure.code === "project-needs-reopen") {
                close();
                handleEditError(failure);
              } else if (!handleSessionEnded(failure)) error.textContent = describeError(failure);
            }
          });
        });
        preview.append(el("div", { class: "actions" }, write));
      }
    }));
    section.append(el("div", { class: "actions" }, review), preview);
  }
  return section;
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
  await requestResync();
  showRecovery(session.recovery);
  return session;
}

// One load at a time. A request made while one is in flight (the project switched again)
// runs another load once it settles, so the last request always wins.
let loading = null;
let loadAgain = false;
function requestLoad() {
  if (loading !== null) {
    loadAgain = true;
    return loading;
  }
  loading = (async () => {
    let session;
    do {
      loadAgain = false;
      session = await loadProject();
    } while (loadAgain);
    return session;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

// Retries after a failed refresh back off, from 250 ms to 30 s, and reset on success.
let retryDelay = 250;
function retryLoad() {
  if (state.client === null || ended) return;
  const delay = retryDelay;
  retryDelay = Math.min(30_000, retryDelay * 2);
  setTimeout(() => requestLoad().catch((error) => {
    if (!handleSessionEnded(error)) retryLoad();
  }), delay);
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

/**
 * Fetch the document and history again: the copy is replaced, never merged. Change events
 * that arrive meanwhile are held, and replayed on top of the fetched copy afterwards (those
 * at or below its revision are already in it), so none is lost or applied twice.
 */
// Timings, as standard User Timing measures (performance.getEntriesByName): the first
// render of an open project (from requesting its document from the host, which already has
// it open, through fetch and parse to the drawn canvas), each change applied from the
// event stream (from the event's arrival), and each edit made here (from the request).
// Each ends when the editor's DOM is updated, before the browser paints. Each kept to at
// most 1,000 at a time (the oldest batch is cleared).
function measure(name, start) {
  try {
    performance.measure(name, { start, end: performance.now() });
    if (performance.getEntriesByName(name, "measure").length > 1000) performance.clearMeasures(name);
  } catch {
    // Timing is never allowed to affect editing.
  }
}

async function resync() {
  const started = performance.now();
  const [{ project, revision, document: next }, { entries }, session] = await Promise.all([
    state.client.get("/api/document"),
    state.client.get("/api/history"),
    state.client.get("/api/session"),
  ]);
  if (session.project !== state.project || project !== state.project) throw new ProjectChanged();
  state.revision = revision;
  state.document = next;
  state.history = entries.filter((entry) => entry.revision <= revision).slice(-MAX_HISTORY_SHOWN);
  state.seen = new Set(state.history.map((entry) => entry.transactionId));
  state.canUndo = Boolean(session.canUndo);
  state.canRedo = Boolean(session.canRedo);
  canvas.setDocument(next);
  state.selection = canvas.selection;
  measure("ninerr:render-project", started);
}

class ProjectChanged extends Error {}

let resyncing = null;
let applying = false;
let held = [];
function requestResync() {
  resyncing ??= (async () => {
    let failed = false;
    try {
      await resync();
    } catch (error) {
      failed = true;
      canvas.clearPreview();
      if (!handleSessionEnded(error)) setStatus(error instanceof ProjectChanged ? "The project changed; refreshing again." : describeError(error));
    } finally {
      resyncing = null;
    }
    const replay = held.sort((a, b) => a.revision - b.revision);
    held = [];
    if (failed) {
      // The project changed under the refresh (or the host is unreachable): start over.
      retryLoad();
      return;
    }
    retryDelay = 250;
    for (const event of replay) applyChange(event);
    renderAll();
  })();
  return resyncing;
}

/** Apply one committed change event to the local copy, in revision order. */
function applyChange(event) {
  if (event.project !== undefined && event.project !== state.project) return; // another project's
  if (resyncing !== null) {
    held.push(event);
    return;
  }
  if (state.document === null || event.revision <= state.revision) return; // already applied
  if (event.revision !== state.revision + 1) {
    requestResync();
    return;
  }
  let result;
  let rootTouched = false;
  try {
    // The host validated and committed the change; the editor's copy follows it in place.
    // If it does not apply, the copy is out of date and is fetched again.
    // Whether top-level layers change, read before applying (the tree still shows the old).
    rootTouched = event.operations.some((operation) => ((operation.type === "insert-node" || operation.type === "restore-subtree" || operation.type === "move-node") && (operation.parentId ?? null) === null)
      || (typeof operation.nodeId === "string" && document.getElementById(`layer-${operation.nodeId}`)?.parentElement === $("layers")));
    result = applyCommittedTransaction(state.document, { operations: event.operations });
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
  const selectionBefore = [...state.selection];
  applying = true;
  try {
    canvas.update(state.document, result.affectedNodeIds);
  } finally {
    applying = false;
  }
  state.selection = canvas.selection;
  // A change that removed selected layers changes the selection; agents see it too.
  if (state.selection.length !== selectionBefore.length || state.selection.some((id, index) => id !== selectionBefore[index])) shareSelection();
  if (event.actor === state.user.actorId) {
    // Only this user's own changes move this user's undo and redo stacks.
    refreshUndoState();
  }
  renderToolbar();
  try {
    patchLayers(result.affectedNodeIds, rootTouched, selectionBefore);
  } catch {
    renderLayers();
  }
  renderInspector();
  renderHistory();
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

/** A 401 means this page's session is over (Lilac restarted); say so once. */
let ended = false;
function handleSessionEnded(error) {
  if (!(error instanceof HostError) || error.status !== 401) return false;
  if (!ended) {
    ended = true;
    forgetToken(window);
    state.events?.close();
    showDialog("This Lilac session has ended", () => [el("p", {}, "Lilac was restarted or the link expired. Open Lilac again from its launcher.")], { dismissable: false });
  }
  return true;
}

function handleEditError(error) {
  if (handleSessionEnded(error)) return;
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
      canvas.clearPreview();
      setStatus("That change was skipped: it was made before the previous change had finished. Try it again.");
      return null;
    }
    try {
      const started = performance.now();
      const event = await state.client.post("/api/edit", { baseRevision: state.revision, operations, intent });
      applyChange(event);
      // Only when this edit's change was applied here (not held for a refresh).
      if (state.revision === event.revision) measure("ninerr:edit", started);
      setStatus(intent ? `${intent}.` : "Changed.");
      return event;
    } catch (error) {
      canvas.clearPreview();
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

function revert(entry) {
  return enqueue(async () => {
    if (state.document === null) return;
    try {
      const event = await state.client.post("/api/revert", { transactionId: entry.transactionId });
      applyChange(event);
      setStatus(`${event.intent}.`);
    } catch (error) {
      if (error instanceof HostError && error.code === "not-revertible") setStatus("Only an agent's latest change can be reverted. Revert its later changes first.");
      else if (error instanceof HostError && error.code === "revert-conflict") setStatus("A later change touches the same layers, so this cannot be reverted now.");
      else handleEditError(error);
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

// The event stream reconnects with a growing delay (1 s to 30 s, reset once it opens), and
// refreshes the copy on reopening, since changes may have been missed while it was down.
let streamDelay = 1000;
function listenForChanges({ refreshOnOpen = false } = {}) {
  state.events?.close();
  if (ended) return;
  const events = state.client.events();
  state.events = events;
  let dropped = refreshOnOpen;
  events.addEventListener("change", (message) => {
    const received = performance.now();
    try {
      const event = JSON.parse(message.data);
      const before = state.revision;
      applyChange(event);
      if (state.revision === event.revision && before === event.revision - 1) measure("ninerr:apply-change", received);
    } catch {
      requestResync();
    }
  });
  events.addEventListener("confirmations", (message) => {
    try {
      showConfirmations(JSON.parse(message.data).pending ?? []);
    } catch {
      // ignore a malformed event
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
    else if (info.project !== state.project) {
      // The copy belongs to the old project: stop applying to it until the new one is loaded.
      state.project = info.project;
      state.document = null;
      renderAll();
      requestLoad().catch((error) => {
        if (!handleSessionEnded(error)) setStatus(describeError(error));
      });
    }
  });
  events.addEventListener("error", () => {
    dropped = true;
    // A closed stream is not retried by the browser: find out whether the session ended,
    // and otherwise open a new one after a delay.
    if (events.readyState === 2 && state.events === events) {
      const delay = streamDelay;
      streamDelay = Math.min(30_000, streamDelay * 2);
      state.client.get("/api/session").then(
        () => setTimeout(() => listenForChanges({ refreshOnOpen: true }), delay),
        (error) => {
          if (!handleSessionEnded(error)) setTimeout(() => listenForChanges({ refreshOnOpen: true }), delay);
        },
      );
    }
  });
  events.addEventListener("open", () => {
    streamDelay = 1000;
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

// One layer's tree item (and, when expanded, its children's).
function buildLayerItem(id, level, selected = new Set(state.selection)) {
  const doc = state.document;
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
  if (expanded) item.append(el("ul", { role: "group", class: "children" }, node.children.filter((child) => doc.nodes[child]).map((child) => buildLayerItem(child, level + 1, selected))));
  return item;
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
  tree.replaceChildren(...doc.rootIds.filter((id) => doc.nodes[id]).map((id) => buildLayerItem(id, 1, selected)));
  if (hadFocus && state.focusedLayer !== null) $(`layer-${state.focusedLayer}`)?.focus();
}

/** Make `container`'s items match `childIds`, reusing items already there. */
function reconcileLayerList(container, childIds, level) {
  const wanted = new Set(childIds);
  let cursor = container.firstElementChild;
  for (const id of childIds) {
    while (cursor && !wanted.has(cursor.dataset.nodeId)) {
      const stale = cursor;
      cursor = cursor.nextElementSibling;
      stale.remove();
    }
    let item = document.getElementById(`layer-${id}`);
    // An item moved to another depth is rebuilt, for its level and indentation.
    if (!item || item.getAttribute("aria-level") !== String(level)) {
      item?.remove();
      item = buildLayerItem(id, level);
    }
    if (item === cursor) cursor = cursor.nextElementSibling;
    else container.insertBefore(item, cursor);
  }
  while (cursor) {
    const stale = cursor;
    cursor = cursor.nextElementSibling;
    stale.remove();
  }
}

/**
 * Update the layers tree for one applied change, touching only the rows and lists the
 * change affects: on a 10,000-layer project, redrawing the whole tree costs far more than
 * the change. `rootTouched` says whether top-level layers changed.
 */
function patchLayers(affectedNodeIds, rootTouched, previousSelection) {
  const doc = state.document;
  const tree = $("layers");
  const hadFocus = tree.contains(document.activeElement);
  for (const id of affectedNodeIds) {
    const node = doc.nodes[id];
    const item = document.getElementById(`layer-${id}`);
    if (!node) {
      item?.remove();
      continue;
    }
    if (!item) continue; // inside a collapsed layer, or new: placed by its parent's list
    const expanded = node.children.length > 0 ? !state.collapsed.has(id) : null;
    if (expanded === null) item.removeAttribute("aria-expanded");
    else item.setAttribute("aria-expanded", String(expanded));
    item.querySelector(":scope > .row .twisty").textContent = expanded === null ? "" : expanded ? "▾" : "▸";
    item.querySelector(":scope > .row .label").textContent = layerLabel(node);
    let group = item.querySelector(":scope > ul");
    if (!expanded) {
      group?.remove();
      continue;
    }
    if (!group) {
      group = el("ul", { role: "group", class: "children" });
      item.append(group);
    }
    reconcileLayerList(group, node.children.filter((child) => doc.nodes[child]), Number(item.getAttribute("aria-level")) + 1);
  }
  if (rootTouched) reconcileLayerList(tree, doc.rootIds.filter((id) => doc.nodes[id]), 1);
  $("layers-empty").hidden = doc.rootIds.length > 0;
  for (const id of new Set([...previousSelection, ...state.selection])) {
    document.getElementById(`layer-${id}`)?.setAttribute("aria-selected", state.selection.includes(id) ? "true" : "false");
  }
  if (state.focusedLayer === null || !document.getElementById(`layer-${state.focusedLayer}`)) {
    state.focusedLayer = state.selection.find((id) => document.getElementById(`layer-${id}`)) ?? tree.querySelector("[role=treeitem]")?.dataset.nodeId ?? null;
    if (state.focusedLayer !== null) document.getElementById(`layer-${state.focusedLayer}`).tabIndex = 0;
  }
  if (hadFocus && !tree.contains(document.activeElement) && state.focusedLayer !== null) document.getElementById(`layer-${state.focusedLayer}`)?.focus();
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
    ? { field: active.name, value: active.value, node: form.dataset.nodeId, start: active.selectionStart, end: active.selectionEnd }
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
    const id = `inspect-${name.replace(":", "-")}`;
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
  // Moving and resizing without dragging (WCAG 2.5.7): one click per 10-pixel step.
  const step = (label, text, action) => el("button", { type: "button", "aria-label": label, onclick: action }, text);
  children.push(el("div", { class: "steps", role: "group", "aria-label": "Move and resize by 10 pixels" },
    step("Move left 10 pixels", "←", () => canvas.nudge(-10, 0)),
    step("Move right 10 pixels", "→", () => canvas.nudge(10, 0)),
    step("Move up 10 pixels", "↑", () => canvas.nudge(0, -10)),
    step("Move down 10 pixels", "↓", () => canvas.nudge(0, 10)),
    // Visible words are the accessible names (WCAG 2.5.3); the group says "by 10 pixels".
    el("button", { type: "button", onclick: () => canvas.resizeBy(-10, 0) }, "Narrower"),
    el("button", { type: "button", onclick: () => canvas.resizeBy(10, 0) }, "Wider"),
    el("button", { type: "button", onclick: () => canvas.resizeBy(0, -10) }, "Shorter"),
    el("button", { type: "button", onclick: () => canvas.resizeBy(0, 10) }, "Taller")));
  form.replaceChildren(...children);
  if (typing && typing.node === node.id) {
    const input = form.elements.namedItem(typing.field);
    if (input) input.value = typing.value;
  }
  if (activeField) {
    const input = form.elements.namedItem(activeField);
    input?.focus();
    if (typing && typing.node === node.id && typing.start !== null) input?.setSelectionRange(typing.start, typing.end);
  }
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
  return typeof entry.actorName === "string" && entry.actorName !== "" ? entry.actorName : entry.actor;
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
      entry.tool && !/^(?:ninerr|lilac):/u.test(entry.tool) ? ` · ${entry.tool}` : null,
      ` · revision ${entry.revision}`),
    entry.actorKind === "agent" ? el("button", { type: "button", class: "revert", "aria-label": `Revert ${entry.intent ?? "change"} by ${actorLabel(entry)}`, onclick: () => revert(entry) }, "Revert") : null)));
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
  $("action-import").disabled = !open;
  $("action-code").disabled = !open;
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
      // The canvas reports the selection after every update; redraw only when it changed,
      // and not while a change is being applied (applyChange updates the panels itself).
      if (applying || ids.join("\n") === state.selection.join("\n")) return;
      state.selection = ids;
      shareSelection();
      if (ids.length > 0) state.focusedLayer = ids.at(-1);
      renderLayers();
      renderInspector();
      renderToolbar();
    },
  });
  canvas.stage.addEventListener("wheel", () => requestAnimationFrame(renderToolbar), { passive: true });
  canvas.stage.addEventListener("keyup", renderToolbar);
  // The skip link lands on the canvas itself, which takes the keyboard commands.
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    canvas.stage.focus({ focusVisible: true });
  });
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
  $("action-import").addEventListener("click", openImportDialog);
  $("action-code").addEventListener("click", openCodeDialog);
  $("action-agents").addEventListener("click", openAgentsDialog);
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
    session = await requestLoad();
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
  state.client.get("/api/confirmations").then(({ pending }) => showConfirmations(pending), () => {});
  if (session.project === null) await openProjectsDialog();
  else setStatus(`Opened ${session.project}.`);
  document.documentElement.dataset.ready = "true";
}

main().catch((error) => setStatus(`Lilac could not start: ${error?.message ?? error}`));
