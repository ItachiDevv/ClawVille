import { describe, expect, test, mock } from 'bun:test';
import { doordashCartAction, doordashPreviewAction, doordashSubmitAction } from './doordash';

/** A bridge whose methods record their arguments and return a fixed result. */
function bridgeWith(overrides: Record<string, unknown>) {
  return { services: { doordash: overrides } };
}

const cartData = {
  cartUuid: 'cart-1',
  storeName: 'Rojas Pizza',
  items: [{ lineId: 'line-1', name: 'Garlic Knots', quantity: 2, unitPriceCents: 695 }],
  droppedItems: 0,
};

describe('DOORDASH_CART', () => {
  test('add refuses a fractional or out of range quantity without calling the bridge', async () => {
    const cartAdd = mock(async () => ({ ok: true, data: cartData, durationMs: 1 }));
    const state = bridgeWith({ cartAdd });
    // An ABSENT quantity is not in this list: omitting it means one, by design.
    for (const quantity of ['0', '21', '1.5', 'two', '-1', '1e1', '0x10']) {
      const result = await doordashCartAction.handler(null, {
        parameters: { op: 'add', storeId: '1', menuId: '2', itemId: '3', quantity },
      }, state);
      expect(result.success).toBe(false);
      expect(result.persist).toBe(false);
    }
    expect(cartAdd).not.toHaveBeenCalled();
  });

  test('add defaults to one and passes the ids through', async () => {
    const cartAdd = mock(async () => ({ ok: true, data: cartData, durationMs: 1 }));
    await doordashCartAction.handler(null, {
      parameters: { op: 'add', storeId: '473827', menuId: '598614', itemId: 'i_57160719' },
    }, bridgeWith({ cartAdd }));
    expect(cartAdd).toHaveBeenCalledWith({
      storeId: '473827', menuId: '598614', itemId: 'i_57160719', quantity: 1, cartUuid: undefined,
    });
  });

  test('add works without a store or menu id, which the model cannot recall', async () => {
    // DoorDash output never enters chat memory, so by a later turn the model has
    // no ids at all. The server holds the in-flight order context instead.
    const cartAdd = mock(async () => ({ ok: true, data: cartData, durationMs: 1 }));
    const result = await doordashCartAction.handler(null, {
      parameters: { op: 'add', itemId: 'i_1' },
    }, bridgeWith({ cartAdd }));
    expect(result.success).toBe(true);
    expect(cartAdd).toHaveBeenCalledWith({
      storeId: undefined, menuId: undefined, itemId: 'i_1', quantity: 1, cartUuid: undefined,
    });
  });

  test('add still needs to know WHICH item', async () => {
    const cartAdd = mock(async () => ({ ok: true, data: cartData, durationMs: 1 }));
    const result = await doordashCartAction.handler(null, {
      parameters: { op: 'add', storeId: '1', menuId: '2' },
    }, bridgeWith({ cartAdd }));
    expect(result.success).toBe(false);
    expect(cartAdd).not.toHaveBeenCalled();
  });

  test('a dropped item is reported, never swallowed', async () => {
    const cartAdd = mock(async () => ({
      ok: true, data: { ...cartData, droppedItems: 1 }, durationMs: 1,
    }));
    const result = await doordashCartAction.handler(null, {
      parameters: { op: 'add', storeId: '1', menuId: '2', itemId: '3' },
    }, bridgeWith({ cartAdd }));
    expect(result.success).toBe(true);
    expect(result.text).toContain('could not be added');
  });

  test('remove needs both the cart and the line', async () => {
    const cartRemove = mock(async () => ({ ok: true, data: cartData, durationMs: 1 }));
    const result = await doordashCartAction.handler(null, {
      parameters: { op: 'remove', cartUuid: 'cart-1' },
    }, bridgeWith({ cartRemove }));
    expect(result.success).toBe(false);
    expect(cartRemove).not.toHaveBeenCalled();
  });
});

describe('DOORDASH_PREVIEW', () => {
  test('shows the real total, asks for a tip, and surfaces the code', async () => {
    const preview = mock(async () => ({
      ok: true,
      durationMs: 1,
      data: {
        items: [{ name: 'Garlic Knots', quantity: 2 }],
        storeName: 'Rojas Pizza',
        lines: [
          { label: 'Subtotal', amount: '$6.95' },
          { label: 'Estimated Tax', amount: '$0.75' },
          { label: 'Service Fee', amount: '$2.99' },
        ],
        totalBeforeTipCents: 1069,
        etaText: '25-40 min',
        tipSuggestionsCents: [150, 200],
        confirmCode: 'ACDEFG',
        expiresInMinutes: 10,
      },
    }));
    const result = await doordashPreviewAction.handler(null,
      { parameters: { cartUuid: 'cart-1' } }, bridgeWith({ preview }));
    expect(result.success).toBe(true);
    // The basket leads: an item the account owner did not choose must be
    // visible BEFORE the code is typed, not buried inside a total.
    expect(result.text).toContain('2 x Garlic Knots');
    expect(result.text).toContain('from Rojas Pizza');
    expect(result.text).toContain('$10.69');
    expect(result.text).toContain('Estimated Tax $0.75');
    expect(result.text).toContain('25-40 min');
    expect(result.text).toContain('$1.50');
    // The founder is ASKED for the tip here. It is never defaulted or chosen.
    expect(result.text).toContain('How much would you like to tip?');
    expect(result.text).toContain('ACDEFG');
    // Terms of service section 6: nothing from the CLI is kept in chat memory.
    expect(result.persist).toBe(false);
  });
});

