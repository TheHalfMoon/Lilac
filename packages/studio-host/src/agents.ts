import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StudioError } from "./errors.ts";
import { LEGACY_AGENT_REGISTRY_FILE, LEGACY_AGENT_TOKEN_PREFIX, existing, registrySource } from "./legacy.ts";
import type { StudioActor } from "./session.ts";

// Agents the person has connected to Ninerr. Each gets its own credential, shown once when
// it is created; only the credential's sha256 is stored, in `<projectsRoot>/.ninerr-agents.json`
// (owner-only permissions), so a connected MCP client keeps working across launches and a
// leaked registry reveals no credential. An agent acts as itself (kind "agent"), owned by
// the person who connected it; revoking it takes effect immediately.

export const AGENT_CAPABILITIES = Object.freeze(["read", "document-write", "comments"]);
const REGISTRY_FILE = ".ninerr-agents.json";
const TOKEN_PREFIX = "ninerr_agent_";
/** Present once the legacy registry has been imported; it is never imported again. */
const IMPORTED_MARKER = ".ninerr-agents.imported";
const MAX_AGENTS = 32;
const NAME = /^[\p{L}\p{N} ._()-]{1,60}$/u;

export interface AgentRecord {
  agentId: string;
  displayName: string;
  tokenSha256: string;
  createdAt: string;
}

export interface AgentSummary {
  agentId: string;
  displayName: string;
  createdAt: string;
}

const digest = (token: string) => createHash("sha256").update(token, "utf8").digest();

export class AgentRegistry {
  readonly #path: string;
  readonly #owner: StudioActor;
  #agents: AgentRecord[];

  #problem: string | null;
  /** Where to record the legacy import once the imported registry is saved; null when done. */
  #importMarker: string | null = null;

  /** Why the registry could not be read (Ninerr started with no agents), until it is saved again. */
  get problem(): string | null {
    return this.#problem;
  }

