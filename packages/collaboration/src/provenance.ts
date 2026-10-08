export const COLLABORATION_PROVENANCE = Object.freeze({
  // Behaviour evidence retired from the tree in N0-G5; the record pins each file in Git history.
  paperEvidence: Object.freeze({
    retired: "docs/provenance/RETIRED_PAPER_RECORDS.md",
    paths: Object.freeze([
      "docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-02.md",
      "docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-03.md",
      "docs/evidence/PAPER_LOCAL_RUNTIME_RECOVERY_2026-10-02.md",
    ]),
  }),
  doop: Object.freeze({
    repository: "kgoedecke/doop",
    revision: "d99c8b157d5afd4192b356f89a2b19adc28c75a5",
    license: "AGPL-3.0-only",
    posture: "reference-only",
    importedCode: false,
    studiedSurfaces: Object.freeze([
      "src/lib/ws.ts",
      "shared/types.ts",
      "shared/viewport.ts",
      "src/components/Cursors.tsx",
      "src/components/PeerAvatars.tsx",
      "src/components/ActivityPanel.tsx",
      "src/lib/store.ts",
      "server/access.ts",
      "server/actions.ts",
      "server/index.ts",
      "server/mcp.ts",
      "server/workspaces.ts",
      "tests/access.test.ts",
      "tests/workspaces.test.ts",
      "tests/commentReplies.test.ts",
      "tests/mcp-comments.test.ts",
      "tests/mcp-comments-write.test.ts",
    ]),
  }),
});
