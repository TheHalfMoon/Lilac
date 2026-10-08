import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The projects folder, shared by every way of running Lilac (local web mode and the
// desktop app), so each sees the same projects.

/** `chosen`, else LILAC_PROJECTS, else "Lilac Projects" in the home folder. */
export function projectsFolder(chosen?: string): string {
  return resolve(chosen ?? process.env.LILAC_PROJECTS ?? join(homedir(), "Lilac Projects"));
}

/**
 * Make sure the projects folder exists. A folder Lilac creates is this user's alone. An
 * existing one is left as it is (it may be shared on purpose); the note says when other
 * users can read it (Lilac's own files in it are owner-only anyway).
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
