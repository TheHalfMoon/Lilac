import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";

import { validateDocument } from "@lilac/document-model";
import { classifyAddress } from "@lilac/network-policy";

import { DesignAssuranceError } from "./errors.mjs";
import { compareCodeUnits } from "./order.mjs";

export const DESIGN_ASSURANCE_SCHEMA_VERSION = 1;
export const IMPECCABLE_PIN = Object.freeze({
  repository: "pbakaus/impeccable",
  revision: "e103efe779e2dd01274dabae83531fef00bf2563",
  packageName: "impeccable",
  packageVersion: "4.1.0",
  sourceEngineVersion: "0.1.11",
  engineVersion: "0.1.5",
  license: "Apache-2.0",
});

const require = createRequire(import.meta.url);
const VALID_SEVERITIES = new Set(["error", "warning", "info"]);
const SEVERITY_RANK = Object.freeze({ info: 0, warning: 1, error: 2 });
const MAX_INLINE_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const MAX_ENGINE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_ELEMENTS = 50_000;
const SCANNABLE_SOURCE_EXTENSIONS = Object.freeze([
  ".blade.php",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".jsx",
  ".tsx",
  ".js",
  ".ts",
  ".vue",
  ".svelte",
  ".astro",
]);

export { DesignAssuranceError };
export * from "./accessibility.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonData(value, label) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("value is not JSON-serializable");
    }
    return JSON.parse(serialized);
  } catch (error) {
    throw new DesignAssuranceError(`${label} must be JSON-serializable`, { cause: error });
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DesignAssuranceError(`${label} must be a non-empty string`);
  }
}

