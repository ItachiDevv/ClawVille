import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TradeDecisionEvent, TradeTickerEvent } from '../../routes/world';

const root = resolve(import.meta.dir, '../../../../..');
const exchange = readFileSync(resolve(root, 'apps/api/src/routes/exchange.ts'), 'utf8');
const world = readFileSync(resolve(root, 'apps/api/src/routes/world.ts'), 'utf8');

describe('Trading Floor route integrity', () => {
  test('registers every Trading Floor route before the dynamic exchange route', () => {
    const dynamicIndex = exchange.indexOf("exchangeRoutes.get('/:id'");
    expect(dynamicIndex).toBeGreaterThan(0);
    for (const literal of [
      "exchangeRoutes.post('/trades/report'",
      "exchangeRoutes.get('/trades/mine'",
      "exchangeRoutes.get('/trades/feed'",
      "exchangeRoutes.get('/wallets/mine'",
      "exchangeRoutes.post('/wallets/bind'",
      "exchangeRoutes.post('/wallets/bind/challenge'",
      "exchangeRoutes.post('/wallets/bind/linked'",
      "exchangeRoutes.post('/wallets/bind/custodial'",
      "exchangeRoutes.post('/wallets/:pubkey/revoke'",
    ]) expect(exchange.indexOf(literal)).toBeLessThan(dynamicIndex);
  });

  test('keeps writes dual-authenticated, non-guest, and the feed public', () => {
    const registrationLines = exchange.split(/\r?\n/).filter((line) => line.startsWith('exchangeRoutes.post(\'/wallets') || line.startsWith("exchangeRoutes.post('/trades/report'"));
    expect(registrationLines).toHaveLength(6);
    for (const line of registrationLines) {
      expect(line).toContain('requireAuthOrAgentSession');
      expect(line).toContain('requireNonGuestIdentity');
    }
    const feedLine = exchange.split(/\r?\n/).find((line) => line.startsWith("exchangeRoutes.get('/trades/feed'"));
    expect(feedLine).toBeDefined();
    expect(feedLine).not.toContain('requireAuthOrAgentSession');
  });

  test('keeps the world publisher narrow and the privacy payload closed', () => {
    expect(world).not.toContain('landStreamSubscribers');
    expect(world.match(/worldStreamSubscribers\.delete\(stream\)/g) ?? []).toHaveLength(2);
    expect(world).toContain("broadcastTypedWorldEvent('trade', payload)");
    expect(world).toContain("broadcastTypedWorldEvent('trade_decision', payload)");
    expect(world).not.toContain('export function broadcastWorldSse');

    const secretWallet = '7YWHMfk9JZe0LMWm1zRuHMH4tq3w6FQnK9xjBvn6pump';
    const trade: TradeTickerEvent = {
      type: 'trade.verified', signature: 'recorded-signature',
      subject: { type: 'agent', id: 'agent-1', avatarName: 'Trader' },
      inputMint: 'mint-a', outputMint: 'mint-b', notionalUsd: 1, dex: 'jupiter',
      blockTime: 1, multiplier: 1, scored: true, operatedByClawville: false,
      decisionId: null, unscoredReason: null,
    };
    expect(JSON.stringify(trade)).not.toContain(secretWallet);

    const decision: TradeDecisionEvent = {
      type: 'trade.decision', decisionId: 'decision-1',
      subject: { type: 'agent', id: 'agent-1', avatarName: 'Trader' },
      verdict: 'refused', reason: 'cooldown_active', inputMint: 'mint-a',
      outputMint: 'mint-b', requestedUsd: 1, operatedByClawville: true,
      at: '2026-09-16T00:00:00.000Z',
    };
    expect(JSON.stringify(decision)).not.toContain(secretWallet);
    expect(JSON.stringify(decision)).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{64,}/);
  });

  test('keeps verified-trade lookup server-internal', () => {
    expect(exchange).not.toContain('lookupVerifiedTrade');
  });
});
