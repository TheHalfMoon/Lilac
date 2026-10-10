import { lstatSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./canonical.ts";
import { PersistenceCorruptionError, PersistenceValidationError } from "./errors.ts";
import { assertNotSymlink, atomicWrite, ensureDirectory, readBounded } from "./fsio.ts";
import { PERSISTENCE_LIMITS, PROJECT_FILES } from "./types.ts";

const DIGEST = /^[0-9a-f]{64}$/u;

function objectPath(projectDir: string, digest: string): { directory: string; file: string } {
  if (!DIGEST.test(digest)) throw new PersistenceValidationError("object id must be a sha-256 hex digest");
  const directory = join(projectDir, PROJECT_FILES.objects, digest.slice(0, 2));
  return { directory, file: join(directory, digest.slice(2)) };
}

/** Store bytes under their SHA-256; writing existing content is a verified no-op. */
export function putObject(projectDir: string, bytes: Buffer): string {
  if (bytes.length > PERSISTENCE_LIMITS.maxObjectBytes) {
    throw new PersistenceValidationError(`object exceeds ${PERSISTENCE_LIMITS.maxObjectBytes} bytes`);
  }
  const digest = sha256Hex(bytes);
  const { directory, file } = objectPath(projectDir, digest);
  ensureDirectory(join(projectDir, PROJECT_FILES.objects), "object store");
  ensureDirectory(directory, "object fan-out directory");
  if (assertNotSymlink(file, `object ${digest}`)) {
    getObject(projectDir, digest);
    return digest;
  }
  atomicWrite(file, bytes, `object ${digest}`);
  return digest;
}

/** Read an object and verify its content against its id. */
export function getObject(projectDir: string, digest: string): Buffer {
  const { directory, file } = objectPath(projectDir, digest);
  // A store or fan-out that is a file is refused as such on every platform: reading through it
  // fails as ENOTDIR on POSIX, but as ENOENT, a missing object, on Windows (P08-G7).
  for (const [path, label] of [[join(projectDir, PROJECT_FILES.objects), "object store"], [directory, "object fan-out directory"]]) {
    if (assertNotSymlink(path, label) && !lstatSync(path).isDirectory()) throw new PersistenceValidationError(`${label} is not a directory`);
  }
  const bytes = readBounded(file, PERSISTENCE_LIMITS.maxObjectBytes, `object ${digest}`);
  if (bytes === null) throw new PersistenceCorruptionError(`object ${digest} is missing`);
  if (sha256Hex(bytes) !== digest) throw new PersistenceCorruptionError(`object ${digest} does not match its content hash`);
  return bytes;
}
