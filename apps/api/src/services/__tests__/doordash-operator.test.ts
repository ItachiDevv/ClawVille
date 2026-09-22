import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppContext } from '../../types';
import type { DoordashOperatorContext } from '../../middleware/doordash-operator-only';
import * as cli from '../doordash-cli';

// This suite exercises routing, not the durable state machine. The separate
// confirmation-flow suite models row predicates and preview revocation.
mock.module('@clawville/database', () => ({
  db: { update: () => ({ set: () => ({ where: async () => {} }) }) },
  doordashOrders: { userId: 'userId', status: 'status' },
  and: () => ({}), eq: () => ({}), sql: () => ({}),
}));

type OperatorModule = typeof import('../doordash-operator');
type MiddlewareModule = typeof import('../../middleware/doordash-operator-only');
const savedEnv = {
  operator: process.env.DOORDASH_OPERATOR_USER_ID,
  admins: process.env.ADMIN_USER_IDS,
  origin: process.env.CORS_ORIGIN,
};
let operator: OperatorModule;
let middleware: MiddlewareModule;
let configImport = 0;
let spawnGuard: ReturnType<typeof spyOn<typeof Bun, 'spawn'>>;
let runMock: ReturnType<typeof spyOn<typeof cli, 'runDdCli'>> | undefined;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(async () => {
  process.env.DOORDASH_OPERATOR_USER_ID = ' founder ';
  process.env.ADMIN_USER_IDS = ' other-admin, founder ';
  process.env.CORS_ORIGIN = 'https://operator.example';
  operator = await import('../doordash-operator');
  middleware = await import('../../middleware/doordash-operator-only');
});

beforeEach(() => {
  // Fail loudly if any test accidentally reaches a real subprocess.
  spawnGuard = spyOn(Bun, 'spawn').mockImplementation(() => {
    throw new Error('Tests must never execute the real dd-cli binary');
  });
});

afterEach(() => {
  runMock?.mockRestore();
  runMock = undefined;
  expect(spawnGuard).not.toHaveBeenCalled();
  spawnGuard.mockRestore();
});

afterAll(() => {
  restoreEnv('DOORDASH_OPERATOR_USER_ID', savedEnv.operator);
  restoreEnv('ADMIN_USER_IDS', savedEnv.admins);
  restoreEnv('CORS_ORIGIN', savedEnv.origin);
});

async function configuredOperator(id: string | undefined, admins: string): Promise<OperatorModule> {
  restoreEnv('DOORDASH_OPERATOR_USER_ID', id);
  process.env.ADMIN_USER_IDS = admins;
  try {
    // Each fresh module captures its own immutable startup configuration.
    return await import(`../doordash-operator.ts?gate=${++configImport}`) as OperatorModule;
  } finally {
    process.env.DOORDASH_OPERATOR_USER_ID = ' founder ';
    process.env.ADMIN_USER_IDS = ' other-admin, founder ';
  }
}

const human = { kind: 'human' as const, userId: 'founder', avatarId: 'founder-avatar' };
const agent = {
  kind: 'agent' as const, userId: 'founder', avatarId: 'founder-avatar',
  ledgerCapable: true, agentSessionId: 'resolved-agent-session',
};

