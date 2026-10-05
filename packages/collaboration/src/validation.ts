import { normalizeJson } from "@lilac/agent-runtime";
import { CollaborationValidationError } from "./errors.ts";
import {
  COLLABORATION_SCHEMA_VERSION,
  MAX_COMMENT_TEXT_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_EDITING_RANGES,
  MAX_ID_LENGTH,
  MAX_SOURCE_PATH_LENGTH,
  MAX_STATUS_LENGTH,
  type CollaboratorActor,
  type CollaborationViewport,
  type CommentAnchor,
  type DurableActorIdentity,
  type EditingRange,
  type GeometryFallback,
  type SourceRangeBinding,
  type WorldPoint,
} from "./types.ts";

export function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CollaborationValidationError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CollaborationValidationError(`${label} must be a plain object`);
  }
}

export function assertBoundedString(value: unknown, label: string, max = MAX_ID_LENGTH): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CollaborationValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > max) throw new CollaborationValidationError(`${label} exceeds ${max} characters`);
}

export function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new CollaborationValidationError(`${label} must be an ISO-compatible timestamp`);
  }
}

export function assertFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CollaborationValidationError(`${label} must be finite`);
  }
}

export function normalizeActor(value: CollaboratorActor): CollaboratorActor {
  assertPlainObject(value, "actor");
  assertAllowedKeys(value, "actor", ["actorId", "kind", "accessClass", "displayName", "ownerActorId", "operationId", "workerTaskId"]);
  assertBoundedString(value.actorId, "actor.actorId");
  if (value.kind !== "user" && value.kind !== "agent") throw new CollaborationValidationError("actor.kind is unsupported");
  if (value.accessClass !== "member" && value.accessClass !== "guest" && value.accessClass !== "service") throw new CollaborationValidationError("actor.accessClass is unsupported");
  assertBoundedString(value.displayName, "actor.displayName", MAX_DISPLAY_NAME_LENGTH);
  if (value.ownerActorId !== undefined) assertBoundedString(value.ownerActorId, "actor.ownerActorId");
  if (value.operationId !== undefined) assertBoundedString(value.operationId, "actor.operationId");
  if (value.workerTaskId !== undefined) assertBoundedString(value.workerTaskId, "actor.workerTaskId");
  if (value.kind === "user" && value.ownerActorId !== undefined) {
    throw new CollaborationValidationError("user actors cannot declare ownerActorId");
  }
  return structuredClone(value);
}

export function durableActor(value: CollaboratorActor): DurableActorIdentity {
  const actor = normalizeActor(value);
  return {
    actorId: actor.actorId,
    kind: actor.kind,
    accessClass: actor.accessClass,
    displayName: actor.displayName,
    ...(actor.ownerActorId === undefined ? {} : { ownerActorId: actor.ownerActorId }),
  };
}

export function normalizePoint(value: WorldPoint, label = "cursor"): WorldPoint {
  assertPlainObject(value, label);
  assertAllowedKeys(value, label, ["x", "y"]);
  assertFinite(value.x, `${label}.x`);
  assertFinite(value.y, `${label}.y`);
  return { x: value.x, y: value.y };
}

export function normalizeViewport(value: CollaborationViewport): CollaborationViewport {
  assertPlainObject(value, "viewport");
  assertAllowedKeys(value, "viewport", ["x", "y", "zoom", "width", "height"]);
  assertFinite(value.x, "viewport.x");
  assertFinite(value.y, "viewport.y");
  assertFinite(value.zoom, "viewport.zoom");
  assertFinite(value.width, "viewport.width");
  assertFinite(value.height, "viewport.height");
  if (value.zoom <= 0 || value.width <= 0 || value.height <= 0) {
    throw new CollaborationValidationError("viewport zoom, width, and height must be positive");
  }
  return { x: value.x, y: value.y, zoom: value.zoom, width: value.width, height: value.height };
}

