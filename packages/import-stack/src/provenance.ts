export const IMPORT_STACK_PROVENANCE = Object.freeze({
  paper: Object.freeze({
    posture: "authorized-behavior-evidence",
    // Retired from the tree in N0-G5; the record pins each file in Git history.
    evidence: Object.freeze({
      retired: "docs/provenance/RETIRED_PAPER_RECORDS.md",
      paths: Object.freeze([
        "docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-02.md",
        "docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-03.md",
        "docs/evidence/PAPER_LOCAL_RUNTIME_RECOVERY_2026-10-02.md",
      ]),
    }),
  }),
  docling: Object.freeze({
    repository: "docling-project/docling",
    revision: "0cd61e0050a9ef68e5e10495b87e41d31acd79c9",
    license: "MIT",
    posture: "optional-local-adapter",
  }),
  websiteDownloader: Object.freeze({
    repository: "AhmadIbrahiim/Website-downloader",
    revision: "130ad63d7163c19df64322556ca9c260eef353be",
    license: "MIT",
    posture: "small-fallback-adaptation",
  }),
  firecrawl: Object.freeze({
    repository: "firecrawl/firecrawl",
    revision: "4244638a7041bae8b99bdd42e3c44520f9e62da1",
    license: "AGPL-3.0",
    posture: "reference-and-optional-external-connector-only",
    importedCode: false,
  }),
  parse5: Object.freeze({
    version: "8.0.1",
    license: "MIT",
    posture: "html-parser-dependency",
  }),
});
