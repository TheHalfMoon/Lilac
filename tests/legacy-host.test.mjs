import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRegistry, CodebaseLinks, resolveProjectsFolder, startStudioHost } from "../packages/studio-host/src/index.ts";

// N0-G2 (#190): the host files from before the rename keep working. Registries are read
// when no Ninerr file exists, saved under the Ninerr name, and never changed; a legacy
// project opens by being migrated; the projects folder honours legacy settings without
// moving anything.

const LEGACY_PROJECT = fileURLToPath(new URL("./fixtures/projects/v1-basic/", import.meta.url));
const AT = "2026-10-08T12:00:00.000Z";
const owner = { actorId: "person-1", kind: "user", accessClass: "member", displayName: "Person" };
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "ninerr-legacy-host-")));
const LEGACY_TOKEN = `lilac_agent_${"A".repeat(43)}`;
const LEGACY_AGENT = { agentId: "agent-00000000-0000-4000-8000-000000000001", displayName: "Old agent", tokenSha256: createHash("sha256").update(LEGACY_TOKEN, "utf8").digest("hex"), createdAt: AT };
const writeOwnerOnly = (path, text) => writeFileSync(path, text, { mode: 0o600 });

function withRoot(callback) {
  const root = scratch();
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a legacy agent registry is carried over: its agents and credentials keep working, and it is left as it was", () => withRoot((root) => {
  const legacyText = `${JSON.stringify({ version: 1, agents: [LEGACY_AGENT] }, null, 2)}\n`;
  writeOwnerOnly(join(root, ".lilac-agents.json"), legacyText);
  const registry = new AgentRegistry(root, owner);
  assert.equal(registry.problem, null);
  assert.deepEqual(registry.list(), [{ agentId: LEGACY_AGENT.agentId, displayName: "Old agent", createdAt: AT }]);
  assert.equal(registry.authenticate(LEGACY_TOKEN)?.actorId, LEGACY_AGENT.agentId, "a credential issued before the rename still authenticates");
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".ninerr-agents.json"), "utf8")).agents, [LEGACY_AGENT], "saved under the Ninerr name");
  assert.equal(readFileSync(join(root, ".lilac-agents.json"), "utf8"), legacyText, "the legacy registry is unchanged");

  const { token } = registry.create("New agent", AT);
  assert.match(token, /^ninerr_agent_/u);
  assert.equal(registry.authenticate(token)?.kind, "agent");
  registry.revoke(LEGACY_AGENT.agentId);
  assert.equal(registry.authenticate(LEGACY_TOKEN), null, "revoking applies to the Ninerr registry");
  assert.equal(new AgentRegistry(root, owner).authenticate(LEGACY_TOKEN), null, "once a Ninerr registry exists the legacy one is not read again");
  assert.equal(readFileSync(join(root, ".lilac-agents.json"), "utf8"), legacyText);
  assert.equal(registry.authenticate(`other_${LEGACY_TOKEN}`), null);
}));

test("a damaged legacy agent registry fails closed and is not moved", () => withRoot((root) => {
  writeOwnerOnly(join(root, ".lilac-agents.json"), "{ not json");
  const registry = new AgentRegistry(root, owner);
  assert.match(registry.problem ?? "", /not valid JSON/u);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(readdirSync(root).sort(), [".lilac-agents.json"], "nothing is set aside or created");
}));

test("legacy codebase links are read until the first change, which saves the Ninerr file", () => withRoot((root) => {
  const legacyText = `${JSON.stringify({ version: 1, links: { site: "/home/someone/site" } }, null, 2)}\n`;
  writeOwnerOnly(join(root, ".lilac-codebases.json"), legacyText);
  const links = new CodebaseLinks(root);
  assert.equal(links.get("site"), "/home/someone/site");
  links.set("app", "/home/someone/app");
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".ninerr-codebases.json"), "utf8")).links, { site: "/home/someone/site", app: "/home/someone/app" });
  assert.equal(readFileSync(join(root, ".lilac-codebases.json"), "utf8"), legacyText);
  assert.equal(new CodebaseLinks(root).get("app"), "/home/someone/app");
}));

test("the projects folder: explicit, then NINERR_PROJECTS, then LILAC_PROJECTS, then the defaults", () => withRoot((home) => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, NINERR_PROJECTS: process.env.NINERR_PROJECTS, LILAC_PROJECTS: process.env.LILAC_PROJECTS };
  const set = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    set({ HOME: home, USERPROFILE: home, NINERR_PROJECTS: undefined, LILAC_PROJECTS: undefined });
    assert.deepEqual(resolveProjectsFolder(), { path: join(home, "Ninerr Projects"), note: null });
    mkdirSync(join(home, "Lilac Projects"));
    const legacy = resolveProjectsFolder();
    assert.equal(legacy.path, join(home, "Lilac Projects"), "an existing legacy folder keeps being used");
    assert.match(legacy.note ?? "", /from before the rename/u);
    mkdirSync(join(home, "Ninerr Projects"));
    assert.deepEqual(resolveProjectsFolder(), { path: join(home, "Ninerr Projects"), note: null }, "a Ninerr folder wins once it exists");
    set({ LILAC_PROJECTS: join(home, "old") });
    const fromLegacyEnv = resolveProjectsFolder();
    assert.equal(fromLegacyEnv.path, join(home, "old"));
    assert.match(fromLegacyEnv.note ?? "", /LILAC_PROJECTS is read because NINERR_PROJECTS is not set/u);
    set({ NINERR_PROJECTS: join(home, "new") });
    assert.deepEqual(resolveProjectsFolder(), { path: join(home, "new"), note: null });
    assert.deepEqual(resolveProjectsFolder(join(home, "chosen")), { path: join(home, "chosen"), note: null });
  } finally {
    set(saved);
  }
}));

test("the studio host lists a legacy project and opens it by migrating it, leaving the original unchanged", async () => {
  const root = scratch();
  cpSync(LEGACY_PROJECT, join(root, "old"), { recursive: true });
  const legacyFiles = () => Object.fromEntries(readdirSync(join(root, "old", ".lilac"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((path) => [path, readFileSync(path).toString("base64")]));
  const before = legacyFiles();
  const host = await startStudioHost({ projectsRoot: root, now: () => AT });
  try {
    const call = (method, path, body) => fetch(`${host.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${host.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => ({ status: response.status, json: await response.json() }));
    assert.deepEqual((await call("GET", "/api/projects")).json.projects, ["old"]);
    const opened = await call("POST", "/api/projects/open", { name: "old" });
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    assert.equal(opened.json.revision, 5);
    assert.equal(opened.json.recovery.legacyProject, true);
    assert.equal(opened.json.recovery.migratedFrom, 1);
    assert.ok(existsSync(join(root, "old", ".ninerr", "project.json")));
  } finally {
    await host.close();
  }
  try {
    assert.deepEqual(legacyFiles(), before, "the legacy directory is byte-identical");
    assert.equal(readFileSync(join(root, "old", ".lilac", "project.json"), "utf8"), readFileSync(join(LEGACY_PROJECT, ".lilac", "project.json"), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
