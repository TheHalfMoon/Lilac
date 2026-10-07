import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { PersistenceCorruptionError, PersistenceValidationError } from "./errors.ts";
import { PROJECT_FILES } from "./types.ts";

// O_NOFOLLOW makes the kernel refuse a symlink at open time (POSIX). Windows has no such
// flag; there the lstat check before open leaves a narrow residual race, documented in the
// evidence file.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
// O_NONBLOCK makes opening a FIFO return at once instead of waiting for a writer, so a
// FIFO swapped in after the regular-file check cannot hang the store. It has no effect
// on regular files.
const NONBLOCK = constants.O_NONBLOCK ?? 0;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Throws when `path` exists and is a symbolic link. Returns whether it exists. */
export function assertNotSymlink(path: string, label: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new PersistenceValidationError(`${label} must not be a symbolic link`);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    if ((error as NodeJS.ErrnoException)?.code === "ENOTDIR") {
      throw new PersistenceValidationError(`${label} is under a path component that is not a directory`);
    }
    throw error;
  }
}

/** Real path plus device and inode of a directory, for detecting a swapped project directory. */
export interface DirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

/**
 * True when `path` still resolves, without symlinks, to the pinned directory. A path that
 * no longer resolves to a directory counts as changed; other errors (EACCES, EMFILE, ...)
 * are rethrown so they are not misreported as a swap.
 */
export function isSameDirectory(path: string, pinned: DirectoryIdentity): boolean {
  let current: DirectoryIdentity;
  try {
    current = directoryIdentity(path, "project directory");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (error instanceof PersistenceValidationError || code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
  return current.path === pinned.path && current.dev === pinned.dev && current.ino === pinned.ino;
}

export function directoryIdentity(path: string, label: string): DirectoryIdentity {
  let real: string;
  try {
    real = realpathSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new PersistenceValidationError(`${label} is missing`);
    throw error;
  }
  const stat = lstatSync(real, { bigint: true });
  if (!stat.isDirectory()) throw new PersistenceValidationError(`${label} must be a directory`);
  return { path: real, dev: stat.dev, ino: stat.ino };
}

/** Resolve `<root>/.lilac`, requiring an absolute existing root and a non-symlink project directory. */
export function projectDirectory(root: unknown): string {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0") || !isAbsolute(root)) {
    throw new PersistenceValidationError("project root must be an absolute path");
  }
  let resolved: string;
  try {
    resolved = realpathSync(root);
  } catch {
    throw new PersistenceValidationError("project root must exist");
  }
  if (!lstatSync(resolved).isDirectory()) throw new PersistenceValidationError("project root must be a directory");
  const directory = join(resolved, PROJECT_FILES.directory);
  assertNotSymlink(directory, "project directory");
  return directory;
}

export function ensureDirectory(path: string, label: string): void {
  if (assertNotSymlink(path, label)) {
    if (!lstatSync(path).isDirectory()) throw new PersistenceValidationError(`${label} must be a directory`);
    return;
  }
  mkdirSync(path, { mode: 0o700 });
  // Make the new directory entry durable before anything that references it is written.
  fsyncDirectory(dirname(path));
}

export function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    // O_DIRECTORY refuses anything but a directory, and O_NONBLOCK keeps a FIFO swapped
    // in at this path from blocking the open.
    fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NONBLOCK);
    fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some platforms (Windows); rename atomicity still holds.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Read a regular, non-symlink file of at most `maxBytes`, or return null when it is missing.
 * A non-regular file (FIFO, socket, device, directory) is refused before it is opened.
 * `singleLink` additionally refuses a hard-linked file.
 */
