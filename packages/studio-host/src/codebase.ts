import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
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
    real = realpathSync(folder);
  } catch {
    throw new StudioError(404, "folder-not-found", "that folder does not exist");
  }
  if (!statSync(real).isDirectory()) throw new StudioError(400, "not-a-folder", "that is a file, not a folder");
  const projects = realpathSync(projectsRoot);
  const inside = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
  if (inside(projects, real) || inside(real, projects)) throw new StudioError(400, "folder-overlaps-projects", "a codebase folder must be outside Lilac's projects folder");
  if (dirname(real) === real) throw new StudioError(400, "folder-is-root", "connect a project's folder, not the whole disk");
  return real;
}

/** A source file inside `folder`, by its path relative to it. */
export function readSourceFile(folder: string, file: unknown): { file: string; content: string; sha256: string; absolute: string } {
  if (typeof file !== "string" || file === "" || file.length > 512 || isAbsolute(file) || file.split(/[\\/]/u).some((part) => part === ".." || part === "") || !SOURCE.test(file)) {
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
  const real = realpathSync(absolute);
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
  /** The sha256 of the file the plan was made from; the write requires it unchanged. */
  sha256: string;
  diff: string;
  changes: Array<{ nodeId: string; field: string; from: string; to: string }>;
  conflicts: Array<{ nodeId: string; field: string; reason: string }>;
  notWritten: Array<{ nodeId: string; reason: string }>;
  after: string;
  /** The bound layers' new bases once written. */
  rebase: Array<{ nodeId: string; codeSource: CodeSource }>;
}

const cssText = (style: Record<string, string>) => Object.entries(style).map(([name, value]) => `${name}: ${value}`).join("; ");
const sameStyle = (a: string, b: Record<string, string>) => {
  const left = styleProperties({ cssText: a });
  return Object.keys(left).length === Object.keys(b).length && Object.entries(left).every(([name, value]) => b[name] === value);
};

/**
 * The layer's style as source text, in the source's own order (the layer keeps its style
 * keys sorted), with any new properties after: a write-back changes only what changed.
 */
function styleInSourceOrder(sourceText: string, style: Record<string, string>): string {
  const order = Object.keys(styleProperties({ cssText: sourceText }));
  const names = [...order.filter((name) => Object.hasOwn(style, name)), ...Object.keys(style).filter((name) => !order.includes(name))];
  return names.map((name) => `${name}: ${style[name]}`).join("; ");
}

/** The layer's current value for a source prop, as source text. */
function layerValue(node: any, prop: string): string | undefined {
  if (prop === "style") return cssText(node.props?.style ?? {});
  const attributes = node.props?.attributes ?? {};
  const name = prop === "className" ? "class" : prop === "htmlFor" ? "for" : prop;
  return typeof attributes[name] === "string" ? attributes[name] : undefined;
}

function equalProp(prop: string, a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (prop === "style") return sameStyle(a, styleProperties({ cssText: b }));
  return a === b;
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

/** What writing the bound layers under `nodeId` back to their file would change. */
export function planWriteBack(document: any, nodeId: unknown, folder: string): WriteBackPlan {
  if (typeof nodeId !== "string" || !Object.hasOwn(document.nodes, nodeId)) throw new StudioError(404, "node-not-found", "no such layer");
  // The bound layers in this subtree, all from one file and component.
  const bound: Array<{ node: any; source: CodeSource }> = [];
  const walk = (id: string) => {
    const node = document.nodes[id];
    if (!node) return;
    const source = node.props?.codeSource;
    if (source && typeof source === "object" && typeof source.file === "string" && typeof source.path === "string") bound.push({ node, source });
    for (const child of node.children) walk(child);
  };
  walk(nodeId);
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
  for (const { node, source } of bound) {
    const symbol = symbolAt(source.path);
    if (!symbol || symbol.name !== source.tag) {
      conflicts.push({ nodeId: node.id, field: "structure", reason: `the source no longer has <${source.tag}> there` });
      continue;
    }
    const nextBase: CodeSource["base"] = { props: { ...source.base.props }, ...(source.base.text === undefined ? {} : { text: source.base.text }) };
    // Text: a single literal text in the source.
    if (source.base.text !== undefined) {
      const fileText = symbol.children.length === 0 && symbol.texts.length === 1 ? symbol.texts[0].value : undefined;
      const mine = typeof node.props?.text === "string" ? node.props.text : "";
      if (fileText === undefined) conflicts.push({ nodeId: node.id, field: "text", reason: "the source's text is no longer one literal" });
      else if (mine === source.base.text) nextBase.text = fileText;
      else if (fileText === mine) nextBase.text = mine;
      else if (fileText !== source.base.text) conflicts.push({ nodeId: node.id, field: "text", reason: "changed both here and in the file" });
      else if (/[{}<>]/u.test(mine)) notWritten.push({ nodeId: node.id, reason: "text with { } < or > is not written as JSX text" });
      else {
        const range = symbol.texts[0].range;
        ops.push({ at: range.startOffset, op: { op: "update-text", targetSymbolId: symbol.id, anchor: { range, expectedText: read.content.slice(range.startOffset, range.endOffset) }, replacement: mine.replace(/&/gu, "&amp;") } });
        changes.push({ nodeId: node.id, field: "text", from: fileText, to: mine });
        nextBase.text = mine;
      }
    }
    // Literal string props.
    for (const [prop, base] of Object.entries(source.base.props)) {
      const fileProp = symbol.props.find((entry: any) => entry.name === prop && typeof entry.literal.value === "string");
      let mine = layerValue(node, prop);
      if (!fileProp) {
        conflicts.push({ nodeId: node.id, field: prop, reason: "no longer a literal string in the source" });
        continue;
      }
      const fileValue: string = fileProp.literal.value;
      if (mine === undefined) {
        notWritten.push({ nodeId: node.id, reason: `removing ${prop} is not written back` });
        continue;
      }
      if (equalProp(prop, mine, base)) {
        nextBase.props[prop] = fileValue;
        continue;
      }
      if (equalProp(prop, fileValue, mine)) {
        nextBase.props[prop] = fileValue;
        continue;
      }
      if (!equalProp(prop, fileValue, base)) {
        conflicts.push({ nodeId: node.id, field: prop, reason: "changed both here and in the file" });
        continue;
      }
      if (/[\r\n]/u.test(mine)) {
        notWritten.push({ nodeId: node.id, reason: `${prop} with a line break is not written` });
        continue;
      }
      if (prop === "style") mine = styleInSourceOrder(fileValue, node.props?.style ?? {});
      const range = fileProp.range;
      ops.push({ at: range.startOffset, op: { op: "update-prop", targetSymbolId: symbol.id, anchor: { range, expectedText: read.content.slice(range.startOffset, range.endOffset) }, replacement: `${prop}="${mine.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;")}"` } });
      changes.push({ nodeId: node.id, field: prop, from: fileValue, to: mine });
      nextBase.props[prop] = mine;
    }
    // Attributes the layer has but the source does not are not added.
    const sourceNames = new Set(Object.keys(source.base.props).map((prop) => (prop === "className" ? "class" : prop === "htmlFor" ? "for" : prop)));
    for (const name of Object.keys(node.props?.attributes ?? {})) if (!sourceNames.has(name)) notWritten.push({ nodeId: node.id, reason: `the new attribute ${name} is not written back` });
    if (Object.keys(node.props?.style ?? {}).length > 0 && !Object.hasOwn(source.base.props, "style")) notWritten.push({ nodeId: node.id, reason: "a style the source does not have is not written back" });
    rebase.push({ nodeId: node.id, codeSource: { ...source, base: nextBase } });
  }
  // Layers added or removed are not written back.
  const sourceCount = (() => {
    let count = 0;
    const visit = (symbol: any) => {
      count += 1;
      for (const child of symbol.children) visit(ir.symbols[child]);
    };
    visit(ir.symbols[definition.children[0]]);
    return count;
  })();
  if (sourceCount !== bound.length) notWritten.push({ nodeId, reason: "layers added or removed are not written back" });

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
  return { file: read.file, sha256: read.sha256, diff: unifiedDiff(read.file, read.content, after), changes, conflicts, notWritten, after, rebase };
}

/**
 * Write the plan for `nodeId` to its file, if the file is still the one previewed
 * (`expectedSha256`). Returns the plan written and the operations that update the bases.
 */
export function writeBack(document: any, nodeId: unknown, folder: string, expectedSha256: unknown): { plan: WriteBackPlan; operations: unknown[] } {
  const plan = planWriteBack(document, nodeId, folder);
  if (typeof expectedSha256 !== "string" || plan.sha256 !== expectedSha256) throw new StudioError(409, "file-changed", `${plan.file} changed since the preview; preview it again`);
  if (plan.changes.length === 0) throw new StudioError(409, "nothing-to-write", "there are no changes to write back");
  const { absolute } = readSourceFile(folder, plan.file);
  const mode = statSync(absolute).mode & 0o777;
  const temporary = join(dirname(absolute), `.${randomUUID()}.lilac-tmp`);
  try {
    const fd = openSync(temporary, "wx", mode);
    try {
      writeSync(fd, plan.after);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Last check, just before the rename: the file is still exactly what was planned from.
    if (readSourceFile(folder, plan.file).sha256 !== plan.sha256) throw new StudioError(409, "file-changed", `${plan.file} changed while it was being written; preview it again`);
    renameSync(temporary, absolute);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (error instanceof StudioError) throw error;
    throw new StudioError(500, "write-failed", `${plan.file} could not be written`);
  }
  return { plan, operations: plan.rebase.map(({ nodeId: id, codeSource }) => ({ type: "set-props", nodeId: id, set: { codeSource } })) };
}
