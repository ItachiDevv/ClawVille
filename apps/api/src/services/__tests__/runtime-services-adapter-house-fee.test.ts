import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { allActions } from '@clawville/agent-runtime';
import { KNOWLEDGE_BOOKS } from '@clawville/shared';
import * as realLedger from '../claw-token-ledger';
import * as realSeeder from '../house-treasury-seeder';

// Security batch 2 (2026-10-02): runtime BUY_ITEM used to only debit, so the
// book price BURNED, while the REST shop (`routes/items.ts` step 1b) routes it to
// the house treasury. `chargeBookPurchase` is the ONE service op that writes the
// buyer debit AND the REST-identical treasury credit inside the caller's tx; no
// standalone treasury-credit service exists, so runtime code cannot credit the
// treasury without the matching debit (Codex SHOULD-FIX). An invalid amount
// THROWS (Codex BLOCKING: a fractional price used to skip the credit silently).
// The real ledger and the treasury resolver are replaced by spies here.
const ledgerCalls: Array<{ fn: 'credit' | 'debit'; input: Record<string, unknown>; tx: unknown }> = [];
let failLedgerDebit = false;
mock.module('../claw-token-ledger', () => ({
  ...realLedger,
  creditClawTokens: async (input: Record<string, unknown>, tx?: unknown) => {
    ledgerCalls.push({ fn: 'credit', input, tx });
    return { balanceAfter: 1, ledgerId: 'l-credit' };
  },
  debitClawTokens: async (input: Record<string, unknown>, tx?: unknown) => {
    ledgerCalls.push({ fn: 'debit', input, tx });
    if (failLedgerDebit) throw new Error('Avatar has 0 ClawTokens, cannot debit');
    return { balanceAfter: 970, ledgerId: 'l-debit' };
  },
}));

let treasuryId: string | null = 'house-treasury-avatar';
let treasuryLookups = 0;
mock.module('../house-treasury-seeder', () => ({
  ...realSeeder,
  getHouseTreasuryAvatarId: async () => {
    treasuryLookups += 1;
    return treasuryId;
  },
}));

const { buildRuntimeServices } = await import('../runtime-services-adapter');

afterAll(() => {
  mock.module('../claw-token-ledger', () => realLedger);
  mock.module('../house-treasury-seeder', () => realSeeder);
});

const BOOK = KNOWLEDGE_BOOKS[0]!;

/** Fake db/tx: answers the adapter's users.is_guest lookup per avatar id. */
function fakeDb(guestByAvatar: Record<string, boolean>) {
  const lookups: string[] = [];
  return {
    lookups,
    execute: async (query: { queryChunks?: unknown[] }) => {
      const id = (query.queryChunks ?? []).find((chunk) => typeof chunk === 'string') as string;
      lookups.push(id);
      return id in guestByAvatar ? [{ is_guest: guestByAvatar[id] }] : [];
    },
  };
}

const charge = (avatarId: string, amount: unknown = BOOK.price, bookId = BOOK.id) =>
  ({ avatarId, bookId, amount }) as { avatarId: string; bookId: string; amount: number };

const expectedDebit = (actorKind: string | null) => ({
  avatarId: 'real-avatar',
  amount: BOOK.price,
  reason: `Purchased book: ${BOOK.name}`,
  // The runtime label 'shop' maps to the ledger enum value 'simulation'.
  source: 'simulation',
  metadata: { bookId: BOOK.id, buildingId: BOOK.building },
  actorKind,
});

const expectedTreasuryCredit = {
  avatarId: 'house-treasury-avatar',
  amount: BOOK.price,
  reason: 'house_fee_book_purchase',
  source: 'system',
  metadata: { bookId: BOOK.id, buyerAvatarId: 'real-avatar' },
  actorKind: 'system',
};

beforeEach(() => {
  ledgerCalls.length = 0;
  treasuryId = 'house-treasury-avatar';
  treasuryLookups = 0;
  failLedgerDebit = false;
});

