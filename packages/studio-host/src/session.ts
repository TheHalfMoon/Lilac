import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { LocalCollaborationRoom, createCollaborationState } from "@lilac/collaboration";
import { createDocument } from "@lilac/document-model";
import { createHistoryState } from "@lilac/history";
import { PersistenceLockError, createProject, openProject, type ProjectStore, type RecoveryReport } from "@lilac/persistence";
import { StudioError } from "./errors.ts";

/** Who is acting. People act through the editor; agents act through MCP (PC5). */
export interface StudioActor {
  actorId: string;
  kind: "user" | "agent";
  accessClass: "member" | "service";
  displayName: string;
  ownerActorId?: string;
  operationId?: string;
  workerTaskId?: string;
}

/** One committed change, as the change stream reports it. */
export interface ChangeEvent {
  type: "transaction";
  revision: number;
  transactionId: string;
  actor: string;
  actorKind: "user" | "agent";
  intent: string | null;
  tool: string | null;
  affectedNodeIds: string[];
  undoOf?: string;
  redoOf?: string;
}

export interface EditInput {
  baseRevision: number;
  operations: unknown[];
  intent?: string;
  tool?: string;
}

interface UndoEntry {
  transactionId: string;
  intent: string | null;
  operations: unknown[];
  inverse: unknown[];
}

// The local person at the keyboard owns the document; agents get grants they are given.
const OWNER_CAPABILITIES = ["read", "presence", "document-write", "comments", "admin"];
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_UNDO = 200;

export function assertProjectName(name: unknown): string {
  if (typeof name !== "string" || !PROJECT_NAME.test(name) || name.includes("..")) {
    throw new StudioError(400, "invalid-project-name", "project name must be 1-64 letters, digits, dots, dashes or underscores");
  }
  return name;
}

/**
 * One open project: the persisted store is the single writer and the only document authority;
 * collaboration attributes each edit; undo and redo commit inverse transactions, so they are
 * themselves durable, attributed history. The undo stack lives for the session only.
 */
export class StudioSession {
  readonly name: string;
  readonly owner: StudioActor;
  readonly recovery: Readonly<RecoveryReport>;
  #store: ProjectStore;
  #room: LocalCollaborationRoom;
  #now: () => string;
  #undo: UndoEntry[] = [];
  #redo: UndoEntry[] = [];
  #listeners = new Set<(event: ChangeEvent) => void>();
  #closed = false;

