import { describe, expect, it } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import {
  grantInventoryItem,
  takeInventoryItem,
  type InventoryDatabase,
} from './inventory-mutations';

/** Render a drizzle SQL object to normalized text + ordered params. */
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

interface InventoryRow {
  id: string;
  avatarId: string;
  itemId: string;
  quantity: number;
  acquiredAt: number;
}

/**
 * In-memory avatar_inventory. Each `execute` applies ONE statement atomically,
 * the way Postgres applies a single UPDATE to the latest committed row. It
 * yields before it runs, so concurrent callers interleave between statements.
 */
function inventoryDb(rows: InventoryRow[] = []) {
  const statements: string[] = [];
  let seq = rows.length;
  const pick = (avatarId: unknown, itemId: unknown, positiveOnly: boolean) =>
    rows
      .filter(
        (r) =>
          r.avatarId === avatarId &&
          r.itemId === itemId &&
          (!positiveOnly || r.quantity > 0),
      )
      .sort((a, b) => a.acquiredAt - b.acquiredAt || a.id.localeCompare(b.id))[0];

  const db = {
    execute: async (query: SQL) => {
      await Promise.resolve();
      const { text, params } = render(query);
      statements.push(text);
      if (
        text.startsWith('INSERT INTO avatar_inventory AS inventory (avatar_id, item_id, quantity)') &&
        text.includes('ON CONFLICT (avatar_id, item_id) DO UPDATE SET quantity = inventory.quantity + 1')
      ) {
        // Models the unique (avatar_id, item_id) index: conflict → increment.
        const row = pick(params[0], params[1], false);
        if (row) {
          row.quantity += 1;
          return [];
        }
        rows.push({
          id: `row-${++seq}`,
          avatarId: String(params[0]),
          itemId: String(params[1]),
          quantity: 1,
          acquiredAt: seq,
        });
        return [];
      }
      if (text.startsWith('WITH inventory_item AS')) {
        const row = pick(params[0], params[1], true);
        if (!row) return [];
        row.quantity -= 1;
        return [{ id: row.id }];
      }
      throw new Error(`unhandled SQL: ${text}`);
    },
  } as unknown as InventoryDatabase;
  return { db, rows, statements };
}

const total = (rows: InventoryRow[], avatarId: string, itemId: string) =>
  rows
    .filter((r) => r.avatarId === avatarId && r.itemId === itemId)
    .reduce((sum, r) => sum + r.quantity, 0);

describe('grantInventoryItem (security M10)', () => {
  it('inserts a first copy and increments an existing row in ONE upsert statement', async () => {
    const h = inventoryDb();
    await grantInventoryItem(h.db, { avatarId: 'a1', itemId: 'book-x' });
    expect(h.rows).toEqual([expect.objectContaining({ avatarId: 'a1', itemId: 'book-x', quantity: 1 })]);

    await grantInventoryItem(h.db, { avatarId: 'a1', itemId: 'book-x' });
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]!.quantity).toBe(2);
    // One statement per grant, and none reads the quantity for a JavaScript add.
    expect(h.statements).toHaveLength(2);
    expect(h.statements.some((s) => /^SELECT .*quantity/i.test(s))).toBe(false);
  });

  it('two concurrent FIRST grants end as one row with quantity 2 (unique index upsert)', async () => {
    const h = inventoryDb();
    await Promise.all([
      grantInventoryItem(h.db, { avatarId: 'a1', itemId: 'book-x' }),
      grantInventoryItem(h.db, { avatarId: 'a1', itemId: 'book-x' }),
    ]);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]!.quantity).toBe(2);
  });

  it('never loses a concurrent grant', async () => {
    const h = inventoryDb([{ id: 'row-0', avatarId: 'a1', itemId: 'book-x', quantity: 1, acquiredAt: 0 }]);
    await Promise.all(
      Array.from({ length: 5 }, () => grantInventoryItem(h.db, { avatarId: 'a1', itemId: 'book-x' })),
    );
    expect(total(h.rows, 'a1', 'book-x')).toBe(6);
  });

  it('revives a row a learn drained to 0 instead of adding a second row', async () => {
    const h = inventoryDb([{ id: 'row-0', avatarId: 'a1', itemId: 'book-x', quantity: 0, acquiredAt: 0 }]);
    await grantInventoryItem(h.db, { avatarId: 'a1', itemId: 'book-x' });
    expect(h.rows).toEqual([expect.objectContaining({ id: 'row-0', quantity: 1 })]);
  });
});

describe('takeInventoryItem (security M11)', () => {
  it('takes exactly one copy and refuses once none is left', async () => {
    const h = inventoryDb([{ id: 'row-0', avatarId: 'poster', itemId: 'book-x', quantity: 1, acquiredAt: 0 }]);
    expect(await takeInventoryItem(h.db, { avatarId: 'poster', itemId: 'book-x' })).toBe(true);
    expect(h.rows[0]!.quantity).toBe(0);
    expect(await takeInventoryItem(h.db, { avatarId: 'poster', itemId: 'book-x' })).toBe(false);
    expect(h.rows[0]!.quantity).toBe(0);
  });

  it('returns false and changes nothing when the avatar never held the item', async () => {
    const h = inventoryDb([{ id: 'row-0', avatarId: 'other', itemId: 'book-x', quantity: 3, acquiredAt: 0 }]);
    expect(await takeInventoryItem(h.db, { avatarId: 'poster', itemId: 'book-x' })).toBe(false);
    expect(h.rows[0]!.quantity).toBe(3);
  });

  it('two concurrent takes of the last copy: exactly one wins', async () => {
    const h = inventoryDb([{ id: 'row-0', avatarId: 'poster', itemId: 'book-x', quantity: 1, acquiredAt: 0 }]);
    const results = await Promise.all([
      takeInventoryItem(h.db, { avatarId: 'poster', itemId: 'book-x' }),
      takeInventoryItem(h.db, { avatarId: 'poster', itemId: 'book-x' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(h.rows[0]!.quantity).toBe(0);
  });
});
