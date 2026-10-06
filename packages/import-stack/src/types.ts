export const IMPORT_SCHEMA_VERSION = 1;

export const IMPORT_HARD_LIMITS = Object.freeze({
  maxHtmlBytes: 4 * 1024 * 1024,
  maxDomNodes: 25_000,
  maxDomDepth: 256,
  maxTextBytes: 4 * 1024 * 1024,
  maxAttributesPerNode: 128,
  maxAttributeBytes: 64 * 1024,
  maxCssBytes: 2 * 1024 * 1024,
  maxAssets: 2_048,
  maxAssetBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxDiagnostics: 2_048,
  maxRedirects: 8,
  maxMirrorDepth: 8,
  maxWallClockMs: 10 * 60 * 1000,
  maxDocumentPages: 1_000,
  maxDocumentOutputBytes: 64 * 1024 * 1024,
});

export type ImportJsonPrimitive = string | number | boolean | null;
export type ImportJsonValue = ImportJsonPrimitive | ImportJsonValue[] | { [key: string]: ImportJsonValue };

export type ImportSourceKind = "html-snapshot" | "local-app" | "remote-url" | "document";
export type ImportNetworkMode = "offline" | "local-app" | "remote";
export type ImportNodeKind = "element" | "text" | "image" | "vector" | "media";

export interface ImportPolicy {
  mode: ImportNetworkMode;
  allowNetwork: boolean;
  allowLoopback: boolean;
  maxHtmlBytes: number;
  maxDomNodes: number;
  maxDomDepth: number;
  maxTextBytes: number;
  maxAttributesPerNode: number;
  maxAttributeBytes: number;
  maxCssBytes: number;
  maxAssets: number;
  maxAssetBytes: number;
  maxTotalBytes: number;
  maxDiagnostics: number;
  maxRedirects: number;
  maxMirrorDepth: number;
  maxWallClockMs: number;
  maxDocumentPages: number;
  maxDocumentOutputBytes: number;
}

export interface ImportSourceIdentity {
  kind: ImportSourceKind;
  uri?: string;
  repositoryId?: string;
  repositoryPath?: string;
  baseUrl?: string;
}

export interface ImportRequest {
  schemaVersion: number;
  requestId: string;
  actorId: string;
  intent: string;
  at: string;
  source: ImportSourceIdentity;
  policy: ImportPolicy;
}

export interface SourceBinding {
  sourceUri?: string;
  domPath?: string;
  repositoryId?: string;
  path?: string;
  start?: number;
  end?: number;
}

export interface AssetRecord {
  assetId: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  logicalName?: string;
  sourceUri?: string;
}

export interface ImportArtifact {
  schemaVersion: number;
  artifactId: string;
  requestId: string;
  adapterId: string;
  source: ImportSourceIdentity;
  sha256: string;
  byteLength: number;
  mediaType: string;
  logicalName?: string;
}

export interface ResourceReference {
  kind: "stylesheet" | "image" | "media" | "link";
  uri: string;
  nodeId?: string;
  attribute?: "href" | "src" | "poster" | "cite" | "background" | "xlink:href";
}

export interface ImportDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  nodeId?: string;
  sourceBinding?: SourceBinding;
}

export interface ImportNode {
  id: string;
  kind: ImportNodeKind;
  parentId: string | null;
  children: string[];
  tag?: string;
  text?: string;
  attributes: Record<string, string>;
  style: Record<string, string>;
  sourceBinding?: SourceBinding;
}

export interface ImportStylesheet {
  id: string;
  cssText: string;
  sourceBinding?: SourceBinding;
}

export interface ImportSecuritySummary {
  scriptsRemoved: number;
  dangerousElementsRemoved: number;
  eventHandlersRemoved: number;
  dangerousUrlsRemoved: number;
  unsafeStylesRemoved: number;
}

export interface ImportProposal {
  schemaVersion: number;
  proposalId: string;
  requestId: string;
  actorId: string;
  intent: string;
  requestedAt: string;
  inputSha256: string;
  source: ImportSourceIdentity;
  policy: ImportPolicy;
  rootIds: string[];
  nodes: Record<string, ImportNode>;
  stylesheets: ImportStylesheet[];
  assets: AssetRecord[];
  resources: ResourceReference[];
  diagnostics: ImportDiagnostic[];
  security: ImportSecuritySummary;
}

export interface ImportLedgerEntry {
  requestId: string;
  intentSha256: string;
  inputSha256: string;
  proposalId: string;
}

export interface ImportRequestLedger {
  schemaVersion: number;
  entries: Record<string, ImportLedgerEntry>;
}

export type AdapterResult<T> =
  | { status: "ok"; value: T }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

export interface DocumentAdapterOutput {
  format: string;
  document: ImportJsonValue;
}

export interface LocalSourceSnapshot {
  repositoryId: string;
  path: string;
  sha256: string;
  byteLength: number;
  content: string;
  sourceBinding: SourceBinding;
}

export interface StaticMirrorResource {
  sourceUri: string;
  finalUri: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
  logicalPath: string;
  depth: number;
}

export interface StaticMirrorManifest {
  schemaVersion: number;
  requestId: string;
  entryUrl: string;
  entryLogicalPath: string;
  totalBytes: number;
  resources: StaticMirrorResource[];
  rewrites: Record<string, string>;
}

export interface StaticMirrorResult {
  jobDirectory: string;
  manifest: StaticMirrorManifest;
}

export interface ImportCommitResult {
  history: unknown;
  transactionId: string;
  documentRevision: number;
  affectedNodeIds: string[];
}