  private constructor(name: string, store: ProjectStore, owner: StudioActor, now: () => string) {
    this.name = name;
    this.owner = owner;
    this.recovery = store.recovery;
    this.#store = store;
    this.#now = now;
    this.#room = new LocalCollaborationRoom(createCollaborationState(store.document.id, [
      { principalKind: "actor", principalId: owner.actorId, capabilities: OWNER_CAPABILITIES },
    ]));
  }

  /** Open `<projectsRoot>/<name>`, creating it first when `create` is set. */
  static open(input: { projectsRoot: string; name: string; owner: StudioActor; create?: { title?: string }; breakStaleLock?: { reason: string }; now: () => string }): StudioSession {
    const name = assertProjectName(input.name);
    const root = `${input.projectsRoot}/${name}`;
    const at = input.now();
    if (input.create !== undefined) {
      createProjectDirectory(root, name, input.create.title, at);
    }
    let store: ProjectStore;
    try {
      store = openProject(root, { owner: input.owner.actorId, at, ...(input.breakStaleLock ? { breakStaleLock: input.breakStaleLock } : {}) });
    } catch (error) {
      if (error instanceof PersistenceLockError) throw new StudioError(409, "project-locked", error.message);
      throw error;
    }
    return new StudioSession(name, store, input.owner, input.now);
  }

  get document() {
    this.#assertOpen();
    return this.#store.document;
  }

  get revision(): number {
    this.#assertOpen();
    return this.#store.revision;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  onChange(listener: (event: ChangeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Commit an edit as `actor`. A stale `baseRevision` is refused rather than rebased. */
  edit(actor: StudioActor, input: EditInput, transport: "http" | "mcp" | "agent" = "http"): ChangeEvent {
    this.#assertOpen();
    if (input === null || typeof input !== "object" || !Number.isSafeInteger(input.baseRevision)) throw new StudioError(400, "invalid-edit", "baseRevision must be an integer");
    if (input.baseRevision !== this.#store.revision) {
      throw new StudioError(409, "stale-revision", `edit is based on revision ${input.baseRevision}; the project is at ${this.#store.revision}`);
    }
    if (!Array.isArray(input.operations) || input.operations.length === 0) throw new StudioError(400, "invalid-edit", "operations must be a non-empty array");
    const intent = typeof input.intent === "string" ? input.intent.slice(0, 500) : null;
    const tool = typeof input.tool === "string" ? input.tool.slice(0, 200) : null;
    const { event, inverse } = this.#commit(actor, transport, { operations: input.operations, intent, tool });
    this.#pushUndo({ transactionId: event.transactionId, intent, operations: input.operations, inverse });
    this.#redo = [];
    return event;
  }

  /** Undo the last change made in this session by committing its inverse. */
  undo(actor: StudioActor): ChangeEvent {
    this.#assertOpen();
    const entry = this.#undo.at(-1);
    if (entry === undefined) throw new StudioError(409, "nothing-to-undo", "there is nothing to undo");
    const { event } = this.#commit(actor, "http", { operations: entry.inverse, intent: entry.intent === null ? "Undo" : `Undo: ${entry.intent}`.slice(0, 500), tool: "lilac:undo", link: { undoOf: entry.transactionId } });
    this.#undo.pop();
    this.#redo.push(entry);
    return event;
  }

  /** Re-apply the last undone change; the state is exactly as before it, so its operations apply. */
  redo(actor: StudioActor): ChangeEvent {
    this.#assertOpen();
    const entry = this.#redo.at(-1);
    if (entry === undefined) throw new StudioError(409, "nothing-to-redo", "there is nothing to redo");
    const { event, inverse } = this.#commit(actor, "http", { operations: entry.operations, intent: entry.intent, tool: "lilac:redo", link: { redoOf: entry.transactionId } });
    this.#redo.pop();
    this.#pushUndo({ transactionId: event.transactionId, intent: entry.intent, operations: entry.operations, inverse });
    return event;
  }

  checkpoint(): { revision: number } {
    this.#assertOpen();
    return { revision: this.#store.checkpoint().revision };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#store.close();
  }

  #pushUndo(entry: UndoEntry): void {
    this.#undo.push(entry);
    if (this.#undo.length > MAX_UNDO) this.#undo.shift();
  }

  #commit(actor: StudioActor, transport: "http" | "mcp" | "agent", input: { operations: unknown[]; intent: string | null; tool: string | null; link?: { undoOf?: string; redoOf?: string } }): { event: ChangeEvent; inverse: unknown[] } {
    const at = this.#now();
    const transactionId = `tx-${randomUUID()}`;
    let attributed: Record<string, unknown>;
    let inverse: unknown[];
    let affectedNodeIds: string[];
    try {
      // Collaboration authorizes the actor and attributes the transaction; the store is the
      // only writer and re-validates it against the persisted document before appending.
      const result = this.#room.commitTransaction({
        actor,
        transport,
        history: createHistoryState(this.#store.document),
        at,
        ...(actor.operationId ? { operationId: actor.operationId } : {}),
        ...(actor.workerTaskId ? { workerTaskId: actor.workerTaskId } : {}),
        transaction: {
          id: transactionId,
          baseRevision: this.#store.revision,
          intent: input.intent,
          tool: input.tool,
          timestamp: at,
          metadata: input.link ? { lilac: input.link } : {},
          operations: input.operations,
        },
      });
      const entry = result.history.past.at(-1);
      attributed = entry.transaction;
      inverse = entry.inverse.operations;
      affectedNodeIds = [...result.summary.affectedNodeIds];
    } catch (error) {
      throw asEditError(error);
    }
    let committed: { revision: number };
    try {
      committed = this.#store.commit(attributed);
    } catch (error) {
      throw asEditError(error);
    }
    const event: ChangeEvent = {
      type: "transaction",
      revision: committed.revision,
      transactionId,
      actor: actor.actorId,
      actorKind: actor.kind,
      intent: input.intent,
      tool: input.tool,
      affectedNodeIds,
      ...(input.link?.undoOf ? { undoOf: input.link.undoOf } : {}),
      ...(input.link?.redoOf ? { redoOf: input.link.redoOf } : {}),
    };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must not affect the commit or other subscribers.
      }
    }
    return { event, inverse };
  }

  #assertOpen(): void {
    if (this.#closed) throw new StudioError(409, "project-closed", "the project is closed");
  }
}

function createProjectDirectory(root: string, name: string, title: string | undefined, at: string): void {
  const document = createDocument({ id: `doc-${randomUUID()}`, name: typeof title === "string" && title.trim() !== "" ? title.slice(0, 200) : name });
  try {
    mkdirSync(root, { mode: 0o700 });
    createProject(root, { projectId: `project-${randomUUID()}`, document, createdAt: at });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST" || (error instanceof Error && /already exists/u.test(error.message))) throw new StudioError(409, "project-exists", `project ${name} already exists`);
    throw error;
  }
}


function asEditError(error: unknown): StudioError {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  if (name === "CollaborationAuthorizationError") return new StudioError(403, "forbidden", message);
  if (name === "PersistenceLockError") return new StudioError(409, "project-locked", message);
  return new StudioError(400, "invalid-edit", message);
}