describe('resolveDoordashOperator: frozen identity gate', () => {
  test('allows the founder human and reserves submit authority for that path', () => {
    expect(operator.doordashOperatorUserId()).toBe('founder');
    expect(operator.resolveDoordashOperator(human)).toEqual({ ...human, canSubmit: true });
  });

  test('allows only a bound, ledger-capable founder agent with no submit authority', () => {
    expect(operator.resolveDoordashOperator(agent)).toEqual({
      kind: 'agent', userId: 'founder', avatarId: 'founder-avatar',
      agentSessionId: 'resolved-agent-session', canSubmit: false,
    });
  });

  test('rejects every non-founder, including another admin, on both paths', () => {
    for (const userId of ['other-admin', 'other-user', 'agent-runtime-id']) {
      expect(operator.resolveDoordashOperator({ ...human, userId })).toBeNull();
      expect(operator.resolveDoordashOperator({ ...agent, userId })).toBeNull();
    }
  });

  test('rejects null userId and null avatarId', () => {
    expect(operator.resolveDoordashOperator({ ...agent, userId: null })).toBeNull();
    expect(operator.resolveDoordashOperator({ ...agent, avatarId: null })).toBeNull();
    // Runtime defense also holds if a typed human caller violates its contract.
    expect(operator.resolveDoordashOperator({ ...human, userId: null } as unknown as typeof human)).toBeNull();
    expect(operator.resolveDoordashOperator({ ...human, avatarId: null } as unknown as typeof human)).toBeNull();
  });

  test('rejects empty avatars and missing agent sessions', () => {
    expect(operator.resolveDoordashOperator({ ...human, avatarId: '  ' })).toBeNull();
    expect(operator.resolveDoordashOperator({ ...agent, agentSessionId: '' })).toBeNull();
  });

  test('rejects false or absent ledger capability', () => {
    expect(operator.resolveDoordashOperator({ ...agent, ledgerCapable: false })).toBeNull();
    expect(operator.resolveDoordashOperator({ ...agent, ledgerCapable: undefined } as unknown as typeof agent)).toBeNull();
  });

  test('rejects unset or empty operator configuration', async () => {
    for (const id of [undefined, '', '  ']) {
      const isolated = await configuredOperator(id, 'founder');
      expect(isolated.doordashOperatorUserId()).toBeNull();
      expect(isolated.resolveDoordashOperator(human)).toBeNull();
      expect(isolated.resolveDoordashOperator(agent)).toBeNull();
    }
  });

  test('rejects the configured founder unless ADMIN_USER_IDS also contains that exact id', async () => {
    for (const admins of ['', 'other-admin', 'founder-prefix, suffix-founder']) {
      const isolated = await configuredOperator('founder', admins);
      expect(isolated.doordashOperatorUserId()).toBeNull();
      expect(isolated.resolveDoordashOperator(human)).toBeNull();
      expect(isolated.resolveDoordashOperator(agent)).toBeNull();
    }
  });

  test('does not change the configured identity after module load', () => {
    process.env.DOORDASH_OPERATOR_USER_ID = 'other-admin';
    process.env.ADMIN_USER_IDS = 'other-admin';
    try {
      expect(operator.doordashOperatorUserId()).toBe('founder');
      expect(operator.resolveDoordashOperator({ ...human, userId: 'other-admin' })).toBeNull();
    } finally {
      process.env.DOORDASH_OPERATOR_USER_ID = ' founder ';
      process.env.ADMIN_USER_IDS = ' other-admin, founder ';
    }
  });
});

