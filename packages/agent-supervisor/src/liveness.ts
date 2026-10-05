import { SupervisorRuntimeError } from "./errors.ts";
import type { LivenessClassification, LivenessSignals, ProgressCheckpoint, StaleState } from "./types.ts";

function progressChanged(current: ProgressCheckpoint | null, previous: ProgressCheckpoint | null): boolean {
  if (current === null) return false;
  if (previous === null) return true;
  return current.sourceHead !== previous.sourceHead
    || current.dirtyDigest !== previous.dirtyDigest
    || current.eventSequence > previous.eventSequence;
}

function activeWait(signals: LivenessSignals): boolean {
  if (signals.declaredWait === null) return false;
  const now = Date.parse(signals.now);
  return now >= Date.parse(signals.declaredWait.startedAt) && now <= Date.parse(signals.declaredWait.validUntil);
}

export function classifyLiveness(previous: StaleState, signals: LivenessSignals): LivenessClassification {
  const now = Date.parse(signals.now);
  if (Number.isNaN(now)) throw new SupervisorRuntimeError("liveness now timestamp is invalid");
  if (!Number.isFinite(signals.staleAfterMs) || signals.staleAfterMs < 0) {
    throw new SupervisorRuntimeError("staleAfterMs must be finite and non-negative");
  }
  if (!Number.isFinite(signals.confirmAfterMs) || signals.confirmAfterMs < signals.staleAfterMs) {
    throw new SupervisorRuntimeError("confirmAfterMs must be finite and at least staleAfterMs");
  }
  if (signals.runtime === "dead" || signals.runtime === "gone") {
    return {
      state: "recovery-requested",
      staleWindows: Math.max(1, previous.staleWindows + (previous.state === "recovery-requested" ? 0 : 1)),
      changed: previous.state !== "recovery-requested",
      reason: `runtime is ${signals.runtime}`,
    };
  }
  if (signals.runtime === "missing" || signals.runtime === "unknown") {
    const state = previous.state === "stale-confirmed" ? "stale-confirmed" : "stale-suspected";
    return { state, staleWindows: Math.max(1, previous.staleWindows), changed: previous.state !== state, reason: `runtime state ${signals.runtime} is not positive absence evidence` };
  }
  if (progressChanged(signals.currentProgress, signals.previousProgress)) {
    return { state: "healthy", staleWindows: 0, changed: previous.state !== "healthy", reason: "useful progress observed" };
  }
  if (activeWait(signals)) {
    return { state: "healthy", staleWindows: 0, changed: previous.state !== "healthy", reason: "declared wait is active" };
  }
  if (["recovery-requested", "recovering", "recovery-refused", "terminal-failure"].includes(previous.state)) {
    return {
      state: previous.state,
      staleWindows: previous.staleWindows,
      changed: false,
      reason: "recovery escalation is monotonic until explicit progress or lifecycle resolution",
    };
  }
  if (signals.lastProgressAt === null) {
    return { state: "healthy", staleWindows: 0, changed: previous.state !== "healthy", reason: "no stale baseline exists" };
  }
  const lastProgressAt = Date.parse(signals.lastProgressAt);
  if (Number.isNaN(lastProgressAt) || lastProgressAt > now) {
    throw new SupervisorRuntimeError("lastProgressAt is invalid or in the future");
  }
  const age = now - lastProgressAt;
  if (age <= signals.staleAfterMs || !signals.activeOperation) {
    return { state: "healthy", staleWindows: 0, changed: previous.state !== "healthy", reason: "progress is within the allowed window" };
  }
  if (age <= signals.confirmAfterMs || (previous.state !== "stale-suspected" && previous.state !== "stale-confirmed")) {
    return { state: "stale-suspected", staleWindows: Math.max(1, previous.staleWindows), changed: previous.state !== "stale-suspected", reason: "runtime is alive but useful progress is stale" };
  }
  return {
    state: "stale-confirmed",
    staleWindows: Math.max(2, previous.staleWindows + (previous.state === "stale-confirmed" ? 0 : 1)),
    changed: previous.state !== "stale-confirmed",
    reason: "multiple liveness signals confirm a useful-progress wedge",
  };
}

export function applyLivenessClassification(previous: StaleState, classification: LivenessClassification, transitionAt: string): { state: StaleState; shouldEmit: boolean } {
  if (Number.isNaN(Date.parse(transitionAt))) throw new SupervisorRuntimeError("transition timestamp is invalid");
  const shouldEmit = classification.state !== previous.lastEmittedState;
  return {
    state: {
      state: classification.state,
      staleWindows: classification.staleWindows,
      lastTransitionAt: classification.changed ? transitionAt : previous.lastTransitionAt,
      lastEmittedState: shouldEmit ? classification.state : previous.lastEmittedState,
    },
    shouldEmit,
  };
}