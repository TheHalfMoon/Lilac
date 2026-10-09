import { CodeIrConflictError } from "./errors.ts";
import { CODE_IR_HARD_LIMITS, type CodeIr, type PatchOp } from "./types.ts";
import { normalizeCodeIr, normalizePatchOp } from "./validation.ts";

export interface PatchFileInput {
  path: string;
  content: string;
}

/**
 * Apply AST-aware patches by verified source range. Every anchor's expected
 * text must match the live source exactly; mismatches, overlaps, and unknown
 * symbols are conflicts, never silent edits. Later operations see earlier
 * ones, so ranges refer to the evolving document in order.
 */
export function applyPatch(irInput: CodeIr, filesInput: PatchFileInput[], opsInput: unknown[]): { files: PatchFileInput[]; applied: number } {
  const ir = normalizeCodeIr(irInput);
  if (!Array.isArray(filesInput) || filesInput.length === 0) {
    throw new CodeIrConflictError("patch requires at least one source file");
  }
  if (!Array.isArray(opsInput)) throw new CodeIrConflictError("patch operations must be an array");
  if (opsInput.length > CODE_IR_HARD_LIMITS.maxPatchOps) {
    throw new CodeIrConflictError(`this change has ${opsInput.length} edits, more than the ${CODE_IR_HARD_LIMITS.maxPatchOps} one write-back can carry`);
  }
  const ops = opsInput.map((op, index) => normalizePatchOp(op, index));
  const files = new Map<string, string>();
  for (const file of filesInput) {
    if (file === null || typeof file !== "object" || typeof (file as PatchFileInput).path !== "string" || typeof (file as PatchFileInput).content !== "string") {
      throw new CodeIrConflictError("patch files must carry a path and string content");
    }
    files.set((file as PatchFileInput).path, (file as PatchFileInput).content);
  }
  let applied = 0;
  for (const op of ops) {
    const symbol = ir.symbols[op.targetSymbolId];
    if (!symbol) throw new CodeIrConflictError(`patch target ${op.targetSymbolId} is unknown`);
    const content = files.get(op.anchor.range.file);
    if (content === undefined) throw new CodeIrConflictError(`patch anchor file ${op.anchor.range.file} is not provided`);
    const { startOffset, endOffset, expectedText } = { startOffset: op.anchor.range.startOffset, endOffset: op.anchor.range.endOffset, expectedText: op.anchor.expectedText };
    if (startOffset < 0 || endOffset > content.length || endOffset < startOffset) {
      throw new CodeIrConflictError(`patch anchor range for ${op.targetSymbolId} is out of bounds`);
    }
    const live = content.slice(startOffset, endOffset);
    if (live !== expectedText) {
      throw new CodeIrConflictError(`patch anchor mismatch for ${op.targetSymbolId}: expected ${JSON.stringify(expectedText)} but found ${JSON.stringify(live)}`);
    }
    const sameSpan = (file: string, aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
      file === op.anchor.range.file && aStart === bStart && aEnd === bEnd;
    if (op.op === "update-prop") {
      const owned = symbol.props.some((prop) => sameSpan(prop.range.file, prop.range.startOffset, prop.range.endOffset, startOffset, endOffset));
      if (!owned) throw new CodeIrConflictError(`update-prop anchor is not a recorded prop of ${op.targetSymbolId}`);
    } else if (op.op === "update-text") {
      const owned = symbol.texts.some((text) => sameSpan(text.range.file, text.range.startOffset, text.range.endOffset, startOffset, endOffset));
      if (!owned) throw new CodeIrConflictError(`update-text anchor is not a recorded text of ${op.targetSymbolId}`);
    } else if (op.op === "insert-prop") {
      if (startOffset !== endOffset) throw new CodeIrConflictError("insert-prop anchors must be zero-width");
      if (op.anchor.range.file !== symbol.range.file || startOffset < symbol.range.startOffset || endOffset > symbol.range.endOffset) {
        throw new CodeIrConflictError(`insert-prop anchor lies outside ${op.targetSymbolId}`);
      }
    } else {
      throw new CodeIrConflictError(`patch operation ${op.op} is unsupported`);
    }
    files.set(op.anchor.range.file, content.slice(0, startOffset) + op.replacement + content.slice(endOffset));
    applied += 1;
  }
  return { files: [...files.entries()].map(([path, content]) => ({ path, content })), applied };
}
