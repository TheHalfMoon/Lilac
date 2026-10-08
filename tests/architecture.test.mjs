import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import {
  ARCHITECTURE_SCHEMA_VERSION,
  ArchitectureValidationError,
  IMPLEMENTED_PACKAGES,
  LILAC_ARCHITECTURE_MAP,
  architectureDigest,
  canonicalArchitectureStringify,
  normalizeArchitectureMap,
  sha256Text,
} from "../packages/architecture/src/index.ts";

const REQUIRED_IDS = [
  "document-model",
  "canvas-viewport",
  "selection-transform",
  "layout-css",
  "text",
  "vector",
  "images-media",
  "components",
  "tokens-themes",
  "renderer",
  "persistence",
  "history",
  "collaboration",
  "import-export",
  "code-ir",
  "round-trip-sync",
  "agent-runtime",
  "desktop-bridge",
  "sandbox-security",
  "plugin-surface",
];

function entry(overrides = {}) {
  return {
    id: "test-subsystem",
    title: "Test subsystem",
    owner: "@lilac/test-owner",
    status: "planned",
    boundary: "A bounded test boundary.",
    dependsOn: [],
    ...overrides,
  };
}

function map(subsystems) {
  return { schemaVersion: ARCHITECTURE_SCHEMA_VERSION, subsystems };
}

test("canonical catalog covers every required subsystem exactly once", () => {
  const normalized = normalizeArchitectureMap(LILAC_ARCHITECTURE_MAP);
  const ids = normalized.subsystems.map((subsystem) => subsystem.id);
  for (const required of REQUIRED_IDS) {
    assert.ok(ids.includes(required), required);
  }
  assert.equal(new Set(ids).size, ids.length);
  const owners = Object.fromEntries(normalized.subsystems.map((subsystem) => [subsystem.id, subsystem.owner]));
  assert.equal(owners["document-model"], "@ninerr/document-model");
  assert.equal(owners["history"], "@ninerr/history");
  assert.equal(owners["collaboration"], "@ninerr/collaboration");
  assert.equal(owners["import-export"], "@ninerr/import-stack");
  assert.equal(owners["agent-runtime"], "@ninerr/agent-runtime");
  assert.equal(owners["mcp-surface"], "@lilac/mcp-protocol");
  assert.equal(owners["canvas-viewport"], "@ninerr/canvas");
  assert.equal(owners["components"], "@lilac/design-components");
  assert.equal(owners["agent-workspace"], "@lilac/agent-workspace");
  assert.equal(owners["visual-git"], "@lilac/visual-git");
  const planned = normalized.subsystems.filter((subsystem) => subsystem.status === "planned");
  assert.ok(planned.length > 0);
  const implemented = normalized.subsystems.filter((subsystem) => subsystem.status === "implemented");
  assert.ok(implemented.length >= 10);
});

test("duplicate ownership and unknown references fail closed", () => {
  const base = LILAC_ARCHITECTURE_MAP.subsystems;
  assert.throws(() => normalizeArchitectureMap(map([...base, entry({ id: "document-model" })])), ArchitectureValidationError);
  assert.throws(() => normalizeArchitectureMap(map([entry({ dependsOn: ["no-such-subsystem"] })])), ArchitectureValidationError);
  assert.throws(() => normalizeArchitectureMap(map([entry({ id: "loop-a", dependsOn: ["loop-a"] })])), ArchitectureValidationError);
  assert.throws(() => normalizeArchitectureMap(map([
    entry({ id: "cycle-a", dependsOn: ["cycle-b"] }),
    entry({ id: "cycle-b", dependsOn: ["cycle-a"] }),
  ])), ArchitectureValidationError);
  assert.throws(() => normalizeArchitectureMap(map([entry({ status: "implemented", owner: "@lilac/does-not-exist" })])), ArchitectureValidationError);
  assert.throws(() => normalizeArchitectureMap(map([entry({ status: "stub", owner: "@lilac/does-not-exist" })])), ArchitectureValidationError);
  assert.throws(() => normalizeArchitectureMap(map([entry({ owner: "not-a-package" })])), ArchitectureValidationError);
  assert.throws(() => normalizeArchitectureMap(map([entry({ id: "Bad_Id" })])), ArchitectureValidationError);
  assert.throws(() => normalizeArchitectureMap(map([])), ArchitectureValidationError);
  assert.throws(() => normalizeArchitectureMap({ schemaVersion: 999, subsystems: [entry()] }), ArchitectureValidationError);
});

test("oversized catalogs fail closed", () => {
  const subsystems = Array.from({ length: 65 }, (_, index) => entry({ id: `subsystem-${index}` }));
  assert.throws(() => normalizeArchitectureMap(map(subsystems)), ArchitectureValidationError);
  const deps = Array.from({ length: 17 }, (_, index) => `subsystem-x${index}`);
  const known = deps.map((id) => entry({ id }));
  assert.throws(() => normalizeArchitectureMap(map([...known, entry({ id: "hub", dependsOn: deps })])), ArchitectureValidationError);
});

test("deterministic serialization for identical inputs", () => {
  assert.equal(canonicalArchitectureStringify(LILAC_ARCHITECTURE_MAP), canonicalArchitectureStringify(JSON.parse(JSON.stringify(LILAC_ARCHITECTURE_MAP))));
  assert.equal(architectureDigest(LILAC_ARCHITECTURE_MAP).length, 64);
  assert.equal(sha256Text("lilac").length, 64);
});

function workspacePackages() {
  const root = new URL("../packages/", import.meta.url);
  return readdirSync(root, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    // Every workspace package, whatever its entry is called (the desktop shell's is policy.mjs).
    .filter((dirent) => existsSync(new URL(`${dirent.name}/package.json`, root)))
    .map((dirent) => JSON.parse(readFileSync(new URL(`${dirent.name}/package.json`, root), "utf8")).name)
    .sort();
}

test("every workspace package is owned by a delivered catalog subsystem", () => {
  const packages = workspacePackages();
  assert.ok(packages.length >= 17);
  const delivered = normalizeArchitectureMap(LILAC_ARCHITECTURE_MAP).subsystems.filter((subsystem) => subsystem.status !== "planned");
  for (const name of packages) {
    assert.ok(delivered.some((subsystem) => subsystem.owner === name), `${name} has no implemented or stub catalog entry`);
  }
});

test("known package list matches the workspace exactly", () => {
  assert.deepEqual([...IMPLEMENTED_PACKAGES].sort(), workspacePackages());
});
