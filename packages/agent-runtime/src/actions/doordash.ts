import { getParam, type Action, type ActionResult } from './types';

// Structural mirrors of chunk 1's validated results. Never import apps/api here.
type DdCliResult<T> =
  | { ok: true; data: T; durationMs: number }
  | { ok: false; failure: string; detail: string; reason?: string; durationMs: number };
type DdId = string | number;

/** Our own view shapes, built by the bridge. No vendor prose reaches this file. */
interface DdCartView {
  cartUuid: string;
  storeName?: string;
  items: Array<{ lineId: string; name?: string; quantity: number; unitPriceCents?: number }>;
  droppedItems: number;
  addedChoices?: string[];
}
interface DdPreviewView {
  items: Array<{ name: string; quantity: number }>;
  storeName?: string;
  lines: Array<{ label: string; amount: string }>;
  totalBeforeTipCents: number;
  etaText?: string;
  tipSuggestionsCents: number[];
  confirmCode: string;
  expiresInMinutes: number;
}
interface DdSubmitView { orderUuid: string; totalCents: number; tipCents: number }

export interface DoordashReadOnlyBridge {
  addresses(): Promise<DdCliResult<Array<{
    address_id: DdId; printable_address: string; label?: string | null; is_default?: boolean;
  }>>>;
  search(q: { query: string }): Promise<DdCliResult<{
    stores: Array<{ store_id: DdId; store_name?: string; kind?: 'restaurant' | 'store'; etaText?: string; miles?: number }>;
  }>>;
  menu(q: { storeId?: string; storeName?: string; query?: string }): Promise<DdCliResult<{
    menu_id: DdId; items: Array<{ item_id: DdId; name?: string; has_required_modifiers?: boolean }>; storeName?: string;
  }>>;
  orderHistory(): Promise<DdCliResult<Array<{
    order_uuid: string; store_id: DdId; store_name?: string;
  }>>>;
  orderStatus(q: { orderUuid?: string }): Promise<DdCliResult<{
    order_uuid?: string; status: string; merchant_name?: string; quoted_delivery_time?: string;
  }>>;
}
/** Phase 2 adds the cart, the priced preview, and the one method that spends money. */
export interface DoordashOrderingBridge extends DoordashReadOnlyBridge {
  // Ids are optional: the server keeps the in-flight order context, because
  // DoorDash output never enters chat memory and so cannot be recalled later.
  cartShow(q: { cartUuid?: string }): Promise<DdCliResult<DdCartView>>;
  cartAdd(q: {
    storeId?: string; menuId?: string; itemId?: string; itemName?: string; choices?: string;
    quantity?: number; cartUuid?: string;
  }): Promise<DdCliResult<DdCartView>>;
  cartRemove(q: { cartUuid?: string; lineId: string }): Promise<DdCliResult<DdCartView>>;
  preview(q: { cartUuid?: string }): Promise<DdCliResult<DdPreviewView>>;
  submit(q: { confirm: string; tipCents: number }): Promise<DdCliResult<DdSubmitView>>;
}
type DoordashBridge = DoordashOrderingBridge;

const failures: Record<string, string> = {
  ddcli_unavailable: 'DoorDash is not available right now.',
  ddcli_version_mismatch: 'DoorDash needs an integration update before it can respond.',
  ddcli_auth_expired: 'DoorDash needs a fresh sign-in.',
  ddcli_timeout: 'DoorDash took too long to respond. Please try again later.',
  ddcli_output_too_large: 'DoorDash returned too much information. Please request fewer details.',
  ddcli_bad_json: 'I could not read the DoorDash response. Please try again later.',
  ddcli_nonzero: 'DoorDash could not complete that request. Please try again later.',
  ddcli_darkened: 'DoorDash is paused until the account owner restores access.',
  // Phase 2 refusals. Each of these normally arrives with a server-authored
  // `reason` that says more; these are the fallbacks if one is ever missing.
  doordash_submit_forbidden: 'You have to place the order yourself from the game chat.',
  doordash_confirm_invalid: 'I could not match that confirmation, so I did not place anything.',
  doordash_confirm_expired: 'That price is too old to use now.',
  doordash_cap_exceeded: 'That order is over the spending limit you set.',
  doordash_price_moved: 'The total changed since I quoted it, so I stopped.',
  doordash_age_restricted: 'I cannot order age restricted items.',
  doordash_undeliverable: 'That restaurant does not deliver to the saved address.',
  doordash_submit_ambiguous: 'I could not confirm whether that order went through.',
  doordash_store_unresolved: 'I am not sure which restaurant you mean.',
  doordash_no_menu: 'Let me pull the menu up first, then I can add that.',
  doordash_no_cart: 'You do not have a cart going right now.',
  doordash_item_unresolved: 'I could not find that item on the menu.',
  doordash_needs_choices: 'That item needs your choices before I can add it.',
  doordash_no_order: 'You have not placed a DoorDash order here yet.',
};

