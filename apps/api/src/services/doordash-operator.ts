import { and, db, doordashOrders, eq, sql } from '@clawville/database';
import { alertError, sendTelegramText } from './alert-error';
import { DOORDASH_CAPS, capRefusal, formatUsd } from './doordash-caps';
import {
  runDdCli,
  isDoordashAvailable,
  type DdAddress,
  type DdCart,
  type DdCliFailure,
  type DdItemOptions,
  type DdMenu,
  type DdNearby,
  type DdOrderStatus,
  type DdOrderSummary,
  type DdPreview,
  type DdSearchResult,
  type DdSubmit,
} from './doordash-cli';
import {
  codeStatedByRequester,
  hashConfirmCode,
  isWellFormedConfirmCode,
  maskConfirmCode,
  mintConfirmCode,
  tipStatedByRequester,
} from './doordash-confirm';
import {
  clearDoordashCart,
  recallDoordashContext,
  rememberDoordashContext,
  matchingStoresByName,
  resolveItemByName,
  resolveStoreReference,
  type DoordashMenuItemRef,
} from './doordash-session';
import { cleanVendorText, describeGaps, isChoiceRequestWithdrawal, isChoiceReviewConfirmation, resolveChoices } from './doordash-options';

/**
 * Queries that mean "what is there", not a name or a cuisine. "I'm hungry, is
 * DoorDash available?" arrives as one of these, and answering it with a
 * restaurant-name search returns nothing at 4 AM even when Wawa is open.
 */
