import { describe, expect, test } from 'bun:test';
import {
  TRADE_MINTS,
  TRADE_MINT_LIQUIDITY_HINT,
  TRADE_REFUSAL_COPY,
  TRADE_REFUSAL_CODES,
  TRADE_SCORING_RULE_LINES,
  TRADE_UNSCORED_REASONS,
  TRADING_FLOOR_GUARDRAIL_LINES,
  TRADING_FLOOR_RULES,
  TRADING_FLOOR_RULES_SUMMARY_LINES,
} from '@clawville/shared';

import {
  PENDING_UNCONFIRMED_AFTER_MS,
  TRADE_MINT_SYMBOLS,
  decisionReasonCopy,
  decisionRowState,
  formatNotionalUsd,
  formatRequestedUsd,
  liquidityHint,
  multiplierLabel,
  operatorLabel,
  pendingState,
  rejectDetailCopy,
  shortSignature,
  symbolForMint,
  tierFromMultiplier,
  tradeAgeLabel,
  traderLabel,
  unscoredReasonCopy,
} from './format';
import type { FloorDecision, FloorTrade } from '@/stores/trade-ticker';

function row(verdict: FloorDecision['verdict']): FloorDecision {
  return {
    kind: 'decision',
    keys: ['d:one'],
    decisionId: 'one',
    subject: { type: 'agent', id: 'agent-1', avatarName: null },
    verdict,
    reason: verdict === 'refused' ? 'cooldown_active' : null,
    inputMint: 'in',
    outputMint: 'out',
    requestedUsd: 10,
    operatedByClawville: false,
    at: '2026-09-16T10:00:00.000Z',
  };
}

function trade(overrides: Partial<FloorTrade> = {}): FloorTrade {
  return {
    kind: 'trade',
    keys: ['t:sig'],
    signature: 'signature',
    subject: null,
    wallet: 'NeverRenderThisWallet',
    inputMint: TRADE_MINTS.USDC,
    outputMint: TRADE_MINTS.ANSEM,
    notionalUsd: 10,
    dex: 'jupiter',
    blockTime: 1_789_000_000,
    multiplier: 1,
    multiplierTier: 'base',
    decisionId: null,
    scored: true,
    unscoredReason: null,
    operatedByClawville: false,
    ...overrides,
  };
}

function expectSafeCopy(value: string): void {
  expect(value).not.toContain('—');
  expect(value.toLowerCase()).not.toContain('casino');
  expect(value).not.toMatch(/\bCT\b/);
}

