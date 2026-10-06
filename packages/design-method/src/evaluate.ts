import type { DesignSnapshot, ReviewCandidate, RulePack, SnapshotNode } from "./types.ts";
import { normalizeRulePack, normalizeSnapshot } from "./validation.ts";

function onGrid(value: number | undefined): boolean {
  if (value === undefined) return true;
  return Number.isInteger(value) && value % 4 === 0;
}

function checkNode(packId: string, ruleId: string, severity: ReviewCandidate["severity"], node: SnapshotNode, message: string): ReviewCandidate {
  return { ruleId, packId, nodeId: node.id, severity, message };
}

function ruleSeverity(pack: RulePack, ruleId: string): ReviewCandidate["severity"] {
  const rule = pack.rules.find((entry) => entry.id === ruleId);
  if (!rule) throw new Error(`unknown rule ${ruleId}`);
  return rule.severity;
}

/**
 * Deterministically evaluate a typed design snapshot against a rule pack.
 * Every candidate names its rule and node; clean snapshots yield none.
 * Judgmental aesthetics are out of scope: only measurable facts are checked.
 */
export function evaluateSnapshot(snapshotInput: DesignSnapshot, packInput: RulePack): ReviewCandidate[] {
  const snapshot = normalizeSnapshot(snapshotInput);
  const pack = normalizeRulePack(packInput);
  const candidates: ReviewCandidate[] = [];
  const ruleIds = new Set(pack.rules.map((rule) => rule.id));

  if (ruleIds.has("min-touch-target")) {
    for (const node of snapshot.nodes) {
      if (!node.interactive) continue;
      if ((node.width ?? 44) < 44 || (node.height ?? 44) < 44) {
        candidates.push(checkNode(pack.id, "min-touch-target", ruleSeverity(pack, "min-touch-target"), node, `interactive node ${node.id} is smaller than 44 by 44 points`));
      }
    }
  }
  if (ruleIds.has("single-display-size")) {
    const display = new Set(
      snapshot.nodes
        .filter((node) => node.text !== undefined && (node.textSize ?? 0) >= 30)
        .map((node) => node.textSize as number),
    );
    if (display.size > 1) {
      candidates.push({
        ruleId: "single-display-size",
        packId: pack.id,
        nodeId: null,
        severity: ruleSeverity(pack, "single-display-size"),
        message: `screen uses ${display.size} competing display sizes: ${[...display].sort((a, b) => a - b).join(", ")} points`,
      });
    }
  }
  if (ruleIds.has("spacing-grid")) {
    for (const node of snapshot.nodes) {
      if (!onGrid(node.x) || !onGrid(node.y) || !onGrid(node.width) || !onGrid(node.height)) {
        candidates.push(checkNode(pack.id, "spacing-grid", ruleSeverity(pack, "spacing-grid"), node, `node ${node.id} sits off the 4-point grid`));
      }
    }
  }
  if (ruleIds.has("themed-tokens")) {
    const themes = snapshot.themes ?? [];
    if (themes.includes("light") && themes.includes("dark") && snapshot.tokensThemed !== true) {
      candidates.push({
        ruleId: "themed-tokens",
        packId: pack.id,
        nodeId: null,
        severity: ruleSeverity(pack, "themed-tokens"),
        message: "screen declares light and dark themes but tokens are not resolved for both",
      });
    }
  }
  if (ruleIds.has("virtualized-long-lists")) {
    for (const node of snapshot.nodes) {
      if (node.kind === "list" && (node.itemCount ?? 0) > 30 && node.virtualized !== true) {
        candidates.push(checkNode(pack.id, "virtualized-long-lists", ruleSeverity(pack, "virtualized-long-lists"), node, `list ${node.id} holds ${node.itemCount} items without virtualization`));
      }
    }
  }
  if (ruleIds.has("labeled-images")) {
    for (const node of snapshot.nodes) {
      if (node.kind === "image" && (node.label ?? "").trim() === "") {
        candidates.push(checkNode(pack.id, "labeled-images", ruleSeverity(pack, "labeled-images"), node, `image ${node.id} has no accessibility label`));
      }
    }
  }
  if (ruleIds.has("named-interactive-nodes")) {
    for (const node of snapshot.nodes) {
      if (node.interactive && (node.label ?? "").trim() === "") {
        candidates.push(checkNode(pack.id, "named-interactive-nodes", ruleSeverity(pack, "named-interactive-nodes"), node, `interactive node ${node.id} has no label`));
      }
    }
  }
  candidates.sort((a, b) => `${a.ruleId}:${a.nodeId ?? ""}`.localeCompare(`${b.ruleId}:${b.nodeId ?? ""}`));
  return candidates;
}
