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
/** One operator exists today; the cap is here so a future one cannot grow this unbounded. */
const MAX_STORES = 10;

export interface DoordashWorkingContext {
  /** Stores from the most recent search, so a later turn can name one. */
  lastStores: Array<{ storeId: string; storeName: string }>;
  storeId?: string;
  menuId?: string;
  storeName?: string;
  cartUuid?: string;
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
  return entry ? { ...entry, lastStores: [...entry.lastStores] } : { lastStores: [] };
}

export function rememberDoordashContext(
  userId: string, patch: Partial<DoordashWorkingContext>,
): void {
  const current = live(userId) ?? { lastStores: [], at: Date.now() };
  const next: Entry = { ...current, ...patch, at: Date.now() };
  if (next.lastStores.length > MAX_STORES) next.lastStores = next.lastStores.slice(0, MAX_STORES);
  entries.set(userId, next);
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
