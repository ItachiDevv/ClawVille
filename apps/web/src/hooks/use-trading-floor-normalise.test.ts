import { describe, expect, test } from 'bun:test';

import {
  normaliseDecisionEvent,
  normaliseMyTrade,
  normalisePublicTrade,
  normaliseSseTrade,
} from '@/hooks/use-trading-floor';

const trade = {
  signature: 'signature',
  subject: { type: 'agent', id: 'agent-1', avatarName: 'Ralph' },
  wallet: 'wallet-secret-to-public-normaliser',
  inputMint: 'mint-in',
  outputMint: 'mint-out',
  notionalUsd: null,
  dex: 'jupiter',
  blockTime: null,
  multiplier: 1.5,
  decisionId: 'decision-1',
  scored: false,
  unscoredReason: 'pair_repeat_today',
  operatedByClawville: true,
};

const decision = {
  decisionId: 'decision-1',
  subject: { type: 'agent', id: 'agent-1', avatarName: null },
  verdict: 'submitted',
  reason: null,
  inputMint: 'mint-in',
  outputMint: 'mint-out',
  requestedUsd: 25,
  operatedByClawville: true,
  at: '2026-09-16T10:00:00.000Z',
};

describe('Trading Floor normalisers', () => {
  test('all trade normalisers set the discriminant and narrow both branches', () => {
    const rows = [
      normaliseSseTrade(trade),
      normalisePublicTrade(trade),
      normaliseMyTrade(trade),
    ];
    expect(rows.every((row) => row?.kind === 'trade')).toBe(true);
    const d = normaliseDecisionEvent(decision);
    expect(d?.kind).toBe('decision');
    expect(rows[0]?.signature).toBe('signature');
    expect(d?.decisionId).toBe('decision-1');
  });

  test('public frames never retain a wallet while my history does', () => {
    expect(normaliseSseTrade(trade)?.wallet).toBeNull();
    expect(normalisePublicTrade(trade)?.wallet).toBeNull();
    expect(normaliseMyTrade(trade)?.wallet).toBe(trade.wallet);
  });

  test('derives the tier and keeps nullable settled values', () => {
    expect(normaliseSseTrade(trade)).toMatchObject({
      multiplierTier: 'clv',
      notionalUsd: null,
      blockTime: null,
      decisionId: 'decision-1',
    });
  });

  test('defaults operated disclosure to false', () => {
    const { operatedByClawville: _removed, ...older } = trade;
    expect(normaliseSseTrade(older)?.operatedByClawville).toBe(false);
  });

  test.each(['submitted', 'refused', 'executed'] as const)(
    'keeps the %s verdict',
    (verdict) => {
      const row = normaliseDecisionEvent({
        ...decision,
        verdict,
        reason: verdict === 'refused' ? 'cooldown_active' : 'daily_notional_cap',
      });
      expect(row?.verdict).toBe(verdict);
      expect(row?.reason).toBe(verdict === 'refused' ? 'cooldown_active' : null);
    },
  );

  test('rejects an unknown verdict and discards prose refusal text', () => {
    expect(normaliseDecisionEvent({ ...decision, verdict: 'unknown' })).toBeNull();
    for (const reason of [
      'x'.repeat(240),
      'two words',
      'punctuation!',
      'COOLDOWN_ACTIVE',
    ]) {
      expect(normaliseDecisionEvent({
        ...decision,
        verdict: 'refused',
        reason,
      })?.reason).toBeNull();
    }
  });

  test('rejects unknown unscored reasons to null', () => {
    expect(normaliseSseTrade({ ...trade, unscoredReason: 'future_reason' })?.unscoredReason).toBeNull();
  });

  test.each([
    undefined,
    null,
    {},
    { ...trade, signature: undefined },
    { ...trade, dex: 'unknown' },
  ])('rejects malformed trade input', (value) => {
    expect(normaliseSseTrade(value)).toBeNull();
  });

  test('all public and private trade normalisers reject invalid identities and dex values', () => {
    for (const normalise of [normaliseSseTrade, normalisePublicTrade, normaliseMyTrade]) {
      expect(normalise(undefined)).toBeNull();
      expect(normalise('trade')).toBeNull();
      expect(normalise({ ...trade, signature: undefined })).toBeNull();
      expect(normalise({ ...trade, dex: 'unknown' })).toBeNull();
    }
  });

  test('decision normalisation rejects invalid identities and input shapes', () => {
    expect(normaliseDecisionEvent(undefined)).toBeNull();
    expect(normaliseDecisionEvent('decision')).toBeNull();
    expect(normaliseDecisionEvent({ ...decision, decisionId: undefined })).toBeNull();
  });

  test('an absent trade decision id maps to null', () => {
    const { decisionId: _removed, ...withoutDecision } = trade;
    expect(normaliseSseTrade(withoutDecision)?.decisionId).toBeNull();
  });
});
