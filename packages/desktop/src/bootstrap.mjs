// The packaged desktop app's entry point. In a checkout, npm workspaces link each
// workspace package into node_modules. A packaged app has no such links (archives
// for Windows cannot hold them), and Node does not strip TypeScript types under
// node_modules. So the packaged app keeps every package at packages/<name>, and this
// resolves each workspace package to that package's own entry, as its package.json exports it,
// before loading the shell.
import { registerHooks } from "node:module";
import { resolveWorkspaceEntry } from "./resolve.mjs";

const APP_ROOT = new URL("../../../", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Only a package's own entry is mapped; anything else in the scope is refused (resolve.mjs).
    const url = resolveWorkspaceEntry(specifier, APP_ROOT);
    if (url === null) return nextResolve(specifier, context);
    // The format is left to Node, which strips the types of a .ts entry.
    return { url, shortCircuit: true };
  },
});

await import("./main.mjs");
