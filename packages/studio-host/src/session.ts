import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LocalCollaborationRoom, createAccessPolicy, createCollaborationState } from "@lilac/collaboration";
import { createDocument } from "@lilac/document-model";
import { createHistoryState } from "@lilac/history";
import { LEGACY_PROJECT_DIRECTORY, PROJECT_FILES, createProject, migrateLegacyProject, openProject, projectLayout, type ProjectStore, type RecoveryReport } from "@lilac/persistence";
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

/**
 * One committed change, as the change stream reports it. `operations` are the committed
 * operations, so a client holding revision `revision - 1` can apply them itself.
 */
export interface ChangeEvent {
  type: "transaction";
  /** The project the change was committed to. */
  project: string;
  revision: number;
  transactionId: string;
  actor: string;
  actorKind: "user" | "agent";
  /** The actor's display name, for attribution in the editor. */
  actorName: string;
  intent: string | null;
  tool: string | null;
  affectedNodeIds: string[];
  operations: unknown[];
  undoOf?: string;
  redoOf?: string;
  revertOf?: string;
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
// Names Windows reserves for devices, with or without an extension.
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/iu;
const MAX_UNDO = 200;
// The history panel's log: the latest changes since the project was opened, without operations.
const MAX_LOG = 500;
export const MAX_OPERATIONS_PER_EDIT = 5_000;

export function assertProjectName(name: unknown): string {
  if (typeof name !== "string" || !PROJECT_NAME.test(name) || name.includes("..") || name.endsWith(".") || RESERVED_NAME.test(name)) {
    throw new StudioError(400, "invalid-project-name", "project name must be 1-64 letters, digits, dots, dashes or underscores, not end in a dot, and not be a reserved device name");
  }
  return name;
}

/**
 * One open project: the persisted store is the single writer and the only document authority;
 * collaboration authorizes and attributes each edit; undo and redo commit inverse
 * transactions, so they are themselves durable, attributed history.
 *
 * Undo stacks are per actor and live for the session only. An actor's undo applies the
 * inverse of that actor's last change; if another actor's later edit made it inapplicable,
 * history refuses it and the undo is reported as a conflict (409) and kept.
 */
export class StudioSession {
  readonly name: string;
  readonly owner: StudioActor;
  /** What opening repaired; `legacyProject` when a project from before Ninerr was migrated. */
  readonly recovery: Readonly<RecoveryReport & { legacyProject?: true }>;
  #store: ProjectStore;
  #documentId: string;
  #grants: Array<{ principalKind: "actor"; principalId: string; capabilities: string[] }>;
  #now: () => string;
  #undo = new Map<string, UndoEntry[]>();
  #redo = new Map<string, UndoEntry[]>();
  #listeners = new Set<(event: ChangeEvent) => void>();
  #log: Array<Omit<ChangeEvent, "operations">> = [];
  #closed = false;
  #failure: string | null = null;
  // The document as of the last commit, as history state for the next one. The session is
  // the store's only writer, so it is the store's document; re-deriving it from the store
  // (a clone and a full validation) on every edit cost more than the edit itself at 10,000
  // layers. The store still validates and applies every transaction itself.
  #base: { document: any; past: never[]; future: never[] } | null = null;

  private constructor(name: string, store: ProjectStore, owner: StudioActor, now: () => string, legacyMigratedFrom: number | null = null) {
    this.name = name;
    this.owner = owner;
    this.recovery = legacyMigratedFrom === null ? store.recovery : Object.freeze({ ...store.recovery, migratedFrom: legacyMigratedFrom, legacyProject: true as const });
    this.#store = store;
    this.#documentId = store.document.id;
    this.#grants = [{ principalKind: "actor", principalId: owner.actorId, capabilities: OWNER_CAPABILITIES }];
    this.#now = now;
  }

