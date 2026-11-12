import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { useGameStore } from '@/stores/game';

describe('Exchange and Trading Floor windows', () => {
  test('opening each window closes the other and clears nested Exchange Escape state', () => {
    useGameStore.setState({ exchangeOpen: true, exchangeEscapeOwnedByDialog: true });
    useGameStore.getState().openTradingFloor();
    expect(useGameStore.getState()).toMatchObject({ exchangeOpen: false, tradingFloorOpen: true, exchangeEscapeOwnedByDialog: false });
    useGameStore.getState().openExchange();
    expect(useGameStore.getState()).toMatchObject({ exchangeOpen: true, tradingFloorOpen: false, exchangeTab: 'browse' });
    useGameStore.getState().closeExchange();
    useGameStore.getState().openTradingFloor();
    useGameStore.getState().closeTradingFloor();
    expect(useGameStore.getState().tradingFloorOpen).toBe(false);
  });
  test('Exchange exposes only its four marketplace tabs', () => {
    const source = readFileSync(new URL('./exchange-modal.tsx', import.meta.url), 'utf8');
    for (const key of ['browse', 'my-listings', 'my-orders', 'post']) expect(source).toContain(`key: '${key}'`);
    expect(source).not.toContain("key: 'floor'");
    expect(source).not.toContain('<TradingFloorTab');
  });
});
