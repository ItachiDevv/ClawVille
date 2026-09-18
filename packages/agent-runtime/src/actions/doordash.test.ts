import { describe, expect, test, mock } from 'bun:test';
import { allActions } from './index';
import {
  doordashAddressesAction, doordashSearchAction, doordashMenuAction,
  doordashOrderHistoryAction, doordashOrderStatusAction,
  doordashCartAction, doordashPreviewAction, doordashSubmitAction,
} from './doordash';

const cases = [
  { action: doordashAddressesAction, method: 'addresses', params: {}, args: [],
    data: [{ address_id: 1, printable_address: '123 Test Street', label: 'Home', is_default: true }],
    text: 'Saved addresses: Home 1: 123 Test Street (default).' },
  { action: doordashSearchAction, method: 'search', params: { query: 'pizza' }, args: [{ query: 'pizza' }],
    data: { stores: [{ store_id: 42, store_name: 'Pizza Shop' }] },
    text: 'On DoorDash: Pizza Shop.' },
  { action: doordashMenuAction, method: 'menu', params: { storeId: '42' }, args: [{ storeId: '42' }],
    data: { menu_id: 43, items: [{ item_id: 44, name: 'Cheese Pizza' }] },
    text: 'Menu items: Cheese Pizza.' },
  // When the store name IS known, the menu names it — a wrong resolution then
  // surfaces a turn earlier than the priced confirmation would catch it.
  { action: doordashOrderHistoryAction, method: 'orderHistory', params: {}, args: [],
    data: [{ order_uuid: 'order-123', store_id: 42, store_name: 'Pizza Shop' }],
    text: 'Recent DoorDash orders: Pizza Shop (order order-123).' },
  { action: doordashOrderStatusAction, method: 'orderStatus', params: { orderUuid: 'order-123' }, args: [{ orderUuid: 'order-123' }],
    data: { order_uuid: 'order-123', status: 'store_confirmed' },
    text: 'Your DoorDash order was confirmed by the restaurant.' },
];
const failureCodes = [
  'ddcli_unavailable', 'ddcli_version_mismatch', 'ddcli_auth_expired', 'ddcli_timeout',
  'ddcli_output_too_large', 'ddcli_bad_json', 'ddcli_nonzero', 'ddcli_darkened',
];

