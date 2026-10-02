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
 * `order` records the money/grant writes in call order.
 */
function harness(
  actor: { clawTokens: number; isGuest: boolean } | null,
  opts: { failGrant?: boolean; failDebit?: boolean; treasuryUnavailable?: boolean; noTreasuryService?: boolean } = {},
) {
  const state = { balance: actor?.clawTokens ?? 0, treasury: 0, books: 0 };
  const executed: string[] = [];
  const order: string[] = [];
  const debits: Array<{ params: unknown; tx: unknown }> = [];
  const credits: unknown[] = [];
  const treasuryFees: Array<{ params: unknown; tx: unknown }> = [];
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
          where: () => ({ limit: async () => (actor ? [actor] : []) }),
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
    debitClawTokens: async (params, t) => {
      debits.push({ params, tx: t });
      order.push('debit');
      if (opts.failDebit) throw new Error('Avatar has 0 ClawTokens, cannot debit');
      state.balance -= params.amount;
      return { balanceAfter: state.balance };
    },
    creditClawTokens: async (params) => {
      credits.push(params);
      state.balance += params.amount;
      return { balanceAfter: state.balance };
    },
    creditHouseTreasuryBookFee: opts.noTreasuryService
      ? undefined
      : async (params, t) => {
          treasuryFees.push({ params, tx: t });
          order.push('treasury');
          // The adapter's null-treasury fallback: nothing is credited (burn).
          if (opts.treasuryUnavailable) return { treasuryAvatarId: null };
          state.treasury += params.amount;
          return { treasuryAvatarId: 'house-treasury-avatar' };
        },
  };
  return { services, executed, order, debits, credits, treasuryFees, state, tx };
}

const message = { content: { text: `buy ${BOOK.name}`, parameters: { itemId: BOOK.id } } };

describe('BUY_ITEM runtime action', () => {
  it('refuses a guest-owned avatar before any ledger call (security M9)', async () => {
    const h = harness({ clawTokens: 100, isGuest: true });
    const result = await buyItemAction.handler(null, message, {
      avatarId: 'guest-avatar',
      userId: 'guest-user',
      services: h.services,
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain('demo economy');
    expect(h.debits).toHaveLength(0);
    expect(h.credits).toHaveLength(0);
    expect(h.treasuryFees).toHaveLength(0);
    expect(h.executed).toHaveLength(0);
  });

  it('debits and grants inside ONE transaction, the grant being one upsert (M10 + Codex round 2)', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false });
    const result = await buyItemAction.handler(null, message, {
      avatarId: 'real-avatar',
      userId: 'real-user',
      services: h.services,
    });

    expect(result.success).toBe(true);
    expect(h.debits).toHaveLength(1);
    expect(h.debits[0]!.params).toEqual(expect.objectContaining({ avatarId: 'real-avatar', amount: BOOK.price }));
    expect(h.debits[0]!.tx).toBe(h.tx);
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0]).toContain('ON CONFLICT (avatar_id, item_id) DO UPDATE SET quantity = inventory.quantity + 1');
    expect(h.state).toEqual({ balance: 10_000 - BOOK.price, treasury: BOOK.price, books: 1 });
  });

  it('routes the exact price to the house treasury in the SAME tx as the debit (T0, net-neutral supply)', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false });
    const result = await buyItemAction.handler(null, message, {
      avatarId: 'real-avatar',
      userId: 'real-user',
      services: h.services,
    });

    expect(result.success).toBe(true);
    expect(h.treasuryFees).toHaveLength(1);
    expect(h.treasuryFees[0]!.params).toEqual({ bookId: BOOK.id, buyerAvatarId: 'real-avatar', amount: BOOK.price });
    expect(h.treasuryFees[0]!.tx).toBe(h.tx);
    expect(h.debits[0]!.tx).toBe(h.tx);
    expect(h.order).toEqual(['debit', 'treasury', 'grant']);
    // Supply is conserved: what left the buyer arrived at the treasury.
    expect(h.state.balance + h.state.treasury).toBe(10_000);
    // The buyer is never credited back.
    expect(h.credits).toHaveLength(0);
  });

  it('a failed debit credits nothing to the treasury', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false }, { failDebit: true });
    const result = await buyItemAction.handler(null, message, {
      avatarId: 'real-avatar',
      userId: 'real-user',
      services: h.services,
    });

    expect(result.success).toBe(false);
    expect(h.treasuryFees).toHaveLength(0);
    expect(h.executed).toHaveLength(0);
    expect(h.state).toEqual({ balance: 10_000, treasury: 0, books: 0 });
  });

  it('a failed grant rolls the debit AND the treasury credit back: no vCLAW minted or lost, no refund write needed', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false }, { failGrant: true });
    const result = await buyItemAction.handler(null, message, {
      avatarId: 'real-avatar',
      userId: 'real-user',
      services: h.services,
    });

    expect(result.success).toBe(false);
    expect(h.debits).toHaveLength(1);
    // The credit ran inside the tx, so the rollback reverses it with the debit.
    expect(h.treasuryFees).toHaveLength(1);
    expect(h.treasuryFees[0]!.tx).toBe(h.tx);
    expect(h.state).toEqual({ balance: 10_000, treasury: 0, books: 0 });
    expect(h.credits).toHaveLength(0);
  });

  it('an unavailable treasury burns the price (pre-T0 fallback) and the buyer still gets the book', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false }, { treasuryUnavailable: true });
    const result = await buyItemAction.handler(null, message, {
      avatarId: 'real-avatar',
      userId: 'real-user',
      services: h.services,
    });

    expect(result.success).toBe(true);
    expect(h.treasuryFees).toHaveLength(1);
    expect(h.state).toEqual({ balance: 10_000 - BOOK.price, treasury: 0, books: 1 });
  });

  it('refuses before any read or debit when the treasury routing service is not wired (never a silent burn)', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false }, { noTreasuryService: true });
    const result = await buyItemAction.handler(null, message, {
      avatarId: 'real-avatar',
      userId: 'real-user',
      services: h.services,
    });

    expect(result.success).toBe(false);
    expect(h.debits).toHaveLength(0);
    expect(h.executed).toHaveLength(0);
    expect(h.state).toEqual({ balance: 10_000, treasury: 0, books: 0 });
  });

  it('an unresolved avatar is refused', async () => {
    const h = harness(null);
    const result = await buyItemAction.handler(null, message, {
      avatarId: 'missing',
      userId: 'u',
      services: h.services,
    });
    expect(result.success).toBe(false);
    expect(h.debits).toHaveLength(0);
  });
});
