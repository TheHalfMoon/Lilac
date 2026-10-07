import { NODE_FIELDS } from "@lilac/document-model";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { PersistenceCorruptionError, PersistenceValidationError, PersistenceVersionError } from "./errors.ts";
import { PERSISTENCE_LIMITS, type JournalEntry } from "./types.ts";

// Journal format 1, the format project schema 1 writes: exactly these fields on a
// transaction, an operation of each type, and a node record. History drops fields it does
// not know, so a field from a newer format would otherwise replay with its meaning lost;
// it is refused instead: at replay as a version error, and at commit before it is written
// (an unknown operation or node field raises a validation error; history has already dropped
// unknown transaction fields and refused unknown operation types by then).
const TRANSACTION_FIELDS = new Set(["id", "actor", "baseRevision", "intent", "tool", "timestamp", "metadata", "operations"]);
const OPERATION_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  "insert-node": new Set(["type", "node", "parentId", "index"]),
  "remove-node": new Set(["type", "nodeId"]),
  "restore-subtree": new Set(["type", "rootId", "nodes", "parentId", "index"]),
  "set-props": new Set(["type", "nodeId", "set", "unset"]),
  "move-node": new Set(["type", "nodeId", "parentId", "index"]),
});
const NODE_FIELD_SET: ReadonlySet<string> = new Set(NODE_FIELDS);

/** The first way `transaction` departs from journal format 1, or null. */
function journalFormatProblem(transaction: Record<string, unknown>): string | null {
  const extra = (record: Record<string, unknown>, allowed: ReadonlySet<string>) => Object.keys(record).find((key) => !allowed.has(key));
  const field = extra(transaction, TRANSACTION_FIELDS);
  if (field !== undefined) return `transaction field ${JSON.stringify(field).slice(0, 80)}`;
  if (!Array.isArray(transaction.operations)) return null; // history reports the shape
  for (const [index, operation] of transaction.operations.entries()) {
    if (!isRecord(operation)) continue;
    const allowed = Object.hasOwn(OPERATION_FIELDS, String(operation.type)) ? OPERATION_FIELDS[String(operation.type)] : undefined;
    if (allowed === undefined) return `operation type ${JSON.stringify(operation.type).slice(0, 80)}`;
    const opField = extra(operation, allowed);
    if (opField !== undefined) return `field ${JSON.stringify(opField).slice(0, 80)} on operation ${index}`;
    const nodes = [operation.node, ...(Array.isArray(operation.nodes) ? operation.nodes : [])].filter(isRecord);
    for (const node of nodes) {
      const nodeField = extra(node, NODE_FIELD_SET);
      if (nodeField !== undefined) return `node field ${JSON.stringify(nodeField).slice(0, 80)} on operation ${index}`;
    }
  }
  return null;
}

/** Refuse a transaction a journal-format-1 reader would misread. */
export function assertJournalFormat(transaction: Record<string, unknown>, label: string, replay: boolean): void {
  const problem = journalFormatProblem(transaction);
  if (problem === null) return;
  if (replay) throw new PersistenceVersionError(`${label} uses ${problem}, which journal format 1 does not have; it was written by a newer Lilac`);
  throw new PersistenceValidationError(`${label} uses ${problem}, which journal format 1 cannot record`);
}

/** Chain origin, bound to the project so journals cannot be swapped between projects. */
export function genesisDigest(projectId: string): string {
  return sha256Hex(`lilac-journal-genesis:${projectId}`);
}

export function chainDigest(previous: string, encodedEntry: string): string {
  return sha256Hex(`${previous}\n${encodedEntry}`);
}

/** One journal line: canonical JSON of the entry plus the chain digest it produces. */
export function encodeJournalLine(entry: JournalEntry, previousDigest: string): { line: string; digest: string } {
  const encoded = canonicalJson({ seq: entry.seq, revision: entry.revision, transaction: entry.transaction });
  const digest = chainDigest(previousDigest, encoded);
  const line = `${canonicalJson({ digest, entry: JSON.parse(encoded) })}\n`;
  if (Buffer.byteLength(line, "utf8") > PERSISTENCE_LIMITS.maxEntryBytes) {
    throw new PersistenceValidationError(`journal entry exceeds ${PERSISTENCE_LIMITS.maxEntryBytes} bytes`);
  }
  return { line, digest };
}

export interface ParsedJournal {
  entries: Array<{ entry: JournalEntry; digest: string }>;
  tornTailBytes: number;
  validBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Decode and verify one journal line against the chain; throws a corruption error describing `label`. */
function verifyLine(line: string, expectedSeq: number, previous: string, label: string): { entry: JournalEntry; digest: string } {
  if (Buffer.byteLength(line, "utf8") >= PERSISTENCE_LIMITS.maxEntryBytes) {
    throw new PersistenceCorruptionError(`${label} exceeds ${PERSISTENCE_LIMITS.maxEntryBytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new PersistenceCorruptionError(`${label} is not valid JSON`);
  }
  if (!isRecord(parsed) || typeof parsed.digest !== "string" || !isRecord(parsed.entry)) {
    throw new PersistenceCorruptionError(`${label} is malformed`);
  }
  const entry = parsed.entry;
  if (entry.seq !== expectedSeq || !Number.isSafeInteger(entry.revision) || !isRecord(entry.transaction)) {
    throw new PersistenceCorruptionError(`${label} has an invalid sequence or entry`);
  }
  const typed: JournalEntry = { seq: expectedSeq, revision: entry.revision as number, transaction: entry.transaction };
  let encoded: { line: string; digest: string };
  try {
    encoded = encodeJournalLine(typed, previous);
  } catch (error) {
    throw new PersistenceCorruptionError(`${label} cannot be re-encoded: ${(error as Error).message}`);
  }
  if (encoded.digest !== parsed.digest || `${line}\n` !== encoded.line) {
    throw new PersistenceCorruptionError(`${label} breaks the hash chain`);
  }
  return { entry: typed, digest: encoded.digest };
}

/**
 * Parse and verify the whole journal. Every append writes line and newline in one call and
 * is acknowledged only after fsync covers both, so an unterminated final line can only be
 * an unacknowledged write interrupted by a crash: it is a torn tail, reported and removed,
 * even when its bytes happen to form a complete entry. Every other defect is corruption.
 */
export function parseJournal(bytes: Buffer, genesis: string): ParsedJournal {
  // Split on the last newline byte before decoding, so a tail torn inside a multi-byte
  // character is still recognized as a torn tail rather than as corruption.
  const validBytes = bytes.lastIndexOf(0x0a) + 1;
  const tornTailBytes = bytes.length - validBytes;
  let complete: string;
  try {
    complete = UTF8.decode(bytes.subarray(0, validBytes));
  } catch {
    throw new PersistenceCorruptionError("journal is not valid UTF-8");
  }
  const lines = complete === "" ? [] : complete.slice(0, -1).split("\n");
  if (lines.length > PERSISTENCE_LIMITS.maxReplayEntries) {
    throw new PersistenceCorruptionError(`journal exceeds ${PERSISTENCE_LIMITS.maxReplayEntries} entries`);
  }
  const entries: ParsedJournal["entries"] = [];
  let previous = genesis;
  for (const [index, line] of lines.entries()) {
    const verified = verifyLine(line, index + 1, previous, `journal line ${index + 1}`);
    entries.push(verified);
    previous = verified.digest;
  }
  return { entries, tornTailBytes, validBytes };
}
