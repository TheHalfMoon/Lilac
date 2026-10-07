import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SupervisorOwnershipError, SupervisorRecordError, SupervisorRuntimeError, SupervisorWorktreeError } from "./errors.ts";
import { deserializeTaskRecord, serializeTaskRecord } from "./records.ts";
import { deserializeSupervisorQueue, serializeSupervisorQueue, type SupervisorQueueStore } from "./queue.ts";
import { canonicalStringify, cloneJson } from "@lilac/agent-runtime";
import type { RecoveryJournalStore, RuntimeAdapter, SupervisorLockAdapter, TaskStore } from "./supervisor.ts";
import type { LeaseLivenessEvidence, RecoveryJournal, RuntimeEndpointIdentity, RuntimeEvidence, SupervisedTaskRecord, SupervisorLease, SupervisorQueueState, WorktreeEvidence } from "./types.ts";

// Code-unit string order: unlike localeCompare, independent of the process locale.
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

const execFileAsync = promisify(execFile);

// An inspected worktree is untrusted, and Git reads that worktree's own config: core.fsmonitor
// is a command `git status` runs, and filter drivers can run during status. Every command
// therefore runs with repository-controlled execution switched off on the command line
// (which outranks repository config), with no system or global config, and with Git's
// environment overrides removed.
const GIT_ENV_OVERRIDES = /^GIT_/u;

function inspectionEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!GIT_ENV_OVERRIDES.test(key)) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

const SAFE_GIT_OPTIONS = [
  "-c", "core.fsmonitor=false",
  "-c", `core.hooksPath=${devNull}`,
  "-c", "core.untrackedCache=false",
  "-c", "core.pager=cat",
  "-c", "diff.external=",
  "--no-optional-locks",
];

async function runGit(cwd: string, options: string[], args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...SAFE_GIT_OPTIONS, ...options, ...args], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: inspectionEnvironment(),
    });
    return stdout;
  } catch (error) {
    throw new SupervisorWorktreeError(error instanceof Error ? error.message : "Git inspection failed");
  }
}

// Filter driver names are chosen by the repository, so they are read from its config (a
// read executes nothing) and each driver's commands are overridden to empty, which Git
// treats as no filter.
async function filterOverrides(cwd: string): Promise<string[]> {
  let listing = "";
  try {
    listing = await runGit(cwd, [], ["config", "--includes", "--name-only", "--get-regexp", "^filter\\."]);
  } catch {
    return [];
  }
  const drivers = new Set<string>();
  for (const key of listing.split("\n")) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/u.exec(key.trim());
    if (match) drivers.add(match[1]);
  }
  return [...drivers].flatMap((driver) => [
    "-c", `filter.${driver}.clean=`, "-c", `filter.${driver}.smudge=`, "-c", `filter.${driver}.process=`, "-c", `filter.${driver}.required=false`,
  ]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  return runGit(cwd, await filterOverrides(cwd), args);
}

