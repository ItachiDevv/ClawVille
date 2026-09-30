import { describe, expect, it } from 'bun:test';
import { KNOWLEDGE_BOOKS } from '@clawville/shared';
import { buyItemAction } from './buy-item';
import type { ClawvilleServices } from './types';

const BOOK = KNOWLEDGE_BOOKS[0]!;

/** Fake drizzle db: the actor select resolves `actor`; raw SQL is recorded. */
function harness(actor: { clawTokens: number; isGuest: boolean } | null) {
  const executed: string[] = [];
  const debits: unknown[] = [];
  const credits: unknown[] = [];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: async () => (actor ? [actor] : []) }),
        }),
      }),
    }),
    execute: async (query: { queryChunks?: unknown[] }) => {
      const text = (query.queryChunks ?? [])
        .map((c) => ((c as { value?: unknown }).value instanceof Array ? (c as { value: string[] }).value.join('') : '?'))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      executed.push(text);
      return [];
    },
  };
  const services: ClawvilleServices = {
    db,
    debitClawTokens: async (params) => {
      debits.push(params);
      return { balanceAfter: 0 };
    },
    creditClawTokens: async (params) => {
      credits.push(params);
      return { balanceAfter: 0 };
    },
  };
  return { services, executed, debits, credits };
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

  it('a full account pays once and gets the book by an atomic increment (security M10)', async () => {
    const h = harness({ clawTokens: 10_000, isGuest: false });
    const result = await buyItemAction.handler(null, message, {
      avatarId: 'real-avatar',
      userId: 'real-user',
      services: h.services,
    });

    expect(result.success).toBe(true);
    expect(h.debits).toEqual([expect.objectContaining({ avatarId: 'real-avatar', amount: BOOK.price })]);
    expect(h.credits).toHaveLength(0);
    expect(h.executed[0]).toContain('SET quantity = inventory.quantity + 1');
    expect(h.executed[1]).toStartWith('INSERT INTO avatar_inventory');
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
