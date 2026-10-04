/**
 * Idle-avatar visit reward — server-side daily cap (security pass 2026-10-04).
 *
 * `awardIdleVisitToken` is the bridge's dbHooks.awardToken. It must claim the
 * shared per-avatar `building_visit` counter and credit in ONE transaction,
 * pay 1 vCLAW for the first 10 arrivals of a UTC day, then 0, and resolve to the
 * credited amount (the visit action logs exactly that). The cap lives on the API
 * side, never only inside the agent-runtime package.
 *
 * Runs in its own process (test:ci isolation): the agent runtime, ledger and
 * DB are faked; the claim helper (`daily-reward-cap.ts`) is REAL.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();
const capUsed = new Map<string, number>();
const capKinds: string[] = [];
const credits: Array<{ input: Record<string, unknown>; tx: unknown }> = [];
let txCount = 0;

const fakeTx = {
  async execute(q: SQL) {
    const { sql: text, params } = dialect.sqlToQuery(q);
    if (text.includes('FROM avatars WHERE id')) return [{ present: 1 }];
    if (text.includes('INSERT INTO daily_reward_caps')) {
      const [avatarId, , kind, want, cap] = params as [string, string, string, number, number];
      capKinds.push(kind);
      const used = capUsed.get(`${avatarId}:${kind}`) ?? 0;
      if (used >= cap) return [];
      const granted = Math.min(want, cap - used);
      capUsed.set(`${avatarId}:${kind}`, used + granted);
      return [{ granted }];
    }
    throw new Error(`unexpected statement: ${text}`);
  },
};

mock.module('@clawville/database', () => ({
  db: {
    transaction: async <T,>(fn: (tx: typeof fakeTx) => Promise<T>) => {
      txCount += 1;
      return fn(fakeTx);
    },
  },
  activityLog: {},
}));
mock.module('@clawville/agent-runtime', () => ({
  AvatarStateStore: class {},
  SimulationRuntime: class {},
  activateIdleAvatars: () => {},
  stepMovement: () => {},
  handleActivityTransition: () => null,
}));
mock.module('../claw-token-ledger', () => ({
  creditClawTokens: async (input: Record<string, unknown>, tx: unknown) => {
    credits.push({ input, tx });
    return { balanceAfter: 0, ledgerId: 'ledger-1' };
  },
}));
mock.module('../runtime-services-adapter', () => ({ buildRuntimeServices: () => ({}) }));
mock.module('../agent-autonomy-state', () => ({
  getAgentDirectiveForAvatar: async () => null,
  formatDirectiveContext: () => null,
}));
mock.module('../pathfinding', () => ({ findPath: () => [] }));

const { awardIdleVisitToken } = await import('../avatar-simulation-bridge');

beforeEach(() => {
  capUsed.clear();
  capKinds.length = 0;
  credits.length = 0;
  txCount = 0;
});

describe('awardIdleVisitToken (bridge dbHooks.awardToken)', () => {
  it('pays 1 vCLAW for the first 10 arrivals, then 0, on the shared building_visit counter', async () => {
    const paid: number[] = [];
    for (let i = 0; i < 12; i++) paid.push(await awardIdleVisitToken('avatar-1'));
    expect(paid).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
    expect(new Set(capKinds)).toEqual(new Set(['building_visit']));
    expect(credits).toHaveLength(10);
    expect(credits[0].input).toMatchObject({
      avatarId: 'avatar-1', amount: 1, reason: 'autonomous_visit', source: 'simulation', actorKind: 'system',
    });
    // Claim and credit share one tx per arrival.
    expect(txCount).toBe(12);
    expect(credits.every((c) => c.tx === fakeTx)).toBe(true);
  });

  it('shares the counter with the other visit paths of the same avatar', async () => {
    // e.g. 7 paid connected-agent / autonomous-driver visits already today.
    capUsed.set('avatar-1:building_visit', 7);
    const paid: number[] = [];
    for (let i = 0; i < 5; i++) paid.push(await awardIdleVisitToken('avatar-1'));
    expect(paid).toEqual([1, 1, 1, 0, 0]);
    // A different avatar has its own counter.
    expect(await awardIdleVisitToken('avatar-2')).toBe(1);
  });
});
