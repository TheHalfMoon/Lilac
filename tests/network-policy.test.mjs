import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CORE_FEATURES,
  NETWORK_POLICY_PROVENANCE,
  NetworkPolicyValidationError,
  classifyAddress,
  defaultNetworkPolicy,
  evaluateOfflineReadiness,
  evaluateResolved,
  evaluateUrl,
  isForbiddenRemoteAddress,
  isLoopbackAddress,
  normalizeNetworkPolicy,
  normalizeProviderRegistry,
  resolveProvider,
} from "../packages/network-policy/src/index.ts";
import * as importStack from "../packages/import-stack/src/index.ts";

const allowlist = (grants) => ({ schemaVersion: 1, mode: "allowlist", grants });
const grant = (overrides = {}) => ({ id: "g1", capability: "provider.inference", scheme: "https", host: "api.example.com", port: null, allowPrivateNetwork: false, purpose: "hosted model", ...overrides });
const registry = (providers) => ({ schemaVersion: 1, providers });

test("provenance is decision-only and the package has no dependencies", () => {
  assert.match(NETWORK_POLICY_PROVENANCE.posture, /never opens connections/);
  const manifest = JSON.parse(readFileSync(new URL("../packages/network-policy/package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.dependencies, {});
});

test("address classification is owned here and re-exported unchanged by import-stack", () => {
  assert.equal(importStack.isForbiddenRemoteAddress, isForbiddenRemoteAddress);
  assert.equal(importStack.isLoopbackAddress, isLoopbackAddress);
  const cases = {
    "127.0.0.1": "loopback", "::1": "loopback", "::ffff:127.0.0.1": "loopback",
    "10.1.2.3": "forbidden", "192.168.0.1": "forbidden", "169.254.169.254": "forbidden", "100.64.0.1": "forbidden",
    "fc00::1": "forbidden", "fe80::1": "forbidden", "64:ff9b::a00:1": "forbidden", "2002::1": "forbidden", "::ffff:10.0.0.1": "forbidden",
    "93.184.216.34": "public", "2606:4700:4700::1111": "public",
    "example.com": "invalid", "": "invalid",
  };
  for (const [address, expected] of Object.entries(cases)) assert.equal(classifyAddress(address), expected, address);
});

test("the default policy is offline and denies every request", () => {
  assert.equal(defaultNetworkPolicy().mode, "offline");
  for (const url of ["https://example.com", "http://127.0.0.1:11434", "http://localhost"]) {
    const decision = evaluateUrl(defaultNetworkPolicy(), { capability: "provider.inference", url });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /offline/);
  }
});

test("local-only mode allows loopback targets only, and resolution must stay on loopback", () => {
  const policy = { schemaVersion: 1, mode: "local-only", grants: [] };
  const local = evaluateUrl(policy, { capability: "provider.inference", url: "http://localhost:11434/api" });
  assert.equal(local.allowed, true);
  assert.equal(local.loopbackOnly, true);
  assert.deepEqual(evaluateResolved(local, ["127.0.0.1", "::1"]), { allowed: true });
  assert.equal(evaluateResolved(local, ["93.184.216.34"]).allowed, false);
  assert.equal(evaluateUrl(policy, { capability: "provider.inference", url: "http://[::1]:8080" }).allowed, true);
  assert.equal(evaluateUrl(policy, { capability: "provider.inference", url: "https://example.com" }).allowed, false);
  assert.throws(() => normalizeNetworkPolicy({ ...policy, grants: [grant()] }), /cannot carry grants/);
});

test("allowlist grants match capability, scheme, host, and port exactly", () => {
  const policy = allowlist([grant(), grant({ id: "g2", capability: "asset.fetch", host: "*.cdn.example.com", port: 8443 })]);
  assert.equal(evaluateUrl(policy, { capability: "provider.inference", url: "https://api.example.com/v1" }).grantId, "g1");
  assert.equal(evaluateUrl(policy, { capability: "import.fetch", url: "https://api.example.com/v1" }).allowed, false);
  assert.equal(evaluateUrl(policy, { capability: "provider.inference", url: "http://api.example.com/v1" }).allowed, false);
  assert.equal(evaluateUrl(policy, { capability: "provider.inference", url: "https://api.example.com:444/v1" }).allowed, false);
  assert.equal(evaluateUrl(policy, { capability: "provider.inference", url: "https://evil-api.example.com" }).allowed, false);
  assert.equal(evaluateUrl(policy, { capability: "asset.fetch", url: "https://img.cdn.example.com:8443/a.png" }).grantId, "g2");
  assert.equal(evaluateUrl(policy, { capability: "asset.fetch", url: "https://cdn.example.com:8443/a.png" }).allowed, false, "wildcard excludes the apex");
  assert.equal(evaluateUrl(policy, { capability: "asset.fetch", url: "https://img.cdn.example.com/a.png" }).allowed, false, "explicit port required");
  assert.throws(() => normalizeNetworkPolicy(allowlist([grant({ host: "*.com" })])), /two labels/);
});

test("credentials in URLs, unsupported schemes, and malformed URLs are refused", () => {
  const policy = allowlist([grant()]);
  for (const url of ["https://user:pass@api.example.com/", "ftp://api.example.com/", "file:///etc/passwd", "not a url", "x".repeat(3000)]) {
    assert.equal(evaluateUrl(policy, { capability: "provider.inference", url }).allowed, false, url.slice(0, 40));
  }
});

test("DNS rebinding and private targets are refused unless explicitly granted", () => {
  const policy = allowlist([grant(), grant({ id: "lan", host: "nas.home.arpa", allowPrivateNetwork: true }), grant({ id: "ip", host: "10.0.0.5" })]);
  const remote = evaluateUrl(policy, { capability: "provider.inference", url: "https://api.example.com" });
  assert.deepEqual(evaluateResolved(remote, ["93.184.216.34"]), { allowed: true });
  for (const rebound of [["127.0.0.1"], ["10.0.0.7"], ["93.184.216.34", "169.254.169.254"], ["::ffff:192.168.1.1"]]) {
    assert.equal(evaluateResolved(remote, rebound).allowed, false, rebound.join(","));
  }
  assert.equal(evaluateResolved(remote, []).allowed, false);
  assert.equal(evaluateResolved(remote, ["example.com"]).allowed, false);
  const lan = evaluateUrl(policy, { capability: "provider.inference", url: "https://nas.home.arpa" });
  assert.deepEqual(evaluateResolved(lan, ["192.168.1.20"]), { allowed: true });
  assert.equal(evaluateResolved(lan, ["127.0.0.1"]).allowed, false, "private grants never cover loopback");
  assert.equal(evaluateUrl(policy, { capability: "provider.inference", url: "https://10.0.0.5" }).allowed, false, "private literal needs allowPrivateNetwork");
  assert.equal(evaluateUrl(policy, { capability: "provider.inference", url: "https://localhost" }).allowed, false, "loopback needs a loopback grant");
  assert.equal(evaluateResolved({ allowed: false, capability: null, reason: "x" }, ["93.184.216.34"]).allowed, false);
});

test("loopback grants in allowlist mode stay on loopback", () => {
  const policy = allowlist([grant({ id: "ollama", scheme: "http", host: "localhost", port: 11434 })]);
  const decision = evaluateUrl(policy, { capability: "provider.inference", url: "http://localhost:11434/api/generate" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.loopbackOnly, true);
  assert.equal(evaluateResolved(decision, ["93.184.216.34"]).allowed, false);
});

test("provider registries hold credential references only", () => {
  const ok = normalizeProviderRegistry(registry([
    { id: "rules", kind: "in-process", capabilities: ["inference.text"] },
    { id: "hosted", kind: "remote-http", capabilities: ["inference.text"], endpoint: "https://api.example.com/v1", credentialRef: { store: "env", name: "LILAC_API_KEY" } },
  ]));
  assert.equal(ok.providers[1].credentialRef.name, "LILAC_API_KEY");
  const bad = [
    { id: "x", kind: "remote-http", capabilities: ["inference.text"], endpoint: "https://api.example.com", apiKey: "sk-live-123" },
    { id: "x", kind: "remote-http", capabilities: ["inference.text"], endpoint: "https://u:p@api.example.com" },
    { id: "x", kind: "remote-http", capabilities: ["inference.text"], endpoint: "https://api.example.com/?key=sk-123" },
    { id: "x", kind: "remote-http", capabilities: ["inference.text"], endpoint: "http://127.0.0.1:1" },
    { id: "x", kind: "loopback-http", capabilities: ["inference.text"], endpoint: "https://api.example.com" },
    { id: "x", kind: "in-process", capabilities: ["inference.text"], endpoint: "https://api.example.com" },
    { id: "x", kind: "remote-http", capabilities: ["inference.text"], endpoint: "https://api.example.com", credentialRef: { store: "env", name: "sk-live-123" } },
    { id: "x", kind: "in-process", capabilities: ["telepathy"] },
  ];
  for (const provider of bad) assert.throws(() => normalizeProviderRegistry(registry([provider])), NetworkPolicyValidationError, JSON.stringify(provider).slice(0, 60));
  assert.throws(() => normalizeProviderRegistry(registry([{ id: "a", kind: "in-process", capabilities: ["ocr"] }, { id: "a", kind: "in-process", capabilities: ["ocr"] }])), /distinct/);
});

test("provider resolution follows the policy and explains every rejection", () => {
  const providers = registry([
    { id: "hosted", kind: "remote-http", capabilities: ["inference.text"], endpoint: "https://api.example.com/v1" },
    { id: "ollama", kind: "loopback-http", capabilities: ["inference.text"], endpoint: "http://localhost:11434" },
    { id: "rules", kind: "in-process", capabilities: ["inference.text"] },
  ]);
  const offline = resolveProvider(providers, defaultNetworkPolicy(), "inference.text");
  assert.equal(offline.provider.id, "rules");
  assert.deepEqual(offline.rejected.map((entry) => entry.id), ["hosted", "ollama"]);
  const local = resolveProvider(providers, { schemaVersion: 1, mode: "local-only", grants: [] }, "inference.text");
  assert.equal(local.provider.id, "ollama");
  const hosted = resolveProvider(providers, allowlist([grant()]), "inference.text");
  assert.equal(hosted.provider.id, "hosted");
  assert.equal(hosted.decision.grantId, "g1");
  assert.equal(resolveProvider(providers, defaultNetworkPolicy(), "ocr").provider, null);
});

test("offline readiness: every required core feature works with no providers and no network", () => {
  const report = evaluateOfflineReadiness(registry([]), defaultNetworkPolicy());
  assert.equal(report.ready, true);
  assert.ok(CORE_FEATURES.filter((feature) => feature.required).every((feature) => feature.needs.length === 0));
  const optional = report.features.find((entry) => entry.feature === "decision.model-ranking");
  assert.deepEqual(optional.missing, ["inference.text"]);
  const withLocalModel = evaluateOfflineReadiness(registry([{ id: "ollama", kind: "loopback-http", capabilities: ["inference.text"], endpoint: "http://localhost:11434" }]), { schemaVersion: 1, mode: "local-only", grants: [] });
  assert.deepEqual(withLocalModel.features.find((entry) => entry.feature === "decision.model-ranking").providers, { "inference.text": "ollama" });
});

test("malformed, hostile, and oversized configuration fails closed", () => {
  const base = allowlist([grant()]);
  const rejects = (value) => assert.throws(() => normalizeNetworkPolicy(value), NetworkPolicyValidationError);
  rejects({ ...base, extra: 1 });
  rejects({ ...base, schemaVersion: 2 });
  rejects({ ...base, mode: "yolo" });
  rejects(allowlist([grant(), grant()]));
  rejects(allowlist([grant({ purpose: "" })]));
  rejects(allowlist([grant({ port: 70000 })]));
  rejects(allowlist([grant({ host: "exa mple.com" })]));
  rejects(allowlist([grant({ purpose: "fetch \u{202e}evil" })]));
  rejects(allowlist(Array.from({ length: 65 }, (_, index) => grant({ id: `g${index}` }))));
  rejects(new Proxy(base, {}));
  const getter = { ...base };
  Object.defineProperty(getter, "mode", { enumerable: true, get: () => "allowlist" });
  rejects(getter);
  assert.throws(() => evaluateUrl(base, { capability: "telemetry", url: "https://api.example.com" }), NetworkPolicyValidationError);
});