export class GitWorktreeInspector {
  async inspect(worktreePath: string): Promise<WorktreeEvidence> {
    let stat;
    try {
      stat = await lstat(worktreePath);
    } catch {
      return {
        exists: false,
        repositoryId: "",
        isGitWorktree: false,
        isWorktreeRoot: false,
        canonicalPath: worktreePath,
        branch: "",
        head: "",
        dirty: false,
        dirtyDigest: "",
      };
    }
    if (stat.isSymbolicLink()) throw new SupervisorWorktreeError("recorded worktree path must not be a symbolic link");
    const canonicalPath = await realpath(worktreePath);
    const inside = (await git(canonicalPath, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
    const topLevel = (await git(canonicalPath, ["rev-parse", "--show-toplevel"])).trim();
    const canonicalTopLevel = await realpath(topLevel);
    const commonDir = (await git(canonicalPath, ["rev-parse", "--git-common-dir"])).trim();
    const repositoryId = await realpath(resolve(canonicalPath, commonDir));
    const branch = (await git(canonicalPath, ["branch", "--show-current"])).trim();
    const head = (await git(canonicalPath, ["rev-parse", "HEAD"])).trim();
    // Submodule worktrees carry their own config, whose filters are not overridden here, so
    // status compares submodule commits without running Git inside them.
    const status = await git(canonicalPath, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=dirty"]);
    const dirtyDigest = createHash("sha256").update(status, "utf8").digest("hex");
    return {
      exists: true,
      repositoryId,
      isGitWorktree: inside,
      isWorktreeRoot: canonicalPath === canonicalTopLevel,
      canonicalPath,
      branch,
      head,
      dirty: status.length !== 0,
      dirtyDigest,
    };
  }
}
export interface TaskMetadataFileType {
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

export function assertTaskMetadataFileType(stat: TaskMetadataFileType): void {
  if (stat.isSymbolicLink()) throw new SupervisorRecordError("durable task metadata must not be a symbolic link");
  if (!stat.isFile()) throw new SupervisorRecordError("durable task metadata must be a regular file");
}

function taskFileName(taskId: string): string {
  return `${createHash("sha256").update(taskId, "utf8").digest("hex")}.task.json`;
}

async function writeExclusiveDurable(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.next`;
  try {
    await writeExclusiveDurable(temporary, content);
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch { /* scratch file may not exist */ }
    throw error;
  }
}
export class FileTaskStore implements TaskStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private path(taskId: string): string {
    return join(this.directory, taskFileName(taskId));
  }

  async create(task: SupervisedTaskRecord): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });
    const path = this.path(task.taskId);
    try {
      await writeExclusiveDurable(path, serializeTaskRecord(task));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  async writeInitial(task: SupervisedTaskRecord): Promise<void> {
    if (!await this.create(task)) throw new SupervisorRecordError(`durable task ${task.taskId} already exists`);
  }

  async list(): Promise<SupervisedTaskRecord[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const tasks: SupervisedTaskRecord[] = [];
    for (const entry of entries.sort((a, b) => compareCodeUnits(a.name, b.name))) {
      if (!entry.name.endsWith(".task.json")) continue;
      const path = join(this.directory, entry.name);
      const stat = await lstat(path);
      assertTaskMetadataFileType(stat);
      const task = deserializeTaskRecord(await readFile(path, "utf8"));
      if (taskFileName(task.taskId) !== entry.name) {
        throw new SupervisorRecordError("durable task filename does not match its task identity");
      }
      tasks.push(task);
    }
    return tasks.sort((a, b) => compareCodeUnits(a.taskId, b.taskId));
  }

  async read(taskId: string): Promise<SupervisedTaskRecord> {
    const path = this.path(taskId);
    const stat = await lstat(path);
    assertTaskMetadataFileType(stat);
    const encoded = await readFile(path, "utf8");
    const task = deserializeTaskRecord(encoded);
    if (task.taskId !== taskId) throw new SupervisorRecordError("durable task file identity does not match requested taskId");
    return task;
  }

  async compareAndSwap(taskId: string, expected: SupervisedTaskRecord, next: SupervisedTaskRecord): Promise<boolean> {
    const current = await this.read(taskId);
    if (serializeTaskRecord(current) !== serializeTaskRecord(expected)) return false;
    if (next.taskId !== taskId) throw new SupervisorRecordError("replacement durable task identity differs from requested taskId");
    await writeAtomic(this.path(taskId), serializeTaskRecord(next));
    return true;
  }
}
export class FileRecoveryJournalStore implements RecoveryJournalStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async write(journal: RecoveryJournal): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const name = `${createHash("sha256").update(journal.recoveryId, "utf8").digest("hex")}.recovery.json`;
    const path = join(this.directory, name);
    const content = canonicalStringify(journal);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new SupervisorRecordError("recovery journal must not be a symbolic link");
      await writeAtomic(path, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await writeExclusiveDurable(path, content);
        return;
      }
      throw error;
    }
  }
}
export type LeaseClassifier = (lease: SupervisorLease) => Promise<LeaseLivenessEvidence>;

export class TaskMutationMutex implements SupervisorLockAdapter {
  private readonly ownerGenerationId: string;
  private readonly classifier: LeaseClassifier;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(ownerGenerationId: string, classifier: LeaseClassifier) {
    this.ownerGenerationId = ownerGenerationId;
    this.classifier = classifier;
  }

  async isMutationOwner(supervisorGenerationId: string): Promise<boolean> {
    return supervisorGenerationId === this.ownerGenerationId;
  }

  async classifyLease(lease: SupervisorLease): Promise<LeaseLivenessEvidence> {
    return cloneJson(await this.classifier(cloneJson(lease)));
  }
  async withTaskMutationLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    if (!taskId) throw new SupervisorOwnershipError("task mutation lock requires taskId");
    const previous = this.tails.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(taskId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(taskId) === tail) this.tails.delete(taskId);
    }
  }
}
export class FileQueueStore implements SupervisorQueueStore {
  private readonly directory: string;
  private readonly path: string;

  constructor(directory: string) {
    this.directory = directory;
    this.path = join(directory, "supervisor.queue.json");
  }

  async writeInitial(queue: SupervisorQueueState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeExclusiveDurable(this.path, serializeSupervisorQueue(queue));
  }

  async read(): Promise<SupervisorQueueState> {
    const stat = await lstat(this.path);
    if (stat.isSymbolicLink()) throw new SupervisorRecordError("durable queue metadata must not be a symbolic link");
    if (!stat.isFile()) throw new SupervisorRecordError("durable queue metadata must be a regular file");
    return deserializeSupervisorQueue(await readFile(this.path, "utf8"));
  }

  async compareAndSwap(expected: SupervisorQueueState, next: SupervisorQueueState): Promise<boolean> {
    const current = await this.read();
    if (serializeSupervisorQueue(current) !== serializeSupervisorQueue(expected)) return false;
    await writeAtomic(this.path, serializeSupervisorQueue(next));
    return true;
  }
}

interface SupervisorOwnerRecord {
  version: 1;
  generationId: string;
  pid: number;
  acquiredAt: string;
}

interface TaskLockRecord extends SupervisorOwnerRecord {
  taskId: string;
}

function assertLockId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new SupervisorOwnershipError(`${label} must be a bounded non-empty string`);
  }
}

function validatePid(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 1) {
    throw new SupervisorOwnershipError(`${label} must be a process id greater than 1`);
  }
  return value as number;
}

function processLiveness(pid: number): "live" | "stale" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "stale";
    if (code === "EPERM" || code === "EACCES") return "live";
    return "unknown";
  }
}

function parseOwnerRecord(encoded: string): SupervisorOwnerRecord {
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw new SupervisorOwnershipError("supervisor owner lock is malformed JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SupervisorOwnershipError("supervisor owner lock must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "acquiredAt,generationId,pid,version") {
    throw new SupervisorOwnershipError("supervisor owner lock has unsupported fields");
  }
  if (record.version !== 1) throw new SupervisorOwnershipError("supervisor owner lock version is unsupported");
  assertLockId(record.generationId, "supervisor generationId");
  const pid = validatePid(record.pid, "supervisor owner pid");
  if (typeof record.acquiredAt !== "string" || Number.isNaN(Date.parse(record.acquiredAt))) {
    throw new SupervisorOwnershipError("supervisor owner acquiredAt must be a timestamp");
  }
  return { version: 1, generationId: record.generationId, pid, acquiredAt: record.acquiredAt };
}

function parseTaskLockRecord(encoded: string): TaskLockRecord {
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw new SupervisorOwnershipError("task mutation lock is malformed JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SupervisorOwnershipError("task mutation lock must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "acquiredAt,generationId,pid,taskId,version") {
    throw new SupervisorOwnershipError("task mutation lock has unsupported fields");
  }
  if (record.version !== 1) throw new SupervisorOwnershipError("task mutation lock version is unsupported");
  assertLockId(record.generationId, "task lock generationId");
  assertLockId(record.taskId, "task lock taskId");
  const pid = validatePid(record.pid, "task lock pid");
  if (typeof record.acquiredAt !== "string" || Number.isNaN(Date.parse(record.acquiredAt))) {
    throw new SupervisorOwnershipError("task lock acquiredAt must be a timestamp");
  }
  return { version: 1, generationId: record.generationId, taskId: record.taskId, pid, acquiredAt: record.acquiredAt };
}

async function readRegularLock(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SupervisorOwnershipError("supervisor lock path must be a regular non-symlink file");
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function createExclusiveLock(path: string, content: string): Promise<boolean> {
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export class FileSupervisorLockAdapter implements SupervisorLockAdapter {
  private readonly directory: string;
  private readonly ownerPath: string;
  private readonly generationId: string;
  private readonly pid: number;
  private readonly acquiredAt: string;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly tails = new Map<string, Promise<void>>();

  private constructor(directory: string, generationId: string, acquiredAt: string, timeoutMs: number, pollMs: number) {
    this.directory = directory;
    this.ownerPath = join(directory, ".supervisor-owner.lock");
    this.generationId = generationId;
    this.pid = process.pid;
    this.acquiredAt = acquiredAt;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
  }

  static async acquire(
    directory: string,
    generationId: string,
    acquiredAt: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<FileSupervisorLockAdapter> {
    assertLockId(generationId, "supervisor generationId");
    if (Number.isNaN(Date.parse(acquiredAt))) throw new SupervisorOwnershipError("supervisor acquiredAt must be a timestamp");
    const timeoutMs = options.timeoutMs ?? 5000;
    const pollMs = options.pollMs ?? 10;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
      throw new SupervisorOwnershipError("supervisor lock timing options are invalid");
    }
    await mkdir(directory, { recursive: true });
    const adapter = new FileSupervisorLockAdapter(directory, generationId, acquiredAt, timeoutMs, pollMs);
    const desired: SupervisorOwnerRecord = { version: 1, generationId, pid: process.pid, acquiredAt };
    for (;;) {
      if (await createExclusiveLock(adapter.ownerPath, canonicalStringify(desired))) return adapter;
      const encoded = await readRegularLock(adapter.ownerPath);
      if (encoded === null) continue;
      const existing = parseOwnerRecord(encoded);
      const liveness = processLiveness(existing.pid);
      if (liveness === "live") {
        throw new SupervisorOwnershipError(`supervisor generation ${existing.generationId} already owns mutation authority`);
      }
      if (liveness === "unknown") {
        throw new SupervisorOwnershipError("existing supervisor owner liveness is unknown; acquisition refused");
      }
      try { await unlink(adapter.ownerPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async isMutationOwner(supervisorGenerationId: string): Promise<boolean> {
    if (supervisorGenerationId !== this.generationId) return false;
    const encoded = await readRegularLock(this.ownerPath);
    if (encoded === null) return false;
    const current = parseOwnerRecord(encoded);
    return current.generationId === this.generationId
      && current.pid === this.pid
      && processLiveness(current.pid) === "live";
  }

  async classifyLease(lease: SupervisorLease): Promise<LeaseLivenessEvidence> {
    const encoded = await readRegularLock(this.ownerPath);
    if (encoded === null) return { status: "unknown", ownerId: lease.ownerId, generationId: lease.generationId };
    const current = parseOwnerRecord(encoded);
    const liveness = processLiveness(current.pid);
    if (liveness !== "live") return { status: "unknown", ownerId: lease.ownerId, generationId: lease.generationId };
    return {
      status: current.generationId === lease.generationId ? "live" : "stale",
      ownerId: lease.ownerId,
      generationId: lease.generationId,
    };
  }

  private taskLockPath(taskId: string): string {
    const digest = createHash("sha256").update(taskId, "utf8").digest("hex");
    return join(this.directory, `.task-${digest}.lock`);
  }

  private async acquireTaskFileLock(taskId: string): Promise<string> {
    assertLockId(taskId, "taskId");
    const path = this.taskLockPath(taskId);
    const desired: TaskLockRecord = {
      version: 1,
      generationId: this.generationId,
      taskId,
      pid: this.pid,
      acquiredAt: this.acquiredAt,
    };
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (!await this.isMutationOwner(this.generationId)) {
        throw new SupervisorOwnershipError("non-owner supervisor generation cannot acquire task mutation lock");
      }
      if (await createExclusiveLock(path, canonicalStringify(desired))) return path;
      const encoded = await readRegularLock(path);
      if (encoded === null) continue;
      const existing = parseTaskLockRecord(encoded);
      const liveness = processLiveness(existing.pid);
      if (liveness === "stale") {
        try { await unlink(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        continue;
      }
      if (liveness === "unknown") throw new SupervisorOwnershipError("task lock owner liveness is unknown; mutation refused");
      if (Date.now() >= deadline) throw new SupervisorOwnershipError(`timed out waiting for task mutation lock ${taskId}`);
      await delay(this.pollMs);
    }
  }

  async withTaskMutationLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    assertLockId(taskId, "taskId");
    const previous = this.tails.get(taskId) ?? Promise.resolve();
    let releaseTail!: () => void;
    const gate = new Promise<void>((resolve) => { releaseTail = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(taskId, tail);
    await previous;
    let lockPath: string | null = null;
    try {
      lockPath = await this.acquireTaskFileLock(taskId);
      return await action();
    } finally {
      try {
        if (lockPath !== null) {
          const encoded = await readRegularLock(lockPath);
          if (encoded !== null) {
            const current = parseTaskLockRecord(encoded);
            if (current.generationId !== this.generationId || current.pid !== this.pid || current.taskId !== taskId) {
              throw new SupervisorOwnershipError("task mutation lock identity changed before release");
            }
            await unlink(lockPath);
          }
        }
      } finally {
        releaseTail();
        if (this.tails.get(taskId) === tail) this.tails.delete(taskId);
      }
    }
  }

  async release(): Promise<void> {
    const encoded = await readRegularLock(this.ownerPath);
    if (encoded === null) return;
    const current = parseOwnerRecord(encoded);
    if (current.generationId !== this.generationId || current.pid !== this.pid) {
      throw new SupervisorOwnershipError("cannot release another supervisor generation's owner lock");
    }
    await unlink(this.ownerPath);
  }
}


export interface LocalRuntimeProfile {
  executable: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
  interrupt?: (pid: number) => Promise<void>;
  interruptSignal?: NodeJS.Signals;
  stopSignal?: NodeJS.Signals;
}

interface LocalEndpointRecord {
  version: 1;
  endpointId: string;
  taskId: string;
  runtimeProfileId: string;
  supervisorGenerationId: string;
  pid: number;
  cwd: string;
  state: "running" | "stopped";
  attachedAt: string;
}

function endpointFileName(endpointId: string): string {
  return `${createHash("sha256").update(endpointId, "utf8").digest("hex")}.endpoint.json`;
}

function validateEndpointRecord(value: unknown): LocalEndpointRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SupervisorRecordError("local endpoint record must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "attachedAt,cwd,endpointId,pid,runtimeProfileId,state,supervisorGenerationId,taskId,version") {
    throw new SupervisorRecordError("local endpoint record has unsupported fields");
  }
  if (record.version !== 1) throw new SupervisorRecordError("local endpoint record version is unsupported");
  for (const [label, field] of [
    ["endpointId", record.endpointId],
    ["taskId", record.taskId],
    ["runtimeProfileId", record.runtimeProfileId],
    ["supervisorGenerationId", record.supervisorGenerationId],
    ["cwd", record.cwd],
  ] as const) {
    if (typeof field !== "string" || field.trim() === "" || field.length > 4096) {
      throw new SupervisorRecordError(`local endpoint ${label} must be a bounded non-empty string`);
    }
  }
  const pid = validatePid(record.pid, "local endpoint pid");
  if (record.state !== "running" && record.state !== "stopped") {
    throw new SupervisorRecordError("local endpoint state is unsupported");
  }
  if (typeof record.attachedAt !== "string" || Number.isNaN(Date.parse(record.attachedAt))) {
    throw new SupervisorRecordError("local endpoint attachedAt must be a timestamp");
  }
  return {
    version: 1,
    endpointId: record.endpointId,
    taskId: record.taskId,
    runtimeProfileId: record.runtimeProfileId,
    supervisorGenerationId: record.supervisorGenerationId,
    pid,
    cwd: record.cwd,
    state: record.state,
    attachedAt: record.attachedAt,
  };
}

export class LocalProcessRuntimeAdapter implements RuntimeAdapter {
  readonly recoveryGrade = true;
  private readonly directory: string;
  private readonly profiles: Readonly<Record<string, LocalRuntimeProfile>>;
  private readonly stopTimeoutMs: number;
  private readonly pollMs: number;
  private readonly launchedPids = new Map<string, number>();
  private readonly launchedChildren = new Map<string, ChildProcess>();

  constructor(
    directory: string,
    profiles: Readonly<Record<string, LocalRuntimeProfile>>,
    options: { stopTimeoutMs?: number; pollMs?: number } = {},
  ) {
    this.directory = directory;
    this.profiles = profiles;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5000;
    this.pollMs = options.pollMs ?? 20;
    if (!Number.isFinite(this.stopTimeoutMs) || this.stopTimeoutMs < 0 || !Number.isFinite(this.pollMs) || this.pollMs <= 0) {
      throw new SupervisorRuntimeError("local runtime timing options are invalid");
    }
  }

  private path(endpointId: string): string {
    assertLockId(endpointId, "endpointId");
    return join(this.directory, endpointFileName(endpointId));
  }

  private async read(endpointId: string): Promise<LocalEndpointRecord | null> {
    const path = this.path(endpointId);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new SupervisorRecordError("local endpoint metadata must be a regular non-symlink file");
      }
      return validateEndpointRecord(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw new SupervisorRecordError("local endpoint metadata is malformed JSON");
      throw error;
    }
  }

  private async write(record: LocalEndpointRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeAtomic(this.path(record.endpointId), canonicalStringify(record));
  }

  async inspect(endpoint: RuntimeEndpointIdentity): Promise<RuntimeEvidence> {
    if (endpoint.backend !== "local-process") throw new SupervisorRuntimeError("local runtime only accepts local-process endpoints");
    const record = await this.read(endpoint.endpointId);
    if (record === null) return { state: "missing", endpointId: null, cwd: null, absenceProven: false };
    if (record.endpointId !== endpoint.endpointId) throw new SupervisorRuntimeError("local endpoint record identity mismatch");
    if (record.state === "stopped") {
      return { state: "dead", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
    }
    const liveness = processLiveness(record.pid);
    if (liveness === "live") {
      if (this.launchedPids.get(record.endpointId) === record.pid) {
        return { state: "alive", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
      }
      return { state: "unknown", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
    }
    if (liveness === "unknown") return { state: "unknown", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
    this.launchedPids.delete(record.endpointId);
    return { state: "dead", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
  }

  async launch(input: {
    taskId: string;
    runtimeProfileId: string;
    worktreePath: string;
    endpoint: RuntimeEndpointIdentity;
    supervisorGenerationId: string;
  }): Promise<RuntimeEvidence> {
    if (input.endpoint.backend !== "local-process") throw new SupervisorRuntimeError("local runtime only accepts local-process endpoints");
    const profile = this.profiles[input.runtimeProfileId];
    if (profile === undefined) throw new SupervisorRuntimeError(`unknown local runtime profile ${input.runtimeProfileId}`);
    if (typeof profile.executable !== "string" || profile.executable.trim() === "") {
      throw new SupervisorRuntimeError("local runtime profile executable must be non-empty");
    }
    if (!Array.isArray(profile.args) || profile.args.some((arg) => typeof arg !== "string")) {
      throw new SupervisorRuntimeError("local runtime profile args must be an array of strings");
    }
    const canonicalWorktree = await realpath(input.worktreePath);
    if (canonicalWorktree !== input.worktreePath) throw new SupervisorRuntimeError("local runtime worktree path must be canonical");
    await mkdir(this.directory, { recursive: true });
    const path = this.path(input.endpoint.endpointId);
    if (await readRegularLock(path) !== null) throw new SupervisorRuntimeError("local runtime endpoint identity already exists");
    const child = spawn(profile.executable, [...profile.args], {
      cwd: canonicalWorktree,
      env: profile.environment === undefined ? Object.create(null) : { ...profile.environment },
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      detached: false,
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { child.removeListener("spawn", onSpawn); reject(error); };
      const onSpawn = () => { child.removeListener("error", onError); resolve(); };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    if (!Number.isSafeInteger(child.pid) || (child.pid as number) <= 1) {
      try { child.kill(profile.stopSignal ?? "SIGTERM"); } catch { /* no durable endpoint was published */ }
      throw new SupervisorRuntimeError("local runtime did not expose a valid process id");
    }
    const childPid = child.pid as number;
    this.launchedPids.set(input.endpoint.endpointId, childPid);
    this.launchedChildren.set(input.endpoint.endpointId, child);
    child.once("close", () => {
      if (this.launchedPids.get(input.endpoint.endpointId) === childPid) this.launchedPids.delete(input.endpoint.endpointId);
      if (this.launchedChildren.get(input.endpoint.endpointId) === child) this.launchedChildren.delete(input.endpoint.endpointId);
    });
    child.unref();
    const record: LocalEndpointRecord = {
      version: 1,
      endpointId: input.endpoint.endpointId,
      taskId: input.taskId,
      runtimeProfileId: input.runtimeProfileId,
      supervisorGenerationId: input.supervisorGenerationId,
      pid: childPid,
      cwd: canonicalWorktree,
      state: "running",
      attachedAt: input.endpoint.attachedAt,
    };
    try {
      await writeExclusiveDurable(path, canonicalStringify(record));
    } catch (error) {
      this.launchedPids.delete(input.endpoint.endpointId);
      try { process.kill(record.pid, profile.stopSignal ?? "SIGTERM"); } catch { /* abort cleanup only */ }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SupervisorRuntimeError("local runtime endpoint identity was published concurrently");
      throw error;
    }
    return this.inspect(input.endpoint);
  }

  async interrupt(endpoint: RuntimeEndpointIdentity): Promise<RuntimeEvidence> {
    if (endpoint.backend !== "local-process") throw new SupervisorRuntimeError("local runtime only accepts local-process endpoints");
    const record = await this.read(endpoint.endpointId);
    if (record === null) return { state: "missing", endpointId: null, cwd: null, absenceProven: false };
    if (record.state !== "running") return { state: "dead", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
    const profile = this.profiles[record.runtimeProfileId];
    if (profile === undefined) throw new SupervisorRuntimeError(`unknown local runtime profile ${record.runtimeProfileId}`);
    if (processLiveness(record.pid) !== "live") return this.inspect(endpoint);
    if (this.launchedPids.get(record.endpointId) !== record.pid) {
      return { state: "unknown", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
    }
    if (profile.interrupt !== undefined) {
      await profile.interrupt(record.pid);
    } else {
      try { process.kill(record.pid, profile.interruptSignal ?? "SIGINT"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await delay(this.pollMs);
    return this.inspect(endpoint);
  }

  async stop(endpoint: RuntimeEndpointIdentity): Promise<RuntimeEvidence> {
    if (endpoint.backend !== "local-process") throw new SupervisorRuntimeError("local runtime only accepts local-process endpoints");
    const record = await this.read(endpoint.endpointId);
    if (record === null) return { state: "missing", endpointId: null, cwd: null, absenceProven: false };
    if (record.state === "stopped") return { state: "dead", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
    const profile = this.profiles[record.runtimeProfileId];
    if (profile === undefined) throw new SupervisorRuntimeError(`unknown local runtime profile ${record.runtimeProfileId}`);
    const before = processLiveness(record.pid);
    if (before === "unknown") return { state: "unknown", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
    const child = this.launchedChildren.get(record.endpointId);
    let closed = child === undefined;
    const closePromise = child === undefined ? null : new Promise<void>((resolve) => {
      child.once("close", () => { closed = true; resolve(); });
    });
    const deadline = Date.now() + this.stopTimeoutMs;
    if (before === "live") {
      if (this.launchedPids.get(record.endpointId) !== record.pid) {
        return { state: "unknown", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
      }
      try { process.kill(record.pid, profile.stopSignal ?? "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      while (processLiveness(record.pid) === "live" && Date.now() < deadline) await delay(this.pollMs);
      const after = processLiveness(record.pid);
      if (after === "live") return { state: "alive", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
      if (after === "unknown") return { state: "unknown", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
    }
    if (closePromise !== null && !closed) {
      const remaining = Math.max(0, deadline - Date.now());
      const closeCompleted = await Promise.race([
        closePromise.then(() => true),
        delay(remaining).then(() => false),
      ]);
      if (!closeCompleted) {
        return { state: "unknown", endpointId: record.endpointId, cwd: record.cwd, absenceProven: false };
      }
    }
    const stopped: LocalEndpointRecord = { ...record, state: "stopped" };
    await this.write(stopped);
    this.launchedPids.delete(record.endpointId);
    this.launchedChildren.delete(record.endpointId);
    return { state: "dead", endpointId: stopped.endpointId, cwd: stopped.cwd, absenceProven: false };
  }
}
