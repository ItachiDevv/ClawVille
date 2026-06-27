/**
 * vCLAW PROVENANCE LEDGER — Tokenomics F1 unit tests.
 *
 * Drives the REAL `claw-token-ledger.ts` helpers (creditClawTokens /
 * debitClawTokens / transferClawTokens / mintEarned) against a STUBBED
 * @clawville/database `db` so NO live DB is touched. The stub is a FAITHFUL
 * in-memory model of the exact operations the ledger performs:
 *   - `tx.execute(sql\`SELECT … FOR UPDATE\`)` → returns the locked avatar row
 *     (and records which avatar is now "locked" for the subsequent UPDATE).
 *   - `tx.update(avatars).set({…}).where(…)` → applies the balance columns to
 *     the locked avatar row (the ledger updates exactly the row it just locked).
 *   - `tx.insert(clawTokenTransactions).values({…}).returning({id})` → appends a
 *     ledger row to the in-memory log and returns a fresh id.
 *   - `db.transaction(fn)` → runs `fn(tx)` against the same in-memory store.
 *
 * The store enforces the SAME invariant the DB CHECK does
 * (`claw_tokens = soft + bought + earned`) on every UPDATE, so a torn write would
 * fail the test the way the constraint would fail in Postgres.
 *
 * INVARIANTS PROVEN (mapping to the F1 spec):
 *   1. credit defaults to SOFT; passing provenance:'bought' tags BOUGHT.
 *   2. mintEarned is the ONLY path that writes provenance='earned' / moves
 *      earned_balance — exhaustively, by exercising EVERY other exported writer.
 *   3. transferClawTokens credits the receiver SOFT regardless of the payer's tags.
 *   4. debit burns SOFT→BOUGHT→EARNED and emits ONE ledger row per tag burned.
 *   5. the per-tag sum always equals the total after every operation.
 *   6. the runtime chokepoint refuses a forced 'earned' through the credit path.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { randomUUID } from 'crypto';

// Capture the REAL modules BEFORE the mocks so each stub can spread every real
// export and override ONLY the member it needs. Bun runs all test files in ONE
// process with a SHARED module registry, so a partial mock of a module that other
// test files import named members from would break THEM ("Export not found"). The
// spread is mandatory for BOTH @clawville/database (db) and ../event-logger
// (logEvent) — event-logger also exports ACTIVITY_EVENT_TYPES that co-running tests
// depend on.
import * as realDatabase from '@clawville/database';
import * as realEventLogger from '../event-logger';

// ── In-memory store ───────────────────────────────────────────────────────────
interface AvatarRow {
  id: string;
  user_id: string;
  claw_tokens: number;
  soft_balance: number;
  bought_balance: number;
  earned_balance: number;
}

interface LedgerRow {
  avatarId: string;
  userId: string;
  amount: number;
  balanceAfter: number;
  reason: string;
  source: string;
  provenance: string | null;
  usdBasis: string | null;
  fpHash: string | null;
  ipPrefixHash: string | null;
  metadata: Record<string, unknown>;
}

const store = {
  avatars: new Map<string, AvatarRow>(),
  ledger: [] as LedgerRow[],
  /** The avatar id locked by the most recent FOR-UPDATE select in this tx. */
  lockedId: null as string | null,
};

function resetStore(): void {
  store.avatars.clear();
  store.ledger = [];
  store.lockedId = null;
}

function seedAvatar(partial: Partial<AvatarRow> & { id?: string }): AvatarRow {
  const id = partial.id ?? randomUUID();
  const soft = partial.soft_balance ?? 0;
  const bought = partial.bought_balance ?? 0;
  const earned = partial.earned_balance ?? 0;
  const row: AvatarRow = {
    id,
    user_id: partial.user_id ?? `user-${id}`,
    claw_tokens: partial.claw_tokens ?? soft + bought + earned,
    soft_balance: soft,
    bought_balance: bought,
    earned_balance: earned,
  };
  store.avatars.set(id, row);
  return row;
}

