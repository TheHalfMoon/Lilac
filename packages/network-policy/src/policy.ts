import { isIP } from "node:net";
import { classifyAddress, isLoopbackAddress } from "./address.ts";
import { NetworkPolicyValidationError } from "./errors.ts";
import {
  NETWORK_CAPABILITIES,
  NETWORK_LIMITS,
  NETWORK_MODES,
  NETWORK_POLICY_SCHEMA_VERSION,
  URL_SCHEMES,
  type NetworkCapability,
  type NetworkGrant,
  type NetworkPolicy,
  type ResolvedDecision,
  type UrlDecision,
} from "./types.ts";
import { assertOneOf, assertRecord, assertStableId, inertCopy } from "./validation.ts";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`, "u");
const DEFAULT_PORT: Record<string, number> = { "https:": 443, "http:": 80 };
const MAX_RESOLVED = 64;

// Only decisions produced by evaluateUrl are honored by evaluateResolved; they are frozen,
// so a caller cannot forge or widen one.
const ISSUED = new WeakSet<object>();

function issue(decision: UrlDecision): UrlDecision {
  Object.freeze(decision);
  ISSUED.add(decision);
  return decision;
}

/** The policy every project starts with: no network at all. */
export function defaultNetworkPolicy(): NetworkPolicy {
  return { schemaVersion: NETWORK_POLICY_SCHEMA_VERSION, mode: "offline", grants: [] };
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || (isIP(host) !== 0 && isLoopbackAddress(host));
}

function normalizeHost(value: unknown, label: string): string {
  if (typeof value !== "string") throw new NetworkPolicyValidationError(`${label} must be a string`);
  const host = value.toLowerCase().replace(/^\[|\]$/gu, "");
  if (isIP(host) !== 0) {
    if (classifyAddress(host) === "unspecified") throw new NetworkPolicyValidationError(`${label} must not be an unspecified address`);
    return host;
  }
  const wildcard = host.startsWith("*.");
  const base = wildcard ? host.slice(2) : host;
  if (!HOSTNAME.test(base)) throw new NetworkPolicyValidationError(`${label} must be a hostname, *.suffix, or IP literal`);
  if (wildcard && (isIP(base) !== 0 || /^[0-9.]+$/u.test(base))) {
    throw new NetworkPolicyValidationError(`${label} wildcard must not cover numeric (IP-like) hosts`);
  }
  if (wildcard && base !== "localhost" && base.split(".").length < 2) {
    throw new NetworkPolicyValidationError(`${label} wildcard must cover a suffix with at least two labels`);
  }
  return host;
}

function normalizeGrant(value: unknown, index: number): NetworkGrant {
  const label = `policy.grants[${index}]`;
  assertRecord(value, label, ["id", "capability", "scheme", "host", "port", "allowPrivateNetwork", "purpose"]);
  assertStableId(value.id, `${label}.id`);
  assertOneOf(value.capability, NETWORK_CAPABILITIES, `${label}.capability`);
  assertOneOf(value.scheme, URL_SCHEMES, `${label}.scheme`);
  const host = normalizeHost(value.host, `${label}.host`);
  const port = value.port ?? null;
  if (port !== null && (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535)) {
    throw new NetworkPolicyValidationError(`${label}.port must be null or 1..65535`);
  }
  const allowPrivateNetwork = value.allowPrivateNetwork ?? false;
  if (typeof allowPrivateNetwork !== "boolean") throw new NetworkPolicyValidationError(`${label}.allowPrivateNetwork must be a boolean`);
  if (typeof value.purpose !== "string" || value.purpose.trim() === "" || value.purpose.length > NETWORK_LIMITS.maxPurposeLength) {
    throw new NetworkPolicyValidationError(`${label}.purpose must be a non-empty string of at most ${NETWORK_LIMITS.maxPurposeLength} characters`);
  }
  return { id: value.id, capability: value.capability, scheme: value.scheme, host, port: port as number | null, allowPrivateNetwork, purpose: value.purpose };
}

export function normalizeNetworkPolicy(input: unknown): NetworkPolicy {
  const value = inertCopy(input, "policy");
  assertRecord(value, "policy", ["schemaVersion", "mode", "grants"]);
  if (value.schemaVersion !== NETWORK_POLICY_SCHEMA_VERSION) throw new NetworkPolicyValidationError("policy.schemaVersion is unsupported");
  assertOneOf(value.mode, NETWORK_MODES, "policy.mode");
  const grantsInput = value.grants ?? [];
  if (!Array.isArray(grantsInput) || grantsInput.length > NETWORK_LIMITS.maxGrants) {
    throw new NetworkPolicyValidationError(`policy.grants must hold at most ${NETWORK_LIMITS.maxGrants} grants`);
  }
  const grants = grantsInput.map((grant, index) => normalizeGrant(grant, index));
  if (new Set(grants.map((grant) => grant.id)).size !== grants.length) throw new NetworkPolicyValidationError("policy grant ids must be distinct");
  if (value.mode !== "allowlist" && grants.length > 0) {
    throw new NetworkPolicyValidationError(`policy.mode ${value.mode} cannot carry grants; use allowlist`);
  }
  return { schemaVersion: NETWORK_POLICY_SCHEMA_VERSION, mode: value.mode, grants };
}

function hostMatches(grantHost: string, host: string): boolean {
  if (grantHost.startsWith("*.")) {
    // Wildcards cover DNS names only, never IP literals such as 192.168.1.1 under *.168.1.1.
    return isIP(host) === 0 && host.endsWith(grantHost.slice(1)) && host.length > grantHost.length - 1;
  }
  return grantHost === host;
}

function deny(capability: NetworkCapability | null, reason: string): UrlDecision {
  return issue({ allowed: false, capability, reason });
}

/**
 * Decide whether `url` may be contacted for `capability` before any DNS lookup. Allowed
 * decisions carry the constraints that `evaluateResolved` must then enforce on every
 * resolved address.
 */
export function evaluateUrl(policyInput: unknown, request: { capability: unknown; url: unknown }): UrlDecision {
  const policy = normalizeNetworkPolicy(policyInput);
  if (request === null || typeof request !== "object") throw new NetworkPolicyValidationError("request must be an object");
  const { capability, url: rawUrl } = request;
  assertOneOf(capability, NETWORK_CAPABILITIES, "request.capability");
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > NETWORK_LIMITS.maxUrlLength) {
    return deny(capability, "url must be a non-empty string within the length limit");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return deny(capability, "url is not valid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return deny(capability, "only http and https URLs are permitted");
  if (url.username !== "" || url.password !== "") return deny(capability, "urls with embedded credentials are refused");
  const host = url.hostname.toLowerCase().replace(/\.$/u, "").replace(/^\[|\]$/gu, "");
  const loopback = isLoopbackHost(host);

  if (policy.mode === "offline") return deny(capability, "network is disabled (offline mode)");
  if (isIP(host) !== 0 && classifyAddress(host) === "unspecified") return deny(capability, "unspecified addresses are never valid targets");
  if (policy.mode === "local-only") {
    if (!loopback) return deny(capability, "local-only mode permits loopback targets only");
    return issue({ allowed: true, capability, url: url.href, host, grantId: null, loopbackOnly: true, allowPrivateNetwork: false });
  }

  const port = url.port === "" ? DEFAULT_PORT[url.protocol] : Number(url.port);
  const scheme = url.protocol.slice(0, -1);
  const grant = policy.grants.find((candidate) =>
    candidate.capability === capability
    && candidate.scheme === scheme
    && (candidate.port ?? DEFAULT_PORT[url.protocol]) === port
    && hostMatches(candidate.host, host));
  if (!grant) return deny(capability, `no ${capability} grant covers ${scheme}://${host}:${port}`);

  const grantIsLoopback = isLoopbackHost(grant.host.replace(/^\*\./u, ""));
  if (loopback !== grantIsLoopback) return deny(capability, "loopback targets require an explicit loopback grant");
  if (!loopback && isIP(host) !== 0 && classifyAddress(host) === "forbidden" && !grant.allowPrivateNetwork) {
    return deny(capability, "private or reserved address targets require allowPrivateNetwork on the grant");
  }
  return issue({ allowed: true, capability, url: url.href, host, grantId: grant.id, loopbackOnly: loopback, allowPrivateNetwork: grant.allowPrivateNetwork });
}

