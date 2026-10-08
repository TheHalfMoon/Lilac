import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { applyPatch, buildCodeIr } from "@lilac/code-ir";
import { StudioError } from "./errors.ts";
import { type CodeSource, importJsx } from "./code.ts";
import { styleProperties } from "./imports.ts";

// A connected codebase (PC11, #182): one local folder linked to a project, whose JSX and
// TSX components the person can bring into the design with their source, and write
// edits back to as a reviewed patch. Only the person does any of this (the editor's
// session), never an agent. Every file is read and written inside the folder: paths are
// relative with no "..", resolved through realpath, regular files, not links.
//
// Writing back is three-way, per field: the base is the source's value when the layer
// was brought in (or last written back); a field the person changed is written only if
// the file still has the base; if both changed differently it is a conflict, never
// written. The write is through code-ir's applyPatch (every anchor must match exactly),
// atomic (a temporary file beside it, then a rename), and only of the content the person
// previewed.

export const MAX_SCAN_FILES = 400;
export const MAX_SCAN_DEPTH = 8;
export const MAX_SOURCE_BYTES = 256 * 1024;
/** Directory entries a scan looks at in all, so a very large folder cannot stall the host. */
export const MAX_SCAN_ENTRIES = 20_000;
const SOURCE = /\.(?:jsx|tsx)$/u;
const SKIPPED = new Set(["node_modules", "dist", "build"]);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The folder linked to each project, kept owner-only in the projects folder. */
export class CodebaseLinks {
  readonly #path: string;
  #links: Record<string, string>;

  constructor(projectsRoot: string) {
    this.#path = join(projectsRoot, ".lilac-codebases.json");
    this.#links = readLinks(this.#path);
  }

  get(project: string): string | null {
    return Object.hasOwn(this.#links, project) ? this.#links[project] : null;
  }

  set(project: string, folder: string | null): void {
    const next = { ...this.#links };
    if (folder === null) delete next[project];
    else next[project] = folder;
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ version: 1, links: next }, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.#path);
    } catch {
      rmSync(temporary, { force: true });
      throw new StudioError(500, "codebases-unwritable", "the codebase links could not be saved");
    }
    this.#links = next;
  }
}

function readLinks(path: string): Record<string, string> {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    return {};
  }
  // Only a small regular file this user owns, and no one else can write, is trusted.
  if (!entry.isFile() || entry.size > 64 * 1024) return {};
  if (typeof process.getuid === "function" && (entry.uid !== process.getuid() || (entry.mode & 0o022) !== 0)) return {};
  try {
    const links = JSON.parse(readFileSync(path, "utf8"))?.links;
    if (links === null || typeof links !== "object" || Array.isArray(links)) return {};
    return Object.fromEntries(Object.entries(links).filter(([project, folder]) => typeof folder === "string" && isAbsolute(folder) && project.length <= 64));
  } catch {
    return {};
  }
}

/** `folder` as a connectable codebase: an existing directory, outside the projects folder. */
export function assertFolder(folder: unknown, projectsRoot: string): string {
  if (typeof folder !== "string" || folder.length === 0 || folder.length > 1024 || !isAbsolute(folder) || /[\u0000-\u001f]/u.test(folder)) {
    throw new StudioError(400, "invalid-folder", "give the folder's full path, for example /home/you/my-app/src");
  }
  let real: string;
  try {
    // The native realpath gives the true case on macOS and Windows, so a differently cased
    // spelling of the projects folder is still recognised.
    real = realpathSync.native(folder);
  } catch {
    throw new StudioError(404, "folder-not-found", "that folder does not exist");
  }
  if (!statSync(real).isDirectory()) throw new StudioError(400, "not-a-folder", "that is a file, not a folder");
  const projects = realpathSync.native(projectsRoot);
  const inside = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
  if (inside(projects, real) || inside(real, projects)) throw new StudioError(400, "folder-overlaps-projects", "a codebase folder must be outside Lilac's projects folder");
  if (dirname(real) === real) throw new StudioError(400, "folder-is-root", "connect a project's folder, not the whole disk");
  return real;
}