describe('runtime services: BUY_ITEM chargeBookPurchase (security batch 2)', () => {
  test('every construction variant exposes the ONE charge op and NO standalone treasury credit', () => {
    const db = fakeDb({});
    for (const services of [
      buildRuntimeServices(db),
      buildRuntimeServices(db, { actorKind: 'human' }),
      buildRuntimeServices(db, { actorKind: 'agent' }),
      buildRuntimeServices(db, { actorKind: null, doordash: {} }),
    ]) {
      expect(typeof services.chargeBookPurchase).toBe('function');
      expect('creditHouseTreasuryBookFee' in services).toBe(false);
      // Pin the whole surface: a new credit-capable service must be a deliberate change.
      expect(Object.keys(services).sort()).toEqual(
        ['chargeBookPurchase', 'creditClawTokens', 'db', 'debitClawTokens', 'doordash', 'recordCovenantAction'].sort(),
      );
    }
  });

  test('writes exactly one buyer debit then one REST-identical treasury credit, both in the caller tx', async () => {
    const db = fakeDb({ 'real-avatar': false });
    const tx = fakeDb({ 'real-avatar': false });
    const services = buildRuntimeServices(db, { actorKind: 'human' });

    const result = await services.chargeBookPurchase!(charge('real-avatar'), tx);

    expect(result).toEqual({ balanceAfter: 970, treasuryAvatarId: 'house-treasury-avatar' });
    expect(ledgerCalls).toEqual([
      // The buyer debit keeps the surface's actor kind (the pre-batch-2 row).
      { fn: 'debit', input: expectedDebit('human'), tx },
      // The surface actor (human) must NOT leak onto the house fee row.
      { fn: 'credit', input: expectedTreasuryCredit, tx },
    ]);
    // The buyer's guest check runs on the tx connection, not the pool.
    expect(tx.lookups).toEqual(['real-avatar']);
    expect(db.lookups).toEqual([]);
  });

  test('the debit carries the agent surface attribution on an agent runtime', async () => {
    const tx = fakeDb({ 'real-avatar': false });
    await buildRuntimeServices(fakeDb({}), { actorKind: 'agent' }).chargeBookPurchase!(charge('real-avatar'), tx);
    expect(ledgerCalls.map((c) => c.input.actorKind)).toEqual(['agent', 'system']);
  });

  test('a null treasury burns the price with a loud log after the debit and never throws (pre-T0 fallback)', async () => {
    treasuryId = null;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const services = buildRuntimeServices(fakeDb({}), { actorKind: 'agent' });
      const tx = fakeDb({ 'real-avatar': false });
      const result = await services.chargeBookPurchase!(charge('real-avatar'), tx);

      expect(result).toEqual({ balanceAfter: 970, treasuryAvatarId: null });
      expect(ledgerCalls).toEqual([{ fn: 'debit', input: expectedDebit('agent'), tx }]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]![0])).toContain('house treasury unavailable');
      expect(String(errorSpy.mock.calls[0]![0])).toContain(BOOK.id);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('a guest buyer is refused before any debit, treasury lookup or credit', async () => {
    const services = buildRuntimeServices(fakeDb({}), { actorKind: 'agent' });
    await expect(
      services.chargeBookPurchase!(charge('guest-avatar'), fakeDb({ 'guest-avatar': true })),
    ).rejects.toThrow(/guest_demo_economy/);
    expect(treasuryLookups).toBe(0);
    expect(ledgerCalls).toHaveLength(0);
  });

  test('a failed debit (insufficient balance) never reaches the treasury', async () => {
    failLedgerDebit = true;
    const services = buildRuntimeServices(fakeDb({}), { actorKind: 'agent' });
    await expect(
      services.chargeBookPurchase!(charge('real-avatar'), fakeDb({ 'real-avatar': false })),
    ).rejects.toThrow(/cannot debit/);
    expect(ledgerCalls.map((c) => c.fn)).toEqual(['debit']);
    expect(treasuryLookups).toBe(0);
  });

  test('refuses to charge outside a transaction (a detached charge could survive a rolled-back grant)', async () => {
    const services = buildRuntimeServices(fakeDb({ 'real-avatar': false }), { actorKind: 'agent' });
    await expect(services.chargeBookPurchase!(charge('real-avatar'), undefined)).rejects.toThrow(
      /caller transaction/,
    );
    expect(treasuryLookups).toBe(0);
    expect(ledgerCalls).toHaveLength(0);
  });

  test('an invalid amount THROWS before any read or write (never a silent skip)', async () => {
    const services = buildRuntimeServices(fakeDb({}), { actorKind: 'agent' });
    for (const amount of [2.5, -5, 0, Number.NaN, '30', Number.MAX_SAFE_INTEGER + 2, Number.POSITIVE_INFINITY, null]) {
      const tx = fakeDb({ 'real-avatar': false });
      await expect(services.chargeBookPurchase!(charge('real-avatar', amount), tx)).rejects.toThrow(
        /invalid amount/,
      );
      expect(tx.lookups).toEqual([]);
    }
    expect(treasuryLookups).toBe(0);
    expect(ledgerCalls).toHaveLength(0);
  });

  test('an unknown book or an amount that is not the catalog price throws before any write', async () => {
    const services = buildRuntimeServices(fakeDb({}), { actorKind: 'agent' });
    const tx = fakeDb({ 'real-avatar': false });
    await expect(services.chargeBookPurchase!(charge('real-avatar', 10, 'no-such-book'), tx)).rejects.toThrow(
      /unknown book/,
    );
    await expect(services.chargeBookPurchase!(charge('real-avatar', BOOK.price + 1), tx)).rejects.toThrow(
      /not the catalog price/,
    );
    expect(tx.lookups).toEqual([]);
    expect(ledgerCalls).toHaveLength(0);
  });
});

