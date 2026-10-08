// Host files and settings from before the product was named Ninerr. They are read so an
// existing setup keeps working, and never written: anything saved again is saved under the
// Ninerr name, and the legacy file is left as it was. Everything that recognizes the legacy
// identity on the host side lives here.
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEGACY_AGENT_REGISTRY_FILE = ".lilac-agents.json";
export const LEGACY_CODEBASE_LINKS_FILE = ".lilac-codebases.json";
/** Credentials issued before the rename keep authenticating (only their sha256 is stored). */
export const LEGACY_AGENT_TOKEN_PREFIX = "lilac_agent_";
export const LEGACY_PROJECTS_ENV = "LILAC_PROJECTS";
export const legacyProjectsFolder = (): string => join(homedir(), "Lilac Projects");

/** The path, when it exists as anything at all (links included). */
export function existing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a registry is read from: the Ninerr file when it exists, otherwise the legacy one
 * when that exists. `legacy` tells the caller to save under `current` before the next change.
 */
export function registrySource(projectsRoot: string, current: string, legacy: string): { path: string; legacy: boolean } {
  const path = join(projectsRoot, current);
  if (existing(path)) return { path, legacy: false };
  const legacyPath = join(projectsRoot, legacy);
  return existing(legacyPath) ? { path: legacyPath, legacy: true } : { path, legacy: false };
}
