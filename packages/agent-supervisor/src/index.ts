export * from "./errors.ts";
export * from "./types.ts";
export * from "./records.ts";
export * from "./lease.ts";
export * from "./queue.ts";
export * from "./liveness.ts";
export * from "./recovery.ts";
export * from "./supervisor.ts";
export * from "./local.ts";

export const FIRSTMATE_SUPERVISION_PROVENANCE = Object.freeze({
  repository: "kunchenguid/firstmate",
  revision: "1f3e769616fdf9f31f85f4c3e6a9f71606634238",
  license: "MIT",
  copyright: "Copyright (c) 2026 Kun Chen",
  posture: "port-adapt",
});