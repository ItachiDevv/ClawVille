/**
 * P0 Codex-gate fix (2026-07-01): the global hono/logger prints request paths,
 * and agent routes carry the real-CT bearer as a `/:sessionId/…` PATH param, so
 * the raw replayable bearer would land in stdout/log-drain without redaction.
 * These tests pin `redactBearerTokens` — it MUST scrub every `(oc|ag|hat|ct)-…`
 * token while leaving ordinary text (and the `oc`/`ag`/`hat`/`ct` letters inside
 * other words) untouched. `ct-` = the real-CT-adjacent connect ticket (P1
 * adversarial pass, 2026-07-02).
 */
import { describe, expect, it } from 'bun:test';
import { redactBearerTokens } from '../log-redact';
import { randomBytes } from 'crypto';

const mkBearer = (p: 'oc' | 'ag' | 'hat' | 'ct') => `${p}-${randomBytes(24).toString('base64url')}`;

describe('redactBearerTokens', () => {
  it('redacts each real bearer shape (oc-/ag-/hat-/ct- + 32 base64url chars), keeping the prefix', () => {
    for (const p of ['oc', 'ag', 'hat', 'ct'] as const) {
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

  it('redacts the ct- connect ticket on the polled connect-status path', () => {
    // GET /api/agent/connect-status/:token is polled repeatedly by the frontend;
    // the ct- ticket binds a bot to the pending avatar on possession alone, so it
    // must be scrubbed like a bearer (P1 adversarial pass).
    const t = mkBearer('ct');
    const out = redactBearerTokens(`  <-- GET /api/agent/connect-status/${t} 200`);
    expect(out).toBe('  <-- GET /api/agent/connect-status/ct-<redacted> 200');
    expect(out.includes(t)).toBe(false);
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
