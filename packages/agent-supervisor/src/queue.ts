import { canonicalStringify, cloneJson } from "@ninerr/agent-runtime";
import { SupervisorQueueError } from "./errors.ts";
import { MAX_QUEUE_ENTRIES, MAX_QUEUE_RECORD_BYTES, MAX_SUPERVISOR_ID_LENGTH, SUPERVISOR_SCHEMA_VERSION, type SupervisedTaskRecord, type SupervisorQueueEntry, type SupervisorQueueState } from "./types.ts";

export function createSupervisorQueue(): SupervisorQueueState {
  return { version: SUPERVISOR_SCHEMA_VERSION, nextSequence: 1, acknowledgedSequence: 0, entries: [] };
}

function assertTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value))) throw new SupervisorQueueError("queue timestamp is invalid");
}

function assertQueueIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new SupervisorQueueError(`${label} must be non-empty`);
  if (value.length > MAX_SUPERVISOR_ID_LENGTH) throw new SupervisorQueueError(`${label} exceeds ${MAX_SUPERVISOR_ID_LENGTH} characters`);
}

function assertQueueSize(encoded: string): void {
  if (new TextEncoder().encode(encoded).byteLength > MAX_QUEUE_RECORD_BYTES) {
    throw new SupervisorQueueError(`queue record exceeds ${MAX_QUEUE_RECORD_BYTES} bytes`);
  }
}

export function enqueueWake(
  queue: SupervisorQueueState,
  input: Omit<SupervisorQueueEntry, "sequence">,
): SupervisorQueueState {
  if (queue.version !== SUPERVISOR_SCHEMA_VERSION) throw new SupervisorQueueError("unsupported queue version");
  if (queue.entries.length >= MAX_QUEUE_ENTRIES) throw new SupervisorQueueError("supervisor queue is full");
  if (queue.entries.some((entry) => entry.eventId === input.eventId)) throw new SupervisorQueueError(`event ${input.eventId} is already queued`);
  assertQueueIdentity(input.eventId, "queue eventId");
  assertQueueIdentity(input.taskId, "queue taskId");
  assertQueueIdentity(input.eventKind, "queue eventKind");
  assertTimestamp(input.enqueuedAt);
  const entry: SupervisorQueueEntry = { sequence: queue.nextSequence, ...cloneJson(input) };
  return {
    version: queue.version,
    nextSequence: queue.nextSequence + 1,
    acknowledgedSequence: queue.acknowledgedSequence,
    entries: [...queue.entries, entry],
  };
}

export function nextActionableWake(queue: SupervisorQueueState): SupervisorQueueEntry | null {
  const sequence = queue.acknowledgedSequence + 1;
  const entry = queue.entries.find((candidate) => candidate.sequence === sequence);
  return entry === undefined ? null : cloneJson(entry);
}

export function acknowledgeWake(queue: SupervisorQueueState, sequence: number): SupervisorQueueState {
  const expected = queue.acknowledgedSequence + 1;
  if (sequence !== expected) {
    throw new SupervisorQueueError(`queue acknowledgement ${sequence} cannot skip expected sequence ${expected}`);
  }
  if (!queue.entries.some((entry) => entry.sequence === sequence)) {
    throw new SupervisorQueueError(`queue sequence ${sequence} does not exist`);
  }
  return { ...cloneJson(queue), acknowledgedSequence: sequence };
}

export function compactAcknowledgedWakes(queue: SupervisorQueueState): SupervisorQueueState {
  return {
    ...cloneJson(queue),
    entries: queue.entries.filter((entry) => entry.sequence > queue.acknowledgedSequence).map((entry) => cloneJson(entry)),
  };
}
export async function settleNextWake(
  queue: SupervisorQueueState,
  handler: (entry: SupervisorQueueEntry) => Promise<void>,
): Promise<SupervisorQueueState> {
  const entry = nextActionableWake(queue);
  if (entry === null) return cloneJson(queue);
  await handler(cloneJson(entry));
  return acknowledgeWake(queue, entry.sequence);
}
export function serializeSupervisorQueue(queue: SupervisorQueueState): string {
  if (queue.version !== SUPERVISOR_SCHEMA_VERSION) throw new SupervisorQueueError("unsupported queue version");
  if (!Number.isSafeInteger(queue.nextSequence) || queue.nextSequence < 1) throw new SupervisorQueueError("queue nextSequence is invalid");
  if (!Number.isSafeInteger(queue.acknowledgedSequence) || queue.acknowledgedSequence < 0) throw new SupervisorQueueError("queue acknowledgedSequence is invalid");
  if (!Array.isArray(queue.entries) || queue.entries.length > MAX_QUEUE_ENTRIES) throw new SupervisorQueueError("queue entries are invalid");
  let previous = 0;
  for (const entry of queue.entries) {
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= previous) throw new SupervisorQueueError("queue entry sequence is not strictly increasing");
    if (entry.sequence >= queue.nextSequence) throw new SupervisorQueueError("queue entry sequence reaches or exceeds nextSequence");
    assertQueueIdentity(entry.eventId, "queue eventId");
    assertQueueIdentity(entry.taskId, "queue taskId");
    assertQueueIdentity(entry.eventKind, "queue eventKind");
    assertTimestamp(entry.enqueuedAt);
    previous = entry.sequence;
  }
  if (queue.acknowledgedSequence >= queue.nextSequence) throw new SupervisorQueueError("queue acknowledgement reaches or exceeds nextSequence");
  const sequences = new Set(queue.entries.map((entry) => entry.sequence));
  for (let sequence = queue.acknowledgedSequence + 1; sequence < queue.nextSequence; sequence += 1) {
    if (!sequences.has(sequence)) {
      throw new SupervisorQueueError(`queue durable entries skip unacknowledged sequence ${sequence}`);
    }
  }
  const encoded = canonicalStringify(queue);
  assertQueueSize(encoded);
  return encoded;
}

