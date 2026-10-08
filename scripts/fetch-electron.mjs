#!/usr/bin/env node
// Fetch the pinned Electron runtime for this computer (or --target <platform-arch>), verify
// it against its pinned SHA-256, and unpack it into .lilac-cache/electron. The desktop app's
// tests and packaging use it.
//
//   node scripts/fetch-electron.mjs [--target linux-x64|darwin-arm64|win32-x64]
import { currentTarget, fetchElectron } from "./desktop/electron.mjs";

const args = process.argv.slice(2);
// Nothing, or exactly --target and a value.
if (!(args.length === 0 || (args.length === 2 && args[0] === "--target" && !args[1].startsWith("--")))) {
  process.stderr.write("usage: node scripts/fetch-electron.mjs [--target <platform-arch>]\n");
  process.exit(2);
}
try {
  await fetchElectron(args.length === 2 ? args[1] : currentTarget(), { log: (line) => process.stdout.write(`${line}\n`) });
} catch (error) {
  process.stderr.write(`fetch-electron: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
