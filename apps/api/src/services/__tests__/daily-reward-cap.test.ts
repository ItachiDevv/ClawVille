/**
 * daily-reward-cap.ts — durable per-avatar daily faucet caps (security pass,
 * founder decision 2026-10-04: 10 paid visits, 10 paid Nori turns, 500 activity
 * vCLAW per avatar per UTC day).
 *
 * Drives the REAL claim helper against an injected in-memory tx that models the
 * counter row the way the single INSERT ... ON CONFLICT DO UPDATE ... WHERE
 * statement does in Postgres, and pins the SQL shape that makes the claim
 * concurrency-safe:
 *   1. CAP MATH — full grant under the cap, partial clamp at the edge, 0 at the
 *      cap, 0 for a non-positive / non-finite amount (no SQL at all).
 *   2. LOCK ORDER — the avatars FOR UPDATE lock comes BEFORE the counter claim
 *      (same order as creditClawTokens, so no reward path can deadlock another).
 *   3. ATOMIC SQL — one upsert, keyed by (avatar_id, reward_day, kind), guarded
 *      by `WHERE c.used < cap`, returning the granted amount.
 *   4. DRIVER TRAP — reward_day binds as a 'YYYY-MM-DD' string, never a Date.
 *   5. TX COMPOSITION — the credit gets the granted amount and the SAME tx; a
 *      capped claim never touches the ledger; a ledger throw propagates (so
 *      db.transaction rolls the claim back).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  DAILY_REWARD_CAPS,
  claimDailyRewardCap,
  creditWithDailyRewardCap,
  utcRewardDay,
  type DailyRewardCapDeps,
  type DailyRewardCapTx,
} from '../daily-reward-cap';

const dialect = new PgDialect();
const NOW = new Date('2026-10-04T12:00:00Z');

interface Rendered {
  text: string;
  params: unknown[];
}

/** In-memory model of daily_reward_caps + the avatars row lock. */
function makeTx(opts: { avatarExists?: boolean } = {}) {
  const used = new Map<string, number>();
  const statements: Rendered[] = [];
  const tx = {
    async execute(q: SQL) {
      const { sql: text, params } = dialect.sqlToQuery(q);
      statements.push({ text, params });
      if (text.includes('FROM avatars WHERE id')) {
        return opts.avatarExists === false ? [] : [{ present: 1 }];
      }
      if (text.includes('INSERT INTO daily_reward_caps')) {
        const [avatarId, day, kind, want, cap] = params as [string, string, string, number, number];
        const key = `${avatarId}|${day}|${kind}`;
        const current = used.get(key) ?? 0;
        if (current >= cap) return []; // the ON CONFLICT ... WHERE refused
        const granted = Math.min(want, cap - current);
        used.set(key, current + granted);
        return [{ granted }];
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  };
  return { tx: tx as unknown as DailyRewardCapTx, used, statements };
}

describe('DAILY_REWARD_CAPS (founder decision 2026-10-04)', () => {
  it('holds the fixed founder values', () => {
    expect(DAILY_REWARD_CAPS).toEqual({ building_visit: 10, nori_chat: 10, activity: 500 });
  });
});

describe('utcRewardDay', () => {
  it('is the UTC calendar date, not the server-local date', () => {
    // 23:30 EDT on Oct 4 is already Oct 5 in UTC.
    expect(utcRewardDay(new Date('2026-10-04T23:30:00-04:00'))).toBe('2026-10-05');
    expect(utcRewardDay(new Date('2026-10-04T00:00:00Z'))).toBe('2026-10-04');
  });
});

describe('claimDailyRewardCap', () => {
  let h: ReturnType<typeof makeTx>;
  beforeEach(() => {
    h = makeTx();
  });

  it('grants 1 per paid visit up to 10, then 0', async () => {
    const grants: number[] = [];
    for (let i = 0; i < 12; i++) {
      grants.push(await claimDailyRewardCap(h.tx, {
        avatarId: 'avatar-1', kind: 'building_visit', amount: 1, now: NOW,
      }));
    }
    expect(grants).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
  });

  it('grants 1 per paid Nori turn up to 10, then 0', async () => {
    let total = 0;
    for (let i = 0; i < 15; i++) {
      total += await claimDailyRewardCap(h.tx, {
        avatarId: 'avatar-1', kind: 'nori_chat', amount: 1, now: NOW,
      });
    }
    expect(total).toBe(10);
  });

  it('clamps an activity award to the remainder of 500, then grants 0', async () => {
    expect(await claimDailyRewardCap(h.tx, { avatarId: 'a', kind: 'activity', amount: 480, now: NOW })).toBe(480);
    expect(await claimDailyRewardCap(h.tx, { avatarId: 'a', kind: 'activity', amount: 60, now: NOW })).toBe(20);
    expect(await claimDailyRewardCap(h.tx, { avatarId: 'a', kind: 'activity', amount: 60, now: NOW })).toBe(0);
  });

  it('clamps a single award larger than the whole cap', async () => {
    expect(await claimDailyRewardCap(h.tx, { avatarId: 'a', kind: 'activity', amount: 900, now: NOW })).toBe(500);
  });

  it('keeps separate counters per avatar, per kind, and per UTC day', async () => {
    for (let i = 0; i < 10; i++) {
      await claimDailyRewardCap(h.tx, { avatarId: 'a', kind: 'building_visit', amount: 1, now: NOW });
    }
    expect(await claimDailyRewardCap(h.tx, { avatarId: 'a', kind: 'building_visit', amount: 1, now: NOW })).toBe(0);
    expect(await claimDailyRewardCap(h.tx, { avatarId: 'b', kind: 'building_visit', amount: 1, now: NOW })).toBe(1);
    expect(await claimDailyRewardCap(h.tx, { avatarId: 'a', kind: 'nori_chat', amount: 1, now: NOW })).toBe(1);
    const tomorrow = new Date('2026-10-05T00:00:01Z');
    expect(await claimDailyRewardCap(h.tx, { avatarId: 'a', kind: 'building_visit', amount: 1, now: tomorrow })).toBe(1);
  });

  it('runs no SQL for a non-positive or non-finite amount', async () => {
    for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.4]) {
      expect(await claimDailyRewardCap(h.tx, { avatarId: 'a', kind: 'activity', amount, now: NOW })).toBe(0);
    }
    expect(h.statements).toHaveLength(0);
  });

  it('grants 0 and claims nothing when the avatar row does not exist', async () => {
    const missing = makeTx({ avatarExists: false });
    expect(await claimDailyRewardCap(missing.tx, { avatarId: 'gone', kind: 'nori_chat', amount: 1, now: NOW })).toBe(0);
    expect(missing.statements).toHaveLength(1);
    expect(missing.statements[0].text).toContain('FOR UPDATE');
  });

  it('never trusts a returned grant above the request', async () => {
    const liar = {
      execute: async (q: SQL) => {
        const { sql: text } = dialect.sqlToQuery(q);
        return text.includes('FROM avatars') ? [{ present: 1 }] : [{ granted: 999 }];
      },
    } as unknown as DailyRewardCapTx;
    expect(await claimDailyRewardCap(liar, { avatarId: 'a', kind: 'activity', amount: 30, now: NOW })).toBe(30);
  });

  it('locks the avatar row BEFORE the counter claim, in one atomic guarded upsert', async () => {
    await claimDailyRewardCap(h.tx, { avatarId: 'avatar-1', kind: 'activity', amount: 45, now: NOW });
    expect(h.statements).toHaveLength(2);
    const [lock, claim] = h.statements;
    expect(lock.text).toBe('SELECT 1 AS present FROM avatars WHERE id = $1::uuid FOR UPDATE');
    expect(lock.params).toEqual(['avatar-1']);

    const flat = claim.text.replace(/\s+/g, ' ');
    expect(flat).toContain('INSERT INTO daily_reward_caps AS c (avatar_id, reward_day, kind, used, last_granted, updated_at)');
    expect(flat).toContain('ON CONFLICT (avatar_id, reward_day, kind) DO UPDATE');
    expect(flat).toContain('SET last_granted = LEAST(EXCLUDED.last_granted, $8::int - c.used)');
    expect(flat).toContain('used = c.used + LEAST(EXCLUDED.last_granted, $9::int - c.used)');
    expect(flat).toContain('WHERE c.used < $10::int');
    expect(flat).toContain('RETURNING c.last_granted AS granted');
    expect(claim.params).toEqual(['avatar-1', '2026-10-04', 'activity', 45, 500, 45, 500, 500, 500, 500]);
  });

  it('binds reward_day as a YYYY-MM-DD string, never a Date', async () => {
    await claimDailyRewardCap(h.tx, { avatarId: 'a', kind: 'nori_chat', amount: 1, now: NOW });
    for (const s of h.statements) {
      for (const p of s.params) expect(p instanceof Date).toBe(false);
    }
    expect(h.statements[1].params[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('creditWithDailyRewardCap', () => {
  function makeDeps(opts: { failCredit?: boolean } = {}) {
    const h = makeTx();
    const credits: Array<{ input: { avatarId: string; amount: number; reason: string }; tx: unknown }> = [];
    const deps: DailyRewardCapDeps = {
      transaction: (fn) => fn(h.tx as never),
      credit: (async (input: { avatarId: string; amount: number; reason: string }, tx?: unknown) => {
        if (opts.failCredit) throw new Error('ledger down');
        credits.push({ input, tx });
        return { balanceAfter: 0, ledgerId: 'ledger-1' };
      }) as unknown as DailyRewardCapDeps['credit'],
    };
    return { h, credits, deps };
  }

  it('credits the granted amount inside the SAME tx and returns it', async () => {
    const { h, credits, deps } = makeDeps();
    const granted = await creditWithDailyRewardCap({
      kind: 'nori_chat', now: NOW,
      credit: { avatarId: 'a', amount: 1, reason: 'system_agent_chat', source: 'api' },
    }, deps);
    expect(granted).toBe(1);
    expect(credits).toHaveLength(1);
    expect(credits[0].input).toMatchObject({ avatarId: 'a', amount: 1, reason: 'system_agent_chat' });
    expect(credits[0].tx).toBe(h.tx);
  });

  it('never touches the ledger once the cap is reached (11th visit pays 0)', async () => {
    const { credits, deps } = makeDeps();
    const paid: number[] = [];
    for (let i = 0; i < 11; i++) {
      paid.push(await creditWithDailyRewardCap({
        kind: 'building_visit', now: NOW,
        credit: { avatarId: 'a', amount: 1, reason: 'autonomous_visit', source: 'simulation' },
      }, deps));
    }
    expect(paid.slice(0, 10).every((p) => p === 1)).toBe(true);
    expect(paid[10]).toBe(0);
    expect(credits).toHaveLength(10);
  });

  it('credits only the clamped remainder for an activity award', async () => {
    const { h, credits, deps } = makeDeps();
    await claimDailyRewardCap(h.tx, { avatarId: 'a', kind: 'activity', amount: 490, now: NOW });
    const granted = await creditWithDailyRewardCap({
      kind: 'activity', now: NOW,
      credit: { avatarId: 'a', amount: 60, reason: 'activity_match_placed', source: 'simulation' },
    }, deps);
    expect(granted).toBe(10);
    expect(credits[0].input.amount).toBe(10);
  });

  it('propagates a ledger failure so the transaction rolls the claim back', async () => {
    const { deps } = makeDeps({ failCredit: true });
    await expect(creditWithDailyRewardCap({
      kind: 'nori_chat', now: NOW,
      credit: { avatarId: 'a', amount: 1, reason: 'system_agent_chat', source: 'api' },
    }, deps)).rejects.toThrow('ledger down');
  });
});
