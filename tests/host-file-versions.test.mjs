import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry, CodebaseLinks } from "../packages/studio-host/src/index.ts";

// N0 exit criterion (#190): a host file from a future version is refused, and left exactly as
// it was, so the newer version still finds it. A refused file is never set aside or rewritten.

const AT = "2026-10-09T12:00:00.000Z";
const owner = { actorId: "person-1", kind: "user", accessClass: "member", displayName: "Person" };
const writeOwnerOnly = (path, text) => writeFileSync(path, text, { mode: 0o600 });

function withRoot(callback) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-host-versions-")));
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("an agent registry from a newer Ninerr is refused, admits no agent, and is never changed", () => withRoot((root) => {
  const path = join(root, ".ninerr-agents.json");
  const newer = `${JSON.stringify({ version: 2, agents: [], future: { kept: true } }, null, 2)}\n`;
  writeOwnerOnly(path, newer);
  for (const launch of [1, 2]) {
    const registry = new AgentRegistry(root, owner);
    assert.match(registry.problem ?? "", /newer version of Ninerr \(registry version 2\)/u, `launch ${launch}`);
    assert.equal(registry.problemCode, "agents-newer");
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.authenticate(`ninerr_agent_${"A".repeat(43)}`), null);
    assert.throws(() => registry.create("Agent", AT), (error) => error.code === "agents-newer" && error.status === 409);
    assert.equal(readFileSync(path, "utf8"), newer, `launch ${launch}: the newer registry is unchanged`);
    assert.deepEqual(readdirSync(root), [".ninerr-agents.json"], `launch ${launch}: nothing is set aside or created`);
  }
}));

test("an agent registry without a version is malformed and set aside, like any damaged registry", () => withRoot((root) => {
  writeOwnerOnly(join(root, ".ninerr-agents.json"), `${JSON.stringify({ agents: [] })}\n`);
  const registry = new AgentRegistry(root, owner);
  assert.match(registry.problem ?? "", /malformed/u);
  assert.ok(readdirSync(root).some((name) => name.startsWith(".ninerr-agents.json.unreadable-")));
}));

test("codebase links from a newer Ninerr are refused, link nothing, and are never changed", () => withRoot((root) => {
  const path = join(root, ".ninerr-codebases.json");
  const newer = `${JSON.stringify({ version: 2, links: { site: "/home/someone/site" } }, null, 2)}\n`;
  writeOwnerOnly(path, newer);
  const links = new CodebaseLinks(root);
  assert.match(links.problem ?? "", /newer version of Ninerr \(links version 2\)/u);
  assert.equal(links.get("site"), null, "a newer file's links are not used");
  assert.throws(() => links.set("app", "/home/someone/app"), (error) => error.code === "codebases-newer" && error.status === 409);
  assert.throws(() => links.set("site", null), (error) => error.code === "codebases-newer");
  assert.equal(readFileSync(path, "utf8"), newer, "the newer links file is unchanged");
  assert.deepEqual(readdirSync(root), [".ninerr-codebases.json"]);
}));

test("current registry and links files still read and save", () => withRoot((root) => {
  const registry = new AgentRegistry(root, owner);
  assert.equal(registry.problem, null);
  const { token } = registry.create("Agent", AT);
  assert.equal(JSON.parse(readFileSync(join(root, ".ninerr-agents.json"), "utf8")).version, 1);
  assert.notEqual(new AgentRegistry(root, owner).authenticate(token), null);
  const links = new CodebaseLinks(root);
  assert.equal(links.problem, null);
  links.set("site", "/home/someone/site");
  assert.equal(JSON.parse(readFileSync(join(root, ".ninerr-codebases.json"), "utf8")).version, 1);
  assert.equal(new CodebaseLinks(root).get("site"), "/home/someone/site");
}));
