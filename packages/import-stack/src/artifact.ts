import { createHash } from "node:crypto";
import { ImportSecurityError, ImportValidationError } from "./errors.ts";
import { IMPORT_SCHEMA_VERSION, type ImportArtifact, type ImportRequest } from "./types.ts";
import { assertBoundedString, canonicalImportStringify, normalizeImportRequest, sha256Text } from "./validation.ts";

export function createImportArtifact(
  requestInput: ImportRequest,
  bytes: Uint8Array,
  input: { adapterId: string; mediaType: string; logicalName?: string },
): ImportArtifact {
  const request = normalizeImportRequest(requestInput);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new ImportValidationError("import artifact bytes must be non-empty");
  if (bytes.byteLength > request.policy.maxTotalBytes) throw new ImportSecurityError("import artifact exceeds maxTotalBytes");
  assertBoundedString(input.adapterId, "import.artifact.adapterId", 256);
  assertBoundedString(input.mediaType, "import.artifact.mediaType", 256);
  if (input.logicalName !== undefined) assertBoundedString(input.logicalName, "import.artifact.logicalName", 512);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactId = `import-artifact:${sha256Text(canonicalImportStringify({
    requestId: request.requestId,
    adapterId: input.adapterId,
    sha256,
    byteLength: bytes.byteLength,
    mediaType: input.mediaType.toLowerCase(),
  })).slice(0, 32)}`;
  return {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    artifactId,
    requestId: request.requestId,
    adapterId: input.adapterId,
    source: request.source,
    sha256,
    byteLength: bytes.byteLength,
    mediaType: input.mediaType.toLowerCase(),
    ...(input.logicalName === undefined ? {} : { logicalName: input.logicalName }),
  };
}
