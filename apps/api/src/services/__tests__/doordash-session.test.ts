import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  clearDoordashCart,
  recallDoordashContext,
  rememberDoordashContext,
  resetDoordashContexts,
  resolveStoreByName,
} from '../doordash-session';

// Reset on BOTH sides: the context is a module-level map shared by every suite
// in the process, and the operator suite populates it for the same user id.
beforeEach(() => resetDoordashContexts());
afterEach(() => resetDoordashContexts());

describe('the in-flight ordering context', () => {
  test('starts empty and accumulates without losing earlier fields', () => {
    expect(recallDoordashContext('founder')).toEqual({ lastStores: [] });
    rememberDoordashContext('founder', { storeId: '473827', storeName: 'Rojas Pizza' });
    rememberDoordashContext('founder', { menuId: '598614' });
    rememberDoordashContext('founder', { cartUuid: 'cart-1' });
    const context = recallDoordashContext('founder');
    expect(context.storeId).toBe('473827');
    expect(context.menuId).toBe('598614');
    expect(context.cartUuid).toBe('cart-1');
    expect(context.storeName).toBe('Rojas Pizza');
  });

  test('keeps operators separate', () => {
    rememberDoordashContext('founder', { cartUuid: 'cart-1' });
    expect(recallDoordashContext('someone-else').cartUuid).toBeUndefined();
  });

  test('returns a copy, so a caller cannot mutate the stored context', () => {
    rememberDoordashContext('founder', { cartUuid: 'cart-1' });
    const context = recallDoordashContext('founder');
    context.cartUuid = 'tampered';
    expect(recallDoordashContext('founder').cartUuid).toBe('cart-1');
  });

  test('caps the remembered store list', () => {
    rememberDoordashContext('founder', {
      lastStores: Array.from({ length: 40 }, (_, i) => ({ storeId: String(i), storeName: `Store ${i}` })),
    });
    // 30 since 2026-09-18: a search now merges restaurants AND stores.
    expect(recallDoordashContext('founder').lastStores).toHaveLength(30);
  });

  test('clearing the cart keeps the store the operator was browsing', () => {
    rememberDoordashContext('founder', { storeId: '473827', menuId: '598614', cartUuid: 'cart-1' });
    clearDoordashCart('founder');
    const context = recallDoordashContext('founder');
    // The cart is spent; the restaurant is still the one they were looking at.
    expect(context.cartUuid).toBeUndefined();
    expect(context.storeId).toBe('473827');
    expect(context.menuId).toBe('598614');
  });
});

describe('resolving a restaurant the operator named', () => {
  const context = {
    lastStores: [
      { storeId: '473827', storeName: 'Rojas Pizza' },
      { storeId: '420491', storeName: 'Papa Johns Pizza' },
      { storeId: '2418513', storeName: 'Pizza Hut' },
    ],
  };

  test('matches an exact name and a clear partial', () => {
    expect(resolveStoreByName(context, 'Rojas Pizza')?.storeId).toBe('473827');
    expect(resolveStoreByName(context, 'rojas')?.storeId).toBe('473827');
    expect(resolveStoreByName(context, 'Pizza Hut')?.storeId).toBe('2418513');
  });

  test('refuses an ambiguous name rather than picking one', () => {
    // Three of these contain "pizza". Ordering from the wrong restaurant is not
    // a recoverable mistake, so the caller has to ask instead of guessing.
    expect(resolveStoreByName(context, 'pizza')).toBeNull();
  });

  test('refuses an unknown or empty name', () => {
    expect(resolveStoreByName(context, 'Sushi Palace')).toBeNull();
    expect(resolveStoreByName(context, '   ')).toBeNull();
    expect(resolveStoreByName({ lastStores: [] }, 'Rojas Pizza')).toBeNull();
  });

  test('a very short store name cannot swallow a long spoken phrase', () => {
    // A store literally called "Pi" must not answer to "menu for Pizza Hut".
    // The reverse direction (a long name containing the spoken words) is the
    // safe one and stays enabled.
    const shortName = { lastStores: [{ storeId: '9', storeName: 'Pi' }] };
    expect(resolveStoreByName(shortName, 'Pizza Hut')).toBeNull();
    expect(resolveStoreByName(shortName, 'Pi')?.storeId).toBe('9');
    const longEnough = { lastStores: [{ storeId: '7', storeName: 'Rojas Pizza' }] };
    expect(resolveStoreByName(longEnough, 'Rojas Pizza please')?.storeId).toBe('7');
  });

  test('an exact match wins over a partial collision', () => {
    const tricky = {
      lastStores: [
        { storeId: '1', storeName: 'Pizza' },
        { storeId: '2', storeName: 'Pizza Hut' },
      ],
    };
    expect(resolveStoreByName(tricky, 'Pizza')?.storeId).toBe('1');
  });
});
