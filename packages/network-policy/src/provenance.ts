export const NETWORK_POLICY_PROVENANCE = {
  package: "@lilac/network-policy",
  posture: "Project-owned, default-deny network capability policy, bring-your-own provider registry, and offline readiness. Decides only; never opens connections, resolves names, or stores credential values. Address classification moved verbatim from @lilac/import-stack (Grain 6); since P06 G5a it also forbids IPv4-translated ::ffff:0:0:0/96, and design-assurance browser scans classify through it. No donor code is involved.",
} as const;
