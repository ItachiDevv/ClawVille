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
 *   - EARNED mint lots / accounted-ledger membership / lot consumption are
 *     modeled explicitly, so the E2 attribution invariant is exercised too.
 *   - `db.transaction(fn)` → runs `fn(tx)` against the same in-memory store.
 *
 * The store enforces the SAME invariant the DB CHECK does
 * (`claw_tokens = soft + bought + earned`) on every UPDATE, so a torn write would
 * fail the test the way the constraint would fail in Postgres.
 *
 * INVARIANTS PROVEN (mapping to the F1 spec):
 *   1. credit defaults to SOFT; passing provenance:'bought' tags BOUGHT.
 *   2. mintEarned is the ONLY path that writes NEW provenance='earned' / moves
 *      earned_balance — exhaustively, by exercising EVERY other exported writer.
 *      The refund-only restoreEarnedSpendForRefund (security pass 2026-10-04) is
 *      the second EARNED writer: it only returns the units of one prior EARNED
 *      spend debit row and refuses without one.
 *   3. transferClawTokens credits the receiver SOFT regardless of the payer's tags.
 *   4. debit burns SOFT→BOUGHT→EARNED and emits ONE ledger row per tag burned.
 *   5. the per-tag sum always equals the total after every operation.
 *   6. the runtime chokepoint refuses a forced 'earned' through the credit path.
 *   7. restoreEarnedSpendForRefund returns each consumed unit to its original lot
 *      (a backed lot gets its released backing back), sends units of a released
 *      lot to one new 'none' lot, credits exactly the debit amount, at most once.
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
  id: string;
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

interface EarnedLotRow {
  id: string;
  ledgerId: string;
  avatarId: string;
  backing_kind: 'backed' | 'none';
  remaining_vclaw: number;
  created: number;
  original_vclaw: number;
  /** released_at IS NOT NULL (admin claw-back / payer rejection). */
  released: boolean;
  earn_event_id: string | null;
  mint_ref: string;
}

/** earned_backing: micro-USDC, original = remaining + consumed + released (DB CHECK). */
interface BackingRow {
  mintLotId: string;
  original: bigint;
  remaining: bigint;
  consumed: bigint;
  released: bigint;
}

interface ConsumptionRow {
  mintLotId: string;
  ledgerDebitId: string;
  kind: string;
  vclawAmount: number;
  usdcAtomic: string;
}

const store = {
  avatars: new Map<string, AvatarRow>(),
  ledger: [] as LedgerRow[],
  earnedLots: [] as EarnedLotRow[],
  /** earned_accounted_ledger: ledger id -> kind (PRIMARY KEY ledger_id). */
  earnedAccounted: new Map<string, string>(),
  backings: new Map<string, BackingRow>(),
  consumptions: [] as ConsumptionRow[],
  /** earn_events: closed = clawed back or payer rejected. */
  earnEvents: new Map<string, { closed: boolean }>(),
  /** treasury_wallets ids with purpose 'earned-backing'. */
  custody: new Set<string>(),
  /** The avatar id locked by the most recent FOR-UPDATE select in this tx. */
  lockedId: null as string | null,
};

function resetStore(): void {
  store.avatars.clear();
  store.ledger = [];
  store.earnedLots = [];
  store.earnedAccounted.clear();
  store.backings.clear();
  store.consumptions = [];
  store.earnEvents.clear();
  store.custody.clear();
  store.lockedId = null;
}

/** The DB CHECK `earned_backing_conservation`, enforced on every fake write. */
function assertBackingConservation(b: BackingRow): void {
  if (b.remaining < 0n || b.consumed < 0n || b.released < 0n
    || b.original !== b.remaining + b.consumed + b.released) {
    throw new Error('earned_backing_conservation violated by stubbed UPDATE');
  }
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
  // Post-E2, an EARNED aggregate without matching fungibility lots is invalid.
  // Directly-seeded F1 fixtures therefore receive one synthetic unbacked lot;
  // mintEarned tests create their lot through the real helper instead.
  if (earned > 0) {
    store.earnedLots.push({
      id: `seed-lot-${id}`,
      ledgerId: `seed-ledger-${id}`,
      avatarId: id,
      backing_kind: 'none',
      remaining_vclaw: earned,
      created: store.earnedLots.length,
      original_vclaw: earned,
      released: false,
      earn_event_id: null,
      mint_ref: `seed:${id}`,
    });
  }
  return row;
}

