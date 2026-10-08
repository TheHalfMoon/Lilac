import test from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_FILES } from "../packages/persistence/src/index.ts";
import { startStudioHost, writeBack } from "../packages/studio-host/src/index.ts";

// #185: a write-back changes a source file and the project's record of it. Whichever step
// fails (recording it, renaming the file, confirming it), and whatever happens next (reopen,
// more edits, an external edit), the project and the file must never disagree silently: no
// write-back may overwrite a change it did not plan, and a preview describes the file as it is.
//
// A store failure is injected for real: a second hard link to the journal makes the store
// refuse its next append (deterministic, no timing), and is removed straight after.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + clock++ * 1000).toISOString();
const CARD = `export function PriceCard() {
  return (
    <section className="card">
      <h2>Pro</h2>
      <p title="Plan">Everything in Free, and more.</p>
    </section>
  );
}
`;
const WRITTEN = CARD.replace("<h2>Pro</h2>", "<h2>Team</h2>");

async function withEditedCard(callback) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-185-")));
  const projects = join(root, "projects");
  const code = join(root, "code");
  mkdirSync(projects);
  mkdirSync(code);
  const cardPath = join(code, "Card.jsx");
  writeFileSync(cardPath, CARD);
  const host = await startStudioHost({ projectsRoot: projects, now });
  const call = async (method, path, body) => {
    const response = await fetch(`${host.url}${path}`, { method, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() };
  };
  const journal = join(projects, "site", PROJECT_FILES.directory, PROJECT_FILES.journal);
  // Awaits the action, so the link is still there while an HTTP request is served.
  const failingStore = async (action) => {
    const extra = join(root, "journal-link");
    linkSync(journal, extra);
    try {
      return await action();
    } finally {
      unlinkSync(extra);
    }
  };
  // The same, for a synchronous step inside writeBack.
  const failingStoreSync = (action) => {
    const extra = join(root, "journal-link");
    linkSync(journal, extra);
    try {
      return action();
    } finally {
      unlinkSync(extra);
    }
  };
  try {
    await call("POST", "/api/projects/create", { name: "site" });
    await call("POST", "/api/codebase/connect", { folder: code });
    assert.equal((await call("POST", "/api/codebase/import", { file: "Card.jsx", component: "PriceCard" })).status, 200);
    const nodes = Object.values(host.session.document.nodes);
    const section = nodes.find((node) => node.props.tag === "section");
    const h2 = nodes.find((node) => node.props.tag === "h2");
    const p = nodes.find((node) => node.props.tag === "p");
    await call("POST", "/api/edit", { baseRevision: host.session.revision, intent: "Edit", operations: [{ type: "set-props", nodeId: h2.id, set: { text: "Team" } }] });
    const preview = (await call("POST", "/api/codebase/preview", { nodeId: section.id })).json;
    assert.deepEqual(preview.changes.map((change) => change.field), ["text"]);
    // The route's own commit, made through the session as the route makes it.
    const sessionCommit = (operations, step) => host.session.edit(host.session.owner, { baseRevision: host.session.revision, operations, intent: step, tool: "test" });
    const reopen = async () => assert.equal((await call("POST", "/api/projects/open", { name: "site" })).status, 200);
    const previewNow = async () => (await call("POST", "/api/codebase/preview", { nodeId: section.id })).json;
    await callback({ call, host, code, cardPath, section, h2, p, preview, failingStore, failingStoreSync, sessionCommit, reopen, previewNow });
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("#185: when recording the write fails, nothing is written and the change is still offered after a reopen", async () => {
  await withEditedCard(async ({ call, cardPath, section, preview, failingStore, reopen, previewNow }) => {
    const written = await failingStore(() => call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token }));
    assert.equal(written.status, 409);
    assert.equal(written.json.error.code, "project-needs-reopen", "a failed journal write is never reported as the client's invalid edit");
    assert.equal(readFileSync(cardPath, "utf8"), CARD, "the file is untouched");
    assert.equal((await call("POST", "/api/edit", { baseRevision: 0, operations: [] })).json.error?.code, "project-needs-reopen");
    await reopen();
    const again = await previewNow();
    assert.deepEqual(again.changes.map((change) => change.field), ["text"]);
    assert.deepEqual(again.conflicts, []);
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: again.token })).status, 200);
    assert.equal(readFileSync(cardPath, "utf8"), WRITTEN);
    assert.deepEqual((await previewNow()).changes, []);
  });
});

/** Write back through the route's function, with the store failing exactly at `confirm`. */
function writeFailingConfirm({ host, code, section, preview, failingStoreSync, sessionCommit }) {
  assert.throws(() => writeBack(host.session.document, section.id, code, preview.token, (operations, step) => {
    if (step === "confirm") failingStoreSync(() => sessionCommit(operations, step));
    else sessionCommit(operations, step);
  }), (error) => error.code === "project-needs-reopen");
}

