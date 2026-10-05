import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { createAssetRecord } from "./assets.ts";
import { ImportConflictError, ImportSecurityError, ImportValidationError } from "./errors.ts";
import { createImportJobDirectory, safeRemoveImportJobDirectory } from "./filesystem.ts";
import { importHtmlSnapshot } from "./html.ts";
import { sanitizeImportedCssText } from "./security.ts";
import { validateNavigationUrl, validateResolvedAddresses } from "./network.ts";
import type {
  AdapterResult,
  ImportProposal,
  ImportRequest,
  StaticMirrorManifest,
  StaticMirrorResource,
  StaticMirrorResult,
} from "./types.ts";
import { canonicalImportStringify, normalizeImportRequest, sha256Text } from "./validation.ts";

export interface MirrorFetchResult { status: number; headers: Record<string, string>; body: Uint8Array; }
export interface MirrorFetchOptions { addresses: string[]; timeoutMs: number; maxBytes: number; signal?: AbortSignal; }
export interface StaticMirrorDependencies {
  resolveHost?: (hostname: string) => Promise<string[]>;
  fetchResource?: (url: URL, options: MirrorFetchOptions) => Promise<MirrorFetchResult>;
  now?: () => number;
}
export interface StaticMirrorOptions { jobId: string; workRoot: string; signal?: AbortSignal; }

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const result = await lookup(hostname, { all: true, verbatim: true });
  return result.map((entry) => entry.address);
}

async function defaultFetchResource(url: URL, options: MirrorFetchOptions): Promise<MirrorFetchResult> {
  const selected = options.addresses[0];
  if (!selected) throw new ImportSecurityError("mirror fetch has no validated address");
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const req = requester({
      protocol: url.protocol,
      hostname: url.hostname,
      servername: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { accept: "*/*", "accept-encoding": "identity", "user-agent": "LilacImportStack/1" },
      lookup: (_hostname, _options, callback) => callback(null, selected, selected.includes(":") ? 6 : 4),
      signal: options.signal,
    }, (response) => {
      const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
      if (encoding !== "identity") {
        response.destroy(new ImportSecurityError("mirror response encoding must be identity"));
        return;
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const declared = Number.parseInt(String(response.headers["content-length"] ?? ""), 10);
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        response.destroy(new ImportSecurityError("mirror response exceeds maxAssetBytes"));
        return;
      }
      response.on("data", (chunk: Uint8Array) => {
        total += chunk.byteLength;
        if (total > options.maxBytes) {
          response.destroy(new ImportSecurityError("mirror response exceeds maxAssetBytes"));
          return;
        }
        chunks.push(Uint8Array.from(chunk));
      });
      response.on("error", (error) => { if (!settled) { settled = true; rejectPromise(error); } });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const headers: Record<string, string> = Object.create(null);
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(", ");
          else if (value !== undefined) headers[key.toLowerCase()] = String(value);
        }
        resolvePromise({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))) });
      });
    });
    req.setTimeout(options.timeoutMs, () => req.destroy(new ImportSecurityError("mirror request timed out")));
    req.on("error", (error) => { if (!settled) { settled = true; rejectPromise(error); } });
    req.end();
  });
}