// Addendum sections 6.2/6.4: display only; never retain CLI data in chat memory.
// replacesReply: the order flow is read at a glance. A persona paragraph in
// front of "Total before tip $12.40 ... code M63C7A" buried it (founder, 2026-09-18).
function ephemeral(success: boolean, text: string): ActionResult {
  return { success, text, persist: false, replacesReply: true };
}

function field(value: string | number | null | undefined, fallback: string): string {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 160) : fallback;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function list<T>(title: string, rows: T[], empty: string, render: (row: T) => string, max = 5): string {
  if (rows.length === 0) return empty;
  const shown = rows.slice(0, max).map(render).join('; ');
  const remainder = rows.length > max ? ` ${rows.length - max} more results are not shown.` : '';
  return `${title}: ${shown}.${remainder}`;
}

async function lookup<T>(call: () => Promise<DdCliResult<T>>, render: (data: T) => string): Promise<ActionResult> {
  try {
    const result = await call();
    // `reason` is written by our own code, never by the vendor, so it is the
    // one failure string safe to show verbatim. See doordash-operator.ts.
    if (!result.ok) return ephemeral(false, result.reason ?? failures[result.failure] ?? failures.ddcli_nonzero);
    return ephemeral(true, render(result.data));
  } catch {
    // Never forward exceptions, failure detail, stdout, or arbitrary vendor fields.
    return ephemeral(false, failures.ddcli_nonzero);
  }
}

function bridgeOf(state: unknown): DoordashBridge | undefined {
  return (state as any)?.services?.doordash as DoordashBridge | undefined;
}

/**
 * Read a parameter as trimmed text, or empty if it is not text at all.
 *
 * `getParam` is TYPED as `string | undefined`, but the tag parser can hand back
 * a number or an object when a model writes something unexpected, and calling
 * .trim() on those throws out of the handler instead of refusing politely.
 */
function text(message: unknown, name: string): string {
  const value = getParam(message, name);
  return typeof value === 'string' ? value.trim() : '';
}

export const doordashAddressesAction: Action = {
  name: 'DOORDASH_ADDRESSES',
  description: 'Show the account owner\'s saved DoorDash delivery addresses.',
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, _message, state) => {
    const bridge = bridgeOf(state);
    if (!bridge) return { success: false, text: 'That is not available here.', persist: false };
    return lookup(() => bridge.addresses(), (data) => list('Saved addresses', data,
      'No saved DoorDash addresses were found.', (a) =>
        `${field(a.label, 'Address')} ${field(a.address_id, 'unknown')}: ${field(a.printable_address, 'address unavailable')}${a.is_default ? ' (default)' : ''}`));
  },
};

