import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, createServer, request as httpRequest } from "node:http";
import { connect, isIP } from "node:net";

import { classifyAddress, isLinkLocalOrMetadataAddress } from "@lilac/network-policy";

import { DesignAssuranceError } from "./errors.mjs";

// A loopback HTTP proxy that the scanning browser is forced through. The browser then
// never resolves or connects itself: every navigation, redirect hop, subresource, fetch
// and WebSocket arrives here, the host is resolved once, every answer is checked, and
// the connection goes to that pinned address. A DNS answer that changes between the
// scan's pre-check and the browser's contact (rebinding) is therefore checked again
// and cannot be used after the check.

export const BROWSER_PROXY_LIMITS = Object.freeze({ maxDenials: 100, maxOpenSockets: 256, headerTimeoutMs: 10_000, upstreamIdleMs: 30_000 });

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

// Public addresses are always allowed. With allowPrivateNetwork, loopback and private
// ranges are allowed too, but never unspecified, link-local or cloud-metadata addresses,
// in any spelling.
function addressDenial(address, privateAllowed) {
  const kind = classifyAddress(address);
  if (kind === "public") return null;
  if (isLinkLocalOrMetadataAddress(address)) return `link-local or metadata address ${address}`;
  if (!privateAllowed || kind === "unspecified" || kind === "invalid") return `${kind === "forbidden" ? "private" : kind} address ${address}`;
  return null;
}

function parsePort(value, fallback) {
  if (value === "" || value === undefined) return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

export async function startBrowserPolicyProxy({ allowPrivateNetwork = false, lookup = dnsLookup } = {}) {
  const privateAllowed = allowPrivateNetwork === true;
  const denials = [];
  const sockets = new Set();
  // A per-proxy pool, so closing one scan's proxy never ends another's connections.
  const agent = new Agent({ keepAlive: true });

  const deny = (host, reason) => {
    if (denials.length < BROWSER_PROXY_LIMITS.maxDenials) denials.push(Object.freeze({ host, reason }));
  };

  // Resolves a host once and returns the address to connect to, or why not.
  async function pin(rawHost) {
    const host = rawHost.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
    let addresses;
    if (isIP(host) !== 0) {
      addresses = [host];
    } else {
      try {
        const answers = await lookup(host, { all: true, verbatim: true });
        addresses = (Array.isArray(answers) ? answers : [answers]).map((answer) => (typeof answer === "string" ? answer : answer?.address));
      } catch {
        return { unresolved: true };
      }
    }
    if (addresses.length === 0) return { unresolved: true };
    for (const address of addresses) {
      const reason = typeof address === "string" ? addressDenial(address, privateAllowed) : "invalid answer";
      if (reason !== null) {
        deny(host, reason);
        return { denied: reason };
      }
    }
    return { address: addresses[0] };
  }

  // Every client and upstream socket is tracked, so close() ends them all and nothing the
  // scan opened keeps the process alive afterwards.
  let closed = false;
  function track(socket) {
    if (closed || sockets.size >= BROWSER_PROXY_LIMITS.maxOpenSockets) {
      socket.destroy();
      return false;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return true;
  }

  const server = createServer(async (request, response) => {
    let target;
    try {
      target = new URL(request.url);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (target.protocol !== "http:" || target.username || target.password) {
      deny(target.host, target.protocol === "http:" ? "refused URL with credentials" : `refused ${target.protocol} request`);
      response.writeHead(403).end();
      return;
    }
    const port = parsePort(target.port, 80);
    const pinned = await pin(target.hostname);
    // The browser may have gone, or the scan ended, during the lookup.
    if (closed || response.destroyed) return;
    if (pinned.address === undefined) {
      response.writeHead(pinned.unresolved ? 502 : 403).end();
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
    headers.host = target.host;
    const upstream = httpRequest({ host: pinned.address, port, method: request.method, path: `${target.pathname}${target.search}`, headers, setHost: false, agent }, (reply) => {
      const replyHeaders = {};
      for (const [name, value] of Object.entries(reply.headers)) if (!HOP_BY_HOP.has(name)) replyHeaders[name] = value;
      reply.on("error", () => response.destroy());
      response.writeHead(reply.statusCode ?? 502, replyHeaders);
      reply.pipe(response);
    });
    upstream.on("socket", (socket) => { if (!sockets.has(socket)) track(socket); });
    upstream.setTimeout(BROWSER_PROXY_LIMITS.upstreamIdleMs, () => upstream.destroy());
    upstream.on("error", () => { if (!response.headersSent && !response.destroyed) response.writeHead(502); response.end(); });
    response.on("close", () => upstream.destroy());
    response.on("error", () => upstream.destroy());
    request.pipe(upstream);
  });

  server.on("connection", (socket) => { track(socket); });

  server.on("connect", async (request, client, head) => {
    // A client that half-closes during the lookup has left too. Only during the lookup: once
    // the tunnel is up, a half-close is passed on so the reply can still come back.
    const leftDuringLookup = () => client.destroy();
    client.once("end", leftDuringLookup);
    const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/u.exec(request.url ?? "");
    const port = match ? parsePort(match[2], null) : null;
    if (!match || port === null) {
      deny(String(request.url).slice(0, 256), "malformed CONNECT target");
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const pinned = await pin(match[1]);
    client.off("end", leftDuringLookup);
    if (closed || client.destroyed) return;
    if (pinned.address === undefined) {
      client.end(pinned.unresolved ? "HTTP/1.1 502 Bad Gateway\r\n\r\n" : "HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect({ host: pinned.address, port });
    if (!track(upstream)) {
      client.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("close", () => client.destroy());
    client.once("close", () => upstream.destroy());
  });

  server.headersTimeout = BROWSER_PROXY_LIMITS.headerTimeoutMs;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  return Object.freeze({
    url: `http://127.0.0.1:${port}`,
    denials: () => denials.slice(),
    async close() {
      closed = true;
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  });
}

export function assertNoPolicyDenials(denials) {
  if (denials.length === 0) return;
  const listed = denials.slice(0, 5).map((entry) => `${entry.host} (${entry.reason})`).join(", ");
  throw new DesignAssuranceError(`browser scan refused: ${denials.length} contact(s) denied by network policy: ${listed}`);
}
