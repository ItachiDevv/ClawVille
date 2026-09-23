import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as cli from '../doordash-cli';
import { clearDoordashCart, recallDoordashContext, rememberDoordashContext, resetDoordashContexts } from '../doordash-session';
import type { DdOptionGroup } from '../doordash-options';
import type { Action } from '@clawville/agent-runtime';

// Load current source at runtime without adding another package to API rootDir.
const actionSource = '../../../../../packages/agent-runtime/src/actions/doordash.ts';
const { doordashCartAction } = await import(actionSource) as { doordashCartAction: Action };

// This suite uses real bridge/action code with synthetic vendor and database
// boundaries. A missing stub fails rather than reaching a vendor or payment.
let quoteInvalidations = 0;
mock.module('@clawville/database', () => ({
  db: { update: () => { quoteInvalidations++; return { set: () => ({ where: async () => {} }) }; } },
  doordashOrders: { userId: 'userId', status: 'status' },
  and: () => ({}), eq: () => ({}), sql: () => ({}),
}));
const { buildDoordashBridge } = await import('../doordash-operator');
const USER = 'independent-item-dialogue';
const items = [
  { itemId: 'sandwich-a', name: 'Custom Sandwich', hasModifiers: true, hasRequired: true },
  { itemId: 'sandwich-b', name: 'Turkey Sandwich', hasModifiers: true, hasRequired: true },
  { itemId: 'plain', name: 'Plain Fries', hasModifiers: true, hasRequired: false },
];
const requiredGroups: DdOptionGroup[] = [
  { extra_id: 'bread', title: 'Bread', min_num_options: 1, max_num_options: 1, options: [
    { option_id: 'classic', name: 'Classic Roll' }, { option_id: 'wheat', name: 'Wheat Bread' },
  ] },
  { extra_id: 'cheese', title: 'Cheese', min_num_options: 1, max_num_options: 1, options: [
    { option_id: 'provolone', name: 'Provolone' }, { option_id: 'swiss', name: 'Swiss' },
  ] },
];
type Write = { operation: string; args: string[]; storeAtCall?: string };
let writes: Write[];
let groups: DdOptionGroup[];
let detailsOverride: ((args: string[]) => Promise<unknown>) | undefined;
let writeFailure = false;
let vendor: ReturnType<typeof spyOn<typeof cli, 'runDdCli'>>;
let spawn: ReturnType<typeof spyOn<typeof Bun, 'spawn'>>;
const success = (data: unknown) => ({ ok: true, durationMs: 0, data });
const details = () => success({ item: { extras: structuredClone(groups) } });
const bridge = (requesterTurn = 'synthetic user turn') => buildDoordashBridge({
  kind: 'human', userId: USER, avatarId: 'independent-avatar', canSubmit: true,
}, requesterTurn);
const confirmDraft = () => bridge('add it').cartAdd({ choices: 'add it' });
const optionIds = (write: Write) => JSON.parse(write.args[4]!).map((option: { id: string }) => option.id);

beforeEach(() => {
  resetDoordashContexts();
  writes = [];
  groups = structuredClone(requiredGroups);
  detailsOverride = undefined;
  writeFailure = false;
  quoteInvalidations = 0;
  rememberDoordashContext(USER, {
    storeId: 'store-A', menuId: 'menu-A', storeName: 'Cafe A', cartUuid: 'existing-cart-A',
    menuSelection: { storeId: 'store-A', storeName: 'Cafe A' }, lastItems: items,
  });
  spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('Real vendor execution is forbidden'); });
  vendor = spyOn(cli, 'runDdCli').mockImplementation((async (operation: string, rawArgs: string[]) => {
    const args = [...rawArgs];
    if (operation === 'item-options') return detailsOverride ? detailsOverride(args) : details();
    if (operation === 'menu') return success({ menu_id: `menu-${args[0]!.slice(-1)}`, items: items.map((item) => ({
      item_id: item.itemId, name: item.name, has_modifiers: item.hasModifiers, has_required_modifiers: item.hasRequired,
    })) });
    if (operation === 'address-list') return success({ addresses: [{ address_id: 'address-fixture', is_default: true, printable_address: 'Synthetic' }] });
    if (operation === 'search') return success({ stores: [{ store_id: 'store-B', store_name: 'Cafe B' }] });
    if (operation === 'nearby-stores') return success({ stores: [] });
    if (operation === 'cart-add' || operation === 'cart-add-options') {
      writes.push({ operation, args, storeAtCall: recallDoordashContext(USER).storeId });
      if (writeFailure) return { ok: false, failure: 'ddcli_timeout', detail: 'synthetic mutation timeout', durationMs: 0 };
      return success({ cart_uuid: `result-cart-${args[0]}`, cart: {
        store_id: args[0], store_name: 'Synthetic Cafe', items: [
          { id: 'line-fixture', item_id: args[2], name: 'Synthetic item', quantity: Number(args[3]), price: 1 },
        ],
      }, item_error_count: 0 });
    }
    throw new Error(`Unexpected operation in isolated dialogue: ${operation}`);
  }) as never);
});