  /**
   * Open `<projectsRoot>/<name>`, creating it first when `create` is set. The project
   * directory must be a real directory inside the root, not a link to somewhere else.
   */
  static open(input: { projectsRoot: string; name: string; owner: StudioActor; create?: { title?: string }; breakStaleLock?: { reason: string }; now: () => string }): StudioSession {
    const name = assertProjectName(input.name);
    const root = `${input.projectsRoot}/${name}`;
    const at = input.now();
    if (input.create !== undefined) createProjectDirectory(root, name, input.create.title, at);
    let entry;
    try {
      entry = lstatSync(root);
    } catch {
      throw new StudioError(404, "project-not-found", `no project named ${name}`);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new StudioError(400, "invalid-project", `${name} is not a project directory inside the projects root`);
    if (input.breakStaleLock !== undefined) assertLockHolderGone(root);
    try {
      // A project from before the rename is migrated into the Ninerr format first; its
      // original directory is left unchanged next to the new one (persistence, N0-G2).
      const legacy = projectLayout(root) === "legacy" ? migrateLegacy(root, name, input.owner.actorId, at) : null;
      const store = openProject(root, { owner: input.owner.actorId, at, ...(input.breakStaleLock ? { breakStaleLock: input.breakStaleLock } : {}) });
      return new StudioSession(name, store, input.owner, input.now, legacy?.migratedFrom ?? null);
    } catch (error) {
      throw asOpenError(error, name);
    }
  }

  get documentId(): string {
    return this.#documentId;
  }

  /**
   * Replace the agents' grants (the owner's own grant is fixed). Takes effect for the next
   * commit and authorization check, so revoking an agent stops it at once.
   */
  setAgentGrants(grants: ReadonlyArray<{ principalKind: "actor"; principalId: string; capabilities: string[] }>): void {
    this.#grants = [this.#grants[0], ...grants.filter((grant) => grant.principalId !== this.owner.actorId).map((grant) => ({ ...grant, capabilities: [...grant.capabilities] }))];
  }

  /** The document access policy every MCP call is authorized against. */
  accessPolicy() {
    return createAccessPolicy(this.#documentId, this.#grants);
  }

  get document() {
    this.#assertUsable();
    return this.#store.document;
  }

  get revision(): number {
    this.#assertUsable();
    return this.#store.revision;
  }

  /** Why the project must be reopened, or null when it is healthy. */
  get failure(): string | null {
    return this.#failure;
  }

  canUndo(actor: StudioActor = this.owner): boolean {
    return (this.#undo.get(actor.actorId)?.length ?? 0) > 0;
  }

  canRedo(actor: StudioActor = this.owner): boolean {
    return (this.#redo.get(actor.actorId)?.length ?? 0) > 0;
  }

  /** The changes committed since the project was opened, newest last (at most 500). */
  get log(): ReadonlyArray<Omit<ChangeEvent, "operations">> {
    return this.#log;
  }

  onChange(listener: (event: ChangeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Commit an edit as `actor`. A stale `baseRevision` is refused rather than rebased. */
  /**
   * `provenance` (host-internal callers only, never from a request body) is kept in the
   * transaction's `metadata.lilac`, for example what an import came from.
   */
  edit(actor: StudioActor, input: EditInput, transport: "http" | "mcp" | "agent" = "http", provenance?: Record<string, unknown>, options: { undoable?: boolean } = {}): ChangeEvent {
    this.#assertUsable();
    if (input === null || typeof input !== "object" || !Number.isSafeInteger(input.baseRevision)) throw new StudioError(400, "invalid-edit", "baseRevision must be an integer");
    if (input.baseRevision !== this.#store.revision) {
      throw new StudioError(409, "stale-revision", `edit is based on revision ${input.baseRevision}; the project is at ${this.#store.revision}`);
    }
    if (!Array.isArray(input.operations) || input.operations.length === 0) throw new StudioError(400, "invalid-edit", "operations must be a non-empty array");
    if (input.operations.length > MAX_OPERATIONS_PER_EDIT) throw new StudioError(413, "too-many-operations", `an edit may hold at most ${MAX_OPERATIONS_PER_EDIT} operations`);
    const intent = typeof input.intent === "string" ? input.intent.slice(0, 500) : null;
    const tool = typeof input.tool === "string" ? input.tool.slice(0, 200) : null;
    const { event, inverse } = this.#commit(actor, transport, { operations: input.operations, intent, tool, ...(provenance ? { provenance } : {}) });
    // Bookkeeping that follows something outside the project (a written source file) is not
    // undoable: undoing it would make the project disagree with that file (#185).
    if (options.undoable === false) return event;
    this.#push(this.#undo, actor, { transactionId: event.transactionId, intent, operations: input.operations, inverse });
    this.#redo.delete(actor.actorId);
    return event;
  }

  /** Undo `actor`'s last change in this session by committing its inverse. */
  undo(actor: StudioActor): ChangeEvent {
    this.#assertUsable();
    const stack = this.#undo.get(actor.actorId);
    const entry = stack?.at(-1);
    if (entry === undefined) throw new StudioError(409, "nothing-to-undo", "there is nothing to undo");
    const { event } = this.#commit(actor, "http", { operations: entry.inverse, intent: entry.intent === null ? "Undo" : `Undo: ${entry.intent}`.slice(0, 500), tool: "lilac:undo", link: { undoOf: entry.transactionId } }, "undo-conflict");
    stack!.pop();
    this.#push(this.#redo, actor, entry);
    return event;
  }

  /** Re-apply `actor`'s last undone change. */
  redo(actor: StudioActor): ChangeEvent {
    this.#assertUsable();
    const stack = this.#redo.get(actor.actorId);
    const entry = stack?.at(-1);
    if (entry === undefined) throw new StudioError(409, "nothing-to-redo", "there is nothing to redo");
    const { event, inverse } = this.#commit(actor, "http", { operations: entry.operations, intent: entry.intent, tool: "lilac:redo", link: { redoOf: entry.transactionId } }, "redo-conflict");
    stack!.pop();
    this.#push(this.#undo, actor, { transactionId: event.transactionId, intent: entry.intent, operations: entry.operations, inverse });
    return event;
  }

  /**
   * `actor` (a person) reverts an agent's latest change in this session: its inverse is
   * committed as `actor`'s own change, linked to the reverted one. Only the agent's latest
   * change can be reverted, so its earlier changes stay consistent; a later conflicting
   * change is reported as a conflict (409).
   */
  revert(actor: StudioActor, transactionId: unknown): ChangeEvent {
    this.#assertUsable();
    if (actor.kind !== "user") throw new StudioError(403, "forbidden", "only a person can revert an agent's change");
    for (const [actorId, stack] of this.#undo) {
      const entry = stack.at(-1);
      if (entry === undefined || entry.transactionId !== transactionId) continue;
      if (actorId === actor.actorId) return this.undo(actor);
      const { event, inverse } = this.#commit(actor, "http", { operations: entry.inverse, intent: `Revert: ${entry.intent ?? "agent change"}`.slice(0, 500), tool: "lilac:revert", link: { revertOf: entry.transactionId } }, "revert-conflict");
      stack.pop();
      this.#push(this.#undo, actor, { transactionId: event.transactionId, intent: event.intent, operations: entry.inverse, inverse });
      this.#redo.delete(actor.actorId);
      return event;
    }
    throw new StudioError(409, "not-revertible", "only an agent's latest change in this session can be reverted");
  }

  checkpoint(): { revision: number } {
    this.#assertUsable();
    try {
      return { revision: this.#store.checkpoint().revision };
    } catch (error) {
      throw this.#storeFailure(error);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#store.close();
  }

  #push(stacks: Map<string, UndoEntry[]>, actor: StudioActor, entry: UndoEntry): void {
    const stack = stacks.get(actor.actorId) ?? [];
    stack.push(entry);
    if (stack.length > MAX_UNDO) stack.shift();
    stacks.set(actor.actorId, stack);
  }

  #commit(actor: StudioActor, transport: "http" | "mcp" | "agent", input: { operations: unknown[]; intent: string | null; tool: string | null; link?: { undoOf?: string; redoOf?: string; revertOf?: string }; provenance?: Record<string, unknown> }, conflictCode?: string): { event: ChangeEvent; inverse: unknown[] } {
    const at = this.#now();
    const transactionId = `tx-${randomUUID()}`;
    let attributed: Record<string, unknown>;
    let nextDocument: any;
    let inverse: unknown[];
    let affectedNodeIds: string[];
    try {
      // Collaboration authorizes the actor and attributes the transaction. The room is built
      // per commit from the session's grants: its fact log is not kept (attribution lives in
      // the persisted transaction), so commits stay O(document), not O(session length).
      const room = new LocalCollaborationRoom(createCollaborationState(this.#documentId, this.#grants));
      const result = room.commitTransaction({
        actor,
        transport,
        history: this.#baseHistory(),
        at,
        ...(actor.operationId ? { operationId: actor.operationId } : {}),
        ...(actor.workerTaskId ? { workerTaskId: actor.workerTaskId } : {}),
        transaction: {
          id: transactionId,
          baseRevision: this.#store.revision,
          intent: input.intent,
          tool: input.tool,
          timestamp: at,
          // How the change arrived (editor, MCP), with its undo/redo/revert link, kept durably.
          metadata: { lilac: { transport, ...(input.link ?? {}), ...(input.provenance ? { provenance: input.provenance } : {}) } },
          operations: input.operations,
        },
      });
      const entry = result.history.past.at(-1);
      nextDocument = result.history.document;
      attributed = entry.transaction;
      inverse = entry.inverse.operations;
      affectedNodeIds = [...result.summary.affectedNodeIds];
    } catch (error) {
      throw asEditError(error, conflictCode);
    }
    let committed: { revision: number };
    try {
      committed = this.#store.commit(attributed);
    } catch (error) {
      this.#base = null;
      throw this.#storeFailure(error);
    }
    // The room applied the same transaction to the same document the store holds.
    this.#base = { document: nextDocument, past: [], future: [] };
    const event: ChangeEvent = {
      type: "transaction",
      project: this.name,
      revision: committed.revision,
      transactionId,
      actor: actor.actorId,
      actorKind: actor.kind,
      actorName: actor.displayName,
      intent: input.intent,
      tool: input.tool,
      affectedNodeIds,
      operations: attributed.operations as unknown[],
      ...(input.link?.undoOf ? { undoOf: input.link.undoOf } : {}),
      ...(input.link?.redoOf ? { redoOf: input.link.redoOf } : {}),
      ...(input.link?.revertOf ? { revertOf: input.link.revertOf } : {}),
    };
    const { operations: _operations, ...summary } = event;
    this.#log.push(summary);
    if (this.#log.length > MAX_LOG) this.#log.shift();
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must not affect the commit or other subscribers.
      }
    }
    return { event, inverse };
  }

  // The store refused or failed to write: an edit the collaboration layer accepted that the
  // store's own validation rejects is still the client's fault; anything else means the
  // project must be reopened, and nothing about the filesystem is reported to the client.
  #storeFailure(error: unknown): StudioError {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : "";
    // A failed journal write poisons the store whatever its message says (#185): the project
    // must be reopened, never reported as the client's invalid edit.
    const storeBroken = this.#store.needsReopen || /reopen|changed outside|modified outside|replaced|changed since|no longer holds|changed while|lock/iu.test(message);
    if ((name === "PersistenceValidationError" || name === "PersistenceCorruptionError") && !storeBroken) {
      return new StudioError(400, "invalid-edit", message.slice(0, 300));
    }
    this.#failure = "the project's files changed or could not be written; reopen the project";
    return new StudioError(409, "project-needs-reopen", this.#failure);
  }

  #baseHistory() {
    if (this.#base === null || this.#base.document.revision !== this.#store.revision) {
      this.#base = createHistoryState(this.#store.document) as any;
    }
    return this.#base;
  }

  #assertUsable(): void {
    if (this.#closed) throw new StudioError(409, "project-closed", "the project is closed");
    if (this.#failure !== null) throw new StudioError(409, "project-needs-reopen", this.#failure);
  }
}

/** Refuse to break a lock whose holder is a process still running on this machine. */
function assertLockHolderGone(root: string): void {
  const lockPath = join(root, PROJECT_FILES.directory, PROJECT_FILES.lock);
  let pid: unknown;
  try {
    // Only a small regular file is read; links, FIFOs and anything odd are left to
    // persistence's own lock handling.
    const entry = lstatSync(lockPath);
    if (!entry.isFile() || entry.size > 4096) return;
    const fd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      pid = JSON.parse(readFileSync(fd, "utf8").slice(0, 4096)).pid;
    } finally {
      closeSync(fd);
    }
  } catch {
    return; // an unreadable lock is exactly what an override is for
  }
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return;
  let alive = false;
  try {
    process.kill(pid as number, 0);
    alive = true;
  } catch (error) {
    alive = (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
  // Our own pid holding it means another session in this process: still live.
  if (alive) throw new StudioError(409, "lock-held-by-live-process", "the project is open in a process that is still running");
}

function createProjectDirectory(root: string, name: string, title: string | undefined, at: string): void {
  const document = createDocument({ id: `doc-${randomUUID()}`, name: typeof title === "string" && title.trim() !== "" ? title.slice(0, 200) : name });
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw new StudioError(409, "project-exists", `${name} already exists`);
    throw error;
  }
  try {
    createProject(root, { projectId: `project-${randomUUID()}`, document, createdAt: at });
  } catch (error) {
    // Do not leave an empty directory that would block the name.
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

// Messages are passed through only for errors whose messages are fixed, path-free
// descriptions of the request; anything else becomes the generic internal error.
const CLIENT_ERRORS = new Set(["TransactionError", "DocumentInvariantError", "CollaborationValidationError"]);

function asEditError(error: unknown, conflictCode?: string): Error {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.slice(0, 300) : "";
  if (name === "CollaborationAuthorizationError") return new StudioError(403, "forbidden", message);
  if (CLIENT_ERRORS.has(name)) return conflictCode ? new StudioError(409, conflictCode, `the change can no longer be applied: ${message}`) : new StudioError(400, "invalid-edit", message);
  if (error instanceof RangeError) return new StudioError(400, "invalid-edit", "the edit is too deeply nested");
  return error instanceof Error ? error : new Error("edit failed");
}

/**
 * Migrate a legacy project before it is opened. A legacy lock is never overridden: it means
 * the earlier release has the project open, or crashed while it did, so the person is told
 * that rather than offered a takeover. When another host migrated it meanwhile, it is opened.
 */
function migrateLegacy(root: string, name: string, owner: string, at: string): ReturnType<typeof migrateLegacyProject> | null {
  try {
    return migrateLegacyProject(root, { owner, at });
  } catch (error) {
    const kind = error instanceof Error ? error.name : "";
    if (kind === "PersistenceLockError") {
      throw new StudioError(409, "legacy-project-locked", `${name} was made before the rename to Ninerr and is open in the earlier release. Close it there and open it here again. If the earlier release is not running, its lock was left by a crash: remove ${name}/${LEGACY_PROJECT_DIRECTORY}/${PROJECT_FILES.lock} and open it again.`);
    }
    if (kind === "PersistenceValidationError" && /Ninerr project already exists/u.test(error instanceof Error ? error.message : "")) return null;
    throw error;
  }
}

function asOpenError(error: unknown, name: string): Error {
  const kind = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (kind === "PersistenceLockError") return new StudioError(409, "project-locked", message.slice(0, 300));
  if (kind === "PersistenceValidationError" && /no Ninerr project exists/u.test(message)) return new StudioError(404, "project-not-found", `no project named ${name}`);
  if (kind === "PersistenceVersionError") return new StudioError(422, "project-version", message.slice(0, 300));
  if (kind === "PersistenceCorruptionError" || kind === "PersistenceValidationError") return new StudioError(422, "project-unreadable", message.slice(0, 300));
  return error instanceof Error ? error : new Error("open failed");
}
