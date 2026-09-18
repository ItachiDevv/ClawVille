/**
 * The operator's in-flight ordering context, held in memory for one order.
 *
 * WHY THIS EXISTS. DoorDash CLI output is deliberately excluded from persisted
 * chat memory (terms of service section 6: vendor data must not be retained
 * beyond completing the transaction), so `eliza-runtime` replaces it with
 * "[Action output omitted]" before storing the reply. That is correct, and it
 * has a consequence: on the NEXT turn the model cannot see any identifier it
 * was shown — not the store, not the menu, not the cart. Without somewhere to
 * put them, a multi-turn order is impossible, because "add two garlic knots"
 * and "what is my total" arrive in later turns than the menu did.
 *
 * So the identifiers live HERE instead: server side, in process, for one
 * operator, expiring in 30 minutes, and never written to the database or to
 * chat memory. That is retention FOR completing the transaction, which the
 * terms permit, rather than retention BEYOND it, which they do not.
 *
 * What is kept is deliberately thin — ids and display names needed to finish an
 * order. No prices, no addresses, no menus, no order history.
 */

// Expiry is LAZY: an entry is dropped when it is next read, and there is no
// sweeper. Correct at one operator, where the only entry is re-read constantly.
// It would be wrong at ten, where abandoned entries would sit until touched —
// so a second operator means a sweeper, not just a bigger map.
const CONTEXT_TTL_MS = 30 * 60 * 1000;
/** One operator exists today; the caps are here so a future one cannot grow this unbounded. */
const MAX_STORES = 30;
const MAX_ITEMS = 400;

export interface DoordashMenuItemRef {
  itemId: string;
  name: string;
  hasModifiers: boolean;
  hasRequired: boolean;
}

export interface DoordashWorkingContext {
  /** Stores from the most recent search, so a later turn can name one. */
  lastStores: Array<{ storeId: string; storeName: string }>;
  storeId?: string;
  menuId?: string;
  storeName?: string;
  cartUuid?: string;
  /**
   * Item ids and names from the last menu, so "add a custom italian hoagie"
   * resolves on a later turn. Names and ids only: no prices, no descriptions.
   */
  lastItems?: DoordashMenuItemRef[];
  /** An item waiting for the operator's option choices, so "classic roll, provolone" needs no item name. */
  pendingItem?: { itemId: string; name: string; quantity: number };
}

interface Entry extends DoordashWorkingContext { at: number }

const entries = new Map<string, Entry>();

function live(userId: string): Entry | undefined {
  const entry = entries.get(userId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CONTEXT_TTL_MS) {
    entries.delete(userId);
    return undefined;
  }
  return entry;
}

export function recallDoordashContext(userId: string): DoordashWorkingContext {
  const entry = live(userId);
  // Copy the array too. A shallow spread hands back the STORED array by
  // reference; nothing mutates it today, and that is exactly the kind of trap
  // that stays harmless until the day something does.
  return entry
    ? { ...entry, lastStores: [...entry.lastStores], lastItems: entry.lastItems ? [...entry.lastItems] : undefined }
    : { lastStores: [] };
}

export function rememberDoordashContext(
  userId: string, patch: Partial<DoordashWorkingContext>,
): void {
  const current = live(userId) ?? { lastStores: [], at: Date.now() };
  const next: Entry = { ...current, ...patch, at: Date.now() };
  if (next.lastStores.length > MAX_STORES) next.lastStores = next.lastStores.slice(0, MAX_STORES);
  if (next.lastItems && next.lastItems.length > MAX_ITEMS) next.lastItems = next.lastItems.slice(0, MAX_ITEMS);
  entries.set(userId, next);
}

// Plurals ("hoagies" for "Hoagie") and joined words ("pepperjack") are what a
// person actually types; the first real order failed on "custom wawa
// cheesesteak hoagies" (founder, 2026-09-18). Same rule as doordash-options.ts.
function words(value: string): string {
  const list = value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return ` ${list.join(' ')} `;
}

