#!/usr/bin/env node
// Identity census and independence gate (N0.1, N0.9). Scans every tracked file's path and
// text for the terms in scripts/identity-policy.json, classifies each finding by the first
// matching rule, and reports per file. The output depends only on tracked content, so two
// runs over the same tree produce identical bytes.
//
//   node scripts/identity-census.mjs            print the census JSON
//   node scripts/identity-census.mjs --write    write docs/evidence/N0_IDENTITY_CENSUS.json
//   node scripts/identity-census.mjs --check    fail on any finding in a gated category
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const CENSUS_PATH = "docs/evidence/N0_IDENTITY_CENSUS.json";
const MAX_LINES_LISTED = 50;

export function loadPolicy(text = readFileSync(join(ROOT, "scripts/identity-policy.json"), "utf8")) {
  const policy = JSON.parse(text);
  const terms = Object.entries(policy.terms).map(([id, source]) => ({ id, pattern: new RegExp(source, "iu") }));
  const categories = new Set(Object.keys(policy.categories));
  const rules = policy.rules.map((rule) => {
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
  const ids = new Set(rules.map((rule) => rule.id));
  if (ids.size !== rules.length) throw new Error("rule ids must be unique");
  const last = rules.at(-1);
  if (!last || last.path || last.terms || last.line) throw new Error("the last rule must match every finding");
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

function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    // The census artifact is the output; scanning it would make the output depend on itself.
    .split("\0").filter((path) => path !== "" && path !== CENSUS_PATH).sort();
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
      const sorted = [...findings.values()].sort((a, b) => a.term.localeCompare(b.term) || a.rule.localeCompare(b.rule));
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

function main(argv) {
  const policy = loadPolicy();
  const record = census(policy);
  if (argv.includes("--write")) {
    writeFileSync(join(ROOT, CENSUS_PATH), serialize(record));
    process.stdout.write(`wrote ${CENSUS_PATH}: ${record.filesWithFindings} files, ${record.gatedFindings} gated findings\n`);
    return 0;
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
