import { describe, expect, test } from 'bun:test';
import { arenaProvisionFailedCopy } from './my-trader';

// The Wallet block's copy for provisionState 'failed' must say what
// apps/api/src/services/floor-arena/provisioning.ts does (lead rule 2026-10-03):
// - our own ClawPump call-budget wait (`clawpump_budget_exhausted`) is NOT an
//   attempt: the row is due again about 25 s later, on the next setup pass;
// - a real failure counts: the next try is 10 minutes later, up to 5 attempts
//   (ARENA_PROVISION_RETRY_MS, ARENA_PROVISION_MAX_ATTEMPTS).
// The copy never names the HTTP 429 detail.

describe('arena wallet: provisioning failed copy', () => {
  test('the budget wait says it tries again in a few seconds and is not a failure', () => {
    const copy = arenaProvisionFailedCopy('clawpump_budget_exhausted');
    expect(copy).toContain('waiting for a free ClawPump slot');
    expect(copy).toContain('tries again in a few seconds');
    expect(copy).not.toContain('10 minutes');
    expect(copy).not.toMatch(/429|rate/i);
  });

  test.each([null, 'clawpump_http_error_500', 'clawpump_rate_limited_429', 'wallet_missing', 'provision_error'])(
    'a real failure (%p) states the five-try rule and never promises another try',
    (code) => {
      // GET /me has no attempt count or next-try time, so after the fifth
      // failure (exhausted) a "tries again" promise would be false (Codex E3).
      const copy = arenaProvisionFailedCopy(code);
      expect(copy).toContain('up to five times, 10 minutes apart');
      expect(copy).toContain('If all five fail');
      expect(copy).not.toMatch(/tries again|will try|next try/i);
      expect(copy).not.toMatch(/429/);
    },
  );

  test('player copy rules: no em dash, no "CT", Paper trading still works', () => {
    for (const code of ['clawpump_budget_exhausted', null]) {
      const copy = arenaProvisionFailedCopy(code);
      expect(copy).not.toContain('—');
      expect(copy).not.toMatch(/\bCT\b/);
      expect(copy).toContain('Paper trading works without it.');
    }
  });
});
