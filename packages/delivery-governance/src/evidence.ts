import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DeliveryValidationError } from "./errors.ts";
import {
  DELIVERY_SCHEMA_VERSION,
  type AskUserRequest,
  type EvidenceBundle,
  type QualificationRecord,
} from "./types.ts";
import {
  canonicalDeliveryStringify,
  normalizeAskUserRequest,
  normalizeQualificationRecord,
  sha256Text,
} from "./validation.ts";

function insideDirectory(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
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
    const stat = await lstat(destinationDir);
    if (stat.isSymbolicLink()) throw new DeliveryValidationError("evidence destination must not be a symbolic link");
    canonicalDir = await realpath(destinationDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    canonicalDir = resolve(destinationDir);
  }
  for (const root of options.disposableRoots ?? []) {
    const canonicalRoot = resolve(root);
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
