import { describe, expect, test } from 'bun:test';
import { RECORDED_CASES } from '../fixtures/recorded';

describe('recorded payloads match landed HTTP shapes', () => {
  test('blackjack deal uses direct playerHand wire, not a render-model hand', () => {
    const body = RECORDED_CASES[0]!.records[0]!.responseBody as Record<string, unknown>;
    expect(Array.isArray(body.playerHand)).toBe(true);
    expect(body.hand).toBeUndefined();
    expect(body.playerHands).toBeUndefined();
  });

  test('baccarat coup carries outcome but no invented UI banner/selection', () => {
    const body = RECORDED_CASES[2]!.records[0]!.responseBody as Record<string, unknown>;
    expect(body.outcome).toBeDefined();
    expect(body.bannerText).toBeUndefined();
    expect(body.betzoneSelected).toBeUndefined();
  });

  test('holdem resync is the direct humanHole/board/publicActionLog shape', () => {
    const body = RECORDED_CASES[3]!.records[0]!.responseBody as Record<string, unknown>;
    expect(Array.isArray(body.humanHole)).toBe(true);
    expect(Array.isArray(body.board)).toBe(true);
    expect(Array.isArray(body.publicActionLog)).toBe(true);
    expect(body.hand).toBeUndefined();
  });
});