export const doordashSearchAction: Action = {
  name: 'DOORDASH_SEARCH',
  // The former wording ("Results do not establish proximity to the saved
  // address") became false once the bridge started anchoring every search to
  // the account's default address, and it read as a caveat that discouraged
  // use. Restaurant names AND cuisine terms both work (verified live).
  // Restaurants AND stores: convenience stores (Wawa, 7-Eleven), grocery and
  // pharmacy only exist in DoorDash's store search, and the bridge runs both.
  // "I'm hungry, is DoorDash available?" must be answered with this action,
  // not with a clarifying question (founder, 2026-09-18).
  description: 'Find DoorDash restaurants and stores near the saved delivery address. Use for a new food or place search: "I feel like pizza" means query="pizza"; "can we get tacos?" means query="tacos". Extract only the food, cuisine, category, or place name, never the whole request. If none is named, use query="food" to discover places now. Call immediately instead of asking what they want first. For a menu, a restaurant number, or a follow-up about what they have, use DOORDASH_MENU instead.',
  // Surfaced into the prompt by buildActionDescriptions. Casual phrasings are
  // the ones that failed live — an explicit "use the doordash search action"
  // always fired, while "find me pizza on doordash" narrated instead.
  similes: [
    'find me pizza on doordash',
    "i'm hungry, find me some tacos",
    "i'm hungry, is doordash available",
    'what is open on doordash right now',
    'order from wawa',
    'what restaurants are near me',
    'order food',
    'i feel like pizza',
    'can we get tacos',
  ],
  parameters: [{ name: 'query', description: 'Only the named food, cuisine, category, or place: "find me pizza" becomes "pizza". Use "food" when none is named.', required: true, schema: { type: 'string' } }],
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, message, state) => {
    const bridge = bridgeOf(state);
    if (!bridge) return { success: false, text: 'That is not available here.', persist: false };
    const query = getParam(message, 'query');
    if (typeof query !== 'string' || !query.trim()) return ephemeral(false, 'Please provide food or restaurant search terms.');
    return lookup(() => bridge.search({ query }), (data) => {
      if (!data.stores.length) return 'Nothing matched that search. What other food or place would you like to try?';
      const rows = data.stores.slice(0, 8).map((s, index) => {
        const detail = [
          s.kind === 'store' ? 'store' : undefined,
          s.miles !== undefined ? `${s.miles} mi` : undefined,
          s.etaText ? field(s.etaText, '') : undefined,
        ].filter(Boolean).join(', ');
        return `${index + 1}. ${field(s.store_name, 'Place')}${detail ? ` (${detail})` : ''}`;
      });
      const remainder = data.stores.length > 8 ? `\n${data.stores.length - 8} more results are not shown.` : '';
      return `Here are some places on DoorDash:\n${rows.join('\n')}${remainder}\n\nWhich menu would you like? Say the place name or its number.`;
    });
  },
};