/** A source file inside `folder`, by its path relative to it. */
export function readSourceFile(folder: string, file: unknown): { file: string; content: string; sha256: string; absolute: string } {
  // Forward slashes only: no backslash, and no colon (a Windows drive or alternate stream).
  if (typeof file !== "string" || file === "" || file.length > 512 || isAbsolute(file) || /[\\:\u0000-\u001f]/u.test(file) || file.split("/").some((part) => part === ".." || part === "." || part === "") || !SOURCE.test(file)) {
    throw new StudioError(400, "invalid-file", "a source file is a .jsx or .tsx path inside the connected folder");
  }
  const absolute = join(folder, file);
  let entry;
  try {
    entry = lstatSync(absolute);
  } catch {
    throw new StudioError(404, "file-not-found", `${file} is not in the connected folder`);
  }
  if (!entry.isFile()) throw new StudioError(400, "invalid-file", `${file} is not a regular file`);
  const real = realpathSync.native(absolute);
  if (!real.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`)) throw new StudioError(400, "invalid-file", `${file} is outside the connected folder`);
  if (entry.size > MAX_SOURCE_BYTES) throw new StudioError(413, "file-too-large", `${file} is larger than ${MAX_SOURCE_BYTES / 1024} KiB`);
  const content = readFileSync(real, "utf8");
  return { file: relative(folder, real).split(sep).join("/"), content, sha256: sha256(content), absolute: real };
}

const exportedNames = (content: string) => [...content.matchAll(/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9]*)/gu)].map((match) => match[1]);

/** The exported function components in the folder's JSX and TSX files. */
export function scanComponents(folder: string): { components: Array<{ file: string; component: string }>; files: number; truncated: boolean } {
  const components: Array<{ file: string; component: string }> = [];
  let files = 0;
  let entriesSeen = 0;
  let truncated = false;
  const walk = (directory: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH || truncated) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_SCAN_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && SOURCE.test(entry.name)) {
        if (files >= MAX_SCAN_FILES) {
          truncated = true;
          return;
        }
        files += 1;
        let content: string;
        try {
          if (lstatSync(path).size > MAX_SOURCE_BYTES) continue;
          content = readFileSync(path, "utf8");
        } catch {
          continue;
        }
        const file = relative(folder, path).split(sep).join("/");
        for (const component of exportedNames(content)) components.push({ file, component });
      }
      // Symbolic links are neither followed nor listed.
    }
  };
  walk(folder, 0);
  return { components, files, truncated };
}

/** The operations that bring `component` from `file` into the design, bound to its source. */
export function bringIn(folder: string, file: unknown, component: unknown) {
  if (typeof component !== "string" || !/^[A-Z][A-Za-z0-9]{0,63}$/u.test(component)) throw new StudioError(400, "invalid-component", "name an exported function component");
  const source = readSourceFile(folder, file);
  return { ...importJsx(source.content, { path: source.file, component, bind: true }), file: source.file };
}

// ---------- writing edits back ----------

export interface WriteBackPlan {
  file: string;
  /** The sha256 of the file the plan was made from. */
  sha256: string;
  /** Names this exact plan (the file and what it would become); the write requires it. */
  token: string;
  diff: string;
  changes: Array<{ nodeId: string; field: string; from: string; to: string }>;
  conflicts: Array<{ nodeId: string; field: string; reason: string }>;
  notWritten: Array<{ nodeId: string; reason: string }>;
  after: string;
  /** The bound layers' new bases once written. */
  rebase: Array<{ nodeId: string; codeSource: CodeSource }>;
}

const sourceName = (prop: string) => (prop === "className" ? "class" : prop === "htmlFor" ? "for" : prop);

/** The layer's current value for a source prop, as source text. */
function layerValue(node: any, prop: string): string | undefined {
  if (prop === "style") return Object.entries(node.props?.style ?? {}).map(([name, value]) => `${name}: ${value}`).join("; ");
  const attributes = node.props?.attributes ?? {};
  const name = sourceName(prop);
  return typeof attributes[name] === "string" ? attributes[name] : undefined;
}

function equalProp(prop: string, a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (prop === "style") {
    const left = styleProperties({ cssText: a });
    const right = styleProperties({ cssText: b });
    return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([name, value]) => right[name] === value);
  }
  return a === b;
}

/**
 * The layer's style as source text, in the source's own order (the layer keeps its style
 * keys sorted), with any new properties after: a write-back changes only what changed.
 */
function styleInSourceOrder(sourceText: string, style: Record<string, string>): string {
  const order = Object.keys(styleProperties({ cssText: sourceText }));
  const names = [...order.filter((name) => Object.hasOwn(style, name)), ...Object.keys(style).filter((name) => !order.includes(name))];
  return names.map((name) => `${name}: ${style[name]}`).join("; ");
}

/** One hunk covering every changed line, with up to 3 lines of context. */
function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const from = Math.max(0, start - 3);
  const toA = Math.min(a.length, endA + 3);
  const toB = Math.min(b.length, endB + 3);
  const lines = [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`,
    ...a.slice(from, start).map((line) => ` ${line}`),
    ...a.slice(start, endA).map((line) => `-${line}`),
    ...b.slice(start, endB).map((line) => `+${line}`),
    ...a.slice(endA, toA).map((line) => ` ${line}`),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * A text's replacement. When the source text is exactly the value Lilac read, it is
 * replaced as it is; when the source spreads it over lines (code-ir reads it normalized),
 * the whitespace around it in the source is kept.
 */
function textReplacement(live: string, fileText: string, text: string): string {
  const escaped = (value: string) => value.replace(/&/gu, "&amp;");
  if (live === fileText) return escaped(text);
  const lead = /^\s*/u.exec(live)?.[0] ?? "";
  const trail = live.length > lead.length ? /\s*$/u.exec(live)?.[0] ?? "" : "";
  return `${lead}${escaped(text.trim())}${trail}`;
}

/** What writing the bound layers under `nodeId` back to their file would change. */
export function planWriteBack(document: any, nodeId: unknown, folder: string, exclude: Set<string> = new Set()): WriteBackPlan {
  if (typeof nodeId !== "string" || !Object.hasOwn(document.nodes, nodeId)) throw new StudioError(404, "node-not-found", "no such layer");
  const label = (node: any) => (typeof node.props?.name === "string" ? node.props.name : typeof node.props?.tag === "string" ? node.props.tag : node.type);
  const isBound = (node: any) => node?.props?.codeSource && typeof node.props.codeSource === "object" && typeof node.props.codeSource.file === "string" && typeof node.props.codeSource.path === "string";
  const isRoot = (node: any) => isBound(node) && node.props.codeSource.path === "" && node.props.codeSource.tag !== "#text";
  // Always the whole component: a layer inside it plans from the component's root.
  let start = document.nodes[nodeId];
  while (isBound(start) && !isRoot(start) && start.parentId !== null && document.nodes[start.parentId]) start = document.nodes[start.parentId];
  if (!isRoot(start)) start = document.nodes[nodeId];
  // Every layer in the subtree, and the bound ones among them.
  const subtree: any[] = [];
  const collect = (id: string) => {
    const node = document.nodes[id];
    if (!node) return;
    subtree.push(node);
    for (const child of node.children) collect(child);
  };
  collect(start.id);
  const bound = subtree.filter(isBound).map((node) => ({ node, source: node.props.codeSource as CodeSource }));
  if (bound.length === 0) throw new StudioError(409, "not-from-codebase", "this layer did not come from the connected codebase");
  const { file, component } = bound[0].source;
  if (bound.some(({ source }) => source.file !== file || source.component !== component)) throw new StudioError(409, "mixed-sources", "select one component brought in from the codebase");
  const read = readSourceFile(folder, file);
  let ir: any;
  try {
    ir = buildCodeIr([{ path: read.file, content: read.content }]);
  } catch (error) {
    throw new StudioError(409, "source-unreadable", `${file} can no longer be read as code: ${error instanceof Error ? error.message.slice(0, 200) : "unreadable"}`);
  }
  const symbols = Object.values(ir.symbols) as any[];
  const definition = symbols.find((symbol) => symbol.kind === "component" && symbol.name === component && symbol.children.length > 0 && ir.rootIds.includes(symbol.children[0]));
  if (!definition) throw new StudioError(409, "component-gone", `${component} is no longer an exported component of ${file}`);
  const symbolAt = (path: string) => {
    let symbol = ir.symbols[definition.children[0]];
    for (const index of path === "" ? [] : path.split(".").map(Number)) {
      const child = symbol?.children?.[index];
      symbol = child === undefined ? undefined : ir.symbols[child];
    }
    return symbol;
  };

  const ops: Array<{ at: number; op: unknown }> = [];
  const changes: WriteBackPlan["changes"] = [];
  const conflicts: WriteBackPlan["conflicts"] = [];
  const notWritten: WriteBackPlan["notWritten"] = [];
  const rebase: WriteBackPlan["rebase"] = [];
  // Each written field, to read back from the new file before the plan is offered.
  const checks: Array<{ nodeId: string; field: string; path: string; textIndex?: number; expected: string }> = [];

  // Layers here that the source does not have: added, or copied from a bound one.
  for (const node of subtree) if (!isBound(node)) notWritten.push({ nodeId: node.id, reason: `the layer ${label(node)} was added here and is not written back` });
  const seen = new Map<string, string>();
  const copies = new Set<string>();
  for (const { node, source } of bound) {
    const key = `${source.path}#${source.textIndex ?? ""}`;
    if (seen.has(key)) {
      copies.add(node.id);
      copies.add(seen.get(key)!);
    } else seen.set(key, node.id);
  }
  for (const id of copies) conflicts.push({ nodeId: id, field: "structure", reason: "this layer is a copy of another from the same source; bring the component in again" });
  // Where each bound element now sits, against where its source is: moved or reordered
  // layers are not written back.
  const elementPath = new Map<string, string>();
  const placeElements = (id: string, path: number[]) => {
    const node = document.nodes[id];
    if (!node) return;
    if (isBound(node) && node.props.codeSource.tag !== "#text") elementPath.set(node.id, path.join("."));
    const elements = node.children.filter((child: string) => isBound(document.nodes[child]) && document.nodes[child].props.codeSource.tag !== "#text");
    elements.forEach((child: string, index: number) => placeElements(child, [...path, index]));
  };
  const root = bound.find(({ source }) => source.path === "" && source.tag !== "#text");
  if (root) placeElements(root.node.id, []);
  let sourceElements = 0;
  const countElements = (symbol: any) => {
    sourceElements += 1;
    for (const child of symbol.children) countElements(ir.symbols[child]);
  };
  countElements(ir.symbols[definition.children[0]]);
  const boundElements = bound.filter(({ source }) => source.tag !== "#text").length;
  if (boundElements < sourceElements) notWritten.push({ nodeId: start.id, reason: "layers removed here are not written back" });
  // Runs of text: each must still be in its own element, in its source order, and none
  // removed (a run moved or removed is listed, never written to its old place).
  const misplacedText = new Set<string>();
  for (const { node, source } of bound) {
    if (source.tag !== "#text") continue;
    const parent = document.nodes[node.parentId];
    if (!isBound(parent) || parent.props.codeSource.tag === "#text" || parent.props.codeSource.path !== source.path || (root && elementPath.get(parent.id) !== source.path)) misplacedText.add(node.id);
  }
  for (const { node, source } of bound) {
    if (source.tag === "#text") continue;
    const runs = node.children.map((child: string) => document.nodes[child]).filter((child: any) => isBound(child) && child.props.codeSource.tag === "#text");
    runs.forEach((run: any, index: number) => {
      if (index > 0 && runs[index - 1].props.codeSource.textIndex >= run.props.codeSource.textIndex) misplacedText.add(run.id);
    });
    const symbol = symbolAt(source.path);
    if (symbol && symbol.children.length > 0) {
      const sourceRuns = symbol.texts.filter((entry: any) => entry.value !== "").length;
      const present = bound.filter(({ source: other }) => other.tag === "#text" && other.path === source.path).length;
      if (present < sourceRuns) notWritten.push({ nodeId: node.id, reason: `text removed from ${label(node)} here is not written back` });
    }
  }

  for (const { node, source } of bound) {
    if (copies.has(node.id)) continue;
    const isText = source.tag === "#text";
    if (isText && misplacedText.has(node.id)) {
      notWritten.push({ nodeId: node.id, reason: "a run of text moved or reordered here is not written back" });
      continue;
    }
    if (!isText && root && elementPath.get(node.id) !== source.path) {
      notWritten.push({ nodeId: node.id, reason: `the layer ${label(node)} was moved or reordered here, which is not written back` });
      continue;
    }
    const symbol = symbolAt(source.path);
    if (!symbol || (!isText && symbol.name !== source.tag)) {
      conflicts.push({ nodeId: node.id, field: "structure", reason: `the source no longer has <${source.tag}> there` });
      continue;
    }
    const nextBase: CodeSource["base"] = { props: { ...source.base.props }, ...(source.base.text === undefined ? {} : { text: source.base.text }) };
    // Text: the element's single literal text, or one run of text among its children.
    if (source.base.text !== undefined) {
      const entry = isText
        ? (Number.isInteger(source.textIndex) ? symbol.texts[source.textIndex!] : undefined)
        : (symbol.children.length === 0 && symbol.texts.length === 1 ? symbol.texts[0] : undefined);
      const fileText: string | undefined = entry?.value;
      const mine = typeof node.props?.text === "string" ? node.props.text : "";
      if (fileText === undefined) conflicts.push({ nodeId: node.id, field: "text", reason: "the source's text is no longer there as a literal" });
      // Not changed here: the base stays, so a change made in the file is never undone.
      else if (mine === source.base.text) {
        // nothing to write
      } else if (fileText === mine) nextBase.text = mine;
      else if (fileText !== source.base.text) conflicts.push({ nodeId: node.id, field: "text", reason: "changed both here and in the file" });
      else if (/[{}<>]/u.test(mine)) notWritten.push({ nodeId: node.id, reason: "text with { } < or > is not written as JSX text" });
      else if (/^\s*\{/u.test(read.content.slice(entry.range.startOffset, entry.range.endOffset))) notWritten.push({ nodeId: node.id, reason: "text written as a {…} expression in the source is not written back" });
      else if (exclude.has(`${node.id}:text`)) notWritten.push({ nodeId: node.id, reason: "this text would not read back as written, so it is not written" });
      else {
        const range = entry.range;
        const live = read.content.slice(range.startOffset, range.endOffset);
        ops.push({ at: range.startOffset, op: { op: "update-text", targetSymbolId: symbol.id, anchor: { range, expectedText: live }, replacement: textReplacement(live, fileText, mine) } });
        changes.push({ nodeId: node.id, field: "text", from: fileText, to: mine });
        checks.push({ nodeId: node.id, field: "text", path: source.path, textIndex: isText ? source.textIndex : undefined, expected: mine });
        nextBase.text = mine;
      }
    }
    // Literal string props.
    for (const [prop, base] of Object.entries(source.base.props)) {
      const fileProp = symbol.props.find((candidate: any) => candidate.name === prop && typeof candidate.literal.value === "string");
      let mine = layerValue(node, prop);
      if (!fileProp) {
        if (!equalProp(prop, mine, base)) conflicts.push({ nodeId: node.id, field: prop, reason: "no longer a literal string in the source" });
        continue;
      }
      const fileValue: string = fileProp.literal.value;
      if (mine === undefined) {
        notWritten.push({ nodeId: node.id, reason: `removing ${prop} is not written back` });
        continue;
      }
      // Not changed here: the base stays, so a change made in the file is never undone.
      if (equalProp(prop, mine, base)) continue;
      if (equalProp(prop, fileValue, mine)) {
        nextBase.props[prop] = fileValue;
        continue;
      }
      if (!equalProp(prop, fileValue, base)) {
        conflicts.push({ nodeId: node.id, field: prop, reason: "changed both here and in the file" });
        continue;
      }
      if (/[\r\n\u2028\u2029]/u.test(mine)) {
        notWritten.push({ nodeId: node.id, reason: `${prop} with a line break is not written` });
        continue;
      }
      if (exclude.has(`${node.id}:${prop}`)) {
        notWritten.push({ nodeId: node.id, reason: `${prop} would not read back as written, so it is not written` });
        continue;
      }
      if (prop === "style") mine = styleInSourceOrder(fileValue, node.props?.style ?? {});
      const range = fileProp.range;
      ops.push({ at: range.startOffset, op: { op: "update-prop", targetSymbolId: symbol.id, anchor: { range, expectedText: read.content.slice(range.startOffset, range.endOffset) }, replacement: `${prop}="${mine.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;")}"` } });
      changes.push({ nodeId: node.id, field: prop, from: fileValue, to: mine });
      checks.push({ nodeId: node.id, field: prop, path: source.path, expected: mine });
      nextBase.props[prop] = mine;
    }
    if (!isText) {
      // Attributes the layer has but the source does not are not added.
      const sourceNames = new Set(symbol.props.map((prop: any) => sourceName(prop.name)));
      for (const name of Object.keys(node.props?.attributes ?? {})) if (!sourceNames.has(name)) notWritten.push({ nodeId: node.id, reason: `the new attribute ${name} is not written back` });
      if (Object.keys(node.props?.style ?? {}).length > 0 && !symbol.props.some((prop: any) => prop.name === "style")) notWritten.push({ nodeId: node.id, reason: "a style the source does not have is not written back" });
    }
    rebase.push({ nodeId: node.id, codeSource: { ...source, base: nextBase } });
  }

  // Applied from the end of the file back, so each anchor's range still holds.
  ops.sort((a, b) => b.at - a.at);
  let after = read.content;
  if (ops.length > 0) {
    try {
      after = applyPatch(ir, [{ path: read.file, content: read.content }], ops.map((entry) => entry.op)).files[0].content;
    } catch (error) {
      throw new StudioError(409, "patch-refused", `the change could not be applied to ${file}: ${error instanceof Error ? error.message.slice(0, 200) : "refused"}`);
    }
  }
  // Read the new file back: every written field must read as the value written (no
  // whitespace, entity or merge drift). A field that does not is left out and listed.
  if (checks.length > 0) {
    const failing = readBackFailures(read.file, after, component, checks);
    if (failing.length > 0) {
      if (exclude.size > 0) throw new StudioError(409, "patch-refused", `the change to ${file} would not read back as written`);
      return planWriteBack(document, nodeId, folder, new Set(failing));
    }
  }
  const token = createHash("sha256").update(`${read.sha256}\0${after}`, "utf8").digest("hex");
  return { file: read.file, sha256: read.sha256, token, diff: unifiedDiff(read.file, read.content, after), changes, conflicts, notWritten, after, rebase };
}

/** The checks (as `nodeId:field`) whose value does not read back from `content`. */
function readBackFailures(file: string, content: string, component: string, checks: Array<{ nodeId: string; field: string; path: string; textIndex?: number; expected: string }>): string[] {
  let ir: any;
  try {
    ir = buildCodeIr([{ path: file, content }]);
  } catch {
    return checks.map((check) => `${check.nodeId}:${check.field}`);
  }
  const definition = (Object.values(ir.symbols) as any[]).find((symbol) => symbol.kind === "component" && symbol.name === component && symbol.children.length > 0 && ir.rootIds.includes(symbol.children[0]));
  if (!definition || ir.unsupported.length > 0) return checks.map((check) => `${check.nodeId}:${check.field}`);
  const at = (path: string) => {
    let symbol = ir.symbols[definition.children[0]];
    for (const index of path === "" ? [] : path.split(".").map(Number)) symbol = symbol?.children?.[index] === undefined ? undefined : ir.symbols[symbol.children[index]];
    return symbol;
  };
  return checks.filter((check) => {
    const symbol = at(check.path);
    if (!symbol) return true;
    if (check.field === "text") {
      const entry = check.textIndex === undefined ? (symbol.children.length === 0 && symbol.texts.length === 1 ? symbol.texts[0] : undefined) : symbol.texts[check.textIndex];
      return entry?.value !== check.expected;
    }
    const prop = symbol.props.find((candidate: any) => candidate.name === check.field && typeof candidate.literal.value === "string");
    return !prop || !equalProp(check.field, prop.literal.value, check.expected);
  }).map((check) => `${check.nodeId}:${check.field}`);
}

/**
 * Write the plan for `nodeId` to its file, if it is still exactly the plan the person
 * previewed (`token`): the same file, becoming the same content. A change to the file or
 * to the layers since the preview is refused, and must be previewed again.
 */
export function writeBack(document: any, nodeId: unknown, folder: string, token: unknown): { plan: WriteBackPlan; operations: unknown[] } {
  const plan = planWriteBack(document, nodeId, folder);
  if (typeof token !== "string" || plan.token !== token) throw new StudioError(409, "plan-changed", `${plan.file} or the layers changed since the preview; preview it again`);
  if (plan.changes.length === 0) throw new StudioError(409, "nothing-to-write", "there are no changes to write back");
  const { absolute } = readSourceFile(folder, plan.file);
  const mode = statSync(absolute).mode & 0o777;
  const temporary = join(dirname(absolute), `.${randomUUID()}.lilac-tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, plan.after);
      // The file keeps its own permissions (the umask does not apply); its owner and group
      // are this user's, as Lilac writes it.
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Last check, just before the rename: the file is still exactly what was planned from.
    if (readSourceFile(folder, plan.file).sha256 !== plan.sha256) throw new StudioError(409, "plan-changed", `${plan.file} changed while it was being written; preview it again`);
    renameSync(temporary, absolute);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (error instanceof StudioError) throw error;
    throw new StudioError(500, "write-failed", `${plan.file} could not be written`);
  }
  return { plan, operations: plan.rebase.map(({ nodeId: id, codeSource }) => ({ type: "set-props", nodeId: id, set: { codeSource } })) };
}
