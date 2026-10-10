import { randomUUID } from "node:crypto";
import { buildCodeIr, designToCode, exportedComponents, type DesignDoc, type DesignDocNode } from "@ninerr/code-ir";
import { planElement } from "@ninerr/renderer";
import { StudioError } from "./errors.ts";
import { styleProperties } from "./imports.ts";

// The design/code workflow (PC6, gate 11), over @ninerr/code-ir.
//
// Export: a layer and what is inside it become one JSX function component. Each layer is
// first reduced by the renderer's own sanitizer (planElement), so the code says exactly
// what the canvas shows: the same tags, attributes and style. A text layer folds into its
// parent's text when it is the parent's only content. `class` becomes `className`; style
// is a CSS string prop (as Preact, Solid and Qwik accept it).
//
// Import: JSX in code-ir's supported subset becomes layers, inside a new page frame, as
// one history transaction. Anything outside the subset is refused by code-ir, not guessed.

const MAX_CODE_BYTES = 256 * 1024;
const MAX_EXPORT_DEPTH = 32;
const MAX_EXPORT_NODES = 5_000;

const pascal = (value: string, fallback: string) => {
  const name = value.replace(/[^A-Za-z0-9]+/gu, " ").trim().split(" ").filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  return /^[A-Z][A-Za-z0-9]*$/u.test(name) ? name.slice(0, 64) : fallback;
};

const cssText = (style: Record<string, string>) => Object.entries(style).map(([name, value]) => `${name}: ${value}`).join("; ");

/** A bare text layer: no tag, attributes or style of its own, so its text can fold. */
function bareText(node: any): string | null {
  if (node.type !== "text" || node.children.length > 0 || typeof node.props?.text !== "string") return null;
  const props = node.props;
  const plain = props.tag === undefined
    && (props.attributes === undefined || Object.keys(props.attributes).length === 0)
    && (props.style === undefined || Object.keys(props.style).length === 0);
  return plain ? props.text : null;
}

