export const NETWORK_POLICY_SCHEMA_VERSION = 1;

export const NETWORK_LIMITS = {
  maxGrants: 64,
  maxProviders: 64,
  maxUrlLength: 2048,
  maxPurposeLength: 256,
  maxInputDepth: 16,
  maxInputValues: 20000,
  maxStringLength: 4096,
} as const;

/** offline: no network and no loopback; local-only: loopback only; allowlist: explicit grants only. */
export const NETWORK_MODES = ["offline", "local-only", "allowlist"] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

export const NETWORK_CAPABILITIES = [
  "provider.inference",
  "import.fetch",
  "asset.fetch",
  "update.check",
  "collaboration.sync",
] as const;
export type NetworkCapability = (typeof NETWORK_CAPABILITIES)[number];

export const URL_SCHEMES = ["https", "http"] as const;
export type UrlScheme = (typeof URL_SCHEMES)[number];

export interface NetworkGrant {
  id: string;
  capability: NetworkCapability;
  scheme: UrlScheme;
  /** Exact host, or `*.suffix` for strict subdomains of `suffix`. IPv6 literals without brackets. */
  host: string;
  port: number | null;
  allowPrivateNetwork: boolean;
  purpose: string;
}

export interface NetworkPolicy {
  schemaVersion: typeof NETWORK_POLICY_SCHEMA_VERSION;
  mode: NetworkMode;
  grants: NetworkGrant[];
}

export type UrlDecision =
  | {
    allowed: true;
    capability: NetworkCapability;
    url: string;
    host: string;
    grantId: string | null;
    /** Resolved addresses must all be loopback. */
    loopbackOnly: boolean;
    /** Resolved private/reserved addresses are acceptable (explicit grant only). */
    allowPrivateNetwork: boolean;
  }
  | { allowed: false; capability: NetworkCapability | null; reason: string };

export type ResolvedDecision = { allowed: true } | { allowed: false; reason: string };

export const PROVIDER_KINDS = ["in-process", "local-process", "loopback-http", "remote-http"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_CAPABILITIES = ["inference.text", "inference.image", "embedding", "ocr", "segmentation", "vectorize"] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const CREDENTIAL_STORES = ["env", "os-keychain"] as const;
export type CredentialStore = (typeof CREDENTIAL_STORES)[number];

/** A reference to where a secret lives; the secret itself is never accepted. */
export interface CredentialRef {
  store: CredentialStore;
  name: string;
}

export interface ProviderDescriptor {
  id: string;
  kind: ProviderKind;
  capabilities: ProviderCapability[];
  endpoint: string | null;
  credentialRef: CredentialRef | null;
}

export interface ProviderRegistry {
  schemaVersion: typeof NETWORK_POLICY_SCHEMA_VERSION;
  providers: ProviderDescriptor[];
}

export interface ProviderResolution {
  capability: ProviderCapability;
  provider: ProviderDescriptor | null;
  decision: UrlDecision | null;
  rejected: Array<{ id: string; reason: string }>;
}

export interface FeatureRequirement {
  feature: string;
  required: boolean;
  needs: ProviderCapability[];
}

export interface ReadinessReport {
  ready: boolean;
  features: Array<{
    feature: string;
    required: boolean;
    satisfiable: boolean;
    providers: Partial<Record<ProviderCapability, string>>;
    missing: ProviderCapability[];
  }>;
}
