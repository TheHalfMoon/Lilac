import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { ImportAdapterError, ImportSecurityError, ImportValidationError } from "./errors.ts";
import { canonicalFileWithinRoots, createImportJobDirectory, safeRemoveImportJobDirectory } from "./filesystem.ts";
import type { AdapterResult, DocumentAdapterOutput, ImportPolicy } from "./types.ts";
import { normalizeImportJson } from "./validation.ts";

const ALLOWED_FORMATS = new Set(["pdf", "html", "docx", "pptx", "xlsx", "md", "csv"]);
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;

export interface DoclingCommandResult { exitCode: number; stdout: string; stderr: string; }
export interface DoclingCommandOptions { cwd: string; env: Record<string, string>; timeoutMs: number; }
export interface DoclingAdapterDependencies {
  execute?: (command: string, args: string[], options: DoclingCommandOptions) => Promise<DoclingCommandResult>;
}
export interface DoclingLocalInput { path: string; format: string; }
export interface DoclingLocalOptions { jobId: string; workRoot: string; authorizedRoots: string[]; }

function appendBounded(current: string, chunk: Uint8Array): string {
  const next = current + Buffer.from(chunk).toString("utf8");
  if (Buffer.byteLength(next, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
    throw new ImportAdapterError("Docling process output exceeds bounded diagnostic size");
  }
  return next;
}

async function defaultExecute(command: string, args: string[], options: DoclingCommandOptions): Promise<DoclingCommandResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forcedError: unknown = null;
    let stopGrace: ReturnType<typeof setTimeout> | null = null;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopGrace) clearTimeout(stopGrace);
      rejectPromise(error);
    };
    const requestStop = (error: unknown) => {
      if (settled || forcedError !== null) return;
      forcedError = error;
      clearTimeout(timer);
      child.kill();
      stopGrace = setTimeout(() => finishError(error), 5_000);
    };
    const timer = setTimeout(
      () => requestStop(new ImportAdapterError("Docling process exceeded maxWallClockMs")),
      options.timeoutMs,
    );
    child.on("error", (error) => {
      if (forcedError === null) finishError(error);
    });
    child.stdout?.on("data", (chunk: Uint8Array) => {
      try { stdout = appendBounded(stdout, chunk); }
      catch (error) { requestStop(error); }
    });
    child.stderr?.on("data", (chunk: Uint8Array) => {
      try { stderr = appendBounded(stderr, chunk); }
      catch (error) { requestStop(error); }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopGrace) clearTimeout(stopGrace);
      if (forcedError !== null) rejectPromise(forcedError);
      else resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function processEnvironment(workRoot: string): Record<string, string> {
  const env: Record<string, string> = Object.create(null);
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.HF_HUB_OFFLINE = "1";
  env.HF_HUB_DISABLE_TELEMETRY = "1";
  env.TRANSFORMERS_OFFLINE = "1";
  env.DO_NOT_TRACK = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.DOCLING_CACHE_DIR = join(workRoot, "docling-cache");
  return env;
}

function safeFormat(input: DoclingLocalInput): string {
  const format = input.format.toLowerCase();
  if (!ALLOWED_FORMATS.has(format)) throw new ImportValidationError(`unsupported Docling input format ${format}`);
  const suffix = extname(input.path).replace(/^\./u, "").toLowerCase();
  if (suffix && suffix !== format) throw new ImportValidationError(`Docling format ${format} does not match input extension .${suffix}`);
  return format;
}

function countPages(document: unknown): number {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return 0;
  const pages = (document as Record<string, unknown>).pages;
  if (Array.isArray(pages)) return pages.length;
  if (pages !== null && typeof pages === "object") return Object.keys(pages).length;
  return 0;
}

function safeFailureReason(error: unknown): string {
  if (error instanceof ImportAdapterError || error instanceof ImportSecurityError || error instanceof ImportValidationError) {
    return error.message;
  }
  return "Docling local adapter failed";
}

export async function runLocalDocling(
  policy: ImportPolicy,
  input: DoclingLocalInput,
  options: DoclingLocalOptions,
  dependencies: DoclingAdapterDependencies = {},
): Promise<AdapterResult<DocumentAdapterOutput>> {
  let jobDirectory: string | null = null;
  let workRoot: string | null = null;
  try {
    const format = safeFormat(input);
    const source = await canonicalFileWithinRoots(input.path, options.authorizedRoots, "Docling input");
    const sourceStat = await stat(source);
    if (sourceStat.size === 0 || sourceStat.size > policy.maxTotalBytes) throw new ImportSecurityError("Docling input size is outside policy bounds");
    const job = await createImportJobDirectory(options.workRoot, "docling", options.jobId);
    workRoot = job.workRoot;
    jobDirectory = job.jobDirectory;
    const outputPath = join(jobDirectory, "docling-output.json");
    const args = [
      "convert", source,
      "--from", format,
      "--to", "json",
      "--output-file", outputPath,
      "--quiet",
      "--no-enable-remote-services",
      "--no-allow-external-plugins",
    ];
    const execute = dependencies.execute ?? defaultExecute;
    let result: DoclingCommandResult;
    try {
      result = await execute("docling", args, {
        cwd: jobDirectory,
        env: processEnvironment(workRoot),
        timeoutMs: policy.maxWallClockMs,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "unavailable", reason: "Docling CLI is not installed" };
      throw error;
    }
    if (result.exitCode !== 0) {
      return { status: "failed", reason: `Docling exited with code ${result.exitCode}` };
    }
    const outputStat = await stat(outputPath);
    if (!outputStat.isFile() || outputStat.size === 0 || outputStat.size > policy.maxDocumentOutputBytes) {
      throw new ImportSecurityError("Docling output size is outside policy bounds");
    }
    const encoded = await readFile(outputPath, "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(encoded); } catch { throw new ImportValidationError("Docling output is malformed JSON"); }
    const normalized = normalizeImportJson(parsed, "Docling output");
    if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) throw new ImportValidationError("Docling output must be a document object");
    const object = normalized as Record<string, unknown>;
    if (object.schema_name !== "DoclingDocument") throw new ImportValidationError("Docling output schema_name is not DoclingDocument");
    if (typeof object.version !== "string" || object.version.length === 0) throw new ImportValidationError("Docling output version is missing");
    if (!Array.isArray(object.texts)) throw new ImportValidationError("Docling output texts collection is missing");
    if (object.texts.length > policy.maxDomNodes) throw new ImportSecurityError("Docling output text collection exceeds maxDomNodes");
    if (object.body === null || typeof object.body !== "object" || Array.isArray(object.body)) throw new ImportValidationError("Docling output body is missing");
    if (countPages(object) > policy.maxDocumentPages) throw new ImportSecurityError("Docling output exceeds maxDocumentPages");
    return { status: "ok", value: { format: "docling-json", document: normalized } };
  } catch (error) {
    return { status: "failed", reason: safeFailureReason(error) };
  } finally {
    if (jobDirectory !== null && workRoot !== null) {
      try {
        await safeRemoveImportJobDirectory(workRoot, jobDirectory);
      } catch {
        return { status: "failed", reason: "Docling sandbox cleanup failed" };
      }
    }
  }
}
