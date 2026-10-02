import { describe, expect, it } from 'bun:test';
import { KNOWLEDGE_BOOKS } from '@clawville/shared';
import { buyItemAction } from './buy-item';
import type { ClawvilleServices } from './types';

const BOOK = KNOWLEDGE_BOOKS[0]!;

function render(query: { queryChunks?: unknown[] }): string {
  return (query.queryChunks ?? [])
    .map((c) => ((c as { value?: unknown }).value instanceof Array ? (c as { value: string[] }).value.join('') : '?'))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fake drizzle db with a transaction that ROLLS BACK the fake balance, the
 * treasury balance and the inventory when the callback throws, the way Postgres
 * does. The actor select resolves `actor`; raw SQL on the tx is recorded, and
 * `order` records the money/grant writes in call order. `chargeBookPurchase`
 * models the adapter's ONE charge op: guard the amount, debit the buyer, credit
 * the treasury (or burn when the treasury is unavailable).
 */
function harness(
  actor: { clawTokens: number; isGuest: boolean } | null,
  opts: { failGrant?: boolean; failDebit?: boolean; treasuryUnavailable?: boolean; noChargeService?: boolean } = {},
) {
  const state = { balance: actor?.clawTokens ?? 0, treasury: 0, books: 0 };
  const executed: string[] = [];
  const order: string[] = [];
  const charges: Array<{ params: unknown; tx: unknown }> = [];
  const genericLedgerCalls: unknown[] = [];
  let actorReads = 0;
  const tx = {
    execute: async (query: { queryChunks?: unknown[] }) => {
      const text = render(query);
      executed.push(text);
      order.push('grant');
      if (opts.failGrant) throw new Error('inventory write failed');
      state.books += 1;
      return [];
    },
  };
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => {
              actorReads += 1;
              return actor ? [actor] : [];
            },
          }),
        }),
      }),
    }),
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      const snapshot = { ...state };
      try {
        return await fn(tx);
      } catch (err) {
        Object.assign(state, snapshot);
        throw err;
      }
    },
  };
  const services: ClawvilleServices = {
    db,
    // BUY_ITEM must never use the generic ledger services: the charge op owns
    // both rows.
    debitClawTokens: async (params) => {
      genericLedgerCalls.push(params);
      return { balanceAfter: 0 };
    },
    creditClawTokens: async (params) => {
      genericLedgerCalls.push(params);
      return { balanceAfter: 0 };
    },
    chargeBookPurchase: opts.noChargeService
      ? undefined
      : async (params, t) => {
          charges.push({ params, tx: t });
          if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
            throw new Error('book_purchase_charge: invalid amount');
          }
          order.push('debit');
          if (opts.failDebit) throw new Error('Avatar has 0 ClawTokens, cannot debit');
          state.balance -= params.amount;
          order.push('treasury');
          // The adapter's null-treasury fallback: nothing is credited (burn).
          if (!opts.treasuryUnavailable) state.treasury += params.amount;
          return {
            balanceAfter: state.balance,
            treasuryAvatarId: opts.treasuryUnavailable ? null : 'house-treasury-avatar',
          };
        },
  };
  return {
    services,
    executed,
    order,
    charges,
    genericLedgerCalls,
    state,
    tx,
    get actorReads() {
      return actorReads;
    },
  };
}

const message = { content: { text: `buy ${BOOK.name}`, parameters: { itemId: BOOK.id } } };

const run = (h: ReturnType<typeof harness>, avatarId = 'real-avatar') =>
  buyItemAction.handler(null, message, { avatarId, userId: `${avatarId}-user`, services: h.services });

/** Temporarily replace the catalog book's price (the action reads the shared catalog object). */
async function withPrice<T>(price: unknown, fn: () => Promise<T>): Promise<T> {
  const original = BOOK.price;
  (BOOK as { price: unknown }).price = price;
  try {
    return await fn();
  } finally {
    (BOOK as { price: unknown }).price = original;
  }
}