// End to end through the REAL adapter: the BUY_ITEM action (built package) with
// services from buildRuntimeServices. The fake db rolls back the ledger rows the
// way Postgres does when the transaction callback throws.
describe('BUY_ITEM through the real adapter (security batch 2)', () => {
  const buyItem = allActions.find((a) => a.name === 'BUY_ITEM')!;

  function chunkText(query: { queryChunks?: unknown[] }): string {
    return (query.queryChunks ?? [])
      .map((c) => ((c as { value?: unknown }).value instanceof Array ? (c as { value: string[] }).value.join('') : ''))
      .join('');
  }

  function world(opts: { failGrant?: boolean } = {}) {
    const committed: typeof ledgerCalls = [];
    const grants: string[] = [];
    const tx = {
      execute: async (query: { queryChunks?: unknown[] }) => {
        const text = chunkText(query);
        if (text.includes('is_guest')) return [{ is_guest: false }];
        if (text.includes('avatar_inventory')) {
          if (opts.failGrant) throw new Error('inventory write failed');
          grants.push(text);
          return [];
        }
        throw new Error(`unexpected tx query: ${text}`);
      },
    };
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: () => ({ limit: async () => [{ clawTokens: 10_000, isGuest: false }] }) }),
        }),
      }),
      execute: async () => {
        throw new Error('a ledger read/write left the caller tx');
      },
      transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
        const start = ledgerCalls.length;
        try {
          const out = await fn(tx);
          committed.push(...ledgerCalls.slice(start));
          return out;
        } catch (err) {
          // ROLLBACK: nothing written inside the callback survives.
          ledgerCalls.length = start;
          grants.length = 0;
          throw err;
        }
      },
    };
    return { db, tx, committed, grants };
  }

  const message = { content: { text: `buy ${BOOK.name}`, parameters: { itemId: BOOK.id } } };

  test('one debit + one treasury credit + one grant commit together in the caller tx', async () => {
    const w = world();
    const result = await buyItem.handler(null, message, {
      avatarId: 'real-avatar',
      userId: 'real-user',
      services: buildRuntimeServices(w.db, { actorKind: 'agent' }),
    });

    expect(result.success).toBe(true);
    expect(w.committed).toEqual([
      { fn: 'debit', input: expectedDebit('agent'), tx: w.tx },
      { fn: 'credit', input: expectedTreasuryCredit, tx: w.tx },
    ]);
    expect(w.grants).toHaveLength(1);
  });

  test('a failed grant rolls back BOTH the debit and the treasury credit', async () => {
    const w = world({ failGrant: true });
    const result = await buyItem.handler(null, message, {
      avatarId: 'real-avatar',
      userId: 'real-user',
      services: buildRuntimeServices(w.db, { actorKind: 'agent' }),
    });

    expect(result.success).toBe(false);
    expect(w.committed).toEqual([]);
    expect(ledgerCalls).toEqual([]);
    expect(w.grants).toEqual([]);
  });
});
