import { and, db, doordashOrders, eq, sql } from '@clawville/database';
import { alertError, sendTelegramText } from './alert-error';
import { DOORDASH_CAPS, capRefusal, formatUsd } from './doordash-caps';
import {
  runDdCli,
  isDoordashAvailable,
  type DdAddress,
  type DdCart,
  type DdCliFailure,
  type DdMenu,
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
  resolveStoreByName,
} from './doordash-session';
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
  | 'doordash_no_cart';

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
  search(q: { query: string }): Promise<DoordashResult<DdSearchResult>>;
  menu(q: { storeId?: string; storeName?: string }): Promise<DoordashResult<DdMenu & { storeName?: string }>>;
  addresses(): Promise<DoordashResult<DdAddress[]>>;
  // The cart and store ids are OPTIONAL because the model cannot see them
  // across turns: DoorDash output is stripped from chat memory by design. When
  // omitted they come from the operator's in-flight context (doordash-session).
  cartShow(q: { cartUuid?: string }): Promise<DoordashResult<DoordashCartView>>;
  cartAdd(q: {
    storeId?: string; menuId?: string; itemId: string; quantity: number; cartUuid?: string;
  }): Promise<DoordashResult<DoordashCartView>>;
  cartRemove(q: { cartUuid?: string; lineId: string }): Promise<DoordashResult<DoordashCartView>>;
  preview(q: { cartUuid?: string }): Promise<DoordashResult<DoordashPreviewView>>;
  submit(q: { confirm: string; tipCents: number }): Promise<DoordashResult<DoordashSubmitView>>;
  orderStatus(q: { orderUuid: string }): Promise<DoordashResult<DdOrderStatus>>;
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
  if (!result.ok) return addressCache?.id ?? null; // Keep a stale id over none.
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
  return {
    subject,
    requesterTurn,
    // Values only; the wrapper owns flags and validation (docs/ddcli-help/search.txt).
    // The default saved address is resolved first: without it the vendor searches
    // Cupertino, CA and returns an empty list (confirmed on staging 2026-09-17).
    // A resolution failure is NOT fatal: we fall back to an unanchored search
    // rather than denying the operator a result, since the vendor still answers.
    async search({ query }) {
      const addressId = await defaultAddressId();
      const result = await runDdCli<DdSearchResult>('search', addressId ? [query, addressId] : [query]);
      if (result.ok) {
        // Ids and display names only, held for the in-flight order. This is what
        // lets a later turn say the restaurant by name instead of by number.
        rememberDoordashContext(subject.userId, {
          lastStores: result.data.stores
            .filter((store) => store.store_name)
            .map((store) => ({ storeId: String(store.store_id), storeName: store.store_name! })),
        });
      }
      return result;
    },
    /**
     * docs/ddcli-help/menu.txt: --store-id. A spoken name is accepted too,
     * resolved against the last search, because by the time the operator says
     * "menu for Rojas Pizza" the model can no longer see the id it was shown.
     * The resolved store and its menu id are remembered so the cart step does
     * not have to ask for them again.
     */
    async menu({ storeId, storeName }) {
      const startedAt = Date.now();
      const context = recallDoordashContext(subject.userId);
      let resolvedId = storeId?.trim();
      let resolvedName = storeName?.trim();
      if (!resolvedId && resolvedName) {
        const match = resolveStoreByName(context, resolvedName);
        if (!match) {
          return refuse('doordash_store_unresolved',
            'I am not sure which restaurant you mean. Ask me to search for it and I will pull the menu.',
            startedAt);
        }
        resolvedId = match.storeId;
        resolvedName = match.storeName;
      }
      if (!resolvedId) {
        return refuse('doordash_store_unresolved',
          'Tell me which restaurant and I will pull the menu.', startedAt);
      }
      // When the caller gave an id rather than a name, recover the name from the
      // last search so the reply can say WHICH restaurant this menu belongs to.
      if (!resolvedName) {
        resolvedName = context.lastStores.find((store) => store.storeId === resolvedId)?.storeName;
      }
      const result = await runDdCli<DdMenu>('menu', [resolvedId]);
      if (!result.ok) return result;
      rememberDoordashContext(subject.userId, {
        storeId: resolvedId,
        menuId: String(result.data.menu_id),
        storeName: resolvedName ?? context.storeName,
      });
      // Naming the store HERE catches a wrong resolution one turn earlier than
      // the priced confirmation does, which is worth a turn of the founder's
      // time when the alternative is ordering from the wrong restaurant.
      return { ...result, data: { ...result.data, storeName: resolvedName } };
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
    async cartAdd({ storeId, menuId, itemId, quantity, cartUuid }) {
      const startedAt = Date.now();
      const context = recallDoordashContext(subject.userId);
      const store = storeId?.trim() || context.storeId;
      const menuIdent = menuId?.trim() || context.menuId;
      if (!store || !menuIdent) {
        return refuse('doordash_no_menu',
          'Let me pull the menu up first, then I can add that.', startedAt);
      }
      const cart = cartUuid?.trim() || context.cartUuid;
      const args = [store, menuIdent, itemId, String(quantity)];
      if (cart) args.push(cart);
      const result = await runDdCli<DdCart>('cart-add', args);
      if (result.ok) rememberDoordashContext(subject.userId, { cartUuid: result.data.cart_uuid });
      return result.ok ? { ...result, data: toCartView(result.data) } : result;
    },

    // docs/ddcli-help/cart-remove-item.txt: the LINE id from cart show, not the menu item id.
    async cartRemove({ cartUuid, lineId }) {
      const startedAt = Date.now();
      const cart = cartUuid?.trim() || recallDoordashContext(subject.userId).cartUuid;
      if (!cart) return refuse('doordash_no_cart', 'You do not have a cart going right now.', startedAt);
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
      const cart = cartUuid?.trim() || recallDoordashContext(subject.userId).cartUuid;
      if (!cart) return refuse('doordash_no_cart', 'You do not have a cart going right now.', startedAt);
      const result = await runDdCli<DdPreview>('order-preview', [cart]);
      if (!result.ok) return result;
      const quote = result.data.quote;

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
          'Tell me the tip amount in your own message and I will place the order.', startedAt);
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
      // The window is also CLOSED to the only actor who could exploit it. The
      // sole ways to change a cart are `cart-add` and `cart-remove`, and both
      // queue on the same `doordash-cli` keyed mutex this submit is waiting on,
      // so a cart mutation cannot interleave with the spawn — it can only land
      // before the re-price or after the charge.
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
      //   Shape (b) is the likelier one: the submit response has never been
      //   captured live, and the inline history probe cannot help after a
      //   killed child (the next call is refused until it reaps) nor when
      //   DoorDash omits a just-placed order from history (vendor issue #67).
      // Current reading: 0 real submits, so unmeasured.
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
        // not something to report as a completed order. We have never captured
        // a real submit response, which is exactly why an unknown value fails
        // toward "I do not know" instead of toward "done".
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
      // nothing parsed and there is no handle to record. That matters more than
      // it looks: the submit response shape has never been captured live, so a
      // schema mismatch is the single most likely outcome of the FIRST real
      // order, and it lands here. Everything below exists to leave a human
      // something to match against.
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
    orderStatus: ({ orderUuid }) => runDdCli<DdOrderStatus>('order-status', [orderUuid]),
    // docs/ddcli-help/order-history.txt: native response has orders[].
    async orderHistory() {
      const result = await runDdCli<{ orders: DdOrderSummary[] }>('order-history', []);
      return result.ok ? { ...result, data: result.data.orders } : result;
    },
  };
}
