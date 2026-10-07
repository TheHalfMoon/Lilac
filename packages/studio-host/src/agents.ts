import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StudioError } from "./errors.ts";
import type { StudioActor } from "./session.ts";

// Agents the person has connected to Lilac. Each gets its own credential, shown once when
// it is created; only the credential's sha256 is stored, in `<projectsRoot>/.lilac-agents.json`
// (owner-only permissions), so a connected MCP client keeps working across launches and a
// leaked registry reveals no credential. An agent acts as itself (kind "agent"), owned by
// the person who connected it; revoking it takes effect immediately.

export const AGENT_CAPABILITIES = Object.freeze(["read", "document-write", "comments"]);
const REGISTRY_FILE = ".lilac-agents.json";
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

  /** Set when the registry could not be read; Lilac starts with no agents connected. */
  readonly problem: string | null;

  constructor(projectsRoot: string, owner: StudioActor) {
    this.#path = join(projectsRoot, REGISTRY_FILE);
    this.#owner = owner;
    let agents: AgentRecord[] = [];
    let problem: string | null = null;
    try {
      agents = readRegistry(this.#path);
    } catch (error) {
      // A damaged registry must not stop Lilac: it is set aside (kept for inspection) and
      // every agent has to be connected again. Failing closed means no agent gets access.
      problem = error instanceof StudioError ? error.message : "the agent registry could not be read";
      try {
        renameSync(this.#path, `${this.#path}.unreadable-${Date.now()}`);
      } catch {
        // left in place; it is ignored until replaced by the next save
      }
    }
    this.#agents = agents;
    this.problem = problem;
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
    const token = `lilac_agent_${randomBytes(32).toString("base64url")}`;
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
    if (!token.startsWith("lilac_agent_")) return null;
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
    this.#agents = next;
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
