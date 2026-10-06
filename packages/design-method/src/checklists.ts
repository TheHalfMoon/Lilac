import type { ReviewChecklist, RulePack } from "./types.ts";
import { normalizeChecklist } from "./validation.ts";

function ruleIds(packs: RulePack[]): Set<string> {
  return new Set(packs.flatMap((pack) => pack.rules.map((rule) => `${pack.id}/${rule.id}`)));
}

const LISTS = [
  {
    id: "accessibility-review",
    role: "accessibility reviewer",
    items: [
      { id: "names-for-controls", text: "Every interactive control exposes an accessible name.", ruleIds: ["lilac-mobile-method/named-interactive-nodes"] },
      { id: "labels-for-images", text: "Every meaningful image carries an accessibility label.", ruleIds: ["lilac-mobile-method/labeled-images"] },
      { id: "touch-target-size", text: "Touch targets meet the 44-point minimum.", ruleIds: ["lilac-mobile-method/min-touch-target"] },
    ],
  },
  {
    id: "design-system-guardian",
    role: "design-system guardian",
    items: [
      { id: "theme-coverage", text: "Light and dark themes both resolve tokens.", ruleIds: ["lilac-mobile-method/themed-tokens"] },
      { id: "type-hierarchy", text: "The screen keeps a single display size.", ruleIds: ["lilac-mobile-method/single-display-size"] },
      { id: "spacing-rhythm", text: "Layout sits on the 4-point grid.", ruleIds: ["lilac-mobile-method/spacing-grid"] },
    ],
  },
  {
    id: "mobile-fidelity-review",
    role: "mobile fidelity reviewer",
    items: [
      { id: "list-performance", text: "Long lists virtualize their rows.", ruleIds: ["lilac-mobile-method/virtualized-long-lists"] },
      { id: "control-naming", text: "Controls are named for review and assistive tech.", ruleIds: ["lilac-mobile-method/named-interactive-nodes"] },
    ],
  },
];

export function builtinChecklists(packs: RulePack[]): ReviewChecklist[] {
  const known = ruleIds(packs);
  return LISTS.map((list) => normalizeChecklist(list, known));
}
