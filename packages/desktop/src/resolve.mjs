// How the packaged desktop app resolves a workspace package. In a checkout, npm workspaces
// link each package into node_modules; a packaged app has no such links, so each package is
// kept at packages/<name> and resolved to its own entry here. Plain functions over an app
// root, so the rules can be tested without Electron.
import { readFileSync } from "node:fs";

// The workspace scope.
const SCOPE = /^@ninerr\/([a-z][a-z0-9-]*)$/u;
// Refused unless mapped above, matched without regard to case (on a case-insensitive
// filesystem, another spelling could reach a link outside the app): the workspace scope,
// and the scope the packages had before the rename, which a stale checkout may still link.
const IN_SCOPE = /^@(?:ninerr|lilac)\//iu;

/**
 * The URL a specifier resolves to inside the app at `appRoot`, or null when it is not a
 * workspace package and normal resolution applies. Anything else in a workspace scope is
 * refused, and so is a package whose manifest names itself differently from the specifier,
 * so a packaged app can never reach a link outside it, nor quietly accept a stale name.
 */
export function resolveWorkspaceEntry(specifier, appRoot) {
  const match = SCOPE.exec(specifier);
  if (match === null) {
    if (IN_SCOPE.test(specifier)) throw new Error(`${specifier} is not a packaged workspace package entry`);
    return null;
  }
  const name = match[1];
  const manifest = JSON.parse(readFileSync(new URL(`packages/${name}/package.json`, appRoot), "utf8"));
  if (manifest.name !== specifier) throw new Error(`${specifier} is not the name of packages/${name} (${String(manifest.name).slice(0, 80)})`);
  const exported = typeof manifest.exports === "string" ? manifest.exports : manifest.exports?.["."];
  if (typeof exported !== "string" || !exported.startsWith("./")) throw new Error(`the workspace package ${name} has no single entry`);
  return new URL(`packages/${name}/${exported.slice(2)}`, appRoot).href;
}
