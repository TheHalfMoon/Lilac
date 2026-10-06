export const NETWORK_POLICY_PROVENANCE = {
  package: "@lilac/network-policy",
  posture: "Project-owned, default-deny network capability policy, bring-your-own provider registry, and offline readiness. Decides only; never opens connections, resolves names, or stores credential values. Address classification moved verbatim from @lilac/import-stack (Grain 6). No donor code is involved.",
} as const;
