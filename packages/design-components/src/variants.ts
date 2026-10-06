import { applyPatch, codeToDesign, normalizeCodeIr, type CodeIr, type PatchOp } from "@lilac/code-ir";
import { DesignComponentsDriftError, DesignComponentsValidationError } from "./errors.ts";
import { bindContract, detectDrift } from "./binding.ts";
import {
  type BoundComponent,
  type ComponentContract,
  type ComponentPreview,
} from "./types.ts";
import { normalizeContract } from "./validation.ts";

function serializeLiteral(value: string | number | boolean): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return `{${String(value)}}`;
  return value ? "{true}" : "{false}";
}

/**
 * Apply a named variant exclusively through verified range-anchored patches.
 * Any drift blocks the update fail-closed: variants never apply to a live
 * component the contract no longer describes.
 */
export function applyVariant(
  irInput: CodeIr,
  filesInput: { path: string; content: string }[],
  boundInput: BoundComponent,
  contractInput: ComponentContract,
  variantName: string,
): { files: { path: string; content: string }[]; applied: number } {
  const ir = normalizeCodeIr(irInput);
  const contract = normalizeContract(contractInput);
  if (typeof variantName !== "string" || variantName === "") {
    throw new DesignComponentsValidationError("variant name is required");
  }
  const variant = contract.variants.find((entry) => entry.name === variantName);
  if (!variant) throw new DesignComponentsDriftError(`variant ${variantName} is not in contract ${contract.contractId}`);
  const drifts = detectDrift(ir, contract, boundInput.symbolId);
  if (drifts.length > 0) {
    throw new DesignComponentsDriftError(`variant ${variantName} refused: ${drifts.length} contract drift(s), first: ${drifts[0].kind} ${drifts[0].detail}`);
  }
  const symbol = ir.symbols[boundInput.symbolId];
  const liveProps = new Map(symbol.props.map((prop) => [prop.name, prop]));
  const files = new Map(filesInput.map((file) => [file.path, file.content]));
  const ops: PatchOp[] = [];
  for (const [name, value] of Object.entries(variant.props)) {
    const declared = contract.props.find((prop) => prop.name === name);
    if (!declared) throw new DesignComponentsDriftError(`variant prop ${name} is not in the contract`);
    const type = declared.propType;
    const matches =
      (type.kind === "string" && typeof value === "string")
      || (type.kind === "number" && typeof value === "number")
      || (type.kind === "boolean" && typeof value === "boolean")
      || (type.kind === "enum" && typeof value === "string" && type.values.includes(value));
    if (!matches) throw new DesignComponentsDriftError(`variant prop ${name} violates its declared type`);
    const live = liveProps.get(name);
    if (!live) throw new DesignComponentsDriftError(`variant prop ${name} has no live anchor`);
    if (live.literal.value === value) continue;
    const content = files.get(live.range.file);
    if (content === undefined) throw new DesignComponentsDriftError(`variant source file ${live.range.file} is not provided`);
    const expectedText = content.slice(live.range.startOffset, live.range.endOffset);
    ops.push({
      op: "update-prop",
      targetSymbolId: symbol.id,
      anchor: { range: live.range, expectedText },
      replacement: `${name}=${serializeLiteral(value)}`,
    });
  }
  bindContract(ir, contract, boundInput.symbolId);
  return applyPatch(ir, [...files.entries()].map(([path, content]) => ({ path, content })), ops);
}

/**
 * Render a source-linked preview document from the live symbol. The preview
 * carries the symbol identity and source range so it never detaches into a
 * flattened screenshot: it is the code, read back.
 */
export function previewComponent(irInput: CodeIr, boundInput: BoundComponent, contractInput: ComponentContract): ComponentPreview {
  const ir = normalizeCodeIr(irInput);
  normalizeContract(contractInput);
  const symbol = ir.symbols[boundInput.symbolId];
  if (!symbol) throw new DesignComponentsDriftError(`preview symbol ${boundInput.symbolId} is missing`);
  const renderedId = symbol.kind === "component" && symbol.children.length === 1 ? symbol.children[0] : symbol.id;
  const doc = codeToDesign(ir, renderedId, boundInput.componentName);
  return {
    componentName: boundInput.componentName,
    symbolId: symbol.id,
    sourceRange: { ...symbol.range },
    doc,
  };
}
