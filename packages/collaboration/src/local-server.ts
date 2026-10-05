import { CollaborationConflictError, CollaborationNotFoundError } from "./errors.ts";
import { LocalCollaborationFileStore } from "./local-store.ts";
import { LocalCollaborationRoom } from "./room.ts";
import { createCollaborationState } from "./state.ts";
import type { AccessGrant } from "./types.ts";

export class LocalCollaborationServer {
  readonly store: LocalCollaborationFileStore;
  #rooms = new Map<string, LocalCollaborationRoom>();

  constructor(store: LocalCollaborationFileStore) {
    this.store = store;
  }

  async create(documentId: string, grants: AccessGrant[] = []): Promise<LocalCollaborationRoom> {
    if (this.#rooms.has(documentId) || await this.store.load(documentId)) {
      throw new CollaborationConflictError(`collaboration document ${documentId} already exists`);
    }
    const room = new LocalCollaborationRoom(createCollaborationState(documentId, grants));
    await this.store.save(room.exportState());
    this.#rooms.set(documentId, room);
    return room;
  }

  async open(documentId: string): Promise<LocalCollaborationRoom> {
    const active = this.#rooms.get(documentId);
    if (active) return active;
    const state = await this.store.load(documentId);
    if (!state) throw new CollaborationNotFoundError(`collaboration document ${documentId} is not found`);
    const room = new LocalCollaborationRoom(state);
    this.#rooms.set(documentId, room);
    return room;
  }

  async save(documentId: string): Promise<void> {
    const room = this.#rooms.get(documentId);
    if (!room) throw new CollaborationNotFoundError(`collaboration document ${documentId} is not open`);
    await this.store.save(room.exportState());
  }

  async close(documentId: string, { save = true } = {}): Promise<boolean> {
    const room = this.#rooms.get(documentId);
    if (!room) return false;
    if (save) await this.store.save(room.exportState());
    this.#rooms.delete(documentId);
    return true;
  }
}