// Recover the FIRST bound param (the avatarId) from a drizzle `sql` template. The
// raw SQL object exposes its interpolations as `queryChunks` (a `Param` chunk holds
// `.value`); this mirrors the proven extraction in cash-house-scaler.test.ts.
function firstParam(q: unknown): string | null {
  const chunks = (q as { queryChunks?: unknown[] }).queryChunks ?? [];
  for (const ch of chunks) {
    const cn = (ch as { constructor?: { name?: string } })?.constructor?.name;
    // A bare-string interpolation (`${avatarId}`) lands as a boxed `String` object
    // whose primitive IS the value; `StringChunk` is the static SQL text (skip it).
    // A `Param` chunk (other drizzle paths) carries `.value`.
    if (cn === 'String') return String(ch);
    if (cn === 'Param') return String((ch as { value: unknown }).value);
  }
  // Fallback: some drizzle versions surface a flattened `params` array.
  const params = (q as { params?: unknown[] }).params;
  if (params && params.length > 0) return String(params[0]);
  return null;
}

// ── Fake tx implementing exactly the surface the ledger calls ──────────────────
function makeTx() {
  return {
    // The ledger only issues the FOR-UPDATE SELECT through execute(). Recover the
    // avatarId from the drizzle `sql` template's bound params and return the row.
    async execute(q: unknown) {
      const avatarId = firstParam(q);
      if (!avatarId) throw new Error('execute: could not recover avatarId param');
      store.lockedId = avatarId;
      const row = store.avatars.get(avatarId);
      return row ? [row] : [];
    },
    update(_table: unknown) {
      return {
        set(payload: Record<string, unknown>) {
          return {
            async where(_cond: unknown) {
              // The ledger updates exactly the row it just locked in this tx.
              const id = store.lockedId;
              if (!id) throw new Error('update without a prior FOR UPDATE lock');
              const row = store.avatars.get(id);
              if (!row) throw new Error(`update of missing avatar ${id}`);
              const next: AvatarRow = {
                ...row,
                claw_tokens: payload.clawTokens as number,
                soft_balance: payload.softBalance as number,
                bought_balance: payload.boughtBalance as number,
                earned_balance: payload.earnedBalance as number,
              };
              // Enforce the DB CHECK in the stub: torn writes fail here.
              if (
                next.claw_tokens !==
                next.soft_balance + next.bought_balance + next.earned_balance
              ) {
                throw new Error('avatars_vclaw_balance_sum violated by stubbed UPDATE');
              }
              store.avatars.set(id, next);
            },
          };
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          return {
            async returning(_cols: unknown) {
              const id = randomUUID();
              store.ledger.push({
                avatarId: v.avatarId as string,
                userId: v.userId as string,
                amount: v.amount as number,
                balanceAfter: v.balanceAfter as number,
                reason: v.reason as string,
                source: v.source as string,
                provenance: (v.provenance as string | null) ?? null,
                usdBasis: (v.usdBasis as string | null) ?? null,
                fpHash: (v.fpHash as string | null) ?? null,
                ipPrefixHash: (v.ipPrefixHash as string | null) ?? null,
                metadata: (v.metadata as Record<string, unknown>) ?? {},
              });
              return [{ id }];
            },
          };
        },
      };
    },
  };
}

const fakeDb = {
  async transaction<T>(fn: (tx: ReturnType<typeof makeTx>) => Promise<T>): Promise<T> {
    return fn(makeTx());
  },
};

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: fakeDb,
}));

// event-logger pulls in alert-error / telegram; stub ONLY logEvent to a no-op so
// transfer's fire-and-forget telemetry doesn't reach real infra. Spread the rest
// (ACTIVITY_EVENT_TYPES et al.) so co-running test files keep resolving them.
mock.module('../event-logger', () => ({
  ...realEventLogger,
  logEvent: async () => {},
}));

// Import the ledger AFTER the mocks are registered.
const {
  creditClawTokens,
  debitClawTokens,
  transferClawTokens,
  mintEarned,
} = await import('../claw-token-ledger');

beforeEach(() => {
  resetStore();
});

function getAvatar(id: string): AvatarRow {
  const row = store.avatars.get(id);
  if (!row) throw new Error(`avatar ${id} missing`);
  return row;
}
function ledgerFor(id: string): LedgerRow[] {
  return store.ledger.filter((r) => r.avatarId === id);
}
function earnedRows(): LedgerRow[] {
  return store.ledger.filter((r) => r.provenance === 'earned');
}

