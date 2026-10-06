import { isIP } from "node:net";
import { isForbiddenRemoteAddress, isLoopbackAddress } from "@lilac/network-policy";
import { ImportSecurityError, ImportValidationError } from "./errors.ts";
import type { ImportPolicy } from "./types.ts";
import { assertSafeProvenanceUrl } from "./validation.ts";

// Address classification is owned by @lilac/network-policy; re-exported for compatibility.
export { isForbiddenRemoteAddress, isLoopbackAddress };

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
