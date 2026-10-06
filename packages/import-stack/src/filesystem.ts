import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { ImportConflictError, ImportSecurityError, ImportValidationError } from "./errors.ts";
import { sha256Text } from "./validation.ts";

export async function canonicalDirectory(path: string, label: string, create = false): Promise<string> {
  if (typeof path !== "string" || path.trim() === "") throw new ImportValidationError(`${label} must be a non-empty path`);
  if (create) await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ImportSecurityError(`${label} must be a regular non-symlink directory`);
  return await realpath(path);
}

export async function canonicalFileWithinRoots(path: string, roots: string[], label: string): Promise<string> {
  if (!Array.isArray(roots) || roots.length === 0) throw new ImportSecurityError(`${label} requires at least one authorized root`);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new ImportSecurityError(`${label} must be a regular non-symlink file`);
  const source = await realpath(path);
  for (const rootInput of roots) {
    const root = await canonicalDirectory(rootInput, `${label} authorized root`);
    const rel = relative(root, source);
    if (rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))) return source;
  }
  throw new ImportSecurityError(`${label} escapes authorized roots`);
}

export async function createImportJobDirectory(
  workRootInput: string,
  prefix: string,
  jobId: string,
): Promise<{ workRoot: string; jobDirectory: string }> {
  if (!/^[a-zA-Z0-9._:-]{1,256}$/u.test(jobId)) throw new ImportValidationError("jobId must be a bounded safe identifier");
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(prefix)) throw new ImportValidationError("job prefix is invalid");
  const workRoot = await canonicalDirectory(workRootInput, "import work root", true);
  const jobDirectory = join(workRoot, `${prefix}-${sha256Text(jobId).slice(0, 24)}`);
  try {
    await mkdir(jobDirectory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ImportConflictError("import job directory already exists");
    throw error;
  }
  return { workRoot, jobDirectory };
}

export async function safeRemoveImportJobDirectory(workRootInput: string, jobDirectoryInput: string): Promise<void> {
  const root = await canonicalDirectory(workRootInput, "import work root");
  let info;
  try {
    info = await lstat(jobDirectoryInput);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ImportSecurityError("refusing to remove a non-directory or symlinked import job path");
  }
  const target = await realpath(jobDirectoryInput);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new ImportSecurityError("refusing to remove import job path outside the configured work root");
  }
  await rm(target, { recursive: true, force: true });
}
