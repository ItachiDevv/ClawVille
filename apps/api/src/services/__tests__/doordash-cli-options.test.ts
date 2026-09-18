import { describe, expect, test } from 'bun:test';
import { ddCliArgvForTest, parseDdCliPayload } from '../doordash-cli';

const ok = JSON.stringify([
  { id: 'o_40123778631', name: 'Shorti Roll', quantity: 1 },
  { id: 'o_42983071027', name: 'Red Wine Vinegar', quantity: 1, options: [{ id: 'o_42983071029', name: 'Red Wine Vinegar', quantity: 1 }] },
]);

describe('cart add with option choices', () => {
  test('builds nested_options from the validated structure', () => {
    const argv = ddCliArgvForTest('cart-add-options', ['897466', '15975751', 'i_19616733360', '1', ok]);
    expect(argv).not.toBeNull();
    const items = JSON.parse(argv![argv!.indexOf('--items-json') + 1]);
    expect(items).toEqual([{ item_id: 'i_19616733360', item_name: 'item', quantity: 1, nested_options: JSON.parse(ok) }]);
    expect(argv).not.toContain('--cart-uuid');
  });

  test('refuses any key beyond id, name, quantity and one level of options', () => {
    const smuggled = [
      JSON.stringify([{ id: 'o_1', name: 'A', quantity: 1, spend_limit_cents: 999999 }]),
      JSON.stringify([{ id: 'o_1', name: 'A', quantity: 1, options: [{ id: 'o_2', name: 'B', quantity: 1, options: [] }] }]),
      JSON.stringify([{ id: '--group-cart', name: 'A', quantity: 1 }]),
      JSON.stringify([{ id: 'o_1', name: 'A', quantity: 99 }]),
      JSON.stringify([]),
      'not json',
    ];
    for (const value of smuggled) {
      expect(ddCliArgvForTest('cart-add-options', ['897466', '15975751', 'i_1', '1', value])).toBeNull();
    }
  });

  test('store discovery and item options use fixed flags only', () => {
    expect(ddCliArgvForTest('nearby-stores', ['1742541215'])).toEqual(expect.arrayContaining(
      ['find-nearby-stores', '--vertical', 'nv', '--max', '100', '--address-id', '1742541215']));
    expect(ddCliArgvForTest('nearby-stores', ['--vertical'])).toBeNull();
    expect(ddCliArgvForTest('item-options', ['897466', '15975751', 'i_19616733360'])).toEqual(expect.arrayContaining(
      ['restaurant-item-details', '--store-id', '897466', '--menu-id', '15975751', '--item-id', 'i_19616733360']));
  });

  test('parses the live nearby-stores and item-details shapes', () => {
    expect(parseDdCliPayload('nearby-stores', { stores: [
      { store_id: '897466', name: 'Wawa', distance_meters: 8367, delivery_time: '69 min', image_url: '' },
      { store_id: '862689', name: '7-Eleven', distance_meters: 1126, delivery_time: 'Scheduled' },
    ], success: true }).ok).toBe(true);
    expect(parseDdCliPayload('item-options', { item: {
      item_id: 'i_19616733360', name: 'Custom Italian Hoagie', price: 5.29,
      extras: [{ extra_id: 'e_8843410895', title: 'Select your bread', min_num_options: 1, max_num_options: 1, num_free_options: 0,
        options: [{ option_id: 'o_40123778629', name: 'Classic Roll', price: 4.3, extras: [], is_default: false, default_quantity: 0 }] }],
    }, success: true, message: '' }).ok).toBe(true);
  });
});
