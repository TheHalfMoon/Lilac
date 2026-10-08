// Identity of projects written before the product was named Ninerr (project schema 1).
// Read only: a legacy project is migrated into a new Ninerr project directory and never
// written in this form again. Everything that recognizes the legacy identity lives here.

/** The project directory a schema-1 project lives in, next to where `.ninerr` would be. */
export const LEGACY_PROJECT_DIRECTORY = ".lilac";
/** The manifest `format` of a schema-1 project. */
export const LEGACY_PROJECT_FORMAT = "lilac-project";
/** The journal genesis domain every schema-1 journal was chained from. */
export const LEGACY_JOURNAL_GENESIS = "lilac-journal-genesis";