describe('the confirmation must never quietly become a bare number', () => {
  // The basket and the store name are OPTIONAL fields in the vendor quote. A
  // safety property resting on an optional field has to fail LOUDLY, or the
  // founder silently goes back to approving a total with nothing to check it
  // against and no sign that anything went missing.
  function previewReturning(data: Record<string, unknown>) {
    return bridgeWith({
      preview: mock(async () => ({
        ok: true,
        durationMs: 1,
        data: {
          lines: [{ label: 'Subtotal', amount: '$6.95' }],
          totalBeforeTipCents: 1069,
          tipSuggestionsCents: [],
          confirmCode: 'ACDEFG',
          expiresInMinutes: 10,
          ...data,
        },
      })),
    });
  }

  test('says so when the basket cannot be read back', async () => {
    const result = await doordashPreviewAction.handler(null,
      { parameters: {} }, previewReturning({ items: [], storeName: 'Rojas Pizza' }));
    expect(result.text).toContain('could not read the basket back');
    // The code still has to be there; the warning replaces the basket, not the flow.
    expect(result.text).toContain('ACDEFG');
  });

  test('keeps the items it has and names the missing restaurant', async () => {
    const result = await doordashPreviewAction.handler(null,
      { parameters: {} }, previewReturning({ items: [{ name: 'Garlic Knots', quantity: 1 }] }));
    // The item names are still useful, so they are NOT thrown away; the gap is
    // reported alongside them rather than instead of them.
    expect(result.text).toContain('1 x Garlic Knots');
    expect(result.text).toContain('could not confirm which restaurant');
    expect(result.text).toContain('ACDEFG');
  });

  test('renders the basket normally when both are present', async () => {
    const result = await doordashPreviewAction.handler(null, { parameters: {} }, previewReturning({
      items: [{ name: 'Garlic Knots', quantity: 2 }], storeName: 'Rojas Pizza',
    }));
    expect(result.text).toContain('2 x Garlic Knots from Rojas Pizza');
    expect(result.text).not.toContain('could not read the basket');
  });
});

describe('DOORDASH_SUBMIT', () => {
  test('converts the stated dollars into cents exactly once', async () => {
    const submit = mock(async () => ({
      ok: true, durationMs: 1, data: { orderUuid: 'order-9', totalCents: 1069, tipCents: 0 },
    }));
    const state = bridgeWith({ submit });
    for (const [tip, cents] of [['4', 400], ['4.50', 450], ['$3', 300], ['0', 0]] as const) {
      await doordashSubmitAction.handler(null, { parameters: { confirm: 'ACDEFG', tip } }, state);
      expect(submit).toHaveBeenLastCalledWith({ confirm: 'ACDEFG', tipCents: cents });
    }
  });

  test('refuses a tip it cannot read rather than sending a default', async () => {
    const submit = mock(async () => ({
      ok: true, durationMs: 1, data: { orderUuid: 'order-9', totalCents: 1069, tipCents: 0 },
    }));
    const state = bridgeWith({ submit });
    for (const tip of ['', 'whatever is normal', '-2', '1000']) {
      const result = await doordashSubmitAction.handler(null,
        { parameters: { confirm: 'ACDEFG', tip } }, state);
      expect(result.success).toBe(false);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  test('refuses with no confirmation code at all', async () => {
    const submit = mock(async () => ({ ok: true, durationMs: 1, data: {} }));
    const result = await doordashSubmitAction.handler(null,
      { parameters: { tip: '4' } }, bridgeWith({ submit }));
    expect(result.success).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  test('reports the total actually charged, including the tip', async () => {
    const submit = mock(async () => ({
      ok: true, durationMs: 1, data: { orderUuid: 'order-9', totalCents: 1069, tipCents: 400 },
    }));
    const result = await doordashSubmitAction.handler(null,
      { parameters: { confirm: 'ACDEFG', tip: '4' } }, bridgeWith({ submit }));
    expect(result.text).toContain('$14.69');
    expect(result.text).toContain('$4.00 tip');
    expect(result.text).toContain('order-9');
  });

  test('shows the server written reason for a refusal, not a generic message', async () => {
    // `reason` is authored by our own bridge. Vendor text never reaches here:
    // the DoorDash error for a bad item literally instructs the caller to keep
    // retrying, which is exactly the prose that must not reach a model.
    const submit = mock(async () => ({
      ok: false, failure: 'doordash_cap_exceeded', detail: 'doordash_cap_exceeded',
      reason: 'That would be order 3 today and the limit is 2 a day.', durationMs: 1,
    }));
    const result = await doordashSubmitAction.handler(null,
      { parameters: { confirm: 'ACDEFG', tip: '4' } }, bridgeWith({ submit }));
    expect(result.success).toBe(false);
    expect(result.text).toBe('That would be order 3 today and the limit is 2 a day.');
  });

  test('falls back to safe prose when a failure carries no reason', async () => {
    const submit = mock(async () => ({
      ok: false, failure: 'ddcli_timeout', detail: 'raw vendor text that must not leak', durationMs: 1,
    }));
    const result = await doordashSubmitAction.handler(null,
      { parameters: { confirm: 'ACDEFG', tip: '4' } }, bridgeWith({ submit }));
    expect(result.text).not.toContain('raw vendor text');
    expect(result.text).toContain('DoorDash took too long');
  });
});
