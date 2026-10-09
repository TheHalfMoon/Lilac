#!/usr/bin/env node
// The exact corresponding source of the Electron runtime Ninerr ships (N0-G7b).
//
// The desktop app redistributes Electron's official release archive, changed only in its fuse
// bytes. Electron statically links LGPL components from Chromium (Blink, from WebKit) and ships
// the LGPL libffmpeg. This module binds, for the pinned release:
//
//   the shipped archive (SHA-256 per target) → the Electron version → its git commit and tree
//   → the Chromium version Electron pins → Chromium's git commit and tree → the ffmpeg revision
//   Chromium pins → the licenses → the release evidence (this record ships in the bundle).
//
// Git commit and tree ids are content addresses, so they identify the source exactly. Electron
// publishes no source archive, and no official Chromium source tarball exists for every release
// Electron pins, so the record names repositories and commits, not tarballs.
//
//   node scripts/desktop/corresponding-source.mjs --write   resolve live and write the record
//   node scripts/desktop/corresponding-source.mjs --check   resolve live and compare
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ELECTRON_ARCHIVES, ELECTRON_LICENSE_SHA256, ELECTRON_VERSION } from "./electron.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const RECORD_PATH = "docs/provenance/ELECTRON_CORRESPONDING_SOURCE.json";
export const RECORD_SCHEMA = 1;
const ELECTRON_REPOSITORY = "https://github.com/electron/electron";
const CHROMIUM_REPOSITORY = "https://chromium.googlesource.com/chromium/src";
const FFMPEG_REPOSITORY = "https://chromium.googlesource.com/chromium/third_party/ffmpeg";
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