describe('Phase 1 DoorDash bridge', () => {
  function bridge() {
    return operator.buildDoordashBridge(operator.resolveDoordashOperator(human)!, 'raw founder turn');
  }

  test('dispatches the five read-only operations and unwraps list envelopes', async () => {
    operator.resetDoordashAddressCache();
    const search = { stores: [] };
    const menu = { menu_id: 'menu-1', items: [] };
    const addresses = [{ address_id: 'address-1', printable_address: 'Test address', is_default: true }];
    const status = { order_uuid: 'order-1', status: 'placed' as const };
    // store_name is normalized from the vendor's `name` field, so it is always
    // present on the parsed shape even when the vendor omits it.
    const orders = [{ order_uuid: 'order-1', store_id: '123', store_name: undefined }];
    runMock = spyOn(cli, 'runDdCli')
      // search resolves the default delivery address FIRST — see the Cupertino note.
      .mockResolvedValueOnce({ ok: true, data: { addresses }, durationMs: 0 })
      .mockResolvedValueOnce({ ok: true, data: search, durationMs: 1 })
      // Stores are searched too: Wawa is a convenience store, invisible to `search`.
      .mockResolvedValueOnce({ ok: true, data: { stores: [] }, durationMs: 1 })
      .mockResolvedValueOnce({ ok: true, data: menu, durationMs: 2 })
      .mockResolvedValueOnce({ ok: true, data: { addresses }, durationMs: 3 })
      .mockResolvedValueOnce({ ok: true, data: status, durationMs: 4 })
      .mockResolvedValueOnce({ ok: true, data: { orders }, durationMs: 5 });
    const capability = bridge();
    expect(capability.requesterTurn).toBe('raw founder turn');
    expect(await capability.search({ query: 'sushi' })).toMatchObject({ ok: true, data: { stores: [] } });
    expect(await capability.menu({ storeId: '123' })).toEqual({ ok: true, data: menu, durationMs: 2 });
    expect(await capability.addresses()).toEqual({ ok: true, data: addresses, durationMs: 3 });
    expect(await capability.orderStatus({ orderUuid: 'order-1' })).toEqual({ ok: true, data: status, durationMs: 4 });
    expect(await capability.orderHistory()).toEqual({ ok: true, data: orders, durationMs: 5 });
    expect(runMock.mock.calls).toEqual([
      ['address-list', []], ['search', ['sushi', 'address-1']], ['nearby-stores', ['address-1']],
      ['menu', ['123']], ['address-list', []],
      ['order-status', ['order-1']], ['order-history', []],
    ]);
  });

  // REGRESSION (staging 2026-09-17): `dd-cli search` with no location flag does
  // NOT error — it silently searches lat 37.3346 / lng -122.009 (Cupertino, CA)
  // and returns an empty store list. A New York operator saw "nothing found"
  // instead of "wrong city", which is why this needs an explicit test.
  test('anchors search to the default saved address, caches it, and degrades safely', async () => {
    operator.resetDoordashAddressCache();
    const addresses = [
      { address_id: '111', printable_address: 'Not default', is_default: false },
      { address_id: '14437790', printable_address: 'Default NYC', is_default: true },
    ];
    runMock = spyOn(cli, 'runDdCli').mockImplementation(((op: string) =>
      Promise.resolve(op === 'address-list'
        ? { ok: true, data: { addresses }, durationMs: 1 }
        : { ok: true, data: { stores: [] }, durationMs: 2 })) as never);
    const capability = bridge();
    await capability.search({ query: 'ramen' });
    // The DEFAULT address wins over merely being first in the list.
    expect(runMock.mock.calls.at(-2)).toEqual(['search', ['ramen', '14437790']]);
    expect(runMock.mock.calls.at(-1)).toEqual(['nearby-stores', ['14437790']]);
    // A second search reuses the cache: restaurants + stores, no address lookup.
    const before = runMock.mock.calls.length;
    await capability.search({ query: 'udon' });
    expect(runMock.mock.calls.length).toBe(before + 2);
    expect(runMock.mock.calls.at(-2)).toEqual(['search', ['udon', '14437790']]);

    // An unanchored search silently uses another city. Refuse on a failed
    // address lookup instead of claiming that no nearby stores exist.
    operator.resetDoordashAddressCache();
    runMock.mockImplementation(((op: string) =>
      Promise.resolve(op === 'address-list'
        ? { ok: false, failure: 'ddcli_nonzero', detail: 'x', durationMs: 1 }
        : { ok: true, data: { stores: [] }, durationMs: 2 })) as never);
    const callCount = runMock.mock.calls.length;
    const refused = await capability.search({ query: 'soba' });
    expect(refused.ok).toBe(false);
    expect(runMock.mock.calls.slice(callCount)).toEqual([['address-list', []]]);
  });

  test('preserves wrapper failures without inventing list data', async () => {
    const failure = { ok: false as const, failure: 'ddcli_darkened' as const, detail: 'dark', durationMs: 0 };
    runMock = spyOn(cli, 'runDdCli').mockResolvedValue(failure);
    expect(await bridge().addresses()).toBe(failure);
    expect(await bridge().orderHistory()).toBe(failure);
  });

  // -------------------------------------------------------------------------
  // Phase 2 cart dispatch. The shapes below are the LIVE ones captured from
  // dd-cli v0.2.4 on 2026-09-17, not invented ones.
  // -------------------------------------------------------------------------
  const liveCart = {
    cart_uuid: 'e3a59a0d-b213-435d-af79-1a97031567c4',
    cart: {
      id: 'e3a59a0d-b213-435d-af79-1a97031567c4',
      store_id: '473827',
      store_name: 'Rojas Pizza',
      items: [{
        id: '48a0823b-a292-45cf-a565-2c7aa1641bcf',
        item_id: '57160719', name: 'Garlic Knots', quantity: 2, price: 6.95,
      }],
      items_count: 1,
    },
    item_error_count: 0,
  };

  test('cart add passes values in wrapper order and omits an absent cart', async () => {
    runMock = spyOn(cli, 'runDdCli').mockResolvedValue({ ok: true, data: liveCart, durationMs: 1 } as never);
    await bridge().cartAdd({ storeId: '473827', menuId: '598614', itemId: 'i_57160719', quantity: 2 });
    expect(runMock.mock.calls.at(-1)).toEqual(['cart-add', ['473827', '598614', 'i_57160719', '2']]);
    await bridge().cartAdd({ storeId: '473827', menuId: '598614', itemId: 'i_57160719', quantity: 1, cartUuid: 'cart-1' });
    expect(runMock.mock.calls.at(-1)).toEqual(['cart-add', ['473827', '598614', 'i_57160719', '1', 'cart-1']]);
  });

  test('cart show and remove dispatch the line id, and the view keeps cents not dollars', async () => {
    runMock = spyOn(cli, 'runDdCli').mockResolvedValue({ ok: true, data: liveCart, durationMs: 1 } as never);
    const shown = await bridge().cartShow({ cartUuid: 'cart-1' });
    expect(runMock.mock.calls.at(-1)).toEqual(['cart-show', ['cart-1']]);
    expect(shown.ok && shown.data.items[0]).toEqual({
      lineId: '48a0823b-a292-45cf-a565-2c7aa1641bcf', name: 'Garlic Knots', quantity: 2, unitPriceCents: 695,
    });
    await bridge().cartRemove({ cartUuid: 'cart-1', lineId: 'line-9' });
    expect(runMock.mock.calls.at(-1)).toEqual(['cart-remove', ['cart-1', 'line-9']]);
  });

  test('a partially written cart reports the dropped count instead of hiding it', async () => {
    // DoorDash issue #64: the vendor exits 0 with success true and lists the
    // failures only in item_errors, so a silent drop is the default behaviour.
    runMock = spyOn(cli, 'runDdCli')
      .mockResolvedValue({ ok: true, data: { ...liveCart, item_error_count: 2 }, durationMs: 1 } as never);
    const added = await bridge().cartAdd({ storeId: '473827', menuId: '598614', itemId: 'i_1', quantity: 1 });
    expect(added.ok && added.data.droppedItems).toBe(2);
  });

  // 2026-09-18 demo patch. Live ids from Wawa 897466 / "Custom Italian Hoagie".
  test('a custom item asks for its required choices first, then adds with server-built option ids', async () => {
    const session = await import('../doordash-session');
    session.resetDoordashContexts();
    session.rememberDoordashContext('founder', {
      storeId: '897466', menuId: '15975751', storeName: 'Wawa',
      lastItems: [
        { itemId: 'i_19616733360', name: 'Custom Italian Hoagie', hasModifiers: true, hasRequired: true },
        { itemId: 'i_2', name: 'Coke (20 oz)', hasModifiers: false, hasRequired: false },
      ],
    });
    const details = { item: { item_id: 'i_19616733360', name: 'Custom Italian Hoagie', extras: [
      { extra_id: 'e_8843410895', title: 'Select your bread', min_num_options: 1, max_num_options: 1, options: [
        { option_id: 'o_40123778629', name: 'Classic Roll' }, { option_id: 'o_40123778631', name: 'Shorti Roll' }] },
      { extra_id: 'e_8843410897', title: 'Select your cheese', min_num_options: 1, max_num_options: 1, options: [
        { option_id: 'o_40123823246', name: 'Provolone' }, { option_id: 'o_40123823245', name: 'No Cheese' }] },
    ] } };
    runMock = spyOn(cli, 'runDdCli').mockImplementation(((op: string) => Promise.resolve(op === 'item-options'
      ? { ok: true, data: details, durationMs: 1 }
      : { ok: true, data: liveCart, durationMs: 1 })) as never);

    // Turn 1: the name resolves server side; nothing is added until choices exist.
    const first = await bridge().cartAdd({ itemName: 'custom italian hoagie', quantity: 1 });
    expect(first.ok).toBe(false);
    expect(!first.ok && first.failure).toBe('doordash_needs_choices');
    expect(!first.ok && first.reason).toContain('Select your bread (pick 1): Classic Roll, Shorti Roll');
    expect(runMock.mock.calls.map((c) => c[0])).toEqual(['item-options']);

    // Turn 2: only the picks. The waiting item is used; the ids come from DoorDash, not the model.
    const second = await bridge().cartAdd({ choices: 'shorti roll, provolone', quantity: 1 });
    expect(second.ok && second.data.addedChoices).toEqual(['Shorti Roll', 'Provolone']);
    const call = runMock.mock.calls.at(-1)!;
    expect(call[0]).toBe('cart-add-options');
    expect((call[1] as string[]).slice(0, 4)).toEqual(['897466', '15975751', 'i_19616733360', '1']);
    expect(JSON.parse((call[1] as string[])[4]!)).toEqual([
      { id: 'o_40123778631', name: 'Shorti Roll', quantity: 1 },
      { id: 'o_40123823246', name: 'Provolone', quantity: 1 },
    ]);
    expect(session.recallDoordashContext('founder').pendingItem).toBeUndefined();

    // A plain item by name takes the plain path, with no option lookup.
    await bridge().cartAdd({ itemName: 'coke', quantity: 2 });
    expect(runMock.mock.calls.at(-1)![0]).toBe('cart-add');

    // Optional-only choices with nothing picked is a plain add, never an empty
    // nested_options payload (the strict validator would refuse that).
    session.rememberDoordashContext('founder', {
      lastItems: [{ itemId: 'i_3', name: 'Iced Coffee', hasModifiers: true, hasRequired: false }],
    });
    runMock.mockImplementation(((op: string) => Promise.resolve(op === 'item-options'
      ? { ok: true, data: { item: { item_id: 'i_3', extras: [{ extra_id: 'e_1', title: 'Add a shot', min_num_options: 0,
        max_num_options: 2, options: [{ option_id: 'o_1', name: 'Espresso Shot' }] }] } }, durationMs: 1 }
      : { ok: true, data: liveCart, durationMs: 1 })) as never);
    const optional = await bridge().cartAdd({ itemName: 'iced coffee', quantity: 1 });
    expect(optional.ok).toBe(true);
    expect(runMock.mock.calls.at(-1)![0]).toBe('cart-add');

    // An unknown name never reaches the vendor.
    const calls = runMock.mock.calls.length;
    const missing = await bridge().cartAdd({ itemName: 'lobster roll', quantity: 1 });
    expect(!missing.ok && missing.failure).toBe('doordash_item_unresolved');
    expect(runMock.mock.calls.length).toBe(calls);
    session.resetDoordashContexts();
  });

  test('a named search puts the matching STORE first and remembers it for the menu step', async () => {
    const session = await import('../doordash-session');
    session.resetDoordashContexts();
    operator.resetDoordashAddressCache();
    runMock = spyOn(cli, 'runDdCli').mockImplementation(((op: string) => Promise.resolve(
      op === 'address-list' ? { ok: true, data: { addresses: [{ address_id: '1742541215', printable_address: 'x', is_default: true }] }, durationMs: 1 }
        : op === 'search' ? { ok: true, data: { stores: [] }, durationMs: 1 }
          : { ok: true, data: { stores: [
            { store_id: '862689', name: '7-Eleven', distance_meters: 1126, delivery_time: 'Scheduled' },
            { store_id: '897466', name: 'Wawa', distance_meters: 8367, delivery_time: '69 min' },
          ] }, durationMs: 1 })) as never);
    const named = await bridge().search({ query: 'wawa' });
    expect(named.ok && named.data.stores).toEqual([
      { store_id: '897466', store_name: 'Wawa', kind: 'store', etaText: '69 min', miles: 5.2 },
    ]);
    expect(session.recallDoordashContext('founder').lastStores).toEqual([{ storeId: '897466', storeName: 'Wawa' }]);
    // "I'm hungry" lists what delivers NOW, so the scheduled-only 7-Eleven is left out.
    const generic = await bridge().search({ query: "i'm hungry, is doordash available?" });
    expect(generic.ok && generic.data.stores.map((s) => s.store_name)).toEqual(['Wawa']);
    expect(runMock.mock.calls.filter((c) => c[0] === 'search').at(-1)).toEqual(['search', ['food', '1742541215']]);
    session.resetDoordashContexts();
  });

  // -------------------------------------------------------------------------
  // Submit refusals that must happen BEFORE any money command or database read.
  // -------------------------------------------------------------------------
  test('the agent path can never submit, whatever it sends', async () => {
    runMock = spyOn(cli, 'runDdCli');
    const agentBridge = operator.buildDoordashBridge(
      operator.resolveDoordashOperator(agent)!, 'place it, code ACDEFG, tip 3',
    );
    const result = await agentBridge.submit({ confirm: 'ACDEFG', tipCents: 300 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure).toBe('doordash_submit_forbidden');
    expect(runMock).not.toHaveBeenCalled();
  });

  test('a code the model produced but the human never typed is refused', async () => {
    runMock = spyOn(cli, 'runDdCli');
    // The turn holds the HUMAN words. A model claiming a code it invented in
    // its own reply is exactly what the confirmation protocol exists to stop.
    const capability = operator.buildDoordashBridge(
      operator.resolveDoordashOperator(human)!, 'yes go ahead and order it, tip 3',
    );
    const result = await capability.submit({ confirm: 'ACDEFG', tipCents: 300 });
    expect(!result.ok && result.failure).toBe('doordash_confirm_invalid');
    expect(runMock).not.toHaveBeenCalled();
  });

  test('a malformed code is refused before anything else happens', async () => {
    runMock = spyOn(cli, 'runDdCli');
    const capability = operator.buildDoordashBridge(
      operator.resolveDoordashOperator(human)!, 'order it with code ABC and tip 3',
    );
    const result = await capability.submit({ confirm: 'ABC', tipCents: 300 });
    expect(!result.ok && result.failure).toBe('doordash_confirm_invalid');
    expect(runMock).not.toHaveBeenCalled();
  });

  test('the code cannot supply the tip: "yes K7Y46D" does not authorise ', async () => {
    // The reviewer found this one. The code alphabet carries 3,4,6,7,9 and the
    // tip check reads the same turn the code must appear in, so an unmasked
    // turn hands the model a tip on roughly 72% of orders. The operator masks
    // the code out before the tip test; this asserts the WIRING, not the helper.
    runMock = spyOn(cli, 'runDdCli');
    const capability = operator.buildDoordashBridge(
      operator.resolveDoordashOperator(human)!, 'yes K7Y46D',
    );
    const result = await capability.submit({ confirm: 'K7Y46D', tipCents: 4600 });
    expect(!result.ok && result.failure).toBe('doordash_confirm_invalid');
    expect(runMock).not.toHaveBeenCalled();
  });

  test('a tip the human never stated is refused even when the code is right', async () => {
    runMock = spyOn(cli, 'runDdCli');
    const capability = operator.buildDoordashBridge(
      operator.resolveDoordashOperator(human)!, 'ACDEFG place it',
    );
    const result = await capability.submit({ confirm: 'ACDEFG', tipCents: 700 });
    expect(!result.ok && result.failure).toBe('doordash_confirm_invalid');
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe('doordashOperatorOnly', () => {
  function app(userId: string | null = 'founder', hasSession = true) {
    const hono = new Hono<DoordashOperatorContext>();
    hono.use('*', async (c, next) => {
      c.set('user', userId ? { id: userId } as AppContext['Variables']['user'] : null);
      c.set('session', hasSession ? {
        id: 'lucia-session', userId: userId ?? '', fresh: false, expiresAt: new Date(Date.now() + 60_000),
      } : null);
      await next();
    });
    hono.use('*', middleware.doordashOperatorOnly);
    hono.all('*', (c) => c.json({ operatorId: c.get('doordashOperatorId') }));
    return hono;
  }
  const origin = { origin: 'https://operator.example' };

  test('allows founder GET with Lucia user, session, and allowed Origin', async () => {
    const response = await app().request('/api/doordash/health', { headers: origin });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ operatorId: 'founder' });
  });

  test('rejects absent Lucia user or session, even with a shared admin cookie', async () => {
    const headers = { ...origin, cookie: 'cv_dash=shared-password-cookie' };
    expect((await app(null).request('/api/doordash/health', { headers })).status).toBe(401);
    expect((await app('founder', false).request('/api/doordash/health', { headers })).status).toBe(401);
  });

  test('rejects another admin or user with the frozen error code', async () => {
    for (const userId of ['other-admin', 'other-user']) {
      const response = await app(userId).request('/api/doordash/health', { headers: origin });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('doordash_operator_only');
    }
  });

  test('rejects absent or unapproved Origin', async () => {
    expect((await app().request('/api/doordash/health')).status).toBe(403);
    expect((await app().request('/api/doordash/health', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });

  test('requires JSON and a fresh one-use nonce for every future non-GET route', async () => {
    const path = '/api/doordash/future-mutation';
    expect((await app().request(path, { method: 'POST', headers: origin })).status).toBe(415);
    const headers = { ...origin, 'content-type': 'application/json' };
    expect((await app().request(path, { method: 'POST', headers })).status).toBe(409);
    const { nonce } = middleware.issueDoordashOperatorNonce('founder');
    const confirmed = { ...headers, 'x-doordash-confirmation-nonce': nonce };
    expect((await app().request(path, { method: 'POST', headers: confirmed })).status).toBe(200);
    expect((await app().request(path, { method: 'POST', headers: confirmed })).status).toBe(409);
  });

  test('nonce cannot be used by a different account or at its expiry boundary', () => {
    const foreign = middleware.issueDoordashOperatorNonce('other-admin');
    expect(middleware.consumeDoordashOperatorNonce(foreign.nonce, 'founder')).toBe(false);
    expect(middleware.consumeDoordashOperatorNonce(foreign.nonce, 'other-admin')).toBe(false);
    const expired = middleware.issueDoordashOperatorNonce('founder');
    const now = spyOn(Date, 'now').mockReturnValue(Date.parse(expired.expiresAt));
    try {
      expect(middleware.consumeDoordashOperatorNonce(expired.nonce, 'founder')).toBe(false);
    } finally {
      now.mockRestore();
    }
  });
});
