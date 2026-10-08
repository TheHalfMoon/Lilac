import { evaluateSnapshot, type DesignSnapshot, type RulePack, type SnapshotNode } from "@ninerr/design-method";
import {
  ASSURANCE_HARD_LIMITS,
  SEVERITY_PENALTY,
  type AssuranceFinding,
  type AssurancePolicy,
  type CandidateAssessment,
  type CandidateInput,
} from "./types.ts";

interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Negative sizes are reported as invalid geometry and excluded from box arithmetic.
function boxOf(node: SnapshotNode): Box | null {
  if (node.x === undefined || node.y === undefined || node.width === undefined || node.height === undefined) return null;
  if (node.width < 0 || node.height < 0) return null;
  return { id: node.id, x: node.x, y: node.y, width: node.width, height: node.height };
}

function onGrid(value: number, grid: number): boolean {
  const ratio = value / grid;
  return Math.abs(ratio - Math.round(ratio)) < 1e-9;
}

function builtin(
  ruleId: string,
  severity: AssuranceFinding["severity"],
  nodeId: string | null,
  measured: AssuranceFinding["measured"],
  expected: string | null,
  message: string,
): AssuranceFinding {
  return { ruleId, source: "builtin", severity, nodeId, measured, expected, message };
}

// Built-in checks are the always-on, policy-configurable baseline. A rule pack with an
// overlapping rule (for example design-method's min-touch-target) reports its own finding
// too; both are major, so eligibility is unchanged and only penalty magnitude doubles.
function accessibilityFindings(snapshot: DesignSnapshot, policy: AssurancePolicy): AssuranceFinding[] {
  const findings: AssuranceFinding[] = [];
  for (const node of snapshot.nodes) {
    if (node.interactive) {
      const smallest = Math.min(node.width ?? Infinity, node.height ?? Infinity);
      if (smallest < policy.minTouchTarget) {
        findings.push(builtin("a11y.touch-target", "major", node.id, smallest, `>= ${policy.minTouchTarget}`, `interactive node ${node.id} has a ${smallest} side, below the ${policy.minTouchTarget} touch target`));
      }
      const name = (node.label?.trim() || node.text?.trim() || "");
      if (name === "") {
        findings.push(builtin("a11y.accessible-name", "major", node.id, null, "non-empty label or text", `interactive node ${node.id} has no accessible name`));
      }
    }
    if (node.text !== undefined && node.textSize !== undefined && node.textSize < policy.minTextSize) {
      findings.push(builtin("a11y.min-text-size", "major", node.id, node.textSize, `>= ${policy.minTextSize}`, `text node ${node.id} uses ${node.textSize}, below the ${policy.minTextSize} minimum`));
    }
  }
  return findings;
}

function overlaps(left: Box, right: Box): boolean {
  return left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height;
}

function layoutFindings(snapshot: DesignSnapshot): AssuranceFinding[] {
  const findings: AssuranceFinding[] = [];
  for (const node of snapshot.nodes) {
    if ((node.width ?? 0) < 0 || (node.height ?? 0) < 0) {
      findings.push(builtin("layout.invalid-geometry", "major", node.id, `${node.width}x${node.height}`, "non-negative width and height", `node ${node.id} has a negative size`));
    }
  }
  const screenNode = snapshot.nodes.find((node) => node.kind === "screen");
  const screen = screenNode ? boxOf({ ...screenNode, x: screenNode.x ?? 0, y: screenNode.y ?? 0 }) : null;
  if (!screen) {
    findings.push(builtin("layout.no-screen-bounds", "info", null, null, "a screen node with width and height", "snapshot has no screen bounds; out-of-bounds checks were skipped"));
  } else {
    for (const node of snapshot.nodes) {
      if (node === screenNode) continue;
      const box = boxOf(node);
      if (!box) continue;
      if (box.x < screen.x || box.y < screen.y || box.x + box.width > screen.x + screen.width || box.y + box.height > screen.y + screen.height) {
        findings.push(builtin("layout.out-of-bounds", "major", node.id, `${box.x},${box.y},${box.width}x${box.height}`, `inside ${screen.x},${screen.y},${screen.width}x${screen.height}`, `node ${node.id} extends outside the screen`));
      }
    }
  }
  // Sweep over x so the common case is near-linear; one finding per overlapping node.
  const interactive = snapshot.nodes
    .filter((node) => node.interactive)
    .map(boxOf)
    .filter((box): box is Box => box !== null && box.width > 0 && box.height > 0)
    .sort((left, right) => left.x - right.x || compareText(left.id, right.id));
  const overlapping = new Set<string>();
  for (let index = 0; index < interactive.length; index += 1) {
    const current = interactive[index];
    for (let next = index + 1; next < interactive.length && interactive[next].x < current.x + current.width; next += 1) {
      if (overlaps(current, interactive[next])) {
        overlapping.add(current.id);
        overlapping.add(interactive[next].id);
      }
    }
  }
  for (const id of [...overlapping].sort()) {
    findings.push(builtin("layout.interactive-overlap", "major", id, null, "no overlap with other interactive nodes", `interactive node ${id} overlaps another interactive node`));
  }
  return findings;
}