async function fetchText(url, headers = {}) {
  const response = await fetch(url, { headers: { "user-agent": "ninerr-corresponding-source", ...headers } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

// The REST API for the Electron repository (named from its parts, so the URL is not read as a project).
const GITHUB_API = "https://api.github.com";
const github = (path) => fetchText(`${GITHUB_API}/${["repos", "electron", "electron"].join("/")}/${path}`, {
  accept: "application/vnd.github+json",
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
}).then((text) => JSON.parse(text));

// Gitiles prefixes JSON with )]}' to defeat cross-site script inclusion.
const gitiles = (url) => fetchText(`${url}?format=JSON`).then((text) => JSON.parse(text.replace(/^\)\]\}'\n?/u, "")));
const gitilesFile = (url) => fetchText(`${url}?format=TEXT`).then((text) => Buffer.from(text, "base64").toString("utf8"));

/** The DEPS variable `name` (a quoted string, possibly on the next line). */
export function depsVariable(deps, name) {
  const match = new RegExp(`'${name}':\\s*'([^']+)'`, "u").exec(deps);
  if (match === null) throw new Error(`DEPS has no ${name}`);
  return match[1];
}

/** Resolves the binding for the pinned Electron release from the live sources. */
export async function resolveCorrespondingSource() {
  const tag = `v${ELECTRON_VERSION}`;
  // The release's own published digests must equal the pinned ones: the version is verified live.
  const sums = await fetchText(`${ELECTRON_REPOSITORY}/releases/download/${tag}/SHASUMS256.txt`);
  for (const [target, digest] of Object.entries(ELECTRON_ARCHIVES)) {
    const line = sums.split("\n").find((entry) => entry.trim().endsWith(`*electron-${tag}-${target}.zip`) || entry.trim().endsWith(` electron-${tag}-${target}.zip`));
    if (line === undefined) throw new Error(`SHASUMS256.txt has no electron-${tag}-${target}.zip`);
    if (line.trim().split(/\s+/u)[0] !== digest) throw new Error(`electron-${tag}-${target}.zip: the release publishes ${line.trim().split(/\s+/u)[0]}, Ninerr pins ${digest}`);
  }
  // The tag may be annotated: follow it to the commit.
  let object = (await github(`git/ref/tags/${tag}`)).object;
  if (object.type === "tag") object = (await github(`git/tags/${object.sha}`)).object;
  if (object.type !== "commit") throw new Error(`${tag} does not resolve to a commit`);
  const electronCommit = object.sha;
  const electronTree = (await github(`git/commits/${electronCommit}`)).tree.sha;
  const electronDeps = Buffer.from((await github(`contents/DEPS?ref=${electronCommit}`)).content, "base64").toString("utf8");
  const chromiumVersion = depsVariable(electronDeps, "chromium_version");
  const nodeVersion = depsVariable(electronDeps, "node_version");
  const chromium = await gitiles(`${CHROMIUM_REPOSITORY}/+/refs/tags/${chromiumVersion}`);
  const chromiumDeps = await gitilesFile(`${CHROMIUM_REPOSITORY}/+/${chromium.commit}/DEPS`);
  const ffmpegRevision = depsVariable(chromiumDeps, "ffmpeg_revision");
  return {
    schema: RECORD_SCHEMA,
    electron: {
      version: ELECTRON_VERSION,
      license: "MIT",
      licenseSha256: ELECTRON_LICENSE_SHA256,
      archives: { ...ELECTRON_ARCHIVES },
      source: { repository: ELECTRON_REPOSITORY, tag, commit: electronCommit, tree: electronTree },
      modifications: "Ninerr changes the shipped binary only in Electron's documented fuse bytes, recorded per package in ninerr-package.json.",
    },
    chromium: {
      version: chromiumVersion,
      source: { repository: CHROMIUM_REPOSITORY, tag: chromiumVersion, commit: chromium.commit, tree: chromium.tree },
      patches: "Electron's patches to Chromium are in the Electron source at the commit above (patches/chromium).",
    },
    components: [
      { name: "Blink (WebKit)", license: "LGPL-2.0+/LGPL-2.1+ and BSD", linkage: "statically linked into the Electron executable", source: "Chromium at the commit above, third_party/blink, with Electron's patches" },
      { name: "ffmpeg", license: "LGPL-2.1+", linkage: "the separately linked libffmpeg, replaceable", source: { repository: FFMPEG_REPOSITORY, commit: ffmpegRevision, pinnedBy: "Chromium DEPS ffmpeg_revision" } },
      { name: "Node.js", license: "MIT", linkage: "built into the Electron executable", source: { repository: "https://github.com/nodejs/node", tag: nodeVersion, pinnedBy: "Electron DEPS node_version" } },
    ],
    build: "Electron's documented source build (gclient sync of the Electron commit above, which checks out Chromium at its pinned version) reproduces the runtime; https://www.electronjs.org/docs/latest/development/build-instructions-gn",
  };
}

/** Problems with a record as it relates to the pinned runtime, without the network. */
export function validateRecord(record) {
  const problems = [];
  const expect = (condition, message) => { if (!condition) problems.push(message); };
  expect(record?.schema === RECORD_SCHEMA, `schema is ${RECORD_SCHEMA}`);
  expect(record?.electron?.version === ELECTRON_VERSION, `electron.version is the pinned ${ELECTRON_VERSION}`);
  expect(record?.electron?.licenseSha256 === ELECTRON_LICENSE_SHA256, "electron.licenseSha256 is the pinned license digest");
  expect(JSON.stringify(record?.electron?.archives) === JSON.stringify(ELECTRON_ARCHIVES), "electron.archives are the pinned archive digests");
  expect(Object.values(record?.electron?.archives ?? {}).every((digest) => SHA256.test(digest)), "every archive digest is a SHA-256");
  expect(record?.electron?.source?.tag === `v${ELECTRON_VERSION}`, "electron.source.tag is the pinned release tag");
  expect(SHA1.test(record?.electron?.source?.commit ?? "") && SHA1.test(record?.electron?.source?.tree ?? ""), "electron.source has a commit and tree id");
  expect(/^\d+\.\d+\.\d+\.\d+$/u.test(record?.chromium?.version ?? ""), "chromium.version is a Chromium version");
  expect(record?.chromium?.source?.tag === record?.chromium?.version, "chromium.source.tag is chromium.version");
  expect(SHA1.test(record?.chromium?.source?.commit ?? "") && SHA1.test(record?.chromium?.source?.tree ?? ""), "chromium.source has a commit and tree id");
  const ffmpeg = record?.components?.find((component) => component.name === "ffmpeg");
  expect(SHA1.test(ffmpeg?.source?.commit ?? ""), "the ffmpeg component has a source commit");
  expect(record?.components?.some((component) => component.name.startsWith("Blink")), "the Blink component is recorded");
  return problems;
}

export function readRecord() {
  return JSON.parse(readFileSync(new URL(`../../${RECORD_PATH}`, import.meta.url), "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  if (mode !== "--write" && mode !== "--check") {
    process.stderr.write("usage: corresponding-source.mjs --write | --check\n");
    process.exit(2);
  }
  try {
    const live = await resolveCorrespondingSource();
    const problems = validateRecord(live);
    if (problems.length > 0) throw new Error(problems.join("; "));
    const text = `${JSON.stringify(live, null, 2)}\n`;
    if (mode === "--write") {
      writeFileSync(`${ROOT}${RECORD_PATH}`, text);
      process.stdout.write(`wrote ${RECORD_PATH}: Electron ${live.electron.version} (${live.electron.source.commit}), Chromium ${live.chromium.version} (${live.chromium.source.commit}), ffmpeg ${live.components.find((component) => component.name === "ffmpeg").source.commit}\n`);
    } else {
      const recorded = readFileSync(`${ROOT}${RECORD_PATH}`, "utf8");
      if (recorded !== text) throw new Error(`${RECORD_PATH} differs from the live sources; run --write and review the change`);
      process.stdout.write(`${RECORD_PATH} matches the live sources\n`);
    }
  } catch (error) {
    process.stderr.write(`corresponding-source: ${error.message}\n`);
    process.exit(1);
  }
}
