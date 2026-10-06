import { CodeIrValidationError } from "./errors.ts";
import { CODE_IR_HARD_LIMITS, type MergeConflict, type MergeResult } from "./types.ts";
import { normalizeMergeConflict } from "./validation.ts";

function splitLines(text: string): string[] {
  return text.split("\n");
}

interface EditOp {
  type: "eq" | "del" | "ins";
  baseIndex: number;
  lines: string[];
}

/**
 * Bounded Myers O(ND) line diff. Returns edit ops over the base lines that
 * produce the target lines. Deterministic for identical inputs.
 */
function diffLines(base: string[], target: string[]): EditOp[] {
  const n = base.length;
  const m = target.length;
  const max = n + m;
  if (max === 0) return [];
  const size = 2 * max + 1;
  const offset = max;
  const v: number[] = new Array<number>(size).fill(-1);
  v[offset + 1] = 0;
  const trace: number[][] = [];
  let depth = 0;
  let done = false;
  for (; depth <= max; depth += 1) {
    for (let k = -depth; k <= depth; k += 2) {
      const index = offset + k;
      let x: number;
      if (k === -depth || (k !== depth && v[index - 1] < v[index + 1])) {
        x = v[index + 1];
      } else {
        x = v[index - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && base[x] === target[y]) {
        x += 1;
        y += 1;
      }
      v[index] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
    trace.push([...v]);
    if (done) break;
  }
  if (!done) throw new CodeIrValidationError("three-way diff failed to converge");
  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = depth; d > 0; d -= 1) {
    const prev = trace[d - 1];
    const k = x - y;
    const index = offset + k;
    let prevK: number;
    if (k === -d || (k !== d && prev[index - 1] < prev[index + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.unshift({ type: "eq", baseIndex: x - 1, lines: [base[x - 1]] });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.unshift({ type: "ins", baseIndex: x, lines: [target[y - 1]] });
      y -= 1;
    } else {
      ops.unshift({ type: "del", baseIndex: x - 1, lines: [base[x - 1]] });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.unshift({ type: "eq", baseIndex: x - 1, lines: [base[x - 1]] });
    x -= 1;
    y -= 1;
  }
  return ops;
}

interface Hunk {
  start: number;
  end: number;
  replacement: string[];
}

function toHunks(ops: EditOp[]): Hunk[] {
  const hunks: Hunk[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op.type === "eq") {
      index += 1;
      continue;
    }
    const start = op.baseIndex;
    let end = op.type === "del" ? op.baseIndex + 1 : op.baseIndex;
    const replacement: string[] = [];
    while (index < ops.length && ops[index].type !== "eq") {
      const current = ops[index];
      if (current.type === "del") end = Math.max(end, current.baseIndex + 1);
      else replacement.push(...current.lines);
      index += 1;
    }
    hunks.push({ start, end, replacement });
  }
  return hunks;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * Bounded three-way merge over Myers diffs. Hunks changed on exactly one
 * side reconcile automatically; hunks changed on both sides reconcile only
 * when identical, otherwise they are conflicts surfaced as data with merged
 * null, so ambiguity never overwrites.
 */
export function threeWayMerge(base: string, ours: string, theirs: string): MergeResult {
  for (const [label, text] of [["base", base], ["ours", ours], ["theirs", theirs]] as const) {
    if (typeof text !== "string") throw new CodeIrValidationError(`three-way ${label} must be a string`);
  }
  const baseLines = splitLines(base);
  const ourLines = splitLines(ours);
  const theirLines = splitLines(theirs);
  for (const lines of [baseLines, ourLines, theirLines]) {
    if (lines.length > CODE_IR_HARD_LIMITS.maxMergeLines) {
      throw new CodeIrValidationError("three-way input exceeds maxMergeLines");
    }
  }
  const oursHunks = toHunks(diffLines(baseLines, ourLines));
  const theirsHunks = toHunks(diffLines(baseLines, theirLines));
  const merged: string[] = [];
  const conflicts: MergeConflict[] = [];
  let baseIndex = 0;
  let oursCursor = 0;
  let theirsCursor = 0;
  const emitBase = (from: number, to: number): void => {
    for (let line = from; line < to; line += 1) merged.push(baseLines[line]);
  };

  for (;;) {
    const oursHunk = oursHunks[oursCursor];
    const theirsHunk = theirsHunks[theirsCursor];
    const nextStart = Math.min(oursHunk?.start ?? baseLines.length, theirsHunk?.start ?? baseLines.length);
    if (nextStart > baseLines.length) break;
    if (nextStart >= baseLines.length && !oursHunk && !theirsHunk) break;
    emitBase(baseIndex, Math.min(nextStart, baseLines.length));
    baseIndex = Math.min(nextStart, baseLines.length);
    const oursActive = oursHunk && oursHunk.start <= baseIndex;
    const theirsActive = theirsHunk && theirsHunk.start <= baseIndex;
    if (!oursActive && !theirsActive) {
      if (!oursHunk && !theirsHunk) break;
      continue;
    }
    if (oursActive && theirsActive) {
      if (oursHunk.end === theirsHunk.end && sameLines(oursHunk.replacement, theirsHunk.replacement)) {
        merged.push(...oursHunk.replacement);
        baseIndex = oursHunk.end;
        oursCursor += 1;
        theirsCursor += 1;
        continue;
      }
      conflicts.push({
        startLine: baseIndex + 1,
        endLineBase: Math.max(oursHunk.end, theirsHunk.end),
        reason: "both sides changed the same region differently",
      });
      return { merged: null, conflicts: conflicts.map((conflict, index) => normalizeMergeConflict(conflict, index)) };
    }
    const active = oursActive ? oursHunk : theirsHunk;
    const other = oursActive ? theirsHunk : oursHunk;
    if (other && other.start < active.end && active.start < other.end
      && !(other.start === active.start && other.end === active.end && sameLines(other.replacement, active.replacement))) {
      conflicts.push({
        startLine: baseIndex + 1,
        endLineBase: Math.max(active.end, other.end),
        reason: "both sides changed overlapping regions differently",
      });
      return { merged: null, conflicts: conflicts.map((conflict, index) => normalizeMergeConflict(conflict, index)) };
    }
    merged.push(...active.replacement);
    baseIndex = Math.max(baseIndex, active.end);
    if (oursActive) oursCursor += 1;
    else theirsCursor += 1;
  }
  emitBase(baseIndex, baseLines.length);
  return { merged: merged.join("\n"), conflicts: [] };
}
