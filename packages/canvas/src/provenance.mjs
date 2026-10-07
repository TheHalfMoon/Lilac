export const CANVAS_PROVENANCE = Object.freeze({
  package: "@lilac/canvas",
  posture:
    "Project-owned canvas over @lilac/renderer: viewport (pan and zoom), hit testing through the renderer's node identity, selection, and move, resize, reorder, insert and delete commands that produce history operations. It never mutates the document. No dependencies beyond the renderer and no donor code.",
});