export const doordashMenuAction: Action = {
  name: 'DOORDASH_MENU',
  description: 'Show a DoorDash menu or narrow it to a food or category. For "their menu", "what do they have?", or "what drinks do they have?", omit storeName and storeId: the server remembers the selected place. If the user chooses a restaurant by number, pass their reference as storeName, such as "the second one" or "number 8"; never invent an ID or restaurant name. For an explicit restaurant name, pass that name. Extract only the food or category into query: "what drinks do they have?" means query="drinks". For the full, entire, or whole menu, omit query; "full menu" is not a food filter. Do not search for pronouns or restaurant numbers. The server asks when the place is unclear.',
  similes: [
    'what do they have',
    'show me the menu',
    'what hoagies does wawa have',
    'what can i get from there',
    'their menu',
    'what drinks do they have',
    'show me their full menu',
    'the second one',
    'number 8',
  ],
  parameters: [
    { name: 'storeName', description: 'Explicit place name or restaurant reference such as "the second one". Omit for "their menu" or a follow-up about the selected place.', required: false, schema: { type: 'string' } },
    { name: 'query', description: 'Only the optional food or category, such as "drinks", "hoagie", or "pizza"; never the whole request. Omit for the full, entire, or whole menu.', required: false, schema: { type: 'string' } },
    { name: 'storeId', description: 'Store ID only if you have one; otherwise leave it out', required: false, schema: { type: 'string' } },
  ],
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, message, state) => {
    const bridge = bridgeOf(state);
    if (!bridge) return { success: false, text: 'That is not available here.', persist: false };
    // Either form works. The name is resolved server side against the last
    // search, which matters because a store id shown in an earlier turn is not
    // in this model's memory: DoorDash output is never persisted there.
    const storeId = text(message, 'storeId');
    const storeName = text(message, 'storeName');
    const rawQuery = text(message, 'query');
    // Models sometimes emit "full menu" as the filter despite the description.
    // Clear only these explicit general-menu phrases, before truncation, so
    // named foods such as "whole wheat" and "full breakfast" stay unchanged.
    const query = /^(?:(?:the|their)\s+)?(?:(?:full|entire|whole)\s+)?menu$/i.test(rawQuery)
      ? '' : rawQuery.slice(0, 60);
    return lookup(() => bridge.menu({
      storeId: storeId || undefined, storeName: storeName || undefined, query: query || undefined,
    }), (data) => {
      // Name the store. A name resolved from a spoken phrase can land on the
      // wrong restaurant, and saying which one HERE lets the founder catch it
      // now rather than at the confirmation, or worse, after the food arrives.
      const heading = data.storeName ? `Menu for ${field(data.storeName, 'that place')}` : 'Menu items';
      // Names only: the cart step resolves names server side, and the menu id
      // lives in the server's in-flight context, so ids are noise here.
      if (!data.items.length) return query
        ? `Nothing on that menu matched ${field(query, 'that')}. Want to see the full menu or try another food?`
        : 'No menu items were returned for that place. Want to try another restaurant?';
      const rows = data.items.slice(0, 12).map((i) =>
        `- ${field(i.name, 'Item')}${i.has_required_modifiers ? ' (you pick options)' : ''}`);
      const remainder = data.items.length > 12 ? `\n${data.items.length - 12} more items are not shown. You can ask for a food or category.` : '';
      return `${heading}:\n${rows.join('\n')}${remainder}\n\nWhat would you like? Tell me the item name, or ask about another part of the menu.`;
    });
  },
};

export const doordashOrderHistoryAction: Action = {
  name: 'DOORDASH_ORDER_HISTORY',
  description: 'Show the account owner\'s recent DoorDash orders.',
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, _message, state) => {
    const bridge = bridgeOf(state);
    if (!bridge) return { success: false, text: 'That is not available here.', persist: false };
    return lookup(() => bridge.orderHistory(), (data) => list('Recent DoorDash orders', data,
      'No recent DoorDash orders were found.', (o) =>
        `${field(o.store_name, 'Restaurant')} (order ${field(o.order_uuid, 'unknown')})`));
  },
};

const statuses: Record<string, string> = {
  pending: 'is pending', action_required: 'needs your attention', order_declined: 'was declined',
  placed: 'was placed', scheduled: 'is scheduled', store_confirmed: 'was confirmed by the restaurant',
  ready_for_pickup: 'is ready for pickup', dasher_assigned: 'has a delivery driver assigned',
  dasher_at_store: 'has a delivery driver at the restaurant', picked_up: 'was picked up',
  dasher_nearby: 'has a delivery driver nearby', completed: 'is complete', cancelled: 'was cancelled',
};

export const doordashOrderStatusAction: Action = {
  name: 'DOORDASH_ORDER_STATUS',
  description: 'Check where the user\'s DoorDash order is. With no order ID it checks their most recent order, so use it right away when they ask where their food is.',
  similes: ['where is my order', 'where is my food', 'is my doordash on the way'],
  parameters: [{ name: 'orderUuid', description: 'Order ID only if you have one; otherwise leave it out', required: false, schema: { type: 'string' } }],
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, message, state) => {
    const bridge = bridgeOf(state);
    if (!bridge) return { success: false, text: 'That is not available here.', persist: false };
    const orderUuid = text(message, 'orderUuid');
    return lookup(() => bridge.orderStatus({ orderUuid: orderUuid || undefined }), (data) => {
      const from = data.merchant_name ? ` from ${field(data.merchant_name, 'the store')}` : '';
      // Minutes from now, not a clock time: the server does not know the
      // operator's time zone, and "in about 20 minutes" needs none.
      const at = data.quoted_delivery_time ? Date.parse(data.quoted_delivery_time) : NaN;
      const minutes = Number.isFinite(at) ? Math.round((at - Date.now()) / 60_000) : NaN;
      const eta = Number.isFinite(minutes) && minutes > 0 && minutes < 600
        ? ` It should arrive in about ${minutes} minutes.` : '';
      return `Your DoorDash order${from} ${statuses[data.status] ?? 'has an unrecognized status'}.${eta}`;
    });
  },
};

