import { normalizeCodeIr, type CodeIr, type SourceSymbol } from "@ninerr/code-ir";
import { DesignComponentsDriftError, DesignComponentsValidationError } from "./errors.ts";
import {
  type BoundComponent,
  type ComponentContract,
  type ContractDrift,
} from "./types.ts";
import { normalizeContract } from "./validation.ts";

function findSymbol(ir: CodeIr, contract: ComponentContract, symbolId: string | undefined): SourceSymbol {
  if (symbolId !== undefined) {
    const symbol = ir.symbols[symbolId];
    if (!symbol) throw new DesignComponentsDriftError(`component symbol ${symbolId} is missing`);
    return symbol;
  }
  const matches = Object.values(ir.symbols).filter(
    (symbol) => symbol.kind === "component" && symbol.name === contract.componentName && symbol.range.file === contract.sourceFile,
  );
  if (matches.length === 0) {
    throw new DesignComponentsDriftError(`component ${contract.componentName} has no symbol in ${contract.sourceFile}`);
  }
  if (matches.length > 1) {
    throw new DesignComponentsDriftError(`component ${contract.componentName} matches ${matches.length} symbols; pass an explicit symbolId`);
  }
  return matches[0];
}

function renderedElement(ir: CodeIr, symbol: SourceSymbol): SourceSymbol {
  if (symbol.kind !== "component") return symbol;
  if (symbol.children.length !== 1) {
    throw new DesignComponentsDriftError(`component ${symbol.id} does not render exactly one root element`);
  }
  const root = ir.symbols[symbol.children[0]];
  if (!root) throw new DesignComponentsDriftError(`component render target ${symbol.children[0]} is missing`);
  return root;
}

function literalMatches(prop: ComponentContract["props"][number], value: string | number | boolean): boolean {
  const type = prop.propType;
  if (type.kind === "string") return typeof value === "string";
  if (type.kind === "number") return typeof value === "number";
  if (type.kind === "boolean") return typeof value === "boolean";
  return typeof value === "string" && type.values.includes(value);
}

/**
 * Bind a contract to a live IR symbol with strict shape validation.
 * Prop types, required props, and slot structure must all match; anything
 * else fails closed with a reason instead of guessing.
 */
export function bindContract(irInput: CodeIr, contractInput: ComponentContract, symbolId?: string): BoundComponent {
  const ir = normalizeCodeIr(irInput);
  const contract = normalizeContract(contractInput);
  const symbol = findSymbol(ir, contract, symbolId);
  if (symbol.kind !== "component") {
    throw new DesignComponentsValidationError(`binding target ${symbol.id} is a ${symbol.kind}, not a component`);
  }
  if (symbol.name !== contract.componentName) {
    throw new DesignComponentsDriftError(`binding target is ${symbol.name}, contract expects ${contract.componentName}`);
  }
  if (symbol.range.file !== contract.sourceFile) {
    throw new DesignComponentsDriftError(`binding target lives in ${symbol.range.file}, contract expects ${contract.sourceFile}`);
  }
  const liveProps = new Map(symbol.props.map((prop) => [prop.name, prop.literal.value]));
  const boundProps: Record<string, string | number | boolean> = {};
  for (const prop of contract.props) {
    if (!liveProps.has(prop.name)) {
      if (prop.required) throw new DesignComponentsDriftError(`required prop ${prop.name} is missing from ${symbol.id}`);
      if (prop.default !== undefined) boundProps[prop.name] = prop.default;
      continue;
    }
    const live = liveProps.get(prop.name) as string | number | boolean;
    if (!literalMatches(prop, live)) {
      throw new DesignComponentsDriftError(`prop ${prop.name} violates its declared type`);
    }
    boundProps[prop.name] = live;
  }
  const rendered = renderedElement(ir, symbol);
  const childTags = rendered.children.map((childId) => {
    const child = ir.symbols[childId];
    if (!child) throw new DesignComponentsDriftError(`component child ${childId} is missing`);
    return child.name;
  });
  if (childTags.length !== contract.slots.length) {
    throw new DesignComponentsDriftError(`component has ${childTags.length} element children but the contract declares ${contract.slots.length} slots`);
  }
  contract.slots.forEach((slot, index) => {
    if (childTags[index] !== slot.tag) {
      throw new DesignComponentsDriftError(`slot ${slot.name} expects <${slot.tag}> but found <${childTags[index]}>`);
    }
  });
  return {
    contractId: contract.contractId,
    componentName: contract.componentName,
    symbolId: symbol.id,
    sourceFile: symbol.range.file,
    range: { ...symbol.range },
    boundProps,
  };
}

/**
 * Compare live IR against a contract and report every drift class.
 * Drift never auto-heals: callers must fail closed on any entry.
 */
export function detectDrift(irInput: CodeIr, contractInput: ComponentContract, symbolId?: string): ContractDrift[] {
  const ir = normalizeCodeIr(irInput);
  const contract = normalizeContract(contractInput);
  const drifts: ContractDrift[] = [];
  let symbol: SourceSymbol | undefined;
  try {
    symbol = findSymbol(ir, contract, symbolId);
  } catch {
    drifts.push({ kind: "missing-symbol", detail: `component ${contract.componentName} has no live symbol` });
    return drifts;
  }
  if (symbol.name !== contract.componentName) {
    drifts.push({ kind: "renamed-symbol", detail: `live symbol is ${symbol.name}` });
  }
  const liveProps = new Map(symbol.props.map((prop) => [prop.name, prop.literal.value]));
  for (const prop of contract.props) {
    if (!liveProps.has(prop.name)) {
      drifts.push({ kind: "missing-prop", detail: `prop ${prop.name} is missing` });
      continue;
    }
    const live = liveProps.get(prop.name) as string | number | boolean;
    const type = prop.propType;
    const matches =
      (type.kind === "string" && typeof live === "string")
      || (type.kind === "number" && typeof live === "number")
      || (type.kind === "boolean" && typeof live === "boolean")
      || (type.kind === "enum" && typeof live === "string" && type.values.includes(live));
    if (!matches) {
      if (type.kind === "enum" && typeof live === "string") {
        drifts.push({ kind: "enum-violated", detail: `prop ${prop.name} value is outside its enum` });
      } else {
        drifts.push({ kind: "type-changed", detail: `prop ${prop.name} changed type` });
      }
    }
  }
  for (const name of liveProps.keys()) {
    if (!contract.props.some((prop) => prop.name === name)) {
      drifts.push({ kind: "extra-prop", detail: `prop ${name} is not in the contract` });
    }
  }
  const rendered = renderedElement(ir, symbol);
  const childTags = rendered.children.map((childId) => ir.symbols[childId]?.name ?? "");
  if (childTags.length < contract.slots.filter((slot) => slot.required).length) {
    drifts.push({ kind: "missing-slot", detail: "required slot content is missing" });
  }
  if (childTags.length > contract.slots.length) {
    drifts.push({ kind: "extra-slot", detail: "element children exceed declared slots" });
  }
  contract.slots.slice(0, childTags.length).forEach((slot, index) => {
    if (childTags[index] !== slot.tag) {
      drifts.push({ kind: "missing-slot", detail: `slot ${slot.name} expects <${slot.tag}>` });
    }
  });
  return drifts;
}
