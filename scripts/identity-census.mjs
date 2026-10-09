#!/usr/bin/env node
// Identity census and independence gate (N0.1, N0.9). Scans every tracked file's path and
// text for the terms in scripts/identity-policy.json, classifies each finding by the first
// matching rule, and reports per file. The output depends only on tracked content, so two
// runs over the same tree produce identical bytes.
//
//   node scripts/identity-census.mjs            print the census JSON
//   node scripts/identity-census.mjs --write    write its summary to docs/evidence/N0_IDENTITY_CENSUS.json
//   node scripts/identity-census.mjs --verify   fail when that summary does not match this tree
//   node scripts/identity-census.mjs --check    fail on any finding in a gated category
//   --root <dir>                                scan another Git checkout instead of this one
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const CENSUS_PATH = "docs/evidence/N0_IDENTITY_CENSUS.json";
// The artifact is the output, and the tool, its policy and its test must name every term;
// scanning them would make the result describe the census rather than the product.
const NOT_SCANNED = new Set([CENSUS_PATH, "scripts/identity-census.mjs", "scripts/identity-policy.json", "tests/identity-census.test.mjs"]);
const RULE_KEYS = new Set(["id", "category", "path", "terms", "line", "reason"]);
const MAX_LINES_LISTED = 50;
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function loadPolicy(text = readFileSync(join(ROOT, "scripts/identity-policy.json"), "utf8")) {
  const policy = JSON.parse(text);
  const terms = Object.entries(policy.terms).map(([id, source]) => ({ id, pattern: new RegExp(source, "iu") }));
  const categories = new Set(Object.keys(policy.categories));
  const rules = policy.rules.map((rule, index) => {
    for (const key of Object.keys(rule)) if (!RULE_KEYS.has(key)) throw new Error(`rule ${rule.id}: unknown key ${key}`);
    if (typeof rule.reason !== "string" || rule.reason.trim() === "") throw new Error(`rule ${rule.id}: a reason is required`);
    const constrained = rule.path !== undefined || rule.terms !== undefined || rule.line !== undefined;
    if (constrained === (index === policy.rules.length - 1)) throw new Error(`rule ${rule.id}: the last rule, and only the last rule, matches every finding`);
    if (!categories.has(rule.category)) throw new Error(`rule ${rule.id}: unknown category ${rule.category}`);
    for (const term of rule.terms ?? []) if (!Object.hasOwn(policy.terms, term)) throw new Error(`rule ${rule.id}: unknown term ${term}`);
    return {
      id: rule.id,
      category: rule.category,
      path: rule.path === undefined ? null : new RegExp(rule.path, "u"),
      terms: rule.terms === undefined ? null : new Set(rule.terms),
      line: rule.line === undefined ? null : new RegExp(rule.line, "u"),
    };
  });
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error("rule ids must be unique");
  for (const category of policy.gated) if (!categories.has(category)) throw new Error(`unknown gated category ${category}`);
  return { terms, rules, gated: new Set(policy.gated), categories: [...categories] };
}

/** The first rule that matches a finding of `term` in `path` (on `line`, or the path itself). */
export function classify(policy, path, term, line) {
  for (const rule of policy.rules) {
    if (rule.path && !rule.path.test(path)) continue;
    if (rule.terms && !rule.terms.has(term)) continue;
    if (rule.line && (line === null || !rule.line.test(line))) continue;
    return rule;
  }
  throw new Error("unreachable: the last rule matches everything");
}

export function trackedFiles(root) {
  // During a merge, git ls-files lists a conflicted path once per stage; count each path once.
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0").filter((path) => path !== "" && !NOT_SCANNED.has(path));
  return [...new Set(paths)].sort(byCodeUnit);
}

