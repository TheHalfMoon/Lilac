import type { RulePack } from "./types.ts";
import { normalizeRulePack } from "./validation.ts";

/**
 * Ninerr-authored mobile/native method rules. The method is guided by the
 * studied Appllama skill (native fidelity and navigation laws) but every
 * statement below is project-owned, explainable, and deterministically
 * checkable. No donor screens, assets, or text are reproduced.
 */
const PACK = {
  id: "ninerr-mobile-method",
  title: "Ninerr mobile and native method",
  platform: "universal",
  category: "method",
  version: "1",
  rules: [
    {
      id: "min-touch-target",
      statement: "Every interactive node is at least 44 by 44 points.",
      rationale: "Smaller targets cause misses and read as broken on phones.",
      severity: "major",
    },
    {
      id: "single-display-size",
      statement: "A screen uses at most one display text size at or above 30 points.",
      rationale: "Competing display sizes destroy the type hierarchy.",
      severity: "minor",
    },
    {
      id: "spacing-grid",
      statement: "Node positions and sizes sit on a 4-point grid.",
      rationale: "A shared base unit keeps rhythm; off-grid values read as slop.",
      severity: "minor",
    },
    {
      id: "themed-tokens",
      statement: "Screens that declare light and dark themes resolve tokens for both.",
      rationale: "Unthemed tokens ship invisible or glaring screens in one theme.",
      severity: "major",
    },
    {
      id: "virtualized-long-lists",
      statement: "Lists longer than 30 items are virtualized.",
      rationale: "Unvirtualized long lists jank and blow memory on phones.",
      severity: "minor",
    },
    {
      id: "labeled-images",
      statement: "Every image node carries an accessibility label.",
      rationale: "Unlabeled images are silent holes for screen-reader users.",
      severity: "minor",
    },
    {
      id: "named-interactive-nodes",
      statement: "Every interactive node carries a label.",
      rationale: "Screen readers and reviewers need a name for every control.",
      severity: "major",
    },
  ],
};

export const NINERR_MOBILE_METHOD_PACK: RulePack = normalizeRulePack(PACK);
