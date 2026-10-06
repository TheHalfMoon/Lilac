import { canonicalJson, sha256Hex } from "./canonical.ts";
import { PersistenceCorruptionError, PersistenceValidationError } from "./errors.ts";
import { PERSISTENCE_LIMITS, type JournalEntry } from "./types.ts";

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

/**
 * Parse and verify the whole journal. Only an unterminated final line is treated as a torn
 * write (each append writes line and newline in one call); every other defect is corruption.
 */
const UTF8 = new TextDecoder("utf-8", { fatal: true });

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
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new PersistenceCorruptionError(`journal line ${index + 1} is not valid JSON`);
    }
    if (!isRecord(parsed) || typeof parsed.digest !== "string" || !isRecord(parsed.entry)) {
      throw new PersistenceCorruptionError(`journal line ${index + 1} is malformed`);
    }
    const entry = parsed.entry;
    if (entry.seq !== index + 1 || !Number.isSafeInteger(entry.revision) || !isRecord(entry.transaction)) {
      throw new PersistenceCorruptionError(`journal line ${index + 1} has an invalid sequence or entry`);
    }
    const typed: JournalEntry = { seq: entry.seq as number, revision: entry.revision as number, transaction: entry.transaction };
    const { line: expected, digest } = encodeJournalLine(typed, previous);
    if (digest !== parsed.digest || `${line}\n` !== expected) {
      throw new PersistenceCorruptionError(`journal line ${index + 1} breaks the hash chain`);
    }
    entries.push({ entry: typed, digest });
    previous = digest;
  }
  return { entries, tornTailBytes, validBytes };
}
