import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_FILES } from "../packages/persistence/src/index.ts";
import { settleWriteBacks, startStudioHost, writeBack } from "../packages/studio-host/src/index.ts";

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
  // The store refuses its next append while `action` runs: until it returns, or, when it
  // returns a promise (an HTTP request), until that settles.
  const failingStore = (action) => {
    const extra = join(root, "journal-link");
    linkSync(journal, extra);
    let result;
    try {
      result = action();
    } catch (error) {
      unlinkSync(extra);
      throw error;
    }
    if (typeof result?.then !== "function") {
      unlinkSync(extra);
      return result;
    }
    return result.finally(() => unlinkSync(extra));
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
    await callback({ call, host, code, cardPath, section, h2, p, preview, failingStore, sessionCommit, reopen, previewNow });
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
function writeFailingConfirm({ host, code, section, preview, failingStore, sessionCommit }) {
  assert.throws(() => writeBack(host.session.document, section.id, code, preview.token, (operations, step) => {
    if (step === "confirm") failingStore(() => sessionCommit(operations, step));
    else sessionCommit(operations, step);
  }), (error) => error.code === "project-needs-reopen");
}

test("#185: when confirming fails after the rename, reopening settles the record from the file", async () => {
  await withEditedCard(async (context) => {
    const { call, cardPath, section, h2, previewNow, reopen, host } = context;
    writeFailingConfirm(context);
    assert.equal(readFileSync(cardPath, "utf8"), WRITTEN, "the file was renamed into place");
    await reopen();
    const source = host.session.document.nodes[h2.id].props.codeSource;
    assert.equal(host.session.document.nodes[h2.id].props.text, "Team");
    assert.equal(source.pending, undefined, "the file matches the record, so opening settled it");
    assert.equal(source.base.text, "Team");
    const preview = await previewNow();
    assert.deepEqual(preview.changes, []);
    assert.deepEqual(preview.conflicts, []);
    assert.equal(preview.diff, "");
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token })).status, 409, "nothing to write");
    // Settled, an external edit afterwards is an ordinary file change: kept, nothing to write.
    writeFileSync(cardPath, CARD);
    const after = await previewNow();
    assert.deepEqual([after.changes, after.conflicts], [[], []]);
    assert.equal(readFileSync(cardPath, "utf8"), CARD);
  });
});

test("#185: an external edit before the record is settled is a conflict, never overwritten", async () => {
  await withEditedCard(async (context) => {
    const { call, cardPath, section, h2, previewNow, reopen, host } = context;
    writeFailingConfirm(context);
    // Someone puts the old heading back before Ninerr sees the file again. Content alone
    // cannot tell this from "the write never happened", so the layer must not be written.
    writeFileSync(cardPath, CARD);
    await reopen();
    assert.equal(host.session.document.nodes[h2.id].props.codeSource.pending.base.text, "Team", "an unknown outcome is not settled");
    const preview = await previewNow();
    assert.deepEqual(preview.changes, [], "nothing is planned over the external edit");
    assert.deepEqual(preview.conflicts.map((conflict) => [conflict.nodeId, conflict.field]), [[h2.id, "write-back"]]);
    assert.match(preview.conflicts[0].reason, /not confirmed/u);
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token })).status, 409);
    assert.equal(readFileSync(cardPath, "utf8"), CARD, "the external edit stands");
    assert.equal(host.session.document.nodes[h2.id].props.text, "Team");
  });
});

test("#185: marking a field as matching leaves another layer's unconfirmed record in place", async () => {
  await withEditedCard(async (context) => {
    const { call, cardPath, section, h2, p, previewNow, reopen, host } = context;
    writeFailingConfirm(context);
    // The heading's write has an unknown outcome (the file was changed back); the paragraph's
    // title is then changed to the same value here and in the file.
    writeFileSync(cardPath, CARD.replace('title="Plan"', 'title="Plan B"'));
    await reopen();
    await call("POST", "/api/edit", { baseRevision: host.session.revision, intent: "Retitle", operations: [{ type: "set-props", nodeId: p.id, set: { attributes: { title: "Plan B" } } }] });
    // The heading is also given the file's text: it agrees with the file too, but its earlier
    // write is unconfirmed, so it is never marked as matching.
    await call("POST", "/api/edit", { baseRevision: host.session.revision, intent: "Heading", operations: [{ type: "set-props", nodeId: h2.id, set: { text: "Pro" } }] });
    const preview = await previewNow();
    assert.deepEqual(preview.matched.map((entry) => [entry.nodeId, entry.field]), [[p.id, "title"]], "only the paragraph's title, not the unconfirmed heading");
    assert.deepEqual(preview.conflicts.map((conflict) => [conflict.nodeId, conflict.field]), [[h2.id, "write-back"]]);
    const marked = await call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token });
    assert.equal(marked.status, 200, JSON.stringify(marked.json));
    assert.equal(marked.json.matched, 1);
    assert.equal(host.session.document.nodes[p.id].props.codeSource.base.props.title, "Plan B", "the matched field's base moved");
    assert.equal(host.session.document.nodes[h2.id].props.codeSource.pending.base.text, "Team", "the unconfirmed record stays");
    assert.deepEqual((await previewNow()).conflicts.map((conflict) => conflict.field), ["write-back"], "and is still reported");
  });
});

