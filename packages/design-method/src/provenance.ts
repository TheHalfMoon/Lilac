export const DESIGN_METHOD_PROVENANCE = {
  package: "@ninerr/design-method",
  guidanceDonors: [
    {
      donor: "Appllama/appllama-skills",
      revision: "dd5caaec3d5d50ad7fc0324da238119c6b7c3707",
      license: "MIT",
      studiedSurfaces: [
        "skills/appllama-app-design-skill/SKILL.md",
        "skills/appllama-app-design-skill/references/",
      ],
      posture: "Method guidance only. Lilac authors its own explainable, deterministically checkable rule packs; no donor screens, assets, text, or MCP wiring is imported.",
    },
    {
      donor: "reinaldosimoes/design-resources",
      revision: "43fe2b5d801e34c21e22b5639711f7e250a798e5",
      license: "CC0-1.0",
      studiedSurfaces: ["README.md category taxonomy"],
      posture: "Taxonomy shape only. Lilac keeps a fixed category set and requires explicit per-entry licensing; no links or assets are bulk-copied and linked-asset licensing is never assumed.",
    },
  ],
} as const;