/**
 * Check every address a name resolved to against an allowed URL decision. Must be called
 * with the addresses actually used to connect, so DNS rebinding cannot redirect an allowed
 * public name to loopback or a private network.
 */
export function evaluateResolved(decision: UrlDecision, addresses: unknown): ResolvedDecision {
  if (decision === null || typeof decision !== "object" || !ISSUED.has(decision)) {
    return { allowed: false, reason: "only decisions issued by evaluateUrl are accepted" };
  }
  if (decision.allowed !== true) return { allowed: false, reason: "the url decision did not allow this request" };
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > MAX_RESOLVED) {
    return { allowed: false, reason: `resolution must return 1..${MAX_RESOLVED} addresses` };
  }
  for (const address of addresses) {
    const kind = typeof address === "string" ? classifyAddress(address) : "invalid";
    if (kind === "invalid") return { allowed: false, reason: "resolution returned a non-IP value" };
    if (kind === "unspecified") return { allowed: false, reason: `target resolved to unspecified address ${address}` };
    if (decision.loopbackOnly === true) {
      if (kind !== "loopback") return { allowed: false, reason: `loopback target resolved to non-loopback address ${address}` };
      continue;
    }
    if (kind === "loopback") return { allowed: false, reason: `target resolved to loopback address ${address}` };
    if (kind === "forbidden" && decision.allowPrivateNetwork !== true) {
      return { allowed: false, reason: `target resolved to private or reserved address ${address}` };
    }
  }
  return { allowed: true };
}