  constructor(projectsRoot: string, owner: StudioActor) {
    this.#path = join(projectsRoot, REGISTRY_FILE);
    this.#owner = owner;
    // The registry from before the rename (legacy.ts) is read when there is no Ninerr
    // registry yet, saved under the Ninerr name, and itself never changed. It is imported at
    // most once, so a credential revoked in Ninerr cannot come back from the legacy file: a
    // marker records the import, and a set-aside damaged registry counts as one. A folder
    // that cannot be listed counts as one too (fail closed).
    let imported = true;
    try {
      imported = readdirSync(projectsRoot).some((name) => name === IMPORTED_MARKER || name.startsWith(`${REGISTRY_FILE}.unreadable-`));
    } catch {
      // stays true
    }
    const source = imported ? { path: this.#path, legacy: false } : registrySource(projectsRoot, REGISTRY_FILE, LEGACY_AGENT_REGISTRY_FILE);
    // A Ninerr registry next to a legacy one but no marker: an import whose marker was never
    // written (the process stopped in between). Record it now.
    if (!imported && !source.legacy && existing(join(projectsRoot, LEGACY_AGENT_REGISTRY_FILE))) {
      this.#importMarker = join(projectsRoot, IMPORTED_MARKER);
      this.#recordImport();
    }
    let agents: AgentRecord[] = [];
    let problem: string | null = null;
    try {
      agents = readRegistry(source.path);
    } catch (error) {
      // A damaged registry must not stop Ninerr: it is set aside (kept for inspection) and
      // every agent has to be connected again. Failing closed means no agent gets access.
      // A damaged legacy registry is only ignored; it is not ours to move.
      problem = error instanceof StudioError ? error.message : "the agent registry could not be read";
      if (!source.legacy) {
        try {
          renameSync(this.#path, `${this.#path}.unreadable-${Date.now()}`);
        } catch {
          // left in place; it is ignored until replaced by the next save
        }
      }
    }
    this.#agents = agents;
    this.#problem = problem;
    // A set-aside registry is replaced by an empty one at once, so the next launch reads that.
    if (problem !== null && !source.legacy) {
      try {
        this.#writeRegistry([]);
      } catch {
        // The set-aside marker above still keeps the legacy registry from being imported.
      }
    }
    if (source.legacy && problem === null) {
      // The marker is written together with the first save of the imported registry, so a
      // failed save is retried on the next launch rather than dropping the agents.
      this.#importMarker = join(projectsRoot, IMPORTED_MARKER);
      try {
        this.#save(agents);
      } catch {
        // The agents still work from memory; the next change saves the Ninerr registry.
      }
    }
  }

  list(): AgentSummary[] {
    return this.#agents.map(({ agentId, displayName, createdAt }) => ({ agentId, displayName, createdAt }));
  }

  /** Connect a new agent; its credential is returned this once and never stored. */
  create(displayName: unknown, at: string): { agent: AgentSummary; token: string } {
    if (typeof displayName !== "string" || !NAME.test(displayName.trim())) {
      throw new StudioError(400, "invalid-agent-name", "an agent name is 1-60 letters, digits, spaces, dots, dashes, underscores or parentheses");
    }
    if (this.#agents.length >= MAX_AGENTS) throw new StudioError(409, "too-many-agents", `at most ${MAX_AGENTS} agents may be connected`);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const record: AgentRecord = { agentId: `agent-${randomUUID()}`, displayName: displayName.trim(), tokenSha256: digest(token).toString("hex"), createdAt: at };
    this.#save([...this.#agents, record]);
    return { agent: { agentId: record.agentId, displayName: record.displayName, createdAt: at }, token };
  }

  revoke(agentId: unknown): void {
    const next = this.#agents.filter((agent) => agent.agentId !== agentId);
    if (next.length === this.#agents.length) throw new StudioError(404, "agent-not-found", "no such agent");
    this.#save(next);
  }

  /** The agent a credential belongs to, as the actor it acts as; null when none matches. */
  authenticate(token: string): StudioActor | null {
    if (!token.startsWith(TOKEN_PREFIX) && !token.startsWith(LEGACY_AGENT_TOKEN_PREFIX)) return null;
    const presented = digest(token);
    let found: AgentRecord | null = null;
    // Compare against every record, so the time taken does not depend on which matched.
    for (const agent of this.#agents) {
      if (timingSafeEqual(presented, Buffer.from(agent.tokenSha256, "hex"))) found = agent;
    }
    if (found === null) return null;
    return { actorId: found.agentId, kind: "agent", accessClass: "service", displayName: found.displayName, ownerActorId: this.#owner.actorId };
  }

  /** The document grants every connected agent holds. */
  grants(): Array<{ principalKind: "actor"; principalId: string; capabilities: string[] }> {
    return this.#agents.map((agent) => ({ principalKind: "actor", principalId: agent.agentId, capabilities: [...AGENT_CAPABILITIES] }));
  }

  #save(next: AgentRecord[]): void {
    this.#writeRegistry(next);
    this.#agents = next;
    this.#problem = null;
    this.#recordImport();
  }

  /** Write the import marker, if one is due. Already there is done; any other failure is retried. */
  #recordImport(): void {
    if (this.#importMarker === null) return;
    try {
      writeFileSync(this.#importMarker, "The agent registry from before the rename was imported into .ninerr-agents.json.\n", { mode: 0o600, flag: "wx" });
      this.#importMarker = null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") this.#importMarker = null;
    }
  }

  #writeRegistry(next: AgentRecord[]): void {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ version: 1, agents: next }, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.#path);
    } catch {
      rmSync(temporary, { force: true });
      throw new StudioError(500, "agents-unwritable", "the agent registry could not be saved");
    }
  }
}

function readRegistry(path: string): AgentRecord[] {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    return [];
  }
  // A link or anything but a small regular file is not trusted as the registry.
  if (!entry.isFile() || entry.size > 256 * 1024) throw new StudioError(500, "agents-unreadable", "the agent registry is not a regular file");
  // Only a registry this user owns, and that no one else can write, is trusted.
  if (typeof process.getuid === "function" && (entry.uid !== process.getuid() || (entry.mode & 0o022) !== 0)) {
    throw new StudioError(500, "agents-unreadable", "the agent registry is not owned by this user or is writable by others");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new StudioError(500, "agents-unreadable", "the agent registry is not valid JSON");
  }
  const agents = (parsed as { agents?: unknown })?.agents;
  if (!Array.isArray(agents) || agents.length > MAX_AGENTS) throw new StudioError(500, "agents-unreadable", "the agent registry is malformed");
  return agents.map((agent: any) => {
    if (typeof agent?.agentId !== "string" || !/^agent-[0-9a-f-]{36}$/u.test(agent.agentId)
      || typeof agent.displayName !== "string" || !NAME.test(agent.displayName)
      || typeof agent.tokenSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(agent.tokenSha256)
      || typeof agent.createdAt !== "string") {
      throw new StudioError(500, "agents-unreadable", "the agent registry is malformed");
    }
    return { agentId: agent.agentId, displayName: agent.displayName, tokenSha256: agent.tokenSha256, createdAt: agent.createdAt };
  });
}
