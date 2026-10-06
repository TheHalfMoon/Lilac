import { lookup } from "node:dns/promises";
import { ImportSecurityError, ImportValidationError } from "./errors.ts";
import { importHtmlSnapshot } from "./html.ts";
import { validateNavigationUrl, validateResolvedAddresses } from "./network.ts";
import { fetchPinnedHttp, sanitizeReadOnlyRequestHeaders, type PinnedHttpResponse } from "./transport.ts";
import type { AdapterResult, ImportProposal, ImportRequest } from "./types.ts";
import { normalizeImportRequest } from "./validation.ts";

interface RequestLike {
  url(): string;
  isNavigationRequest(): boolean;
  method(): string;
  allHeaders(): Promise<Record<string, string>>;
}
interface RouteLike {
  request(): RequestLike;
  fulfill(options: { status: number; headers: Record<string, string>; body: Uint8Array }): Promise<void>;
  abort(): Promise<void>;
}
interface WebSocketRouteLike { close(): void; }
interface PageLike {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
}
interface BrowserContextLike {
  route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
  routeWebSocket?: (pattern: string, handler: (route: WebSocketRouteLike) => void) => Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
interface BrowserLike {
  newContext(options: {
    acceptDownloads: boolean;
    serviceWorkers: "block";
    permissions: string[];
    ignoreHTTPSErrors: boolean;
  }): Promise<BrowserContextLike>;
  close(): Promise<void>;
}
interface PlaywrightLike { chromium: { launch(options: { headless: boolean }): Promise<BrowserLike> }; }

export interface PlaywrightCaptureDependencies {
  loadPlaywright?: () => Promise<PlaywrightLike>;
  resolveHost?: (hostname: string) => Promise<string[]>;
  fetchHttp?: (
    url: URL,
    options: {
      addresses: string[];
      timeoutMs: number;
      maxBytes: number;
      method: "GET" | "HEAD";
      headers: Record<string, string>;
    },
  ) => Promise<PinnedHttpResponse>;
  now?: () => number;
}

async function defaultLoadPlaywright(): Promise<PlaywrightLike> {
  const loaded = await import("playwright");
  return loaded as unknown as PlaywrightLike;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const result = await lookup(hostname, { all: true, verbatim: true });
  return result.map((entry) => entry.address);
}

function unavailablePlaywright(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === "ERR_MODULE_NOT_FOUND" || /cannot find (?:package|module).*playwright/iu.test(error.message);
}

async function validatedAddresses(
  url: URL,
  request: ImportRequest,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<string[]> {
  const literal = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = /^[0-9.]+$/u.test(literal) || literal.includes(":") ? [literal] : await resolveHost(url.hostname);
  validateResolvedAddresses(url, addresses, request.policy, request.networkPolicy);
  return addresses;
}

export async function captureDynamicHtml(
  requestInput: ImportRequest,
  rawUrl: string,
  dependencies: PlaywrightCaptureDependencies = {},
): Promise<AdapterResult<ImportProposal>> {
  let request: ImportRequest;
  try {
    request = normalizeImportRequest(requestInput);
    if (request.source.kind !== "local-app" && request.source.kind !== "remote-url") {
      throw new ImportValidationError("Playwright capture requires local-app or remote-url source kind");
    }
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }

  const resolveHost = dependencies.resolveHost ?? defaultResolveHost;
  const fetchHttp = dependencies.fetchHttp ?? fetchPinnedHttp;
  const now = dependencies.now ?? Date.now;
  let initial: URL;
  try {
    initial = validateNavigationUrl(rawUrl, request.policy, request.networkPolicy);
    await validatedAddresses(initial, request, resolveHost);
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }

  let playwright: PlaywrightLike;
  try { playwright = await (dependencies.loadPlaywright ?? defaultLoadPlaywright)(); }
  catch (error) {
    if (unavailablePlaywright(error)) return { status: "unavailable", reason: "Playwright is not installed" };
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }

  const deadline = now() + request.policy.maxWallClockMs;
  const remaining = () => {
    const value = deadline - now();
    if (value <= 0) throw new ImportSecurityError("dynamic capture exceeded maxWallClockMs");
    return value;
  };
  let browser: BrowserLike | null = null;
  let context: BrowserContextLike | null = null;
  let totalResponseBytes = 0;
  let interceptedRequests = 0;
  let navigationRequests = 0;
  let blockedWriteRequests = 0;
  let routeFailure: Error | null = null;

  try {
    browser = await playwright.chromium.launch({ headless: true });
    context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
      ignoreHTTPSErrors: false,
    });
    if (typeof context.routeWebSocket !== "function") {
      throw new ImportSecurityError("Playwright adapter lacks WebSocket blocking capability");
    }
    await context.routeWebSocket("**/*", (webSocket) => webSocket.close());
    await context.route("**/*", async (route) => {
      if (routeFailure) { await route.abort(); return; }
      try {
        const browserRequest = route.request();
        const target = validateNavigationUrl(browserRequest.url(), request.policy, request.networkPolicy);
        const addresses = await validatedAddresses(target, request, resolveHost);
        interceptedRequests += 1;
        if (interceptedRequests > request.policy.maxAssets + 1) throw new ImportSecurityError("dynamic capture exceeds bounded request count");
        if (browserRequest.isNavigationRequest()) {
          navigationRequests += 1;
          if (navigationRequests > request.policy.maxRedirects + 1) throw new ImportSecurityError("dynamic capture exceeds maxRedirects");
        }

        const method = browserRequest.method().toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          blockedWriteRequests += 1;
          await route.abort();
          if (browserRequest.isNavigationRequest()) {
            routeFailure = new ImportSecurityError("dynamic capture blocks write-capable navigation requests");
          }
          return;
        }

        const response = await fetchHttp(target, {
          addresses,
          timeoutMs: remaining(),
          maxBytes: request.policy.maxAssetBytes,
          method,
          headers: sanitizeReadOnlyRequestHeaders(await browserRequest.allHeaders()),
        });
        remaining();
        totalResponseBytes += response.body.byteLength;
        if (totalResponseBytes > request.policy.maxTotalBytes) throw new ImportSecurityError("dynamic capture exceeds maxTotalBytes");
        await route.fulfill({ status: response.status, headers: response.headers, body: response.body });
      } catch (error) {
        routeFailure = error instanceof Error ? error : new Error(String(error));
        await route.abort();
      }
    });

    const page = await context.newPage();
    await page.goto(initial.href, { waitUntil: "domcontentloaded", timeout: remaining() });
    if (routeFailure) throw routeFailure;
    const finalUrl = validateNavigationUrl(page.url(), request.policy, request.networkPolicy);
    await validatedAddresses(finalUrl, request, resolveHost);
    const html = await page.content();
    if (routeFailure) throw routeFailure;

    const proposal = importHtmlSnapshot({
      ...request,
      source: { ...request.source, uri: request.source.uri ?? initial.href, baseUrl: finalUrl.href },
    }, html);
    if (proposal.diagnostics.length < proposal.policy.maxDiagnostics) {
      proposal.diagnostics.push({
        code: "dynamic-capture-completed",
        severity: "info",
        message: `Captured isolated dynamic HTML after ${interceptedRequests} bounded requests, ${blockedWriteRequests} blocked write requests, and ${totalResponseBytes} response bytes`,
      });
    }
    return { status: "ok", value: proposal };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (context) { try { await context.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
  }
}
