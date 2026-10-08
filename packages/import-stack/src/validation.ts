import { createHash } from "node:crypto";
import { defaultNetworkPolicy, normalizeNetworkPolicy, type NetworkPolicy } from "@ninerr/network-policy";
import { ImportValidationError } from "./errors.ts";
import {
  IMPORT_HARD_LIMITS,
  IMPORT_SCHEMA_VERSION,
  type ImportJsonValue,
  type ImportNetworkMode,
  type ImportPolicy,
  type ImportRequest,
  type ImportSourceIdentity,
  type SourceBinding,
} from "./types.ts";

const SOURCE_KINDS = new Set(["html-snapshot", "local-app", "remote-url", "document"]);
const MODES = new Set(["offline", "local-app", "remote"]);
const SENSITIVE_QUERY_KEYS = new Set([
  "apikey", "accesstoken", "refreshtoken", "token", "secret", "clientsecret",
  "password", "passwd", "authorization", "auth", "session", "sessionid",
  "signature", "sig", "xamzsignature", "xgoogsignature", "credential", "code",
]);

export function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportValidationError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ImportValidationError(`${label} must not be a class instance`);
  }
}

export function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) throw new ImportValidationError(`${label} contains unsupported field ${key}`);
  }
}

export function assertBoundedString(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ImportValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > max) throw new ImportValidationError(`${label} exceeds ${max} characters`);
}

export function assertTimestamp(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, 128);
  if (Number.isNaN(Date.parse(value))) throw new ImportValidationError(`${label} must be an ISO-compatible timestamp`);
}

function boundedInteger(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw new ImportValidationError(`${label} must be a positive safe integer <= ${max}`);
  }
  return value as number;
}

export function defaultImportPolicy(mode: ImportNetworkMode = "offline"): ImportPolicy {
  if (!MODES.has(mode)) throw new ImportValidationError("unsupported import network mode");
  return {
    mode,
    allowNetwork: mode !== "offline",
    allowLoopback: mode === "local-app",
    maxHtmlBytes: 2 * 1024 * 1024,
    maxDomNodes: 10_000,
    maxDomDepth: 128,
    maxTextBytes: 2 * 1024 * 1024,
    maxAttributesPerNode: 64,
    maxAttributeBytes: 16 * 1024,
    maxCssBytes: 1024 * 1024,
    maxAssets: 512,
    maxAssetBytes: 16 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    maxDiagnostics: 512,
    maxRedirects: 5,
    maxMirrorDepth: 4,
    maxWallClockMs: 5 * 60 * 1000,
    maxDocumentPages: 250,
    maxDocumentOutputBytes: 32 * 1024 * 1024,
  };
}

