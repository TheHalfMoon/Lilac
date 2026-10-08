import { NetworkPolicyValidationError } from "./errors.ts";
import { normalizeNetworkPolicy } from "./policy.ts";
import { normalizeProviderRegistry, resolveProvider } from "./providers.ts";
import { PROVIDER_CAPABILITIES, type FeatureRequirement, type ReadinessReport } from "./types.ts";

/**
 * The core workflow and what each step needs from providers. Required features need no
 * provider; that declaration is not self-proving, so every required feature here is
 * exercised one-for-one, with all network primitives trapped, by
 * tests/offline-guarantee.test.mjs. Optional features degrade (or are unavailable) without
 * a provider. Only features that exist in Ninerr today are listed; the local MCP endpoint
 * is not implemented yet (#82).
 */
export const CORE_FEATURES: readonly FeatureRequirement[] = Object.freeze([
  { feature: "document.edit", required: true, needs: [] },
  { feature: "history.undo-redo", required: true, needs: [] },
  { feature: "collaboration.agent-edit", required: true, needs: [] },
  { feature: "project.save-reopen", required: true, needs: [] },
  { feature: "design.method-review", required: true, needs: [] },
  { feature: "decision.assurance", required: true, needs: [] },
  { feature: "import.offline-html", required: true, needs: [] },
  { feature: "decision.model-ranking", required: false, needs: ["inference.text"] },
]);

/** Report which features are satisfiable under a policy and registry, without any network I/O. */
export function evaluateOfflineReadiness(registryInput: unknown, policyInput: unknown, features: readonly FeatureRequirement[] = CORE_FEATURES): ReadinessReport {
  const registry = normalizeProviderRegistry(registryInput);
  const policy = normalizeNetworkPolicy(policyInput);
  if (!Array.isArray(features) || features.length === 0 || features.length > 256) {
    throw new NetworkPolicyValidationError("features must list 1..256 requirements");
  }
  const report: ReadinessReport["features"] = features.map((requirement) => {
    if (!requirement || typeof requirement.feature !== "string" || !Array.isArray(requirement.needs)) {
      throw new NetworkPolicyValidationError("feature requirements must have a name and a needs list");
    }
    const providers: ReadinessReport["features"][number]["providers"] = {};
    const missing: ReadinessReport["features"][number]["missing"] = [];
    for (const need of requirement.needs) {
      if (!(PROVIDER_CAPABILITIES as readonly string[]).includes(need)) throw new NetworkPolicyValidationError(`unknown provider capability ${String(need).slice(0, 40)}`);
      const resolution = resolveProvider(registry, policy, need);
      if (resolution.provider) providers[need] = resolution.provider.id;
      else missing.push(need);
    }
    return { feature: requirement.feature, required: requirement.required === true, satisfiable: missing.length === 0, providers, missing };
  });
  return { ready: report.every((entry) => !entry.required || entry.satisfiable), features: report };
}
