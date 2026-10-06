import type { ComponentContract, DesignSystem } from "./types.ts";
import { normalizeContract, normalizeSystem } from "./validation.ts";

export function systemHas(systemInput: DesignSystem, contractId: string): boolean {
  const system = normalizeSystem(systemInput);
  if (typeof contractId !== "string" || contractId === "") return false;
  return system.contracts.some((contract) => contract.contractId === contractId);
}

export function systemContractsFor(systemInput: DesignSystem, systemId: string): ComponentContract[] {
  const system = normalizeSystem(systemInput);
  return system.contracts.filter((contract) => contract.systemId === undefined || contract.systemId === systemId);
}
