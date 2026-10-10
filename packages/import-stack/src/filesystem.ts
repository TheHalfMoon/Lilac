import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
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
  // A hard link inside a root can name a file that lives outside it; realpath cannot tell.
  if (info.nlink > 1) throw new ImportSecurityError(`${label} must not be hard-linked`);
  const source = await realpath(path);
  for (const rootInput of roots) {
    const root = await canonicalDirectory(rootInput, `${label} authorized root`);
    const rel = relative(root, source);
    if (rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))) return source;
  }
  throw new ImportSecurityError(`${label} escapes authorized roots`);
}

// Reads a file that a path check has already admitted. The checks are repeated on the open
// handle, so a swap after the check cannot substitute a symlink, a FIFO or a hard link to a
// file elsewhere. A swap of a parent directory in between is not covered.
export async function readSingleLinkFile(path: string, label: string, maxBytes: number): Promise<Buffer> {
  // O_NOFOLLOW refuses a link when the file is opened (POSIX). Windows has no such flag, and
  // opening there follows a link: so the path is checked first, and the file opened must be
  // the one checked (P08-G7). A swap between the two is then refused, not read.
  const noFollow = constants.O_NOFOLLOW;
  let checked: BigIntStats | null = null;
  if (noFollow === undefined) {
    checked = await lstat(path, { bigint: true });
    if (checked.isSymbolicLink()) throw new ImportSecurityError(`${label} must be a regular non-symlink file`);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (noFollow ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new ImportSecurityError(`${label} must be a regular non-symlink file`);
    throw error;
  }
  try {
    if (checked !== null) {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== checked.dev || opened.ino !== checked.ino) throw new ImportSecurityError(`${label} changed while it was being opened`);
    }
    const info = await handle.stat();
    if (!info.isFile()) throw new ImportSecurityError(`${label} must be a regular non-symlink file`);
    if (info.nlink > 1) throw new ImportSecurityError(`${label} must not be hard-linked`);
    if (info.size > maxBytes) throw new ImportSecurityError(`${label} exceeds ${maxBytes} bytes`);
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) throw new ImportSecurityError(`${label} exceeds ${maxBytes} bytes`);
    return bytes;
  } finally {
    await handle.close();
  }
}

/** The name createImportJobDirectory gives a job directory: `<prefix>-<24 hex>`. */
export const IMPORT_JOB_DIRECTORY_NAME = /^[a-z][a-z0-9-]{0,31}-[0-9a-f]{24}$/u;

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
  // Only a job directory itself: a direct child of the work root named as created.
  if (rel.includes(sep) || !IMPORT_JOB_DIRECTORY_NAME.test(rel)) {
    throw new ImportSecurityError("refusing to remove a path that is not an import job directory");
  }
  await rm(target, { recursive: true, force: true });
}