export function readBounded(path: string, maxBytes: number, label: string, { singleLink = false }: { singleLink?: boolean } = {}): Buffer | null {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    if ((error as NodeJS.ErrnoException)?.code === "ENOTDIR") {
      throw new PersistenceValidationError(`${label} is under a path component that is not a directory`);
    }
    throw error;
  }
  if (entry.isSymbolicLink()) throw new PersistenceValidationError(`${label} must not be a symbolic link`);
  if (!entry.isFile()) throw new PersistenceValidationError(`${label} must be a regular file`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    if (isMissing(error)) return null;
    if ((error as NodeJS.ErrnoException)?.code === "ELOOP") throw new PersistenceValidationError(`${label} must not be a symbolic link`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new PersistenceValidationError(`${label} must be a regular file`);
    if (singleLink && stat.nlink > 1) throw new PersistenceValidationError(`${label} must not be hard-linked`);
    if (stat.size > maxBytes) throw new PersistenceValidationError(`${label} exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
}

/** Write via a same-directory temporary file, fsync, and rename, so readers see old or new, never partial. */
export function atomicWrite(path: string, data: string | Buffer, label: string): void {
  assertNotSymlink(path, label);
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
  fsyncDirectory(dirname(path));
}

/** Create a file exclusively (fails if it exists) and fsync it. */
export function createExclusive(path: string, data: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeAll(fd, Buffer.from(data, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

/**
 * Device and inode of the journal a store writes to. Inode numbers can be reused at once
 * after deletion (ext4), and timestamps have coarse ticks, so neither identifies the content;
 * `appendDurable` therefore also verifies a digest of the bytes themselves.
 */
export interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

export function fileIdentity(path: string, label: string): FileIdentity {
  assertNotSymlink(path, label);
  const stat = lstatSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

const VERIFY_CHUNK_BYTES = 1024 * 1024;

function contentSha256(fd: number, size: number): string {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(Math.min(VERIFY_CHUNK_BYTES, Math.max(size, 1)));
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (read === 0) break;
    hash.update(chunk.subarray(0, read));
    offset += read;
  }
  return hash.digest("hex");
}

/**
 * Append and fsync one record. Through the descriptor it writes with, the file must be the
 * pinned, regular, singly linked journal of exactly the expected size whose bytes hash to
 * the expected SHA-256 (the bytes this writer validated and appended), so a foreign or stale
 * writer, an in-place rewrite, a replaced file, or a hard link out of the project is detected
 * before anything is written, independent of timestamp granularity. Cost is one read of the
 * journal per append (about 1.3 ms/MB measured; bounded by the journal size limit).
 */
export function appendDurable(path: string, data: string, label: string, expected: { size: number; identity: FileIdentity; sha256: string }): void {
  assertNotSymlink(path, label);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_APPEND | NOFOLLOW | NONBLOCK);
  } catch (error) {
    if (isMissing(error)) throw new PersistenceCorruptionError(`${label} is missing`);
    throw error;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new PersistenceValidationError(`${label} must be a regular file`);
    if (stat.nlink > 1n) throw new PersistenceValidationError(`${label} must not be hard-linked`);
    if (stat.dev !== expected.identity.dev || stat.ino !== expected.identity.ino) {
      throw new PersistenceCorruptionError(`${label} was replaced or modified outside this writer`);
    }
    if (stat.size !== BigInt(expected.size)) {
      throw new PersistenceCorruptionError(`${label} changed outside this writer (expected ${expected.size} bytes, found ${stat.size})`);
    }
    if (contentSha256(fd, expected.size) !== expected.sha256) {
      throw new PersistenceCorruptionError(`${label} was replaced or modified outside this writer`);
    }
    writeAll(fd, Buffer.from(data, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// The name atomicWrite gives its temporary file: <target>.tmp-<pid>-<uuid>.
const TEMPORARY_NAME = /^(.+)\.tmp-\d{1,10}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Remove temporary files that an interrupted atomicWrite left in `directory`: regular
 * files (never symlinks or directories) whose name is exactly a temporary name for a
 * target `isTarget` accepts. A temporary is never referenced, so removing it loses
 * nothing, and failing to remove one is no reason to refuse the project: this is best
 * effort, and anything it cannot list, inspect or remove is left in place. Returns how
 * many were removed.
 */
export function removeStaleTemporaries(directory: string, isTarget: (name: string) => boolean): number {
  return removeStaleFiles(directory, (name) => {
    const match = TEMPORARY_NAME.exec(name);
    return match !== null && isTarget(match[1]);
  });
}

/**
 * An error the operating system reported (ENOENT, EACCES, ...): it carries a numeric errno.
 * Node's own argument errors (ERR_*) have a string code but no errno, so they are bugs, not
 * filesystem conditions, and are never absorbed.
 */
export function isFilesystemError(error: unknown): boolean {
  return typeof (error as NodeJS.ErrnoException)?.errno === "number" && typeof (error as NodeJS.ErrnoException)?.code === "string";
}

/** Remove the regular files in `directory` whose name `matches` accepts; best effort. */
export function removeStaleFiles(directory: string, matches: (name: string) => boolean): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (isFilesystemError(error)) return 0;
    throw error;
  }
  for (const name of names) {
    if (!matches(name)) continue;
    const path = join(directory, name);
    try {
      if (!lstatSync(path).isFile()) continue;
      unlinkSync(path);
      removed += 1;
    } catch (error) {
      // Gone already, or not ours to remove: leave it. Anything else is a bug.
      if (!isFilesystemError(error)) throw error;
    }
  }
  return removed;
}

export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