// ---------------------------------------------------------------------------
// Phase 2: cart, priced preview, and the human-confirmed submit.
// ---------------------------------------------------------------------------

function renderCart(view: DdCartView, verb: string): string {
  const items = view.items.length === 0
    ? 'The cart is now empty.'
    : view.items.map((item) => {
      const price = item.unitPriceCents === undefined ? '' : ` ${usd(item.unitPriceCents)} each`;
      return `${item.quantity} x ${field(item.name, 'item')}${price} (line ${field(item.lineId, 'unknown')})`;
    }).join('; ');
  // DoorDash issue #64: a partial write still reports success, so a silent drop
  // is possible. Saying so is the whole point of tracking droppedItems.
  const dropped = view.droppedItems > 0
    ? ` ${view.droppedItems} item(s) could not be added, so check the cart before ordering.`
    : '';
  return `${verb} ${field(view.storeName, 'the restaurant')}: ${items}.${dropped} Cart ${field(view.cartUuid, 'unknown')}.`;
}

export const doordashCartAction: Action = {
  name: 'DOORDASH_CART',
  description: 'Add an item to the DoorDash cart, remove one, or show what is in it. For an item request such as "I\'ll have the Italian", use add with the item name the user said. If choices are needed, the server asks for a missing choice. For a choice reply such as "white bread", "actually wheat", "no mayo", or "make it large", use add with only choices from the CURRENT user message; omit itemName and IDs. Keep correction and exclusion words exactly as stated. The server retains accepted choices for the pending item: do not reconstruct or repeat earlier choices from chat history. When the server asks whether to add the prepared item, pass the user\'s literal answer such as "add it" or "that\'s all" in choices only; the server decides whether the draft can be added. For "skip that item", pass those words in choices only to discard the pending customization without clearing the cart. Supply quantity only when the user states an item count; size is a choice, not a quantity. The server asks again if there is no valid pending item. This does not order anything and does not spend money.',
  similes: [
    'add that to my cart',
    'add two garlic knots',
    'add a custom italian hoagie',
    "I'll have the Italian",
    'white bread',
    'actually wheat',
    'no mayo',
    'make it large',
    'add it',
    "that's all",
    'skip that item',
    'keep these choices',
    'classic roll, not toasted, provolone',
    'what is in my cart',
    'take the fries off',
  ],
  parameters: [
    { name: 'op', description: 'add, remove, or show', required: true, schema: { type: 'string', enum: ['add', 'remove', 'show'] } },
    { name: 'itemName', description: 'The item name the user said, for add', required: false, schema: { type: 'string' } },
    { name: 'choices', description: 'Only the CURRENT user message\'s option picks or correction, in their own words. Preserve words such as "actually", "instead", "no", and "without". Do not repeat earlier choices. Forward "keep these choices" literally when the user says it; the server can clear an unmatched request and show the draft again, without adding it.', required: false, schema: { type: 'string' } },
    { name: 'itemId', description: 'Item ID only if you have one; otherwise leave it out', required: false, schema: { type: 'string' } },
    { name: 'quantity', description: 'Whole item count from 1 to 20, only if the user states it. Omit for choice replies; the server keeps the pending count or starts a new item at 1. Size is not quantity.', required: false, schema: { type: 'string' } },
    { name: 'lineId', description: 'Line ID from the cart, required for remove', required: false, schema: { type: 'string' } },
    { name: 'storeId', description: 'Only if you still have it; otherwise leave it out', required: false, schema: { type: 'string' } },
    { name: 'menuId', description: 'Only if you still have it; otherwise leave it out', required: false, schema: { type: 'string' } },
    { name: 'cartUuid', description: 'Only if you still have it; otherwise leave it out', required: false, schema: { type: 'string' } },
  ],
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, message, state) => {
    const bridge = bridgeOf(state);
    if (!bridge) return { success: false, text: 'That is not available here.', persist: false };
    const op = text(message, 'op').toLowerCase();
    const cartUuid = text(message, 'cartUuid');

    // A missing cart, store or menu id is NORMAL, not an error: the server holds
    // the in-flight order context, so the model does not have to carry ids it
    // cannot see across turns.
    if (op === 'show') {
      return lookup(() => bridge.cartShow({ cartUuid: cartUuid || undefined }),
        (view) => renderCart(view, 'In your cart from'));
    }
    if (op === 'remove') {
      const lineId = text(message, 'lineId');
      if (!lineId) return ephemeral(false, 'Tell me which item to take off and I will remove it.');
      return lookup(() => bridge.cartRemove({ cartUuid: cartUuid || undefined, lineId }),
        (view) => renderCart(view, 'Removed. Now in your cart from'));
    }
    if (op !== 'add') return ephemeral(false, 'I can add to the cart, remove from it, or show it.');

    const storeId = text(message, 'storeId');
    const menuId = text(message, 'menuId');
    const itemId = text(message, 'itemId');
    const itemName = text(message, 'itemName').slice(0, 120);
    const choices = text(message, 'choices').slice(0, 600);
    // With only `choices`, the server uses the item that is waiting for them.
    if (!itemId && !itemName && !choices) {
      return ephemeral(false, 'Tell me which item and I will add it.');
    }
    // Whole numbers only. A fractional quantity crashes the vendor CLI
    // (DoorDash issue #92), so by-weight items are simply not orderable here.
    // Matched as a STRING first, for the same reason as the tip below: Number()
    // happily reads '1e1' as 10 and '' as 0, so digits are checked before any
    // conversion rather than after it.
    const rawQuantity = text(message, 'quantity');
    if (rawQuantity && !/^\d{1,2}$/.test(rawQuantity)) {
      return ephemeral(false, 'I can add between 1 and 20 of a whole item at a time.');
    }
    const quantity = rawQuantity ? Number(rawQuantity) : undefined;
    if (quantity !== undefined && (quantity < 1 || quantity > 20)) {
      return ephemeral(false, 'I can add between 1 and 20 of a whole item at a time.');
    }
    return lookup(
      () => bridge.cartAdd({
        storeId: storeId || undefined, menuId: menuId || undefined,
        itemId: itemId || undefined, itemName: itemName || undefined, choices: choices || undefined,
        quantity, cartUuid: cartUuid || undefined,
      }),
      (view) => {
        // Echo the picks: the priced confirmation lists items, not options, so
        // this is where the operator sees WHICH bread and cheese went in.
        const picks = view.addedChoices?.length
          ? ` With: ${view.addedChoices.map((c) => field(c, '')).filter(Boolean).join(', ')}.`
          : '';
        return `${renderCart(view, 'Added. Now in your cart from')}${picks}`;
      },
    );
  },
};

