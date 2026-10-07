// Deterministic writer for the golden project-schema-1 fixture in
// tests/fixtures/projects/v1-basic. Run `node tests/support/golden-project.mjs <empty dir>`
// to regenerate it; the compatibility suite checks that this release writes the same bytes.
import { createDocument } from "../../packages/document-model/src/index.mjs";
import { createProject, openProject } from "../../packages/persistence/src/index.ts";

export const GOLDEN_AT = "2026-10-07T12:00:00.000Z";

export function writeGoldenProject(root) {
  createProject(root, {
    projectId: "golden-v1",
    createdAt: GOLDEN_AT,
    document: createDocument({
      id: "doc-golden",
      nodes: [
        { id: "frame-1", type: "frame", children: ["text-1"], props: { title: "Pricing" } },
        { id: "text-1", type: "text", parentId: "frame-1", props: { text: "Hello" } },
      ],
    }),
  });
  const store = openProject(root, { owner: "golden-writer", at: GOLDEN_AT });
  try {
    store.commit({ id: "tx-1", actor: "user-1", baseRevision: 0, intent: "rename", tool: null, timestamp: GOLDEN_AT, metadata: {}, operations: [{ type: "set-props", nodeId: "frame-1", set: { title: "Plans" } }] });
    store.commit({ id: "tx-2", actor: "user-1", baseRevision: 1, operations: [{ type: "insert-node", node: { id: "text-2", type: "text", props: { text: "World" } }, parentId: "frame-1", index: 1 }] });
    store.checkpoint();
    store.commit({ id: "tx-3", actor: "agent-1", baseRevision: 2, tool: "edit", operations: [{ type: "move-node", nodeId: "text-2", parentId: "frame-1", index: 0 }] });
    store.commit({ id: "tx-4", actor: "user-1", baseRevision: 3, operations: [{ type: "set-props", nodeId: "text-1", set: { text: "Hi" }, unset: [] }, { type: "remove-node", nodeId: "text-2" }] });
    store.commit({
      id: "tx-5",
      actor: "importer-1",
      baseRevision: 4,
      intent: "import card",
      tool: "@lilac/import-stack",
      timestamp: GOLDEN_AT,
      metadata: { import: { requestId: "req-1" } },
      operations: [{
        type: "restore-subtree",
        rootId: "card",
        parentId: "frame-1",
        index: 1,
        nodes: [
          { id: "card", type: "element", parentId: "frame-1", children: ["card-title"], props: { tag: "section" }, metadata: { sourceBinding: { file: "card.html" } } },
          { id: "card-title", type: "text", parentId: "card", children: [], props: { text: "Card" }, metadata: {} },
        ],
      }],
    });
  } finally {
    store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) writeGoldenProject(process.argv[2]);