export function normalizeImportPolicy(value: unknown): ImportPolicy {
  assertPlainObject(value, "import.policy");
  assertAllowedKeys(value, Object.keys(defaultImportPolicy()), "import.policy");
  if (!MODES.has(value.mode as string)) throw new ImportValidationError("import.policy.mode is unsupported");
  if (typeof value.allowNetwork !== "boolean" || typeof value.allowLoopback !== "boolean") {
    throw new ImportValidationError("import policy network flags must be booleans");
  }
  const mode = value.mode as ImportNetworkMode;
  if (mode === "offline" && (value.allowNetwork || value.allowLoopback)) {
    throw new ImportValidationError("offline policy cannot enable network or loopback");
  }
  if (mode === "remote" && (!value.allowNetwork || value.allowLoopback)) {
    throw new ImportValidationError("remote policy requires network and forbids loopback");
  }
  if (mode === "local-app" && (!value.allowNetwork || !value.allowLoopback)) {
    throw new ImportValidationError("local-app policy requires explicit network and loopback capability");
  }
  return {
    mode,
    allowNetwork: value.allowNetwork,
    allowLoopback: value.allowLoopback,
    maxHtmlBytes: boundedInteger(value.maxHtmlBytes, "maxHtmlBytes", IMPORT_HARD_LIMITS.maxHtmlBytes),
    maxDomNodes: boundedInteger(value.maxDomNodes, "maxDomNodes", IMPORT_HARD_LIMITS.maxDomNodes),
    maxDomDepth: boundedInteger(value.maxDomDepth, "maxDomDepth", IMPORT_HARD_LIMITS.maxDomDepth),
    maxTextBytes: boundedInteger(value.maxTextBytes, "maxTextBytes", IMPORT_HARD_LIMITS.maxTextBytes),
    maxAttributesPerNode: boundedInteger(value.maxAttributesPerNode, "maxAttributesPerNode", IMPORT_HARD_LIMITS.maxAttributesPerNode),
    maxAttributeBytes: boundedInteger(value.maxAttributeBytes, "maxAttributeBytes", IMPORT_HARD_LIMITS.maxAttributeBytes),
    maxCssBytes: boundedInteger(value.maxCssBytes, "maxCssBytes", IMPORT_HARD_LIMITS.maxCssBytes),
    maxAssets: boundedInteger(value.maxAssets, "maxAssets", IMPORT_HARD_LIMITS.maxAssets),
    maxAssetBytes: boundedInteger(value.maxAssetBytes, "maxAssetBytes", IMPORT_HARD_LIMITS.maxAssetBytes),
    maxTotalBytes: boundedInteger(value.maxTotalBytes, "maxTotalBytes", IMPORT_HARD_LIMITS.maxTotalBytes),
    maxDiagnostics: boundedInteger(value.maxDiagnostics, "maxDiagnostics", IMPORT_HARD_LIMITS.maxDiagnostics),
    maxRedirects: boundedInteger(value.maxRedirects, "maxRedirects", IMPORT_HARD_LIMITS.maxRedirects),
    maxMirrorDepth: boundedInteger(value.maxMirrorDepth, "maxMirrorDepth", IMPORT_HARD_LIMITS.maxMirrorDepth),
    maxWallClockMs: boundedInteger(value.maxWallClockMs, "maxWallClockMs", IMPORT_HARD_LIMITS.maxWallClockMs),
    maxDocumentPages: boundedInteger(value.maxDocumentPages, "maxDocumentPages", IMPORT_HARD_LIMITS.maxDocumentPages),
    maxDocumentOutputBytes: boundedInteger(value.maxDocumentOutputBytes, "maxDocumentOutputBytes", IMPORT_HARD_LIMITS.maxDocumentOutputBytes),
  };
}

export function assertSafeProvenanceUrl(raw: string, label: string): void {
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.username || url.password) throw new ImportValidationError(`${label} must not embed credentials`);
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase().replace(/[-_.]/gu, "");
    if (SENSITIVE_QUERY_KEYS.has(normalized)) {
      throw new ImportValidationError(`${label} contains a secret-bearing query parameter`);
    }
  }
  if (url.hash.length > 1) {
    let fragmentText = url.hash.slice(1);
    try { fragmentText = decodeURIComponent(fragmentText); } catch {}
    for (const segment of fragmentText.split(/[?&;]/u)) {
      const equals = segment.indexOf("=");
      if (equals < 0) continue;
      const rawKey = segment.slice(0, equals).trim();
      const normalized = rawKey.toLowerCase().replace(/[-_.]/gu, "");
      if (SENSITIVE_QUERY_KEYS.has(normalized)) {
        throw new ImportValidationError(`${label} contains a secret-bearing URL fragment`);
      }
    }
  }
}

export function normalizeSourceIdentity(value: unknown): ImportSourceIdentity {
  assertPlainObject(value, "import.source");
  assertAllowedKeys(value, ["kind", "uri", "repositoryId", "repositoryPath", "baseUrl"], "import.source");
  if (!SOURCE_KINDS.has(value.kind as string)) throw new ImportValidationError("import.source.kind is unsupported");
  for (const key of ["uri", "repositoryId", "repositoryPath", "baseUrl"] as const) {
    if (value[key] !== undefined) assertBoundedString(value[key], `import.source.${key}`);
  }
  if (value.uri !== undefined) assertSafeProvenanceUrl(value.uri as string, "import.source.uri");
  if (value.baseUrl !== undefined) assertSafeProvenanceUrl(value.baseUrl as string, "import.source.baseUrl");
  if (value.repositoryPath !== undefined) {
    const path = value.repositoryPath as string;
    if (path.includes("\\") || path.startsWith("/") || /^[a-zA-Z]:/u.test(path) || path.split("/").includes("..")) {
      throw new ImportValidationError("import.source.repositoryPath must be a normalized repository-relative path");
    }
  }
  return {
    kind: value.kind as ImportSourceIdentity["kind"],
    ...(value.uri === undefined ? {} : { uri: value.uri as string }),
    ...(value.repositoryId === undefined ? {} : { repositoryId: value.repositoryId as string }),
    ...(value.repositoryPath === undefined ? {} : { repositoryPath: value.repositoryPath as string }),
    ...(value.baseUrl === undefined ? {} : { baseUrl: value.baseUrl as string }),
  };
}

