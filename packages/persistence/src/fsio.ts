import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
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
    throw error;
  }
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
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some platforms (Windows); rename atomicity still holds.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Read a regular, non-symlink file of at most `maxBytes`, or return null when it is missing. */
export function readBounded(path: string, maxBytes: number, label: string): Buffer | null {
  if (!assertNotSymlink(path, label)) return null;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return null;
    if ((error as NodeJS.ErrnoException)?.code === "ELOOP") throw new PersistenceValidationError(`${label} must not be a symbolic link`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new PersistenceValidationError(`${label} must be a regular file`);
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
 * Append and fsync one record. The opened file must be a regular, singly linked file of
 * exactly `expectedSize` bytes, so a foreign writer, a stale writer, or a hard link out of
 * the project is detected before anything is written.
 */
export function appendDurable(path: string, data: string, label: string, expectedSize: number): void {
  assertNotSymlink(path, label);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new PersistenceValidationError(`${label} must be a regular file`);
    if (stat.nlink > 1) throw new PersistenceValidationError(`${label} must not be hard-linked`);
    if (stat.size !== expectedSize) {
      throw new PersistenceCorruptionError(`${label} changed outside this writer (expected ${expectedSize} bytes, found ${stat.size})`);
    }
    writeAll(fd, Buffer.from(data, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
