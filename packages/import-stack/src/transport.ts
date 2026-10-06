import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { ImportSecurityError, ImportValidationError } from "./errors.ts";

const READ_METHODS = new Set(["GET", "HEAD"]);
const DROP_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
]);
const DROP_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "set-cookie2",
  "connection",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "upgrade",
]);
const MAX_FORWARDED_HEADER_BYTES = 64 * 1024;

export interface PinnedHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface PinnedHttpOptions {
  addresses: string[];
  timeoutMs: number;
  maxBytes: number;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function sanitizeReadOnlyRequestHeaders(input: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let total = 0;
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(name)) continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/u.test(name)) {
      throw new ImportValidationError("browser request contains an invalid header name");
    }
    if (typeof rawValue !== "string" || /[\r\n]/u.test(rawValue)) {
      throw new ImportValidationError(`browser request header ${name} is invalid`);
    }
    total += Buffer.byteLength(name, "utf8") + Buffer.byteLength(rawValue, "utf8");
    if (total > MAX_FORWARDED_HEADER_BYTES) {
      throw new ImportSecurityError("browser request headers exceed bounded size");
    }
    result[name] = rawValue;
  }
  result["accept-encoding"] = "identity";
  return result;
}

export async function fetchPinnedHttp(url: URL, options: PinnedHttpOptions): Promise<PinnedHttpResponse> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ImportSecurityError("pinned HTTP transport only supports http and https");
  }
  if (!Array.isArray(options.addresses) || options.addresses.length === 0) {
    throw new ImportSecurityError("pinned HTTP transport requires validated addresses");
  }
  for (const address of options.addresses) {
    if (isIP(address) === 0) throw new ImportSecurityError("pinned HTTP transport received a non-IP address");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new ImportValidationError("pinned HTTP timeout must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new ImportValidationError("pinned HTTP maxBytes must be a positive safe integer");
  }
  const method = (options.method ?? "GET").toUpperCase();
  if (!READ_METHODS.has(method)) throw new ImportSecurityError("pinned HTTP transport is read-only");

  const selected = options.addresses[0];
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = sanitizeReadOnlyRequestHeaders(options.headers ?? {});

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const req = requester({
      protocol: url.protocol,
      hostname,
      ...(url.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      lookup: (_hostname, lookupOptions, callback) => {
        const family = selected.includes(":") ? 6 : 4;
        if (lookupOptions && typeof lookupOptions === "object" && lookupOptions.all) {
          callback(null, [{ address: selected, family }]);
        } else {
          callback(null, selected, family);
        }
      },
      signal: options.signal,
    }, (response) => {
      const failResponse = (error: Error) => {
        if (settled) return;
        settled = true;
        response.destroy();
        rejectPromise(error);
      };
      response.on("error", fail);
      const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
      if (encoding !== "identity") {
        failResponse(new ImportSecurityError("pinned HTTP response encoding must be identity"));
        return;
      }
      const declared = Number.parseInt(String(response.headers["content-length"] ?? ""), 10);
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        failResponse(new ImportSecurityError("pinned HTTP response exceeds maxBytes"));
        return;
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      response.on("data", (chunk: Uint8Array) => {
        total += chunk.byteLength;
        if (total > options.maxBytes) {
          failResponse(new ImportSecurityError("pinned HTTP response exceeds maxBytes"));
          return;
        }
        chunks.push(Uint8Array.from(chunk));
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const responseHeaders: Record<string, string> = Object.create(null);
        for (const [rawName, rawValue] of Object.entries(response.headers)) {
          const name = rawName.toLowerCase();
          if (DROP_RESPONSE_HEADERS.has(name) || rawValue === undefined) continue;
          const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
          if (/[
]/u.test(value)) continue;
          responseHeaders[name] = value;
        }
        resolvePromise({
          status: response.statusCode ?? 0,
          headers: responseHeaders,
          body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
        });
      });
    });
    req.setTimeout(options.timeoutMs, () => req.destroy(new ImportSecurityError("pinned HTTP request timed out")));
    req.on("error", fail);
    req.end();
  });
}
