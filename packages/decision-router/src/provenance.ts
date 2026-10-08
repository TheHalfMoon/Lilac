export const DECISION_ROUTER_PROVENANCE = {
  package: "@ninerr/decision-router",
  guidanceDonor: "mrmps/classifier-dev",
  donorRevision: "a17bf2b6353f6234af6e977a463da7cd1975b68e",
  donorLicense: "MIT",
  studiedSurfaces: [
    "src/dimensions.ts",
    "src/jev.ts",
    "src/mcp.ts",
  ],
  posture: "Guidance only. Ninerr reimplements dimension/label schemas, bounds, batching, threshold, and review-routing semantics as project-owned code. No donor SaaS, billing, quota, gateway, analytics, or frontend code is imported.",
} as const;
