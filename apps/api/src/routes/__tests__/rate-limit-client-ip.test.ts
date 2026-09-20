import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createRateLimiter, getClientIp } from '../../middleware/rate-limit';

/**
 * Regression guard for the 2026-09-19 rate-limit keying fault.
 *
 * `getClientIp` takes a Headers-like `{ get(name) }`. Three call sites passed
 * the Hono CONTEXT instead, whose `.get()` reads context VARIABLES, so every
 * caller resolved to the literal 'unknown': `POST /api/floor/trade` and
 * `POST /api/exchange/trades/report` (10/min) and the public trade feed
 * (60/min) were ONE GLOBAL bucket each, so one caller could lock out everyone.
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
}> {
  const app = new Hono();
  let captured = { fromContext: '', fromHeaders: '' };
  app.get('/probe', (c) => {
    captured = {
      fromContext: getClientIp(c as unknown as { get(name: string): string | null | undefined }),
      fromHeaders: getClientIp(c.req.raw.headers),
    };
    return c.text('ok');
  });
  await app.request('/probe', { headers });
  return captured;
}

describe('getClientIp keying', () => {
  it('reads the real address from headers and NOT from the Hono context', async () => {
    const captured = await captureIps({ 'cf-connecting-ip': '203.0.113.9' });
    expect(captured.fromHeaders).toBe('203.0.113.9');
    // The exact fault: the context form silently collapses every caller to one
    // key. If this ever stops being 'unknown', the helper changed shape.
    expect(captured.fromContext).toBe('unknown');
  });

  it('separates two different addresses into two buckets', async () => {
    const limiter = createRateLimiter({ maxPerWindow: 2, windowMs: 60_000 });
    const first = await captureIps({ 'cf-connecting-ip': '198.51.100.1' });
    const second = await captureIps({ 'cf-connecting-ip': '198.51.100.2' });
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