describe('Trading Floor copy and state formatting', () => {
  test('shortens only signatures outside the compact bound', () => {
    expect(shortSignature('123456789012345')).toBe('123456789012345');
    expect(shortSignature('1234567890123456')).toBe('1234567...123456');
  });

  test('formats notional and requested values without invented amounts', () => {
    expect(formatNotionalUsd(1240.5)).toBe('$1,241');
    expect(formatNotionalUsd(12.4)).toBe('$12.40');
    expect(formatNotionalUsd(0.4)).toBe('<$1');
    expect(formatNotionalUsd(null)).toBe('unpriced');
    expect(formatRequestedUsd(null)).toContain('wanted');
    expect(formatRequestedUsd(12.4)).toContain('wanted');
  });

  test('maps multiplier tiers and labels from shared mint identities', () => {
    expect(tierFromMultiplier(1)).toBe('base');
    expect(tierFromMultiplier(1.5)).toBe('clv');
    expect(tierFromMultiplier(2)).toBe('ansem');
    expect(tierFromMultiplier(9)).toBe('base');
    expect(multiplierLabel(trade())).toBeNull();
    expect(multiplierLabel(trade({ multiplier: 2, multiplierTier: 'ansem' }))).toBe(
      `2x ${TRADE_MINT_SYMBOLS[TRADE_MINTS.ANSEM]}`,
    );
    expect(multiplierLabel(trade({ multiplier: 1.5, multiplierTier: 'clv' }))).toBe(
      `1.5x ${TRADE_MINT_SYMBOLS[TRADE_MINTS.CLAWVILLE]}`,
    );
    expect(symbolForMint(TRADE_MINTS.ANSEM)).toBe(TRADE_MINT_SYMBOLS[TRADE_MINTS.ANSEM]);
  });

  test('uses an injected clock for trade ages', () => {
    const now = 1_800_000_000_000;
    expect(tradeAgeLabel(null, now)).toBe('time unavailable');
    expect(tradeAgeLabel(now / 1_000 + 60, now)).toBe('now');
    expect(tradeAgeLabel(now / 1_000 - 120, now)).toBe('2m ago');
  });

  test('keeps invalid and future decision clocks pending', () => {
    const at = Date.parse('2026-09-16T10:00:00.000Z');
    const iso = new Date(at).toISOString();
    expect(pendingState(iso, at)).toBe('pending');
    expect(pendingState(iso, at + PENDING_UNCONFIRMED_AFTER_MS - 1_000)).toBe('pending');
    expect(pendingState(iso, at + PENDING_UNCONFIRMED_AFTER_MS)).toBe('unconfirmed');
    expect(pendingState(iso, at + PENDING_UNCONFIRMED_AFTER_MS + 1)).toBe('unconfirmed');
    expect(pendingState(new Date(at + 1).toISOString(), at)).toBe('pending');
    expect(pendingState('not-a-time', at)).toBe('pending');
  });

  test('never derives the public trader label from a wallet', () => {
    expect(traderLabel(trade())).toBe('A trader');
    expect(traderLabel(trade())).not.toContain('NeverRenderThisWallet');
  });

  test('every runtime unscored reason has recorded copy', () => {
    for (const reason of TRADE_UNSCORED_REASONS) {
      expect(unscoredReasonCopy(reason).startsWith('Recorded.')).toBe(true);
    }
  });

  test('covers verifier details and uses a safe fallback', () => {
    for (const detail of [
      'dex_not_recognized',
      'wallet_not_signer',
      'token_account_not_owned',
      'multi_leg',
      'no_net_movement',
    ]) {
      expect(rejectDetailCopy(detail)).not.toBe('That transaction is not an eligible swap.');
    }
    expect(rejectDetailCopy('future_detail')).toBe('That transaction is not an eligible swap.');
    expect(rejectDetailCopy(null)).toBe('That transaction is not an eligible swap.');
  });

  test('every refusal code resolves without exposing its enum value', () => {
    for (const reason of TRADE_REFUSAL_CODES) {
      const copy = decisionReasonCopy(reason);
      expect(copy).toBe(TRADE_REFUSAL_COPY[reason]);
      expect(copy.length).toBeGreaterThan(0);
      expect(copy).not.toBe(reason);
    }
    expect(decisionReasonCopy('future_reason')).toBe('Blocked by a floor rule.');
    expect(decisionReasonCopy(null)).toBe('Blocked by a floor rule.');
  });

  test('labels current operation and keeps liquidity qualitative', () => {
    expect(operatorLabel({ operatedByClawville: false }, 'tape')).toBeNull();
    expect(operatorLabel({ operatedByClawville: true }, 'tape')).toBe('HOUSE');
    expect(operatorLabel({ operatedByClawville: true }, 'panel')).toBe('ClawVille-operated');
    expect(operatorLabel({ operatedByClawville: false, operator: 'clawpump' }, 'tape')).toBe('CLAWPUMP');
    expect(operatorLabel({ operatedByClawville: false, operator: 'clawpump' }, 'panel')).toBe('ClawPump-operated');
    expect(operatorLabel({ operatedByClawville: true, operator: 'clawpump' }, 'tape')).toBe('HOUSE');
    expect(operatorLabel({ operatedByClawville: true, operator: 'clawpump' }, 'panel')).toBe('ClawVille-operated');
    for (const mint of Object.keys(TRADE_MINT_LIQUIDITY_HINT)) {
      const hint = liquidityHint(mint);
      expect(hint).not.toBeNull();
      expect(hint).not.toMatch(/\d/);
    }
    expect(liquidityHint('unknown')).toBeNull();
  });

  test('combines submitted verdict and the injected clock in one function', () => {
    const submitted = row('submitted');
    const at = Date.parse(submitted.at);
    expect(decisionRowState(submitted, at + PENDING_UNCONFIRMED_AFTER_MS - 1)).toBe('pending');
    expect(decisionRowState(submitted, at + PENDING_UNCONFIRMED_AFTER_MS)).toBe('unconfirmed');
  });

  test('executed and blocked states ignore the clock', () => {
    expect(decisionRowState(row('executed'), Number.MAX_SAFE_INTEGER)).toBe('executed');
    expect(decisionRowState(row('refused'), 0)).toBe('blocked');
  });

  test('shared rule copy omits forbidden words, missing values, and invalid percentages', () => {
    const ruleArrays = [
      TRADE_SCORING_RULE_LINES,
      TRADING_FLOOR_GUARDRAIL_LINES,
      TRADING_FLOOR_RULES_SUMMARY_LINES,
    ];
    for (const value of [
      ...Object.values(TRADE_MINT_SYMBOLS),
      ...Object.values(TRADE_REFUSAL_COPY),
      ...Object.values(TRADE_MINT_LIQUIDITY_HINT),
      ...ruleArrays.flat(),
    ]) {
      expectSafeCopy(value);
      expect(value).not.toMatch(/\b(?:null|undefined|NaN)\b/);
      for (const match of value.matchAll(/(\d+(?:\.\d+)?)%/g)) {
        expect(Number(match[1])).toBeLessThanOrEqual(100);
      }
    }

    const percent = TRADING_FLOOR_RULES.guardrails.perTradeMaxPctOfFloat;
    if (percent !== null) {
      expect(TRADING_FLOOR_GUARDRAIL_LINES.some((line) => line.includes(`${percent}%`))).toBe(true);
    }
  });
});
