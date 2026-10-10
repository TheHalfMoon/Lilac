// Links for the tests that check Ninerr refuses to follow them (P08-G7, #192). A link to a
// directory is a junction on Windows, which any account may create and which Node, like
// Ninerr, sees as a symbolic link, so those tests run everywhere. A link to a file must be a
// true symbolic link, which Windows lets an account create only with Developer Mode on or as
// an administrator; without that right, a test that needs one is skipped and says why.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FILE_LINKS_NEED_RIGHTS = "creating a symbolic link to a file needs Developer Mode or administrator rights on Windows";

const DIRECTORY_LINK = process.platform === "win32" ? "junction" : "dir";

/** Link `path` to the directory `target` (a junction on Windows). */
export function linkDirectory(target, path) {
  symlinkSync(target, path, DIRECTORY_LINK);
}

export async function linkDirectoryAsync(target, path) {
  await symlink(target, path, DIRECTORY_LINK);
}

const fileLinkRefused = (error) => process.platform === "win32" && error?.code === "EPERM";

/** Link `path` to the file `target`; false, with the test skipped, where this account may not. */
export function linkFile(context, target, path) {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch (error) {
    if (!fileLinkRefused(error)) throw error;
    context.skip(FILE_LINKS_NEED_RIGHTS);
    return false;
  }
}

/**
 * Link `path` to the file `target` where this account may, for a test that has other checks
 * to make without it: true when linked, false with a note of the check that did not run.
 */
export function tryLinkFile(context, target, path) {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch (error) {
    if (!fileLinkRefused(error)) throw error;
    context.diagnostic(`not checked with a file link: ${FILE_LINKS_NEED_RIGHTS}`);
    return false;
  }
}

/** Whether this account may create a symbolic link to a file here, found by trying once. */
export const canLinkFiles = (() => {
  const dir = mkdtempSync(join(tmpdir(), "ninerr-link-probe-"));
  try {
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "link"), "file");
    return true;
  } catch (error) {
    if (fileLinkRefused(error)) return false;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
