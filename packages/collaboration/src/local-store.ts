import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deserializePersistentState, serializePersistentState } from "./durable.ts";
import { CollaborationPersistenceError } from "./errors.ts";
import { assertBoundedString } from "./validation.ts";
import { MAX_STATE_BYTES, type CollaborationPersistentState } from "./types.ts";

function stateFileName(documentId: string): string {
  assertBoundedString(documentId, "store.documentId");
  return `${createHash("sha256").update(documentId, "utf8").digest("hex")}.json`;
}

async function refuseSymlink(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) throw new CollaborationPersistenceError("collaboration state path cannot be a symbolic link");
    if (!info.isFile()) throw new CollaborationPersistenceError("collaboration state path must be a regular file");
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

export class LocalCollaborationFileStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    if (typeof rootDir !== "string" || rootDir.trim() === "") throw new CollaborationPersistenceError("rootDir must be non-empty");
    this.rootDir = path.resolve(rootDir);
  }

  filePath(documentId: string): string {
    return path.join(this.rootDir, stateFileName(documentId));
  }

  async load(documentId: string): Promise<CollaborationPersistentState | null> {
    const filePath = this.filePath(documentId);
    await refuseSymlink(filePath);
    // The checks above can race a swap, so the file is opened without following a link or
    // blocking on a FIFO, and the opened file itself must be a single-link regular file
    // within the state size bound (a hard link can name a file outside the store).
    let handle;
    try {
      handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") throw new CollaborationPersistenceError("collaboration state path cannot be a symbolic link");
      throw error;
    }
    let serialized: string;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new CollaborationPersistenceError("collaboration state path must be a regular file");
      if (info.nlink > 1) throw new CollaborationPersistenceError("collaboration state file must not be hard-linked");
      if (info.size > MAX_STATE_BYTES) throw new CollaborationPersistenceError("serialized collaboration state is invalid or oversized");
      serialized = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
    const state = deserializePersistentState(serialized);
    if (state.documentId !== documentId) throw new CollaborationPersistenceError("stored collaboration state document identity mismatch");
    return state;
  }

  async save(state: CollaborationPersistentState): Promise<void> {
    const serialized = serializePersistentState(state);
    await mkdir(this.rootDir, { recursive: true });
    const filePath = this.filePath(state.documentId);
    await refuseSymlink(filePath);
    const tempPath = `${filePath}.tmp-${process.pid}`;
    await rm(tempPath, { force: true });
    try {
      await writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        await rename(tempPath, filePath);
      } catch (error: any) {
        if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
        await rm(filePath, { force: true });
        await rename(tempPath, filePath);
      }
    } finally {
      await rm(tempPath, { force: true });
    }
  }
}
