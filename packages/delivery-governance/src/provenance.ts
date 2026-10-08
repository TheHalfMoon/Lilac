export const DELIVERY_GOVERNANCE_PROVENANCE = {
  package: "@ninerr/delivery-governance",
  guidanceDonor: "kunchenguid/no-mistakes",
  donorRevision: "0616eb4911845e2ba04faa17186ecd2686d7d579",
  donorLicense: "MIT",
  studiedSurfaces: [
    "skills/no-mistakes/SKILL.md",
    "internal/gate/gate.go",
    "internal/gate/reconcile.go",
    "internal/custody/refs.go",
    "internal/evidence",
    ".no-mistakes.yaml",
  ],
  posture: "Governance semantics only. Ninerr reimplements exact-head proof, create-only evidence, conflict-fails-closed anchors, parked human decisions, and forward-only delivery as project-owned code. No donor daemon, proxy, hooks, database, billing, or forge machinery is imported.",
} as const;
