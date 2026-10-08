export const SEMANTIC_ROLES = [
  "button",
  "link",
  "heading",
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "complementary",
  "form",
  "region",
  "search",
  "list",
  "listitem",
  "img",
  "textbox",
  "searchbox",
  "spinbutton",
  "listbox",
  "checkbox",
  "radio",
  "combobox",
  "dialog",
  "tab",
  "tablist",
  "tabpanel",
  "menu",
  "menuitem",
] as const;
export type SemanticRole = (typeof SEMANTIC_ROLES)[number];

/** How a semantic fact was established. Intake only ever records markup it saw. */
export type EvidenceClass = "OBSERVED";

export interface SemanticRecord {
  nodeId: string;
  role: SemanticRole;
  evidence: EvidenceClass;
  /** What in the markup established the role, e.g. `tag:button`, `aria-role:button`, `input-type:checkbox`. */
  source: string;
  /** Heading level 1-6, when the role is heading. */
  level?: number;
  /** Accessible name from aria-label or alt, when present in markup. */
  name?: string;
  /** For img: whether an alt attribute was present (an empty alt marks decoration). */
  hasAlt?: boolean;
}

export interface SemanticReport {
  records: SemanticRecord[];
  /** Explicit ARIA roles that are not on the allow-list; reported, never applied. */
  unknownRoles: Array<{ nodeId: string; role: string }>;
  /** Native semantics that an explicit ARIA role overrode. */
  overrides: Array<{ nodeId: string; native: SemanticRole; aria: SemanticRole }>;
}

export interface ImportReview {
  proposalId: string;
  inputSha256: string;
  source: { kind: string; uri: string | null };
  counts: {
    roots: number;
    nodes: number;
    byKind: Record<string, number>;
    assets: number;
    assetBytes: number;
    resources: number;
    stylesheets: number;
  };
  security: Record<string, number>;
  diagnostics: {
    error: number;
    warning: number;
    info: number;
    items: Array<{ code: string; severity: "info" | "warning" | "error"; message: string; nodeId: string | null }>;
    /** Items beyond the review cap that were counted but not listed. */
    truncated: number;
  };
  sourceBindings: { bound: number; elements: number };
  semantics: { byRole: Partial<Record<SemanticRole, number>>; unknownRoles: number; overrides: number };
  /** Accessibility findings from @ninerr/design-assurance; advisory, they do not block the commit. */
  accessibility: {
    findings: number;
    byRule: Record<string, number>;
    items: Array<{ ruleId: string; wcag: string; severity: string; message: string; nodeId: string | null }>;
    /** Items beyond the review cap that were counted but not listed. */
    truncated: number;
  };
  commitReady: boolean;
  blockingReasons: string[];
}

export interface IntakeCommitResult {
  revision: number;
  transactionId: string;
  review: ImportReview;
  semanticNodes: number;
}
