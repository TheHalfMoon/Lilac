import test from "node:test";
import assert from "node:assert/strict";

import { classifyAddress } from "../packages/network-policy/src/index.ts";
import { createImpeccableCliRunner, scanBrowserUrl } from "../packages/design-assurance/src/index.mjs";
import { defaultImportPolicy, validateResolvedAddresses } from "../packages/import-stack/src/index.ts";
import { NETWORK_POLICY_SCHEMA_VERSION } from "../packages/network-policy/src/index.ts";

// Sandbox escapes found by the P06 gate-5 probe (#112): translated IPv6
// addresses, the browser-scan private-target guard, and CLI option injection.

const runner = () => {
  const calls = [];
  return { calls, async scanTarget(target, options) { calls.push({ target, options }); return { exitCode: 0, stderr: "", findings: [] }; } };
};
const publicLookup = async () => [{ address: "93.184.215.14", family: 4 }];

test("IPv4-translated addresses (::ffff:0:0:0/96) are never public", () => {
  for (const address of ["::ffff:0:7f00:1", "::ffff:0:a00:1", "::ffff:0:a9fe:a9fe", "::ffff:0:808:808", "::ffff:0:c0a8:101"]) {
    assert.equal(classifyAddress(address), "forbidden", address);
  }
  assert.equal(classifyAddress("::ffff:0:0:1"), "unspecified");
  assert.equal(classifyAddress("::ffff:8.8.8.8"), "public", "ordinary IPv4-mapped public addresses are unchanged");
});

test("remote imports reject translated DNS answers", () => {
  const url = new URL("https://example.com/page");
  const remote = defaultImportPolicy("remote");
  const networkPolicy = {
    schemaVersion: NETWORK_POLICY_SCHEMA_VERSION, mode: "allowlist",
    grants: [{ id: "grant-example", capability: "import.fetch", scheme: "https", host: "example.com", port: null, allowPrivateNetwork: false, purpose: "P06 G5a test" }],
  };
  validateResolvedAddresses(url, ["93.184.216.34"], remote, networkPolicy);
  for (const address of ["::ffff:0:7f00:1", "::ffff:0:a00:1", "::ffff:0:a9fe:a9fe"]) {
    assert.throws(() => validateResolvedAddresses(url, [address], remote, networkPolicy), /forbidden address/u, address);
  }
});

test("browser scans refuse private targets in every spelling", async () => {
  const targets = [
    "http://localhost./", "http://foo.localhost./", "http://printer.local/", "http://metadata.google.internal/",
    "http://[::ffff:127.0.0.1]/", "http://[::127.0.0.1]/", "http://[fec0::1]/", "http://[64:ff9b::7f00:1]/",
    "http://[::ffff:0:7f00:1]/", "http://198.18.0.1/", "http://192.0.0.192/", "http://224.0.0.1/", "http://0.0.0.0/",
    "http://127.1/", "http://2130706433/", "http://0x7f.0.0.1/",
  ];
  for (const url of targets) {
    const fake = runner();
    await assert.rejects(scanBrowserUrl({ url, runner: fake, lookup: publicLookup }), /allowPrivateNetwork/u, url);
    assert.equal(fake.calls.length, 0, `${url} must not reach the runner`);
  }
});

test("browser scans refuse names that resolve privately or not at all", async () => {
  for (const answers of [[{ address: "127.0.0.1", family: 4 }], [{ address: "::1", family: 6 }], [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.5", family: 4 }], [{ address: "::ffff:0:a9fe:a9fe", family: 6 }], []]) {
    const fake = runner();
    await assert.rejects(scanBrowserUrl({ url: "http://127.0.0.1.nip.io/", runner: fake, lookup: async () => answers }), /non-public|allowPrivateNetwork/u, JSON.stringify(answers));
    assert.equal(fake.calls.length, 0);
  }
  const failing = runner();
  await assert.rejects(scanBrowserUrl({ url: "https://unresolvable.example/", runner: failing, lookup: async () => { throw new Error("ENOTFOUND"); } }), /could not be resolved/u);
  assert.equal(failing.calls.length, 0);
});

test("public targets scan, and allowPrivateNetwork still permits private ones without resolving", async () => {
  const fake = runner();
  await scanBrowserUrl({ url: "https://example.com/a", runner: fake, lookup: publicLookup });
  await scanBrowserUrl({ url: "http://[2606:4700::1111]/", runner: fake, lookup: async () => { throw new Error("literals are not resolved"); } });
  await scanBrowserUrl({ url: "http://localhost:3000/", runner: fake, allowPrivateNetwork: true, lookup: async () => { throw new Error("not called"); } });
  assert.deepEqual(fake.calls.map((call) => call.target), ["https://example.com/a", "http://[2606:4700::1111]/", "http://localhost:3000/"]);
});

test("a target that starts with a dash is refused before the CLI runs", async () => {
  // The pinned engine keeps parsing options after "--", so the real CLI is used here:
  // with the stand-in, a separator would look effective when it is not.
  const cli = createImpeccableCliRunner({ timeoutMs: 30_000 });
  for (const target of ["--help", "--json", "-x", "--scope=type"]) {
    await assert.rejects(cli.scanTarget(target), /must not start with '-'/u, target);
  }
  const echo = createImpeccableCliRunner({ cliPath: new URL("./support/argv-echo.mjs", import.meta.url).pathname, timeoutMs: 10_000 });
  const { findings } = await echo.scanTarget("/tmp/scan-target.html", { scopes: ["a"] });
  assert.equal(findings[0].argv.at(-1), "/tmp/scan-target.html", "ordinary targets are passed through unchanged");
});

test("only an explicit true opts in to private targets", async () => {
  for (const allowPrivateNetwork of ["false", "true", 1, {}, []]) {
    const fake = runner();
    await assert.rejects(scanBrowserUrl({ url: "http://127.0.0.1/", runner: fake, allowPrivateNetwork, lookup: publicLookup }), /allowPrivateNetwork/u, JSON.stringify(allowPrivateNetwork));
    assert.equal(fake.calls.length, 0);
  }
});