describe('claw-token-ledger F1 — credit provenance', () => {
  it('credit defaults to SOFT and moves only soft_balance', async () => {
    const a = seedAvatar({ claw_tokens: 100, soft_balance: 100 });
    const res = await creditClawTokens({ avatarId: a.id, amount: 50, reason: 'quest', source: 'quest' });
    expect(res.balanceAfter).toBe(150);
    const row = getAvatar(a.id);
    expect(row.soft_balance).toBe(150);
    expect(row.bought_balance).toBe(0);
    expect(row.earned_balance).toBe(0);
    expect(row.claw_tokens).toBe(150);
    const last = ledgerFor(a.id).at(-1)!;
    expect(last.provenance).toBe('soft');
    expect(last.amount).toBe(50);
  });

  it("credit with provenance:'bought' moves only bought_balance and stamps the bought tag", async () => {
    const a = seedAvatar({ claw_tokens: 0, soft_balance: 0 });
    await creditClawTokens({
      avatarId: a.id,
      amount: 200,
      reason: 'onramp',
      source: 'x402',
      provenance: 'bought',
    });
    const row = getAvatar(a.id);
    expect(row.bought_balance).toBe(200);
    expect(row.soft_balance).toBe(0);
    expect(row.earned_balance).toBe(0);
    expect(row.claw_tokens).toBe(200);
    expect(ledgerFor(a.id).at(-1)!.provenance).toBe('bought');
  });
});

describe('claw-token-ledger F1 — mintEarned chokepoint', () => {
  it('mintEarned is the ONLY writer that produces an earned row / moves earned_balance', async () => {
    const a = seedAvatar({ claw_tokens: 1000, soft_balance: 1000 });
    const b = seedAvatar({ claw_tokens: 0, soft_balance: 0 });

    // Exercise EVERY other exported writer — none may produce an earned row.
    await creditClawTokens({ avatarId: a.id, amount: 10, reason: 'soft', source: 'quest' });
    await creditClawTokens({
      avatarId: a.id, amount: 10, reason: 'bought', source: 'x402', provenance: 'bought',
    });
    await debitClawTokens({ avatarId: a.id, amount: 5, reason: 'sink', source: 'api' });
    await transferClawTokens({
      fromAvatarId: a.id, toAvatarId: b.id, amount: 20, reason: 'peer', source: 'exchange',
    });
    expect(earnedRows().length).toBe(0);
    expect(getAvatar(a.id).earned_balance).toBe(0);
    expect(getAvatar(b.id).earned_balance).toBe(0);

    // Only mintEarned writes earned.
    const res = await mintEarned({
      avatarId: b.id, amount: 75, reason: 'agent_labor', source: 'x402', usdBasis: '75.000000',
    });
    expect(res.balanceAfter).toBe(getAvatar(b.id).claw_tokens);
    const row = getAvatar(b.id);
    expect(row.earned_balance).toBe(75);
    const er = earnedRows();
    expect(er.length).toBe(1);
    expect(er[0].provenance).toBe('earned');
    expect(er[0].usdBasis).toBe('75.000000');
  });

  it('mintEarned stamps usd_basis + fp/ip anti-abuse hashes', async () => {
    const a = seedAvatar({ claw_tokens: 0, soft_balance: 0 });
    await mintEarned({
      avatarId: a.id,
      amount: 40,
      reason: 'labor',
      source: 'x402',
      usdBasis: '40.000000',
      fpHash: 'fp-abc',
      ipPrefixHash: 'ip-xyz',
    });
    const r = earnedRows()[0];
    expect(r.usdBasis).toBe('40.000000');
    expect(r.fpHash).toBe('fp-abc');
    expect(r.ipPrefixHash).toBe('ip-xyz');
  });

  it('mintEarned rejects an empty usdBasis (a cashable mint must carry a USD basis)', async () => {
    const a = seedAvatar({ claw_tokens: 0, soft_balance: 0 });
    await expect(
      mintEarned({ avatarId: a.id, amount: 10, reason: 'x', source: 'x402', usdBasis: '' }),
    ).rejects.toThrow(/usdBasis/);
    expect(earnedRows().length).toBe(0);
  });

  it('the RUNTIME guard refuses a forced earned provenance through creditClawTokens (belt-and-suspenders)', async () => {
    const a = seedAvatar({ claw_tokens: 0, soft_balance: 0 });
    // The public type forbids 'earned'; force-cast to SIMULATE a future refactor
    // that widens the type or a caller that bypasses the compiler. The runtime
    // chokepoint must still refuse to mint a cashable balance off this path.
    await expect(
      creditClawTokens({
        avatarId: a.id,
        amount: 50,
        reason: 'laundering_attempt',
        source: 'system',
        provenance: 'earned' as unknown as 'soft',
      }),
    ).rejects.toThrow(/EARNED provenance may only be minted via mintEarned/);
    expect(earnedRows().length).toBe(0);
    expect(getAvatar(a.id).earned_balance).toBe(0);
  });
});