/**
 * Match a spoken item name to the last menu. Same stance as the store match:
 * an exact name wins, then a single containment match; several matches come
 * back as a list for the operator to choose from, never as a guess.
 */
export function resolveItemByName(
  context: DoordashWorkingContext, spoken: string,
): { item: DoordashMenuItemRef } | { choices: string[] } | null {
  const needle = words(spoken).trim();
  const items = context.lastItems ?? [];
  if (!needle || items.length === 0) return null;
  const exact = items.filter((i) => words(i.name).trim() === needle);
  if (exact.length === 1) return { item: exact[0]! };
  const partial = items.filter((i) => words(i.name).includes(` ${needle} `));
  if (partial.length === 1) return { item: partial[0]! };
  if (partial.length > 1) return { choices: partial.slice(0, 8).map((i) => i.name) };
  // Every spoken word present, in any order ("italian custom hoagie").
  const tokens = needle.split(' ').filter((t) => t.length > 1);
  const loose = items.filter((i) => tokens.every((t) => words(i.name).includes(` ${t} `)));
  if (loose.length === 1) return { item: loose[0]! };
  if (loose.length > 1) return { choices: loose.slice(0, 8).map((i) => i.name) };
  // Split vs joined spelling ("cheese steak" for "Cheesesteak"): every spoken
  // word appears inside the name once spaces are removed.
  const compact = (value: string) => words(value).replace(/ /g, '');
  const squeezed = items.filter((i) => tokens.every((t) => t.length > 2 && compact(i.name).includes(t)));
  if (squeezed.length === 1) return { item: squeezed[0]! };
  if (squeezed.length > 1) return { choices: squeezed.slice(0, 8).map((i) => i.name) };
  // Nothing matched outright: offer the closest names instead of a bare "not
  // found", ranked by how many spoken words each shares.
  const scored = items
    .map((i) => ({ i, score: tokens.filter((t) => t.length > 2 && words(i.name).includes(` ${t} `)).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  return scored.length ? { choices: scored.map((s) => s.i.name) } : null;
}

/**
 * Drop the cart, keeping the store the operator was looking at.
 *
 * Called once an order is placed or has failed terminally: that cart is spent
 * either way, and reusing its uuid would either duplicate an order or price a
 * cart that no longer exists.
 */
export function clearDoordashCart(userId: string): void {
  const entry = live(userId);
  if (!entry) return;
  delete entry.cartUuid;
  entry.at = Date.now();
}

/** Test seam: no suite should inherit another one's in-flight order. */
export function resetDoordashContexts(): void {
  entries.clear();
}

/**
 * Best-effort match of a spoken restaurant name to a store from the last search.
 *
 * Exact match first, then a containment match either way, so "Rojas" finds
 * "Rojas Pizza" and "Rojas Pizza please" still resolves. An ambiguous or absent
 * match returns null and the caller asks rather than guessing, because ordering
 * from the wrong restaurant is not a recoverable mistake.
 */
export function resolveStoreByName(
  context: DoordashWorkingContext, spoken: string,
): { storeId: string; storeName: string } | null {
  const needle = spoken.trim().toLowerCase();
  if (!needle) return null;
  const exact = context.lastStores.filter((s) => s.storeName.toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;
  const partial = context.lastStores.filter((s) => {
    const name = s.storeName.toLowerCase();
    // `name.includes(needle)` is the safe direction: "Rojas" finds "Rojas Pizza".
    // The REVERSE direction is hazardous, because a very short store name is a
    // substring of almost any spoken phrase — a store literally called "Pi"
    // would match "menu for Pizza Hut" and send the order somewhere else
    // entirely. Require a name long enough for the coincidence to be unlikely.
    return name.includes(needle) || (name.length >= 4 && needle.includes(name));
  });
  return partial.length === 1 ? partial[0]! : null;
}