export function normalizeEditing(value: EditingRange[]): EditingRange[] {
  if (!Array.isArray(value) || value.length > MAX_EDITING_RANGES) {
    throw new CollaborationValidationError(`editing must contain at most ${MAX_EDITING_RANGES} ranges`);
  }
  return value.map((range, index) => {
    assertPlainObject(range, `editing[${index}]`);
    assertAllowedKeys(range, `editing[${index}]`, ["nodeId", "start", "end"]);
    assertBoundedString(range.nodeId, `editing[${index}].nodeId`);
    if (range.start !== undefined && (!Number.isSafeInteger(range.start) || range.start < 0)) {
      throw new CollaborationValidationError(`editing[${index}].start must be a non-negative safe integer`);
    }
    if (range.end !== undefined && (!Number.isSafeInteger(range.end) || range.end < 0)) {
      throw new CollaborationValidationError(`editing[${index}].end must be a non-negative safe integer`);
    }
    if (range.start !== undefined && range.end !== undefined && range.end < range.start) {
      throw new CollaborationValidationError(`editing[${index}].end precedes start`);
    }
    return structuredClone(range);
  });
}

export function normalizeStatus(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  assertBoundedString(value, "presence.status", MAX_STATUS_LENGTH);
  return value;
}

function normalizeSource(value: SourceRangeBinding): SourceRangeBinding {
  assertPlainObject(value, "anchor.source");
  assertAllowedKeys(value, "anchor.source", ["repositoryId", "path", "start", "end"]);
  assertBoundedString(value.path, "anchor.source.path", MAX_SOURCE_PATH_LENGTH);
  if (value.repositoryId !== undefined) assertBoundedString(value.repositoryId, "anchor.source.repositoryId");
  if (value.start !== undefined && (!Number.isSafeInteger(value.start) || value.start < 0)) {
    throw new CollaborationValidationError("anchor.source.start must be a non-negative safe integer");
  }
  if (value.end !== undefined && (!Number.isSafeInteger(value.end) || value.end < 0)) {
    throw new CollaborationValidationError("anchor.source.end must be a non-negative safe integer");
  }
  if (value.start !== undefined && value.end !== undefined && value.end < value.start) {
    throw new CollaborationValidationError("anchor.source.end precedes start");
  }
  return structuredClone(value);
}

function normalizeGeometry(value: GeometryFallback): GeometryFallback {
  assertPlainObject(value, "anchor.geometry");
  assertAllowedKeys(value, "anchor.geometry", ["x", "y", "width", "height"]);
  assertFinite(value.x, "anchor.geometry.x");
  assertFinite(value.y, "anchor.geometry.y");
  assertFinite(value.width, "anchor.geometry.width");
  assertFinite(value.height, "anchor.geometry.height");
  if (value.width <= 0 || value.height <= 0) throw new CollaborationValidationError("anchor geometry dimensions must be positive");
  return structuredClone(value);
}

export function normalizeAnchor(value: CommentAnchor, documentId: string): CommentAnchor {
  assertPlainObject(value, "anchor");
  assertAllowedKeys(value, "anchor", ["documentId", "nodeId", "source", "geometry"]);
  assertBoundedString(value.documentId, "anchor.documentId");
  if (value.documentId !== documentId) throw new CollaborationValidationError("comment anchor belongs to another document");
  if (value.nodeId !== undefined) assertBoundedString(value.nodeId, "anchor.nodeId");
  const source = value.source === undefined ? undefined : normalizeSource(value.source);
  const geometry = value.geometry === undefined ? undefined : normalizeGeometry(value.geometry);
  if (value.nodeId === undefined && source === undefined && geometry === undefined) {
    throw new CollaborationValidationError("comment anchor requires nodeId, source, or geometry");
  }
  return { documentId, ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }), ...(source === undefined ? {} : { source }), ...(geometry === undefined ? {} : { geometry }) };
}

export function normalizeCommentText(value: string): string {
  assertBoundedString(value, "comment.text", MAX_COMMENT_TEXT_LENGTH);
  return value;
}

export function normalizeMetadata(value: unknown, label: string) {
  try {
    return normalizeJson(value, label);
  } catch (error) {
    throw new CollaborationValidationError(error instanceof Error ? error.message : `${label} must be JSON-safe`);
  }
}

export function assertSchemaVersion(value: unknown, label: string): void {
  if (value !== COLLABORATION_SCHEMA_VERSION) throw new CollaborationValidationError(`${label} version is unsupported`);
}

export function assertAllowedKeys(value: Record<string, unknown>, label: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new CollaborationValidationError(`${label} contains unsupported field ${key}`);
  }
}
