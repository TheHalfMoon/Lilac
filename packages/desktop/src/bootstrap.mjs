// The packaged desktop app's entry point. In a checkout, npm workspaces link each
// `@lilac/<name>` package into node_modules. A packaged app has no such links (archives
// for Windows cannot hold them), and Node does not strip TypeScript types under
// node_modules. So the packaged app keeps every package at packages/<name>, and this
// resolves `@lilac/<name>` to that package's own entry, as its package.json exports it,
// before loading the shell.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const APP_ROOT = new URL("../../../", import.meta.url);
const SCOPE = /^@lilac\/([a-z][a-z0-9-]*)$/u;

function entryOf(name) {
  const manifest = JSON.parse(readFileSync(new URL(`packages/${name}/package.json`, APP_ROOT), "utf8"));
  const exported = typeof manifest.exports === "string" ? manifest.exports : manifest.exports?.["."];
  if (typeof exported !== "string" || !exported.startsWith("./")) throw new Error(`@lilac/${name} has no single entry`);
  return new URL(`packages/${name}/${exported.slice(2)}`, APP_ROOT).href;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const match = SCOPE.exec(specifier);
    if (match === null) return nextResolve(specifier, context);
    // The format is left to Node, which strips the types of a .ts entry.
    return { url: entryOf(match[1]), shortCircuit: true };
  },
});

await import("./main.mjs");
