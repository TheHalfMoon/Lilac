import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackAddress } from "@lilac/network-policy";
import { LEGACY_PROJECT_DIRECTORY, PROJECT_FILES } from "@lilac/persistence";
import { AgentRegistry } from "./agents.ts";
import { StudioError } from "./errors.ts";
import { exportJsx, importJsx } from "./code.ts";
import { CodebaseLinks, assertFolder, bringIn, planWriteBack, scanComponents, writeBack, type WriteBackPlan } from "./codebase.ts";
import { ImportDesk, MAX_IMPORT_HTML_BYTES } from "./imports.ts";
import { ConfirmationBroker, handleMcpMessage } from "./mcp.ts";
import { StudioSession, assertProjectName, type ChangeEvent, type StudioActor } from "./session.ts";

export interface StudioHostOptions {
  /** Directory holding one sub-directory per project. Only names inside it can be opened. */
  projectsRoot: string;
  /** TCP port on 127.0.0.1; 0 picks a free one. */
  port?: number;
  /** The person at the keyboard; every editor request acts as them. */
  owner?: StudioActor;
  /** Clock for transaction timestamps (ISO-8601 UTC). */
  now?: () => string;
  /** Directory holding the browser packages served to the editor (default: this repository's packages/). */
  packagesRoot?: string;
  /** How long a consequential MCP call waits for the person (default 50 s). */
  confirmationWaitMs?: number;
}

export interface StudioHost {
  readonly url: string;
  readonly port: number;
  /** Per-launch secret every API request must carry; never logged or persisted. */
  readonly token: string;
  /** Open this once in a browser: the editor trades its single-use ticket for the token. */
  launchUrl(): string;
  /** The MCP endpoint (Streamable HTTP); agents authenticate with their own credential. */
  readonly mcpUrl: string;
  readonly session: StudioSession | null;
  close(): Promise<void>;
}

