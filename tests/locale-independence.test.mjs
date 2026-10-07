import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCALES = ["C", "en_US.UTF-8", "sv_SE.UTF-8", "tr_TR.UTF-8"];

// Ids whose collation differs between locales: sv_SE puts a-ring and a-umlaut
// after z, tr_TR has dotless i, and en_US ignores case at the first level.
const IDS = ["a", "aa", "B", "z", "\u00e4", "\u00e5", "I", "\u0131", "e\u0301", "\u00e9"];

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:mjs|ts)$/u.test(name) ? [path] : [];
  });
}

test("package sources never order by locale", () => {
  const offenders = readdirSync(join(ROOT, "packages"))
    .flatMap((name) => sourceFiles(join(ROOT, "packages", name, "src")))
    .filter((path) => /\.localeCompare\s*\(/u.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(ROOT.length));
  assert.deepEqual(offenders, []);
});

const SCRIPT = `
  const root = ${JSON.stringify(new URL("../packages/", import.meta.url).href)};
  const ids = ${JSON.stringify(IDS)};
  const imports = await import(root + "import-stack/src/index.ts");
  const assurance = await import(root + "design-assurance/src/index.mjs");
  const model = await import(root + "document-model/src/index.mjs");

  const request = (requestId) => ({
    schemaVersion: imports.IMPORT_SCHEMA_VERSION, requestId, actorId: "user-1", intent: "Import",
    at: "2026-10-07T09:00:00.000Z", policy: imports.defaultImportPolicy("offline"),
    source: { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" },
  });
  const html = "<div " + ids.map((id, index) => "data-" + index + "-" + encodeURIComponent(id).replace(/%/g, "") + "=\\"" + id + "\\"").join(" ") + ">"
    + ids.map((id) => "<a href=\\"/" + encodeURIComponent(id) + "\\">" + id + "</a><style>." + id + "{color:red}</style>").join("") + "</div>";
  const proposal = imports.importHtmlSnapshot(request("r-1"), html);

  let ledger = imports.createImportRequestLedger();
  for (const id of ids) ledger = imports.recordImportRequest(ledger, request("r-" + id), proposal.inputSha256, proposal.proposalId).ledger;

  const document = model.createDocument({ id: "doc-1", nodes: [
    { id: "root", type: "frame", children: ids.map((id) => "token-" + id) },
    ...ids.map((id) => ({ id: "token-" + id, type: "token-reference", parentId: "root", props: { tokenId: "missing." + id } })),
  ] });
  const report = assurance.scanDocument({ document });

  process.stdout.write(JSON.stringify({
    nodes: Object.keys(proposal.nodes),
    attributes: Object.values(proposal.nodes).map((node) => Object.keys(node.attributes)),
    resources: proposal.resources.map((entry) => entry.uri),
    stylesheets: proposal.stylesheets.map((entry) => entry.cssText),
    ledger: Object.keys(ledger.entries),
    findings: report.findings.map((finding) => JSON.stringify(finding.location)),
  }));
`;

test("proposals, ledgers and findings are ordered identically under every locale", () => {
  const outputs = LOCALES.map((locale) => execFileSync(
    process.execPath,
    ["--input-type=module", "-e", SCRIPT],
    { cwd: ROOT, env: { ...process.env, LC_ALL: locale, LANG: locale }, encoding: "utf8" },
  ));
  for (let index = 1; index < outputs.length; index += 1) {
    assert.equal(outputs[index], outputs[0], `${LOCALES[index]} differs from ${LOCALES[0]}`);
  }
  const parsed = JSON.parse(outputs[0]);
  assert.ok(parsed.resources.length >= IDS.length, "every link became a resource");
  assert.ok(parsed.findings.length >= IDS.length, "every unresolved token produced a finding");
  assert.equal(parsed.ledger.length, IDS.length);
  // Code-unit order: canonically equivalent but different strings stay distinct.
  const sortedCopy = [...parsed.resources].sort();
  assert.deepEqual(parsed.resources, sortedCopy);
});
