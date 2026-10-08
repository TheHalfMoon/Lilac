// The component licenses in an Electron runtime's LICENSES.chromium.html, by family, and
// a check that every component whose license text mentions a copyleft or other
// non-permissive license, by full name or SPDX id, is one Lilac has reviewed
// (docs/evidence/PC9B_DESKTOP_PACKAGING_2026-10-08.md).
// A runtime that brings a new such component fails packaging until it is reviewed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };
const unescape = (text) => text.replace(/&(amp|lt|gt|quot|#39|apos);/gu, (_match, name) => ENTITIES[name]).replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)));

const FAMILIES = [
  ["LGPL", /gnu (?:lesser|library) general public license|\blgpl-?v?\d/u],
  ["GPL", /gnu general public license|(?<![al])gpl-?v?\d/u],
  ["MPL", /mozilla public license|\bmpl-?\d/u],
  ["EPL", /eclipse public license|\bepl-?\d/u],
  ["CDDL", /common development and distribution license|\bcddl-?\d/u],
  ["AGPL", /gnu affero general public license|\bagpl-?v?\d/u],
  ["Apache", /apache license/u],
  ["MIT-style", /permission is hereby granted, free of charge/u],
  ["BSD-style", /redistribution and use in source and binary forms/u],
];
const NOT_PERMISSIVE = new Set(["LGPL", "GPL", "MPL", "EPL", "CDDL", "AGPL"]);

// Reviewed components whose license text names a non-permissive license, with why each
// is acceptable for an Apache-2.0 Lilac that redistributes the runtime changed only in
// Electron's fuse bytes.
export const REVIEWED = Object.freeze({
  WebKit: "LGPL-2.0+/LGPL-2.1+ and BSD files in Blink (from WebKit and KHTML), statically linked into the Electron binary. Lilac changes the binary only in Electron's documented fuse bytes (recorded in lilac-package.json); its corresponding source is Electron v44.7.0, with Chromium at its pinned revision, plus those fuse settings. Lilac's own code is a separate program the runtime loads, not linked into it. The LGPL source offer for a binary release is part of the release audit (PC-L, #139)",
  // Apache-2.0 WITH LLVM-exception: its text names GPLv2 only to permit combining with it.
  "compiler-rt": "Apache-2.0 WITH LLVM-exception; GPLv2 is named only in the exception",
  libcxx: "Apache-2.0 WITH LLVM-exception; GPLv2 is named only in the exception",
  libcxxabi: "Apache-2.0 WITH LLVM-exception; GPLv2 is named only in the exception",
  libunwind: "Apache-2.0 WITH LLVM-exception; GPLv2 is named only in the exception",
  "llvm-libc": "Apache-2.0 WITH LLVM-exception; GPLv2 is named only in the exception",
  dragonbox: "Apache-2.0 WITH LLVM-exception (or Boost-1.0); GPLv2 is named only in the exception",
  "v4l-utils": "LGPL-2.1 libv4l; loaded from the system where used, not shipped",
  ffmpeg: "LGPL-2.1+, built into the separately linked libffmpeg (replaceable); source is Chromium's third_party/ffmpeg at the release's Chromium revision",
  icu: "Unicode/ICU license; the GPL text is pkg-config's build macro, not in the binary",
  "Node.js": "MIT; the GPL text is in build tooling it bundles (pkg-config macro), not in the binary",
  JSZip: "dual MIT or GPL-3.0; used under MIT",
  hunspell: "MPL-1.1/GPL-2.0/LGPL-2.1 tri-license; used under MPL-1.1, file-level, unmodified; source is public",
  "hunspell dictionaries": "dictionaries under MPL/LGPL tri-licenses; Lilac turns spell checking off and downloads none",
  "hyphenation-patterns": "tri-licensed patterns (MPL/LGPL/other); unmodified, source public",
  "Netscape Portable Runtime (NSPR)": "MPL-2.0, file-level; unmodified, source public",
  "Mozilla Personal Security Manager": "MPL-2.0, file-level; unmodified, source public",
  "Mozilla Windows Cert code": "MPL-2.0, file-level; unmodified, source public",
  "ISimpleDOM COM interfaces for accessibility": "MPL/GPL/LGPL tri-license; used under MPL, unmodified",
  url_parse: "MPL/GPL/LGPL tri-license (from Mozilla); used under MPL, unmodified",
  Eigen: "MPL-2.0, file-level; unmodified, source public",
  grpc: "Apache-2.0; MPL text for a bundled component, unmodified",
  symphonia: "MPL-2.0 (its text names GPL only as a permitted Secondary License); unmodified, source public",
  "symphonia-bundle-flac": "as symphonia",
  "symphonia-bundle-mp3": "as symphonia",
  "symphonia-codec-pcm": "as symphonia",
  "symphonia-codec-vorbis": "as symphonia",
  "symphonia-common": "as symphonia",
  "symphonia-core": "as symphonia",
  "symphonia-metadata": "as symphonia",
  "AXE-CORE Accessibility Audit": "MPL-2.0, file-level; unmodified, source public",
  "Android NDK": "notice for Android builds; MPL and CC texts for bundled parts, not in a desktop binary",
  glibc: "LGPL; the system C library, linked dynamically, not shipped",
  gtk: "LGPL; system library, linked dynamically, not shipped",
  libsecret: "LGPL; system library, loaded dynamically, not shipped",
  libusbx: "LGPL-2.1; linked dynamically from the system where used",
  libbrlapi: "LGPL-2.1; loaded dynamically from the system where installed, not shipped",
  "Speech Dispatcher": "LGPL; loaded dynamically from the system where installed, not shipped",
  "Braille Translation Library": "LGPL-2.1; part of the ChromeOS accessibility extension data, unmodified",
  "Checker Qual": "MIT with a GPL-2.0-with-classpath-exception notice; Java annotations for Android builds, not in a desktop binary",
  "DirectX-Shader-Compiler": "University of Illinois/NCSA; LGPL text for a bundled component, Windows only, unmodified",
  "plasma-wayland-protocols": "LGPL protocol descriptions; generated headers only, unmodified",
  "ScreenAI Library": "notice for a downloadable component Chromium does not ship in Electron",
  common: "Android (Google Play services) notice, not in a desktop binary",
  "core-common": "Android notice, not in a desktop binary",
  "feature-delivery": "Android notice, not in a desktop binary",
  "genai-common": "Android notice, not in a desktop binary",
  "genai-prompt": "Android notice, not in a desktop binary",
  googleid: "Android notice, not in a desktop binary",
  review: "Android notice, not in a desktop binary",
});

/** Classify `path` (a LICENSES.chromium.html). */
export function classifyChromiumLicenses(path) {
  const text = readFileSync(path, "utf8");
  const blocks = text.split('<div class="product">').slice(1);
  const families = {};
  const unreviewed = [];
  for (const block of blocks) {
    const title = unescape((/<span class="title">([\s\S]*?)<\/span>/u.exec(block)?.[1] ?? "?").replace(/<[^>]+>/gu, "")).trim();
    const body = unescape(/<pre>([\s\S]*?)<\/pre>/u.exec(block)?.[1] ?? "").toLowerCase();
    const found = FAMILIES.filter(([, pattern]) => pattern.test(body)).map(([name]) => name);
    for (const name of found.length > 0 ? found : ["other"]) families[name] = (families[name] ?? 0) + 1;
    const flagged = found.filter((name) => NOT_PERMISSIVE.has(name));
    // Google Play services notices are Android-only (play-services-*).
    if (flagged.length > 0 && !Object.hasOwn(REVIEWED, title) && !title.startsWith("play-services-")) unreviewed.push({ component: title, families: flagged });
  }
  return { components: blocks.length, sha256: createHash("sha256").update(text).digest("hex"), families, unreviewed };
}
