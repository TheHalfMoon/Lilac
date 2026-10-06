import { isIP } from "node:net";
import { ImportSecurityError, ImportValidationError } from "./errors.ts";
import type { ImportPolicy } from "./types.ts";
import { assertSafeProvenanceUrl } from "./validation.ts";

function ipv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map((part) => Number.parseInt(part, 10));
}

function expandIpv6(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let source = address.toLowerCase();
  let ipv4Tail: number[] | null = null;
  const lastColon = source.lastIndexOf(":");
  const tail = source.slice(lastColon + 1);
  if (tail.includes(".")) {
    ipv4Tail = ipv4(tail);
    if (!ipv4Tail) return null;
    source = source.slice(0, lastColon) + ":" + (((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16))
      + ":" + (((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16));
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right];
  if (parts.length !== 8) return null;
  const values = parts.map((part) => Number.parseInt(part || "0", 16));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffff)) return null;
  return values;
}

function forbiddenIpv4Parts(parts: number[]): boolean {
  const [a, b, c] = parts;
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

function mappedIpv4(parts: number[]): number[] | null {
  if (
    parts[0] === 0 && parts[1] === 0 && parts[2] === 0
    && parts[3] === 0 && parts[4] === 0 && parts[5] === 0xffff
  ) {
    return [parts[6] >> 8, parts[6] & 0xff, parts[7] >> 8, parts[7] & 0xff];
  }
  return null;
}

export function isLoopbackAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) return v4[0] === 127;
  const v6 = expandIpv6(address);
  if (!v6) return false;
  const mapped = mappedIpv4(v6);
  if (mapped) return mapped[0] === 127;
  return v6.slice(0, 7).every((value) => value === 0) && v6[7] === 1;
}

export function isForbiddenRemoteAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) return forbiddenIpv4Parts(v4);

  const v6 = expandIpv6(address);
  if (!v6) return true;
  const mapped = mappedIpv4(v6);
  if (mapped) return forbiddenIpv4Parts(mapped);

  if (v6.every((value) => value === 0) || isLoopbackAddress(address)) return true;
  if ((v6[0] & 0xfe00) === 0xfc00) return true;
  if ((v6[0] & 0xffc0) === 0xfe80) return true;
  if ((v6[0] & 0xff00) === 0xff00) return true;

  // IPv4 translation/transition prefixes can otherwise hide forbidden IPv4 destinations.
  if (v6[0] === 0x0064 && v6[1] === 0xff9b && (v6[2] === 0 || v6[2] === 1)) return true;
  if (v6[0] === 0x0100 && v6.slice(1, 4).every((value) => value === 0)) return true; // discard-only 100::/64
  if (v6[0] === 0x2001 && v6[1] <= 0x01ff) return true; // IETF special-purpose /23
  if (v6[0] === 0x2001 && v6[1] === 0x0db8) return true; // documentation
  if (v6[0] === 0x2002) return true; // 6to4 embeds IPv4
  if (v6[0] === 0x3fff) return true; // documentation block

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