test("#185: a crash between recording and renaming is withdrawn from the leftover temporary", async () => {
  await withEditedCard(async ({ call, host, code, cardPath, section, h2, preview, sessionCommit, previewNow, reopen }) => {
    // The process stops right after the record is committed: the record is durable, the
    // temporary is on disk, and the file is unchanged. (writeBack removes its temporary when
    // a step fails, so the stop is reproduced by putting it back as it was.)
    let temporary = null;
    assert.throws(() => writeBack(host.session.document, section.id, code, preview.token, (operations, step) => {
      sessionCommit(operations, step);
      if (step === "record") {
        temporary = join(code, host.session.document.nodes[h2.id].props.codeSource.pending.temp);
        throw new Error("the process stops");
      }
    }), /the process stops/u);
    writeFileSync(temporary, WRITTEN);
    assert.equal(readFileSync(cardPath, "utf8"), CARD);
    await reopen();
    const source = host.session.document.nodes[h2.id].props.codeSource;
    assert.equal(source.pending, undefined, "the temporary proves the rename never happened, so the record is withdrawn");
    assert.equal(source.base.text, "Pro");
    assert.equal(existsSync(temporary), false, "the leftover temporary is removed");
    const again = await previewNow();
    assert.deepEqual(again.changes.map((change) => change.field), ["text"], "the change is offered again");
    assert.deepEqual(again.conflicts, []);
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: again.token })).status, 200);
    assert.equal(readFileSync(cardPath, "utf8"), WRITTEN);
  });
});

test("#185: undo never takes back a write-back's bookkeeping", async () => {
  await withEditedCard(async ({ call, host, cardPath, section, h2, preview, previewNow }) => {
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token })).status, 200);
    assert.equal(readFileSync(cardPath, "utf8"), WRITTEN);
    // The latest undoable change is the person's text edit, not the write-back's steps.
    const undone = await call("POST", "/api/undo", {});
    assert.equal(undone.status, 200);
    assert.equal(undone.json.intent, "Undo: Edit");
    assert.equal(host.session.document.nodes[h2.id].props.text, "Pro");
    assert.equal(host.session.document.nodes[h2.id].props.codeSource.base.text, "Team", "the base still describes the file");
    // An external edit that puts "Pro" back agrees with the layer: nothing to write.
    writeFileSync(cardPath, CARD);
    const after = await previewNow();
    assert.deepEqual([after.changes, after.conflicts], [[], []]);
    // Without it, the undone edit is offered as a change to write, never silently.
    writeFileSync(cardPath, WRITTEN);
    assert.deepEqual((await previewNow()).changes.map((change) => [change.field, change.to]), [["text", "Pro"]]);
  });
});

test("a source file that is not valid UTF-8 is refused, never rewritten", async () => {
  await withEditedCard(async ({ call, cardPath, section, preview }) => {
    const bytes = Buffer.concat([Buffer.from(CARD.replace("<h2>Pro</h2>", "<h2>Team</h2>"), "utf8"), Buffer.from([0x2f, 0x2f, 0x20, 0xff, 0x0a])]);
    writeFileSync(cardPath, bytes);
    const response = await call("POST", "/api/codebase/preview", { nodeId: section.id });
    assert.equal(response.json.error?.code, "source-not-utf8");
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token })).json.error?.code, "source-not-utf8");
    assert.deepEqual(readFileSync(cardPath), bytes);
    assert.deepEqual((await call("GET", "/api/codebase")).json.components, [], "nor is it offered to bring in");
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

test("#185: a file changed before the rename withdraws the record, and settles it later if the withdrawal fails too", async () => {
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
    const pending = host.session.document.nodes[h2.id].props.codeSource.pending;
    assert.equal(pending.base.text, "Team", "the record stays");
    assert.ok(existsSync(join(code, pending.temp)), "and so does its temporary, which proves the rename never happened");
    const again = await previewNow();
    assert.equal(host.session.document.nodes[h2.id].props.codeSource.pending, undefined, "settling withdrew it");
    assert.equal(existsSync(join(code, pending.temp)), false);
    assert.deepEqual(again.changes.map((change) => change.field), ["text"], "the change is offered again, on the new file");
    assert.deepEqual(again.conflicts, []);
    assert.equal(readFileSync(cardPath, "utf8"), external);
  });
});

test("#185: settling sees every layer bound to a file, across components, and leaves unknown outcomes alone", () => {
  const code = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-185-settle-")));
  try {
    writeFileSync(join(code, "Card.jsx"), WRITTEN);
    const temp = ".00000000-0000-4000-8000-000000000000.ninerr-tmp";
    writeFileSync(join(code, temp), "never renamed");
    const sha = createHash("sha256").update(WRITTEN, "utf8").digest("hex");
    const source = (component, base, pending) => ({ file: "Card.jsx", component, path: "", tag: "section", base: { props: {}, text: base }, ...(pending ? { pending } : {}) });
    const document = { nodes: {
      landed: { id: "landed", props: { codeSource: source("PriceCard", "Pro", { base: { props: {}, text: "Team" }, sha256: sha }) } },
      notWritten: { id: "notWritten", props: { codeSource: source("PlanCard", "Free", { base: { props: {}, text: "Basic" }, sha256: "0".repeat(64), temp }) } },
      unknown: { id: "unknown", props: { codeSource: source("PlanCard", "Free", { base: { props: {}, text: "Basic" }, sha256: "0".repeat(64), temp: ".11111111-1111-4111-8111-111111111111.ninerr-tmp" }) } },
      plain: { id: "plain", props: { codeSource: source("PriceCard", "Pro") } },
    } };
    const { operations, temporaries } = settleWriteBacks(document, code);
    assert.deepEqual(operations, [
      { type: "set-props", nodeId: "landed", set: { codeSource: source("PriceCard", "Team") } },
      { type: "set-props", nodeId: "notWritten", set: { codeSource: source("PlanCard", "Free") } },
    ]);
    assert.deepEqual(temporaries, [join(code, temp)]);
  } finally {
    rmSync(code, { recursive: true, force: true });
  }
});
