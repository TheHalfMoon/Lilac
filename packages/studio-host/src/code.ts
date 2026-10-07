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
      else if (/^[A-Za-z_][A-Za-z0-9_:.-]*$/u.test(name) && !/[\r\n]/u.test(value)) props[name] = value;
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
  const declared = /export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9]*)/u.exec(source)?.[1] ?? "Imported";
  let design: DesignDoc;
  try {
    const ir = buildCodeIr([{ path: `${declared}.jsx`, content: source }]);
    if (ir.rootIds.length === 0) throw new Error("the code has no JSX element to bring in");
    design = codeToDesign(ir, ir.rootIds[0], declared);
  } catch (error) {
    throw new StudioError(422, "code-refused", error instanceof Error ? error.message.slice(0, 300) : "the code could not be read");
  }
  const frameId = `page-code-${randomUUID().slice(0, 12)}`;
  const suffix = randomUUID().slice(0, 8);
  let count = 0;
  const nodes: unknown[] = [];
  const convert = (node: DesignDocNode, parentId: string): string => {
    count += 1;
    const id = `code-${suffix}-${count}`;
    const attributes: Record<string, string> = {};
    let style: Record<string, string> = {};
    for (const [name, value] of Object.entries(node.props)) {
      if (name === "className") attributes.class = String(value);
      else if (name === "style" && typeof value === "string") style = styleProperties({ cssText: value });
      else attributes[name] = String(value);
    }
    // A component (Button, Card) is kept as a named layer; the renderer draws it as a box.
    const component = /^[A-Z]/u.test(node.tag);
    const record = {
      id,
      type: "element",
      parentId,
      children: [] as string[],
      props: {
        tag: component ? "div" : node.tag,
        ...(component ? { name: node.tag } : {}),
        ...(node.text === undefined ? {} : { text: node.text }),
        attributes,
        style,
      },
      metadata: {},
    };
    nodes.push(record);
    record.children = (node.children ?? []).map((child) => convert(child, id));
    return id;
  };
  const frame = { id: frameId, type: "frame", parentId: null, children: [] as string[], props: { tag: "div", name: design.componentName, style: { position: "relative", width: "800px", "min-height": "400px", background: "#ffffff" } }, metadata: {} };
  frame.children = [convert(design.root, frameId)];
  return { operations: [{ type: "restore-subtree", rootId: frameId, parentId: null, nodes: [frame, ...nodes] }], frameId, componentName: design.componentName, layers: count };
}