function systemFindings(snapshot: DesignSnapshot, policy: AssurancePolicy): AssuranceFinding[] {
  const findings: AssuranceFinding[] = [];
  if (policy.allowedTextSizes) {
    const allowed = new Set(policy.allowedTextSizes);
    for (const node of snapshot.nodes) {
      if (node.textSize !== undefined && !allowed.has(node.textSize)) {
        findings.push(builtin("ds.type-scale", "minor", node.id, node.textSize, `one of ${policy.allowedTextSizes.join(", ")}`, `node ${node.id} uses text size ${node.textSize} outside the type scale`));
      }
    }
  }
  if (policy.spacingGrid !== null) {
    const grid = policy.spacingGrid;
    for (const node of snapshot.nodes) {
      // Screen size is given by the device, not chosen by the design.
      if (node.kind === "screen") continue;
      const box = boxOf(node);
      if (!box) continue;
      const off = [box.x, box.y, box.width, box.height].some((value) => !onGrid(value, grid));
      if (off) {
        findings.push(builtin("ds.spacing-grid", "minor", node.id, `${box.x},${box.y},${box.width}x${box.height}`, `multiples of ${grid}`, `node ${node.id} sits off the ${grid}-unit grid`));
      }
    }
  }
  return findings;
}

function rulePackFindings(snapshot: DesignSnapshot, packs: readonly RulePack[]): AssuranceFinding[] {
  return packs.flatMap((pack) => evaluateSnapshot(snapshot, pack).map((candidate) => ({
    ruleId: `${candidate.packId}/${candidate.ruleId}`,
    source: "rule-pack" as const,
    severity: candidate.severity,
    nodeId: candidate.nodeId,
    measured: null,
    expected: null,
    message: candidate.message,
  })));
}

const SEVERITY_ORDER = { major: 0, minor: 1, info: 2 } as const;

function compareText(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}

function compareFindings(left: AssuranceFinding, right: AssuranceFinding): number {
  return SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || compareText(left.ruleId, right.ruleId)
    || compareText(left.nodeId ?? "", right.nodeId ?? "");
}

/**
 * Deterministic stage for one candidate. Penalty and eligibility are computed over every
 * finding; only the reported list is capped.
 */
export function assessCandidate(candidate: CandidateInput, packs: readonly RulePack[], policy: AssurancePolicy): CandidateAssessment {
  const all = [
    ...accessibilityFindings(candidate.snapshot, policy),
    ...layoutFindings(candidate.snapshot),
    ...systemFindings(candidate.snapshot, policy),
    ...rulePackFindings(candidate.snapshot, packs),
  ].sort(compareFindings);
  const blocking = new Set(policy.blockingSeverities);
  const limit = ASSURANCE_HARD_LIMITS.maxFindingsPerCandidate;
  return {
    candidateId: candidate.candidateId,
    rationale: candidate.rationale,
    snapshotId: candidate.snapshot.snapshotId,
    eligible: !all.some((finding) => blocking.has(finding.severity)),
    penalty: all.reduce((sum, finding) => sum + SEVERITY_PENALTY[finding.severity], 0),
    findings: all.slice(0, limit),
    truncatedFindings: Math.max(0, all.length - limit),
    fit: null,
  };
}
