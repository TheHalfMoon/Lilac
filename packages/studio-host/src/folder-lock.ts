import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { StudioError } from "./errors.ts";

// One studio host per projects folder (#261). The folder-wide files (connected agents,
// codebase links, the discovery file MCP relays read) are each kept by one host and written
// back whole, so a second host on the same folder would silently undo the first's changes,
// and relays could find only one of them. A host therefore claims the folder when it starts
// and releases it when it closes; a second one is refused, naming the first. A claim left by
// a process that no longer runs (a crash) is taken over.

export const HOST_LOCK = ".ninerr-host.lock";

interface Holder {
  pid: number;
  nonce: string;
  /** When the claim was made, in milliseconds since the epoch (the real clock, not a host's `now`). */
  claimedAt: number;
}

function readHolder(path: string): Holder | null {
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (Number.isSafeInteger(record?.pid) && record.pid > 0 && typeof record.nonce === "string" && Number.isSafeInteger(record.claimedAt)) {
      return { pid: record.pid, nonce: record.nonce, claimedAt: record.claimedAt };
    }
  } catch {
    // Unreadable or not ours: treated as left behind.
  }
  return null;
}

/** Remove a file, quietly: a claim that cannot be removed now is left for the next start. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // See above.
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists, it is only not ours to signal.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Where the running host serves, from the discovery file it wrote, if it can be read. */
function runningUrl(projectsRoot: string): string | null {
  try {
    const url = JSON.parse(readFileSync(join(projectsRoot, ".ninerr-studio.json"), "utf8"))?.url;
    return typeof url === "string" && /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Claim `projectsRoot` for this host, or refuse with 409 `projects-folder-in-use` while another
 * running process holds it. Returns the release, which removes the claim only while it is
 * still this host's. A claim is left behind when its process stopped, or when it was made
 * before the computer last started (its process id may belong to another process by now).
 */
export function claimProjectsFolder(projectsRoot: string, startedAt: string): () => void {
  const path = join(projectsRoot, HOST_LOCK);
  const nonce = randomBytes(8).toString("hex");
  const content = `${JSON.stringify({ version: 1, pid: process.pid, nonce, startedAt, claimedAt: Date.now() })}\n`;
  const release = (): void => {
    if (readHolder(path)?.nonce === nonce) removeQuietly(path);
  };
  const bootedAt = Date.now() - uptime() * 1000;
  const live = (holder: Holder | null): holder is Holder => holder !== null && holder.claimedAt >= bootedAt && isRunning(holder.pid);
  // Written in full first, then linked into place, so no other host ever reads a half-written
  // claim; a link fails if a claim is already there.
  const temporary = `${path}.${nonce}.tmp`;
  const exists = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "EEXIST";
  /** Put the claim in place: true, or false when a claim is already there. */
  const place = (): boolean => {
    try {
      linkSync(temporary, path);
      return true;
    } catch (error) {
      if (exists(error)) return false;
    }
    // A file system without hard links (FAT, some network shares): create it exclusively.
    try {
      writeFileSync(path, content, { mode: 0o600, flag: "wx" });
      return true;
    } catch (error) {
      if (exists(error)) return false;
      throw error;
    }
  };
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (place()) return release;
      const holder = readHolder(path);
      if (live(holder)) {
        const url = runningUrl(projectsRoot);
        throw new StudioError(409, "projects-folder-in-use", `Ninerr is already running for this projects folder (process ${holder.pid}${url === null ? "" : `, at ${url}`}). Use that Ninerr, or start this one with another projects folder. If no Ninerr is running, remove ${HOST_LOCK} from the projects folder.`);
      }
      // Left by a process that has stopped: take it over, unless another host just did.
      if (readHolder(path)?.nonce === holder?.nonce) removeQuietly(path);
    }
    throw new StudioError(409, "projects-folder-in-use", "another Ninerr claimed this projects folder while this one was starting");
  } finally {
    removeQuietly(temporary);
  }
}
