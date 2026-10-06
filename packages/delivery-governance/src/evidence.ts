import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { DeliveryValidationError } from "./errors.ts";
import {
  DELIVERY_SCHEMA_VERSION,
  type AskUserRequest,
  type EvidenceBundle,
  type QualificationRecord,
} from "./types.ts";
import {
  canonicalDeliveryStringify,
  assertPlainObject,
  normalizeAskUserRequest,
  normalizeQualificationRecord,
  sha256Text,
} from "./validation.ts";

function insideDirectory(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolve a possibly non-existent path against the nearest existing ancestor
 * so symlinked parents cannot dodge confinement: lexical resolve() alone
 * never sees through them.
 */
async function resolveThroughExisting(path: string): Promise<string> {
  const segments: string[] = [];
  let cursor = resolve(path);
  for (let depth = 0; depth < 64; depth += 1) {
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      segments.unshift(cursor.slice(dirname(cursor).length + 1));
      cursor = dirname(cursor);
      continue;
    }
    if (stat.isSymbolicLink()) throw new DeliveryValidationError("evidence path must not traverse a symbolic link");
    const canonical = await realpath(cursor);
    return segments.length === 0 ? canonical : join(canonical, ...segments);
  }
  throw new DeliveryValidationError("evidence path is nested too deeply");
}

export interface EvidenceStoreOptions {
  evidenceRoot: string;
  disposableRoots?: string[];
}

export interface EvidenceStore {
  readonly root: string;
  writeBundle(bundleInput: Omit<EvidenceBundle, "schemaVersion" | "bundleId">): Promise<{ path: string; bundleId: string }>;
}

/**
 * Evidence bundles persist in exactly one pre-registered store root outside
 * disposable worktrees. Callers never choose arbitrary destinations: the root
 * is resolved once, symlink escapes are refused, disposable containment is
 * refused, and every bundle file is create-only under that root.
 */
export async function createEvidenceStore(options: EvidenceStoreOptions): Promise<EvidenceStore> {
  if (options === null || typeof options !== "object") {
    throw new DeliveryValidationError("evidence store options are required");
  }
  if (typeof options.evidenceRoot !== "string" || options.evidenceRoot.trim() === "") {
    throw new DeliveryValidationError("evidence root must be a non-empty string");
  }
  let root: string;
  try {
    root = await resolveThroughExisting(options.evidenceRoot);
  } catch (error) {
    if (error instanceof DeliveryValidationError) throw error;
    throw new DeliveryValidationError(`evidence root cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const disposable of options.disposableRoots ?? []) {
    let canonicalDisposable: string | null;
    try {
      canonicalDisposable = await realpath(disposable);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    if (insideDirectory(root, canonicalDisposable)) {
      throw new DeliveryValidationError(`evidence root must persist outside disposable worktree ${disposable}`);
    }
  }
  await mkdir(root, { recursive: true });

  async function writeBundle(
    bundleInput: Omit<EvidenceBundle, "schemaVersion" | "bundleId">,
  ): Promise<{ path: string; bundleId: string }> {
    assertPlainObject(bundleInput, "evidence.bundle");
    if (!Array.isArray((bundleInput as Record<string, unknown>).records)
      || !Array.isArray((bundleInput as Record<string, unknown>).askUserRequests)) {
      throw new DeliveryValidationError("evidence bundle records and askUserRequests must be arrays");
    }
    const records = (bundleInput.records as unknown[]).map(normalizeQualificationRecord);
    const askUserRequests = (bundleInput.askUserRequests as unknown[]).map(normalizeAskUserRequest);
    const bundle: EvidenceBundle = {
      schemaVersion: DELIVERY_SCHEMA_VERSION,
      bundleId: `evidence-bundle:${sha256Text(canonicalDeliveryStringify({ ...bundleInput, records, askUserRequests })).slice(0, 32)}`,
      qualificationId: bundleInput.qualificationId,
      candidateHead: bundleInput.candidateHead,
      createdAt: bundleInput.createdAt,
      records,
      askUserRequests,
    };
    if (typeof bundle.qualificationId !== "string" || bundle.qualificationId.trim() === "") {
      throw new DeliveryValidationError("evidence bundle qualificationId is required");
    }
    const path = join(root, `${bundle.bundleId}.evidence.json`);
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat !== null) {
      if (stat.isSymbolicLink()) throw new DeliveryValidationError("evidence path must not be a symbolic link");
      throw new DeliveryValidationError("evidence bundle already exists; bundles are create-only");
    }
    await writeFile(path, `${canonicalDeliveryStringify(bundle)}\n`, { encoding: "utf8", flag: "wx" });
    return { path, bundleId: bundle.bundleId };
  }

  return { root, writeBundle };
}
