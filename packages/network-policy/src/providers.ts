import { isIP } from "node:net";
import { isLoopbackAddress } from "./address.ts";
import { NetworkPolicyValidationError } from "./errors.ts";
import { evaluateUrl, normalizeNetworkPolicy } from "./policy.ts";
import {
  CREDENTIAL_STORES,
  NETWORK_LIMITS,
  NETWORK_POLICY_SCHEMA_VERSION,
  PROVIDER_CAPABILITIES,
  PROVIDER_KINDS,
  type CredentialRef,
  type ProviderCapability,
  type ProviderDescriptor,
  type ProviderRegistry,
  type ProviderResolution,
} from "./types.ts";
import { assertOneOf, assertRecord, assertStableId, inertCopy } from "./validation.ts";

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

function normalizeCredentialRef(value: unknown, label: string): CredentialRef | null {
  if (value === undefined || value === null) return null;
  assertRecord(value, label, ["store", "name"]);
  assertOneOf(value.store, CREDENTIAL_STORES, `${label}.store`);
  if (value.store === "env") {
    if (typeof value.name !== "string" || !ENV_NAME.test(value.name)) {
      throw new NetworkPolicyValidationError(`${label}.name must be an environment variable name`);
    }
  } else {
    assertStableId(value.name, `${label}.name`);
  }
  return { store: value.store, name: value.name as string };
}

function endpointHost(endpoint: string, label: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new NetworkPolicyValidationError(`${label} is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new NetworkPolicyValidationError(`${label} must be http or https`);
  if (url.username !== "" || url.password !== "") throw new NetworkPolicyValidationError(`${label} must not embed credentials; use credentialRef`);
  if (url.search !== "" || url.hash !== "") throw new NetworkPolicyValidationError(`${label} must not carry a query or fragment (they often hold secrets)`);
  return url.hostname.toLowerCase().replace(/\.$/u, "").replace(/^\[|\]$/gu, "");
}

function normalizeProvider(value: unknown, index: number): ProviderDescriptor {
  const label = `registry.providers[${index}]`;
  // Unknown fields are refused, so secret values (apiKey, token, password, ...) cannot be registered.
  assertRecord(value, label, ["id", "kind", "capabilities", "endpoint", "credentialRef"]);
  assertStableId(value.id, `${label}.id`);
  assertOneOf(value.kind, PROVIDER_KINDS, `${label}.kind`);
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.length > PROVIDER_CAPABILITIES.length) {
    throw new NetworkPolicyValidationError(`${label}.capabilities must list 1..${PROVIDER_CAPABILITIES.length} capabilities`);
  }
  const capabilities = value.capabilities.map((capability, position) => {
    assertOneOf(capability, PROVIDER_CAPABILITIES, `${label}.capabilities[${position}]`);
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length) throw new NetworkPolicyValidationError(`${label}.capabilities must be distinct`);
  const http = value.kind === "loopback-http" || value.kind === "remote-http";
  const endpoint = value.endpoint ?? null;
  if (http) {
    if (typeof endpoint !== "string" || endpoint.length > NETWORK_LIMITS.maxUrlLength) {
      throw new NetworkPolicyValidationError(`${label}.endpoint is required for ${value.kind} providers`);
    }
    const host = endpointHost(endpoint, `${label}.endpoint`);
    const loopback = host === "localhost" || host.endsWith(".localhost") || (isIP(host) !== 0 && isLoopbackAddress(host));
    if (value.kind === "loopback-http" && !loopback) throw new NetworkPolicyValidationError(`${label}.endpoint must be a loopback host for loopback-http`);
    if (value.kind === "remote-http" && loopback) throw new NetworkPolicyValidationError(`${label}.endpoint must not be loopback for remote-http; use loopback-http`);
  } else if (endpoint !== null) {
    throw new NetworkPolicyValidationError(`${label}.endpoint must be null for ${value.kind} providers`);
  }
  return {
    id: value.id,
    kind: value.kind,
    capabilities,
    endpoint: endpoint as string | null,
    credentialRef: normalizeCredentialRef(value.credentialRef, `${label}.credentialRef`),
  };
}

export function normalizeProviderRegistry(input: unknown): ProviderRegistry {
  const value = inertCopy(input, "registry");
  assertRecord(value, "registry", ["schemaVersion", "providers"]);
  if (value.schemaVersion !== NETWORK_POLICY_SCHEMA_VERSION) throw new NetworkPolicyValidationError("registry.schemaVersion is unsupported");
  if (!Array.isArray(value.providers) || value.providers.length > NETWORK_LIMITS.maxProviders) {
    throw new NetworkPolicyValidationError(`registry.providers must hold at most ${NETWORK_LIMITS.maxProviders} providers`);
  }
  const providers = value.providers.map((provider, index) => normalizeProvider(provider, index));
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) {
    throw new NetworkPolicyValidationError("registry provider ids must be distinct");
  }
  return { schemaVersion: NETWORK_POLICY_SCHEMA_VERSION, providers };
}

/**
 * Pick the first registered provider for `capability` whose network needs the policy
 * permits. In-process and local-process providers need no network; HTTP providers need an
 * allowed `provider.inference` decision for their endpoint. Every skipped provider is
 * reported with a reason.
 */
export function resolveProvider(registryInput: unknown, policyInput: unknown, capability: unknown): ProviderResolution {
  const registry = normalizeProviderRegistry(registryInput);
  const policy = normalizeNetworkPolicy(policyInput);
  assertOneOf(capability, PROVIDER_CAPABILITIES, "capability");
  const rejected: ProviderResolution["rejected"] = [];
  for (const provider of registry.providers) {
    if (!provider.capabilities.includes(capability)) continue;
    if (provider.kind === "in-process" || provider.kind === "local-process") {
      return { capability, provider, decision: null, rejected };
    }
    const decision = evaluateUrl(policy, { capability: "provider.inference", url: provider.endpoint });
    if (decision.allowed) return { capability, provider, decision, rejected };
    rejected.push({ id: provider.id, reason: decision.reason });
  }
  return { capability, provider: null, decision: null, rejected };
}

export type { ProviderCapability };
