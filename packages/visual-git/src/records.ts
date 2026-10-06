import { VisualGitValidationError } from "./errors.ts";
import type { DesignProvenanceRecord } from "./types.ts";
import {
  assertAllowedKeys,
  assertBoundedString,
  assertPlainObject,
  assertStableId,
  assertTimestamp,
  normalizeSnapshot,
  snapshotDigest,
} from "./validation.ts";

export function recordProvenance(snapshotInput: unknown, input: unknown): DesignProvenanceRecord {
  const snapshot = normalizeSnapshot(snapshotInput);
  assertPlainObject(input, "provenance");
  assertAllowedKeys(input, ["recordId", "recordedBy", "recordedAt"], "provenance");
  assertStableId(input.recordId, "provenance.recordId");
  assertBoundedString(input.recordedBy, "provenance.recordedBy", 256);
  assertTimestamp(input.recordedAt, "provenance.recordedAt");
  return {
    recordId: input.recordId,
    snapshotId: snapshot.snapshotId,
    snapshotDigest: snapshotDigest(snapshot),
    branch: snapshot.branch,
    sourceCommit: snapshot.sourceCommit,
    recordedBy: input.recordedBy,
    recordedAt: input.recordedAt,
  };
}

export function verifyProvenance(record: DesignProvenanceRecord, snapshotInput: unknown): true {
  assertPlainObject(record, "provenance record");
  assertAllowedKeys(record, ["recordId", "snapshotId", "snapshotDigest", "branch", "sourceCommit", "recordedBy", "recordedAt"], "provenance record");
  assertStableId(record.recordId, "provenance record.recordId");
  const snapshot = normalizeSnapshot(snapshotInput);
  if (
    record.snapshotId !== snapshot.snapshotId ||
    record.branch !== snapshot.branch ||
    record.sourceCommit !== snapshot.sourceCommit ||
    record.snapshotDigest !== snapshotDigest(snapshot)
  ) {
    throw new VisualGitValidationError(`provenance record ${record.recordId} does not match snapshot ${snapshot.snapshotId}`);
  }
  return true;
}
