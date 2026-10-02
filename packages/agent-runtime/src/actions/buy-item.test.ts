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
 * Fake drizzle db with a transaction that ROLLS BACK the fake balance and
 * inventory when the callback throws, the way Postgres does. The actor select
 * resolves `actor`; raw SQL on the tx is recorded.
 */
function harness(actor: { clawTokens: number; isGuest: boolean } | null, opts: { failGrant?: boolean } = {}) {
  const state = { balance: actor?.clawTokens ?? 0, books: 0 };
  const executed: string[] = [];
  const debits: Array<{ params: unknown; tx: unknown }> = [];
  const credits: unknown[] = [];
  const tx = {
    execute: async (query: { queryChunks?: unknown[] }) => {
      const text = render(query);
      executed.push(text);
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
      state.balance -= params.amount;
      return { balanceAfter: state.balance };
    },
    creditClawTokens: async (params) => {
      credits.push(params);
      state.balance += params.amount;
      return { balanceAfter: state.balance };
    },
  };
  return { services, executed, debits, credits, state, tx };
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
    expect(h.state).toEqual({ balance: 10_000 - BOOK.price, books: 1 });
  });

  it('a failed grant rolls the debit back: the buyer keeps the vCLAW, no refund write needed', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false }, { failGrant: true });
    const result = await buyItemAction.handler(null, message, {
      avatarId: 'real-avatar',
      userId: 'real-user',
      services: h.services,
    });

    expect(result.success).toBe(false);
    expect(h.debits).toHaveLength(1);
    expect(h.state).toEqual({ balance: 10_000, books: 0 });
    expect(h.credits).toHaveLength(0);
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
