import { describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createRateLimiter, getClientIp, resetClientIpAnomalyWarningForTests } from '../../middleware/rate-limit';
import {
  CLOUDFLARE_IPV4_RANGES,
  CLOUDFLARE_IPV6_RANGES,
  ipInCidrs,
  isCloudflareIp,
  isValidIp,
  parseIp,
} from '../../lib/cloudflare-ips';

/**
 * Regression guard for the 2026-09-19 rate-limit keying fault.
 *
 * `getClientIp` takes a Headers-like `{ get(name) }`. Three call sites passed
 * the Hono CONTEXT instead, whose `.get()` reads context VARIABLES, so every
 * caller resolved to the literal 'unknown': `POST /api/floor/trade` and
 * `POST /api/exchange/trades/report` (10/min) and the public trade feed
 * (60/min) were ONE GLOBAL bucket each, so one caller could lock out everyone.
 *
 * Also the H2 client-IP trust guard (security pass 2026-10-04): Traefik
 * rewrites `x-real-ip` to the TCP peer but passes `cf-connecting-ip` through,
 * so `cf-connecting-ip` is trusted ONLY when the peer is a Cloudflare edge.
 * This file sits in the routes CI lane, which is why the CIDR matcher tests
 * live here and not in `src/lib/__tests__` (no CI lane runs that directory).
 *
 * No `mock.module` here on purpose: the routes CI lane runs every file in this
 * directory in ONE bun process and a mocker poisons its siblings.
 */

const apiRoot = resolve(import.meta.dir, '../..');
const readSource = (relativePath: string) => readFileSync(resolve(apiRoot, relativePath), 'utf8');

/** Dispatch through a real Hono app so `c` and `c.req.raw.headers` are real. */
async function captureIps(headers: Record<string, string>): Promise<{
  fromContext: string;
  fromHeaders: string;
  fromHeaderGetter: string;
}> {
  const app = new Hono();
  let captured = { fromContext: '', fromHeaders: '', fromHeaderGetter: '' };
  app.get('/probe', (c) => {
    captured = {
      fromContext: getClientIp(c as unknown as { get(name: string): string | null | undefined }),
      fromHeaders: getClientIp(c.req.raw.headers),
      fromHeaderGetter: getClientIp({ get: (name) => c.req.header(name) ?? null }),
    };
    return c.text('ok');
  });
  await app.request('/probe', { headers });
  return captured;
}

/** Plain `{ get }` shape over a lower-case header map. */
function plain(headers: Record<string, string>) {
  return { get: (name: string) => headers[name] ?? null };
}

