import test from "node:test";
import assert from "node:assert/strict";

import { RECORD_PATH, depsVariable, readRecord, validateRecord } from "../scripts/desktop/corresponding-source.mjs";
import { ELECTRON_ARCHIVES, ELECTRON_LICENSE_SHA256, ELECTRON_VERSION } from "../scripts/desktop/electron.mjs";

// N0-G7b: the Electron runtime Ninerr ships is bound to its exact corresponding source. The
// record is resolved and checked against the live sources by the script (--write, --check);
// these tests hold it to the pinned runtime without the network.

test("the corresponding-source record matches the pinned runtime", () => {
  const record = readRecord();
  assert.deepEqual(validateRecord(record), []);
  assert.equal(record.electron.version, ELECTRON_VERSION);
  assert.deepEqual(record.electron.archives, { ...ELECTRON_ARCHIVES });
  assert.equal(record.electron.licenseSha256, ELECTRON_LICENSE_SHA256);
  // The LGPL components and the source each is built from.
  const ffmpeg = record.components.find((component) => component.name === "ffmpeg");
  assert.match(ffmpeg.license, /LGPL/u);
  assert.match(ffmpeg.source.repository, /^https:\/\/chromium\.googlesource\.com\/chromium\/third_party\/ffmpeg$/u);
  assert.ok(record.components.some((component) => component.name.startsWith("Blink") && /LGPL/u.test(component.license)));
});

test("a record that does not match the pinned runtime is refused", () => {
  const record = readRecord();
  const broken = (change) => {
    const copy = structuredClone(record);
    change(copy);
    return validateRecord(copy);
  };
  assert.ok(broken((copy) => { copy.electron.version = "0.0.0"; }).length > 0, "another Electron version");
  assert.ok(broken((copy) => { copy.electron.archives["linux-x64"] = "0".repeat(64); }).length > 0, "another archive digest");
  assert.ok(broken((copy) => { delete copy.electron.archives["win32-x64"]; }).length > 0, "a missing target");
  assert.ok(broken((copy) => { copy.electron.licenseSha256 = "0".repeat(64); }).length > 0, "another license");
  assert.ok(broken((copy) => { copy.electron.source.commit = "main"; }).length > 0, "a branch instead of a commit");
  assert.ok(broken((copy) => { copy.chromium.source.tag = "1.0.0.0"; }).length > 0, "a Chromium tag that is not its version");
  assert.ok(broken((copy) => { copy.components = copy.components.filter((component) => component.name !== "ffmpeg"); }).length > 0, "no ffmpeg source");
  assert.ok(broken((copy) => { copy.schema = 2; }).length > 0, "another schema");
  assert.deepEqual(validateRecord(null).length > 0, true);
});

test("DEPS variables are read whether the value is on the same line or the next", () => {
  const deps = "vars = {\n  'chromium_version':\n    '152.0.7977.130',\n  'node_version': 'v24.21.0',\n}";
  assert.equal(depsVariable(deps, "chromium_version"), "152.0.7977.130");
  assert.equal(depsVariable(deps, "node_version"), "v24.21.0");
  assert.throws(() => depsVariable(deps, "ffmpeg_revision"), /DEPS has no ffmpeg_revision/u);
});

test("the record ships in the release bundle with the other provenance records", async () => {
  const { BUNDLED_DIRECTORIES } = await import("../scripts/release-bundle.mjs");
  assert.ok(BUNDLED_DIRECTORIES.some((directory) => RECORD_PATH.startsWith(`${directory}/`)), `${RECORD_PATH} is in a bundled directory`);
});
