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
 * Resolve a possibly non-existent destination against the nearest existing
 * ancestor so symlinked parents cannot dodge confinement: lexical resolve()
 * alone never sees through them.
 */
async function resolveDestination(destinationDir: string): Promise<string> {
  const segments: string[] = [];
  let cursor = resolve(destinationDir);
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
    if (stat.isSymbolicLink()) throw new DeliveryValidationError("evidence destination must not traverse a symbolic link");
    const canonical = await realpath(cursor);
    return segments.length === 0 ? canonical : join(canonical, ...segments);
  }
  throw new DeliveryValidationError("evidence destination is nested too deeply");
}

/**
 * Evidence bundles persist outside disposable worktrees. Destinations inside
 * any registered disposable root are refused; symlink escapes are refused;
 * the bundle filename derives deterministically from its content.
 */
export async function writeEvidenceBundle(
  destinationDir: string,
  bundleInput: Omit<EvidenceBundle, "schemaVersion" | "bundleId">,
  options: { disposableRoots?: string[] } = {},
): Promise<{ path: string; bundleId: string }> {
  if (typeof destinationDir !== "string" || destinationDir.trim() === "") {
    throw new DeliveryValidationError("evidence destination must be a non-empty string");
  }
  assertPlainObject(bundleInput, "evidence.bundle");
  if (!Array.isArray(bundleInput.records) || !Array.isArray(bundleInput.askUserRequests)) {
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
  let canonicalDir: string;
  try {
    canonicalDir = await resolveDestination(destinationDir);
  } catch (error) {
    if (error instanceof DeliveryValidationError) throw error;
    throw new DeliveryValidationError(`evidence destination cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const root of options.disposableRoots ?? []) {
    let canonicalRoot: string | null;
    try {
      canonicalRoot = await realpath(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    if (insideDirectory(canonicalDir, canonicalRoot)) {
      throw new DeliveryValidationError(`evidence must persist outside disposable worktree ${root}`);
    }
  }
  await mkdir(canonicalDir, { recursive: true });
  const path = join(canonicalDir, `${bundle.bundleId}.evidence.json`);
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
