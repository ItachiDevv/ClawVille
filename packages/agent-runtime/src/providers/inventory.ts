import type { Provider, ProviderResult } from './types';

/**
 * Inventory Provider — surfaces the avatar's owned items grouped by type.
 *
 * Expects:
 *   state.inventory — Array<{ itemId: string; quantity: number }>
 *
 * itemId conventions:
 *   "book-<buildingId>-<bookIndex>"  for knowledge books
 *   "skill-<skillId>"               for quest/bounty skill rewards
 */
export const inventoryProvider: Provider = {
  name: 'inventory',
  description: 'Avatar inventory: books, skills, and other items',
  position: 30,

  async get(_runtime: any, _message: any, state: any): Promise<ProviderResult> {
    const inventory = state?.inventory as Array<{ itemId?: string; quantity?: number }> | undefined;

    if (!inventory || inventory.length === 0) {
      return { text: '', values: {}, data: {} };
    }

    const books: string[] = [];
    const skills: string[] = [];
    const other: string[] = [];
    let totalItems = 0;

    for (const item of inventory) {
      const id = item.itemId ?? '';
      const qty = item.quantity ?? 1;
      totalItems += qty;

      const qtyLabel = qty > 1 ? ` (\u00d7${qty})` : '';
      const displayName = formatItemName(id);

      if (id.startsWith('book-')) {
        books.push(`${displayName}${qtyLabel}`);
      } else if (id.startsWith('skill-')) {
        skills.push(`${displayName}${qtyLabel}`);
      } else {
        other.push(`${displayName}${qtyLabel}`);
      }
    }

    const lines: string[] = ['[Inventory]'];
    if (books.length > 0) lines.push(`Books: ${books.join(', ')}`);
    if (skills.length > 0) lines.push(`Skills: ${skills.join(', ')}`);
    if (other.length > 0) lines.push(`Other: ${other.join(', ')}`);
    lines.push(`Total items: ${totalItems}`);

    return {
      text: lines.join('\n'),
      values: {
        inventoryCount: totalItems,
      },
      data: {
        inventory,
        bookCount: books.length,
        skillCount: skills.length,
      },
    };
  },
};

/**
 * Convert an itemId like "book-cron-automation-0" or "skill-memory-rag-guide"
 * into a human-readable name by stripping the prefix and title-casing.
 */
function formatItemName(itemId: string): string {
  // Strip known prefixes
  let name = itemId;
  if (name.startsWith('book-')) name = name.slice(5);
  else if (name.startsWith('skill-')) name = name.slice(6);

  // Replace hyphens with spaces and title-case each word
  return name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
