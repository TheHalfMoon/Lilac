import { isIP } from "node:net";

// Moved from @ninerr/import-stack (Grain 6, qualified in PR #35) so that one package owns
// address classification for every network decision in Lilac. P05 D6b additionally forbids
// site-local fec0::/10 and IPv4-compatible ::/96 (strictly safer than Grain 6).

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

function isTranslatedIpv4(parts: number[]): boolean {
  return parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0 && parts[4] === 0xffff && parts[5] === 0;
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
  if ((v6[0] & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((v6[0] & 0xff00) === 0xff00) return true;
  // Deprecated IPv4-compatible ::/96 can embed any IPv4 destination, including loopback.
  if (v6.slice(0, 6).every((value) => value === 0)) return true;
  // IPv4-translated ::ffff:0:0:0/96 (SIIT) likewise embeds any IPv4 destination
  // (::ffff:0:7f00:1 is 127.0.0.1) and is never a legitimate remote destination.
  if (isTranslatedIpv4(v6)) return true;

  // IPv4 translation/transition prefixes can otherwise hide forbidden IPv4 destinations.
  if (v6[0] === 0x0064 && v6[1] === 0xff9b && (v6[2] === 0 || v6[2] === 1)) return true;
  if (v6[0] === 0x0100 && v6.slice(1, 4).every((value) => value === 0)) return true; // discard-only 100::/64
  if (v6[0] === 0x2001 && v6[1] <= 0x01ff) return true; // IETF special-purpose /23
  if (v6[0] === 0x2001 && v6[1] === 0x0db8) return true; // documentation
  if (v6[0] === 0x2002) return true; // 6to4 embeds IPv4
  if (v6[0] === 0x3fff) return true; // documentation block

  return false;
}

// The IPv4 address an IPv6 form carries, if any: mapped, compatible, translated, NAT64 and
// 6to4 forms can all name an IPv4 destination.
function embeddedIpv4(parts: number[]): number[] | null {
  const tail = [parts[6] >> 8, parts[6] & 0xff, parts[7] >> 8, parts[7] & 0xff];
  if (parts.slice(0, 5).every((value) => value === 0) && (parts[5] === 0xffff || parts[5] === 0)) return tail;
  if (isTranslatedIpv4(parts)) return tail;
  if (parts[0] === 0x0064 && parts[1] === 0xff9b) return tail;
  if (parts[0] === 0x2002) return [parts[1] >> 8, parts[1] & 0xff, parts[2] >> 8, parts[2] & 0xff];
  return null;
}

const metadataIpv4 = ([a, b, c, d]: number[]): boolean => (a === 169 && b === 254) || (a === 100 && b === 100 && c === 100 && d === 200);

/**
 * Link-local and cloud-metadata destinations (169.254.0.0/16, fe80::/10, Alibaba's
 * 100.100.100.200, AWS's fd00:ec2::254), in every IPv4 and IPv6 spelling. These are refused
 * even where private networks are allowed.
 */
export function isLinkLocalOrMetadataAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) return metadataIpv4(v4);
  const v6 = expandIpv6(address);
  if (!v6) return false;
  if ((v6[0] & 0xffc0) === 0xfe80) return true;
  if (v6[0] === 0xfd00 && v6[1] === 0x0ec2 && v6.slice(2, 7).every((value) => value === 0) && v6[7] === 0x0254) return true;
  const embedded = embeddedIpv4(v6);
  return embedded !== null && metadataIpv4(embedded);
}

export type AddressClass = "unspecified" | "loopback" | "forbidden" | "public" | "invalid";

/**
 * Unspecified addresses are never a legitimate destination; on common stacks connecting to
 * them reaches local services, so they get their own class and are denied in every mode.
 * Covers 0.0.0.0/8, ::, and 0.x.x.x embedded in IPv4-mapped (::ffff:0:0/104),
 * IPv4-compatible (::/96, except ::1), IPv4-translated (::ffff:0:0:0/96), NAT64
 * (64:ff9b::/96), and 6to4 (2002::/16) forms.
 */
function isUnspecifiedAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) return v4[0] === 0;
  const v6 = expandIpv6(address);
  if (!v6) return false;
  if (v6.every((value) => value === 0)) return true;
  const mapped = mappedIpv4(v6);
  if (mapped !== null) return mapped[0] === 0;
  const tailFirstOctet = v6[6] >> 8;
  if (isTranslatedIpv4(v6)) return tailFirstOctet === 0;
  const isLoopbackV6 = v6.slice(0, 7).every((value) => value === 0) && v6[7] === 1;
  if (v6.slice(0, 6).every((value) => value === 0) && !isLoopbackV6) return tailFirstOctet === 0;
  if (v6[0] === 0x0064 && v6[1] === 0xff9b && v6.slice(2, 6).every((value) => value === 0)) return tailFirstOctet === 0;
  if (v6[0] === 0x2002) return v6[1] >> 8 === 0;
  return false;
}

/** Classify a literal IP address; anything that is not an IP literal is "invalid". */
export function classifyAddress(address: string): AddressClass {
  if (typeof address !== "string" || isIP(address) === 0) return "invalid";
  if (isUnspecifiedAddress(address)) return "unspecified";
  if (isLoopbackAddress(address)) return "loopback";
  return isForbiddenRemoteAddress(address) ? "forbidden" : "public";
}