export const doordashPreviewAction: Action = {
  name: 'DOORDASH_PREVIEW',
  description: 'Price the DoorDash cart and get the real total with tax, fees and delivery time, plus a confirmation code. Use this before ordering. This does not spend money and does not place the order.',
  similes: [
    'what is the total',
    'how much will that be',
    'check out',
    'price it up',
    'ready to order',
  ],
  parameters: [
    { name: 'cartUuid', description: 'Only if you still have it; otherwise leave it out', required: false, schema: { type: 'string' } },
  ],
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, message, state) => {
    const bridge = bridgeOf(state);
    if (!bridge) return { success: false, text: 'That is not available here.', persist: false };
    const cartUuid = text(message, 'cartUuid');
    return lookup(() => bridge.preview({ cartUuid: cartUuid || undefined }), (view) => {
      // The basket leads the reply. What is being bought matters more at this
      // moment than how the fees break down, and an item the account owner did
      // not choose has to be visible BEFORE the confirmation code is typed.
      // A safety property that rests on an OPTIONAL vendor field has to fail
      // loudly. Both the basket and the store name can be absent from the
      // quote, and rendering nothing would silently return the founder to
      // confirming a bare number with no sign that anything went missing.
      // Say so instead, in the same breath as the code.
      // Show everything that IS readable, and name whatever is not. Replacing
      // the whole line with a warning would throw away item names we already
      // have, and rendering nothing would quietly put the founder back to
      // approving a bare number with no sign anything went missing.
      const named = view.items.length > 0
        ? `${view.items.map((item) => `${item.quantity} x ${field(item.name, 'item')}`).join(', ')}`
        : '';
      const from = view.storeName ? ` from ${field(view.storeName, 'the restaurant')}` : '';
      const missing = view.items.length === 0
        ? 'I could not read the basket back from DoorDash, so open the cart and check it before you confirm. '
        : (view.storeName ? '' : 'I could not confirm which restaurant this is from, so check that before you confirm. ');
      const basket = named ? `${named}${from}. ${missing}` : missing;
      const breakdown = view.lines.map((line) => `${field(line.label, 'Charge')} ${field(line.amount, '')}`).join(', ');
      const eta = view.etaText ? ` Delivery is about ${field(view.etaText, '')}.` : '';
      const tips = view.tipSuggestionsCents.length > 0
        ? ` DoorDash suggests a tip of ${view.tipSuggestionsCents.map(usd).join(', ')}.`
        : '';
      // The tip is ASKED here, never chosen. The founder's answer, in the
      // founder's own next message, is what the submit path will accept.
      return `${basket}${breakdown}. Total before tip ${usd(view.totalBeforeTipCents)}.${eta}${tips}`
        + ` How much would you like to tip? Reply with the tip and this code to place it: ${view.confirmCode}.`
        + ` The code expires in ${view.expiresInMinutes} minutes.`;
    });
  },
};