describe('getClientIp keying', () => {
  it('reads the real address from headers and NOT from the Hono context', async () => {
    const captured = await captureIps({ 'x-real-ip': '203.0.113.9' });
    expect(captured.fromHeaders).toBe('203.0.113.9');
    // The exact fault: the context form silently collapses every caller to one
    // key. If this ever stops being 'unknown', the helper changed shape.
    expect(captured.fromContext).toBe('unknown');
  });

  it('separates two different addresses into two buckets', async () => {
    const limiter = createRateLimiter({ maxPerWindow: 2, windowMs: 60_000 });
    const first = await captureIps({ 'x-real-ip': '198.51.100.1' });
    const second = await captureIps({ 'x-real-ip': '198.51.100.2' });
    expect(limiter.check(first.fromHeaders)).toBe(true);
    expect(limiter.check(first.fromHeaders)).toBe(true);
    expect(limiter.check(first.fromHeaders)).toBe(false);
    // The second address must be untouched by the first one's burst.
    expect(limiter.check(second.fromHeaders)).toBe(true);
    // Under the old keying both would have shared the 'unknown' bucket.
    expect(limiter.check(first.fromContext)).toBe(true);
    expect(limiter.check(second.fromContext)).toBe(true);
    expect(limiter.check('unknown')).toBe(false);
  });

  it('still caps one subject that spreads its calls over many addresses', () => {
    // This is why the per-IP fix alone is not enough: per-IP is LOOSER than the
    // old global bucket for a single actor, so the write routes also carry a
    // subject bucket at the same 10/min.
    const subjectLimiter = createRateLimiter({ maxPerWindow: 10, windowMs: 60_000 });
    const subjectKey = 'avatar:11111111-2222-3333-4444-555555555555';
    for (let call = 0; call < 10; call += 1) {
      expect(subjectLimiter.check(subjectKey)).toBe(true);
    }
    expect(subjectLimiter.check(subjectKey)).toBe(false);
    // A different subject is unaffected.
    expect(subjectLimiter.check('agent:some-other-agent')).toBe(true);
  });

  it('leaves no route passing the bare Hono context to getClientIp', () => {
    // Source-level guard: the fault is invisible at runtime (it fails open into
    // one shared bucket), so the only cheap regression net is the call shape.
    for (const file of ['routes/exchange.ts', 'routes/trading-floor.ts']) {
      expect(readSource(file)).not.toMatch(/getClientIp\(c\)/);
    }
  });

  it('keeps a subject bucket beside the IP bucket on both authed write routes', () => {
    expect(readSource('routes/trading-floor.ts')).toContain('tradeSubjectLimiter.check(');
    expect(readSource('routes/exchange.ts')).toContain('reportSubjectLimiter.check(');
    // The public feed resolves no subject, so it stays per-IP only.
    expect(readSource('routes/exchange.ts')).toContain(
      "feedLimiter.check(getClientIp(c.req.raw.headers))",
    );
  });
});

