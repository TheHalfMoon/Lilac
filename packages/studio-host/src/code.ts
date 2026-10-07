import { randomUUID } from "node:crypto";
import { buildCodeIr, codeToDesign, designToCode, type DesignDoc, type DesignDocNode } from "@lilac/code-ir";
import { planElement } from "@lilac/renderer";
import { StudioError } from "./errors.ts";
import { styleProperties } from "./imports.ts";

// The design/code workflow (PC6, gate 11), over @lilac/code-ir.
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
  // The ids labels in this subtree point to (for), so their controls keep them.
  const referenced = new Set<string>();
  const usedIds = new Set<string>();
  const collect = (id: string, depth: number) => {
    if (depth > MAX_EXPORT_DEPTH) return;
    const target = document.nodes[id]?.props?.attributes?.for;
    if (typeof target === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(target)) referenced.add(target);
    for (const child of document.nodes[id]?.children ?? []) collect(child, depth + 1);
  };
  collect(nodeId, 1);
  const convert = (id: string, depth: number): DesignDocNode => {
    if (depth > MAX_EXPORT_DEPTH) throw new StudioError(422, "export-too-deep", `layers nested more than ${MAX_EXPORT_DEPTH} deep cannot be exported`);
    layers += 1;
    if (layers > MAX_EXPORT_NODES) throw new StudioError(422, "export-too-large", `at most ${MAX_EXPORT_NODES} layers can be exported at once`);
    const node = document.nodes[id];
    const plan = planElement(node);
    const props: Record<string, string> = {};
    for (const [name, value] of Object.entries(plan.attributes as Record<string, string>)) {
      if (name === "data-lilac-href") props.href = value;
      else if (name === "class") props.className = value;
      else if (name === "for") props.htmlFor = value;
      else if (/^[A-Za-z_][A-Za-z0-9_:.-]*$/u.test(name) && !/[\r\n]/u.test(value)) props[name] = value;
    }
    // The canvas never renders ids, but a label's htmlFor needs its control's id in the
    // code: an id is kept only when a label in this export points to it, and only once.
    const ownId = node.props?.attributes?.id;
    if (typeof ownId === "string" && referenced.has(ownId) && !usedIds.has(ownId)) {
      props.id = ownId;
      usedIds.add(ownId);
    }
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
export function importJsx(source: unknown): { operations: unknown[]; frameId: string; componentName: string; layers: number } {
  if (typeof source !== "string" || source.trim() === "") throw new StudioError(400, "invalid-code", "code must be a non-empty string");
  if (Buffer.byteLength(source) > MAX_CODE_BYTES) throw new StudioError(413, "code-too-large", "code is limited to 256 KiB");
  const refuse = (message: string) => new StudioError(422, "code-refused", message.slice(0, 300));
  const exportedNames = [...source.matchAll(/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9]*)/gu)].map((match) => match[1]);
  let ir: any;
  try {
    ir = buildCodeIr([{ path: `${exportedNames[0] ?? "Imported"}.jsx`, content: source }]);
  } catch (error) {
    throw refuse(error instanceof Error ? error.message : "the code could not be read");
  }
  // Anything code-ir could not read is refused as a whole, never partly imported.
  if (ir.unsupported.length > 0) {
    const first = ir.unsupported[0];
    throw refuse(`this code uses something Lilac cannot bring in yet (${String(first.reason ?? first.kind ?? "unsupported construct")}, line ${first.range?.startLine ?? "?"})`);
  }
  // The exported component's own element, by name, not whichever element came first.
  // A component's definition is the component symbol whose element is a root; a JSX use of
  // the same name (<Button>) is also a component symbol, but inside another element. The
  // first exported function with a definition is brought in (others in the file are not).
  const symbols = Object.values(ir.symbols) as any[];
  const definitionOf = (name: string) => symbols.find((symbol) => symbol.kind === "component" && symbol.name === name && symbol.children.length > 0 && ir.rootIds.includes(symbol.children[0]));
  const declared = exportedNames.find((name) => definitionOf(name) !== undefined) ?? exportedNames[0] ?? null;
  const component = declared === null ? undefined : definitionOf(declared);
  const rootId = component ? component.children[0] : (declared === null && ir.rootIds.length === 1 ? ir.rootIds[0] : null);
  if (!rootId) throw refuse(declared === null ? "bring in one exported function component, e.g. export function Card() { return <section>…</section>; }" : `${declared} does not return a JSX element`);
  const componentName = declared ?? "Imported";
  // Keep the subset codeToDesign accepts (literal props, element trees) as the gate.
  try {
    codeToDesign(ir, rootId, componentName);
  } catch (error) {
    throw refuse(error instanceof Error ? error.message : "the code could not be read");
  }

  const frameId = `page-code-${randomUUID().slice(0, 12)}`;
  const suffix = randomUUID().slice(0, 8);
  let count = 0;
  const nodes: unknown[] = [];
  const nextId = () => `code-${suffix}-${++count}`;
  const convert = (symbolId: string, parentId: string, name?: string): string => {
    const symbol = ir.symbols[symbolId];
    const id = nextId();
    const attributes: Record<string, string> = {};
    let style: Record<string, string> = {};
    for (const prop of symbol.props) {
      const value = prop.literal.value;
      if (value === false) continue; // absent, as in JSX
      const text = value === true ? "" : String(value);
      if (prop.name === "className") attributes.class = text;
      else if (prop.name === "htmlFor") attributes.for = text;
      else if (prop.name === "style" && typeof value === "string") style = styleProperties({ cssText: value });
      else attributes[prop.name] = text;
    }
    // A component (Button, Card) is kept as a named layer; the canvas draws it as a box.
    const isComponent = /^[A-Z]/u.test(symbol.name);
    const record: any = {
      id,
      type: "element",
      parentId,
      children: [],
      props: { tag: isComponent ? "div" : symbol.name, ...(isComponent || name ? { name: name ?? symbol.name } : {}), attributes, style },
      metadata: {},
    };
    nodes.push(record);
    // Text and elements in the order they appear in the source: text alone is the
    // element's own text; mixed with elements, each run of text is its own text layer.
    const pieces = [
      ...symbol.texts.map((entry: any) => ({ at: entry.range.startOffset, text: entry.value })),
      ...symbol.children.map((child: string) => ({ at: ir.symbols[child].range.startOffset, child })),
    ].sort((a, b) => a.at - b.at);
    if (symbol.children.length === 0) {
      const text = symbol.texts.map((entry: any) => entry.value).join("");
      if (text !== "") record.props.text = text;
    } else {
      for (const piece of pieces) {
        if (piece.child !== undefined) record.children.push(convert(piece.child, id));
        else if (piece.text !== "") {
          const textId = nextId();
          nodes.push({ id: textId, type: "text", parentId: id, children: [], props: { text: piece.text }, metadata: {} });
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
