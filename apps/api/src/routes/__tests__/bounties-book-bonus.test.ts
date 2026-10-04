/**
 * Security M10/M11 (2026-09-30) — bounty knowledge-book bonus + inventory writes.
 *
 * M11: a knowledge_book bonus was minted into the hunter's inventory with no
 * debit, under a free-text `book-<bookId>` item id. Now create requires a
 * canonical book id, and approval MOVES one copy from the poster to the hunter
 * (atomic conditional decrement, then atomic increment) or skips it with a
 * recorded reason. No vCLAW moves.
 * M10: no book writer may read `quantity` and add in JavaScript.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { SQL } from 'drizzle-orm';
import { KNOWLEDGE_BOOKS } from '@clawville/shared';
import { createBountySchema, transferBountyBookBonuses } from '../bounties';

const BOOK = KNOWLEDGE_BOOKS[0]!;

function render(query: SQL): { text: string; params: unknown[] } {
  const chunks = (query as unknown as { queryChunks: unknown[] }).queryChunks ?? [];
  let text = '';
  const params: unknown[] = [];
  for (const chunk of chunks) {
    const name = (chunk as { constructor?: { name?: string } })?.constructor?.name;
    if (name === 'StringChunk') {
      text += ((chunk as { value: string[] }).value ?? []).join('');
    } else if (name === 'SQL') {
      const sub = render(chunk as SQL);
      text += sub.text;
      params.push(...sub.params);
    } else {
      params.push(chunk);
      text += '?';
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), params };
}

/** In-memory avatar_inventory keyed `${avatarId}:${itemId}` → quantity. */
function inventoryTx(start: Record<string, number>) {
  const inv = new Map(Object.entries(start));
  const tx = {
    execute: async (query: SQL) => {
      const { text, params } = render(query);
      const key = `${params[0]}:${params[1]}`;
      if (text.startsWith('WITH inventory_item AS')) {
        if ((inv.get(key) ?? 0) <= 0) return [];
        inv.set(key, inv.get(key)! - 1);
        return [{ id: key }];
      }
      if (text.startsWith('INSERT INTO avatar_inventory AS inventory') && text.includes('ON CONFLICT (avatar_id, item_id)')) {
        inv.set(key, (inv.get(key) ?? 0) + 1);
        return [];
      }
      throw new Error(`unhandled SQL: ${text}`);
    },
  };
  return { tx: tx as never, inv };
}

const bountyBase = {
  title: 'Book bonus bounty',
  description: 'A bounty that carries a knowledge-book bonus.',
  difficulty: 'beginner' as const,
  tokenReward: 10,
};

describe('bounty create: knowledge_book bonus needs a canonical book id (M11)', () => {
  const parse = (bonus: Record<string, unknown>) =>
    createBountySchema.safeParse({ ...bountyBase, bonusRewards: [bonus] });

  it('accepts a canonical book id', () => {
    expect(parse({ rewardType: 'knowledge_book', bookId: BOOK.id }).success).toBe(true);
  });

  it('rejects a free-text id and a missing id', () => {
    const freeText = parse({ rewardType: 'knowledge_book', bookId: 'my-secret-grimoire' });
    expect(freeText.success).toBe(false);
    if (!freeText.success) {
      expect(freeText.error.issues[0]!.path).toEqual(['bonusRewards', 0, 'bookId']);
    }
    expect(parse({ rewardType: 'knowledge_book' }).success).toBe(false);
  });

  it('leaves custom bonuses unchanged', () => {
    expect(parse({ rewardType: 'custom', customDescription: 'A shout-out' }).success).toBe(true);
  });
});

describe('bounty approve: book bonus moves poster → hunter, never minted (M11)', () => {
  const rewards = [
    { id: 'r-book', rewardType: 'knowledge_book', bookId: BOOK.id },
    { id: 'r-custom', rewardType: 'custom', bookId: null },
  ];

  it('takes one copy from the poster and gives it to the hunter', async () => {
    const { tx, inv } = inventoryTx({ [`poster:${BOOK.id}`]: 2 });
    const out = await transferBountyBookBonuses(tx, {
      bountyId: 'b-1',
      posterAvatarId: 'poster',
      hunterAvatarId: 'hunter',
      rewards,
    });

    expect(out).toEqual([{ rewardId: 'r-book', bookId: BOOK.id, status: 'granted' }]);
    expect(inv.get(`poster:${BOOK.id}`)).toBe(1);
    expect(inv.get(`hunter:${BOOK.id}`)).toBe(1);
  });

  it('skips (and reports why) when the poster no longer holds the book', async () => {
    const { tx, inv } = inventoryTx({ [`poster:${BOOK.id}`]: 0 });
    const out = await transferBountyBookBonuses(tx, {
      bountyId: 'b-2',
      posterAvatarId: 'poster',
      hunterAvatarId: 'hunter',
      rewards,
    });

    expect(out).toEqual([
      { rewardId: 'r-book', bookId: BOOK.id, status: 'skipped', reason: 'poster_no_longer_holds_book' },
    ]);
    expect(inv.get(`hunter:${BOOK.id}`)).toBeUndefined();
  });

  it('skips a legacy non-canonical book id instead of minting it', async () => {
    const { tx, inv } = inventoryTx({});
    const out = await transferBountyBookBonuses(tx, {
      bountyId: 'b-3',
      posterAvatarId: 'poster',
      hunterAvatarId: 'hunter',
      rewards: [{ id: 'r-legacy', rewardType: 'knowledge_book', bookId: 'free-text' }],
    });

    expect(out).toEqual([
      { rewardId: 'r-legacy', bookId: 'free-text', status: 'skipped', reason: 'unknown_book' },
    ]);
    expect(inv.size).toBe(0);
  });
});

describe('web Create form bonus rows match the server schema', () => {
  // The form used to send { type, label, value }, which createBountySchema
  // rejects, so a bounty with any bonus could not be posted from the UI.
  it('mapped rows pass createBountySchema; a free-text book id is still refused', async () => {
    // A computed path keeps the web file out of the API tsc program (rootDir).
    const webModule = join(import.meta.dir, '..', '..', '..', '..', 'web', 'src', 'lib', 'bounty-bonus-payload.ts');
    const { toBonusRewardPayload } = (await import(webModule)) as {
      toBonusRewardPayload: (row: { type: string; label: string; value: string }) => unknown;
    };
    const rows = [
      { type: 'knowledge_book', label: 'Book', value: BOOK.id },
      { type: 'custom', label: 'Shout-out', value: 'on the town board' },
    ];
    const ok = createBountySchema.safeParse({
      ...bountyBase,
      bonusRewards: rows.map(toBonusRewardPayload),
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.bonusRewards).toEqual([
        { rewardType: 'knowledge_book', bookId: BOOK.id },
        { rewardType: 'custom', customDescription: 'Shout-out: on the town board' },
      ]);
    }
    const bad = createBountySchema.safeParse({
      ...bountyBase,
      bonusRewards: [toBonusRewardPayload({ type: 'knowledge_book', label: '', value: 'grimoire' })],
    });
    expect(bad.success).toBe(false);
  });
});

describe('inventory writers never read-then-write the quantity (M10)', () => {
  const files = [
    join(import.meta.dir, '..', 'items.ts'),
    join(import.meta.dir, '..', 'bounties.ts'),
    join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'agent-runtime', 'src', 'actions', 'buy-item.ts'),
  ];
  for (const file of files) {
    it(`${file.split(/[\\/]/).slice(-1)[0]} uses the atomic grant helper`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/\.quantity \+ 1/);
      expect(src).toContain('grantInventoryItem(');
    });
  }
});