describe('getClientIp trust model (H2 2026-10-04)', () => {
  it('direct caller (staging probe): a forged CF-Connecting-IP is ignored, the Traefik peer wins', async () => {
    // Exactly what the api received from a non-Cloudflare caller on staging.
    const captured = await captureIps({
      'X-Real-Ip': '100.83.49.44',
      'X-Forwarded-For': '100.83.49.44',
      'Cf-Connecting-Ip': '7.7.7.7',
    });
    expect(captured.fromHeaders).toBe('100.83.49.44');
    expect(captured.fromHeaderGetter).toBe('100.83.49.44');
  });

  it('through Cloudflare (staging probe): the edge peer is swapped for the true client', async () => {
    // 104.23.213.192 is inside 104.16.0.0/13.
    const captured = await captureIps({
      'X-Real-Ip': '104.23.213.192',
      'X-Forwarded-For': '104.23.213.192',
      'Cf-Connecting-Ip': '2a01:4ff:f4:816f::1',
      'Cf-Ray': '8c0000000000abcd-IAD',
    });
    expect(captured.fromHeaders).toBe('2a01:4ff:f4:816f::1');
    expect(captured.fromHeaderGetter).toBe('2a01:4ff:f4:816f::1');
  });

  it('two users behind the same Cloudflare edge get two buckets, not one', async () => {
    const a = await captureIps({ 'x-real-ip': '172.68.1.1', 'cf-connecting-ip': '198.51.100.10' });
    const b = await captureIps({ 'x-real-ip': '172.68.1.1', 'cf-connecting-ip': '198.51.100.11' });
    expect(a.fromHeaders).toBe('198.51.100.10');
    expect(b.fromHeaders).toBe('198.51.100.11');
  });

  it('accepts an IPv6 Cloudflare peer and an IPv4-mapped Cloudflare peer', () => {
    expect(getClientIp(plain({ 'x-real-ip': '2a06:98c0::1', 'cf-connecting-ip': '203.0.113.5' }))).toBe('203.0.113.5');
    expect(getClientIp(plain({ 'x-real-ip': '::ffff:104.16.0.1', 'cf-connecting-ip': '203.0.113.6' }))).toBe('203.0.113.6');
  });

  it('keeps the peer when the Cloudflare peer sends no or an invalid CF-Connecting-IP, and warns ONCE per process', () => {
    resetClientIpAnomalyWarningForTests();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(getClientIp(plain({ 'x-real-ip': '104.16.0.1' }))).toBe('104.16.0.1');
      expect(getClientIp(plain({ 'x-real-ip': '104.16.0.1', 'cf-connecting-ip': 'garbage' }))).toBe('104.16.0.1');
      expect(getClientIp(plain({ 'x-real-ip': '104.16.0.1', 'cf-connecting-ip': '1.2.3.4, 5.6.7.8' }))).toBe('104.16.0.1');
      expect(getClientIp(plain({ 'x-real-ip': '104.16.0.1', 'cf-connecting-ip': '' }))).toBe('104.16.0.1');
      // Four anomalous requests, one log line (no per-request spam), and the
      // line carries no caller-controlled header value.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('cf-connecting-ip');
      expect(String(warn.mock.calls[0]?.[0])).not.toContain('garbage');
      // A normal Cloudflare request or a non-Cloudflare peer never warns.
      warn.mockClear();
      resetClientIpAnomalyWarningForTests();
      expect(getClientIp(plain({ 'x-real-ip': '104.16.0.1', 'cf-connecting-ip': '203.0.113.5' }))).toBe('203.0.113.5');
      expect(getClientIp(plain({ 'x-real-ip': '203.0.113.30' }))).toBe('203.0.113.30');
      expect(warn).toHaveBeenCalledTimes(0);
    } finally {
      warn.mockRestore();
      resetClientIpAnomalyWarningForTests();
    }
  });

  it('trims a valid CF-Connecting-IP from a Cloudflare peer', () => {
    expect(getClientIp(plain({ 'x-real-ip': ' 104.16.0.1 ', 'cf-connecting-ip': ' 203.0.113.8 ' }))).toBe('203.0.113.8');
  });

  it('never trusts CF-Connecting-IP when there is no x-real-ip and no x-forwarded-for', () => {
    expect(getClientIp(plain({ 'cf-connecting-ip': '203.0.113.9' }))).toBe('unknown');
  });

  it('no x-real-ip (local dev / tests): falls back to the LAST x-forwarded-for entry', () => {
    expect(getClientIp(plain({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))).toBe('2.2.2.2');
    // A forged cf header still loses when the fallback peer is not Cloudflare.
    expect(getClientIp(plain({ 'x-forwarded-for': '2.2.2.2', 'cf-connecting-ip': '7.7.7.7' }))).toBe('2.2.2.2');
    // The same Cloudflare rule applies to the fallback peer.
    expect(getClientIp(plain({ 'x-forwarded-for': '9.9.9.9, 104.16.0.1', 'cf-connecting-ip': '203.0.113.10' }))).toBe('203.0.113.10');
  });

  it('an invalid x-real-ip falls back to x-forwarded-for, then to unknown', () => {
    expect(getClientIp(plain({ 'x-real-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.20' }))).toBe('198.51.100.20');
    expect(getClientIp(plain({ 'x-real-ip': 'not-an-ip' }))).toBe('unknown');
    expect(getClientIp(plain({}))).toBe('unknown');
  });

  it('Codex round 2: an invalid LAST x-forwarded-for entry is never a key (unknown, no earlier entry)', () => {
    // A garbage token used to become a caller-chosen bucket key.
    expect(getClientIp(plain({ 'x-forwarded-for': 'test-any-string' }))).toBe('unknown');
    expect(getClientIp(plain({ 'x-real-ip': 'not-an-ip', 'x-forwarded-for': 'garbage' }))).toBe('unknown');
    // The leading entries are client-set: an invalid last entry does not fall
    // back to them.
    expect(getClientIp(plain({ 'x-forwarded-for': '198.51.100.21, garbage' }))).toBe('unknown');
    expect(getClientIp(plain({ 'x-forwarded-for': '198.51.100.22:443' }))).toBe('unknown');
    expect(getClientIp(plain({ 'x-forwarded-for': '[2001:db8::1]' }))).toBe('unknown');
    expect(getClientIp(plain({ 'x-forwarded-for': ' , ' }))).toBe('unknown');
    // A forged cf header cannot rescue an invalid fallback.
    expect(getClientIp(plain({ 'x-forwarded-for': 'garbage', 'cf-connecting-ip': '203.0.113.9' }))).toBe('unknown');
    // Valid v4 / v6 last entries still key, trimmed.
    expect(getClientIp(plain({ 'x-forwarded-for': 'garbage, 198.51.100.23 ' }))).toBe('198.51.100.23');
    expect(getClientIp(plain({ 'x-forwarded-for': '2001:db8::17' }))).toBe('2001:db8::17');
  });

  it('Codex round 3: an EMPTY last x-forwarded-for field is not skipped (unknown, never the earlier caller-set entry)', async () => {
    // The old fallback dropped empty fields first, so a trailing comma made the
    // caller-set entry the key.
    expect(getClientIp(plain({ 'x-forwarded-for': '198.51.100.8, ' }))).toBe('unknown');
    expect(getClientIp(plain({ 'x-forwarded-for': '198.51.100.8,' }))).toBe('unknown');
    expect(getClientIp(plain({ 'x-forwarded-for': '198.51.100.8,,' }))).toBe('unknown');
    expect(getClientIp(plain({ 'x-forwarded-for': '1.1.1.1, 198.51.100.8 ,   ' }))).toBe('unknown');
    expect(getClientIp(plain({ 'x-forwarded-for': ',' }))).toBe('unknown');
    expect(getClientIp(plain({ 'x-forwarded-for': '   ' }))).toBe('unknown');
    // A Cloudflare-looking earlier entry plus a forged cf header cannot win either.
    expect(
      getClientIp(plain({ 'x-forwarded-for': '104.16.0.1, ', 'cf-connecting-ip': '203.0.113.11' })),
    ).toBe('unknown');
    // Through Hono's real Headers object as well.
    expect((await captureIps({ 'x-forwarded-for': '198.51.100.8, ' })).fromHeaders).toBe('unknown');
    // The actual last field still keys when it is a valid IP (trimmed), even
    // after an empty middle field.
    expect(getClientIp(plain({ 'x-forwarded-for': '198.51.100.8, , 198.51.100.24 ' }))).toBe('198.51.100.24');
    expect(getClientIp(plain({ 'x-forwarded-for': ',198.51.100.25' }))).toBe('198.51.100.25');
  });

  it('no test in apps/api/src keys on a non-IP x-forwarded-for literal', () => {
    // Every per-test rate-limit key must be a valid IP (x-real-ip preferred);
    // a non-IP x-forwarded-for now collapses into the shared 'unknown' bucket
    // and CI signups would trip each other's limits.
    const offenders: string[] = [];
    const literal = /['"]x-forwarded-for['"]\s*:\s*(['"`])([^'"`]*)\1/gi;
    for (const entry of readdirSync(apiRoot, { recursive: true }) as string[]) {
      const rel = entry.replace(/\\/g, '/');
      if (!/(^|\/)__tests__\/[^/]+\.ts$/.test(rel)) continue;
      // This file feeds invalid values to getClientIp on purpose.
      if (rel.endsWith('/rate-limit-client-ip.test.ts')) continue;
      const text = readFileSync(resolve(apiRoot, entry), 'utf8');
      for (const match of text.matchAll(literal)) {
        const value = match[2]!.replace(/\$\{[^}]*\}/g, '1');
        // Same rule as getClientIp: the ACTUAL last comma field, empty included.
        const last = value.slice(value.lastIndexOf(',') + 1).trim();
        if (!isValidIp(last)) offenders.push(`${rel}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('a non-Cloudflare x-real-ip beats a Cloudflare-looking x-forwarded-for', () => {
    expect(
      getClientIp(plain({ 'x-real-ip': '203.0.113.30', 'x-forwarded-for': '104.16.0.1', 'cf-connecting-ip': '7.7.7.7' })),
    ).toBe('203.0.113.30');
  });
});

/** Independent v4 helpers (plain number math, not the module's bigint code). */
function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}
function intToV4(n: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');
}

describe('Cloudflare CIDR matcher', () => {
  it('lists the 15 v4 and 7 v6 ranges fetched 2026-10-04', () => {
    expect(CLOUDFLARE_IPV4_RANGES.length).toBe(15);
    expect(CLOUDFLARE_IPV6_RANGES.length).toBe(7);
  });

  it('matches the first and last address of every v4 range and rejects both neighbours', () => {
    const spans = CLOUDFLARE_IPV4_RANGES.map((cidr) => {
      const [net, bits] = cidr.split('/');
      const start = v4ToInt(net);
      return { start, end: start + 2 ** (32 - Number(bits)) - 1 };
    });
    const inAnySpan = (n: number) => spans.some((s) => n >= s.start && n <= s.end);
    let outsideNeighbours = 0;
    for (const { start, end } of spans) {
      expect(isCloudflareIp(intToV4(start))).toBe(true);
      expect(isCloudflareIp(intToV4(end))).toBe(true);
      expect(isCloudflareIp(intToV4(start + Math.floor((end - start) / 2)))).toBe(true);
      // A neighbour is outside unless another range starts right there
      // (104.16.0.0/13 ends at 104.23.255.255; 104.24.0.0/14 follows it).
      for (const neighbour of [start - 1, end + 1]) {
        expect(isCloudflareIp(intToV4(neighbour))).toBe(inAnySpan(neighbour));
        if (!inAnySpan(neighbour)) outsideNeighbours += 1;
      }
    }
    expect(outsideNeighbours).toBe(28); // 30 neighbours minus the one adjacent pair
    expect(isCloudflareIp('104.23.255.255')).toBe(true);
    expect(isCloudflareIp('104.24.0.0')).toBe(true);
    expect(isCloudflareIp('104.15.255.255')).toBe(false);
    expect(isCloudflareIp('104.28.0.0')).toBe(false);
  });

  it('matches the first and last address of every v6 range and rejects both neighbours', () => {
    for (const cidr of CLOUDFLARE_IPV6_RANGES) {
      // Every v6 range is "<h1>:<h2>::/<= 32", so only the 2nd hextet varies.
      const [net, bitsRaw] = cidr.split('/');
      const [h1, h2] = net.split(':');
      const base = parseInt(h2, 16);
      const span = 2 ** (32 - Number(bitsRaw));
      const hex = (n: number) => n.toString(16);
      const ones = 'ffff:ffff:ffff:ffff:ffff:ffff';
      expect(isCloudflareIp(`${h1}:${hex(base)}::`)).toBe(true);
      expect(isCloudflareIp(`${h1}:${hex(base + span - 1)}:${ones}`)).toBe(true);
      expect(isCloudflareIp(`${h1}:${hex(base)}::1`)).toBe(true);
      expect(isCloudflareIp(`${h1}:${hex(base - 1)}:${ones}`)).toBe(false);
      expect(isCloudflareIp(`${h1}:${hex(base + span)}::`)).toBe(false);
    }
  });

  it('handles the /29 range edge explicitly (2a06:98c0::/29 = 98c0..98c7)', () => {
    expect(isCloudflareIp('2a06:98c7:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true);
    expect(isCloudflareIp('2a06:98c8::')).toBe(false);
    expect(isCloudflareIp('2a06:98bf:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(false);
  });

  it('accepts compressed, full, upper-case and embedded-v4 IPv6 forms', () => {
    expect(isCloudflareIp('2606:4700::1')).toBe(true);
    expect(isCloudflareIp('2606:4700:0:0:0:0:0:1')).toBe(true);
    expect(isCloudflareIp('2400:cb00:0000:0000:0000:0000:0000:0001')).toBe(true);
    expect(isCloudflareIp('2606:4700::ABCD')).toBe(true);
    expect(isCloudflareIp('2606:4700:1:2:3:4:1.2.3.4')).toBe(true);
    expect(isCloudflareIp('2001:db8::1')).toBe(false);
    expect(isCloudflareIp('::1')).toBe(false);
    expect(isCloudflareIp('::')).toBe(false);
  });

  it('treats IPv4-mapped IPv6 as the embedded IPv4 address', () => {
    expect(isCloudflareIp('::ffff:104.16.0.1')).toBe(true);
    expect(isCloudflareIp('::FFFF:104.16.0.1')).toBe(true);
    expect(isCloudflareIp('::ffff:6810:1')).toBe(true); // 104.16.0.1 in hex
    expect(isCloudflareIp('0:0:0:0:0:ffff:104.16.0.1')).toBe(true);
    expect(isCloudflareIp('::ffff:6.6.6.6')).toBe(false);
    expect(isCloudflareIp('::ffff:104.15.255.255')).toBe(false);
    expect(parseIp('::ffff:104.16.0.1')).toEqual({ version: 4, value: BigInt(v4ToInt('104.16.0.1')) });
    // Not mapped: a v4 tail under a different prefix stays IPv6.
    expect(parseIp('64:ff9b::104.16.0.1')?.version).toBe(6);
    expect(isCloudflareIp('64:ff9b::104.16.0.1')).toBe(false);
  });

  it('returns false (never throws) for invalid input', () => {
    const invalid: Array<string | null | undefined> = [
      null,
      undefined,
      '',
      ' ',
      'unknown',
      '104.16.0',
      '104.16.0.1.2',
      '256.16.0.1',
      '104.016.0.1',
      '104.16.0.-1',
      '104.16.0.1/32',
      '104.16.0.1:443',
      '[2606:4700::1]',
      '2606:4700::1%eth0',
      '2606:4700:::1',
      '2606::4700::1',
      '2606:4700:1:2:3:4:5:6:7',
      '2606:4700:1:2:3:4:5:6::',
      '12345::',
      'g::1',
      ':2606:4700::1',
      '2606:4700::1:',
      '::ffff:999.1.1.1',
      '::ffff:104.16.0',
      '0x68.0x10.0.1',
    ];
    for (const value of invalid) {
      expect(isCloudflareIp(value)).toBe(false);
      expect(isValidIp(value)).toBe(false);
    }
  });

  it('validates ordinary addresses', () => {
    for (const value of ['1.2.3.4', '0.0.0.0', '255.255.255.255', '::', '::1', '2a01:4ff:f4:816f::1', ' 203.0.113.1 ']) {
      expect(isValidIp(value)).toBe(true);
    }
  });

  it('ipInCidrs handles /0, /32, /128 and keeps v4 and v6 apart', () => {
    expect(ipInCidrs('8.8.8.8', ['0.0.0.0/0'])).toBe(true);
    expect(ipInCidrs('2001:db8::1', ['0.0.0.0/0'])).toBe(false);
    expect(ipInCidrs('2001:db8::1', ['::/0'])).toBe(true);
    expect(ipInCidrs('8.8.8.8', ['::/0'])).toBe(false);
    expect(ipInCidrs('10.0.0.1', ['10.0.0.1/32'])).toBe(true);
    expect(ipInCidrs('10.0.0.2', ['10.0.0.1/32'])).toBe(false);
    expect(ipInCidrs('::1', ['::1/128'])).toBe(true);
    expect(ipInCidrs('::2', ['::1/128'])).toBe(false);
    expect(ipInCidrs('not-an-ip', ['0.0.0.0/0', '::/0'])).toBe(false);
  });

  it('ipInCidrs throws on a malformed CIDR (programmer error, never silent)', () => {
    expect(() => ipInCidrs('1.2.3.4', ['1.2.3.4/33'])).toThrow();
    expect(() => ipInCidrs('1.2.3.4', ['1.2.3.4'])).toThrow();
    expect(() => ipInCidrs('1.2.3.4', ['::ffff:1.2.3.0/120'])).toThrow();
  });
});
