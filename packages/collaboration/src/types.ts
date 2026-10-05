import type { JsonValue } from "@lilac/agent-runtime";

export const COLLABORATION_SCHEMA_VERSION = 1;
export const MAX_ID_LENGTH = 256;
export const MAX_DISPLAY_NAME_LENGTH = 256;
export const MAX_STATUS_LENGTH = 512;
export const MAX_COMMENT_TEXT_LENGTH = 16_384;
export const MAX_SOURCE_PATH_LENGTH = 4096;
export const MAX_EDITING_RANGES = 32;
export const MAX_GRANTS = 1024;
export const MAX_LOG_ENTRIES = 16_384;
export const MAX_LOG_BYTES = 16 * 1024 * 1024;
export const MAX_STATE_BYTES = 20 * 1024 * 1024;
export const MAX_EPHEMERAL_MESSAGE_BYTES = 64 * 1024;
export const MAX_EPHEMERAL_UPDATES_PER_WINDOW = 120;
export const EPHEMERAL_RATE_WINDOW_MS = 1000;
export const MAX_ROOM_SESSIONS = 256;
export const DEFAULT_COMMENT_PAGE_SIZE = 100;
export const MAX_COMMENT_PAGE_SIZE = 200;

export type ActorKind = "user" | "agent";
export type ActorAccessClass = "member" | "guest" | "service";
export type CollaborationCapability = "read" | "presence" | "document-write" | "comments" | "admin" | "durable-secret";
export type CollaborationTransport = "http" | "realtime" | "mcp" | "agent";
export type AccessPrincipalKind = "actor" | "link";

export interface CollaboratorActor {
  actorId: string;
  kind: ActorKind;
  accessClass: ActorAccessClass;
  displayName: string;
  ownerActorId?: string;
  operationId?: string;
  workerTaskId?: string;
}

export interface DurableActorIdentity {
  actorId: string;
  kind: ActorKind;
  accessClass: ActorAccessClass;
  displayName: string;
  ownerActorId?: string;
}

export interface AccessGrant {
  principalKind: AccessPrincipalKind;
  principalId: string;
  capabilities: CollaborationCapability[];
  expiresAt?: string;
}

export interface DocumentAccessPolicy {
  version: number;
  documentId: string;
  policyRevision: number;
  deleted: boolean;
  grants: AccessGrant[];
}

export interface AccessRequest {
  actor: CollaboratorActor;
  transport: CollaborationTransport;
  capability: CollaborationCapability;
  at: string;
  linkGrantId?: string;
}

export interface AccessDecision {
  outcome: "allowed" | "denied" | "not-found";
  documentId: string;
  actorId: string;
  capability: CollaborationCapability;
  transport: CollaborationTransport;
  policyRevision: number;
  reason: string;
}

export interface WorldPoint {
  x: number;
  y: number;
}

export interface CollaborationViewport {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export interface EditingRange {
  nodeId: string;
  start?: number;
  end?: number;
}

export interface PresenceSession {
  version: number;
  documentId: string;
  actor: CollaboratorActor;
  sessionId: string;
  generation: number;
  sequence: number;
  cursor?: WorldPoint;
  viewport?: CollaborationViewport;
  activeNodeId?: string;
  editing: EditingRange[];
  status?: string;
  updatedAt: string;
}

export interface SourceRangeBinding {
  repositoryId?: string;
  path: string;
  start?: number;
  end?: number;
}

export interface GeometryFallback {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CommentAnchor {
  documentId: string;
  nodeId?: string;
  source?: SourceRangeBinding;
  geometry?: GeometryFallback;
}

export interface CommentRecord {
  version: number;
  id: string;
  documentId: string;
  rootId: string;
  parentId?: string;
  anchor: CommentAnchor;
  author: DurableActorIdentity;
  text: string;
  at: string;
  resolvedAt?: string;
  resolvedBy?: DurableActorIdentity;
}

export interface TransactionSummary {
  transactionId: string;
  historyRevision: number;
  intent?: string;
  operationId?: string;
  workerTaskId?: string;
  affectedNodeIds: string[];
  sourceBindings: SourceRangeBinding[];
}

export type CollaborationFactKind =
  | "transaction-committed"
  | "comment-created"
  | "comment-replied"
  | "comment-resolved"
  | "access-changed"
  | "agent-work-linked"
  | "reconnect-recovered";

export interface CollaborationFact {
  version: number;
  documentId: string;
  id: string;
  sequence: number;
  kind: CollaborationFactKind;
  actor: DurableActorIdentity;
  at: string;
  data: JsonValue;
}

export interface CollaborationLog {
  version: number;
  documentId: string;
  nextSequence: number;
  facts: CollaborationFact[];
}

export interface CollaborationReplayState {
  documentId: string;
  cursor: number;
  comments: CommentRecord[];
  transactions: TransactionSummary[];
  accessFacts: CollaborationFact[];
  agentLinks: CollaborationFact[];
}

export interface ActivityRecord {
  id: string;
  sequence: number;
  documentId: string;
  kind: "document-transaction" | "comment" | "access" | "agent-work" | "reconnect";
  actor: DurableActorIdentity;
  at: string;
  operationId?: string;
  transactionId?: string;
  commentId?: string;
  detail: JsonValue;
}

export interface CollaborationPersistentState {
  version: number;
  documentId: string;
  policy: DocumentAccessPolicy;
  log: CollaborationLog;
}
