import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LEGACY_PROJECTS_ENV, existing, legacyProjectsFolder } from "./legacy.ts";

// The projects folder, shared by every way of running Ninerr (local web mode and the
// desktop app), so each sees the same projects.

const DEFAULT_FOLDER = () => join(homedir(), "Ninerr Projects");

/**
 * `chosen`, else NINERR_PROJECTS, else "Ninerr Projects" in the home folder. Setups from
 * before the rename keep their projects (legacy.ts): the legacy variable is read when
 * NINERR_PROJECTS is not set, and the legacy default folder is used while there is no
 * "Ninerr Projects". Nothing is moved; `note` says which legacy setting was used and how to
 * retire it.
 */
export function resolveProjectsFolder(chosen?: string): { path: string; note: string | null } {
  if (chosen !== undefined) return { path: resolve(chosen), note: null };
  const fromEnv = process.env.NINERR_PROJECTS;
  if (fromEnv !== undefined && fromEnv !== "") return { path: resolve(fromEnv), note: null };
  const legacyEnv = process.env[LEGACY_PROJECTS_ENV];
  if (legacyEnv !== undefined && legacyEnv !== "") {
    return { path: resolve(legacyEnv), note: `${LEGACY_PROJECTS_ENV} is read because NINERR_PROJECTS is not set; rename it to NINERR_PROJECTS` };
  }
  const folder = DEFAULT_FOLDER();
  const legacyFolder = legacyProjectsFolder();
  if (!existing(folder) && existing(legacyFolder)) {
    return { path: resolve(legacyFolder), note: `using the projects folder from before the rename, ${legacyFolder}; rename it to ${folder} to use the new default` };
  }
  return { path: resolve(folder), note: null };
}

/** The projects folder's path; see `resolveProjectsFolder`. */
export function projectsFolder(chosen?: string): string {
  return resolveProjectsFolder(chosen).path;
}

/**
 * Make sure the projects folder exists. A folder Ninerr creates is this user's alone. An
 * existing one is left as it is (it may be shared on purpose); the note says when other
 * users can read it (Ninerr's own files in it are owner-only anyway).
 */
export function prepareProjectsFolder(root: string): { note: string | null } {
  let existed = true;
  try {
    statSync(root);
  } catch {
    existed = false;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (existed && process.platform !== "win32" && (statSync(root).mode & 0o077) !== 0) {
    return { note: `${root} can be read by other users of this computer; its projects can too` };
  }
  return { note: null };
}