function mediaType(headers: Record<string, string>): string {
  const value = headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  return value && value.length <= 256 ? value : "application/octet-stream";
}
function isRedirect(status: number): boolean { return status >= 300 && status < 400; }
function scopePrefix(entry: URL): string {
  if (entry.pathname.endsWith("/")) return entry.pathname;
  const parent = dirname(entry.pathname.replace(/\\/gu, "/"));
  return parent === "/" ? "/" : `${parent}/`;
}
function isPageInScope(candidate: URL, entry: URL, prefix: string): boolean {
  return candidate.origin === entry.origin && candidate.pathname.startsWith(prefix);
}
function looksHtml(url: URL, type: string): boolean {
  return type === "text/html" || /\.(?:html?|xhtml)$/iu.test(url.pathname) || !/\.[a-z0-9]{1,8}$/iu.test(url.pathname);
}
function looksCss(url: URL, type: string): boolean { return type === "text/css" || /\.css$/iu.test(url.pathname); }
function decodeUtf8(bytes: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ImportValidationError(`${label} is not valid UTF-8`); }
}
function fetchCanonical(url: URL): URL {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy;
}
function discoverCssUrls(css: string, baseUrl: URL): string[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const found = new Set<string>();
  for (const pattern of [/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/giu, /@import\s+(?:url\()?\s*(['"])([^'"]+)\1/giu]) {
    for (const match of plain.matchAll(pattern)) {
      const raw = (match[2] ?? "").trim();
      if (!raw || raw.startsWith("data:") || raw.startsWith("#")) continue;
      try {
        const target = fetchCanonical(new URL(raw, baseUrl));
        if (target.protocol === "http:" || target.protocol === "https:") found.add(target.href);
      } catch {}
    }
  }
  return [...found].sort();
}
async function addressesFor(url: URL, request: ImportRequest, resolveHost: (hostname: string) => Promise<string[]>): Promise<string[]> {
  const literal = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = /^[0-9.]+$/u.test(literal) || literal.includes(":") ? [literal] : await resolveHost(url.hostname);
  validateResolvedAddresses(url, addresses, request.policy);
  return addresses;
}

export async function mirrorStaticSite(
  requestInput: ImportRequest,
  rawUrl: string,
  options: StaticMirrorOptions,
  dependencies: StaticMirrorDependencies = {},
): Promise<AdapterResult<StaticMirrorResult>> {
  let jobDirectory: string | null = null;
  let workRoot: string | null = null;
  let completed = false;
  try {
    const request = normalizeImportRequest(requestInput);
    if (request.source.kind !== "remote-url" && request.source.kind !== "local-app") {
      throw new ImportValidationError("static mirror requires remote-url or local-app source kind");
    }
    const entry = fetchCanonical(validateNavigationUrl(rawUrl, request.policy));
    const prefix = scopePrefix(entry);
    const resolveHost = dependencies.resolveHost ?? defaultResolveHost;
    const fetchResource = dependencies.fetchResource ?? defaultFetchResource;
    const now = dependencies.now ?? Date.now;
    const job = await createImportJobDirectory(options.workRoot, "mirror", options.jobId);
    workRoot = job.workRoot;
    jobDirectory = job.jobDirectory;
    const objectDirectory = join(jobDirectory, "objects");
    await (await import("node:fs/promises")).mkdir(objectDirectory);

    const deadline = now() + request.policy.maxWallClockMs;
    const queue: Array<{ url: string; depth: number; kind: "page" | "asset" }> = [{ url: entry.href, depth: 0, kind: "page" }];
    const queued = new Set([entry.href]);
    const resources: StaticMirrorResource[] = [];
    const rewrites: Record<string, string> = Object.create(null);
    let transferBytes = 0;
    let entryLogicalPath: string | null = null;

    const enqueue = (input: URL, depth: number, kind: "page" | "asset") => {
      const url = fetchCanonical(input);
      if (queued.has(url.href)) return;
      if (queued.size >= request.policy.maxAssets) throw new ImportSecurityError("mirror resource count exceeds maxAssets");
      queued.add(url.href);
      queue.push({ url: url.href, depth, kind });
    };

    while (queue.length > 0) {
      if (options.signal?.aborted) throw new ImportSecurityError("mirror capture cancelled");
      if (now() >= deadline) throw new ImportSecurityError("mirror capture exceeded maxWallClockMs");
      const item = queue.shift()!;
      let current = validateNavigationUrl(item.url, request.policy);
      const original = current.href;
      let redirects = 0;
      let response: MirrorFetchResult;
      for (;;) {
        if (current.origin !== entry.origin) throw new ImportSecurityError("mirror redirect or resource escaped same-origin scope");
        const addresses = await addressesFor(current, request, resolveHost);
        response = await fetchResource(current, {
          addresses,
          timeoutMs: Math.max(1, deadline - now()),
          maxBytes: request.policy.maxAssetBytes,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (now() >= deadline) throw new ImportSecurityError("mirror capture exceeded maxWallClockMs");
        if (options.signal?.aborted) throw new ImportSecurityError("mirror capture cancelled");
        transferBytes += response.body.byteLength;
        if (transferBytes > request.policy.maxTotalBytes) throw new ImportSecurityError("mirror transfer exceeds maxTotalBytes");
        if (!isRedirect(response.status)) break;
        const location = response.headers.location;
        if (!location) throw new ImportValidationError("mirror redirect is missing Location");
        redirects += 1;
        if (redirects > request.policy.maxRedirects) throw new ImportSecurityError("mirror redirect count exceeds maxRedirects");
        const next = fetchCanonical(validateNavigationUrl(new URL(location, current).href, request.policy));
        if (next.origin !== entry.origin) throw new ImportSecurityError("mirror redirect escaped same-origin scope");
        current = next;
      }
      if (response.status < 200 || response.status >= 300) throw new ImportValidationError(`mirror request failed with HTTP ${response.status}`);
      const type = mediaType(response.headers);
      const asset = createAssetRecord(response.body, { mediaType: type, sourceUri: current.href }, request.policy);
      const logicalPath = `objects/${asset.sha256}`;
      const targetPath = join(objectDirectory, asset.sha256);
      try {
        await writeFile(targetPath, response.body, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readFile(targetPath);
        const existingHash = createHash("sha256").update(existing).digest("hex");
        if (existingHash !== asset.sha256) throw new ImportConflictError("mirror object hash collision");
      }
      resources.push({
        sourceUri: original,
        finalUri: current.href,
        mediaType: type,
        sha256: asset.sha256,
        byteLength: asset.byteLength,
        logicalPath,
        depth: item.depth,
      });
      rewrites[original] = logicalPath;
      rewrites[current.href] = logicalPath;
      if (original === entry.href) entryLogicalPath = logicalPath;

      if (looksHtml(current, type)) {
        if (response.body.byteLength > request.policy.maxHtmlBytes) throw new ImportSecurityError("mirrored HTML exceeds maxHtmlBytes");
        const proposal = importHtmlSnapshot({
          ...request,
          source: { ...request.source, uri: current.href, baseUrl: current.href },
        }, decodeUtf8(response.body, "mirrored HTML"));
        for (const reference of proposal.resources) {
          let discovered: URL;
          try { discovered = fetchCanonical(new URL(reference.uri, current)); } catch { continue; }
          if (discovered.origin !== entry.origin) continue;
          if (reference.kind === "link") {
            if (item.depth < request.policy.maxMirrorDepth && isPageInScope(discovered, entry, prefix)) {
              enqueue(discovered, item.depth + 1, "page");
            }
          } else {
            enqueue(discovered, item.depth, "asset");
          }
        }
      } else if (looksCss(current, type)) {
        if (response.body.byteLength > request.policy.maxCssBytes) throw new ImportSecurityError("mirrored CSS exceeds maxCssBytes");
        const css = decodeUtf8(response.body, "mirrored CSS");
        for (const raw of discoverCssUrls(css, current)) {
          const discovered = validateNavigationUrl(raw, request.policy);
          if (discovered.origin === entry.origin) enqueue(discovered, item.depth, "asset");
        }
      }
    }

    if (!entryLogicalPath) throw new ImportConflictError("mirror did not persist the entry document");
    const sortedResources = resources.sort((a, b) => a.sourceUri.localeCompare(b.sourceUri) || a.finalUri.localeCompare(b.finalUri));
    const manifest: StaticMirrorManifest = {
      schemaVersion: 1,
      requestId: request.requestId,
      entryUrl: entry.href,
      entryLogicalPath,
      totalBytes: sortedResources.reduce((total, resource) => total + resource.byteLength, 0),
      resources: sortedResources,
      rewrites: Object.fromEntries(Object.entries(rewrites).sort(([a], [b]) => a.localeCompare(b))),
    };
    await writeFile(join(jobDirectory, "manifest.json"), canonicalImportStringify(manifest), { flag: "wx" });
    completed = true;
    return { status: "ok", value: { jobDirectory, manifest } };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!completed && jobDirectory !== null && workRoot !== null) {
      try { await safeRemoveImportJobDirectory(workRoot, jobDirectory); } catch {}
    }
  }
}

export async function proposalFromStaticMirror(requestInput: ImportRequest, result: StaticMirrorResult): Promise<ImportProposal> {
  const request = normalizeImportRequest(requestInput);
  const bytes = await readFile(join(result.jobDirectory, result.manifest.entryLogicalPath));
  if (bytes.byteLength > request.policy.maxHtmlBytes) throw new ImportSecurityError("mirrored entry exceeds maxHtmlBytes");
  const proposal = importHtmlSnapshot({
    ...request,
    source: { ...request.source, uri: result.manifest.entryUrl, baseUrl: result.manifest.entryUrl },
  }, decodeUtf8(bytes, "mirrored entry"));
  for (const node of Object.values(proposal.nodes)) {
    // External URL attributes are absent until bytes have been captured.
  }
  proposal.resources = proposal.resources.map((resource) => {
    const logical = result.manifest.rewrites[resource.uri];
    if (logical && resource.nodeId && resource.attribute && proposal.nodes[resource.nodeId]) {
      proposal.nodes[resource.nodeId].attributes[resource.attribute] = `./${logical}`;
    }
    return {
      ...resource,
      uri: logical ? `./${logical}` : resource.uri,
    };
  });
  proposal.assets = result.manifest.resources.map((resource) => ({
    assetId: `asset:${resource.sha256}`,
    sha256: resource.sha256,
    byteLength: resource.byteLength,
    mediaType: resource.mediaType,
    logicalName: resource.logicalPath,
    sourceUri: resource.finalUri,
  }));
  for (const resource of result.manifest.resources) {
    if (resource.mediaType !== "text/css") continue;
    const stylesheetBytes = await readFile(join(result.jobDirectory, resource.logicalPath));
    if (stylesheetBytes.byteLength > proposal.policy.maxCssBytes) throw new ImportSecurityError("mirrored stylesheet exceeds maxCssBytes");
    const sanitized = sanitizeImportedCssText(decodeUtf8(stylesheetBytes, "mirrored stylesheet"), proposal.policy.maxCssBytes);
    if (sanitized.cssText !== null && sanitized.cssText !== "") {
      proposal.stylesheets.push({
        id: `import-style:${sha256Text(`${proposal.proposalId}:${resource.finalUri}`).slice(0, 32)}`,
        cssText: sanitized.cssText,
        sourceBinding: { sourceUri: resource.finalUri, domPath: "external-stylesheet" },
      });
    } else if (sanitized.unsafe && proposal.diagnostics.length < proposal.policy.maxDiagnostics) {
      proposal.diagnostics.push({
        code: "unsafe-mirrored-stylesheet-removed",
        severity: "warning",
        message: "Captured stylesheet remains provenance data but was not promoted because it contains external-loading or executable CSS.",
        sourceBinding: { sourceUri: resource.finalUri, domPath: "external-stylesheet" },
      });
    }
  }
  proposal.stylesheets.sort((a, b) => a.id.localeCompare(b.id));
  return proposal;
}

export async function disposeStaticMirror(workRoot: string, result: StaticMirrorResult): Promise<void> {
  await safeRemoveImportJobDirectory(workRoot, result.jobDirectory);
}
