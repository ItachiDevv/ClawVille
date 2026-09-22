import { describe, expect, test } from 'bun:test';
import { fingerprintDoordashQuote } from '../doordash-quote';
function payload() {
  return { cart_uuid: 'cart', quote: { total_before_tip: { unit_amount: 1000 },
    delivery_address: { printable_address: 'Test address', subpremise: 'A' },
    delivery_availability: { asap_minutes_range_string: '20-30 min' },
    store_order_cart: { store: { id: 'store' }, is_consumer_pickup: false, fulfillment_type: 'DELIVERY',
      orders: [{ order_items: [{ id: 'line', item: { id: 'item', name: 'Test food' }, quantity: 1,
        nested_options: [{ id: 'bread' }, { id: 'cheese' }], unit_price_monetary_fields: { display_string: '$10.00' } }] }] } } };
}
describe('durable DoorDash quote identity', () => {
  test('stores only a SHA256 digest and preserves vendor array order', () => {
    const original = payload(); const reordered = payload();
    reordered.quote.store_order_cart.orders[0].order_items[0].nested_options.reverse();
    const digest = fingerprintDoordashQuote(original);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintDoordashQuote(reordered)).not.toBe(digest);
    expect(fingerprintDoordashQuote({ quote: original.quote, cart_uuid: original.cart_uuid })).toBe(digest);
    expect(digest).not.toContain('Test');
  });
  test.each(['store', 'item', 'line', 'quantity', 'option', 'address', 'unit', 'fulfillment'])('%s changes identity', (change) => {
    const original = payload(); const changed = payload();
    const cart = changed.quote.store_order_cart; const line = cart.orders[0].order_items[0];
    if (change === 'store') cart.store.id = 'other';
    if (change === 'item') line.item.id = 'other';
    if (change === 'line') line.id = 'other';
    if (change === 'quantity') line.quantity = 2;
    if (change === 'option') line.nested_options[0].id = 'other';
    if (change === 'address') changed.quote.delivery_address.printable_address = 'Other address';
    if (change === 'unit') changed.quote.delivery_address.subpremise = 'B';
    if (change === 'fulfillment') { cart.is_consumer_pickup = true; cart.fulfillment_type = 'PICKUP'; }
    expect(fingerprintDoordashQuote(changed)).not.toBe(fingerprintDoordashQuote(original));
  });
  test('volatile ETA, pricing, and display formats do not change identity', () => {
    const original = payload(); const changed = payload();
    changed.quote.delivery_availability.asap_minutes_range_string = '30-40 min';
    changed.quote.total_before_tip.unit_amount = 1100;
    changed.quote.store_order_cart.orders[0].order_items[0].unit_price_monetary_fields.display_string = '$11.00';
    expect(fingerprintDoordashQuote(changed)).toBe(fingerprintDoordashQuote(original));
  });
  test.each(['cart', 'store', 'item', 'line', 'quantity', 'address', 'fulfillment'])('missing %s cannot mint a confirmation', (missing) => {
    const p = payload(); const cart = p.quote.store_order_cart; const line = cart.orders[0].order_items[0];
    if (missing === 'cart') p.cart_uuid = '';
    if (missing === 'store') cart.store.id = '';
    if (missing === 'item') line.item.id = '';
    if (missing === 'line') line.id = '';
    if (missing === 'quantity') line.quantity = 0;
    if (missing === 'address') p.quote.delivery_address.printable_address = '';
    if (missing === 'fulfillment') cart.fulfillment_type = 'PICKUP';
    expect(fingerprintDoordashQuote(p)).toBeNull();
  });
});
