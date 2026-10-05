import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deserializePersistentState, serializePersistentState } from "./durable.ts";
import { CollaborationPersistenceError } from "./errors.ts";
import { assertBoundedString } from "./validation.ts";
import type { CollaborationPersistentState } from "./types.ts";

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
    try {
      const serialized = await readFile(filePath, "utf8");
      const state = deserializePersistentState(serialized);
      if (state.documentId !== documentId) throw new CollaborationPersistenceError("stored collaboration state document identity mismatch");
      return state;
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
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