export function normalizeImportRequest(value: unknown): ImportRequest {
  assertPlainObject(value, "import.request");
  assertAllowedKeys(value, ["schemaVersion", "requestId", "actorId", "intent", "at", "source", "policy", "networkPolicy"], "import.request");
  if (value.schemaVersion !== IMPORT_SCHEMA_VERSION) throw new ImportValidationError("unsupported import request schema version");
  assertBoundedString(value.requestId, "import.requestId", 256);
  assertBoundedString(value.actorId, "import.actorId", 256);
  assertBoundedString(value.intent, "import.intent", 2048);
  assertTimestamp(value.at, "import.at");
  // Own property only, and always set on the normalized request (default: offline), so no later
  // read of request.networkPolicy can fall through to a polluted prototype and inherit a grant.
  let networkPolicy: NetworkPolicy = defaultNetworkPolicy();
  if (Object.hasOwn(value, "networkPolicy") && value.networkPolicy !== undefined) {
    try {
      networkPolicy = normalizeNetworkPolicy(value.networkPolicy);
    } catch (error) {
      throw new ImportValidationError(`import.networkPolicy is invalid: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
    }
  }
  return {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    requestId: value.requestId,
    actorId: value.actorId,
    intent: value.intent,
    at: value.at,
    source: normalizeSourceIdentity(value.source),
    policy: normalizeImportPolicy(value.policy),
    networkPolicy,
  };
}

export function normalizeSourceBinding(value: unknown): SourceBinding {
  assertPlainObject(value, "sourceBinding");
  assertAllowedKeys(value, ["sourceUri", "domPath", "repositoryId", "path", "start", "end"], "sourceBinding");
  for (const key of ["sourceUri", "domPath", "repositoryId", "path"] as const) {
    if (value[key] !== undefined) assertBoundedString(value[key], `sourceBinding.${key}`, 4096);
  }
  if (value.sourceUri !== undefined) assertSafeProvenanceUrl(value.sourceUri as string, "sourceBinding.sourceUri");
  if (value.path !== undefined) {
    const path = value.path as string;
    if (path.includes("\\") || path.startsWith("/") || /^[a-zA-Z]:/u.test(path) || path.split("/").includes("..")) {
      throw new ImportValidationError("sourceBinding.path must be repository-relative and traversal-free");
    }
  }
  for (const key of ["start", "end"] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) {
      throw new ImportValidationError(`sourceBinding.${key} must be a non-negative safe integer`);
    }
  }
  if (value.start !== undefined && value.end !== undefined && (value.end as number) < (value.start as number)) {
    throw new ImportValidationError("sourceBinding.end must be >= sourceBinding.start");
  }
  return {
    ...(value.sourceUri === undefined ? {} : { sourceUri: value.sourceUri as string }),
    ...(value.domPath === undefined ? {} : { domPath: value.domPath as string }),
    ...(value.repositoryId === undefined ? {} : { repositoryId: value.repositoryId as string }),
    ...(value.path === undefined ? {} : { path: value.path as string }),
    ...(value.start === undefined ? {} : { start: value.start as number }),
    ...(value.end === undefined ? {} : { end: value.end as number }),
  };
}

export function normalizeImportJson(value: unknown, label = "value", depth = 0, seen = new Set<object>()): ImportJsonValue {
  if (depth > 128) throw new ImportValidationError(`${label} exceeds maximum JSON depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ImportValidationError(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") throw new ImportValidationError(`${label} must be JSON-serializable`);
  if (seen.has(value)) throw new ImportValidationError(`${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => normalizeImportJson(entry, `${label}[${index}]`, depth + 1, seen));
    }
    assertPlainObject(value, label);
    const result: Record<string, ImportJsonValue> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) {
        throw new ImportValidationError(`${label}.${key} must be an own defined data value`);
      }
      result[key] = normalizeImportJson(descriptor.value, `${label}.${key}`, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function canonicalImportStringify(value: unknown): string {
  return JSON.stringify(normalizeImportJson(value));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Code-unit string order: unlike localeCompare, independent of the process locale. */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