describe('claw-token-ledger F1 — transfer always credits SOFT', () => {
  it('receiver gets SOFT even when the payer spends BOUGHT and EARNED', async () => {
    // Payer has NO soft, only bought+earned, so the debit must dip into both.
    const payer = seedAvatar({ claw_tokens: 100, soft_balance: 0, bought_balance: 60, earned_balance: 40 });
    const receiver = seedAvatar({ claw_tokens: 0, soft_balance: 0 });

    await transferClawTokens({
      fromAvatarId: payer.id, toAvatarId: receiver.id, amount: 80, reason: 'peer', source: 'exchange',
    });

    // Receiver: 80 SOFT, nothing else — internal recirculation is never cashable.
    const r = getAvatar(receiver.id);
    expect(r.soft_balance).toBe(80);
    expect(r.bought_balance).toBe(0);
    expect(r.earned_balance).toBe(0);
    const credit = ledgerFor(receiver.id).at(-1)!;
    expect(credit.provenance).toBe('soft');
    expect(credit.amount).toBe(80);

    // Payer burned bought(60) then earned(20) — earned preserved as much as possible
    // is NOT the rule for a payer who has no soft; the rule is SOFT→BOUGHT→EARNED.
    const p = getAvatar(payer.id);
    expect(p.bought_balance).toBe(0);
    expect(p.earned_balance).toBe(20);
    expect(p.claw_tokens).toBe(20);
  });
});

describe('claw-token-ledger F1 — spend order SOFT→BOUGHT→EARNED + per-tag rows', () => {
  it('burns SOFT first, then BOUGHT, then EARNED, preserving the cashable balance', async () => {
    const a = seedAvatar({ claw_tokens: 100, soft_balance: 50, bought_balance: 30, earned_balance: 20 });
    // Debit 60: should burn 50 soft + 10 bought, leaving bought=20, earned=20 intact.
    await debitClawTokens({ avatarId: a.id, amount: 60, reason: 'sink', source: 'api' });
    const row = getAvatar(a.id);
    expect(row.soft_balance).toBe(0);
    expect(row.bought_balance).toBe(20);
    expect(row.earned_balance).toBe(20); // cashable balance untouched
    expect(row.claw_tokens).toBe(40);
  });

  it('a multi-tag debit emits ONE ledger row per tag burned with a running total balanceAfter', async () => {
    const a = seedAvatar({ claw_tokens: 100, soft_balance: 50, bought_balance: 30, earned_balance: 20 });
    // Debit 90: 50 soft + 30 bought + 10 earned.
    await debitClawTokens({ avatarId: a.id, amount: 90, reason: 'big_sink', source: 'api' });

    const rows = ledgerFor(a.id);
    expect(rows.length).toBe(3);
    // Order is SOFT, BOUGHT, EARNED with the right negative amounts.
    expect(rows[0].provenance).toBe('soft');
    expect(rows[0].amount).toBe(-50);
    expect(rows[0].balanceAfter).toBe(50); // 100 - 50
    expect(rows[1].provenance).toBe('bought');
    expect(rows[1].amount).toBe(-30);
    expect(rows[1].balanceAfter).toBe(20); // 50 - 30
    expect(rows[2].provenance).toBe('earned');
    expect(rows[2].amount).toBe(-10);
    expect(rows[2].balanceAfter).toBe(10); // 20 - 10

    const row = getAvatar(a.id);
    expect(row.soft_balance).toBe(0);
    expect(row.bought_balance).toBe(0);
    expect(row.earned_balance).toBe(10);
    expect(row.claw_tokens).toBe(10);
  });

  it('a single-tag debit (soft only) emits exactly one row', async () => {
    const a = seedAvatar({ claw_tokens: 100, soft_balance: 100 });
    await debitClawTokens({ avatarId: a.id, amount: 30, reason: 'sink', source: 'api' });
    const rows = ledgerFor(a.id);
    expect(rows.length).toBe(1);
    expect(rows[0].provenance).toBe('soft');
    expect(rows[0].amount).toBe(-30);
  });

  it('debit throws InsufficientTokensError when the TOTAL is too low (and writes nothing)', async () => {
    const a = seedAvatar({ claw_tokens: 10, soft_balance: 5, bought_balance: 5 });
    await expect(
      debitClawTokens({ avatarId: a.id, amount: 11, reason: 'sink', source: 'api' }),
    ).rejects.toThrow(/cannot debit/);
    const row = getAvatar(a.id);
    expect(row.claw_tokens).toBe(10); // unchanged
    expect(ledgerFor(a.id).length).toBe(0);
  });
});