afterEach(() => {
  expect(spawn).not.toHaveBeenCalled();
  vendor.mockRestore();
  spawn.mockRestore();
  resetDoordashContexts();
});

describe('independent item customization dialogues', () => {
  test('separate choices and an explicit correction yield one correct cart addition', async () => {
    const capability = bridge();
    expect(await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 2 })).toMatchObject({ ok: false });
    expect(await capability.cartAdd({ choices: 'Classic Roll' })).toMatchObject({ ok: false });
    expect(await capability.cartAdd({ choices: 'Actually Wheat Bread' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    expect(await capability.cartAdd({ choices: 'Provolone' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    expect(await confirmDraft()).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
    expect(optionIds(writes[0]!)).toEqual(['wheat', 'provolone']);
    expect(writes[0]!.args[3]).toBe('2');
    expect(writes[0]!.args.at(-1)).toBe('existing-cart-A');
    // A repeated choice-only reply cannot duplicate the completed addition.
    expect(await capability.cartAdd({ choices: 'Provolone' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(1);
  });

  test('the actual action preserves omitted quantity but accepts an explicit change to one', async () => {
    const act = (parameters: Record<string, string>) => doordashCartAction.handler(null, { parameters: { op: 'add', ...parameters } }, { services: { doordash: bridge(parameters.choices ?? parameters.itemName) } });
    await act({ itemName: 'Custom Sandwich', quantity: '2' });
    await act({ choices: 'Classic Roll' });
    await act({ choices: 'Provolone', quantity: '1' });
    expect(writes).toHaveLength(0);
    await act({ choices: 'add it' });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.args[3]).toBe('1');
  });

  test('two partial answers in flight serialize into one addition', async () => {
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 1 });
    const replies = await Promise.all([
      capability.cartAdd({ choices: 'Classic Roll' }),
      capability.cartAdd({ choices: 'Provolone' }),
    ]);
    expect(replies.filter((reply) => reply.ok)).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(await confirmDraft()).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
    expect(optionIds(writes[0]!)).toEqual(['classic', 'provolone']);
  });

  test('conflicting alternatives do not silently select a bread', async () => {
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 1 });
    expect(await capability.cartAdd({ choices: 'Classic Roll or Wheat Bread' })).toMatchObject({ ok: false });
    expect(await capability.cartAdd({ choices: 'Provolone' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
  });

  test('unknown positive customization cannot become an optional-only plain addition', async () => {
    groups = [{ extra_id: 'sauce', title: 'Sauce', min_num_options: 0, max_num_options: 1,
      options: [{ option_id: 'ranch', name: 'Ranch' }] }];
    expect(await bridge().cartAdd({ itemName: 'Plain Fries', choices: 'with truffle sauce', quantity: 1 })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    expect(recallDoordashContext(USER).cartUuid).toBe('existing-cart-A');
  });

  test('an unknown new item invalidates the earlier pending item', async () => {
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 1 });
    await capability.cartAdd({ choices: 'Classic Roll' });
    expect(await capability.cartAdd({ itemName: 'Imaginary Taco', quantity: 1 })).toMatchObject({ ok: false });
    expect(await capability.cartAdd({ choices: 'Classic Roll, Provolone' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
  });

  test('a different item never inherits the former item choices', async () => {
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 2 });
    await capability.cartAdd({ choices: 'Classic Roll' });
    expect(await capability.cartAdd({ itemName: 'Turkey Sandwich', choices: 'Provolone', quantity: 1 })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    expect(await capability.cartAdd({ choices: 'Wheat Bread' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    expect(await confirmDraft()).toMatchObject({ ok: true });
    expect(writes[0]!.args[2]).toBe('sandwich-b');
    expect(writes[0]!.args[3]).toBe('1');
    expect(optionIds(writes[0]!)).toEqual(['wheat', 'provolone']);
  });

  test('vendor removal of an earlier choice requires a new answer', async () => {
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 1 });
    await capability.cartAdd({ choices: 'Classic Roll' });
    groups[0]!.options = [{ option_id: 'wheat', name: 'Wheat Bread' }];
    expect(await capability.cartAdd({ choices: 'Provolone' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
  });

  test('review leaves time for an optional removal before one explicit cart addition', async () => {
    groups.push({ extra_id: 'sauce', title: 'Sauce', min_num_options: 0, max_num_options: 2, options: [
      { option_id: 'mayo', name: 'Mayo', is_default: true }, { option_id: 'no-mayo', name: 'No Mayo' },
    ] });
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 1 });
    await capability.cartAdd({ choices: 'Classic Roll' });
    await capability.cartAdd({ choices: 'Provolone' });
    expect(writes).toHaveLength(0);
    expect(await capability.cartAdd({ choices: 'No Mayo' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    expect(await confirmDraft()).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
    expect(optionIds(writes[0]!)).toEqual(['classic', 'provolone', 'no-mayo']);
  });

  test('a model-authored review confirmation cannot override the raw negative turn', async () => {
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 1 });
    await capability.cartAdd({ choices: 'Classic Roll' });
    await capability.cartAdd({ choices: 'Provolone' });
    expect(await bridge('Do not add it').cartAdd({ choices: 'add it' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
  });

  test('unavailable option groups cannot authorize an unsupported customization', async () => {
    groups = [];
    expect(await bridge().cartAdd({ itemName: 'Plain Fries', choices: 'no salt', quantity: 1 })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
  });

  test('a failed option read preserves the existing cart and earlier valid choices', async () => {
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 1 });
    await capability.cartAdd({ choices: 'Classic Roll' });
    detailsOverride = async () => ({ ok: false, failure: 'ddcli_timeout', detail: 'synthetic read timeout', durationMs: 0 });
    expect(await capability.cartAdd({ choices: 'Provolone' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    expect(recallDoordashContext(USER).cartUuid).toBe('existing-cart-A');
    detailsOverride = undefined;
    await capability.cartAdd({ choices: 'Provolone' });
    expect(writes).toHaveLength(0);
    expect(await confirmDraft()).toMatchObject({ ok: true });
    expect(optionIds(writes[0]!)).toEqual(['classic', 'provolone']);
  });

  test('asking for the total does not price an older cart while the new item waits', async () => {
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 1 });
    expect(await capability.preview({})).toMatchObject({ ok: false });
    expect(vendor.mock.calls.some(([operation]) => operation === 'order-preview')).toBe(false);
    expect(writes).toHaveLength(0);
    expect(recallDoordashContext(USER).cartUuid).toBe('existing-cart-A');
  });

  test('the existing cart-clear lifecycle also removes its pending draft', async () => {
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 1 });
    await capability.cartAdd({ choices: 'Classic Roll' });
    clearDoordashCart(USER);
    expect(await capability.cartAdd({ choices: 'Classic Roll, Provolone' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    expect(recallDoordashContext(USER).cartUuid).toBeUndefined();
  });

  test('a failed cart addition cannot replay through a repeated choice-only confirmation', async () => {
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 1 });
    await capability.cartAdd({ choices: 'Classic Roll' });
    await capability.cartAdd({ choices: 'Provolone' });
    writeFailure = true;
    expect(await confirmDraft()).toMatchObject({ ok: false });
    expect(writes).toHaveLength(1);
    expect(await confirmDraft()).toMatchObject({ ok: false });
    expect(writes).toHaveLength(1);
  });

  test('explicit draft cancellation preserves the existing cart and quote', async () => {
    await bridge().cartAdd({ itemName: 'Custom Sandwich', choices: 'Classic Roll' });
    expect(await bridge('skip that item').cartAdd({ choices: 'skip that item' })).toMatchObject({
      ok: false, reason: 'I skipped that item. Your cart has not changed. What would you like next?',
    });
    expect(recallDoordashContext(USER).pendingItem).toBeUndefined();
    expect(recallDoordashContext(USER).cartUuid).toBe('existing-cart-A');
    expect(quoteInvalidations).toBe(0);
    expect(await bridge().cartAdd({ choices: 'Classic Roll, Provolone' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
  });

  test('model-authored cancellation cannot discard a draft without the raw request', async () => {
    await bridge().cartAdd({ itemName: 'Custom Sandwich', choices: 'Classic Roll' });
    expect(await bridge('Which cheeses are available?').cartAdd({ choices: 'skip that item' })).toMatchObject({ ok: false });
    expect(recallDoordashContext(USER).pendingItem).toBeDefined();
    expect(recallDoordashContext(USER).cartUuid).toBe('existing-cart-A');
    expect(quoteInvalidations).toBe(0);
    expect(writes).toHaveLength(0);
  });

  test.each(['I cannot have mayo', 'no peanuts', 'with truffle sauce'])(
    'an unrelated cheese answer cannot erase the unresolved request: %s', async (request) => {
      groups.push({ extra_id: 'sauce', title: 'Sauce', min_num_options: 0, max_num_options: 2,
        options: [{ option_id: 'mayo', name: 'Mayo' }, { option_id: 'no-mayo', name: 'No Mayo' }] });
      const capability = bridge();
      await capability.cartAdd({ itemName: 'Custom Sandwich', choices: 'Classic Roll, Mayo' });
      expect(await capability.cartAdd({ choices: request })).toMatchObject({ ok: false });
      expect(await capability.cartAdd({ choices: 'Provolone' })).toMatchObject({ ok: false });
      expect(await confirmDraft()).toMatchObject({ ok: false });
      expect(writes).toHaveLength(0);
    });

  test('only an explicit withdrawal restores review without adding the item', async () => {
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', choices: 'Classic Roll, with truffle sauce' });
    await capability.cartAdd({ choices: 'Provolone' });
    await bridge('Do not keep those choices').cartAdd({ choices: 'keep these choices' });
    expect(await confirmDraft()).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    expect(await bridge('keep these choices').cartAdd({ choices: 'keep these choices' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    expect(await confirmDraft()).toMatchObject({ ok: true });
    expect(optionIds(writes[0]!)).toEqual(['classic', 'provolone']);
  });

  test('withdrawal does not erase a separate blocked ingredient group', async () => {
    groups.push({ extra_id: 'sauce', title: 'Sauce', min_num_options: 0, max_num_options: 2,
      options: [{ option_id: 'mayo', name: 'Mayo' }, { option_id: 'no-mayo', name: 'No Mayo' }] });
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', choices: 'Classic Roll, Mayo' });
    await capability.cartAdd({ choices: 'I cannot have mayo' });
    await capability.cartAdd({ choices: 'no peanuts' });
    await capability.cartAdd({ choices: 'Provolone' });
    await bridge('keep these choices').cartAdd({ choices: 'keep these choices' });
    expect(await confirmDraft()).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    await capability.cartAdd({ choices: 'No Mayo' });
    expect(await confirmDraft()).toMatchObject({ ok: true });
    expect(optionIds(writes[0]!)).toEqual(['classic', 'provolone', 'no-mayo']);
  });

  test('one short answer does not choose identical names in two required groups', async () => {
    groups = [
      { extra_id: 'size', title: 'Size', min_num_options: 1, max_num_options: 1,
        options: [{ option_id: 'size-regular', name: 'Regular' }, { option_id: 'size-large', name: 'Large' }] },
      { extra_id: 'style', title: 'Style', min_num_options: 1, max_num_options: 1,
        options: [{ option_id: 'style-regular', name: 'Regular' }, { option_id: 'style-crispy', name: 'Crispy' }] },
    ];
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 1 });
    await capability.cartAdd({ choices: 'Regular' });
    expect(await confirmDraft()).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    await capability.cartAdd({ choices: 'Regular' });
    expect(await confirmDraft()).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
    expect(optionIds(writes[0]!)).toEqual(['size-regular', 'style-regular']);
  });

  test('new discovery and expired context cannot resume old customizations', async () => {
    const capability = bridge();
    await capability.cartAdd({ itemName: 'Custom Sandwich', quantity: 1 });
    await capability.cartAdd({ choices: 'Classic Roll' });
    await capability.search({ query: 'Cafe B' });
    expect(await capability.cartAdd({ choices: 'Classic Roll, Provolone' })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    try {
      expect(await capability.cartAdd({ choices: 'Classic Roll, Provolone' })).toMatchObject({ ok: false });
      expect(writes).toHaveLength(0);
    } finally { clock.mockRestore(); }
  });

  test('menu changes cannot overtake a customization read and attach the wrong cart', async () => {
    const capability = bridge();
    let release!: (result: unknown) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    detailsOverride = () => new Promise((resolve) => { release = resolve; signalStarted(); });
    const addition = capability.cartAdd({ itemName: 'Custom Sandwich', choices: 'Classic Roll, Provolone', quantity: 1 });
    await started;
    const newMenu = capability.menu({ storeId: 'store-B' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(details());
    await Promise.all([addition, newMenu]);
    for (const write of writes) {
      expect(write.storeAtCall).toBeDefined();
      expect(write.args[0]).toBe(write.storeAtCall!);
    }
    expect(recallDoordashContext(USER).storeId).toBe('store-B');
    expect(recallDoordashContext(USER).cartUuid).not.toBe('result-cart-store-A');
  });
});