export function deserializeSupervisorQueue(encoded: string): SupervisorQueueState {
  assertQueueSize(encoded);
  let parsed: unknown;
  try { parsed = JSON.parse(encoded); } catch { throw new SupervisorQueueError("queue record is not valid JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new SupervisorQueueError("queue record must be an object");
  const record = parsed as SupervisorQueueState;
  serializeSupervisorQueue(record);
  return cloneJson(record);
}
export interface SupervisorQueueStore {
  read(): Promise<SupervisorQueueState>;
  compareAndSwap(expected: SupervisorQueueState, next: SupervisorQueueState): Promise<boolean>;
}

export async function settleDurableWake(
  store: SupervisorQueueStore,
  withTaskLock: <T>(taskId: string, action: () => Promise<T>) => Promise<T>,
  handler: (entry: SupervisorQueueEntry) => Promise<void>,
): Promise<SupervisorQueueState> {
  const observed = await store.read();
  const candidate = nextActionableWake(observed);
  if (candidate === null) return cloneJson(observed);
  return withTaskLock(candidate.taskId, async () => {
    const current = await store.read();
    const entry = nextActionableWake(current);
    if (entry === null) return cloneJson(current);
    if (entry.sequence !== candidate.sequence || entry.taskId !== candidate.taskId) {
      return cloneJson(current);
    }
    await handler(cloneJson(entry));
    const next = acknowledgeWake(current, entry.sequence);
    if (!await store.compareAndSwap(current, next)) {
      throw new SupervisorQueueError("durable queue changed before acknowledgement publication");
    }
    return cloneJson(next);
  });
}

export interface TaskWakeCursorStore {
  read(taskId: string): Promise<SupervisedTaskRecord>;
  compareAndSwap(taskId: string, expected: SupervisedTaskRecord, next: SupervisedTaskRecord): Promise<boolean>;
}

export async function settleDurableTaskWake(
  queueStore: SupervisorQueueStore,
  taskStore: TaskWakeCursorStore,
  withTaskLock: <T>(taskId: string, action: () => Promise<T>) => Promise<T>,
  handler: (entry: SupervisorQueueEntry) => Promise<void>,
  at: string,
): Promise<SupervisorQueueState> {
  if (Number.isNaN(Date.parse(at))) throw new SupervisorQueueError("task wake settlement timestamp is invalid");
  const observed = await queueStore.read();
  const candidate = nextActionableWake(observed);
  if (candidate === null) return cloneJson(observed);
  return withTaskLock(candidate.taskId, async () => {
    const currentQueue = await queueStore.read();
    const entry = nextActionableWake(currentQueue);
    if (entry === null) return cloneJson(currentQueue);
    if (entry.sequence !== candidate.sequence || entry.taskId !== candidate.taskId) return cloneJson(currentQueue);

    const currentTask = cloneJson(await taskStore.read(entry.taskId));
    if (!Number.isSafeInteger(currentTask.wakeCursor) || currentTask.wakeCursor < 0) {
      throw new SupervisorQueueError("task wake cursor is invalid");
    }
    if (currentTask.wakeCursor < entry.sequence) {
      await handler(cloneJson(entry));
      const nextTask: SupervisedTaskRecord = { ...cloneJson(currentTask), wakeCursor: entry.sequence, updatedAt: at };
      if (!await taskStore.compareAndSwap(entry.taskId, currentTask, nextTask)) {
        throw new SupervisorQueueError("durable task changed before wake cursor publication");
      }
    }

    const nextQueue = acknowledgeWake(currentQueue, entry.sequence);
    if (!await queueStore.compareAndSwap(currentQueue, nextQueue)) {
      throw new SupervisorQueueError("durable queue changed before acknowledgement publication");
    }
    return cloneJson(nextQueue);
  });
}
