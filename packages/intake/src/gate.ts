import { defaultImportPolicy, type ImportPolicy } from "@ninerr/import-stack";
import { evaluateUrl, type UrlDecision } from "@ninerr/network-policy";

export type NetworkImportPlan =
  | { allowed: true; importPolicy: ImportPolicy; decision: UrlDecision }
  | { allowed: false; reason: string; decision: UrlDecision };

/**
 * Decide whether a network import of `url` may happen under the project's network policy.
 * An allowed `import.fetch` decision maps to the matching import-stack policy (`local-app`
 * for loopback decisions, `remote` otherwise). Pass the same network policy as
 * `networkPolicy` on the import request: import-stack then requires an allowed `import.fetch`
 * decision for every URL it contacts and checks the addresses it connects to with
 * `evaluateResolved` (#83), so this plan is an early answer, not the enforcement point.
 *
 * The returned import policy is generic for its mode and never looser than the decision:
 * import-stack enforces both policies together, and its remote mode refuses private and
 * reserved addresses even when a grant sets allowPrivateNetwork.
 */
export function planNetworkImport(networkPolicy: unknown, url: unknown): NetworkImportPlan {
  const decision = evaluateUrl(networkPolicy, { capability: "import.fetch", url });
  if (!decision.allowed) return { allowed: false, reason: decision.reason, decision };
  const importPolicy = defaultImportPolicy(decision.loopbackOnly ? "local-app" : "remote");
  return { allowed: true, importPolicy, decision };
}