const GENERIC_QUERY = /^(?:food|anything|something|hungry|eat|eats|meal|snacks?|delivery|doordash|open|open now|what'?s open|near me|nearby|restaurants?|stores?|places?|options?|available)$/i;

function isGenericQuery(query: string): boolean {
  const q = query.trim().replace(/[?.!]+$/, '');
  return q.length === 0 || GENERIC_QUERY.test(q) || /\b(?:hungry|what'?s open|available|anything)\b/i.test(q);
}

function storeNameMatches(name: string, query: string): boolean {
  const n = name.toLowerCase();
  const q = query.trim().toLowerCase();
  // Same length floor as resolveStoreByName, for the same reason.
  return q.length > 0 && (n.includes(q) || (n.length >= 4 && q.includes(n)));
}

/** "Scheduled" is the vendor's word for "cannot deliver right now". */
function deliversNow(etaText: string | undefined): boolean {
  return !!etaText && !/scheduled/i.test(etaText);
}

// A small name-only convenience for "what drinks do they have?". The vendor
// menu shape has no category field. This is not a complete category inventory.
const BEVERAGE_QUERY = /^(?:drinks?|beverages?)$/;
const BEVERAGE_NAME = /\b(?:drinks?|beverages?|sodas?|coke|coca[ -]cola|pepsi|sprite|fanta|dr\.? pepper|mountain dew|water|teas?|coffee|espresso|latte|cappuccino|lemonades?|juices?|smoothies?|milkshakes?)\b/i;
const BEVERAGE_FOOD_NAME = /\b(?:cakes?|cookies?|bread|muffins?|chicken|sauces?|sandwich(?:es)?|bowls?)\b/i;
import { withKeyedMutex } from './keyed-mutex';

const OPERATOR_ID = (process.env.DOORDASH_OPERATOR_USER_ID ?? '').trim();
const ADMIN_IDS = new Set(
  (process.env.ADMIN_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
);

/** The one enabled account must also be an admin. Both settings resolve at module load. */
export function doordashOperatorUserId(): string | null {
  return OPERATOR_ID && ADMIN_IDS.has(OPERATOR_ID) ? OPERATOR_ID : null;
}

export interface DoordashSubject {
  userId: string;
  avatarId: string;
  kind: 'human' | 'agent';
  /** Resolved agent session id for audit; never write the raw bearer to a log. */
  agentSessionId?: string;
  /** Only the Lucia human path can submit in Phase 2. */
  canSubmit: boolean;
}

/**
 * Consume identity from requireAuth / resolveAgentSession, never runtime state.userId.
 * Those upstream resolvers enforce session liveness, rotation, and avatar ownership.
 * Availability is independent: runDdCli checks the executable and the dark latch.
 */
export function resolveDoordashOperator(input:
  | { kind: 'human'; userId: string; avatarId: string }
  | { kind: 'agent'; userId: string | null; avatarId: string | null;
      ledgerCapable: boolean; agentSessionId: string },
): DoordashSubject | null {
  const operatorId = doordashOperatorUserId();
  if (!operatorId || input.userId !== operatorId || !input.avatarId?.trim()) return null;
  if (input.kind === 'agent') {
    if (input.ledgerCapable !== true || !input.agentSessionId?.trim()) return null;
    // Frozen: `canSubmit` is the authority boundary, and nothing downstream
    // should be able to flip it after the identity has been resolved.
    return Object.freeze({
      userId: operatorId, avatarId: input.avatarId, kind: 'agent' as const,
      agentSessionId: input.agentSessionId, canSubmit: false,
    });
  }
  if (input.kind !== 'human') return null;
  return Object.freeze({
    userId: operatorId, avatarId: input.avatarId, kind: 'human' as const, canSubmit: true,
  });
}

// ---------------------------------------------------------------------------
// Result type
//
// The bridge can refuse for reasons the CLI never sees: a cap, an expired code,
// a price that moved. Those are OUR failures, so they get their own codes
// alongside the wrapper's. `reason` is SERVER-AUTHORED text that is safe to
// show the founder; `detail` stays diagnostic and never reaches a chat reply.
// ---------------------------------------------------------------------------
export type DoordashFailure =
  | DdCliFailure
  | 'doordash_submit_forbidden'
  | 'doordash_confirm_invalid'
  | 'doordash_confirm_expired'
  | 'doordash_cap_exceeded'
  | 'doordash_price_moved'
  | 'doordash_age_restricted'
  | 'doordash_undeliverable'
  | 'doordash_submit_ambiguous'
  | 'doordash_store_unresolved'
  | 'doordash_no_menu'
  | 'doordash_no_cart'
  | 'doordash_item_unresolved'
  | 'doordash_needs_choices'
  | 'doordash_no_order';

export type DoordashResult<T> =
  | { ok: true; data: T; durationMs: number }
  | { ok: false; failure: DoordashFailure; detail: string; reason?: string; durationMs: number };

function refuse(
  failure: DoordashFailure, reason: string, startedAt: number,
): { ok: false; failure: DoordashFailure; detail: string; reason: string; durationMs: number } {
  return { ok: false, failure, detail: failure, reason, durationMs: Date.now() - startedAt };
}

// ---------------------------------------------------------------------------
// Views handed to the action layer
//
// These are OUR shapes, not the vendor's. The wrapper's schemas already strip
// unknown keys; these views narrow again to exactly what a reply needs, so no
// vendor-authored prose can reach a model through this path.
// ---------------------------------------------------------------------------
export interface DoordashCartView {
  cartUuid: string;
  storeName?: string;
  items: Array<{ lineId: string; name?: string; quantity: number; unitPriceCents?: number }>;
  /** Non-zero means DoorDash silently dropped part of the write (vendor issue #64). */
  droppedItems: number;
  /** The option choices just added, echoed so the operator sees them before pricing. */
  addedChoices?: string[];
}
/** One search hit, restaurant or store. Our shape, built from two vendor calls. */
export interface DoordashPlaceView {
  store_id: string;
  store_name?: string;
  kind: 'restaurant' | 'store';
  etaText?: string;
  miles?: number;
}
export interface DoordashPreviewView {
  /** What is actually in the basket, so a confirmation is an informed one. */
  items: Array<{ name: string; quantity: number }>;
  storeName?: string;
  lines: Array<{ label: string; amount: string }>;
  totalBeforeTipCents: number;
  etaText?: string;
  tipSuggestionsCents: number[];
  confirmCode: string;
  expiresInMinutes: number;
}
export interface DoordashSubmitView {
  orderUuid: string;
  totalCents: number;
  tipCents: number;
}

/** Per-message capability. No CLI output is retained here or persisted to memory. */
export interface DoordashBridge {
  subject: DoordashSubject;
  /** Raw requester turn. The confirmation protocol reads THIS, never a model reply. */
  requesterTurn: string;
  search(q: { query: string }): Promise<DoordashResult<{ stores: DoordashPlaceView[] }>>;
  menu(q: { storeId?: string; storeName?: string; query?: string }): Promise<DoordashResult<DdMenu & { storeName?: string }>>;
  addresses(): Promise<DoordashResult<DdAddress[]>>;
  // The cart and store ids are OPTIONAL because the model cannot see them
  // across turns: DoorDash output is stripped from chat memory by design. When
  // omitted they come from the operator's in-flight context (doordash-session).
  cartShow(q: { cartUuid?: string }): Promise<DoordashResult<DoordashCartView>>;
  cartAdd(q: {
    storeId?: string; menuId?: string; itemId?: string; itemName?: string; choices?: string;
    quantity?: number; cartUuid?: string;
  }): Promise<DoordashResult<DoordashCartView>>;
  cartRemove(q: { cartUuid?: string; lineId: string }): Promise<DoordashResult<DoordashCartView>>;
  preview(q: { cartUuid?: string }): Promise<DoordashResult<DoordashPreviewView>>;
  submit(q: { confirm: string; tipCents: number }): Promise<DoordashResult<DoordashSubmitView>>;
  orderStatus(q: { orderUuid?: string }): Promise<DoordashResult<DdOrderStatus>>;
  orderHistory(): Promise<DoordashResult<DdOrderSummary[]>>;
}

/**
 * The operator's DEFAULT saved delivery address id, cached in-process.
 *
 * `dd-cli search` with no location flag searches Cupertino, CA. It does not
 * error, it just returns an empty store list, so a Florida operator sees
 * "nothing found" instead of "wrong city". Anchoring every search to the saved
 * default is what makes results correct. Cached for 10 minutes so a search
 * costs one subprocess call, not two; the vendor warns `address list` is not
 * deduped and `address set` is account-wide, so a stale pick self-corrects
 * within the TTL. `is_default` is documented as best-effort and can be false
 * for every row, so fall back to the first address rather than giving up.
 */
const ADDRESS_CACHE_MS = 10 * 60 * 1000;
let addressCache: { id: string | null; at: number } | null = null;

async function defaultAddressId(): Promise<string | null> {
  if (addressCache && Date.now() - addressCache.at < ADDRESS_CACHE_MS) return addressCache.id;
  const result = await runDdCli<{ addresses: DdAddress[] }>('address-list', []);
  if (!result.ok) return null; // An expired cache cannot establish the current destination.
  const rows = result.data.addresses ?? [];
  const chosen = rows.find((row) => row.is_default) ?? rows[0];
  // The schema permits a numeric address_id; the CLI flag takes a string.
  const id = chosen?.address_id === undefined || chosen.address_id === null
    ? null
    : String(chosen.address_id);
  addressCache = { id, at: Date.now() };
  return id;
}

/** Test seam: drop the cached address so a suite never leaks state across cases. */
export function resetDoordashAddressCache(): void {
  addressCache = null;
}

function toCartView(data: DdCart): DoordashCartView {
  return {
    cartUuid: data.cart_uuid,
    storeName: data.cart.store_name,
    items: data.cart.items.map((item) => ({
      lineId: item.id,
      name: item.name,
      // An omitted quantity means one; the vendor sends it, but the schema no
      // longer requires it, so the view must not inherit the optionality.
      quantity: item.quantity ?? 1,
      unitPriceCents: item.price === undefined ? undefined : Math.round(item.price * 100),
    })),
    droppedItems: data.item_error_count,
  };
}

/** Start of the current UTC day. The caps are defined per UTC day. */
function utcDayStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

type SqlExecutor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/**
 * Today's committed order count and spend, read from the DATABASE.
 *
 * Reading from the database rather than memory is the point: a container
 * restart must not hand back a fresh daily allowance.
 *
 * THREE statuses count, and the reason is the same for all of them: the card
 * may already have been charged, and a cap must never be widened by our own
 * uncertainty. `submitting` is a spend in flight. `failed` is the AMBIGUOUS
 * outcome — it is set only after the submit command has started, so it means
 * "we do not know", not "it did not happen". Only `refused` is genuinely free:
 * every refusal that happens BEFORE the spend begins writes that status, so a
 * cap rejection, an expired code, a moved price and a superseded quote all
 * correctly leave the allowance untouched.
 */
async function todaysUsage(
  executor: SqlExecutor, userId: string,
): Promise<{ count: number; spentCents: number }> {
  const result = await executor.execute(sql`
    SELECT count(*)::int AS count, COALESCE(sum(total_cents + tip_cents), 0)::int AS spent
    FROM doordash_orders
    WHERE user_id = ${userId}
      AND status IN ('submitting', 'submitted', 'failed')
      AND confirmed_at >= ${utcDayStart().toISOString()}::timestamptz
  `);
  // DRIVER ASSUMPTION, stated because getting it wrong fails OPEN. Drizzle on
  // postgres-js returns a RowList that extends Array, so `Array.isArray` holds
  // and the `::int` casts arrive as numbers. Under node-postgres the result is
  // `{ rows: [...] }`, `Array.isArray` goes false, and every cap would silently
  // read zero — no error, no alert, no limit. If this repo ever changes driver,
  // this function must be revisited FIRST.
  const rows = result as unknown as Array<{ count: number; spent: number }>;
  if (!Array.isArray(rows)) {
    // PAGE before throwing. The throw is fail-closed at both call sites — it
    // aborts the claim transaction, or becomes a generic refusal in the action
    // layer — but `lookup()` swallows it into "DoorDash could not complete that
    // request", so without this the loudest failure in the file would be the
    // quietest one in practice and nobody would know the caps had stopped working.
    void alertError({
      severity: 'critical', source: 'doordash-caps',
      message: 'Cap read returned an unexpected driver result shape. Ordering is refused until this is fixed.',
    }).catch(() => {});
    throw new Error('doordash caps: unexpected driver result shape; refusing to read caps as zero');
  }
  const row = rows[0];
  return { count: Number(row?.count ?? 0), spentCents: Number(row?.spent ?? 0) };
}


export function buildDoordashBridge(
  subject: DoordashSubject,
  requesterTurn: string,
): DoordashBridge {
  // Revoke before sending a cart write: even a timeout may have changed it.
  // Both subject kinds prepare the SAME operator cart, so both lose their old
  // confirmations. A failed database write prevents the vendor mutation.
  const invalidateCartConfirmations = () => db.update(doordashOrders)
    .set({ status: 'refused', failureCode: 'cart_changed' })
    .where(and(eq(doordashOrders.userId, subject.userId), eq(doordashOrders.status, 'previewed')));
  const bridge: DoordashBridge = {
    subject,
    requesterTurn,
    // Values only; the wrapper owns flags and validation (docs/ddcli-help/search.txt).
    // The default saved address is resolved first: without it the vendor searches
    // Cupertino, CA and returns an empty list (confirmed on staging 2026-09-17).
    // Refuse when the saved address cannot be verified. An unanchored vendor
    // search silently uses another city and revives the original location bug.
    /**
     * Restaurants AND stores. DoorDash splits discovery in two: `search` finds
     * restaurants only, and convenience, grocery and pharmacy stores (Wawa,
     * 7-Eleven, CVS) exist only in `find-nearby-stores`. Asking one of them
     * made "I'm hungry" return nothing while Wawa was open (founder, 2026-09-18).
     * A generic query lists stores that deliver NOW; a named query keeps the
     * stores whose name matches it.
     */
    async search({ query }) {
      const startedAt = Date.now();
      // Even a failed new search must not leave "their menu" pointing at an
      // older restaurant. Keep the actual cart and its menu intact.
      rememberDoordashContext(subject.userId, { lastStores: [], namedStores: [], menuSelection: undefined, pendingItem: undefined });
      const generic = isGenericQuery(query);
      const addressId = await defaultAddressId();
      if (!addressId) return refuse('ddcli_unavailable',
        'I could not verify the saved delivery address. Check the address in DoorDash, then try the search again.', startedAt);
      const restaurants = await runDdCli<DdSearchResult>('search',
        [generic ? 'food' : query, addressId]);
      const stores = await runDdCli<DdNearby>('nearby-stores', [addressId]);
      if (!restaurants.ok && !(stores && stores.ok)) return restaurants;

      const places: DoordashPlaceView[] = [];
      const seen = new Set<string>();
      const add = (place: DoordashPlaceView) => {
        if (seen.has(place.store_id)) return;
        seen.add(place.store_id);
        places.push(place);
      };
      const storeRows = stores && stores.ok ? stores.data.stores : [];
      const toStore = (row: DdNearby['stores'][number]): DoordashPlaceView => ({
        store_id: String(row.store_id),
        store_name: row.name,
        kind: 'store',
        etaText: row.delivery_time,
        miles: row.distance_meters === undefined ? undefined : Math.round((row.distance_meters / 1609) * 10) / 10,
      });
      // Named stores first: "wawa" should put Wawa at the top, not below five restaurants.
      if (!generic) {
        for (const row of storeRows) if (row.name && storeNameMatches(row.name, query)) add(toStore(row));
      }
      if (restaurants.ok) {
        for (const row of restaurants.data.stores) {
          add({ store_id: String(row.store_id), store_name: row.store_name, kind: 'restaurant' });
        }
      }
      if (generic) {
        for (const row of storeRows) if (row.name && deliversNow(row.delivery_time)) add(toStore(row));
      }
      // Ids and display names only, held for the in-flight order. This is what
      // lets a later turn say the place by name instead of by number.
      rememberDoordashContext(subject.userId, {
        // Preserve unnamed rows too: numbering must match the visible list.
        // rememberDoordashContext bounds this to the eight displayed rows.
        lastStores: places.map((place) => ({ storeId: place.store_id, storeName: place.store_name?.trim() || 'Place' })),
        namedStores: places.filter((place) => place.store_name?.trim())
          .map((place) => ({ storeId: place.store_id, storeName: place.store_name!.trim() })),
      });
      return { ok: true as const, data: { stores: places }, durationMs: Date.now() - startedAt };
    },
    /**
     * docs/ddcli-help/menu.txt: --store-id. A spoken name is accepted too,
     * resolved against the last search, because by the time the operator says
     * "menu for Rojas Pizza" the model can no longer see the id it was shown.
     * The resolved store and its menu id are remembered so the cart step does
     * not have to ask for them again.
     */
    async menu({ storeId, storeName, query }) {
      const startedAt = Date.now();
      rememberDoordashContext(subject.userId, { pendingItem: undefined });
      let context = recallDoordashContext(subject.userId);
      let resolvedId = storeId?.trim();
      let resolvedName = storeName?.trim();
      const askForStore = (matches: Array<{ storeId: string; storeName: string }>) => {
        const shown = matches.slice(0, 8);
        rememberDoordashContext(subject.userId, { lastStores: shown, menuSelection: undefined });
        const choices = shown.map((store, index) => `${index + 1}. ${cleanVendorText(store.storeName)}`).join('\n');
        return refuse('doordash_store_unresolved',
          `I found more than one matching place:\n${choices}\n\nWhich menu would you like? Say the place name or its number.`, startedAt);
      };
      if (!resolvedId) {
        const reference = resolveStoreReference(context, resolvedName ?? '');
        if (reference.kind === 'unresolved') {
          return refuse('doordash_store_unresolved',
            context.lastStores.length > 1
              ? 'Which place would you like? Say its name or the number from the latest list.'
              : 'Which restaurant do you mean? Tell me its name, or ask me to find some places first.', startedAt);
        }
        if (reference.kind === 'store') {
          resolvedId = reference.storeId;
          resolvedName = reference.storeName;
        } else {
          let matches = matchingStoresByName(context, resolvedName!);
          if (matches.length === 0) {
            // Direct named-menu discovery is not a displayed restaurant list.
            // Restore the prior browse state unless we explicitly show choices.
            const previous = context;
            const found = await searchUnlocked({ query: resolvedName! });
            const discovered = recallDoordashContext(subject.userId);
            matches = found.ok ? matchingStoresByName(discovered, resolvedName!) : [];
            if (matches.length > 1) return askForStore(matches);
            // An unresolved explicit restaurant switch invalidates deictic
            // fallback, including a single prior discovery hit. Its cart stays.
            rememberDoordashContext(subject.userId, matches.length === 1 ? {
              lastStores: previous.lastStores, namedStores: previous.namedStores, menuSelection: previous.menuSelection,
            } : { lastStores: [], menuSelection: undefined });
            context = previous;
            if (!found.ok) return found;
          }
          if (matches.length !== 1) {
            if (matches.length > 1) return askForStore(matches);
            return refuse('doordash_store_unresolved',
              'I could not find that place. What restaurant or kind of food would you like?', startedAt);
          }
          const match = matches[0]!;
          resolvedId = match.storeId;
          resolvedName = match.storeName;
        }
      }
      if (!resolvedId) {
        return refuse('doordash_store_unresolved',
          'Tell me which restaurant or store and I will pull the menu.', startedAt);
      }
      // When the caller gave an id rather than a name, recover the name from the
      // last search so the reply can say WHICH place this menu belongs to.
      resolvedName = (context.namedStores ?? context.lastStores).find((store) => store.storeId === resolvedId)?.storeName
        ?? (context.storeId === resolvedId ? context.storeName : undefined) ?? resolvedName;
      // The conversational target changes even if this fetch fails. A follow-up
      // retries the requested place; the existing cart stays at its old store.
      rememberDoordashContext(subject.userId, { menuSelection: { storeId: resolvedId, storeName: resolvedName } });
      const result = await runDdCli<DdMenu>('menu', [resolvedId]);
      if (!result.ok) return result;
      const sameStore = resolvedId === context.storeId;
      const lastItems: DoordashMenuItemRef[] = result.data.items
        .filter((item) => item.name)
        .map((item) => ({
          itemId: String(item.item_id),
          name: item.name!,
          hasModifiers: item.has_modifiers === true,
          hasRequired: item.has_required_modifiers === true,
        }));
      rememberDoordashContext(subject.userId, {
        menuSelection: { storeId: resolvedId, storeName: resolvedName },
        storeId: resolvedId,
        menuId: String(result.data.menu_id),
        storeName: resolvedName ?? (sameStore ? context.storeName : undefined),
        lastItems,
        pendingItem: undefined,
        // A DoorDash cart belongs to ONE store. Carrying the old cart uuid into a
        // new store would aim the next add at the wrong cart.
        ...(sameStore ? {} : { cartUuid: undefined }),
      });
      // A filter word ("hoagie", "soda") narrows a 150-item convenience-store
      // menu to what the operator asked about; the action shows at most 12.
      const needle = query?.trim().toLowerCase();
      const items = needle
        ? result.data.items.filter((item) => BEVERAGE_QUERY.test(needle)
          ? !!item.name && BEVERAGE_NAME.test(item.name) && !BEVERAGE_FOOD_NAME.test(item.name)
          : item.name?.toLowerCase().includes(needle)
            || needle.split(/\s+/).filter((w) => w.length > 2).some((w) => item.name?.toLowerCase().includes(w.replace(/s$/, ''))))
        : result.data.items;
      // Naming the store HERE catches a wrong resolution one turn earlier than
      // the priced confirmation does, which is worth a turn of the founder's
      // time when the alternative is ordering from the wrong restaurant.
      return { ...result, data: { ...result.data, items, storeName: resolvedName } };
    },
    // docs/ddcli-help/address-list.txt: native response has addresses[].
    async addresses() {
      const result = await runDdCli<{ addresses: DdAddress[] }>('address-list', []);
      return result.ok ? { ...result, data: result.data.addresses } : result;
    },

    async cartShow({ cartUuid }) {
      const startedAt = Date.now();
      const cart = cartUuid?.trim() || recallDoordashContext(subject.userId).cartUuid;
      if (!cart) return refuse('doordash_no_cart', 'You do not have a cart going right now.', startedAt);
      const result = await runDdCli<DdCart>('cart-show', [cart]);
      return result.ok ? { ...result, data: toCartView(result.data) } : result;
    },

    /**
     * Add ONE item. A partial write is surfaced, never swallowed: DoorDash
     * issue #64 documents that a batch can drop items while still exiting 0
     * with success true, so `droppedItems` is what the reply must report.
     */
    /**
     * Add by item NAME or id, with option choices in plain words.
     *
     * The model cannot see menu ids on a later turn (DoorDash output never
     * enters chat memory), so a name is resolved against the last menu here.
     * An item with required choices (a Wawa custom hoagie: bread, toasting,
     * cheese) is NOT added until every required group is answered: the reply
     * lists the groups, the item waits in `pendingItem`, and the next turn's
     * "classic roll, not toasted, provolone" is matched to option ids by
     * doordash-options.ts. The model never supplies an option id.
     */
    async cartAdd({ storeId, menuId, itemId, itemName, choices, quantity, cartUuid }) {
      const startedAt = Date.now();
      const context = recallDoordashContext(subject.userId);
      const choiceText = choices?.trim() ?? '';
      const cancel = (text: string) => /^(?:skip|cancel|forget) (?:that|this|the) item[.!?]*$/i.test(text.trim());
      if (context.pendingItem && cancel(choiceText) && cancel(requesterTurn)) {
        rememberDoordashContext(subject.userId, { pendingItem: undefined });
        return refuse('doordash_needs_choices', 'I skipped that item. Your cart has not changed. What would you like next?', startedAt);
      }
      const store = storeId?.trim() || context.storeId;
      const menuIdent = menuId?.trim() || context.menuId;
      if (!store || !menuIdent) {
        return refuse('doordash_no_menu',
          'Let me pull the menu up first, then I can add that.', startedAt);
      }
      if ((context.storeId && context.storeId !== store) || (context.menuId && context.menuId !== menuIdent)
        || (context.menuSelection && context.menuSelection.storeId !== store)
        || (cartUuid?.trim() && context.cartUuid && cartUuid.trim() !== context.cartUuid)) {
        rememberDoordashContext(subject.userId, { pendingItem: undefined });
        return refuse('doordash_no_menu', 'The restaurant or cart changed. Please open its menu before choosing an item.', startedAt);
      }
      if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1 || quantity > 20)) {
        return refuse('doordash_needs_choices', 'How many would you like? Choose a whole number from 1 to 20.', startedAt);
      }

      // Resolve WHICH item. An explicit id wins, then a spoken name, then the
      // item still waiting for its choices.
      let item: { itemId: string; name: string; hasModifiers: boolean; hasRequired: boolean } | undefined;
      const idGiven = itemId?.trim();
      if (idGiven) {
        const known = context.lastItems?.find((i) => i.itemId === idGiven);
        item = known ?? { itemId: idGiven, name: 'that item', hasModifiers: false, hasRequired: false };
      } else if (itemName?.trim()) {
        const match = resolveItemByName(context, itemName);
        if (!match) {
          rememberDoordashContext(subject.userId, { pendingItem: undefined });
          return refuse('doordash_item_unresolved',
            `I could not find ${cleanVendorText(itemName)} on the ${context.storeName ? cleanVendorText(context.storeName) : 'current'} menu. Ask me for the menu and I will list it.`,
            startedAt);
        }
        if ('choices' in match) {
          rememberDoordashContext(subject.userId, { pendingItem: undefined });
          return refuse('doordash_item_unresolved',
            `Which one: ${match.choices.map((n) => cleanVendorText(n)).join('; ')}?`, startedAt);
        }
        item = match.item;
      } else if (context.pendingItem) {
        const pending = context.pendingItem;
        if (pending.storeId !== store || pending.menuId !== menuIdent) {
          rememberDoordashContext(subject.userId, { pendingItem: undefined });
          return refuse('doordash_item_unresolved', 'The menu changed. Which item would you like?', startedAt);
        }
        item = context.lastItems?.find((i) => i.itemId === pending.itemId)
          ?? { itemId: pending.itemId, name: pending.name, hasModifiers: true, hasRequired: true };
      }
      if (!item) {
        return refuse('doordash_item_unresolved', 'Tell me which item and I will add it.', startedAt);
      }
      const pending = context.pendingItem?.itemId === item.itemId && context.pendingItem.storeId === store
        && context.pendingItem.menuId === menuIdent ? context.pendingItem : undefined;
      if (context.pendingItem && !pending) rememberDoordashContext(subject.userId, { pendingItem: undefined });
      const qty = quantity ?? pending?.quantity ?? 1;
      const cart = cartUuid?.trim() || context.cartUuid;

      // Items with choices go through the option list for THIS item.
      if (item.hasModifiers || item.hasRequired || choiceText || pending) {
        const details = await runDdCli<DdItemOptions>('item-options', [store, menuIdent, item.itemId]);
        if (!details.ok) return details;
        // Expiry during the vendor read cannot resurrect an old draft or cart.
        const current = recallDoordashContext(subject.userId);
        if (context.storeId && (current.storeId !== context.storeId || current.menuId !== context.menuId)) {
          return refuse('doordash_no_menu', 'That menu expired. Please open it again before adding an item.', startedAt);
        }
        const groups = details.data.item.extras;
        const reviewAnswer = pending?.stage === 'review' && isChoiceReviewConfirmation(choiceText)
          && isChoiceReviewConfirmation(requesterTurn);
        // The displayed review authorizes only its displayed quantity. A count
        // change gets another review even when the same turn says "add it".
        const completing = reviewAnswer && qty === pending.quantity;
        if (groups.length === 0 && (choiceText || pending)) {
          return refuse('doordash_needs_choices',
            'DoorDash does not offer those choices for this item. I have not added it. Would you like it as listed, or another item?', startedAt);
        }
        const withdrawing = !!pending?.choices.unresolvedRequest && isChoiceRequestWithdrawal(choiceText)
          && isChoiceRequestWithdrawal(requesterTurn);
        const priorChoices = withdrawing ? { ...pending!.choices, unresolvedRequest: false } : pending?.choices;
        const resolved = groups.length > 0 ? resolveChoices(groups, reviewAnswer || withdrawing ? '' : choiceText, priorChoices) : null;
        if (resolved && !resolved.ok) {
          rememberDoordashContext(subject.userId, {
            pendingItem: { storeId: store, menuId: menuIdent, itemId: item.itemId, name: item.name, quantity: qty,
              choices: resolved.draft, stage: 'choices' },
          });
          return refuse('doordash_needs_choices', describeGaps(item.name, resolved), startedAt);
        }
        if (pending && resolved?.ok && !completing) {
          rememberDoordashContext(subject.userId, {
            pendingItem: { storeId: store, menuId: menuIdent, itemId: item.itemId, name: item.name, quantity: qty,
              choices: resolved.draft, stage: 'review' },
          });
          return refuse('doordash_needs_choices',
            `${qty} × ${cleanVendorText(item.name)}${resolved.picked.length ? `: ${resolved.picked.join(', ')}` : ' as listed'}.\nAdd this to your cart? You can still tell me a change.`, startedAt);
        }
        // Optional-only choices with nothing picked falls through to a PLAIN
        // add: an empty nested_options list is refused by the strict validator.
        if (resolved && resolved.ok && resolved.nested.length > 0) {
          const args = [store, menuIdent, item.itemId, String(qty), JSON.stringify(resolved.nested)];
          if (cart) args.push(cart);
          // A failed or ambiguous vendor mutation must not leave a replayable
          // choice-only draft. The operator can inspect the cart afterwards.
          rememberDoordashContext(subject.userId, { pendingItem: undefined });
          await invalidateCartConfirmations();
          const result = await runDdCli<DdCart>('cart-add-options', args);
          if (!result.ok) return result;
          rememberDoordashContext(subject.userId, { cartUuid: result.data.cart_uuid, pendingItem: undefined });
          return { ...result, data: { ...toCartView(result.data), addedChoices: resolved.picked } };
        }
      }

      const args = [store, menuIdent, item.itemId, String(qty)];
      if (cart) args.push(cart);
      rememberDoordashContext(subject.userId, { pendingItem: undefined });
      await invalidateCartConfirmations();
      const result = await runDdCli<DdCart>('cart-add', args);
      if (result.ok) rememberDoordashContext(subject.userId, { cartUuid: result.data.cart_uuid, pendingItem: undefined });
      return result.ok ? { ...result, data: toCartView(result.data) } : result;
    },

    // docs/ddcli-help/cart-remove-item.txt: the LINE id from cart show, not the menu item id.
    async cartRemove({ cartUuid, lineId }) {
      const startedAt = Date.now();
      const cart = cartUuid?.trim() || recallDoordashContext(subject.userId).cartUuid;
      if (!cart) return refuse('doordash_no_cart', 'You do not have a cart going right now.', startedAt);
      await invalidateCartConfirmations();
      const result = await runDdCli<DdCart>('cart-remove', [cart, lineId]);
      return result.ok ? { ...result, data: toCartView(result.data) } : result;
    },

    /**
     * Price the cart and mint a confirmation code.
     *
     * Read-only at the vendor: --fulfillment is never passed, so preview does
     * not mutate the cart. The write here is ours, one `doordash_orders` row
     * holding the quoted total and a HASH of the code. Any previously live code
     * for this operator is voided first, so at most one confirmation can ever
     * be outstanding.
     */
    async preview({ cartUuid }) {
      const startedAt = Date.now();
      const pending = recallDoordashContext(subject.userId).pendingItem;
      if (pending) return refuse('doordash_needs_choices',
        `${cleanVendorText(pending.name)} is not in your cart yet. ${pending.stage === 'review'
          ? 'Add this item, change its choices, or say "skip that item".'
          : 'Finish its choices, or say "skip that item".'}`, startedAt);
      const cart = cartUuid?.trim() || recallDoordashContext(subject.userId).cartUuid;
      if (!cart) return refuse('doordash_no_cart', 'You do not have a cart going right now.', startedAt);
      const result = await runDdCli<DdPreview>('order-preview', [cart]);
      if (!result.ok) return result;
      const quote = result.data.quote;
      if (!result.data.quoteFingerprint) {
        return refuse('doordash_price_moved',
          'I could not verify the basket and delivery details, so I cannot issue a confirmation code. Check the cart in DoorDash.', startedAt);
      }

      // Terms of service section 8(f): the wrapper refuses age-restricted items.
      // Checked here because preview is the first point the vendor tells us.
      if (quote.contains_alcohol_item === true || (quote.min_age_requirement ?? 0) > 0) {
        return refuse('doordash_age_restricted',
          'That cart has an age restricted item in it, so I cannot place this order.', startedAt);
      }
      if (quote.delivery_availability?.is_within_delivery_region === false) {
        return refuse('doordash_undeliverable',
          'That restaurant does not deliver to the saved address.', startedAt);
      }

      const totalBeforeTipCents = quote.total_before_tip.unit_amount;
      if (totalBeforeTipCents < 0) {
        return refuse('doordash_price_moved', 'DoorDash returned a total I could not read.', startedAt);
      }
      // Advisory cap read. The authoritative one runs inside the submit
      // transaction; refusing early just saves the founder a dead-end confirm.
      const usage = await todaysUsage(db, subject.userId);
      const capReason = capRefusal(usage, totalBeforeTipCents);
      if (capReason) return refuse('doordash_cap_exceeded', capReason, startedAt);

      const confirmCode = mintConfirmCode();
      await db.transaction(async (tx) => {
        // A new price voids any outstanding code: one live confirmation at a
        // time. Scoped to THIS subject kind on purpose. Both paths resolve to
        // the same operator id, so an unscoped void would let a hosted agent's
        // preview silently kill the code the founder is holding — and the
        // agent's own code never reaches him, because the gateway reply goes
        // to the agent. Sharing the CART is the intended handoff; sharing the
        // confirmation slot is not.
        await tx.update(doordashOrders)
          .set({ status: 'refused', failureCode: 'superseded' })
          .where(and(
            eq(doordashOrders.userId, subject.userId),
            eq(doordashOrders.subjectKind, subject.kind),
            eq(doordashOrders.status, 'previewed'),
          ));
        await tx.insert(doordashOrders).values({
          userId: subject.userId,
          avatarId: subject.avatarId,
          subjectKind: subject.kind,
          cartUuid: result.data.cart_uuid,
          status: 'previewed',
          totalCents: totalBeforeTipCents,
          confirmCodeHash: hashConfirmCode(confirmCode),
          quoteFingerprint: result.data.quoteFingerprint,
        });
      });

      // Itemise the basket. The founder is about to authorise a real charge, and
      // a confirmation that shows only "Subtotal $19.00" is a confirmation of a
      // number, not of an order. Anything the agent put in the cart has to be
      // visible at the moment the code is typed, not merely present in a total.
      const storeName = quote.store_order_cart?.store?.name;
      const items = (quote.store_order_cart?.orders ?? [])
        .flatMap((order) => order.order_items ?? [])
        .map((entry) => ({
          name: entry.item?.name ?? 'item',
          quantity: entry.quantity ?? 1,
        }));

      const lines = (quote.line_items ?? [])
        .filter((line) => line.final_money !== undefined)
        .map((line) => ({
          label: line.label ?? line.charge_id ?? 'Charge',
          amount: line.final_money?.display_string ?? formatUsd(line.final_money?.unit_amount ?? 0),
        }));
      const tipSuggestionsCents = (result.data.tip?.options ?? [])
        .map((option) => option.amount_cents)
        .filter((cents) => Number.isSafeInteger(cents) && cents >= 0)
        .slice(0, 4);

      return {
        ok: true,
        durationMs: Date.now() - startedAt,
        data: {
          items,
          storeName,
          lines,
          totalBeforeTipCents,
          etaText: quote.delivery_availability?.asap_minutes_range_string,
          tipSuggestionsCents,
          confirmCode,
          expiresInMinutes: Math.round(DOORDASH_CAPS.previewTtlMs / 60000),
        },
      };
    },

    /**
     * Place the order. THE ONLY METHOD HERE THAT SPENDS MONEY.
     *
     * Note what this does NOT take: a cart uuid. The cart comes from the
     * previewed row, so a model holding a valid confirmation cannot point it at
     * a different cart than the one the founder was quoted.
     */
    async submit({ confirm, tipCents }) {
      const startedAt = Date.now();

      // 1. Authority. The agent path prepares; only the human path may submit.
      if (!subject.canSubmit) {
        // Worth a page. Ordinary refusals (a mistyped code, a stale price) are
        // the founder's own typos and paging on those would be pure noise, so
        // this deviates from the spec's "page on every attempt" deliberately.
        // An AGENT reaching for submit is different in kind: it is the
        // authority boundary being tested, and it should never happen twice
        // without someone knowing about it.
        void alertError({
          severity: 'warning', source: 'doordash-submit',
          message: 'An agent session attempted to place a DoorDash order. Refused: submit is human-only.',
        }).catch(() => {});
        return refuse('doordash_submit_forbidden',
          'I can get the order ready, but you have to place it yourself from the game chat.', startedAt);
      }
      // 2 and 3. The code must be well formed AND present in the HUMAN's own
      // turn. This is the check a model cannot satisfy by echoing its own reply.
      if (!isWellFormedConfirmCode(confirm) || !codeStatedByRequester(requesterTurn, confirm)) {
        return refuse('doordash_confirm_invalid',
          'I need you to type the confirmation code yourself before I can place the order.', startedAt);
      }
      // 4. The tip likewise comes from the human, never from the model. The
      //    code is MASKED OUT of the turn first: its alphabet contains digits,
      //    so an unmasked turn would hand the model a tip amount on every
      //    order ("yes K7Y46D" would authorise a $46 tip).
      if (!Number.isSafeInteger(tipCents) || tipCents < 0 || tipCents > 99999
        || !tipStatedByRequester(maskConfirmCode(requesterTurn, confirm), tipCents)) {
        return refuse('doordash_confirm_invalid',
          'Reply with the confirmation code and a clear tip, such as "tip 4" for $4 or "no tip".', startedAt);
      }
      // 5. Never start a money command while the integration is dark.
      if (!isDoordashAvailable()) {
        return refuse('ddcli_darkened', 'DoorDash is unavailable right now.', startedAt);
      }

      // 6. The quoted row. Matched by HASH: the plaintext code is never stored.
      const hash = hashConfirmCode(confirm);
      const [row] = await db.select().from(doordashOrders)
        .where(and(
          eq(doordashOrders.userId, subject.userId),
          eq(doordashOrders.status, 'previewed'),
          eq(doordashOrders.confirmCodeHash, hash),
        ))
        .limit(1);
      if (!row) {
        return refuse('doordash_confirm_invalid',
          'That confirmation code does not match the order I priced.', startedAt);
      }
      if (!row.quoteFingerprint) {
        await db.update(doordashOrders).set({ status: 'refused', failureCode: 'quote_identity_missing' })
          .where(eq(doordashOrders.id, row.id));
        return refuse('doordash_price_moved',
          'That confirmation predates the basket check. Ask me to check the total again.', startedAt);
      }
      // 7. Time to live.
      if (Date.now() - new Date(row.previewedAt).getTime() > DOORDASH_CAPS.previewTtlMs) {
        await db.update(doordashOrders)
          .set({ status: 'refused', failureCode: 'expired' })
          .where(eq(doordashOrders.id, row.id));
        return refuse('doordash_confirm_expired',
          'That price is too old to use now. Ask me to check the total again.', startedAt);
      }

      // 8. Re-price. Any movement at all voids the code. Cheaper counts too,
      //    because a changed total means a changed cart.
      //
      // WHY THE RE-PRICE COMES BEFORE THE CLAIM, and not after. The tempting
      // argument is that claiming first would shrink the gap between verifying
      // the price and charging the card. It would, by roughly the duration of
      // one database transaction, and it is the wrong trade.
      //
      // The re-price exists to catch drift across the TEN MINUTE confirmation
      // window, which is where real drift happens. The gap between the check
      // and the charge is irreducible in either ordering — DoorDash prices at
      // charge time, not at check time — so shrinking it from milliseconds to
      // fewer milliseconds buys almost nothing.
      //
      // Claiming first would move a multi-second subprocess call INSIDE the
      // window where the row is already marked `submitting`. A crash or a
      // container flip in that window strands a row that permanently consumes
      // one of two daily orders and up to $75 of the daily budget, for an order
      // that was never placed, with no automatic recovery in this phase. That
      // failure is larger, lasts longer, and costs the founder something real.
      // Keeping the claim last makes the claim-to-spend window as small as it
      // can be, which is the window that actually matters.
      //
      // The per-operator workflow mutex below covers the WHOLE re-price/claim/
      // submit sequence against this process's cart mutations. The CLI mutex
      // alone covers only one subprocess and cannot provide that guarantee.
      //
      // DO NOT take the adjacent step of moving the re-price INSIDE the claim
      // transaction. That puts a 45 second subprocess under an advisory lock
      // and a FOR UPDATE row lock, held across the transaction pooler. This
      // repo has two recorded wedges of exactly that shape.
      const reprice = await runDdCli<DdPreview>('order-preview', [row.cartUuid]);
      if (!reprice.ok) return reprice;
      // The age gate is re-run on the FRESH quote, not trusted from preview.
      // The price check alone does not cover it: swapping an item for an
      // equally priced age-restricted one leaves total_before_tip identical,
      // so an unchecked submit would place an order the terms forbid.
      const fresh = reprice.data.quote;
      if (!reprice.data.quoteFingerprint || reprice.data.quoteFingerprint !== row.quoteFingerprint) {
        await db.update(doordashOrders).set({ status: 'refused', failureCode: 'cart_changed' })
          .where(eq(doordashOrders.id, row.id));
        return refuse('doordash_price_moved',
          'The basket or delivery details changed since I quoted them. Ask me to check the total again.', startedAt);
      }
      if (fresh.contains_alcohol_item === true || (fresh.min_age_requirement ?? 0) > 0) {
        await db.update(doordashOrders)
          .set({ status: 'refused', failureCode: 'age_restricted' })
          .where(eq(doordashOrders.id, row.id));
        return refuse('doordash_age_restricted',
          'That cart has an age restricted item in it, so I cannot place this order.', startedAt);
      }
      if (reprice.data.quote.total_before_tip.unit_amount !== row.totalCents) {
        await db.update(doordashOrders)
          .set({ status: 'refused', failureCode: 'price_moved' })
          .where(eq(doordashOrders.id, row.id));
        return refuse('doordash_price_moved',
          'The total changed since I quoted it, so I stopped. Ask me to price it again.', startedAt);
      }

      const chargeCents = row.totalCents + tipCents;

      // FEATURE_GATE: doordash_submitting_reconcile
      // Status: a row can be left in `submitting` forever if the process dies
      //   between the claim below and the status write after the spend. It is
      //   counted against the daily caps (deliberately — it may have charged),
      //   so a stranded row silently costs the operator one of two daily orders
      //   and up to $75 of the daily budget until someone edits the row by hand.
      //   The window is one subprocess call wide and there is no sweeper.
      // Metric to graduate: zero unresolvable rows observed across the first 10
      //   real submits, counting BOTH shapes the Phase 3 sweeper would repair:
      //   (a) stranded claims — status='submitting' AND confirmed_at < now() - interval '15 minutes'
      //   (b) charges with no handle — status='failed' AND order_uuid IS NULL
      //   A submitted order is recorded in the 2026-09-18 session (dd log
      //   8110/8117/8123). Shape (b) remains possible: the history probe cannot help after a
      //   killed child (the next call is refused until it reaps) nor when
      //   DoorDash omits a just-placed order from history (vendor issue #67).
      // Current reading: one submit is recorded in the 2026-09-18 session;
      //   stranded/ambiguous production counts are unmeasured in this audit.
      // Review deadline: 2026-11-16 (same as doordash_operator_beta).
      // On deadline: if any stranded row has been seen, Phase 3 must ship the
      //   reconcile sweeper described in the spec section 8.3 before the caps
      //   can be trusted. If none has, re-read at the next 10 submits.
      // Reference: .claude/plans/doordash-cli-integration.md section 8.3.
      //
      // 9. Claim the row. Serialized twice, per the repo's money convention: an
      //    in-process mutex, then a transaction-scoped advisory lock on this
      //    operator, with the cap read INSIDE the transaction that claims it.
      //    A second concurrent submit finds status 'submitting' and stops.
      const claim = await withKeyedMutex('doordash-submit', async () => db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`doordash-submit:${subject.userId}`}, 0))`);
        const [locked] = await tx.select().from(doordashOrders)
          .where(and(eq(doordashOrders.id, row.id), eq(doordashOrders.status, 'previewed')))
          .for('update')
          .limit(1);
        if (!locked) {
          return { claimed: false as const, cap: false, reason: 'That order was already being placed.' };
        }
        if (Date.now() - new Date(locked.previewedAt).getTime() > DOORDASH_CAPS.previewTtlMs) {
          await tx.update(doordashOrders).set({ status: 'refused', failureCode: 'expired' })
            .where(eq(doordashOrders.id, locked.id));
          return { claimed: false as const, cap: false, reason: 'That price is too old to use now.' };
        }
        const usage = await todaysUsage(tx as unknown as SqlExecutor, subject.userId);
        const capReason = capRefusal(usage, chargeCents);
        if (capReason) {
          await tx.update(doordashOrders).set({ status: 'refused', failureCode: 'cap_exceeded' })
            .where(eq(doordashOrders.id, locked.id));
          return { claimed: false as const, cap: true, reason: capReason };
        }
        await tx.update(doordashOrders)
          .set({ status: 'submitting', tipCents, confirmedAt: new Date() })
          .where(eq(doordashOrders.id, locked.id));
        return { claimed: true as const, cap: false, reason: '' };
      }));
      if (!claim.claimed) {
        return refuse(claim.cap ? 'doordash_cap_exceeded' : 'doordash_confirm_invalid',
          claim.reason, startedAt);
      }

      // 10. Spend. Everything past this line may already have charged the card.
      const submitted = await runDdCli<DdSubmit>('order-submit', [row.cartUuid, String(tipCents)]);

      if (submitted.ok) {
        // The vendor's own documented success carries `processing_status: ""`,
        // and its wording is "Order submitted; awaiting processing result" —
        // accepted for processing, NOT placed. So an unfamiliar value here is
        // not something to report as a completed order. The first real order
        // succeeded on 2026-09-18; that does not prove every vendor status.
        // An unknown value still fails toward "I do not know".
        //
        // The order uuid is RECORDED EITHER WAY. It is the only handle that can
        // resolve what really happened, via `order status`, and throwing it
        // away is what turns an ambiguous outcome into an unanswerable one.
        const processing = (submitted.data.processing_status ?? '').trim();
        if (processing !== '') {
          await db.update(doordashOrders)
            .set({
              status: 'failed',
              failureCode: `processing:${processing.slice(0, 40)}`,
              orderUuid: submitted.data.order_uuid,
              submittedAt: new Date(),
            })
            .where(eq(doordashOrders.id, row.id));
          clearDoordashCart(subject.userId);
          void alertError({
            severity: 'critical', source: 'doordash-submit',
            message: `submit returned an unrecognised processing status for order row ${row.id}; the card may or may not have been charged`,
          }).catch(() => {});
          return refuse('doordash_submit_ambiguous',
            'DoorDash took the order but did not confirm it went through. Check the DoorDash app before ordering again. I will not retry it by myself.',
            startedAt);
        }
        await db.update(doordashOrders)
          .set({ status: 'submitted', orderUuid: submitted.data.order_uuid, submittedAt: new Date() })
          .where(eq(doordashOrders.id, row.id));
        clearDoordashCart(subject.userId);
        void sendTelegramText(
          `DoorDash order placed: ${formatUsd(chargeCents)} including a ${formatUsd(tipCents)} tip. Order ${submitted.data.order_uuid}.`,
        ).catch(() => {});
        return {
          ok: true, durationMs: Date.now() - startedAt,
          data: { orderUuid: submitted.data.order_uuid, totalCents: row.totalCents, tipCents },
        };
      }

      // Some failures prove the command never ran at all. `runDdCli` refuses
      // BEFORE spawning when the dark latch is set, the binary is missing,
      // a previous child has not reaped, the arguments are rejected, or the
      // version probe fails — and a version mismatch can only come from that
      // probe, since submit never version-checks itself. No spawn means no
      // charge, so these must NOT burn a daily order or page the founder about
      // a card that was never touched. The cart survives too: it is still good.
      const neverSpawned: readonly DoordashFailure[] = [
        'ddcli_darkened', 'ddcli_unavailable', 'ddcli_version_mismatch',
      ];
      if (neverSpawned.includes(submitted.failure)) {
        await db.update(doordashOrders)
          .set({ status: 'refused', failureCode: submitted.failure })
          .where(eq(doordashOrders.id, row.id));
        return refuse('ddcli_unavailable',
          'I could not reach DoorDash, so nothing was ordered. Try again in a moment.', startedAt);
      }

      // Anything else did reach the spawn, so we do NOT know whether DoorDash
      // placed it: a timeout or an unreadable response can both follow a real
      // charge. The row is terminal and is NEVER retried automatically. Same
      // discipline as every other money path here, capture before send and
      // treat ambiguity as something to reconcile rather than resend.
      //
      // THIS BRANCH HAS NO ORDER UUID. `submitted` is an error result, so
      // nothing parsed and there is no handle to record. A future response
      // shape change can still follow a real charge. Leave a human enough
      // evidence to match the attempt against the DoorDash app.
      const failedAt = new Date();
      const storeName = recallDoordashContext(subject.userId).storeName;

      // Best effort only, and recorded AS best effort. Two independent reasons
      // this probe often cannot help: after a killed child, `runDdCli` refuses
      // the next call until the child reaps, which is exactly the timeout case;
      // and DoorDash issue #67 reports that `order history` omits orders it has
      // just placed. So a miss here is uninformative, and it must never be
      // written down as if it were an answer.
      let candidate: string | null = null;
      let probeFailed = false;
      const history = await runDdCli<{ orders: DdOrderSummary[] }>('order-history', []);
      if (!history.ok) {
        probeFailed = true;
      } else {
        const newest = history.data.orders?.[0]?.order_uuid ?? null;
        if (newest) {
          // Skip a uuid we have already recorded as some other row's order. That
          // filter is cheap and catches the obvious wrong answer, but it is NOT
          // sufficient, which is why the result below is only ever a candidate.
          const [claimedElsewhere] = await db.select({ id: doordashOrders.id })
            .from(doordashOrders).where(eq(doordashOrders.orderUuid, newest)).limit(1);
          if (!claimedElsewhere) candidate = newest;
        }
      }

      // A GUESS MUST NOT LIVE IN `order_uuid`. That column means "this row IS
      // that order", and every later reader treats it that way, including the
      // gate metric below. The probe cannot support that claim: with two
      // ambiguous submits in a row, the second probe sees the FIRST order as
      // newest, and the dedupe above cannot tell — row A's uuid is NULL, which
      // is precisely why we are here. Attaching it would make row B assert it
      // is order A, and leave A unresolved forever. There is no timestamp to
      // gate on either: order history rows carry no temporal field we read.
      //
      // So the candidate goes in `failure_code` as a lead to check, `order_uuid`
      // stays NULL, and the gate metric keeps measuring what it claims to.
      const suffix = candidate
        ? `+candidate:${candidate}`
        : (probeFailed ? '+unrecovered' : '+nohandle');
      await db.update(doordashOrders)
        .set({
          status: 'failed',
          failureCode: `${submitted.failure}${suffix}`.slice(0, 120),
          submittedAt: failedAt,
        })
        .where(eq(doordashOrders.id, row.id));
      // The cart is spent either way: it may have been charged. Reusing it would
      // either duplicate a real order or price a cart that no longer exists.
      clearDoordashCart(subject.userId);
      // The alert has to be matchable against the DoorDash app BY A PERSON. A
      // row id is meaningless there. An amount, a restaurant and a time are not.
      void alertError({
        severity: 'critical', source: 'doordash-submit',
        message: `DoorDash submit unresolved (${submitted.failure}${suffix}). The card MAY have been charged.`
          + ` Check the DoorDash app for a ${formatUsd(chargeCents)} order`
          + `${storeName ? ` from ${storeName}` : ''}`
          + ` (tip ${formatUsd(tipCents)}) placed around ${failedAt.toISOString()}.`
          + ` Cart ${row.cartUuid}. Order row ${row.id}.`
          + `${candidate
            ? ` A POSSIBLE match is order ${candidate} — confirm it in the app before trusting it; it may be an earlier order.`
            : ' No order id was recoverable.'}`,
      }).catch(() => {});
      return refuse('doordash_submit_ambiguous',
        'I could not confirm whether that order went through. Check the DoorDash app before ordering again. I will not retry it by myself.',
        startedAt);
    },

    // docs/ddcli-help/order-status.txt: --order-uuid.
    // With no id, the operator's most recent PLACED order. The model can never
    // quote an order id: DoorDash output is kept out of chat memory, so "where
    // is my order?" arrives with nothing to pass (founder, 2026-09-18).
    async orderStatus({ orderUuid }) {
      const startedAt = Date.now();
      let target = orderUuid?.trim();
      if (!target) {
        const rows = await db
          .select({ orderUuid: doordashOrders.orderUuid })
          .from(doordashOrders)
          .where(and(eq(doordashOrders.userId, subject.userId), sql`${doordashOrders.orderUuid} IS NOT NULL`))
          .orderBy(sql`${doordashOrders.submittedAt} DESC NULLS LAST`)
          .limit(1);
        target = rows[0]?.orderUuid ?? undefined;
      }
      if (!target) return refuse('doordash_no_order', 'You have not placed a DoorDash order here yet.', startedAt);
      return runDdCli<DdOrderStatus>('order-status', [target]);
    },
    // docs/ddcli-help/order-history.txt: native response has orders[].
    async orderHistory() {
      const result = await runDdCli<{ orders: DdOrderSummary[] }>('order-history', []);
      return result.ok ? { ...result, data: result.data.orders } : result;
    },
  };
  // Serialize complete cart workflows for the current single API process.
  // These methods do not call each other; the mutex is not reentrant.
  // This does not coordinate another environment or the DoorDash app. Spend
  // claims retain the database lock above, independent of this workflow lock.
  const workflowKey = `doordash-cart:${subject.userId}`;
  const { search: searchUnlocked, menu, cartAdd, cartRemove, preview, submit } = bridge;
  bridge.search = (input) => withKeyedMutex(workflowKey, () => searchUnlocked(input));
  bridge.menu = (input) => withKeyedMutex(workflowKey, () => menu(input));
  bridge.cartAdd = (input) => withKeyedMutex(workflowKey, () => cartAdd(input));
  bridge.cartRemove = (input) => withKeyedMutex(workflowKey, () => cartRemove(input));
  bridge.preview = (input) => withKeyedMutex(workflowKey, () => preview(input));
  bridge.submit = (input) => withKeyedMutex(workflowKey, () => submit(input));
  return bridge;
}
