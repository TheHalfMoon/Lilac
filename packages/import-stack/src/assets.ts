import { createHash } from "node:crypto";
import { ImportConflictError, ImportValidationError } from "./errors.ts";
import type { AssetRecord, ImportPolicy } from "./types.ts";
import { assertBoundedString, assertSafeProvenanceUrl, compareCodeUnits } from "./validation.ts";

export function createAssetRecord(
  bytes: Uint8Array,
  input: { mediaType: string; logicalName?: string; sourceUri?: string },
  policy: ImportPolicy,
): AssetRecord {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new ImportValidationError("asset bytes must be a non-empty Uint8Array");
  }
  if (bytes.byteLength > policy.maxAssetBytes) throw new ImportValidationError("asset exceeds maxAssetBytes");
  assertBoundedString(input.mediaType, "asset.mediaType", 256);
  if (input.logicalName !== undefined) assertBoundedString(input.logicalName, "asset.logicalName", 512);
  if (input.sourceUri !== undefined) {
    assertBoundedString(input.sourceUri, "asset.sourceUri", 4096);
    assertSafeProvenanceUrl(input.sourceUri, "asset.sourceUri");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    assetId: `asset:${sha256}`,
    sha256,
    byteLength: bytes.byteLength,
    mediaType: input.mediaType.toLowerCase(),
    ...(input.logicalName === undefined ? {} : { logicalName: input.logicalName }),
    ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
  };
}

export function deduplicateAssets(records: readonly AssetRecord[], policy: ImportPolicy): AssetRecord[] {
  if (records.length > policy.maxAssets) throw new ImportValidationError("asset count exceeds maxAssets");
  const byHash = new Map<string, AssetRecord>();
  let total = 0;
  for (const record of records) {
    total += record.byteLength;
    if (total > policy.maxTotalBytes) throw new ImportValidationError("asset bytes exceed maxTotalBytes");
    const existing = byHash.get(record.sha256);
    if (existing) {
      if (existing.byteLength !== record.byteLength || existing.mediaType !== record.mediaType) {
        throw new ImportConflictError(`conflicting asset metadata for ${record.sha256}`);
      }
      continue;
    }
    byHash.set(record.sha256, structuredClone(record));
  }
  return [...byHash.values()].sort((a, b) => compareCodeUnits(a.sha256, b.sha256));
}
