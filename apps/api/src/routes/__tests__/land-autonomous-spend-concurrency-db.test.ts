/**
 * FEATURE_GATE land-autonomous-spend-cap: the CONCURRENT daily-cap DB contract.
 *
 * N concurrent autonomous land spends by ONE agent/avatar on the same UTC day,
 * whose total exceeds the daily cap, must admit at most the cap, and the
 * ledger debits must equal exactly what was admitted.
 *
 * `admitAutonomousSpend` reads the day's usage from `claw_token_transactions`
 * inside the settlement transaction, after `takeAvatarLockAndValidate` takes
 * `pg_advisory_xact_lock(hashtextextended(avatarId, 0))` + the avatar row
 * `FOR UPDATE`. Every entry point ALSO wraps the transaction in the in-process
 * `withKeyedMutex('land-tenure:<avatarId>')`. In one test process that mutex
 * alone makes `Promise.all` strictly FIFO, so a naive test would never reach the
 * DB lock. This file therefore mocks the mutex as a pass-through for case 1
 * (what two API processes / replicas look like) and holds the avatar advisory
 * lock itself until all N transactions are queued on it, so they really race
 * the moment it is released. Case 2 keeps the real mutex (the in-process path).
 *
 * The file uses `mock.module`, so the gates.yml route lane runs it in its own
 * process automatically (no filename list to update).
 */
import { afterAll, describe, expect, it, mock } from 'bun:test';
import * as dbMod from '@clawville/database';
import type { ActivityIdentity } from '../../middleware/require-auth-or-agent';
import { resolveAgentLandDailySpendVclaw } from '../../services/autonomous-land-spend-cap';

// Capture the REAL mutex function object before the mock replaces the module.
const realWithKeyedMutex = (await import('../../services/keyed-mutex')).withKeyedMutex;
let bypassMutex = false;
mock.module('../../services/keyed-mutex', () => ({
  withKeyedMutex: <T>(key: string, fn: () => Promise<T>): Promise<T> =>
    bypassMutex ? fn() : realWithKeyedMutex(key, fn),
  _keyedMutexSize: () => 0,
}));
// Dynamic import AFTER the mock so the settlement module binds to it.
const { settleRentPrepay } = await import('../../services/land-tenure-settlement');

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const START_BALANCE = 100_000;
const START_DEPOSIT = 1_000;

function first<T>(rows: Iterable<T>): T {
  const row = Array.from(rows)[0];
  if (!row) throw new Error('autonomous land concurrency fixture query returned no row');
  return row;
}

interface Fixture {
  userId: string;
  avatarId: string;
  agentId: string;
  parcelCodes: string[];
}