describe('BUY_ITEM runtime action', () => {
  it('refuses a guest-owned avatar before any ledger call (security M9)', async () => {
    const h = harness({ clawTokens: 100, isGuest: true });
    const result = await run(h, 'guest-avatar');

    expect(result.success).toBe(false);
    expect(result.text).toContain('demo economy');
    expect(h.charges).toHaveLength(0);
    expect(h.genericLedgerCalls).toHaveLength(0);
    expect(h.executed).toHaveLength(0);
  });

  it('charges and grants inside ONE transaction, the grant being one upsert (M10 + Codex round 2)', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false });
    const result = await run(h);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({ price: BOOK.price, balanceAfter: 10_000 - BOOK.price }));
    expect(h.charges).toHaveLength(1);
    expect(h.charges[0]!.tx).toBe(h.tx);
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0]).toContain('ON CONFLICT (avatar_id, item_id) DO UPDATE SET quantity = inventory.quantity + 1');
    expect(h.state).toEqual({ balance: 10_000 - BOOK.price, treasury: BOOK.price, books: 1 });
  });

  it('routes the exact price through the ONE charge op in the SAME tx as the grant (T0, net-neutral supply)', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false });
    const result = await run(h);

    expect(result.success).toBe(true);
    expect(h.charges).toEqual([{ params: { avatarId: 'real-avatar', bookId: BOOK.id, amount: BOOK.price }, tx: h.tx }]);
    expect(h.order).toEqual(['debit', 'treasury', 'grant']);
    // Supply is conserved: what left the buyer arrived at the treasury.
    expect(h.state.balance + h.state.treasury).toBe(10_000);
    // The generic ledger services are never used for a book buy: no separate
    // debit, no refund, no standalone treasury credit.
    expect(h.genericLedgerCalls).toHaveLength(0);
  });

  it('a failed debit inside the charge credits nothing and grants nothing', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false }, { failDebit: true });
    const result = await run(h);

    expect(result.success).toBe(false);
    expect(h.executed).toHaveLength(0);
    expect(h.state).toEqual({ balance: 10_000, treasury: 0, books: 0 });
  });

  it('a failed grant rolls the debit AND the treasury credit back: no vCLAW minted or lost, no refund write needed', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false }, { failGrant: true });
    const result = await run(h);

    expect(result.success).toBe(false);
    expect(h.charges).toHaveLength(1);
    expect(h.charges[0]!.tx).toBe(h.tx);
    expect(h.order).toEqual(['debit', 'treasury', 'grant']);
    expect(h.state).toEqual({ balance: 10_000, treasury: 0, books: 0 });
    expect(h.genericLedgerCalls).toHaveLength(0);
  });

  it('an unavailable treasury burns the price (pre-T0 fallback) and the buyer still gets the book', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false }, { treasuryUnavailable: true });
    const result = await run(h);

    expect(result.success).toBe(true);
    expect(h.charges).toHaveLength(1);
    expect(h.state).toEqual({ balance: 10_000 - BOOK.price, treasury: 0, books: 1 });
  });

  it('refuses before any read or debit when the charge service is not wired (never a silent burn)', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false }, { noChargeService: true });
    const result = await run(h);

    expect(result.success).toBe(false);
    expect(h.actorReads).toBe(0);
    expect(h.genericLedgerCalls).toHaveLength(0);
    expect(h.executed).toHaveLength(0);
    expect(h.state).toEqual({ balance: 10_000, treasury: 0, books: 0 });
  });

  it('insufficient balance fails without a charge or a credit', async () => {
    const h = harness({ clawTokens: BOOK.price - 1, isGuest: false });
    const result = await run(h);

    expect(result.success).toBe(false);
    expect(result.text).toContain('Not enough vCLAW');
    expect(h.charges).toHaveLength(0);
    expect(h.state).toEqual({ balance: BOOK.price - 1, treasury: 0, books: 0 });
  });

  // Codex BLOCKING (security batch 2): a fractional price burned (the treasury
  // credit skipped it) and a string price passed the balance check by coercion.
  for (const [label, price] of [
    ['fractional', 2.5],
    ['negative', -5],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['numeric string', '5'],
    ['above MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2],
    ['Infinity', Number.POSITIVE_INFINITY],
  ] as const) {
    it(`refuses a ${label} price before any read, debit or credit`, async () => {
      const h = harness({ clawTokens: 10_000, isGuest: false });
      const result = await withPrice(price, () => run(h));

      expect(result.success).toBe(false);
      expect(result.text).toContain('no valid price');
      expect(h.actorReads).toBe(0);
      expect(h.charges).toHaveLength(0);
      expect(h.genericLedgerCalls).toHaveLength(0);
      expect(h.executed).toHaveLength(0);
      expect(h.state).toEqual({ balance: 10_000, treasury: 0, books: 0 });
    });
  }

  it('an unresolved avatar is refused', async () => {
    const h = harness(null);
    const result = await run(h, 'missing');
    expect(result.success).toBe(false);
    expect(h.charges).toHaveLength(0);
  });
});