describe('claw-token-ledger F1 — reconciler adversarial edges', () => {
  it('debit of the FULL balance zeroes all three tags and emits one row per tag', async () => {
    const a = seedAvatar({ claw_tokens: 100, soft_balance: 50, bought_balance: 30, earned_balance: 20 });
    await debitClawTokens({ avatarId: a.id, amount: 100, reason: 'drain', source: 'api' });
    const row = getAvatar(a.id);
    expect(row.soft_balance).toBe(0);
    expect(row.bought_balance).toBe(0);
    expect(row.earned_balance).toBe(0);
    expect(row.claw_tokens).toBe(0);
    const rows = ledgerFor(a.id);
    expect(rows.length).toBe(3);
    // running balanceAfter walks 100→50→20→0
    expect(rows.map((r) => r.balanceAfter)).toEqual([50, 20, 0]);
    expect(rows.map((r) => r.provenance)).toEqual(['soft', 'bought', 'earned']);
    expect(rows.map((r) => r.amount)).toEqual([-50, -30, -20]);
  });

  it('debit exactly equal to soft burns ONLY soft and preserves bought+earned untouched', async () => {
    const a = seedAvatar({ claw_tokens: 100, soft_balance: 50, bought_balance: 30, earned_balance: 20 });
    await debitClawTokens({ avatarId: a.id, amount: 50, reason: 'boundary', source: 'api' });
    const row = getAvatar(a.id);
    expect(row.soft_balance).toBe(0);
    expect(row.bought_balance).toBe(30);
    expect(row.earned_balance).toBe(20);
    expect(row.claw_tokens).toBe(50);
    const rows = ledgerFor(a.id);
    expect(rows.length).toBe(1); // exactly one tag burned
    expect(rows[0].provenance).toBe('soft');
    expect(rows[0].amount).toBe(-50);
  });

  it('lazy-backfill reconciliation: a row with tags=0 but non-zero claw_tokens is treated as all-SOFT and leaves consistent', async () => {
    // Simulate a not-yet-migrated row: 100 claw_tokens, all tag columns still 0.
    const a = seedAvatar({ claw_tokens: 100, soft_balance: 0, bought_balance: 0, earned_balance: 0 });
    // Sanity: this row currently violates the sum (the stub allows seeding it, but
    // any WRITE must leave it reconciled).
    expect(a.soft_balance + a.bought_balance + a.earned_balance).not.toBe(a.claw_tokens);

    // A credit must fold the legacy balance into SOFT (readLockedBalances), then add.
    await creditClawTokens({ avatarId: a.id, amount: 25, reason: 'reconcile', source: 'quest' });
    const row = getAvatar(a.id);
    expect(row.claw_tokens).toBe(125);
    expect(row.soft_balance).toBe(125); // 100 folded to soft + 25 new soft
    expect(row.bought_balance).toBe(0);
    expect(row.earned_balance).toBe(0);
    // And it never minted earned via this path.
    expect(earnedRows().length).toBe(0);
  });

  it('lazy-backfill reconciliation on a DEBIT: legacy all-SOFT row debits from soft only', async () => {
    const a = seedAvatar({ claw_tokens: 100, soft_balance: 0, bought_balance: 0, earned_balance: 0 });
    await debitClawTokens({ avatarId: a.id, amount: 40, reason: 'legacy_sink', source: 'api' });
    const row = getAvatar(a.id);
    expect(row.claw_tokens).toBe(60);
    expect(row.soft_balance).toBe(60); // folded-to-soft then burned from soft
    expect(row.bought_balance).toBe(0);
    expect(row.earned_balance).toBe(0);
    const rows = ledgerFor(a.id);
    expect(rows.length).toBe(1);
    expect(rows[0].provenance).toBe('soft');
  });
});

