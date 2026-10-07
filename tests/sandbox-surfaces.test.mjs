import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GitWorktreeInspector } from "../packages/agent-supervisor/src/index.ts";
import { LocalCollaborationFileStore, LocalCollaborationServer } from "../packages/collaboration/src/index.ts";
import { DELIVERY_SCHEMA_VERSION, createEvidenceStore } from "../packages/delivery-governance/src/index.ts";
import {
  IMPORT_SCHEMA_VERSION,
  ImportSecurityError,
  defaultImportPolicy,
  disposeStaticMirror,
  mirrorStaticSite,
  proposalFromStaticMirror,
  readAuthorizedLocalSource,
  runLocalDocling,
  safeRemoveImportJobDirectory,
} from "../packages/import-stack/src/index.ts";
import { NETWORK_POLICY_SCHEMA_VERSION } from "../packages/network-policy/src/index.ts";

// P06 gate 5 (sandbox escape), grain c: surfaces outside persistence and network policy
// where untrusted content or a hostile local actor could run code, read outside a root,
// or redirect writes. Each test is an attack that worked before this grain.

const AT = "2026-10-07T09:00:00.000Z";
const HEAD = "9e25bd787b2e874120f6183beea1dfe07b1afba4";

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "lilac-sandbox-surfaces-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

const gitIn = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });

// A repository whose own config tries to run commands during `git status`.
async function hostileRepository(dir) {
  const repo = join(dir, "repo");
  const markers = join(dir, "markers");
  await mkdir(repo);
  await mkdir(markers);
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.name", "t");
  gitIn(repo, "config", "user.email", "t@example.invalid");
  // "a=b" defeats a `-c filter.a=b.clean=` override, which Git splits at the first "=".
  await writeFile(join(repo, ".gitattributes"), "a.txt filter=evil\nb.txt filter=a=b\n");
  await writeFile(join(repo, "a.txt"), "content\n");
  await writeFile(join(repo, "b.txt"), "content\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "init");
  gitIn(repo, "config", "core.fsmonitor", `touch ${join(markers, "fsmonitor")}; echo`);
  gitIn(repo, "config", "filter.evil.clean", `touch ${join(markers, "clean")}; cat`);
  gitIn(repo, "config", "filter.evil.process", `touch ${join(markers, "process")}`);
  gitIn(repo, "config", "filter.a=b.clean", `touch ${join(markers, "clean-equals")}; cat`);
  // A plain `git status` that refreshes the index runs post-index-change.
  const hooks = join(dir, "hooks");
  await mkdir(hooks);
  await writeFile(join(hooks, "post-index-change"), `#!/bin/sh\ntouch ${join(markers, "hook")}\n`);
  await chmod(join(hooks, "post-index-change"), 0o755);
  gitIn(repo, "config", "core.hooksPath", hooks);
  // A newer mtime with unchanged content forces status to re-hash, which runs clean filters.
  const later = new Date(Date.now() + 5_000);
  for (const name of ["a.txt", "b.txt"]) await utimes(join(repo, name), later, later);
  return { repo, markers };
}

test("worktree inspection runs no command the inspected repository configures", async () => {
  await withTemp(async (dir) => {
    const { repo, markers } = await hostileRepository(dir);
    const evidence = await new GitWorktreeInspector().inspect(repo);
    assert.deepEqual(readdirSync(markers), [], "no fsmonitor, filter or hook command ran");
    assert.equal(evidence.exists, true);
    assert.equal(evidence.isWorktreeRoot, true);
    assert.equal(evidence.branch, "main");
    assert.match(evidence.head, /^[0-9a-f]{40}$/u);
    assert.equal(evidence.dirty, false, "an unchanged file is clean without its filter");
    await writeFile(join(repo, "a.txt"), "changed\n");
    assert.equal((await new GitWorktreeInspector().inspect(repo)).dirty, true, "a real change is still seen");
    assert.deepEqual(readdirSync(markers), []);
  });
});

test("worktree inspection ignores Git environment overrides of the process", async () => {
  await withTemp(async (dir) => {
    const { repo } = await hostileRepository(dir);
    const other = join(dir, "other");
    await mkdir(other);
    gitIn(other, "init", "-q", "-b", "elsewhere");
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, ".git");
    try {
      const evidence = await new GitWorktreeInspector().inspect(repo);
      assert.equal(evidence.branch, "main", "GIT_DIR does not redirect the inspection");
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    }
  });
});