const LOOPBACK = "127.0.0.1";
const MAX_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const MAX_STREAMS = 32;
// A stream whose client has stopped reading is dropped rather than buffered without bound;
// the client reconnects and resynchronizes from GET /api/document.
const MAX_STREAM_BUFFER = 1024 * 1024;
// The editor and the browser-loadable packages it imports; nothing else is served.
const BROWSER_PACKAGES = new Set(["studio-web", "document-model", "history", "renderer", "canvas"]);
const STATIC_FILE = /^\/packages\/([a-z-]+)\/src\/([a-z0-9-]+\.(?:mjs|css|html))$/u;
const STATIC_TYPES: Record<string, string> = { ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8" };
const TICKET_TTL_MS = 120_000;
// The editor page may load only its own modules and styles, talk only to this host, and
// frame only same-origin documents (the renderer's srcdoc frame inherits this policy).
const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; child-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const DEFAULT_OWNER: StudioActor = { actorId: "local-user", kind: "user", accessClass: "member", displayName: "You" };

/**
 * Start the studio host. It listens on 127.0.0.1 only and answers only requests that come
 * from a loopback peer, name this host and port in `Host`, carry no foreign `Origin`, and
 * present the per-launch token, so another site in a browser, a DNS-rebinding page, or
 * another machine cannot drive it.
 */
export async function startStudioHost(options: StudioHostOptions): Promise<StudioHost> {
  if (typeof options?.projectsRoot !== "string" || !existsSync(options.projectsRoot) || !lstatSync(options.projectsRoot).isDirectory()) {
    throw new StudioError(500, "invalid-projects-root", "projectsRoot must be an existing directory");
  }
  const projectsRoot = realpathSync(options.projectsRoot);
  const owner = options.owner ?? DEFAULT_OWNER;
  const now = options.now ?? (() => new Date().toISOString());
  const token = randomBytes(32).toString("base64url");
  const tokenBytes = Buffer.from(token);
  const packagesRoot = realpathSync(options.packagesRoot ?? fileURLToPath(new URL("../../", import.meta.url)));
  const tickets = new Map<string, number>();
  const issueTicket = () => {
    const ticket = randomBytes(24).toString("base64url");
    for (const [old, expires] of tickets) if (expires < Date.now()) tickets.delete(old);
    tickets.set(ticket, Date.now() + TICKET_TTL_MS);
    return ticket;
  };
  const redeemTicket = (ticket: string | null): boolean => {
    if (ticket === null) return false;
    const expires = tickets.get(ticket);
    tickets.delete(ticket);
    return expires !== undefined && expires >= Date.now();
  };
  const streams = new Set<ServerResponse>();
  const imports = new ImportDesk();
  const connectedFolder = (project: string) => {
    const folder = codebases.get(project);
    if (folder === null) throw new StudioError(409, "no-codebase", "connect a codebase folder first");
    return assertFolder(folder, projectsRoot);
  };
  const agents = new AgentRegistry(projectsRoot, owner);
  const codebases = new CodebaseLinks(projectsRoot);
  // What the person has selected in the editor, for MCP's get_selection.
  let selection: string[] = [];
  let session: StudioSession | null = null;
  let unsubscribe: (() => void) | null = null;
  let port = 0;

  const send = (stream: ServerResponse, frame: string) => {
    if (stream.writableLength > MAX_STREAM_BUFFER) {
      streams.delete(stream);
      stream.destroy();
      return;
    }
    stream.write(frame);
  };
  const broadcast = (name: string, data: unknown, id?: number) => {
    const frame = `${id === undefined ? "" : `id: ${id}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of [...streams]) send(stream, frame);
  };
  const confirmations = new ConfirmationBroker((pending) => broadcast("confirmations", { pending }));
  const closeSession = () => {
    // A reviewed import belongs to the project it was reviewed for.
    imports.clear();
    if (session !== null) {
      const documentId = session.documentId;
      confirmations.drop((item) => item.documentId === documentId);
    }
    selection = [];
    unsubscribe?.();
    unsubscribe = null;
    session?.close();
    session = null;
  };
  // Open `open()`'s project in place of the current one. The current project stays open if
  // the new one cannot be opened, unless it is the same project, which must be closed first
  // so its own lock does not block the reopen.
  const switchTo = (name: string, open: () => StudioSession) => {
    if (session !== null && session.name === name) {
      closeSession();
      broadcast("project", describe());
    }
    const next = open();
    closeSession();
    next.setAgentGrants(agents.grants());
    session = next;
    unsubscribe = next.onChange((event: ChangeEvent) => broadcast("change", event, event.revision));
    broadcast("project", describe());
  };
  const requireSession = (): StudioSession => {
    if (session === null) throw new StudioError(409, "no-project", "no project is open");
    return session;
  };
  const describe = () => {
    if (session === null) return { project: null };
    if (session.failure !== null) return { project: session.name, failure: session.failure };
    return { project: session.name, revision: session.revision, canUndo: session.canUndo(owner), canRedo: session.canRedo(owner), recovery: session.recovery };
  };

  const matches = (presented: unknown): boolean => {
    if (typeof presented !== "string") return false;
    const bytes = Buffer.from(presented);
    return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
  };
  // The token comes in the Authorization header, except on the event stream, which
  // EventSource opens without custom headers and so may carry it in the query.
  const authorized = (request: IncomingMessage, url: URL): boolean => {
    const header = request.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) return matches(header.slice(7));
    return request.method === "GET" && url.pathname === "/api/events" && matches(url.searchParams.get("token"));
  };

  const routes: Record<string, (body: any) => unknown> = {
    "GET /api/session": () => ({ ...describe(), user: { actorId: owner.actorId, displayName: owner.displayName ?? owner.actorId } }),
    "GET /api/projects": () => ({
      projects: readdirSync(projectsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && (existsSync(join(projectsRoot, entry.name, PROJECT_FILES.directory)) || existsSync(join(projectsRoot, entry.name, LEGACY_PROJECT_DIRECTORY))))
        .map((entry) => entry.name)
        .sort(),
    }),
    "POST /api/projects/create": (body) => {
      const name = assertProjectName(body?.name);
      if (existsSync(join(projectsRoot, name))) throw new StudioError(409, "project-exists", `${name} already exists`);
      switchTo(name, () => StudioSession.open({ projectsRoot, name, owner, now, create: { title: body?.title } }));
      return describe();
    },
    "POST /api/projects/open": (body) => {
      const name = assertProjectName(body?.name);
      const breakStaleLock = body?.breakStaleLock;
      if (breakStaleLock !== undefined && (typeof breakStaleLock?.reason !== "string" || breakStaleLock.reason.trim() === "")) {
        throw new StudioError(400, "invalid-lock-override", "breakStaleLock needs a non-empty reason");
      }
      switchTo(name, () => StudioSession.open({ projectsRoot, name, owner, now, ...(breakStaleLock ? { breakStaleLock: { reason: breakStaleLock.reason.slice(0, 500) } } : {}) }));
      return describe();
    },
    "POST /api/projects/close": () => {
      closeSession();
      broadcast("project", describe());
      return describe();
    },
    "GET /api/document": () => {
      const current = requireSession();
      return { project: current.name, revision: current.revision, document: current.document };
    },
    "GET /api/history": () => ({ entries: requireSession().log }),
    "POST /api/edit": (body) => requireSession().edit(owner, body),
    "POST /api/undo": () => requireSession().undo(owner),
    "POST /api/redo": () => requireSession().redo(owner),
    "POST /api/revert": (body) => requireSession().revert(owner, body?.transactionId),
    "POST /api/checkpoint": () => requireSession().checkpoint(),
    "POST /api/import": (body) => {
      requireSession();
      return imports.prepare(body, owner.actorId, now());
    },
    "POST /api/import/commit": (body) => {
      const current = requireSession();
      const { operations, intent, frameId, provenance } = imports.change(body?.proposalId, current.document);
      const event = current.edit(owner, { baseRevision: current.revision, operations, intent, tool: "lilac:import" }, "http", { import: provenance });
      // Only a committed review is used up; a failed commit can be retried.
      imports.consume(body.proposalId);
      return { ...event, frameId };
    },
    "POST /api/code/export": (body) => exportJsx(requireSession().document, body?.nodeId),
    "POST /api/code/import": (body) => {
      const current = requireSession();
      const { operations, frameId, componentName, layers } = importJsx(body?.code);
      const placed = operations.map((operation: any) => ({ ...operation, index: (current.document as any).rootIds.length }));
      return { ...current.edit(owner, { baseRevision: current.revision, operations: placed, intent: `Bring in ${componentName}`, tool: "lilac:code" }), frameId, layers };
    },
    // A connected codebase (PC11): only the person, through the editor's session, ever
    // connects one, brings a component in from it, or writes back to it.
    "GET /api/codebase": () => {
      const current = requireSession();
      const folder = codebases.get(current.name);
      if (folder === null) return { folder: null, components: [] };
      return { folder, ...scanComponents(assertFolder(folder, projectsRoot)) };
    },
    "POST /api/codebase/connect": (body) => {
      const current = requireSession();
      const folder = assertFolder(body?.folder, projectsRoot);
      codebases.set(current.name, folder);
      return { folder, ...scanComponents(folder) };
    },
    "POST /api/codebase/disconnect": () => {
      codebases.set(requireSession().name, null);
      return { folder: null, components: [] };
    },
    "POST /api/codebase/import": (body) => {
      const current = requireSession();
      const folder = connectedFolder(current.name);
      const { operations, frameId, componentName, layers, file } = bringIn(folder, body?.file, body?.component);
      const placed = operations.map((operation: any) => ({ ...operation, index: (current.document as any).rootIds.length }));
      return { ...current.edit(owner, { baseRevision: current.revision, operations: placed, intent: `Bring in ${componentName} from ${file}`, tool: "lilac:codebase" }), frameId, layers };
    },
    "POST /api/codebase/preview": (body) => {
      const current = requireSession();
      const { after: _after, rebase: _rebase, ...plan } = planWriteBack(current.document, body?.nodeId, connectedFolder(current.name));
      return plan;
    },
    "POST /api/codebase/write": (body) => {
      const current = requireSession();
      // Recorded as pending, written, then confirmed: three transactions (#185, writeBack).
      let event: ReturnType<typeof current.edit> | undefined;
      const intents = {
        record: (plan: WriteBackPlan) => `Write ${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"} back to ${plan.file}`,
        confirm: (plan: WriteBackPlan) => `Confirm the write to ${plan.file}`,
        withdraw: (plan: WriteBackPlan) => `Withdraw the write to ${plan.file}`,
      };
      const plan = writeBack(current.document, body?.nodeId, connectedFolder(current.name), body?.token, (operations, step, planned) => {
        event = current.edit(owner, { baseRevision: current.revision, operations, intent: intents[step](planned), tool: "lilac:codebase" });
      });
      return { ...event, file: plan.file, written: plan.changes.length };
    },
    "POST /api/import/discard": (body) => {
      imports.discard(body?.proposalId);
      return { discarded: true };
    },
    "POST /api/selection": (body) => {
      const ids = body?.nodeIds;
      if (!Array.isArray(ids) || ids.length > 500 || ids.some((id: unknown) => typeof id !== "string" || id.length > 200)) throw new StudioError(400, "invalid-selection", "nodeIds must be a list of at most 500 node ids");
      selection = [...ids];
      return { selected: selection.length };
    },
    "GET /api/agents": () => ({ agents: agents.list(), mcpUrl: `http://${LOOPBACK}:${port}/mcp`, ...(agents.problem ? { problem: agents.problem } : {}) }),
    "POST /api/agents/create": (body) => {
      const created = agents.create(body?.name, now());
      // The open project grants the new agent at once.
      session?.setAgentGrants(agents.grants());
      return { ...created, mcpUrl: `http://${LOOPBACK}:${port}/mcp` };
    },
    "POST /api/agents/revoke": (body) => {
      agents.revoke(body?.agentId);
      session?.setAgentGrants(agents.grants());
      confirmations.drop((item) => item.agentId === body.agentId);
      return { agents: agents.list() };
    },
    "GET /api/confirmations": () => ({ pending: confirmations.pending() }),
    "POST /api/confirmations/decide": (body) => {
      if (typeof body?.approve !== "boolean") throw new StudioError(400, "invalid-decision", "approve must be true or false");
      confirmations.decide(body.id, body.approve, now());
      return { pending: confirmations.pending() };
    },
  };

  // Check timeouts every second, so the 10 s header limit is actually enforced.
  const server: Server = createServer({ connectionsCheckingInterval: 1_000 }, (request, response) => {
    handle(request, response).catch((error) => respondError(response, error));
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isLoopbackAddress(stripMappedPrefix(request.socket.remoteAddress ?? ""))) throw new StudioError(403, "not-loopback", "only loopback peers are served");
    const allowedHosts = [`${LOOPBACK}:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(request.headers.host ?? "")) throw new StudioError(421, "wrong-host", "the Host header does not name this studio");
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedHosts.some((host) => origin === `http://${host}`)) throw new StudioError(403, "foreign-origin", "requests from other origins are refused");
    const url = new URL(request.url ?? "/", `http://${LOOPBACK}:${port}`);
    if (url.pathname === "/mcp") {
      await serveMcp(request, response);
      return;
    }
    // The editor's files are public source and carry no secret, so they are served without
    // the token; the Host and Origin checks above still apply.
    if (!url.pathname.startsWith("/api/")) {
      serveStatic(response, request.method, url.pathname);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/launch") {
      // The editor page trades the single-use ticket from its launch URL for the token. A
      // browser always sends Origin on a POST, and only this host's own origin is accepted.
      if (origin === undefined) throw new StudioError(403, "origin-required", "the launch ticket is redeemed only by the editor page");
      const { ticket } = ((await readJson(request)) ?? {}) as { ticket?: unknown };
      if (!redeemTicket(typeof ticket === "string" ? ticket : null)) throw new StudioError(401, "invalid-ticket", "this launch link has been used or has expired; open Lilac again");
      respondJson(response, 200, { token });
      return;
    }
    if (!authorized(request, url)) throw new StudioError(401, "unauthorized", "a valid studio token is required");

    if (request.method === "GET" && url.pathname === "/api/events") {
      openStream(response);
      return;
    }
    const route = routes[`${request.method} ${url.pathname}`];
    if (route === undefined) throw new StudioError(404, "not-found", "not found");
    // An HTML import may be larger than other requests (the import stack's own limit).
    // JSON escaping can make HTML up to six times larger (control characters as \uXXXX).
    const body = request.method === "POST" ? await readJson(request, url.pathname === "/api/import" ? MAX_IMPORT_HTML_BYTES * 6 + 64 * 1024 : MAX_BODY_BYTES) : undefined;
    respondJson(response, 200, route(body));
  }

  // MCP over Streamable HTTP, request/response only: no server-initiated stream (GET), no
  // batches. Only an agent credential is accepted, so every call has an agent identity.
  async function serveMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, { ...SECURITY_HEADERS, allow: "POST" });
      response.end();
      return;
    }
    const header = request.headers.authorization;
    const actor = typeof header === "string" && header.startsWith("Bearer ") ? agents.authenticate(header.slice(7)) : null;
    if (actor === null) throw new StudioError(401, "unauthorized", "an agent credential from Lilac is required");
    const message = await readJson(request);
    if (Array.isArray(message)) {
      respondJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not supported" } });
      return;
    }
    const answer = await handleMcpMessage({ session: () => session, selection: () => selection, confirmations, now, ...(options.confirmationWaitMs ? { confirmationWaitMs: options.confirmationWaitMs } : {}) }, actor, message);
    if (answer === null) {
      response.writeHead(202, SECURITY_HEADERS);
      response.end();
      return;
    }
    respondJson(response, 200, answer);
  }

  function serveStatic(response: ServerResponse, method: string | undefined, pathname: string): void {
    if (method !== "GET") throw new StudioError(405, "method-not-allowed", "only GET is served here");
    const path = pathname === "/" ? "/packages/studio-web/src/index.html" : pathname;
    const match = STATIC_FILE.exec(path);
    if (match === null || !BROWSER_PACKAGES.has(match[1])) throw new StudioError(404, "not-found", "not found");
    let file: string;
    try {
      file = realpathSync(join(packagesRoot, match[1], "src", match[2]));
    } catch {
      throw new StudioError(404, "not-found", "not found");
    }
    if (!file.startsWith(`${packagesRoot}${sep}`)) throw new StudioError(404, "not-found", "not found");
    const body = readFileSync(file);
    const type = STATIC_TYPES[extname(file)];
    response.writeHead(200, { ...SECURITY_HEADERS, "content-type": type, "content-length": body.length, ...(type.startsWith("text/html") ? { "content-security-policy": APP_CSP } : {}) });
    response.end(body);
  }

  function openStream(response: ServerResponse): void {
    if (streams.size >= MAX_STREAMS) throw new StudioError(503, "too-many-streams", `at most ${MAX_STREAMS} event streams may be open`);
    response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" });
    response.write(`event: project\ndata: ${JSON.stringify(describe())}\n\n`);
    // Requests waiting for the person, so a reconnected editor shows them again.
    response.write(`event: confirmations\ndata: ${JSON.stringify({ pending: confirmations.pending() })}\n\n`);
    streams.add(response);
    const heartbeat = setInterval(() => send(response, ": keep-alive\n\n"), HEARTBEAT_MS);
    heartbeat.unref();
    response.on("close", () => {
      clearInterval(heartbeat);
      streams.delete(response);
    });
  }

  // Loopback only, but a stuck client still must not hold sockets open indefinitely. No
  // connection cap: a cap would let any local process lock the editor out with idle sockets.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, LOOPBACK, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string" || !isLoopbackAddress(address.address)) {
    server.close();
    throw new StudioError(500, "not-loopback", "the studio host must listen on a loopback address");
  }
  port = address.port;
  // Tell local MCP relays where this host is: a small owner-only file in the projects root,
  // removed when the host closes. It holds no credential.
  const discovery = join(projectsRoot, ".ninerr-studio.json");
  const discoveryNonce = randomBytes(8).toString("hex");
  try {
    const temporary = `${discovery}.${discoveryNonce}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, url: `http://${LOOPBACK}:${port}`, mcpUrl: `http://${LOOPBACK}:${port}/mcp`, pid: process.pid, nonce: discoveryNonce })}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, discovery);
  } catch {
    // Relays can still be given the URL directly.
  }

  return {
    url: `http://${LOOPBACK}:${port}`,
    port,
    token,
    launchUrl: () => `http://${LOOPBACK}:${port}/?ticket=${issueTicket()}`,
    mcpUrl: `http://${LOOPBACK}:${port}/mcp`,
    get session() {
      return session;
    },
    async close() {
      for (const stream of streams) stream.end();
      streams.clear();
      closeSession();
      try {
        if (JSON.parse(readFileSync(discovery, "utf8")).nonce === discoveryNonce) rmSync(discovery, { force: true });
      } catch {
        // already gone, or another host's
      }
      // Stop accepting, then drop every open connection (idle keep-alives, an editor's
      // requests, an agent's waiting call): close() alone waits for all of them to end.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await closed;
    },
  };
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'",
  "referrer-policy": "no-referrer",
};

function stripMappedPrefix(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

async function readJson(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const type = request.headers["content-type"];
  const bodiless = type === undefined && request.headers["transfer-encoding"] === undefined && (request.headers["content-length"] ?? "0") === "0";
  if (bodiless) return {};
  if (!/^application\/json(;|$)/u.test(type ?? "")) throw new StudioError(415, "unsupported-media-type", "request bodies must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new StudioError(413, "too-large", `request bodies are limited to ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StudioError(400, "invalid-json", "the request body is not valid JSON");
  }
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value ?? null);
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function respondError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof StudioError) {
    respondJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  // Unexpected failures are reported without internals.
  respondJson(response, 500, { error: { code: "internal", message: "the studio host could not complete the request" } });
}
