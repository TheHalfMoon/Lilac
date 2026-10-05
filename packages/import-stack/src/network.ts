import { isIP } from "node:net";
import { ImportSecurityError, ImportValidationError } from "./errors.ts";
import type { ImportPolicy } from "./types.ts";
import { assertSafeProvenanceUrl } from "./validation.ts";

function ipv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map((part) => Number.parseInt(part, 10));
}

export function isLoopbackAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) return v4[0] === 127;
  const lower = address.toLowerCase();
  return lower === "::1" || lower === "0:0:0:0:0:0:0:1";
}

export function isForbiddenRemoteAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) {
    const [a, b, c] = v4;
    return (
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224
    );
  }
  if (isIP(address) !== 6) return true;
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isForbiddenRemoteAddress(lower.slice("::ffff:".length));
  if (lower === "::" || isLoopbackAddress(lower) || lower.startsWith("ff") || lower.startsWith("2001:db8:")) return true;
  const first = Number.parseInt(lower.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  return false;
}

export function validateNavigationUrl(raw: string, policy: ImportPolicy): URL {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 4096) {
    throw new ImportValidationError("navigation URL must be a bounded non-empty string");
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new ImportValidationError("navigation URL is invalid"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ImportSecurityError("navigation URL must use http or https");
  }
  assertSafeProvenanceUrl(url.href, "navigation URL");
  if (!policy.allowNetwork || policy.mode === "offline") throw new ImportSecurityError("network is disabled by import policy");
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const literal = hostname.replace(/^\[|\]$/gu, "");
  if (policy.mode === "local-app") {
    if (!policy.allowLoopback) throw new ImportSecurityError("local-app mode requires loopback capability");
    if (hostname !== "localhost" && !hostname.endsWith(".localhost") && !isLoopbackAddress(literal)) {
      throw new ImportSecurityError("local-app mode only permits loopback targets");
    }
  } else if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || (isIP(literal) !== 0 && isForbiddenRemoteAddress(literal))
  ) {
    throw new ImportSecurityError("remote mode rejects local/private/reserved targets");
  }
  return url;
}

export function validateResolvedAddresses(url: URL, addresses: readonly string[], policy: ImportPolicy): void {
  if (addresses.length === 0) throw new ImportSecurityError("target resolution returned no addresses");
  for (const address of addresses) {
    if (isIP(address) === 0) throw new ImportSecurityError("resolver returned a non-IP address");
    if (policy.mode === "local-app") {
      if (!isLoopbackAddress(address)) throw new ImportSecurityError("local-app resolution escaped loopback");
    } else if (policy.mode === "remote") {
      if (isForbiddenRemoteAddress(address)) throw new ImportSecurityError(`remote target resolved to forbidden address ${address}`);
    } else {
      throw new ImportSecurityError("offline policy cannot resolve network addresses");
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ImportSecurityError("resolved target protocol is unsupported");
}