const importRequest = (overrides = {}) => ({
  schemaVersion: IMPORT_SCHEMA_VERSION, requestId: "import-1", actorId: "user-1", intent: "Sandbox surfaces", at: AT,
  ...overrides,
});

test("an in-root hard link to an outside file is not read as a local source", async () => {
  await withTemp(async (dir) => {
    const repoRoot = join(dir, "repo");
    await mkdir(join(repoRoot, "src"), { recursive: true });
    const secret = join(dir, "secret.html");
    await writeFile(secret, "<p>outside secret</p>");
    const linked = join(repoRoot, "src", "index.html");
    await link(secret, linked);
    const result = await readAuthorizedLocalSource(importRequest({
      source: { kind: "local-app", repositoryId: "repo-1", repositoryPath: "src/index.html" },
      policy: defaultImportPolicy("local-app"),
      networkPolicy: { schemaVersion: NETWORK_POLICY_SCHEMA_VERSION, mode: "local-only", grants: [] },
    }), { repositoryId: "repo-1", repositoryRoot: repoRoot, path: linked });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /hard-linked/u);
  });
});

const doclingOutput = JSON.stringify({ schema_name: "DoclingDocument", texts: [] });

async function doclingWith(dir, input, act) {
  return runLocalDocling(defaultImportPolicy("offline"), { path: input, format: "pdf" }, {
    jobId: "docling-job", workRoot: join(dir, "work"), authorizedRoots: [join(dir, "in")],
  }, {
    execute: async (_command, args) => {
      await act(args[args.indexOf("--output-file") + 1]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
}

test("Docling refuses hard-linked input and output that is not its own regular file", async () => {
  await withTemp(async (dir) => {
    await mkdir(join(dir, "in"));
    const input = join(dir, "in", "doc.pdf");
    await writeFile(input, "%PDF-1.4 bounded");
    const secret = join(dir, "secret.pdf");
    await writeFile(secret, "%PDF-1.4 outside");
    const linkedInput = join(dir, "in", "linked.pdf");
    await link(secret, linkedInput);
    const linked = await doclingWith(dir, linkedInput, async (output) => writeFile(output, doclingOutput));
    assert.equal(linked.status, "failed");
    assert.match(linked.reason, /hard-linked/u);

    const outsideJson = join(dir, "outside.json");
    await writeFile(outsideJson, doclingOutput);
    const viaSymlink = await doclingWith(dir, input, async (output) => symlink(outsideJson, output));
    assert.equal(viaSymlink.status, "failed");
    assert.match(viaSymlink.reason, /regular non-symlink file/u);

    const viaFifo = await doclingWith(dir, input, async (output) => { execFileSync("mkfifo", [output]); });
    assert.equal(viaFifo.status, "failed", "a FIFO output fails without blocking");
    assert.match(viaFifo.reason, /regular non-symlink file/u);
    assert.equal(existsSync(join(dir, "work")) ? readdirSync(join(dir, "work")).length : 0, 0, "job directories are cleaned");
  });
});

const NET_REMOTE = {
  schemaVersion: NETWORK_POLICY_SCHEMA_VERSION, mode: "allowlist",
  grants: [{ id: "grant-example", capability: "import.fetch", scheme: "https", host: "example.com", port: null, allowPrivateNetwork: false, purpose: "Sandbox surfaces test" }],
};
const mirrorRequest = () => importRequest({
  source: { kind: "remote-url", uri: "https://example.com/docs/page.html" },
  policy: defaultImportPolicy("remote"),
  networkPolicy: NET_REMOTE,
});

test("mirror disposal removes only job directories, and promotion requires a mirror job directory", async () => {
  await withTemp(async (dir) => {
    const workRoot = join(dir, "work");
    const precious = join(workRoot, "precious");
    await mkdir(join(precious, "nested"), { recursive: true });
    await assert.rejects(() => disposeStaticMirror(workRoot, { jobDirectory: precious, manifest: {} }), ImportSecurityError);
    await assert.rejects(() => safeRemoveImportJobDirectory(workRoot, join(precious, "nested")), ImportSecurityError);
    assert.equal((await stat(join(precious, "nested"))).isDirectory(), true, "a non-job directory survives");
    const doclingJob = join(workRoot, `docling-${"0".repeat(24)}`);
    await mkdir(doclingJob);
    await assert.rejects(() => disposeStaticMirror(workRoot, { jobDirectory: doclingJob, manifest: {} }), ImportSecurityError);
    assert.equal(existsSync(doclingJob), true, "another adapter's job directory survives mirror disposal");

    const result = await mirrorStaticSite(mirrorRequest(), "https://example.com/docs/page.html", { jobId: "mirror-shape", workRoot }, {
      resolveHost: async () => ["93.184.216.34"],
      fetchResource: async () => ({ status: 200, headers: { "content-type": "text/html", "content-encoding": "identity" }, body: new TextEncoder().encode("<p>ok</p>") }),
    });
    assert.equal(result.status, "ok");
    const renamed = join(workRoot, "renamed");
    await rename(result.value.jobDirectory, renamed);
    await assert.rejects(() => proposalFromStaticMirror(mirrorRequest(), { ...result.value, jobDirectory: renamed }), /not a mirror job directory/u);
    await rename(renamed, result.value.jobDirectory);
    await proposalFromStaticMirror(mirrorRequest(), result.value);
    await disposeStaticMirror(workRoot, result.value);
    assert.equal(existsSync(result.value.jobDirectory), false);
  });
});

const bundle = () => ({
  qualificationId: "delivery-qualification:test01", candidateHead: HEAD, createdAt: AT, askUserRequests: [],
  records: [{
    schemaVersion: DELIVERY_SCHEMA_VERSION, qualificationId: "delivery-qualification:test01", candidateHead: HEAD,
    base: "a54517413267e3f1cf190128c24334e337403a18", parentQualificationId: null, actorId: "agent-1", intent: "Qualify bounded change",
    createdAt: AT, gates: [{ name: "tests", verdict: "pass", findings: [] }], ciChecks: [{ name: "Foundation checks", conclusion: "success", headSha: HEAD }],
    worktrees: [], mergeStrategy: "merge", mutatedAfterQualification: false,
  }],
});

test("an evidence root swapped after store creation receives no bundle", async () => {
  await withTemp(async (dir) => {
    const root = join(dir, "evidence");
    const outside = join(dir, "outside");
    await mkdir(outside);
    const store = await createEvidenceStore({ evidenceRoot: root, disposableRoots: [] });
    await rename(root, join(dir, "moved"));
    await symlink(outside, root);
    await assert.rejects(() => store.writeBundle(bundle()), /evidence root changed/u);
    assert.deepEqual(readdirSync(outside), [], "nothing was written through the link");

    await rm(root);
    await mkdir(root);
    await assert.rejects(() => store.writeBundle(bundle()), /evidence root changed/u, "a replacement directory is not the pinned root");
    assert.deepEqual(readdirSync(root), []);

    const fresh = await createEvidenceStore({ evidenceRoot: root, disposableRoots: [] });
    await fresh.writeBundle(bundle());
    assert.equal(readdirSync(root).length, 1);
  });
});

const ownerGrant = { principalKind: "actor", principalId: "user-owner", capabilities: ["read", "presence", "document-write", "comments", "admin", "durable-secret"] };

async function savedState(dir) {
  const store = new LocalCollaborationFileStore(dir);
  const server = new LocalCollaborationServer(store);
  await server.create("doc-1", [ownerGrant]);
  await server.save("doc-1");
  return store;
}

test("collaboration state loads only from its own single-link regular file", async () => {
  await withTemp(async (dir) => {
    const store = await savedState(join(dir, "store"));
    const path = store.filePath("doc-1");
    assert.equal((await store.load("doc-1")).documentId, "doc-1");
    const outside = join(dir, "outside.json");
    await writeFile(outside, await readFile(path, "utf8"));

    await rm(path);
    await link(outside, path);
    await assert.rejects(() => store.load("doc-1"), /hard-linked/u);

    await rm(path);
    await symlink(outside, path);
    await assert.rejects(() => store.load("doc-1"), /symbolic link/u);
  });
});

// In a child process so that a regression blocks a killable process, not the test runner.
test("a FIFO in place of collaboration state fails closed without blocking", async () => {
  await withTemp(async (dir) => {
    const store = await savedState(join(dir, "store"));
    const path = store.filePath("doc-1");
    await rm(path);
    execFileSync("mkfifo", [path]);
    const module = fileURLToPath(new URL("../packages/collaboration/src/index.ts", import.meta.url));
    const script = `import(${JSON.stringify(module)}).then(async ({ LocalCollaborationFileStore }) => {
      try { await new LocalCollaborationFileStore(${JSON.stringify(join(dir, "store"))}).load("doc-1"); console.log("loaded"); }
      catch (error) { console.log("refused: " + error.message); }
    });`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.signal, null, "the load did not block");
    assert.match(child.stdout, /^refused: collaboration state path must be a regular file/u);
  });
});