describe('read-only DoorDash actions', () => {
  test('registers the five read-only actions plus the three ordering ones', () => {
    const registered = allActions.filter((action) => action.name.startsWith('DOORDASH_'));
    expect(registered).toEqual([
      ...cases.map(({ action }) => action),
      doordashCartAction, doordashPreviewAction, doordashSubmitAction,
    ]);
  });

  test('DOORDASH_SUBMIT is the only action flagged as spending money', () => {
    // The runtime allows at most one money action per reply, and that budget
    // only applies to actions that declare themselves. Cart edits and priced
    // previews move no money, so flagging them would spend the budget for
    // nothing; submit is the single command that reaches a real card.
    const registered = allActions.filter((action) => action.name.startsWith('DOORDASH_'));
    const money = registered.filter((action) => action.writesMoney === true);
    expect(money).toEqual([doordashSubmitAction]);
  });

  for (const c of cases) {
    test(`${c.action.name} uses bridge presence only and rechecks it in the handler`, async () => {
      for (const state of [undefined, {}, { services: {} }, { userId: 'founder', services: { doordash: null } }]) {
        expect(c.action.available!(state as any)).toBe(false);
        expect(await c.action.handler(null, { parameters: c.params }, state)).toEqual({
          success: false, text: 'That is not available here.', persist: false,
        });
      }
      const state = { userId: 'agent-id-not-human-id', services: { doordash: {} as unknown } };
      expect(c.action.available!(state)).toBe(true);
      state.services.doordash = undefined;
      expect(await c.action.handler(null, { parameters: c.params }, state)).toEqual({
        success: false, text: 'That is not available here.', persist: false,
      });
    });

    test(`${c.action.name} calls the real bridge method and returns ephemeral prose`, async () => {
      const call = mock(async () => ({ ok: true, data: c.data, durationMs: 1 }));
      const state = { services: { doordash: { [c.method]: call } } };
      // Accessing this value is a bug on the agent path. Throw to prove no read.
      Object.defineProperty(state, 'userId', { get() { throw new Error('agent identity is not a human identity'); } });
      const result = await c.action.handler(null, { parameters: c.params }, state);
      expect(call.mock.calls).toEqual([c.args]);
      expect(result).toEqual({ success: true, text: c.text, persist: false });
      expect(result.data).toBeUndefined();
      expect(result.text).not.toContain(JSON.stringify(c.data));
    });

    test(`${c.action.name} translates each failure without exposing detail or raw output`, async () => {
      const texts = new Set<string>();
      for (const failure of [...failureCodes, 'unexpected_vendor_failure']) {
        const state = { services: { doordash: { [c.method]: async () => ({
          ok: false, failure, detail: 'RAW PRIVATE OUTPUT: secret address and stack trace', durationMs: 1,
        }) } } };
        const result = await c.action.handler(null, { parameters: c.params }, state);
        expect(result.success).toBe(false);
        expect(result.persist).toBe(false);
        expect(result.data).toBeUndefined();
        expect(result.text).not.toContain('RAW PRIVATE OUTPUT');
        expect(result.text).not.toContain(failure);
        expect(result.text!.length).toBeGreaterThan(10);
        if (failureCodes.includes(failure)) texts.add(result.text!);
      }
      expect(texts.size).toBe(failureCodes.length);
    });

    test(`${c.action.name} catches bridge exceptions without exposing their contents`, async () => {
      const state = { services: { doordash: { [c.method]: async () => {
        throw new Error('PRIVATE TOKEN / stack trace');
      } } } };
      expect(await c.action.handler(null, { parameters: c.params }, state)).toEqual({
        success: false, text: 'DoorDash could not complete that request. Please try again later.', persist: false,
      });
    });
  }

  test('missing or non-string required parameters never reach the bridge', async () => {
    for (const c of cases.filter((entry) => Object.keys(entry.params).length > 0)) {
      const call = mock(async () => { throw new Error('must not run'); });
      const state = { services: { doordash: { [c.method]: call } } };
      const name = Object.keys(c.params)[0];
      for (const value of [undefined, '', '   ', 42, {}]) {
        const result = await c.action.handler(null, { parameters: { [name]: value } }, state);
        expect(result.success).toBe(false);
        expect(result.persist).toBe(false);
      }
      expect(call).not.toHaveBeenCalled();
    }
  });

  test('empty results use concise prose', async () => {
    const empty = [[], { stores: [] }, { menu_id: 1, items: [] }, []];
    for (const [index, data] of empty.entries()) {
      const c = cases[index];
      const result = await c.action.handler(null, { parameters: c.params }, {
        services: { doordash: { [c.method]: async () => ({ ok: true, data, durationMs: 1 }) } },
      });
      expect(result.success).toBe(true);
      expect(result.persist).toBe(false);
      expect(result.text).toMatch(/^(No |Nothing )/);
    }
  });

  test('summaries bound row count and field length and ignore unrecognized fields', async () => {
    const result = await doordashSearchAction.handler(null, { parameters: { query: 'pizza' } }, {
      services: { doordash: { search: async () => ({ ok: true, durationMs: 1, data: {
        stores: Array.from({ length: 20 }, (_, n) => ({ store_id: n, store_name: 'A'.repeat(2000), raw: 'PRIVATE EXTRA' })),
        stdout: 'PRIVATE RAW JSON',
      } }) } },
    });
    // Eight rows since 2026-09-18 (restaurants and stores share one list).
    expect(result.text!.length).toBeLessThan(1600);
    expect(result.text).toContain('12 more results are not shown.');
    expect(result.text).not.toContain('store 5');
    expect(result.text).not.toContain('PRIVATE');
    expect(result.text).not.toContain('nearby');
  });

  test('all known order status values use prose without raw vendor status names', async () => {
    const statuses = [
      'pending', 'action_required', 'order_declined', 'placed', 'scheduled', 'store_confirmed',
      'ready_for_pickup', 'dasher_assigned', 'dasher_at_store', 'picked_up', 'dasher_nearby', 'completed', 'cancelled',
    ];
    for (const status of statuses) {
      const result = await doordashOrderStatusAction.handler(null, { parameters: { orderUuid: 'o-1' } }, {
        services: { doordash: { orderStatus: async () => ({ ok: true, durationMs: 1, data: { status } }) } },
      });
      expect(result.success).toBe(true);
      expect(result.text).not.toContain('_');
      expect(result.text).not.toContain('unrecognized');
    }
  });
});
