import { isIP } from "node:net";

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

// [network, prefix length]. Loopback, private, link-local, CGNAT, documentation, benchmarking, multicast, reserved.
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function blockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return BLOCKED_V4.some(([net, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(net) & mask);
  });
}

/** Expands an IPv6 address into 8 numeric hextets. Handles "::" and a trailing dotted IPv4 part. */
export function expandV6(ip: string): number[] {
  let addr = ip.toLowerCase().replace(/%.*$/, "");
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]!);
    addr = addr.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x || "0", 16));
}

function blockedV6(ip: string): boolean {
  const x = expandV6(ip);
  if (x.length !== 8 || x.some((n) => Number.isNaN(n))) return true;
  const embeddedV4 = `${x[6]! >> 8}.${x[6]! & 255}.${x[7]! >> 8}.${x[7]! & 255}`;
  if (x.slice(0, 7).every((n) => n === 0)) return true; // :: and ::1 (and deprecated ::a.b.c.d)
  if (x.slice(0, 5).every((n) => n === 0) && x[5] === 0xffff) return blockedV4(embeddedV4); // IPv4-mapped
  if (x[0] === 0x64 && x[1] === 0xff9b && x.slice(2, 6).every((n) => n === 0)) return blockedV4(embeddedV4); // NAT64
  if ((x[0]! & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((x[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((x[0]! & 0xff00) === 0xff00) return true; // multicast
  if (x[0] === 0x2001 && x[1] === 0x0db8) return true; // documentation
  if (x[0] === 0x2002) return blockedV4(`${x[1]! >> 8}.${x[1]! & 255}.${x[2]! >> 8}.${x[2]! & 255}`); // 6to4
  return false;
}

/** True for any address a probe must never connect to: loopback, private, link-local, metadata, multicast, reserved. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, ""));
  if (kind === 4) return blockedV4(ip);
  if (kind === 6) return blockedV6(ip.replace(/^\[|\]$/g, ""));
  return true; // not an IP at all: refuse
}
