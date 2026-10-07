// Preload (node --import) for product-surface tests: every way out of this computer is
// trapped. A connection to a loopback address is allowed (the editor and the MCP relay talk
// to Lilac on 127.0.0.1); any other connection, any DNS lookup of a name other than
// localhost, any UDP socket and any helper process is refused and reported on stderr as
// "LILAC-NETWORK-ATTEMPT <what>", so a test can assert there were none.
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const net = require("node:net");
const report = (label) => {
  process.stderr.write(`LILAC-NETWORK-ATTEMPT ${label}\n`);
  return new Error(`network access attempted: ${label}`);
};
const loopback = (host) => {
  if (host === undefined || host === null || host === "" || host === "localhost") return true;
  const bare = String(host).replace(/^\[|\]$/gu, "");
  return net.isIP(bare) !== 0 && (bare === "::1" || bare.startsWith("127.") || bare.startsWith("::ffff:127."));
};
const targetOf = (args) => {
  const [first] = args;
  if (Array.isArray(first)) return targetOf(first);
  if (first !== null && typeof first === "object") return { host: first.host ?? first.hostname, path: first.path };
  if (typeof first === "string" && !/^\d+$/u.test(first)) return { path: first };
  return { host: typeof args[1] === "string" ? args[1] : undefined };
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const { host, path } = targetOf(args);
  if (path === undefined && !loopback(host)) throw report(`connect ${host}`);
  return connect.apply(this, args);
};
const dns = require("node:dns");
const DNS = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolveTxt", "resolveSrv", "reverse"];
for (const holder of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const key of DNS) {
    if (typeof holder[key] !== "function") continue;
    const original = holder[key];
    holder[key] = function guardedDns(name, ...rest) {
      if (key === "lookup" && loopback(name)) return original.call(this, name, ...rest);
      throw report(`dns.${key} ${String(name)}`);
    };
  }
}
const dgram = require("node:dgram");
dgram.createSocket = () => {
  throw report("dgram.createSocket");
};
const childProcess = require("node:child_process");
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[key] = () => {
    throw report(`child_process.${key}`);
  };
}
syncBuiltinESMExports();
