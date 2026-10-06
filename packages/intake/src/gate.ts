import { defaultImportPolicy, type ImportPolicy } from "@lilac/import-stack";
import { evaluateUrl, type UrlDecision } from "@lilac/network-policy";

export type NetworkImportPlan =
  | { allowed: true; importPolicy: ImportPolicy; decision: UrlDecision }
  | { allowed: false; reason: string; decision: UrlDecision };

/**
 * Decide whether a network import of `url` may happen under the project's network policy.
 * An allowed `import.fetch` decision maps to the matching import-stack policy (`local-app`
 * for loopback decisions, `remote` otherwise). Callers must still pass every resolved
 * address through `evaluateResolved(plan.decision, addresses)` before connecting; the
 * import-stack transport also applies its own resolved-address checks.
 */
export function planNetworkImport(networkPolicy: unknown, url: unknown): NetworkImportPlan {
  const decision = evaluateUrl(networkPolicy, { capability: "import.fetch", url });
  if (!decision.allowed) return { allowed: false, reason: decision.reason, decision };
  const importPolicy = defaultImportPolicy(decision.loopbackOnly ? "local-app" : "remote");
  return { allowed: true, importPolicy, decision };
}