describeIfDb('Land autonomous daily cap under concurrent spends (real DB)', () => {
  const tag = `lac${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  const fixtures: Fixture[] = [];

  // Each waiting settlement holds one pooled connection. Keep N inside the
  // pool (DB_POOL_MAX, default 10) with room for the gate tx and the poller.
  const envPool = Number(process.env.DB_POOL_MAX);
  const poolMax = envPool > 0 ? envPool : 10;
  const concurrency = Math.min(6, poolMax - 2);
  const cap = resolveAgentLandDailySpendVclaw();
  const admittedTarget = Math.max(1, Math.floor(concurrency / 2));
  // floor(cap / amount) === admittedTarget, and concurrency * amount > cap.
  const amount = Math.floor(cap / admittedTarget);

  async function makeFixture(label: string): Promise<Fixture> {
    const users = await dbMod.db.execute<{ id: string }>(
      dbMod.sql`INSERT INTO users (email, password_hash, name)
                VALUES (${`${tag}-${label}@clawville-test.invalid`}, ${`disabled-${tag}`},
                        'Land autonomous concurrency test')
                RETURNING id`,
    );
    const userId = first(users).id;
    const avatars = await dbMod.db.execute<{ id: string }>(
      dbMod.sql`INSERT INTO avatars
                  (user_id, name, species, color, gender, archetype, personality, stats,
                   claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
                VALUES
                  (${userId}, ${`${tag}-${label}`}, 'cat', 'green', 'male', 'brave-adventurer',
                   ${JSON.stringify({ habitat: 'test', hobby: 'testing', greeting: 'hi' })}::jsonb,
                   ${JSON.stringify({ strength: 1, defence: 1, movement: 1 })}::jsonb,
                   ${START_BALANCE}, ${START_BALANCE}, 0, 0, false, false)
                RETURNING id`,
    );
    const avatarId = first(avatars).id;
    const agentId = `${tag}-${label}-agent`;
    await dbMod.db.execute(
      dbMod.sql`INSERT INTO openclaw_bots (agent_id, mode, user_id)
                VALUES (${agentId}, 'connected', ${userId})`,
    );
    // One deposit parcel PER spend: the parcel row lock (`lockParcel FOR UPDATE`)
    // must not be what serializes the spends, or the test would pass even with
    // the avatar-level advisory lock removed. Only the avatar lock is shared.
    const parcelCodes: string[] = [];
    for (let i = 0; i < concurrency; i += 1) {
      const parcelCode = `${tag}-${label}-parcel-${i}`;
      const grid = -930000 - fixtures.length * 100 - i;
      await dbMod.db.execute(
        dbMod.sql`INSERT INTO land_parcels
                    (parcel_code, tier, status, grid_x, grid_y, owner_avatar_id,
                     tenure, tenure_terms_version, acquired_at, rent_ct_weekly,
                     deposit_ct, deposit_remaining_ct, grandfathered)
                  VALUES (${parcelCode}, 'starter', 'owned', ${grid}, ${grid},
                          ${avatarId}, 'deposit', 2, now(), 1000,
                          ${START_DEPOSIT}, ${START_DEPOSIT}, false)`,
      );
      parcelCodes.push(parcelCode);
    }
    const fixture = { userId, avatarId, agentId, parcelCodes };
    fixtures.push(fixture);
    return fixture;
  }

  const agentIdentity = (f: Fixture): ActivityIdentity => ({
    kind: 'agent',
    userId: f.userId,
    avatarId: f.avatarId,
    agentId: f.agentId,
    sessionId: `${f.agentId}-session`,
    ledgerCapable: true,
  });

  const spend = (f: Fixture, i: number) =>
    settleRentPrepay({
      identity: agentIdentity(f),
      expectedAvatarId: f.avatarId,
      expectedUserId: f.userId,
      expectedAgentId: f.agentId,
      parcelCode: f.parcelCodes[i] as string,
      idempotencyKey: `${tag}-${f.agentId}-spend-${i}`,
      autonomous: true,
      amountCt: amount,
    });

  async function advisoryWaiters(): Promise<number> {
    const rows = await dbMod.db.execute<{ n: number | string }>(
      dbMod.sql`SELECT COUNT(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database()
                  AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
    );
    return Number(first(rows).n);
  }

  async function waitForAdvisoryWaiters(n: number): Promise<number> {
    const deadline = Date.now() + 15_000;
    let seen = 0;
    while (Date.now() < deadline) {
      seen = await advisoryWaiters();
      if (seen >= n) return seen;
      await new Promise((r) => setTimeout(r, 25));
    }
    return seen;
  }

  async function assertCapHeld(
    f: Fixture,
    results: PromiseSettledResult<unknown>[],
  ): Promise<void> {
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    for (const r of rejected) {
      const failure = r.reason as { code?: string; status?: number };
      expect({ code: failure.code, status: failure.status }).toEqual({
        code: 'autonomous_daily_cap',
        status: 429,
      });
    }
    expect(fulfilled.length).toBe(admittedTarget);
    expect(rejected.length).toBe(concurrency - admittedTarget);

    const admittedCt = admittedTarget * amount;
    const debits = first(
      await dbMod.db.execute<{ n: number | string; total: number | string }>(
        dbMod.sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(-amount), 0)::int AS total
                  FROM claw_token_transactions
                  WHERE avatar_id = ${f.avatarId} AND amount < 0
                    AND metadata ->> 'autonomousLand' = 'true'`,
      ),
    );
    expect(Number(debits.n)).toBe(admittedTarget);
    expect(Number(debits.total)).toBe(admittedCt);
    expect(Number(debits.total)).toBeLessThanOrEqual(cap);

    const avatar = first(
      await dbMod.db.execute<{ claw_tokens: number | string }>(
        dbMod.sql`SELECT claw_tokens FROM avatars WHERE id = ${f.avatarId}`,
      ),
    );
    expect(Number(avatar.claw_tokens)).toBe(START_BALANCE - admittedCt);

    const parcels = first(
      await dbMod.db.execute<{ total: number | string }>(
        dbMod.sql`SELECT COALESCE(SUM(deposit_remaining_ct), 0)::int AS total
                  FROM land_parcels WHERE owner_avatar_id = ${f.avatarId}`,
      ),
    );
    expect(Number(parcels.total)).toBe(concurrency * START_DEPOSIT + admittedCt);

    const settlements = first(
      await dbMod.db.execute<{ n: number | string }>(
        dbMod.sql`SELECT COUNT(*)::int AS n FROM land_tenure_settlements
                  WHERE avatar_id = ${f.avatarId} AND operation = 'rent_prepay'`,
      ),
    );
    expect(Number(settlements.n)).toBe(admittedTarget);

    const landTx = first(
      await dbMod.db.execute<{ n: number | string; total: number | string }>(
        dbMod.sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_ct), 0)::int AS total
                  FROM land_transactions
                  WHERE avatar_id = ${f.avatarId} AND kind = 'land_deposit_topup'`,
      ),
    );
    expect(Number(landTx.n)).toBe(admittedTarget);
    expect(Number(landTx.total)).toBe(admittedCt);
  }

  afterAll(async () => {
    bypassMutex = false;
    for (const f of fixtures) {
      await dbMod.db.execute(
        dbMod.sql`DELETE FROM land_transactions WHERE avatar_id = ${f.avatarId}`,
      ).catch(() => {});
      await dbMod.db.execute(
        dbMod.sql`DELETE FROM land_tenure_settlements WHERE avatar_id = ${f.avatarId}`,
      ).catch(() => {});
      await dbMod.db.execute(
        dbMod.sql`DELETE FROM land_parcels WHERE owner_avatar_id = ${f.avatarId}`,
      ).catch(() => {});
      await dbMod.db.execute(
        dbMod.sql`DELETE FROM claw_token_transactions WHERE avatar_id = ${f.avatarId}`,
      ).catch(() => {});
      await dbMod.db.execute(
        dbMod.sql`DELETE FROM openclaw_bots WHERE agent_id = ${f.agentId}`,
      ).catch(() => {});
      await dbMod.db.execute(dbMod.sql`DELETE FROM avatars WHERE id = ${f.avatarId}`).catch(
        () => {},
      );
      await dbMod.db.execute(dbMod.sql`DELETE FROM users WHERE id = ${f.userId}`).catch(
        () => {},
      );
    }
  });

  it('fixture sizing: N concurrent spends exceed the cap, the cap admits fewer than N', () => {
    expect(concurrency).toBeGreaterThanOrEqual(2);
    expect(amount).toBeGreaterThan(0);
    expect(amount).toBeLessThanOrEqual(1_000_000);
    expect(Math.floor(cap / amount)).toBe(admittedTarget);
    expect(concurrency * amount).toBeGreaterThan(cap);
    expect(START_BALANCE).toBeGreaterThan(concurrency * amount);
  });

  it('DB advisory lock alone (mutex bypassed, all N queued on the lock, then released) admits at most the cap', async () => {
    const f = await makeFixture('dblock');
    // No stray advisory waiters from elsewhere would make the queue count lie.
    expect(await advisoryWaiters()).toBe(0);

    let releaseGate!: () => void;
    const gateReleased = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let gateHeld!: () => void;
    const gateLocked = new Promise<void>((resolve) => {
      gateHeld = resolve;
    });
    const gate = dbMod.db.transaction(async (tx) => {
      await tx.execute(
        dbMod.sql`SELECT pg_advisory_xact_lock(hashtextextended(${f.avatarId}, 0))`,
      );
      gateHeld();
      await gateReleased;
    });

    bypassMutex = true;
    let results: PromiseSettledResult<unknown>[];
    try {
      await gateLocked;
      // allSettled is attached at once so an early rejection is never unhandled.
      const settled = Promise.allSettled(
        Array.from({ length: concurrency }, (_, i) => spend(f, i)),
      );
      // Proof of real contention: every one of the N transactions is parked
      // on the avatar advisory lock at the same time. With the in-process
      // mutex still active this count could never pass 1.
      const queued = await waitForAdvisoryWaiters(concurrency);
      releaseGate();
      await gate;
      results = await settled;
      expect(queued).toBeGreaterThanOrEqual(concurrency);
    } finally {
      releaseGate();
      bypassMutex = false;
    }
    await assertCapHeld(f, results);
  }, 60_000);

  it('production in-process path (real keyed mutex + DB lock) admits at most the cap', async () => {
    const f = await makeFixture('mutex');
    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, (_, i) => spend(f, i)),
    );
    await assertCapHeld(f, results);
  }, 60_000);
});
