/**
 * Cloudflare edge ranges + a dependency-free IPv4/IPv6 CIDR matcher.
 *
 * Used by `getClientIp` (middleware/rate-limit.ts) to decide whether the
 * `cf-connecting-ip` header can be trusted: only when the Traefik-set peer
 * address (`x-real-ip`) is a Cloudflare edge. A caller that reaches the
 * origin without Cloudflare can send any `CF-Connecting-IP` it likes, and
 * Traefik passes that header through unchanged (staging probe 2026-10-04).
 *
 * Ranges fetched 2026-10-04 from https://www.cloudflare.com/ips-v4 and
 * https://www.cloudflare.com/ips-v6. Cloudflare changes these rarely; when
 * it does, update this list (a stale list only fails toward keying a client
 * on its Cloudflare edge address, never toward trusting a spoofed header).
 */

export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

export const CLOUDFLARE_IPV6_RANGES: readonly string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

export interface ParsedIp {
  version: 4 | 6;
  /** 32-bit (v4) or 128-bit (v6) address as an unsigned bigint. */
  value: bigint;
}

function parseIpv4(input: string): bigint | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    // Decimal only; reject leading zeros ("010" is octal in some parsers).
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(input: string): bigint | null {
  if (input.length === 0 || input.length > 45) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(input)) return null;

  // An embedded IPv4 tail (e.g. ::ffff:1.2.3.4) counts as two hextets.
  let head = input;
  let tail: bigint | null = null;
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    if (lastColon < 0) return null;
    tail = parseIpv4(input.slice(lastColon + 1));
    if (tail === null) return null;
    head = input.slice(0, lastColon + 1);
    // Keep "::" intact; turn a single trailing ":" into nothing.
    if (!head.endsWith('::')) head = head.slice(0, -1);
  }

  const doubleColon = head.indexOf('::');
  if (doubleColon !== head.lastIndexOf('::')) return null;

  const splitGroups = (s: string): string[] | null => {
    if (s === '') return [];
    const groups = s.split(':');
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    }
    return groups;
  };

  const totalGroups = tail === null ? 8 : 6;
  let groups: string[];
  if (doubleColon >= 0) {
    const left = splitGroups(head.slice(0, doubleColon));
    const right = splitGroups(head.slice(doubleColon + 2));
    if (left === null || right === null) return null;
    const missing = totalGroups - left.length - right.length;
    // "::" must stand for at least one zero group.
    if (missing < 1) return null;
    groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  } else {
    const all = splitGroups(head);
    if (all === null || all.length !== totalGroups) return null;
    groups = all;
  }

  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(parseInt(g, 16));
  if (tail !== null) value = (value << 32n) | tail;
  return value;
}

const IPV4_MAPPED_PREFIX = 0xffffn << 32n; // ::ffff:0:0/96
const LOW_32 = 0xffffffffn;

/**
 * Parse a bare IPv4 or IPv6 address (no port, brackets or zone id).
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is returned as IPv4.
 * Returns null for anything else.
 */
export function parseIp(raw: string): ParsedIp | null {
  if (typeof raw !== 'string') return null;
  const input = raw.trim();
  if (input === '') return null;
  if (input.includes(':')) {
    const v6 = parseIpv6(input);
    if (v6 === null) return null;
    if (v6 >> 32n === IPV4_MAPPED_PREFIX >> 32n) {
      return { version: 4, value: v6 & LOW_32 };
    }
    return { version: 6, value: v6 };
  }
  const v4 = parseIpv4(input);
  return v4 === null ? null : { version: 4, value: v4 };
}

export function isValidIp(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && parseIp(raw) !== null;
}

interface ParsedCidr {
  version: 4 | 6;
  network: bigint;
  mask: bigint;
}

function parseCidr(cidr: string): ParsedCidr {
  const slash = cidr.indexOf('/');
  const addr = slash < 0 ? '' : cidr.slice(0, slash);
  const bitsRaw = slash < 0 ? '' : cidr.slice(slash + 1);
  // A mapped address would parse as v4 with a v6 prefix length: reject it.
  const parsed = addr.toLowerCase().includes('::ffff:') ? null : parseIp(addr);
  const width = parsed?.version === 6 ? 128 : 32;
  const bits = /^\d{1,3}$/.test(bitsRaw) ? Number(bitsRaw) : NaN;
  if (!parsed || !Number.isInteger(bits) || bits < 0 || bits > width) {
    // Programmer error in the constant list — fail at module load, loudly.
    throw new Error(`cloudflare-ips: invalid CIDR ${cidr}`);
  }
  const all = (1n << BigInt(width)) - 1n;
  const mask = bits === 0 ? 0n : (all << BigInt(width - bits)) & all;
  return { version: parsed.version, network: parsed.value & mask, mask };
}

/** True when `ip` is inside any of the given CIDRs. Invalid input -> false. */
export function ipInCidrs(ip: string, cidrs: readonly string[]): boolean {
  return matchParsed(parseIp(ip), cidrs.map(parseCidr));
}

function matchParsed(parsed: ParsedIp | null, ranges: readonly ParsedCidr[]): boolean {
  if (!parsed) return false;
  for (const r of ranges) {
    if (r.version === parsed.version && (parsed.value & r.mask) === r.network) return true;
  }
  return false;
}

const CLOUDFLARE_RANGES: readonly ParsedCidr[] = [
  ...CLOUDFLARE_IPV4_RANGES,
  ...CLOUDFLARE_IPV6_RANGES,
].map(parseCidr);

/** True when `ip` is a Cloudflare edge address. Invalid input -> false. */
export function isCloudflareIp(ip: string | null | undefined): boolean {
  if (typeof ip !== 'string') return false;
  return matchParsed(parseIp(ip), CLOUDFLARE_RANGES);
}
