import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { isLoopbackAddress } from "@lilac/network-policy";
import { StudioError } from "./errors.ts";
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
}

export interface StudioHost {
  readonly url: string;
  readonly port: number;
  /** Per-launch secret every API request must carry; never logged or persisted. */
  readonly token: string;
  readonly session: StudioSession | null;
  close(): Promise<void>;
}

const LOOPBACK = "127.0.0.1";
const MAX_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
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
  const streams = new Set<ServerResponse>();
  let session: StudioSession | null = null;
  let unsubscribe: (() => void) | null = null;
  let port = 0;

  const broadcast = (name: string, data: unknown) => {
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of streams) stream.write(frame);
  };
  const replaceSession = (next: StudioSession | null) => {
    unsubscribe?.();
    unsubscribe = null;
    session?.close();
    session = next;
    if (next) unsubscribe = next.onChange((event: ChangeEvent) => broadcast("change", event));
    broadcast("project", describe());
  };
  const requireSession = (): StudioSession => {
    if (session === null) throw new StudioError(409, "no-project", "no project is open");
    return session;
  };
  const describe = () => (session === null
    ? { project: null }
    : { project: session.name, revision: session.revision, canUndo: session.canUndo, canRedo: session.canRedo, recovery: session.recovery });

  const authorized = (request: IncomingMessage, url: URL): boolean => {
    const header = request.headers.authorization;
    const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
    if (typeof presented !== "string") return false;
    const bytes = Buffer.from(presented);
    return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
  };

  const routes: Record<string, (body: any) => unknown> = {
    "GET /api/session": () => describe(),
    "GET /api/projects": () => ({
      projects: readdirSync(projectsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(projectsRoot, entry.name, ".lilac")))
        .map((entry) => entry.name)
        .sort(),
    }),
    "POST /api/projects/create": (body) => {
      replaceSession(null);
      replaceSession(StudioSession.open({ projectsRoot, name: body?.name, owner, now, create: { title: body?.title } }));
      return describe();
    },
    "POST /api/projects/open": (body) => {
      const name = assertProjectName(body?.name);
      const breakStaleLock = body?.breakStaleLock;
      if (breakStaleLock !== undefined && (typeof breakStaleLock?.reason !== "string" || breakStaleLock.reason.trim() === "")) {
        throw new StudioError(400, "invalid-lock-override", "breakStaleLock needs a non-empty reason");
      }
      replaceSession(null);
      replaceSession(StudioSession.open({ projectsRoot, name, owner, now, ...(breakStaleLock ? { breakStaleLock: { reason: breakStaleLock.reason.slice(0, 500) } } : {}) }));
      return describe();
    },
    "POST /api/projects/close": () => {
      replaceSession(null);
      return describe();
    },
    "GET /api/document": () => {
      const current = requireSession();
      return { revision: current.revision, document: current.document };
    },
    "POST /api/edit": (body) => requireSession().edit(owner, body),
    "POST /api/undo": () => requireSession().undo(owner),
    "POST /api/redo": () => requireSession().redo(owner),
    "POST /api/checkpoint": () => requireSession().checkpoint(),
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error) => respondError(response, error));
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isLoopbackAddress(stripMappedPrefix(request.socket.remoteAddress ?? ""))) throw new StudioError(403, "not-loopback", "only loopback peers are served");
    const allowedHosts = [`${LOOPBACK}:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(request.headers.host ?? "")) throw new StudioError(421, "wrong-host", "the Host header does not name this studio");
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedHosts.some((host) => origin === `http://${host}`)) throw new StudioError(403, "foreign-origin", "requests from other origins are refused");
    const url = new URL(request.url ?? "/", `http://${LOOPBACK}:${port}`);
    if (!url.pathname.startsWith("/api/")) throw new StudioError(404, "not-found", "not found");
    if (!authorized(request, url)) throw new StudioError(401, "unauthorized", "a valid studio token is required");

    if (request.method === "GET" && url.pathname === "/api/events") {
      openStream(response);
      return;
    }
    const route = routes[`${request.method} ${url.pathname}`];
    if (route === undefined) throw new StudioError(404, "not-found", "not found");
    const body = request.method === "POST" ? await readJson(request) : undefined;
    respondJson(response, 200, route(body));
  }

  function openStream(response: ServerResponse): void {
    response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" });
    response.write(`event: project\ndata: ${JSON.stringify(describe())}\n\n`);
    streams.add(response);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), HEARTBEAT_MS);
    heartbeat.unref();
    response.on("close", () => {
      clearInterval(heartbeat);
      streams.delete(response);
    });
  }

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

  return {
    url: `http://${LOOPBACK}:${port}`,
    port,
    token,
    get session() {
      return session;
    },
    async close() {
      for (const stream of streams) stream.end();
      streams.clear();
      replaceSession(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers["content-type"];
  const bodiless = type === undefined && request.headers["transfer-encoding"] === undefined && (request.headers["content-length"] ?? "0") === "0";
  if (bodiless) return {};
  if (!/^application\/json(;|$)/u.test(type ?? "")) throw new StudioError(415, "unsupported-media-type", "request bodies must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new StudioError(413, "too-large", `request bodies are limited to ${MAX_BODY_BYTES} bytes`);
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
