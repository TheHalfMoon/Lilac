import type { Server } from "node:http";
import { StudioError } from "./errors.ts";

/**
 * The ports browsers refuse to load: the Fetch standard's "bad port" list without 0, which
 * here means "any free port" and is never a port a server is bound to. It is the list Node's
 * fetch refuses (checked against Node 24 for every port up to 10999); Chromium, and so
 * Electron, follows the standard. A host on one of them would serve an
 * editor no browser can open. The operating system can hand one out for port 0 where its
 * dynamic range starts low (Windows' starts at 1024 on some machines), so a host must never
 * keep one.
 */
export const BROWSER_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

const ATTEMPTS = 32;

function listenOnce(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      const address = server.address();
      resolve(address !== null && typeof address === "object" ? address.port : -1);
    });
  });
}

const closed = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/**
 * Listen on `requested` (0 for any free port) and return the port, never one a browser
 * refuses. A requested blocked port is refused; an assigned one is given back and another
 * taken. `next` supplies each attempt's port; tests use it to force a blocked one first.
 */
export async function listenOnBrowserPort(server: Server, requested: number, host: string, next: () => number = () => requested): Promise<number> {
  if (BROWSER_BLOCKED_PORTS.has(requested)) {
    throw new StudioError(400, "blocked-port", `port ${requested} is one browsers refuse to open; choose another, or 0 for any free port`);
  }
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const port = await listenOnce(server, next(), host);
    if (!BROWSER_BLOCKED_PORTS.has(port)) return port;
    await closed(server);
  }
  throw new StudioError(500, "no-usable-port", "no port that browsers can open was free");
}