/** The JSX for a layer and everything inside it. */
export function exportJsx(document: any, nodeId: unknown): { componentName: string; code: string; layers: number } {
  if (typeof nodeId !== "string" || !Object.hasOwn(document.nodes, nodeId)) throw new StudioError(404, "node-not-found", "no such layer");
  let layers = 0;
  // Labels and the controls they name (for → id). The canvas never renders ids, but the
  // code needs them: each control a label in this export points to keeps an id, unique in
  // the export (a second copy of a form gets email-2), and its label points to that id. A
  // label names the next control with its id in document order, or else the last before.
  const order: string[] = [];
  const walkOrder = (id: string, depth: number) => {
    if (depth > MAX_EXPORT_DEPTH || !document.nodes[id]) return;
    // The same limit convert enforces, before any work is done on a larger export.
    if (order.length >= MAX_EXPORT_NODES) throw new StudioError(422, "export-too-large", `at most ${MAX_EXPORT_NODES} layers can be exported at once`);
    order.push(id);
    for (const child of document.nodes[id].children) walkOrder(child, depth + 1);
  };
  walkOrder(nodeId, 1);
  const SIMPLE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
  const attr = (id: string, name: string) => {
    const value = document.nodes[id]?.props?.attributes?.[name];
    return typeof value === "string" && SIMPLE_ID.test(value) ? value : null;
  };
  const exportedId = new Map<string, string>(); // control node → id in the code
  const labelTarget = new Map<string, string>(); // label node → id in the code
  const taken = new Set<string>();
  // Each id's positions in document order (ascending), so a label finds its control by
  // binary search: linear in the export, not labels × controls.
  const positionsOf = new Map<string, number[]>();
  order.forEach((id, position) => {
    const value = attr(id, "id");
    if (value === null) return;
    if (!positionsOf.has(value)) positionsOf.set(value, []);
    positionsOf.get(value)!.push(position);
  });
  order.forEach((labelId, position) => {
    const wanted = attr(labelId, "for");
    if (wanted === null) return;
    const positions = positionsOf.get(wanted);
    if (positions === undefined) return;
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (positions[middle] <= position) low = middle + 1;
      else high = middle;
    }
    // The next control after the label, or else the last one before it (never the label itself).
    let at = low < positions.length ? low : low - 1;
    if (at >= 0 && positions[at] === position) at -= 1;
    if (at < 0) return;
    const control = order[positions[at]];
    if (!exportedId.has(control)) {
      let candidate = wanted;
      for (let copy = 2; taken.has(candidate); copy += 1) candidate = `${wanted}-${copy}`;
      taken.add(candidate);
      exportedId.set(control, candidate);
    }
    labelTarget.set(labelId, exportedId.get(control)!);
  });
  const convert = (id: string, depth: number): DesignDocNode => {
    if (depth > MAX_EXPORT_DEPTH) throw new StudioError(422, "export-too-deep", `layers nested more than ${MAX_EXPORT_DEPTH} deep cannot be exported`);
    layers += 1;
    if (layers > MAX_EXPORT_NODES) throw new StudioError(422, "export-too-large", `at most ${MAX_EXPORT_NODES} layers can be exported at once`);
    const node = document.nodes[id];
    const plan = planElement(node);
    const props: Record<string, string> = {};
    for (const [name, value] of Object.entries(plan.attributes as Record<string, string>)) {
      if (name === "data-ninerr-href") props.href = value;
      else if (name === "class") props.className = value;
      else if (name === "for") props.htmlFor = value;
      else if (/^[A-Za-z_][A-Za-z0-9_:.-]*$/u.test(name) && !/[\r\n]/u.test(value)) props[name] = value;
    }
    if (exportedId.has(id)) props.id = exportedId.get(id)!;
    if (labelTarget.has(id)) props.htmlFor = labelTarget.get(id)!;
    else if (props.htmlFor !== undefined) delete props.htmlFor; // names nothing in this export
    if (Object.keys(plan.style).length > 0) props.style = cssText(plan.style);
    const out: DesignDocNode = { tag: plan.tag, props };
    const childIds: string[] = node.children;
    const folded = childIds.length > 0 && childIds.every((child) => bareText(document.nodes[child]) !== null);
    let text = typeof plan.text === "string" ? plan.text : "";
    if (folded) text += childIds.map((child) => bareText(document.nodes[child])).join("");
    if (text !== "") out.text = text;
    if (!folded && childIds.length > 0) out.children = childIds.map((child) => convert(child, depth + 1));
    return out;
  };
  const root = document.nodes[nodeId];
  const componentName = pascal(typeof root.props?.name === "string" ? root.props.name : "", "Layer");
  const design: DesignDoc = { componentName, root: convert(nodeId, 1) };
  try {
    return { componentName, code: designToCode(design), layers };
  } catch (error) {
    throw new StudioError(422, "export-refused", error instanceof Error ? error.message.slice(0, 300) : "this layer cannot be exported");
  }
}

/** Layers for JSX source, inside a new page frame, as one operation. */
/** Where a layer brought in from a connected codebase came from (PC11). */
export interface CodeSource {
  file: string;
  component: string;
  /** Child indexes from the component's root element ("" is the root). */
  path: string;
  /** The element's tag; "#text" for a run of text inside an element with children. */
  tag: string;
  /** For a run of text: its index among the element's texts. */
  textIndex?: number;
  /** The source's literal values when it was brought in (or last written back). */
  base: { text?: string; props: Record<string, string> };
  /**
   * What is code in the source and never written back (P08-G11, #282): for an element, its
   * attributes that are code (by their layer names, class for className); for a {…} part
   * ("#expression"), its source text as the layer shows it.
   */
  code?: string[];
  /**
   * For an element or fragment: its children in the source when it was brought in, in order
   * (each child's tag, "#expression", "#fragment", or "#text" for a run of text). A layer is
   * found in the file by its position, so when these no longer line up, nothing under the
   * element is written back (#285).
   */
  shape?: string[];
  /**
   * A write-back recorded before its file was renamed into place and not yet confirmed: the
   * bases it writes, the SHA-256 the file has once it lands, and the name of the temporary
   * file next to it that becomes the file (#185). See codebase.ts, pendingState.
   */
  pending?: { base: { text?: string; props: Record<string, string> }; sha256: string; temp?: string };
}

/** An element tag the canvas draws as itself (svg's linearGradient too); others are named boxes. */
const PLAIN_TAG = /^[a-z][A-Za-z0-9]*$/u;
/** A prop name a layer attribute can take: what the design subset allows. */
const DESIGN_NAME = /^[A-Za-z][A-Za-z0-9-]*$/u;
/** The layer's name for a source prop: class for className, for for htmlFor. */
const LAYER_NAMES = new Map([["className", "class"], ["htmlFor", "for"]]);
export const layerName = (prop: string) => LAYER_NAMES.get(prop) ?? prop;

