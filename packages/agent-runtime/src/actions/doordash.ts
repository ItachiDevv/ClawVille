import { getParam, type Action, type ActionResult } from './types';

// Structural mirrors of chunk 1's validated results. Never import apps/api here.
type DdCliResult<T> =
  | { ok: true; data: T; durationMs: number }
  | { ok: false; failure: string; detail: string; durationMs: number };
type DdId = string | number;
export interface DoordashReadOnlyBridge {
  addresses(): Promise<DdCliResult<Array<{
    address_id: DdId; printable_address: string; label?: string | null; is_default?: boolean;
  }>>>;
  search(q: { query: string }): Promise<DdCliResult<{
    stores: Array<{ store_id: DdId; store_name?: string }>;
  }>>;
  menu(q: { storeId: string }): Promise<DdCliResult<{
    menu_id: DdId; items: Array<{ item_id: DdId; name?: string }>;
  }>>;
  orderHistory(): Promise<DdCliResult<Array<{
    order_uuid: string; store_id: DdId; store_name?: string;
  }>>>;
  orderStatus(q: { orderUuid: string }): Promise<DdCliResult<{ order_uuid?: string; status: string }>>;
}
type DoordashBridge = DoordashReadOnlyBridge;

const failures: Record<string, string> = {
  ddcli_unavailable: 'DoorDash is not available right now.',
  ddcli_version_mismatch: 'DoorDash needs an integration update before it can respond.',
  ddcli_auth_expired: 'DoorDash needs a fresh sign-in.',
  ddcli_timeout: 'DoorDash took too long to respond. Please try again later.',
  ddcli_output_too_large: 'DoorDash returned too much information. Please request fewer details.',
  ddcli_bad_json: 'I could not read the DoorDash response. Please try again later.',
  ddcli_nonzero: 'DoorDash could not complete that request. Please try again later.',
  ddcli_darkened: 'DoorDash is paused until the account owner restores access.',
};

// Addendum sections 6.2/6.4: display only; never retain CLI data in chat memory.
function ephemeral(success: boolean, text: string): ActionResult {
  return { success, text, persist: false };
}

function field(value: string | number | null | undefined, fallback: string): string {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 160) : fallback;
}

function list<T>(title: string, rows: T[], empty: string, render: (row: T) => string): string {
  if (rows.length === 0) return empty;
  const shown = rows.slice(0, 5).map(render).join('; ');
  const remainder = rows.length > 5 ? ` ${rows.length - 5} more results are not shown.` : '';
  return `${title}: ${shown}.${remainder}`;
}

async function lookup<T>(call: () => Promise<DdCliResult<T>>, render: (data: T) => string): Promise<ActionResult> {
  try {
    const result = await call();
    if (!result.ok) return ephemeral(false, failures[result.failure] ?? failures.ddcli_nonzero);
    return ephemeral(true, render(result.data));
  } catch {
    // Never forward exceptions, failure detail, stdout, or arbitrary vendor fields.
    return ephemeral(false, failures.ddcli_nonzero);
  }
}

export const doordashAddressesAction: Action = {
  name: 'DOORDASH_ADDRESSES',
  description: 'Show the account owner\'s saved DoorDash delivery addresses.',
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, _message, state) => {
    const bridge = (state as any)?.services?.doordash as DoordashBridge | undefined;
    if (!bridge) return { success: false, text: 'That is not available here.', persist: false };
    return lookup(() => bridge.addresses(), (data) => list('Saved addresses', data,
      'No saved DoorDash addresses were found.', (a) =>
        `${field(a.label, 'Address')} ${field(a.address_id, 'unknown')}: ${field(a.printable_address, 'address unavailable')}${a.is_default ? ' (default)' : ''}`));
  },
};

export const doordashSearchAction: Action = {
  name: 'DOORDASH_SEARCH',
  description: 'Search DoorDash restaurants. Results do not establish proximity to the saved address.',
  parameters: [{ name: 'query', description: 'Food or restaurant search terms', required: true, schema: { type: 'string' } }],
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, message, state) => {
    const bridge = (state as any)?.services?.doordash as DoordashBridge | undefined;
    if (!bridge) return { success: false, text: 'That is not available here.', persist: false };
    const query = getParam(message, 'query');
    if (typeof query !== 'string' || !query.trim()) return ephemeral(false, 'Please provide food or restaurant search terms.');
    return lookup(() => bridge.search({ query }), (data) => list('DoorDash search results', data.stores,
      'No DoorDash restaurants matched that search.', (s) =>
        `${field(s.store_name, 'Restaurant')} (store ${field(s.store_id, 'unknown')})`));
  },
};

export const doordashMenuAction: Action = {
  name: 'DOORDASH_MENU',
  description: 'Show items on a DoorDash restaurant menu.',
  parameters: [{ name: 'storeId', description: 'Store ID from a DoorDash search result', required: true, schema: { type: 'string' } }],
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, message, state) => {
    const bridge = (state as any)?.services?.doordash as DoordashBridge | undefined;
    if (!bridge) return { success: false, text: 'That is not available here.', persist: false };
    const storeId = getParam(message, 'storeId');
    if (typeof storeId !== 'string' || !storeId.trim()) return ephemeral(false, 'Please provide a DoorDash store ID.');
    return lookup(() => bridge.menu({ storeId }), (data) => list('Menu items', data.items,
      'No menu items were returned for that restaurant.', (i) =>
        `${field(i.name, 'Item')} (item ${field(i.item_id, 'unknown')})`));
  },
};

export const doordashOrderHistoryAction: Action = {
  name: 'DOORDASH_ORDER_HISTORY',
  description: 'Show the account owner\'s recent DoorDash orders.',
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, _message, state) => {
    const bridge = (state as any)?.services?.doordash as DoordashBridge | undefined;
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
  description: 'Check the status of a DoorDash order.',
  parameters: [{ name: 'orderUuid', description: 'Order ID from DoorDash order history', required: true, schema: { type: 'string' } }],
  available: (state) => Boolean((state as any)?.services?.doordash),
  validate: async () => true,
  handler: async (_runtime, message, state) => {
    const bridge = (state as any)?.services?.doordash as DoordashBridge | undefined;
    if (!bridge) return { success: false, text: 'That is not available here.', persist: false };
    const orderUuid = getParam(message, 'orderUuid');
    if (typeof orderUuid !== 'string' || !orderUuid.trim()) return ephemeral(false, 'Please provide a DoorDash order ID.');
    return lookup(() => bridge.orderStatus({ orderUuid }), (data) =>
      `Your DoorDash order ${statuses[data.status] ?? 'has an unrecognized status'}.`);
  },
};
