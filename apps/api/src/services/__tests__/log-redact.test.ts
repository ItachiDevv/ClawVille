/**
 * P0 Codex-gate fix (2026-07-01): the global hono/logger prints request paths,
 * and agent routes carry the real-CT bearer as a `/:sessionId/…` PATH param, so
 * the raw replayable bearer would land in stdout/log-drain without redaction.
 * These tests pin `redactBearerTokens` — it MUST scrub every `(oc|ag|hat)-…`
 * bearer while leaving ordinary text (and the `oc`/`ag`/`hat` letters inside
 * other words) untouched.
 */
import { describe, expect, it } from 'bun:test';
import { redactBearerTokens } from '../log-redact';
import { randomBytes } from 'crypto';

const mkBearer = (p: 'oc' | 'ag' | 'hat') => `${p}-${randomBytes(24).toString('base64url')}`;

describe('redactBearerTokens', () => {
  it('redacts each real bearer shape (oc-/ag-/hat- + 32 base64url chars), keeping the prefix', () => {
    for (const p of ['oc', 'ag', 'hat'] as const) {
      const bearer = mkBearer(p);
      const out = redactBearerTokens(`  --> POST /api/agent/${bearer}/cove/blackjack/deal 200 12ms`);
      expect(out).toBe(`  --> POST /api/agent/${p}-<redacted>/cove/blackjack/deal 200 12ms`);
      expect(out.includes(bearer)).toBe(false);
      // the tail secret is gone
      expect(out.includes(bearer.slice(bearer.indexOf('-') + 1))).toBe(false);
    }
  });

  it('redacts the SSE + move + legacy-unregister path shapes', () => {
    const b = mkBearer('hat');
    expect(redactBearerTokens(`  <-- GET /api/agent/${b}/events`)).toBe('  <-- GET /api/agent/hat-<redacted>/events');
    expect(redactBearerTokens(`  --> POST /api/agent/${b}/move 200`)).toBe('  --> POST /api/agent/hat-<redacted>/move 200');
  });

  it('redacts multiple bearers on one line', () => {
    const a = mkBearer('oc');
    const b = mkBearer('ag');
    const out = redactBearerTokens(`from=${a} to=${b}`);
    expect(out).toBe('from=oc-<redacted> to=ag-<redacted>');
  });

  it('does NOT redact the oc/ag/hat letters embedded in ordinary words', () => {
    // `flag-…` ends in `ag-`; `advocate`/`what-…` contain oc/hat — none is a bearer.
    const s = 'flag-abcdefghijklmnopqrstuvwxyz123 advocate what-abcdefghijklmnopqrstuvwx';
    expect(redactBearerTokens(s)).toBe(s);
  });

  it('does NOT redact short non-bearer ids (below the 24-char tail floor)', () => {
    expect(redactBearerTokens('oc-1 ag-foo hat-bar')).toBe('oc-1 ag-foo hat-bar');
  });

  it('is a safe no-op on empty / non-string input', () => {
    expect(redactBearerTokens('')).toBe('');
    // @ts-expect-error — defensive: never throws on a non-string
    expect(redactBearerTokens(undefined)).toBe(undefined);
  });
});