export const doordashSubmitAction: Action = {
  name: 'DOORDASH_SUBMIT',
  description: 'Place the previewed DoorDash order. Only use this when the account owner has typed the confirmation code and a tip amount in their own message. This charges a real card.',
  similes: [
    'yes place it',
    'confirm the order',
    'go ahead and order it',
  ],
  // At most one money action may run per reply (eliza-runtime dispatch budget).
  writesMoney: true,
  parameters: [
    { name: 'confirm', description: 'The confirmation code exactly as the account owner typed it', required: true, schema: { type: 'string' } },
    { name: 'tip', description: 'Tip in DOLLARS as the account owner stated it, for example 3 or 3.50', required: true, schema: { type: 'string' } },
  ],
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, message, state) => {
    const bridge = bridgeOf(state);
    if (!bridge) return { success: false, text: 'That is not available here.', persist: false };
    const confirm = text(message, 'confirm');
    if (!confirm) return ephemeral(false, 'Type the confirmation code and I will place the order.');
    // Dollars in, cents out, converted HERE and once. The vendor's own help
    // warns that --tip-cents 5 means five cents, and the whole class of
    // hundred-fold tip mistakes lives in that unit confusion.
    const rawTip = text(message, 'tip').replace(/^\$/, '');
    // Matched as a STRING before any conversion, because Number('') is 0, not
    // NaN. A numeric check alone would turn a missing tip into a silent zero
    // tip, and the founder's rule is that the tip is never defaulted.
    if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(rawTip)) {
      return ephemeral(false, 'Tell me the tip in dollars and I will place the order.');
    }
    const tipCents = Math.round(Number(rawTip) * 100);
    return lookup(() => bridge.submit({ confirm, tipCents }), (view) =>
      `Order placed. ${usd(view.totalCents + view.tipCents)} in total, including a ${usd(view.tipCents)} tip.`
      + ` Order ${field(view.orderUuid, 'unknown')}.`);
  },
};