/** An element's children in source order, as CodeSource.shape records them. */
export function sourceShape(ir: any, symbol: any): string[] {
  return [
    ...symbol.texts.filter((entry: any) => entry.value !== "").map((entry: any) => ({ at: entry.range.startOffset, name: "#text" })),
    ...symbol.children.map((child: string) => ({ at: ir.symbols[child].range.startOffset, name: ir.symbols[child].name })),
  ].sort((a, b) => a.at - b.at).map((piece) => piece.name);
}

export interface ImportJsxOptions {
  /** The source file's path, as code-ir records it (its extension picks JSX or TSX). */
  path?: string;
  /** The exported component to bring in; by default, the first one. */
  component?: string;
  /** Record each element layer's source in props.codeSource, for writing edits back. */
  bind?: boolean;
}

export function importJsx(source: unknown, options: ImportJsxOptions = {}): { operations: unknown[]; frameId: string; componentName: string; layers: number } {
  if (typeof source !== "string" || source.trim() === "") throw new StudioError(400, "invalid-code", "code must be a non-empty string");
  if (Buffer.byteLength(source) > MAX_CODE_BYTES) throw new StudioError(413, "code-too-large", "code is limited to 256 KiB");
  const refuse = (message: string) => new StudioError(422, "code-refused", message.slice(0, 300));
  // Pasted code is read as TSX, which also reads JSX; a file by its own extension.
  const sourcePath = options.path ?? "Imported.tsx";
  let ir: any;
  let exportedNames: string[];
  try {
    // Each name once: a source can repeat a declaration thousands of times (#250).
    exportedNames = exportedComponents(sourcePath, source);
    ir = buildCodeIr([{ path: sourcePath, content: source }]);
  } catch (error) {
    throw refuse(error instanceof Error ? error.message : "the code could not be read");
  }
  // The exported component's own element, by name, not whichever element came first.
  // A component's definition is the component symbol whose element is a root; a JSX use of
  // the same name (<Button>) is also a component symbol, but inside another element. The
  // first exported function with a definition is brought in (others in the file are not).
  // Built once, so finding definitions stays linear in the symbols however many names there are.
  const roots = new Set(ir.rootIds);
  const definitions = new Map<string, any>();
  for (const symbol of Object.values(ir.symbols) as any[]) {
    if (symbol.kind === "component" && symbol.children.length > 0 && roots.has(symbol.children[0]) && !definitions.has(symbol.name)) definitions.set(symbol.name, symbol);
  }
  const definitionOf = (name: string) => definitions.get(name);
  if (options.component !== undefined && !exportedNames.includes(options.component)) throw refuse(`${options.component} is not an exported function component of this file`);
  const declared = options.component ?? exportedNames.find((name) => definitionOf(name) !== undefined) ?? exportedNames[0] ?? null;
  const component = declared === null ? undefined : definitionOf(declared);
  const rootId = component ? component.children[0] : (declared === null && ir.rootIds.length === 1 ? ir.rootIds[0] : null);
  // JSX that code-ir cannot read gives no element at all (it is refused whole, never partly
  // imported), so a component whose own JSX cannot be read has no element here; the file's
  // first such construct is named. What cannot be read elsewhere is not this component's.
  if (!rootId) {
    const first = ir.unsupported[0];
    const why = first === undefined ? "" : ` (this file uses something Ninerr cannot bring in yet: ${String(first.reason)}, line ${first.range?.startLine ?? "?"})`;
    throw refuse(declared === null ? "bring in one exported function component, e.g. export function Card() { return <section>…</section>; }" : `${declared} does not return a JSX element Ninerr can read${why}`);
  }
  const componentName = declared ?? "Imported";

  const frameId = `page-code-${randomUUID().slice(0, 12)}`;
  const suffix = randomUUID().slice(0, 8);
  let count = 0;
  const nodes: unknown[] = [];
  const nextId = () => `code-${suffix}-${++count}`;
  const convert = (symbolId: string, parentId: string, name?: string, path: number[] = []): string => {
    const symbol = ir.symbols[symbolId];
    const id = nextId();
    if (symbol.kind === "expression") {
      // A {…} part is code: a text layer that shows it, bound so a write-back knows to leave it.
      const shown = `{${symbol.code}}`;
      const props: Record<string, unknown> = { name: "Code", text: shown };
      if (options.bind) props.codeSource = { file: options.path ?? "", component: componentName, path: path.join("."), tag: "#expression", base: { props: {} }, code: [shown] } satisfies CodeSource;
      nodes.push({ id, type: "text", parentId, children: [], props, metadata: {} });
      return id;
    }
    const attributes: Record<string, string> = {};
    let style: Record<string, string> = {};
    // Only names a design attribute can have (no __proto__): others stay code in the source.
    const designable = (prop: any) => DESIGN_NAME.test(prop.name);
    for (const prop of symbol.props.filter(designable)) {
      const value = prop.literal.value;
      if (value === false) continue; // absent, as in JSX
      const text = value === true ? "" : String(value);
      if (prop.name === "className") attributes.class = text;
      else if (prop.name === "htmlFor") attributes.for = text;
      else if (prop.name === "style" && typeof value === "string") style = styleProperties({ cssText: value });
      else attributes[prop.name] = text;
    }
    // A component (Button, Item.Skeleton) or a name that is not a plain tag is kept as a named
    // layer the canvas draws as a box; a fragment is a box that takes no part in layout.
    const fragment = symbol.kind === "fragment";
    const named = fragment || !PLAIN_TAG.test(symbol.name);
    if (fragment) style = { display: "contents" };
    const label = name ?? (fragment ? "Fragment" : symbol.name);
    const record: any = {
      id,
      type: "element",
      parentId,
      children: [],
      props: { tag: named ? "div" : symbol.name, ...(named || name ? { name: label } : {}), attributes, style },
      metadata: {},
    };
    if (options.bind) {
      // The source's literal values, the base a later write-back compares against.
      const base: CodeSource["base"] = { props: {} };
      for (const prop of symbol.props.filter(designable)) if (typeof prop.literal.value === "string") base.props[prop.name] = prop.literal.value;
      if (symbol.children.length === 0 && symbol.texts.length === 1) base.text = symbol.texts[0].value;
      const codeSource: CodeSource = { file: options.path ?? "", component: componentName, path: path.join("."), tag: symbol.name, base };
      // Attributes that are code, by the names a layer would give them.
      const code = [...(symbol.codeProps ?? []).map((prop: any) => layerName(prop.name)), ...symbol.props.filter((prop: any) => !designable(prop)).map((prop: any) => prop.name)];
      if (code.length > 0) codeSource.code = code;
      codeSource.shape = sourceShape(ir, symbol);
      record.props.codeSource = codeSource;
    }
    nodes.push(record);
    // Text and elements in the order they appear in the source: text alone is the
    // element's own text; mixed with elements, each run of text is its own text layer.
    const pieces = [
      ...symbol.texts.map((entry: any, textIndex: number) => ({ at: entry.range.startOffset, text: entry.value, textIndex })),
      ...symbol.children.map((child: string, childIndex: number) => ({ at: ir.symbols[child].range.startOffset, child, childIndex })),
    ].sort((a, b) => a.at - b.at);
    if (symbol.children.length === 0) {
      const text = symbol.texts.map((entry: any) => entry.value).join("");
      if (text !== "") record.props.text = text;
    } else {
      for (const piece of pieces) {
        if (piece.child !== undefined) record.children.push(convert(piece.child, id, undefined, [...path, piece.childIndex]));
        else if (piece.text !== "") {
          const textId = nextId();
          const textProps: Record<string, unknown> = { text: piece.text };
          // A run of text is bound too, by its element and its index among the element's texts.
          if (options.bind) textProps.codeSource = { file: options.path ?? "", component: componentName, path: path.join("."), tag: "#text", textIndex: piece.textIndex, base: { text: piece.text, props: {} } } satisfies CodeSource;
          nodes.push({ id: textId, type: "text", parentId: id, children: [], props: textProps, metadata: {} });
          record.children.push(textId);
        }
      }
    }
    return id;
  };
  const frame = { id: frameId, type: "frame", parentId: null, children: [] as string[], props: { tag: "div", name: componentName, style: { position: "relative", width: "800px", "min-height": "400px", background: "#ffffff" } }, metadata: {} };
  frame.children = [convert(rootId, frameId, componentName)];
  return { operations: [{ type: "restore-subtree", rootId: frameId, parentId: null, nodes: [frame, ...nodes] }], frameId, componentName, layers: count };
}
