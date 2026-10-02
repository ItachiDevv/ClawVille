import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as realLedger from '../claw-token-ledger';
import * as realSeeder from '../house-treasury-seeder';

// Security batch 2 (2026-10-02): runtime BUY_ITEM used to only debit, so the
// book price BURNED, while the REST shop (`routes/items.ts` step 1b) routes it to
// the house treasury. `creditHouseTreasuryBookFee` writes the SAME ledger row
// the REST shop writes, inside the buyer's debit tx. The real ledger and the
// treasury resolver are replaced by spies here.
const ledgerCalls: Array<{ fn: 'credit' | 'debit'; input: Record<string, unknown>; tx: unknown }> = [];
mock.module('../claw-token-ledger', () => ({
  ...realLedger,
  creditClawTokens: async (input: Record<string, unknown>, tx?: unknown) => {
    ledgerCalls.push({ fn: 'credit', input, tx });
    return { balanceAfter: 1, ledgerId: 'l-credit' };
  },
  debitClawTokens: async (input: Record<string, unknown>, tx?: unknown) => {
    ledgerCalls.push({ fn: 'debit', input, tx });
    return { balanceAfter: 0, ledgerId: 'l-debit' };
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

const fee = (buyerAvatarId: string, amount = 30) => ({ bookId: 'cron-automation-basics', buyerAvatarId, amount });

beforeEach(() => {
  ledgerCalls.length = 0;
  treasuryId = 'house-treasury-avatar';
  treasuryLookups = 0;
});

describe('runtime services: BUY_ITEM T0 house-fee routing (security batch 2)', () => {
  test('every construction variant exposes the treasury routing service', () => {
    const db = fakeDb({});
    for (const services of [
      buildRuntimeServices(db),
      buildRuntimeServices(db, { actorKind: 'human' }),
      buildRuntimeServices(db, { actorKind: 'agent' }),
      buildRuntimeServices(db, { actorKind: null, doordash: {} }),
    ]) {
      expect(typeof services.creditHouseTreasuryBookFee).toBe('function');
    }
  });

  test('credits the treasury with the exact REST ledger row, in the caller tx, attributed to system', async () => {
    const db = fakeDb({ 'real-avatar': false });
    const tx = fakeDb({ 'real-avatar': false });
    // The surface actor (human) must NOT leak onto the house fee row.
    const services = buildRuntimeServices(db, { actorKind: 'human' });

    const result = await services.creditHouseTreasuryBookFee!(fee('real-avatar'), tx);

    expect(result).toEqual({ treasuryAvatarId: 'house-treasury-avatar' });
    expect(ledgerCalls).toEqual([
      {
        fn: 'credit',
        input: {
          avatarId: 'house-treasury-avatar',
          amount: 30,
          reason: 'house_fee_book_purchase',
          source: 'system',
          metadata: { bookId: 'cron-automation-basics', buyerAvatarId: 'real-avatar' },
          actorKind: 'system',
        },
        tx,
      },
    ]);
    // The buyer's guest check runs on the tx connection, not the pool.
    expect(tx.lookups).toEqual(['real-avatar']);
    expect(db.lookups).toEqual([]);
  });

  test('a null treasury burns the fee with a loud log and never throws (pre-T0 fallback)', async () => {
    treasuryId = null;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const services = buildRuntimeServices(fakeDb({}), { actorKind: 'agent' });
      const result = await services.creditHouseTreasuryBookFee!(fee('real-avatar'), fakeDb({ 'real-avatar': false }));

      expect(result).toEqual({ treasuryAvatarId: null });
      expect(ledgerCalls).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]![0])).toContain('house treasury unavailable');
      expect(String(errorSpy.mock.calls[0]![0])).toContain('cron-automation-basics');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('a guest buyer is refused before the treasury is resolved or credited (demo money never reaches it)', async () => {
    const services = buildRuntimeServices(fakeDb({}), { actorKind: 'agent' });
    await expect(
      services.creditHouseTreasuryBookFee!(fee('guest-avatar'), fakeDb({ 'guest-avatar': true })),
    ).rejects.toThrow(/guest_demo_economy/);
    expect(treasuryLookups).toBe(0);
    expect(ledgerCalls).toHaveLength(0);
  });

  test('refuses to credit outside a transaction (a detached credit could survive a rolled-back debit)', async () => {
    const services = buildRuntimeServices(fakeDb({ 'real-avatar': false }), { actorKind: 'agent' });
    await expect(services.creditHouseTreasuryBookFee!(fee('real-avatar'), undefined)).rejects.toThrow(
      /buyer debit transaction/,
    );
    expect(treasuryLookups).toBe(0);
    expect(ledgerCalls).toHaveLength(0);
  });

  test('a non-positive or fractional amount credits nothing (mirrors the REST guard)', async () => {
    const services = buildRuntimeServices(fakeDb({}), { actorKind: 'agent' });
    for (const amount of [0, -5, 2.5]) {
      const result = await services.creditHouseTreasuryBookFee!(fee('real-avatar', amount), fakeDb({ 'real-avatar': false }));
      expect(result).toEqual({ treasuryAvatarId: null });
    }
    expect(ledgerCalls).toHaveLength(0);
  });
});