// Render enough of a Drizzle SQL template to distinguish the E2 cutover queries
// without coupling the harness to queryChunks' exact nesting.
function renderSql(q: unknown): { text: string; params: unknown[] } {
  const out = { text: '', params: [] as unknown[] };
  const walk = (node: unknown): void => {
    for (const chunk of (node as { queryChunks?: unknown[] })?.queryChunks ?? []) {
      const name = (chunk as { constructor?: { name?: string } })?.constructor?.name;
      if (name === 'StringChunk') {
        const value = (chunk as { value: unknown }).value;
        out.text += Array.isArray(value) ? value.join('') : String(value);
      } else if (name === 'SQL') {
        walk(chunk);
      } else if (name === 'Param') {
        out.params.push((chunk as { value: unknown }).value);
        out.text += '?';
      } else if (name === 'String' || name === 'Number' || name === 'BigInt') {
        out.params.push((chunk as { valueOf(): unknown }).valueOf());
        out.text += '?';
      }
    }
  };
  walk(q);
  return out;
}

// ── Fake tx implementing exactly the surface the ledger calls ──────────────────
function makeTx() {
  return {
    async execute(q: unknown) {
      const { text, params } = renderSql(q);
      const avatarId = params.length > 0 ? String(params[0]) : null;

      // ── restoreEarnedSpendForRefund (matched before the generic handlers) ──
      if (text.includes('AS accounted_kind')) {
        const [debitId, ownerId] = params.map(String);
        const row = store.ledger.find((r) => r.id === debitId && r.avatarId === ownerId
          && r.provenance === 'earned' && r.amount < 0);
        return row
          ? [{ id: row.id, amount: -row.amount, accounted_kind: store.earnedAccounted.get(row.id) ?? null }]
          : [];
      }
      if (text.includes("metadata->>'refundOfLedgerId'")) {
        const [ownerId, debitId] = params.map(String);
        return store.ledger
          .filter((r) => r.avatarId === ownerId && r.provenance === 'earned' && r.amount > 0
            && r.metadata.refundOfLedgerId === debitId)
          .slice(0, 1)
          .map((r) => ({ id: r.id }));
      }
      if (text.includes('FROM earned_lot_consumptions c')) {
        const debitId = String(params[0]);
        return store.consumptions
          .filter((c) => c.ledgerDebitId === debitId)
          .map((c) => ({ c, lot: store.earnedLots.find((l) => l.id === c.mintLotId)! }))
          .sort((x, y) => x.lot.created - y.lot.created)
          .map(({ c, lot }) => {
            const backing = store.backings.get(lot.id);
            return {
              consumption_kind: c.kind,
              vclaw_amount: c.vclawAmount,
              usdc_atomic: c.usdcAtomic,
              lot_id: lot.id,
              lot_avatar_id: lot.avatarId,
              backing_kind: lot.backing_kind,
              lot_released: lot.released,
              event_closed: lot.earn_event_id ? (store.earnEvents.get(lot.earn_event_id)?.closed ?? false) : false,
              backing_id: backing ? `backing-${lot.id}` : null,
              backing_released: backing ? backing.released.toString() : null,
            };
          });
      }
      if (text.includes('UPDATE earned_mint_lots')
        && text.includes('remaining_vclaw = remaining_vclaw +')) {
        const units = Number(params[0]);
        const lot = store.earnedLots.find((row) => row.id === String(params[1]));
        if (!lot || lot.released || lot.remaining_vclaw + units > lot.original_vclaw) return [];
        lot.remaining_vclaw += units;
        return [{ id: lot.id }];
      }
      if (text.includes('UPDATE earned_backing')
        && text.includes('remaining_usdc_atomic = remaining_usdc_atomic +')) {
        const atomic = BigInt(String(params[0]));
        const backing = store.backings.get(String(params[2]));
        if (!backing || backing.released < atomic) return [];
        backing.remaining += atomic;
        backing.released -= atomic;
        assertBackingConservation(backing);
        return [{ id: `backing-${backing.mintLotId}` }];
      }
      // ── consumeEarnedLots backed-lot spend / redemption ──
      if (text.includes('UPDATE earned_backing')
        && text.includes('remaining_usdc_atomic = remaining_usdc_atomic -')) {
        const atomic = BigInt(String(params[0]));
        const kind = String(params[1]);
        const backing = store.backings.get(String(params[5]));
        if (!backing || backing.remaining < atomic) return [];
        backing.remaining -= atomic;
        if (kind === 'redemption') backing.consumed += atomic;
        else backing.released += atomic;
        assertBackingConservation(backing);
        return [{ id: `backing-${backing.mintLotId}` }];
      }
      if (text.includes('FROM treasury_wallets')) {
        return store.custody.has(String(params[0])) ? [{ id: String(params[0]) }] : [];
      }

      if (text.includes('SELECT earned_balance FROM avatars')) {
        if (!avatarId) throw new Error('execute: missing avatarId for EARNED reconciliation');
        store.lockedId = avatarId;
        const row = store.avatars.get(avatarId);
        return row ? [{ earned_balance: row.earned_balance }] : [];
      }
      if (text.includes('FROM avatars WHERE id =') && text.includes('FOR UPDATE')) {
        if (!avatarId) throw new Error('execute: missing avatarId for balance lock');
        store.lockedId = avatarId;
        const row = store.avatars.get(avatarId);
        return row ? [row] : [];
      }
      if (text.includes('FROM claw_token_transactions t') && text.includes('t.amount < 0')) {
        return store.ledger
          .filter((row) => row.avatarId === avatarId && row.provenance === 'earned'
            && row.amount < 0 && !store.earnedAccounted.has(row.id))
          .map((row) => ({ id: row.id, amount: -row.amount }));
      }
      if (text.includes('FROM claw_token_transactions t') && text.includes('t.amount > 0')) {
        return store.ledger
          .filter((row) => row.avatarId === avatarId && row.provenance === 'earned'
            && row.amount > 0 && !store.earnedAccounted.has(row.id))
          .map((row) => ({ id: row.id, amount: row.amount }));
      }
      if (text.includes('COALESCE(SUM(remaining_vclaw)')) {
        const amount = store.earnedLots
          .filter((lot) => lot.avatarId === avatarId)
          .reduce((sum, lot) => sum + lot.remaining_vclaw, 0);
        return [{ amount: String(amount) }];
      }
      if (text.includes('FROM earned_mint_lots l') && text.includes('FOR UPDATE OF l')) {
        // Same order as the real spend: unbacked first, then backed, then age.
        return store.earnedLots
          .filter((lot) => lot.avatarId === avatarId && lot.remaining_vclaw > 0)
          .sort((a, b) => (a.backing_kind === b.backing_kind
            ? a.created - b.created
            : a.backing_kind === 'none' ? -1 : 1))
          .map((lot) => ({
            id: lot.id,
            backing_kind: lot.backing_kind,
            remaining_vclaw: lot.remaining_vclaw,
          }));
      }
      if (text.includes('UPDATE earned_mint_lots')
        && text.includes('remaining_vclaw = remaining_vclaw -')) {
        const requested = Number(params[0]);
        const lot = store.earnedLots.find((row) => row.id === String(params[2]));
        if (!lot || lot.remaining_vclaw < requested) return [];
        lot.remaining_vclaw -= requested;
        return [{ id: lot.id }];
      }
      if (text.includes('INSERT INTO earned_mint_lots')) {
        const ledgerId = String(params[0]);
        const targetAvatarId = String(params[1]);
        store.earnedLots.push({
          id: `cutover-lot-${ledgerId}`,
          ledgerId,
          avatarId: targetAvatarId,
          backing_kind: 'none',
          remaining_vclaw: Number(params[4]),
          created: store.earnedLots.length,
          original_vclaw: Number(params[3]),
          released: false,
          earn_event_id: null,
          mint_ref: String(params[2]),
        });
        return [];
      }
      throw new Error(`unhandled ledger SQL: ${text.replace(/\s+/g, ' ').trim()}`);
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
    insert(table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          const id = randomUUID();
          if (table === realDatabase.clawTokenTransactions) {
            store.ledger.push({
              id,
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
          } else if (table === realDatabase.earnedMintLots) {
            const mintRef = String(v.mintRef);
            // UNIQUE earned_mint_lots_ref_unique / earned_mint_lots_ledger_unique.
            if (store.earnedLots.some((l) => l.mint_ref === mintRef || l.ledgerId === String(v.ledgerId))) {
              throw new Error('duplicate key value violates unique constraint on earned_mint_lots');
            }
            store.earnedLots.push({
              id,
              ledgerId: String(v.ledgerId),
              avatarId: String(v.avatarId),
              backing_kind: v.backingKind as 'backed' | 'none',
              remaining_vclaw: Number(v.remainingVclaw),
              created: store.earnedLots.length,
              original_vclaw: Number(v.originalVclaw),
              released: false,
              earn_event_id: (v.earnEventId as string | null) ?? null,
              mint_ref: mintRef,
            });
          } else if (table === realDatabase.earnedBackings) {
            const original = BigInt(String(v.originalUsdcAtomic));
            store.backings.set(String(v.mintLotId), {
              mintLotId: String(v.mintLotId),
              original,
              remaining: BigInt(String(v.remainingUsdcAtomic)),
              consumed: BigInt(String(v.consumedUsdcAtomic)),
              released: BigInt(String(v.releasedUsdcAtomic)),
            });
          } else if (table === realDatabase.earnedLotConsumptions) {
            store.consumptions.push({
              mintLotId: String(v.mintLotId),
              ledgerDebitId: String(v.ledgerDebitId),
              kind: String(v.kind),
              vclawAmount: Number(v.vclawAmount),
              usdcAtomic: String(v.usdcAtomic),
            });
          } else if (table === realDatabase.earnedAccountedLedger) {
            // PRIMARY KEY ledger_id; the ledger only re-inserts via onConflictDoNothing.
            const ledgerId = String(v.ledgerId);
            if (!store.earnedAccounted.has(ledgerId)) store.earnedAccounted.set(ledgerId, String(v.kind));
          }
          return {
            async returning(_cols: unknown) {
              return [{ id }];
            },
            async onConflictDoNothing() {},
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
  restoreEarnedSpendForRefund,
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

  // ── Tokenomics F2 — the on-ramp BOUGHT credit stamps a usd_basis ───────────────
  it("a BOUGHT credit stamps usd_basis = the dollars paid (the V-Bucks revenue record)", async () => {
    const a = seedAvatar({ claw_tokens: 0, soft_balance: 0 });
    // $10 buys 100 vCLAW at the F2 store price ($0.10/coin); the on-ramp passes the
    // dollars paid as the usd_basis.
    await creditClawTokens({
      avatarId: a.id,
      amount: 100,
      reason: 'topup_usdc',
      source: 'x402',
      provenance: 'bought',
      usdBasis: '10.00',
    });
    const last = ledgerFor(a.id).at(-1)!;
    expect(last.provenance).toBe('bought');
    expect(last.usdBasis).toBe('10.00');
    expect(getAvatar(a.id).bought_balance).toBe(100);
  });

  it("a SOFT credit REFUSES a usd_basis (only BOUGHT carries dollars; SOFT is play money)", async () => {
    const a = seedAvatar({ claw_tokens: 0, soft_balance: 0 });
    await expect(
      creditClawTokens({
        avatarId: a.id,
        amount: 50,
        reason: 'quest',
        source: 'quest',
        // no provenance ⇒ defaults to SOFT; a usd_basis here is a misuse.
        usdBasis: '5.00',
      }),
    ).rejects.toThrow(/usdBasis is only valid for a 'bought' credit/);
    // The credit was rejected BEFORE any write — balance unchanged.
    expect(getAvatar(a.id).soft_balance).toBe(0);
  });
});

describe('claw-token-ledger F1 — mintEarned chokepoint', () => {
  it('mintEarned is the ONLY writer of new EARNED; the refund-only restore needs a prior EARNED debit', async () => {
    const a = seedAvatar({ claw_tokens: 1000, soft_balance: 1000 });
    const b = seedAvatar({ claw_tokens: 0, soft_balance: 0 });

    // Exercise EVERY other exported writer — none may produce an earned row.
    await creditClawTokens({ avatarId: a.id, amount: 10, reason: 'soft', source: 'quest' });
    await creditClawTokens({
      avatarId: a.id, amount: 10, reason: 'bought', source: 'x402', provenance: 'bought',
    });
    const softDebit = await debitClawTokens({ avatarId: a.id, amount: 5, reason: 'sink', source: 'api' });
    await transferClawTokens({
      fromAvatarId: a.id, toAvatarId: b.id, amount: 20, reason: 'peer', source: 'exchange',
    });
    // The refund-only restore refuses a SOFT debit row and an unknown row id:
    // it can only give back EARNED that an EARNED debit row took.
    for (const originalDebitLedgerId of [softDebit.ledgerId, randomUUID()]) {
      await expect(
        fakeDb.transaction((tx) => restoreEarnedSpendForRefund(
          { avatarId: a.id, originalDebitLedgerId, reason: 'refund' },
          tx as never,
        )),
      ).rejects.toThrow(/no EARNED debit row/);
    }
    expect(earnedRows().length).toBe(0);
    expect(getAvatar(a.id).earned_balance).toBe(0);
    expect(getAvatar(b.id).earned_balance).toBe(0);

    // Only mintEarned writes earned.
    const res = await mintEarned({
      avatarId: b.id, amount: 75, reason: 'agent_labor', source: 'x402', usdBasis: '75.000000',
      backing: { kind: 'none', mintRef: `test:${b.id}:only-writer`, reason: 'unit_test' },
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
      backing: { kind: 'none', mintRef: `test:${a.id}:hashes`, reason: 'unit_test' },
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
      mintEarned({
        avatarId: a.id, amount: 10, reason: 'x', source: 'x402', usdBasis: '',
        backing: { kind: 'none', mintRef: `test:${a.id}:empty`, reason: 'unit_test' },
      }),
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
      () => mintEarned({
        avatarId: a.id, amount: 25, reason: 'e', source: 'x402', usdBasis: '25.000000',
        backing: { kind: 'none', mintRef: `test:${a.id}:sum`, reason: 'unit_test' },
      }),
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

  it('soft_balance DEFAULT mirrors claw_tokens DEFAULT (both 1000 after the A3 ¢-peg ×10)', () => {
    // A3 (2026-07-07) redenomination bumped BOTH starting-balance defaults 100→1000
    // (migration 0011) so a new account keeps the same $10 value at the $0.01 peg.
    // The mirror property (the reason this test exists) is unchanged — both defaults
    // must stay EQUAL or every default-relying INSERT trips the sum CHECK.
    expect(colDefault('clawTokens')).toBe(1000);
    expect(colDefault('softBalance')).toBe(1000);
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

describe('claw-token-ledger T0 — fee routing conservation (debit player + credit treasury in ONE tx)', () => {
  // T0 routes every silent-burn fee as `debitClawTokens(player, price, tx)` +
  // `creditClawTokens(treasury, price, tx)` COMPOSED into one transaction (shop
  // shape), or `creditClawTokens(treasury, rake, tx)` alongside the raked payout
  // (cove shape). This proves the composed shape at the ledger layer:
  //   - total supply is CONSERVED on a purchase (player -P, treasury +P),
  //   - the treasury credit lands SOFT (fees are SOFT; never bought/earned),
  //   - both legs write audit rows against the SAME tx.
  it('purchase shape: player -P / treasury +P conserves supply; treasury credit is SOFT', async () => {
    const player = seedAvatar({ claw_tokens: 500, soft_balance: 500 });
    const treasury = seedAvatar({ claw_tokens: 0, soft_balance: 0 }); // pure sink starts at 0
    const P = 120;

    await fakeDb.transaction(async (tx) => {
      await debitClawTokens(
        { avatarId: player.id, amount: P, reason: 'buy_cosmetic', source: 'api' },
        tx as never,
      );
      await creditClawTokens(
        { avatarId: treasury.id, amount: P, reason: 'house_fee_cosmetic_purchase', source: 'system' },
        tx as never,
      );
    });

    const p = getAvatar(player.id);
    const t = getAvatar(treasury.id);
    expect(p.claw_tokens).toBe(380); // player-side amount exactly as before T0
    expect(t.claw_tokens).toBe(120); // the fee LANDS instead of burning
    expect(p.claw_tokens + t.claw_tokens).toBe(500); // supply conserved
    // Treasury revenue is SOFT (T0 invariant — bought/earned stay 0).
    expect(t.soft_balance).toBe(120);
    expect(t.bought_balance).toBe(0);
    expect(t.earned_balance).toBe(0);
    // Both legs audited: one debit row on the player, one credit on the treasury.
    const treasuryRows = ledgerFor(treasury.id);
    expect(treasuryRows.length).toBe(1);
    expect(treasuryRows[0]!.reason).toBe('house_fee_cosmetic_purchase');
    expect(treasuryRows[0]!.amount).toBe(P);
    expect(treasuryRows[0]!.provenance).toBe('soft');
    expect(ledgerFor(player.id).at(-1)!.amount).toBe(-P);
  });

  it('rake shape: crediting the treasury the withheld rake never touches the player', async () => {
    const player = seedAvatar({ claw_tokens: 1000, soft_balance: 1000 });
    const treasury = seedAvatar({ claw_tokens: 0, soft_balance: 0 });
    // Blackjack-style: player is credited the RAKED payout; the rake goes to the
    // treasury in the same tx. Player-side number is the raked figure, unchanged.
    const rakedPayout = 95;
    const rake = 5;

    await fakeDb.transaction(async (tx) => {
      await creditClawTokens(
        { avatarId: player.id, amount: rakedPayout, reason: 'cove_blackjack_payout', source: 'api' },
        tx as never,
      );
      await creditClawTokens(
        { avatarId: treasury.id, amount: rake, reason: 'house_fee_blackjack_rake', source: 'system' },
        tx as never,
      );
    });

    expect(getAvatar(player.id).claw_tokens).toBe(1095); // exactly the raked payout
    expect(getAvatar(treasury.id).claw_tokens).toBe(rake);
    expect(ledgerFor(treasury.id)[0]!.provenance).toBe('soft');
  });
});

describe('claw-token-ledger — restoreEarnedSpendForRefund (refund-only EARNED restore, security pass 2026-10-04)', () => {
  const CUSTODY = 'earned-backing-custody';

  /** A backed EARNED mint through the REAL mintEarned (lot + backing row). */
  async function mintBacked(avatarId: string, amount: number): Promise<EarnedLotRow> {
    const eventId = randomUUID();
    store.custody.add(CUSTODY);
    store.earnEvents.set(eventId, { closed: false });
    await mintEarned({
      avatarId,
      amount,
      reason: 'earn',
      source: 'x402',
      usdBasis: (amount / 100).toFixed(6),
      backing: {
        kind: 'backed',
        mintRef: `earn:${eventId}`,
        earnEventId: eventId,
        custodyWalletId: CUSTODY,
        sourceRef: `settlement:${eventId}`,
        usdcAtomic: String(amount * 10_000),
      },
    });
    return store.earnedLots.find((l) => l.earn_event_id === eventId)!;
  }

  async function mintNone(avatarId: string, amount: number): Promise<EarnedLotRow> {
    const mintRef = `agent-pay:${randomUUID()}`;
    await mintEarned({
      avatarId, amount, reason: 'agent_pay', source: 'x402', usdBasis: '0',
      backing: { kind: 'none', mintRef, reason: 'unit_test' },
    });
    return store.earnedLots.find((l) => l.mint_ref === mintRef)!;
  }

  /** An ordinary entry-fee spend; returns its EARNED debit row. */
  async function spend(avatarId: string, amount: number): Promise<LedgerRow> {
    await debitClawTokens({ avatarId, amount, reason: 'special_event_entry', source: 'api' });
    return ledgerFor(avatarId).filter((r) => r.provenance === 'earned' && r.amount < 0).at(-1)!;
  }

  function restore(avatarId: string, debitId: string) {
    return fakeDb.transaction((tx) => restoreEarnedSpendForRefund(
      {
        avatarId,
        originalDebitLedgerId: debitId,
        reason: 'special_event_entry_refund',
        source: 'simulation',
        metadata: { signupId: 'signup-1' },
        actorKind: 'admin',
      },
      tx as never,
    ));
  }

  const lotsOf = (avatarId: string) => store.earnedLots.filter((l) => l.avatarId === avatarId);
  const lotSum = (avatarId: string) => lotsOf(avatarId).reduce((n, l) => n + l.remaining_vclaw, 0);

  it('a backed lot gets its units AND its released backing back: same lot, still cash-out eligible', async () => {
    const a = seedAvatar({});
    const lot = await mintBacked(a.id, 100);
    const debit = await spend(a.id, 40);
    expect(lot.remaining_vclaw).toBe(60);
    expect(store.backings.get(lot.id)).toMatchObject({ remaining: 600_000n, released: 400_000n });

    const res = await restore(a.id, debit.id);

    expect(res).toMatchObject({ amount: 40, restoredToLots: 40, restoredAsNone: 0 });
    // Same lot, same backing kind, same earn event: no new lot was created.
    expect(lotsOf(a.id)).toHaveLength(1);
    expect(lot).toMatchObject({ backing_kind: 'backed', remaining_vclaw: 100, released: false });
    // Backing is whole again and still matches remaining_vclaw * 10,000 (the
    // earned-solvency integrity rule the redemption rail checks).
    const backing = store.backings.get(lot.id)!;
    expect(backing).toMatchObject({ original: 1_000_000n, remaining: 1_000_000n, consumed: 0n, released: 0n });
    expect(backing.remaining).toBe(BigInt(lot.remaining_vclaw) * 10_000n);
    // ONE EARNED credit, tied to the original debit, no new dollars.
    const credit = ledgerFor(a.id).at(-1)!;
    expect(credit).toMatchObject({
      id: res.ledgerId,
      amount: 40,
      provenance: 'earned',
      usdBasis: '0',
      reason: 'special_event_entry_refund',
      source: 'simulation',
    });
    expect(credit.metadata).toMatchObject({
      signupId: 'signup-1',
      refundOfLedgerId: debit.id,
      earnedRestore: { restoredToLots: 40, restoredAsNone: 0 },
    });
    expect(store.earnedAccounted.get(res.ledgerId)).toBe('mint');
    expect(getAvatar(a.id)).toMatchObject({ earned_balance: 100, claw_tokens: 100 });
    expect(lotSum(a.id)).toBe(100);
  });

  it('an unbacked lot gets its units back unchanged (spendable, never cashable)', async () => {
    const a = seedAvatar({});
    const lot = await mintNone(a.id, 100);
    const debit = await spend(a.id, 30);
    const res = await restore(a.id, debit.id);
    expect(res).toMatchObject({ amount: 30, restoredToLots: 30, restoredAsNone: 0 });
    expect(lotsOf(a.id)).toHaveLength(1);
    expect(lot).toMatchObject({ backing_kind: 'none', remaining_vclaw: 100 });
    expect(store.backings.size).toBe(0);
    expect(getAvatar(a.id).earned_balance).toBe(100);
  });

  it('mixed lots: each part goes back to the lot it came from', async () => {
    const a = seedAvatar({});
    const unbacked = await mintNone(a.id, 30);
    const backed = await mintBacked(a.id, 70);
    // Spend order is unbacked first: 30 from the none lot, 20 from the backed lot.
    const debit = await spend(a.id, 50);
    expect([unbacked.remaining_vclaw, backed.remaining_vclaw]).toEqual([0, 50]);

    const res = await restore(a.id, debit.id);
    expect(res).toMatchObject({ amount: 50, restoredToLots: 50, restoredAsNone: 0 });
    expect([unbacked.remaining_vclaw, backed.remaining_vclaw]).toEqual([30, 70]);
    expect(store.backings.get(backed.id)).toMatchObject({ remaining: 700_000n, released: 0n });
    expect(lotsOf(a.id)).toHaveLength(2);
    expect(getAvatar(a.id).earned_balance).toBe(100);
  });

  it('units of a lot released since the spend (admin claw-back) return as ONE new none lot: no new cashability', async () => {
    const a = seedAvatar({});
    const lot = await mintBacked(a.id, 100);
    const debit = await spend(a.id, 40);
    // Model clawBackEarnedMint: the 60 still on the lot are debited, the lot is
    // released, its backing remainder moves to released, the event is closed.
    const backing = store.backings.get(lot.id)!;
    backing.released += backing.remaining;
    backing.remaining = 0n;
    lot.remaining_vclaw = 0;
    lot.released = true;
    store.earnEvents.set(lot.earn_event_id!, { closed: true });
    const av = getAvatar(a.id);
    store.avatars.set(a.id, { ...av, claw_tokens: av.claw_tokens - 60, earned_balance: av.earned_balance - 60 });

    const res = await restore(a.id, debit.id);

    expect(res).toMatchObject({ amount: 40, restoredToLots: 0, restoredAsNone: 40 });
    expect(lot).toMatchObject({ remaining_vclaw: 0, released: true });
    expect(store.backings.get(lot.id)).toMatchObject({ remaining: 0n, released: 1_000_000n });
    const fresh = lotsOf(a.id).filter((l) => l.id !== lot.id);
    expect(fresh).toEqual([
      expect.objectContaining({
        backing_kind: 'none',
        original_vclaw: 40,
        remaining_vclaw: 40,
        ledgerId: res.ledgerId,
        mint_ref: `earned-refund:${debit.id}`,
        earn_event_id: null,
      }),
    ]);
    expect(getAvatar(a.id).earned_balance).toBe(40);
    expect(lotSum(a.id)).toBe(40);
  });

  it('a legacy debit row (no lot attribution, accounted legacy) restores wholly as one none lot', async () => {
    const a = seedAvatar({ earned_balance: 50 });
    const legacyDebitId = randomUUID();
    store.ledger.push({
      id: legacyDebitId, avatarId: a.id, userId: a.user_id, amount: -10, balanceAfter: 50,
      reason: 'old_spend', source: 'api', provenance: 'earned', usdBasis: null,
      fpHash: null, ipPrefixHash: null, metadata: {},
    });
    store.earnedAccounted.set(legacyDebitId, 'legacy');

    const res = await restore(a.id, legacyDebitId);
    expect(res).toMatchObject({ amount: 10, restoredToLots: 0, restoredAsNone: 10 });
    expect(getAvatar(a.id).earned_balance).toBe(60);
    expect(lotSum(a.id)).toBe(60);
  });

  it('no double restore: a second restore of the same debit row is refused and moves nothing', async () => {
    const a = seedAvatar({});
    const lot = await mintBacked(a.id, 100);
    const debit = await spend(a.id, 40);
    await restore(a.id, debit.id);
    const balancesAfterFirst = { ...getAvatar(a.id) };
    const ledgerRows = store.ledger.length;

    await expect(restore(a.id, debit.id)).rejects.toThrow(/debit row already restored/);
    expect(getAvatar(a.id)).toEqual(balancesAfterFirst);
    expect(store.ledger.length).toBe(ledgerRows);
    expect(lot.remaining_vclaw).toBe(100);
    expect(store.backings.get(lot.id)).toMatchObject({ remaining: 1_000_000n, released: 0n });
  });

  it('a restore never exceeds its debit: an over-attributed debit, another avatar and a non-spend row are refused', async () => {
    const a = seedAvatar({});
    const lot = await mintNone(a.id, 100);
    const debit = await spend(a.id, 40);
    const before = { ...getAvatar(a.id) };

    // One extra attributed unit: the restore would credit more than was spent.
    store.consumptions.push({
      mintLotId: lot.id, ledgerDebitId: debit.id, kind: 'spend', vclawAmount: 1, usdcAtomic: '0',
    });
    await expect(restore(a.id, debit.id)).rejects.toThrow(/does not match the debit row/);
    store.consumptions.pop();

    // Another avatar cannot restore this avatar's debit row.
    const other = seedAvatar({});
    await expect(restore(other.id, debit.id)).rejects.toThrow(/no EARNED debit row/);

    // A redemption / claw-back debit is not an ordinary spend.
    store.earnedAccounted.set(debit.id, 'clawback');
    await expect(restore(a.id, debit.id)).rejects.toThrow(/not an ordinary spend/);
    store.earnedAccounted.set(debit.id, 'spend');

    expect(getAvatar(a.id)).toEqual(before);
    expect(earnedRows().filter((r) => r.amount > 0 && r.metadata.refundOfLedgerId)).toHaveLength(0);

    // The valid restore credits exactly the debit amount, never more.
    const res = await restore(a.id, debit.id);
    expect(res.amount).toBe(40);
    expect(getAvatar(a.id).earned_balance).toBe(before.earned_balance + 40);
  });
});