function assertInlineText(value, label) {
  if (typeof value !== "string") {
    throw new DesignAssuranceError(`${label} must be a string`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_INLINE_INPUT_BYTES) {
    throw new DesignAssuranceError(`${label} exceeds ${MAX_INLINE_INPUT_BYTES} bytes`);
  }
}

function normalizedSeverity(value) {
  if (value === "error") return "error";
  if (value === "advisory" || value === "info") return "info";
  return "warning";
}

function stableLocationKey(location) {
  return [
    location?.path ?? "",
    location?.url ?? "",
    location?.nodeId ?? "",
    Number.isFinite(location?.line) ? location.line : -1,
    Number.isFinite(location?.column) ? location.column : -1,
  ].join("\u0000");
}

function compareFindings(left, right) {
  const severityDelta = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
  if (severityDelta !== 0) return severityDelta;
  return compareCodeUnits(left.ruleId, right.ruleId)
    || compareCodeUnits(stableLocationKey(left.location), stableLocationKey(right.location))
    || compareCodeUnits(left.message, right.message)
    || compareCodeUnits(JSON.stringify(left.evidence), JSON.stringify(right.evidence));
}

function dedupeAndSort(findings) {
  const seen = new Set();
  const result = [];
  for (const finding of findings) {
    const key = JSON.stringify([
      finding.ruleId,
      finding.surface,
      finding.severity,
      finding.message,
      finding.location ?? null,
      finding.evidence ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result.sort(compareFindings);
}

function upstreamProvenance() {
  return {
    source: "impeccable",
    repository: IMPECCABLE_PIN.repository,
    revision: IMPECCABLE_PIN.revision,
    package: IMPECCABLE_PIN.packageName,
    packageVersion: IMPECCABLE_PIN.packageVersion,
    engineVersion: IMPECCABLE_PIN.engineVersion,
    license: IMPECCABLE_PIN.license,
  };
}

function localProvenance(namespace) {
  return {
    source: "lilac-rule-pack",
    namespace,
    schemaVersion: DESIGN_ASSURANCE_SCHEMA_VERSION,
  };
}

export function normalizeImpeccableFinding(raw, {
  surface,
  virtualPath = null,
  url = null,
} = {}) {
  if (!isPlainObject(raw)) {
    throw new DesignAssuranceError("Impeccable finding must be an object");
  }
  assertNonEmptyString(raw.antipattern, "Impeccable finding.antipattern");
  assertNonEmptyString(surface, "surface");

  const severity = normalizedSeverity(raw.severity);
  const line = Number.isFinite(Number(raw.line)) ? Number(raw.line) : 0;
  const path = virtualPath ?? (typeof raw.file === "string" && !/^https?:\/\//i.test(raw.file)
    ? raw.file
    : null);
  const resolvedUrl = url ?? (typeof raw.file === "string" && /^https?:\/\//i.test(raw.file)
    ? raw.file
    : null);
  const name = typeof raw.name === "string" && raw.name.trim() !== ""
    ? raw.name.trim()
    : raw.antipattern;
  const description = typeof raw.description === "string" ? raw.description : "";
  const snippet = typeof raw.snippet === "string" ? raw.snippet : "";

  return {
    ruleId: `impeccable/${raw.antipattern}`,
    upstreamRuleId: raw.antipattern,
    surface,
    severity,
    originalSeverity: typeof raw.severity === "string" ? raw.severity : "warning",
    invariant: false,
    message: name,
    description,
    evidence: {
      snippet,
      category: typeof raw.category === "string" ? raw.category : null,
    },
    location: {
      path,
      url: resolvedUrl,
      line,
      column: null,
      nodeId: null,
    },
    fixability: "manual",
    provenance: upstreamProvenance(),
  };
}

function validateRule(rule, namespace) {
  if (!isPlainObject(rule)) {
    throw new DesignAssuranceError(`Rule in ${namespace} must be an object`);
  }
  assertNonEmptyString(rule.id, `Rule id in ${namespace}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(rule.id)) {
    throw new DesignAssuranceError(`Rule id ${rule.id} must use lowercase letters, numbers, and hyphens`);
  }
  assertNonEmptyString(rule.title, `Rule ${namespace}/${rule.id}.title`);
  if (!VALID_SEVERITIES.has(rule.severity)) {
    throw new DesignAssuranceError(`Rule ${namespace}/${rule.id} has invalid severity`);
  }
  if (!Array.isArray(rule.surfaces) || rule.surfaces.length === 0) {
    throw new DesignAssuranceError(`Rule ${namespace}/${rule.id}.surfaces must be a non-empty array`);
  }
  if (typeof rule.check !== "function") {
    throw new DesignAssuranceError(`Rule ${namespace}/${rule.id}.check must be a function`);
  }
}

export function createLilacRulePack({ namespace, rules }) {
  assertNonEmptyString(namespace, "rule pack namespace");
  if (!/^[a-z][a-z0-9-]*$/.test(namespace)) {
    throw new DesignAssuranceError("rule pack namespace must be lowercase kebab-case");
  }
  if (namespace === "impeccable") {
    throw new DesignAssuranceError("rule pack namespace impeccable is reserved for upstream findings");
  }
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new DesignAssuranceError("rule pack rules must be a non-empty array");
  }

  const ids = new Set();
  for (const rule of rules) {
    validateRule(rule, namespace);
    const fullId = `${namespace}/${rule.id}`;
    if (ids.has(fullId)) {
      throw new DesignAssuranceError(`duplicate rule id ${fullId}`);
    }
    ids.add(fullId);
  }

  return Object.freeze({
    namespace,
    rules: Object.freeze([...rules].sort((a, b) => compareCodeUnits(a.id, b.id))),
  });
}

function localFinding(rulePack, rule, partial, context) {
  if (!isPlainObject(partial)) {
    throw new DesignAssuranceError(`Rule ${rulePack.namespace}/${rule.id} returned a non-object finding`);
  }
  const location = isPlainObject(partial.location) ? partial.location : {};
  const message = typeof partial.message === "string" && partial.message.trim() !== ""
    ? partial.message.trim()
    : rule.title;
  return {
    ruleId: `${rulePack.namespace}/${rule.id}`,
    upstreamRuleId: null,
    surface: context.surface,
    severity: rule.severity,
    originalSeverity: rule.severity,
    invariant: rule.invariant === true,
    message,
    description: typeof partial.description === "string" ? partial.description : (rule.description ?? ""),
    evidence: isPlainObject(partial.evidence)
      ? cloneJsonData(partial.evidence, `Rule ${rulePack.namespace}/${rule.id} evidence`)
      : {},
    location: {
      path: typeof location.path === "string" ? location.path : (context.path ?? null),
      url: typeof location.url === "string" ? location.url : (context.url ?? null),
      line: Number.isFinite(location.line) ? location.line : null,
      column: Number.isFinite(location.column) ? location.column : null,
      nodeId: typeof location.nodeId === "string" ? location.nodeId : null,
    },
    fixability: partial.fixability === "automatic" ? "automatic" : "manual",
    provenance: localProvenance(rulePack.namespace),
  };
}

function runRulePacks(context, rulePacks) {
  const findings = [];
  const fullIds = new Set();
  const orderedPacks = [...rulePacks].sort((a, b) => compareCodeUnits(String(a?.namespace), String(b?.namespace)));
  for (const pack of orderedPacks) {
    if (!isPlainObject(pack) || !Array.isArray(pack.rules)) {
      throw new DesignAssuranceError("Invalid Lilac rule pack");
    }
    assertNonEmptyString(pack.namespace, "rule pack namespace");
    if (!/^[a-z][a-z0-9-]*$/.test(pack.namespace) || pack.namespace === "impeccable") {
      throw new DesignAssuranceError(`Invalid or reserved rule pack namespace ${pack.namespace}`);
    }
    for (const rule of pack.rules) {
      validateRule(rule, pack.namespace);
      const fullId = `${pack.namespace}/${rule.id}`;
      if (fullIds.has(fullId)) {
        throw new DesignAssuranceError(`rule id collision ${fullId}`);
      }
      fullIds.add(fullId);
      if (!rule.surfaces.includes(context.surface)) continue;
      const result = rule.check(context);
      if (!Array.isArray(result)) {
        throw new DesignAssuranceError(`Rule ${fullId} must return an array`);
      }
      findings.push(...result.map((partial) => localFinding(pack, rule, partial, context)));
    }
  }
  return findings;
}

function validatePolicy(policy) {
  if (policy === undefined || policy === null) return {
    disabledRules: [],
    severityOverrides: {},
    waivers: [],
  };
  if (!isPlainObject(policy)) throw new DesignAssuranceError("policy must be an object");
  const disabledRules = policy.disabledRules ?? [];
  const severityOverrides = policy.severityOverrides ?? {};
  const waivers = policy.waivers ?? [];
  if (!Array.isArray(disabledRules) || disabledRules.some((id) => typeof id !== "string")) {
    throw new DesignAssuranceError("policy.disabledRules must be an array of rule ids");
  }
  if (!isPlainObject(severityOverrides)) {
    throw new DesignAssuranceError("policy.severityOverrides must be an object");
  }
  for (const [ruleId, severity] of Object.entries(severityOverrides)) {
    assertNonEmptyString(ruleId, "severity override rule id");
    if (!VALID_SEVERITIES.has(severity)) {
      throw new DesignAssuranceError(`Invalid severity override for ${ruleId}`);
    }
  }
  if (!Array.isArray(waivers)) {
    throw new DesignAssuranceError("policy.waivers must be an array");
  }
  for (const waiver of waivers) {
    if (!isPlainObject(waiver)) throw new DesignAssuranceError("waiver must be an object");
    assertNonEmptyString(waiver.ruleId, "waiver.ruleId");
    assertNonEmptyString(waiver.reason, "waiver.reason");
  }
  return { disabledRules, severityOverrides, waivers };
}

function applyPolicy(findings, policyInput) {
  const policy = validatePolicy(policyInput);
  const disabled = new Set(policy.disabledRules);
  const waiversByRule = new Map(policy.waivers.map((waiver) => [waiver.ruleId, waiver]));

  return findings.map((finding) => {
    const next = structuredClone(finding);
    const changes = {};

    if (disabled.has(finding.ruleId)) {
      if (finding.invariant) {
        throw new DesignAssuranceError(`Invariant rule ${finding.ruleId} cannot be disabled`);
      }
      changes.suppressed = true;
      changes.reason = "disabled-rule";
    }

    const severityOverride = policy.severityOverrides[finding.ruleId];
    if (severityOverride) {
      if (finding.invariant && SEVERITY_RANK[severityOverride] < SEVERITY_RANK[finding.severity]) {
        throw new DesignAssuranceError(`Invariant rule ${finding.ruleId} cannot be severity-downgraded`);
      }
      next.severity = severityOverride;
      changes.severityOverride = severityOverride;
    }

    const waiver = waiversByRule.get(finding.ruleId);
    if (waiver) {
      if (finding.invariant && waiver.acknowledgeInvariant !== true) {
        throw new DesignAssuranceError(
          `Invariant waiver for ${finding.ruleId} requires acknowledgeInvariant: true`,
        );
      }
      changes.waived = true;
      changes.waiverReason = waiver.reason;
      changes.acknowledgeInvariant = waiver.acknowledgeInvariant === true;
    }

    if (Object.keys(changes).length > 0) next.policy = changes;
    return next;
  });
}

function summarize(findings) {
  const summary = {
    total: findings.length,
    active: 0,
    waived: 0,
    suppressed: 0,
    bySeverity: { error: 0, warning: 0, info: 0 },
  };
  for (const finding of findings) {
    if (finding.policy?.suppressed) {
      summary.suppressed += 1;
      continue;
    }
    if (finding.policy?.waived) {
      summary.waived += 1;
      continue;
    }
    summary.active += 1;
    summary.bySeverity[finding.severity] += 1;
  }
  return summary;
}

function buildReport({ surface, subject, findings, policy, rulePacks }) {
  const normalized = dedupeAndSort(findings);
  const governed = applyPolicy(normalized, policy);
  const finalFindings = dedupeAndSort(governed);
  return {
    schemaVersion: DESIGN_ASSURANCE_SCHEMA_VERSION,
    surface,
    subject: structuredClone(subject),
    findings: finalFindings,
    summary: summarize(finalFindings),
    rulePacks: [...new Set(rulePacks.map((pack) => pack.namespace))].sort(),
    upstream: structuredClone(IMPECCABLE_PIN),
  };
}

function resolveImpeccableCli() {
  const packagePath = require.resolve("impeccable/package.json");
  return join(dirname(packagePath), "cli", "bin", "cli.js");
}

function runProcess(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const append = (kind, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_ENGINE_OUTPUT_BYTES) {
        child.kill();
        finish(new DesignAssuranceError("Impeccable output exceeded safety limit"));
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error) => finish(new DesignAssuranceError(
      `Unable to start Impeccable: ${error.message}`,
      { cause: error },
    )));
    child.once("close", (code, signal) => finish(null, { code, signal, stdout, stderr }));

    const timer = setTimeout(() => {
      child.kill();
      finish(new DesignAssuranceError(`Impeccable scan exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}

function parseEngineJson(stdout) {
  if (stdout.trim() === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new DesignAssuranceError("Impeccable returned invalid JSON", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new DesignAssuranceError("Impeccable JSON output must be an array");
  }
  return parsed;
}

export function createImpeccableCliRunner({
  cwd = process.cwd(),
  cliPath = resolveImpeccableCli(),
  nodePath = process.execPath,
  timeoutMs = 30_000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new DesignAssuranceError("timeoutMs must be a positive safe integer");
  }
  return Object.freeze({
    async scanTarget(target, { viewport = null, scopes = [] } = {}) {
      assertNonEmptyString(target, "scan target");
      // The pinned engine keeps parsing options after "--", so a target that
      // starts with "-" would become an option; such targets are refused.
      if (target.startsWith("-")) throw new DesignAssuranceError("scan target must not start with '-'");
      if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
        throw new DesignAssuranceError("scopes must be an array of strings");
      }
      const args = [cliPath, "detect", "--json", "--no-config"];
      if (viewport !== null) {
        if (!isPlainObject(viewport)
          || !Number.isSafeInteger(viewport.width)
          || !Number.isSafeInteger(viewport.height)
          || viewport.width <= 0
          || viewport.height <= 0) {
          throw new DesignAssuranceError("viewport must contain positive integer width and height");
        }
        args.push("--viewport", `${viewport.width}x${viewport.height}`);
      }
      if (scopes.length > 0) args.push("--scope", scopes.join(","));
      args.push(target);
      const result = await runProcess(nodePath, args, { cwd, timeoutMs });
      if (result.code !== 0 && result.code !== 2) {
        const detail = result.stderr.trim() || `exit ${String(result.code)} signal ${String(result.signal)}`;
        throw new DesignAssuranceError(`Impeccable scan failed: ${detail}`);
      }
      return {
        findings: parseEngineJson(result.stdout),
        exitCode: result.code,
        stderr: result.stderr,
      };
    },
  });
}

function sourceExtension(filePath) {
  assertNonEmptyString(filePath, "filePath");
  const lower = filePath.toLowerCase();
  const extension = SCANNABLE_SOURCE_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  if (!extension) {
    throw new DesignAssuranceError(`Unsupported source extension ${extname(filePath).toLowerCase() || "<none>"}`);
  }
  return extension;
}

async function withTempInput(content, extension, callback) {
  const directory = await mkdtemp(join(tmpdir(), "lilac-design-assurance-"));
  const target = join(directory, `input${extension}`);
  try {
    await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    return await callback(target);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function normalizeUpstream(findings, options) {
  if (!Array.isArray(findings)) {
    throw new DesignAssuranceError("runner findings must be an array");
  }
  return findings.map((finding) => normalizeImpeccableFinding(finding, options));
}

function defaultRulePacks(rulePacks) {
  if (rulePacks === undefined) return [LILAC_CORE_RULE_PACK];
  if (!Array.isArray(rulePacks)) throw new DesignAssuranceError("rulePacks must be an array");
  return rulePacks;
}

export async function scanSourceText({
  content,
  filePath = "input.tsx",
  runner = createImpeccableCliRunner(),
  rulePacks,
  policy,
} = {}) {
  assertInlineText(content, "content");
  const extension = sourceExtension(filePath);
  const packs = defaultRulePacks(rulePacks);
  const upstream = await withTempInput(content, extension, (target) => runner.scanTarget(target));
  const context = { surface: "source", path: filePath, content };
  const findings = [
    ...normalizeUpstream(upstream.findings, { surface: "source", virtualPath: filePath }),
    ...runRulePacks(context, packs),
  ];
  return buildReport({
    surface: "source",
    subject: { kind: "source", path: filePath, name: basename(filePath) },
    findings,
    policy,
    rulePacks: packs,
  });
}

export async function scanStaticHtml({
  html,
  filePath = "input.html",
  runner = createImpeccableCliRunner(),
  rulePacks,
  policy,
} = {}) {
  assertInlineText(html, "html");
  const packs = defaultRulePacks(rulePacks);
  const upstream = await withTempInput(html, ".html", (target) => runner.scanTarget(target));
  const context = { surface: "static-html", path: filePath, html };
  const findings = [
    ...normalizeUpstream(upstream.findings, { surface: "static-html", virtualPath: filePath }),
    ...runRulePacks(context, packs),
  ];
  return buildReport({
    surface: "static-html",
    subject: { kind: "static-html", path: filePath, name: basename(filePath) },
    findings,
    policy,
    rulePacks: packs,
  });
}

// Address classification is owned by @lilac/network-policy; only "public" passes.
function isPrivateBrowserHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const literal = host.replace(/^\[|\]$/gu, "");
  return isIP(literal) !== 0 && classifyAddress(literal) !== "public";
}

function validateBrowserUrl(value, { allowPrivateNetwork = false } = {}) {
  assertNonEmptyString(value, "url");
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new DesignAssuranceError("url must be a valid absolute URL", { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DesignAssuranceError("browser scans support only http and https URLs");
  }
  if (parsed.username || parsed.password) {
    throw new DesignAssuranceError("browser scan URLs must not contain credentials");
  }
  if (isPrivateBrowserHost(parsed.hostname) && !allowPrivateNetwork) {
    throw new DesignAssuranceError("private-network browser scans require allowPrivateNetwork: true");
  }
  return parsed;
}

// A DNS name is resolved before the scan and refused unless every answer is public.
// The browser resolves again when it fetches and follows redirects and loads
// subresources itself, so this blocks targets that are private at scan time; it
// cannot prevent DNS rebinding, redirects or subresource loads to private hosts.
// Those residuals are recorded in the P06 G5a evidence (#112) and tracked in #114.
async function assertPublicResolution(hostname, lookup) {
  const host = hostname.replace(/^\[|\]$/gu, "");
  if (isIP(host) !== 0) return;
  let answers;
  try {
    answers = await lookup(host.replace(/\.$/u, ""), { all: true, verbatim: true });
  } catch (error) {
    throw new DesignAssuranceError("browser scan host could not be resolved", { cause: error });
  }
  const addresses = (Array.isArray(answers) ? answers : [answers]).map((answer) => (typeof answer === "string" ? answer : answer?.address));
  if (addresses.length === 0 || addresses.some((address) => typeof address !== "string" || classifyAddress(address) !== "public")) {
    throw new DesignAssuranceError("browser scan host resolves to a non-public address; private-network scans require allowPrivateNetwork: true");
  }
}

export async function scanBrowserUrl({
  url,
  viewport = null,
  allowPrivateNetwork = false,
  runner = createImpeccableCliRunner(),
  lookup = dnsLookup,
  rulePacks,
  policy,
} = {}) {
  // Only an explicit true opts in; "false", 1 or {} must not.
  const privateAllowed = allowPrivateNetwork === true;
  const parsed = validateBrowserUrl(url, { allowPrivateNetwork: privateAllowed });
  if (!privateAllowed) await assertPublicResolution(parsed.hostname, lookup);
  const normalizedUrl = parsed.toString();
  const packs = defaultRulePacks(rulePacks);
  const upstream = await runner.scanTarget(normalizedUrl, { viewport });
  const context = { surface: "browser", url: normalizedUrl, viewport };
  const findings = [
    ...normalizeUpstream(upstream.findings, { surface: "browser", url: normalizedUrl }),
    ...runRulePacks(context, packs),
  ];
  return buildReport({
    surface: "browser",
    subject: { kind: "browser", url: normalizedUrl, viewport },
    findings,
    policy,
    rulePacks: packs,
  });
}

function validateSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    throw new DesignAssuranceError("snapshot must be a plain object");
  }
  let serialized;
  try {
    serialized = JSON.stringify(snapshot);
  } catch (error) {
    throw new DesignAssuranceError("snapshot must be JSON-serializable", { cause: error });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new DesignAssuranceError(`snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  }
  if (snapshot.elements !== undefined) {
    if (!Array.isArray(snapshot.elements)) {
      throw new DesignAssuranceError("snapshot.elements must be an array when present");
    }
    if (snapshot.elements.length > MAX_SNAPSHOT_ELEMENTS) {
      throw new DesignAssuranceError(`snapshot.elements exceeds ${MAX_SNAPSHOT_ELEMENTS} entries`);
    }
  }
}

export async function scanBrowserSnapshot({
  snapshot,
  upstreamFindings = [],
  runner = null,
  subject = { kind: "browser-snapshot" },
  rulePacks,
  policy,
} = {}) {
  validateSnapshot(snapshot);
  const packs = defaultRulePacks(rulePacks);
  let resolvedUpstream = upstreamFindings;
  if (runner?.scanSnapshot) {
    const result = await runner.scanSnapshot(structuredClone(snapshot));
    resolvedUpstream = result.findings;
  }
  if (!Array.isArray(resolvedUpstream)) {
    throw new DesignAssuranceError("upstreamFindings must be an array");
  }
  const context = { surface: "browser-snapshot", snapshot };
  const findings = [
    ...normalizeUpstream(resolvedUpstream, { surface: "browser-snapshot" }),
    ...runRulePacks(context, packs),
  ];
  return buildReport({
    surface: "browser-snapshot",
    subject,
    findings,
    policy,
    rulePacks: packs,
  });
}

function sortedNodes(document, type) {
  return Object.values(document.nodes)
    .filter((node) => node.type === type)
    .sort((a, b) => compareCodeUnits(a.id, b.id));
}

function sourceRegistry(document) {
  const sources = document.metadata?.sources;
  return isPlainObject(sources) ? sources : null;
}

function tokenRegistry(document) {
  const designSystem = document.metadata?.designSystem;
  if (designSystem === undefined) return null;
  if (!isPlainObject(designSystem)) return "INVALID";
  const tokens = designSystem.tokens;
  if (tokens === undefined) return null;
  return isPlainObject(tokens) ? tokens : "INVALID";
}

export const LILAC_CORE_RULE_PACK = createLilacRulePack({
  namespace: "lilac",
  rules: [
    {
      id: "source-binding-source-id",
      title: "Source binding must identify its source",
      description: "Every source-binding node must carry a non-empty props.sourceId and resolve it when a source registry is present.",
      severity: "error",
      invariant: true,
      surfaces: ["document"],
      check({ document }) {
        const registry = sourceRegistry(document);
        const findings = [];
        for (const node of sortedNodes(document, "source-binding")) {
          const sourceId = node.props?.sourceId;
          if (typeof sourceId !== "string" || sourceId.trim() === "") {
            findings.push({
              message: `Source binding ${node.id} has no sourceId`,
              location: { nodeId: node.id },
              evidence: { sourceId: sourceId ?? null },
            });
          } else if (registry && !Object.hasOwn(registry, sourceId)) {
            findings.push({
              message: `Source binding ${node.id} references unknown source ${sourceId}`,
              location: { nodeId: node.id },
              evidence: { sourceId },
            });
          }
        }
        return findings;
      },
    },
    {
      id: "source-binding-target",
      title: "Source binding target must resolve",
      description: "A source binding must identify an existing non-self target node through props.targetNodeId.",
      severity: "error",
      invariant: true,
      surfaces: ["document"],
      check({ document }) {
        const findings = [];
        for (const node of sortedNodes(document, "source-binding")) {
          const targetNodeId = node.props?.targetNodeId;
          if (typeof targetNodeId !== "string" || targetNodeId.trim() === "") {
            findings.push({
              message: `Source binding ${node.id} has no targetNodeId`,
              location: { nodeId: node.id },
              evidence: { targetNodeId: targetNodeId ?? null },
            });
          } else if (targetNodeId === node.id || !document.nodes[targetNodeId]) {
            findings.push({
              message: `Source binding ${node.id} targets invalid node ${targetNodeId}`,
              location: { nodeId: node.id },
              evidence: { targetNodeId },
            });
          }
        }
        return findings;
      },
    },
    {
      id: "source-binding-range",
      title: "Source binding range must be valid",
      description: "When present, props.range must contain safe integer start/end offsets with 0 <= start <= end.",
      severity: "error",
      invariant: true,
      surfaces: ["document"],
      check({ document }) {
        const findings = [];
        for (const node of sortedNodes(document, "source-binding")) {
          const range = node.props?.range;
          if (range === undefined) continue;
          const valid = isPlainObject(range)
            && Number.isSafeInteger(range.start)
            && Number.isSafeInteger(range.end)
            && range.start >= 0
            && range.end >= range.start;
          if (!valid) {
            findings.push({
              message: `Source binding ${node.id} has an invalid source range`,
              location: { nodeId: node.id },
              evidence: {
                range: isPlainObject(range)
                  ? {
                      start: Number.isSafeInteger(range.start) ? range.start : null,
                      end: Number.isSafeInteger(range.end) ? range.end : null,
                    }
                  : { valueType: Array.isArray(range) ? "array" : typeof range },
              },
            });
          }
        }
        return findings;
      },
    },
    {
      id: "design-token-registry",
      title: "Design token registry must be an object",
      description: "document.metadata.designSystem.tokens must be a plain object when declared.",
      severity: "error",
      invariant: true,
      surfaces: ["document"],
      check({ document }) {
        return tokenRegistry(document) === "INVALID"
          ? [{
              message: "Document design-system token registry is malformed",
              evidence: { expected: "plain object" },
            }]
          : [];
      },
    },
    {
      id: "token-reference-resolution",
      title: "Token references must resolve",
      description: "Every token-reference node must carry props.tokenId and resolve it against document.metadata.designSystem.tokens.",
      severity: "error",
      invariant: true,
      surfaces: ["document"],
      check({ document }) {
        const registry = tokenRegistry(document);
        const findings = [];
        for (const node of sortedNodes(document, "token-reference")) {
          const tokenId = node.props?.tokenId;
          if (typeof tokenId !== "string" || tokenId.trim() === "") {
            findings.push({
              message: `Token reference ${node.id} has no tokenId`,
              location: { nodeId: node.id },
              evidence: { tokenId: tokenId ?? null },
            });
            continue;
          }
          if (registry === null) {
            findings.push({
              message: `Token reference ${node.id} cannot resolve ${tokenId} because no token registry is declared`,
              location: { nodeId: node.id },
              evidence: { tokenId },
            });
          } else if (registry !== "INVALID" && !Object.hasOwn(registry, tokenId)) {
            findings.push({
              message: `Token reference ${node.id} references unknown token ${tokenId}`,
              location: { nodeId: node.id },
              evidence: { tokenId },
            });
          }
        }
        return findings;
      },
    },
  ],
});

export function scanDocument({
  document,
  rulePacks,
  policy,
} = {}) {
  validateDocument(document);
  const packs = defaultRulePacks(rulePacks);
  const context = { surface: "document", document };
  const findings = runRulePacks(context, packs);
  return buildReport({
    surface: "document",
    subject: { kind: "document", id: document.id, revision: document.revision },
    findings,
    policy,
    rulePacks: packs,
  });
}
