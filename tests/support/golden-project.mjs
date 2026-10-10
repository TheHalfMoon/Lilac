// Deterministic writers for the golden fixtures of this release (project schema 3):
// - tests/fixtures/projects/v3-basic: `node tests/support/golden-project.mjs <empty dir>`;
// - tests/fixtures/projects/v3-segments, the same history with its journal in segments (#258):
//   `node tests/support/golden-project.mjs <empty dir> segments`.
// The compatibility suite checks that this release writes the same bytes.
// tests/fixtures/projects/v2-basic (schema 2) and v1-basic (schema 1, before the rename) are
// the same history written by earlier releases; they are frozen as the migration corpus and
// never regenerated.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createDocument } from "../../packages/document-model/src/index.mjs";
import { pathToFileURL } from "node:url";
import { PROJECT_FILES, createProject, openProject } from "../../packages/persistence/src/index.ts";

export const GOLDEN_AT = "2026-10-07T12:00:00.000Z";

const HISTORY = [
  { id: "tx-1", actor: "user-1", baseRevision: 0, intent: "rename", tool: null, timestamp: GOLDEN_AT, metadata: {}, operations: [{ type: "set-props", nodeId: "frame-1", set: { title: "Plans" } }] },
  { id: "tx-2", actor: "user-1", baseRevision: 1, operations: [{ type: "insert-node", node: { id: "text-2", type: "text", props: { text: "World" } }, parentId: "frame-1", index: 1 }] },
  { id: "tx-3", actor: "agent-1", baseRevision: 2, tool: "edit", operations: [{ type: "move-node", nodeId: "text-2", parentId: "frame-1", index: 0 }] },
  { id: "tx-4", actor: "user-1", baseRevision: 3, operations: [{ type: "set-props", nodeId: "text-1", set: { text: "Hi" }, unset: [] }, { type: "remove-node", nodeId: "text-2" }] },
  {
    id: "tx-5",
    actor: "importer-1",
    baseRevision: 4,
    intent: "import card",
    tool: "@ninerr/import-stack",
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
  },
];

function create(root, projectId) {
  createProject(root, {
    projectId,
    createdAt: GOLDEN_AT,
    document: createDocument({
      id: "doc-golden",
      nodes: [
        { id: "frame-1", type: "frame", children: ["text-1"], props: { title: "Pricing" } },
        { id: "text-1", type: "text", parentId: "frame-1", props: { text: "Hello" } },
      ],
    }),
  });
}

// The writer stops without a clean close, as after a crash, its lock gone as after an
// override: the snapshot stays at tx-2, so opening the fixture replays three entries of every
// kind. A clean close would checkpoint at the journal's end (#239).
const crash = (root) => rmSync(join(root, PROJECT_FILES.directory, PROJECT_FILES.lock));

/** v3-basic: one journal from the genesis, the snapshot at tx-2. */
export function writeGoldenProject(root) {
  create(root, "golden-v3");
  const store = openProject(root, { owner: "golden-writer", at: GOLDEN_AT });
  try {
    store.commit(HISTORY[0]);
    store.commit(HISTORY[1]);
    store.checkpoint();
    for (const transaction of HISTORY.slice(2)) store.commit(transaction);
  } finally {
    crash(root);
  }
}

/**
 * v3-segments: the same history, written so the journal is in segments. The first session
 * starts a new segment after each of tx-1 and tx-2 and closes; the second commits tx-3 to tx-5
 * and stops as after a crash. The journal then holds a segment after tx-2 whose archive is the
 * segment after tx-1, whose archive is the journal from the genesis.
 */
export function writeSegmentedGoldenProject(root) {
  create(root, "golden-v3-segments");
  const first = openProject(root, { owner: "golden-writer", at: GOLDEN_AT, rotateJournalAt: 1 });
  first.commit(HISTORY[0]);
  first.commit(HISTORY[1]);
  first.close();
  const second = openProject(root, { owner: "golden-writer", at: GOLDEN_AT });
  try {
    for (const transaction of HISTORY.slice(2)) second.commit(transaction);
  } finally {
    crash(root);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[3] === "segments") writeSegmentedGoldenProject(process.argv[2]);
  else writeGoldenProject(process.argv[2]);
}
