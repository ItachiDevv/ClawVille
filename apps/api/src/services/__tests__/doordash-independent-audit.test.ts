import { describe, expect, test } from 'bun:test';
import { tipStatedByRequester } from '../doordash-confirm';
import { fingerprintDoordashQuote } from '../doordash-quote';

describe('independent DoorDash authorization review', () => {
  test.each([
    'tip 4 euros', 'tip 4,50', 'tip 4 to 5 dollars', 'tip 4 and 5',
    'tip 4; actually 5', 'tip 4 less than before',
    'cancel the order, tip 4', 'avoid a tip 4', 'I refuse to tip 4',
  ])('ambiguous authorization fails closed: %s', (turn) => {
    expect(tipStatedByRequester(turn, 400)).toBe(false);
  });
  test('a thousands separator cannot truncate the tip', () => {
    expect(tipStatedByRequester('tip 1,000', 100)).toBe(false);
  });
  test('zero tip does not override a cancellation', () => {
    expect(tipStatedByRequester('cancel the order, no tip', 0)).toBe(false);
  });
  const quote = () => ({ cart_uuid: 'basket', quote: {
    delivery_address: { printable_address: '1 Main St', subpremise: 'A' },
    store_order_cart: { store: { id: 'restaurant' }, is_consumer_pickup: false,
      orders: [{ order_items: [{ id: 'line', quantity: 1,
        item: { id: 'food', name: 'Food' }, nested_options: [{ id: 'option', quantity: 1 }] }] }] },
  } });
  test('apartment-only destination change changes the fingerprint', () => {
    const first = quote(); const next = quote(); next.quote.delivery_address.subpremise = 'B';
    expect(fingerprintDoordashQuote(first)).not.toBe(fingerprintDoordashQuote(next));
  });
  test('option quantity changes the fingerprint', () => {
    const first = quote(); const next = quote();
    next.quote.store_order_cart.orders[0].order_items[0].nested_options[0].quantity = 2;
    expect(fingerprintDoordashQuote(first)).not.toBe(fingerprintDoordashQuote(next));
  });
  test('unknown ordered raw arrays must not collapse into one authorization fingerprint', () => {
    const first = quote(), next = quote();
    Object.assign(first.quote.delivery_address, { coordinate_pair: [12, 34] });
    Object.assign(next.quote.delivery_address, { coordinate_pair: [34, 12] });
    expect(fingerprintDoordashQuote(first)).not.toBe(fingerprintDoordashQuote(next));
  });
  test.each(['cart_uuid', 'store', 'quantity', 'address'])('incomplete %s fails closed', (part) => {
    const next: any = quote();
    if (part === 'cart_uuid') delete next.cart_uuid;
    if (part === 'store') delete next.quote.store_order_cart.store.id;
    if (part === 'quantity') delete next.quote.store_order_cart.orders[0].order_items[0].quantity;
    if (part === 'address') delete next.quote.delivery_address;
    expect(fingerprintDoordashQuote(next)).toBeNull();
  });
});