test("#185: when confirming fails after the rename, the durable record keeps the preview exact", async () => {
  await withEditedCard(async (context) => {
    const { call, cardPath, section, h2, previewNow, reopen, host } = context;
    writeFailingConfirm(context);
    assert.equal(readFileSync(cardPath, "utf8"), WRITTEN, "the file was renamed into place");
    await reopen();
    assert.equal(host.session.document.nodes[h2.id].props.text, "Team");
    assert.equal(host.session.document.nodes[h2.id].props.codeSource.pending.base.text, "Team", "the pending record survived the reopen");
    const preview = await previewNow();
    assert.deepEqual(preview.changes, []);
    assert.deepEqual(preview.conflicts, []);
    assert.equal(preview.diff, "");
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token })).status, 409, "nothing to write");
    assert.equal(readFileSync(cardPath, "utf8"), WRITTEN);
  });
});

test("#185: an external edit after an unconfirmed write is a conflict, never overwritten", async () => {
  await withEditedCard(async (context) => {
    const { call, cardPath, section, h2, previewNow, reopen, host } = context;
    writeFailingConfirm(context);
    await reopen();
    // Someone puts the old heading back. Content alone cannot tell this from "the write
    // never happened", so the layer must not be written.
    writeFileSync(cardPath, CARD);
    const preview = await previewNow();
    assert.deepEqual(preview.changes, [], "nothing is planned over the external edit");
    assert.deepEqual(preview.conflicts.map((conflict) => [conflict.nodeId, conflict.field]), [[h2.id, "write-back"]]);
    assert.match(preview.conflicts[0].reason, /not confirmed/u);
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token })).status, 409);
    assert.equal(readFileSync(cardPath, "utf8"), CARD, "the external edit stands");
    assert.equal(host.session.document.nodes[h2.id].props.text, "Team");
  });
});

test("#185: after an unconfirmed write lands, a later edit writes back only itself and settles the record", async () => {
  await withEditedCard(async (context) => {
    const { call, cardPath, section, h2, p, previewNow, reopen, host } = context;
    writeFailingConfirm(context);
    await reopen();
    await call("POST", "/api/edit", { baseRevision: host.session.revision, intent: "Edit", operations: [{ type: "set-props", nodeId: p.id, set: { attributes: { title: "Plan B" } } }] });
    const preview = await previewNow();
    assert.deepEqual(preview.changes.map((change) => change.field), ["title"]);
    assert.deepEqual(preview.conflicts, []);
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token })).status, 200);
    assert.equal(readFileSync(cardPath, "utf8"), WRITTEN.replace('title="Plan"', 'title="Plan B"'));
    assert.deepEqual((await previewNow()).changes, []);
    assert.equal(host.session.document.nodes[h2.id].props.codeSource.pending, undefined, "the record is settled");
    assert.equal(host.session.document.nodes[h2.id].props.codeSource.base.text, "Team");
  });
});

test("#185: a file changed before the rename withdraws the record; if the withdrawal fails too, the layer is a conflict", async () => {
  await withEditedCard(async (context) => {
    const { host, code, cardPath, section, h2, preview, sessionCommit, previewNow } = context;
    const external = CARD.replace("Everything in Free, and more.", "All of Free.");
    assert.throws(() => writeBack(host.session.document, section.id, code, preview.token, (operations, step) => {
      sessionCommit(operations, step);
      if (step === "record") writeFileSync(cardPath, external);
    }), (error) => error.code === "plan-changed");
    assert.equal(readFileSync(cardPath, "utf8"), external, "the external edit stands");
    assert.equal(host.session.document.nodes[h2.id].props.codeSource.pending, undefined, "the record was withdrawn");
    const again = await previewNow();
    assert.deepEqual(again.changes.map((change) => change.field), ["text"], "the change is offered again, on the new file");
    assert.deepEqual(again.conflicts, []);
  });
  await withEditedCard(async (context) => {
    const { host, code, cardPath, section, h2, preview, sessionCommit, previewNow } = context;
    const external = CARD.replace("Everything in Free, and more.", "All of Free.");
    assert.throws(() => writeBack(host.session.document, section.id, code, preview.token, (operations, step) => {
      if (step === "withdraw") throw new Error("withdrawal failed");
      sessionCommit(operations, step);
      if (step === "record") writeFileSync(cardPath, external);
    }), (error) => error.code === "plan-changed");
    assert.equal(host.session.document.nodes[h2.id].props.codeSource.pending.base.text, "Team", "the record stays");
    const again = await previewNow();
    assert.deepEqual(again.changes, [], "nothing is written while it is unknown whether the record landed");
    assert.deepEqual(again.conflicts.map((conflict) => [conflict.nodeId, conflict.field]), [[h2.id, "write-back"]]);
    assert.equal(readFileSync(cardPath, "utf8"), external);
  });
});