describe('claw-token-ledger F1 — sum invariant holds after every op', () => {
  it('credit, debit, transfer, and mintEarned all keep claw_tokens === sum(tags)', async () => {
    const a = seedAvatar({ claw_tokens: 100, soft_balance: 100 });
    const b = seedAvatar({ claw_tokens: 0, soft_balance: 0 });

    const ops: Array<() => Promise<unknown>> = [
      () => creditClawTokens({ avatarId: a.id, amount: 33, reason: 'c', source: 'quest' }),
      () => creditClawTokens({ avatarId: a.id, amount: 17, reason: 'b', source: 'x402', provenance: 'bought' }),
      () => mintEarned({ avatarId: a.id, amount: 25, reason: 'e', source: 'x402', usdBasis: '25.000000' }),
      () => debitClawTokens({ avatarId: a.id, amount: 40, reason: 'd', source: 'api' }),
      () => transferClawTokens({ fromAvatarId: a.id, toAvatarId: b.id, amount: 10, reason: 't', source: 'exchange' }),
    ];
    for (const op of ops) {
      await op();
      for (const row of store.avatars.values()) {
        expect(row.claw_tokens).toBe(row.soft_balance + row.bought_balance + row.earned_balance);
      }
    }
  });
});

describe('claw-token-ledger F1 — DEFAULT-INSERT must satisfy the sum CHECK (regression for BLOCKING #1)', () => {
  // Root cause caught here: `avatars_vclaw_balance_sum` is immediate/non-deferrable,
  // so a bare INSERT that omits the tag columns must satisfy
  //   claw_tokens(default) = soft_balance(default) + bought_balance(default) + earned_balance(default)
  // The original diff left soft_balance DEFAULT 0 while claw_tokens DEFAULT 100, so
  // EVERY default-relying INSERT (guest signup, create-agent, agent-setup, Hatcher
  // provision, web avatars route) would have thrown a CHECK violation. The fix sets
  // soft_balance DEFAULT 100 to mirror claw_tokens. We assert the LIVE column
  // defaults (read off the imported drizzle schema), not a hand-built row, so this
  // can NEVER be masked by the stub's seedAvatar pre-computing the sum.
  const avatarsTable = (realDatabase as unknown as {
    avatars: Record<string, { default?: unknown }>;
  }).avatars;
  const colDefault = (name: string): number => Number(avatarsTable[name]?.default ?? NaN);

  it('soft_balance DEFAULT mirrors claw_tokens DEFAULT (both 100)', () => {
    expect(colDefault('clawTokens')).toBe(100);
    expect(colDefault('softBalance')).toBe(100);
  });

  it('bought_balance and earned_balance DEFAULT to 0', () => {
    expect(colDefault('boughtBalance')).toBe(0);
    expect(colDefault('earnedBalance')).toBe(0);
  });

  it('a bare INSERT (all balance columns defaulted) satisfies claw_tokens === soft + bought + earned', () => {
    // This is exactly the row a default-relying INSERT (no explicit clawTokens/tags)
    // produces — the case the original stub never modeled. If the defaults diverge
    // this assertion fails the way the live Postgres CHECK would reject the INSERT.
    const ct = colDefault('clawTokens');
    const soft = colDefault('softBalance');
    const bought = colDefault('boughtBalance');
    const earned = colDefault('earnedBalance');
    expect(ct).toBe(soft + bought + earned);
  });

  // NOTE: a REAL-DB integration test (insert an avatar omitting the tag columns,
  // expect no CHECK violation) is the ultimate proof and should run against the
  // migrated staging DB — the unit layer here can only assert the column-default
  // contract, which is the exact invariant that broke.
});
