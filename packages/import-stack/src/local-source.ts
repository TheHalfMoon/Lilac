import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { ImportSecurityError, ImportValidationError } from "./errors.ts";
import { canonicalDirectory, canonicalFileWithinRoots } from "./filesystem.ts";
import type { AdapterResult, ImportRequest, LocalSourceSnapshot } from "./types.ts";
import { normalizeImportRequest, sha256Text } from "./validation.ts";

export async function readAuthorizedLocalSource(
  requestInput: ImportRequest,
  input: { repositoryId: string; repositoryRoot: string; path: string },
): Promise<AdapterResult<LocalSourceSnapshot>> {
  try {
    const request = normalizeImportRequest(requestInput);
    if (request.source.kind !== "local-app" && request.source.kind !== "document" && request.source.kind !== "html-snapshot") {
      throw new ImportValidationError("local source instrumentation requires local-app, document, or html-snapshot source kind");
    }
    if (typeof input.repositoryId !== "string" || input.repositoryId.trim() === "" || input.repositoryId.length > 256) {
      throw new ImportValidationError("repositoryId must be a bounded non-empty string");
    }
    if (request.source.repositoryId !== undefined && request.source.repositoryId !== input.repositoryId) {
      throw new ImportSecurityError("local source repository identity does not match import request");
    }
    const root = await canonicalDirectory(input.repositoryRoot, "repository root");
    const source = await canonicalFileWithinRoots(input.path, [root], "local source file");
    const rel = relative(root, source);
    if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
      throw new ImportSecurityError("local source path escapes repository root");
    }
    const normalizedPath = rel.split(sep).join("/");
    const info = await stat(source);
    if (info.size === 0 || info.size > request.policy.maxHtmlBytes) {
      throw new ImportSecurityError("local source file size is outside maxHtmlBytes");
    }
    const bytes = await readFile(source);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new ImportValidationError("local source file is not valid UTF-8"); }
    return {
      status: "ok",
      value: {
        repositoryId: input.repositoryId,
        path: normalizedPath,
        sha256: sha256Text(content),
        byteLength: bytes.byteLength,
        content,
        sourceBinding: {
          repositoryId: input.repositoryId,
          path: normalizedPath,
          start: 0,
          end: bytes.byteLength,
        },
      },
    };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
