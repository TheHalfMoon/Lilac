export const STUDIO_HOST_PROVENANCE = Object.freeze({
  package: "@lilac/studio-host",
  posture:
    "Project-owned studio host composing @lilac/persistence (the project store), @lilac/history (transactions and inverses), @lilac/collaboration (attribution and the access oracle), and @lilac/network-policy (loopback classification). Serves a loopback-only API to the editor; creates no second document authority. No donor code is involved.",
});