/** Scan `files` (paths relative to `root`) and return the census record. */
export function census(policy, root = ROOT, files = trackedFiles(root)) {
  const results = [];
  const totals = Object.fromEntries(policy.categories.map((category) => [category, 0]));
  const byTerm = Object.fromEntries(policy.terms.map((term) => [term.id, 0]));
  for (const path of files) {
    const findings = new Map();
    const record = (term, rule, lineNumber) => {
      const key = `${term}\u0000${rule.id}`;
      let finding = findings.get(key);
      if (!finding) findings.set(key, finding = { term, category: rule.category, rule: rule.id, count: 0, lines: [] });
      finding.count += 1;
      if (lineNumber > 0 && finding.lines.length < MAX_LINES_LISTED) finding.lines.push(lineNumber);
      totals[rule.category] += 1;
      byTerm[term] += 1;
    };
    for (const term of policy.terms) if (term.pattern.test(path)) record(term.id, classify(policy, path, term.id, null), 0);
    const bytes = readFileSync(join(root, path));
    if (!bytes.includes(0)) {
      const lines = bytes.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        for (const term of policy.terms) {
          if (term.pattern.test(lines[index])) record(term.id, classify(policy, path, term.id, lines[index]), index + 1);
        }
      }
    }
    if (findings.size > 0) {
      const sorted = [...findings.values()].sort((a, b) => byCodeUnit(a.term, b.term) || byCodeUnit(a.rule, b.rule));
      results.push({ path, findings: sorted });
    }
  }
  const gatedFindings = Object.entries(totals).filter(([category]) => policy.gated.has(category)).reduce((sum, [, count]) => sum + count, 0);
  return {
    schema: "identity-census/1",
    filesScanned: files.length,
    filesWithFindings: results.length,
    gatedFindings,
    byCategory: totals,
    byTerm,
    files: results,
  };
}

export function serialize(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * The committed artifact: totals by category, term and rule, plus the SHA-256 of the full
 * census, so anyone can regenerate the per-file detail (`node scripts/identity-census.mjs`)
 * and check it against what was recorded without the repository carrying every line.
 */
export function summarize(record) {
  const byRule = {};
  for (const file of record.files) for (const finding of file.findings) byRule[finding.rule] = (byRule[finding.rule] ?? 0) + finding.count;
  return {
    schema: "identity-census-summary/1",
    filesScanned: record.filesScanned,
    filesWithFindings: record.filesWithFindings,
    gatedFindings: record.gatedFindings,
    byCategory: record.byCategory,
    byTerm: record.byTerm,
    byRule: Object.fromEntries(Object.entries(byRule).sort(([a], [b]) => byCodeUnit(a, b))),
    censusSha256: createHash("sha256").update(serialize(record), "utf8").digest("hex"),
  };
}

function main(argv) {
  const policy = loadPolicy();
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex === -1 ? ROOT : argv[rootIndex + 1];
  if (root === undefined) throw new Error("--root needs a directory");
  // One mode per run, so a combined invocation cannot run one check and silently skip another.
  const modes = ["--write", "--verify", "--check"].filter((mode) => argv.includes(mode));
  if (modes.length > 1) {
    process.stderr.write(`identity census: give one of ${modes.join(", ")} per run\n`);
    return 2;
  }
  const record = census(policy, root, trackedFiles(root));
  if (argv.includes("--write")) {
    mkdirSync(dirname(join(root, CENSUS_PATH)), { recursive: true });
    writeFileSync(join(root, CENSUS_PATH), serialize(summarize(record)));
    process.stdout.write(`wrote ${CENSUS_PATH}: ${record.filesWithFindings} files, ${record.gatedFindings} gated findings\n`);
    return 0;
  }
  if (argv.includes("--verify")) {
    let committed = null;
    try {
      committed = readFileSync(join(root, CENSUS_PATH), "utf8");
    } catch {
      // reported below as out of date
    }
    if (committed === serialize(summarize(record))) {
      process.stdout.write(`identity census: ${CENSUS_PATH} is current\n`);
      return 0;
    }
    process.stderr.write(`identity census: ${CENSUS_PATH} is out of date; run node scripts/identity-census.mjs --write\n`);
    return 1;
  }
  if (argv.includes("--check")) {
    if (record.gatedFindings === 0) {
      process.stdout.write(`identity gate: no gated findings in ${record.filesScanned} files\n`);
      return 0;
    }
    for (const file of record.files) {
      for (const finding of file.findings) {
        if (!policy.gated.has(finding.category)) continue;
        process.stderr.write(`${file.path}:${finding.lines[0] ?? 0}: ${finding.term} (${finding.category}, rule ${finding.rule}, ${finding.count}x)\n`);
      }
    }
    process.stderr.write(`identity gate: ${record.gatedFindings} gated findings\n`);
    return 1;
  }
  process.stdout.write(serialize(record));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
