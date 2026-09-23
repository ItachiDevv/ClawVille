import { describe, expect, test } from 'bun:test';

import {
  normaliseDecisionEvent,
  normaliseHouseSlotForTest,
  normaliseHouseSlotRiskForTest,
  normaliseMyTrade,
  normalisePublicTrade,
  normaliseSseTrade,
} from '@/hooks/use-trading-floor';
// The CONTRACT's own reason list, not the client's copy of it: this test is
// meant to prove the web validator accepts everything the wire may send.
import { HOUSE_TRADER_STATUS_REASONS } from '@clawville/shared';

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

  test('normalises the operator with ClawVille operation taking precedence', () => {
    for (const normalise of [normaliseSseTrade, normalisePublicTrade, normaliseMyTrade]) {
      expect(normalise({ ...trade, operatedByClawville: false, operator: 'clawpump' })?.operator).toBe('clawpump');
      expect(normalise(trade)?.operator).toBe('clawville');
      expect(normalise({ ...trade, operator: 'clawpump' })?.operator).toBe('clawville');
      expect(normalise({ ...trade, operatedByClawville: false, operator: 'x' })?.operator).toBeNull();
    }
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

// ---------------------------------------------------------------------------
// THE RISK BLOCK (founder, 2026-09-20). Additive on the route, so the two rules
// that matter are: a readable block must survive intact, and an unreadable one
// must cost the slot NOTHING. The route on staging does not send it yet.
// ---------------------------------------------------------------------------

/** The wire slot WITHOUT the additive field — exactly what staging serves. */
function wireSlotWithoutRisk(): Record<string, unknown> {
  return {
    objective: 'momentum-board',
    slotName: 'Genesis',
    strategyNote: 'Rules only, no AI decisions.',
    status: 'live-observed',
    subject: { type: 'agent', id: 'agent-1', avatarName: 'Genesis' },
    counts: { verified: 20, scored: 12, lastTradeAt: '2026-09-20T04:30:00.000Z' },
    realised: {
      closedPositions: 20, wins: 8, losses: 12, realisedUsd: -5.2,
      bestUsd: 3.15, worstUsd: -2.4, openPositions: 1, openCostUsd: 12,
      basis: 'gross_usdc_leg', costBasis: 'round_trip_fifo',
      noExitHours: 24, noExitClosures: 3, unmatchedSells: 0, excludedNonUsdc: 0,
      computedOverTrades: 41, undatedLegs: 0, invalidLegs: 0, partial: false,
      note: 'Gross realised on the USDC leg, excludes network fees.',
      preBindIncluded: true, unpricedLegs: 0, unclassifiedLegs: 0,
      computedAt: '2026-09-20T05:00:00.000Z',
    },
    recentTrades: [],
  };
}

function wireSlot(risk: unknown): Record<string, unknown> {
  return { ...wireSlotWithoutRisk(), risk };
}

function wireRisk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'paused',
    reason: 'daily_loss_floor',
    detail: 'Daily loss floor reached; the desk resumes after the UTC reset.',
    dayLossUsd: 9.99,
    dayLossCapUsd: 20,
    roomNeededUsd: 10.25,
    at: '2026-09-20T10:40:00.000Z',
    ageSeconds: 42,
    ...overrides,
  };
}

const readRisk = (risk: unknown) => normaliseHouseSlotForTest(wireSlot(risk))?.risk;

describe('House trader risk block', () => {
  test('a valid paused block survives every field intact', () => {
    expect(readRisk(wireRisk())).toEqual({
      state: 'paused',
      reason: 'daily_loss_floor',
      detail: 'Daily loss floor reached; the desk resumes after the UTC reset.',
      dayLossUsd: 9.99,
      dayLossCapUsd: 20,
      roomNeededUsd: 10.25,
      at: '2026-09-20T10:40:00.000Z',
      ageSeconds: 42,
    });
  });

  test('all three states are accepted and nothing else is', () => {
    for (const state of ['paused', 'live', 'fault'] as const) {
      expect({ state, out: readRisk(wireRisk({ state }))?.state }).toEqual({ state, out: state });
    }
    // An unknown state has NO safe default: 'live' would claim a paused desk is
    // trading and 'paused' would accuse a running one, so the block goes.
    for (const bad of ['PAUSED', 'blocked', '', null, 1, undefined]) {
      expect({ bad, out: readRisk(wireRisk({ state: bad })) }).toEqual({ bad, out: null });
    }
  });

  test('an absent block is null, and so is anything that is not an object', () => {
    // THE STAGING CASE: the route does not send the field at all.
    expect(normaliseHouseSlotForTest(wireSlotWithoutRisk())?.risk).toBeNull();
    for (const bad of [undefined, null, 'paused', 42, [], true]) {
      expect({ bad, out: readRisk(bad) }).toEqual({ bad, out: null });
    }
  });

  test('the three USD figures need only be finite, and SIGNED IS LEGAL', () => {
    for (const key of ['dayLossUsd', 'dayLossCapUsd', 'roomNeededUsd']) {
      // Zero is a REAL value: a desk can be paused with no loss booked today.
      expect({ key, out: readRisk(wireRisk({ [key]: 0 }))?.state }).toEqual({ key, out: 'paused' });
      // NEGATIVE IS ALSO REAL, and rejecting it was a bug in an earlier
      // revision of this guard: a desk can be UP on the day and still be
      // blocked by something that is not its loss floor, so a negative
      // `dayLossUsd` is a reading, not a fault. Nulling the block over it would
      // have hidden a live pause on a public money board. Implausible
      // COMBINATIONS are handled where they belong, by the arithmetic sentence
      // refusing to claim what the figures do not support.
      expect({ key, out: readRisk(wireRisk({ [key]: -3.2 }))?.state }).toEqual({ key, out: 'paused' });
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '9.99', null, undefined]) {
        expect({ key, bad, out: readRisk(wireRisk({ [key]: bad })) }).toEqual({ key, bad, out: null });
      }
    }
  });

  test('ageSeconds must be a NON-NEGATIVE SAFE INTEGER, unlike the money', () => {
    // It is a server-computed COUNT, so a value that cannot be one means this
    // is not a block that server produced. Past 2**53-1 a JSON integer has
    // already lost precision in transit.
    expect(readRisk(wireRisk({ ageSeconds: 0 }))?.ageSeconds).toBe(0);
    expect(readRisk(wireRisk({ ageSeconds: 2 ** 53 - 1 }))?.ageSeconds).toBe(2 ** 53 - 1);
    for (const bad of [-1, 1.5, 2 ** 53, 1e21, Number.NaN, '42', null, undefined]) {
      expect({ bad, out: readRisk(wireRisk({ ageSeconds: bad })) }).toEqual({ bad, out: null });
    }
  });

  // DETAIL CAN NEVER NULL THE BLOCK. An optional elaboration that can delete a
  // pause from a public money board is a worse defect than the unshowable
  // sentence it was guarding against (tfs-audit, correcting an earlier
  // revision of this guard that rejected the block for a non-string detail).
  test('an unusable detail costs the sentence and never the pause', () => {
    expect(readRisk(wireRisk({ detail: null }))?.detail).toBeNull();
    const { detail: _absent, ...withoutDetail } = wireRisk();
    expect(readRisk(withoutDetail)?.detail).toBeNull();
    expect(readRisk(wireRisk({ detail: '   ' }))?.detail).toBeNull();
    for (const bad of [42, { text: 'no' }, ['no'], true, 'x'.repeat(400)]) {
      const out = readRisk(wireRisk({ detail: bad }));
      expect({ bad: String(bad).slice(0, 12), state: out?.state, detail: out?.detail }).toEqual({
        bad: String(bad).slice(0, 12),
        state: 'paused',
        detail: null,
      });
    }
  });

  test('a usable detail is bounded and stripped of invisible characters', () => {
    // NO CONTENT INSPECTION: the API strips addresses at ingest, and a second
    // opinion here could only disagree with it. This is bounding, not judging.
    // Built with `fromCharCode` so the hostile characters are VISIBLE here.
    const hostile = `over${String.fromCharCode(0x0000)} the${String.fromCharCode(0x202e)} cap`;
    expect(readRisk(wireRisk({ detail: hostile }))?.detail).toBe('over the cap');
    const atCap = 'x'.repeat(120);
    expect(readRisk(wireRisk({ detail: atCap }))?.detail).toBe(atCap);
    // One over the contract's cap is a payload that is not the contract, so the
    // sentence is dropped rather than truncated: a cut-off sentence reads as a
    // complete one that says less.
    expect(readRisk(wireRisk({ detail: 'x'.repeat(121) }))?.detail).toBeNull();
  });

  test('at must be a non-empty string', () => {
    for (const bad of ['', null, undefined, 1758365000]) {
      expect({ bad, out: readRisk(wireRisk({ at: bad })) }).toEqual({ bad, out: null });
    }
  });

  // REASON DEGRADES WHERE STATE DOES NOT. Dropping the block over a code this
  // build has not heard of would show LIVE for a desk that cannot trade, which
  // is the exact failure the block exists to end. Nothing renders the code.
  test('every listed reason is kept and an unknown one folds to other', () => {
    for (const reason of HOUSE_TRADER_STATUS_REASONS) {
      expect({ reason, out: readRisk(wireRisk({ reason }))?.reason }).toEqual({ reason, out: reason });
    }
    for (const bad of ['circuit_breaker', '', null, undefined, 7]) {
      expect({ bad, out: readRisk(wireRisk({ reason: bad }))?.state }).toEqual({ bad, out: 'paused' });
      expect({ bad, out: readRisk(wireRisk({ reason: bad }))?.reason }).toEqual({ bad, out: 'other' });
    }
  });

  // THE HALF A FIELD-LEVEL TEST CANNOT SEE. A bad risk block must cost the slot
  // nothing: collapsing the slot would turn a metadata problem into a missing
  // card, and nulling `realised` alongside it would put "P&L unavailable" on a
  // desk whose figures we read perfectly well.
  test('an unreadable risk block never damages the rest of the slot', () => {
    const intact = normaliseHouseSlotForTest(wireSlotWithoutRisk());
    const poisoned = normaliseHouseSlotForTest(wireSlot(wireRisk({ state: 'nonsense' })));
    expect(poisoned).not.toBeNull();
    expect(poisoned?.risk).toBeNull();
    expect(poisoned?.realised?.realisedUsd).toBe(-5.2);
    expect(poisoned).toEqual(intact);
  });

  // The per-field seam, alongside the whole-slot one the rest of this block
  // drives. Same guard, reached without a slot around it.
  test('the field seam and the slot path agree', () => {
    expect(normaliseHouseSlotRiskForTest(wireRisk())).toEqual(readRisk(wireRisk())!);
    expect(normaliseHouseSlotRiskForTest(undefined)).toBeNull();
    expect(normaliseHouseSlotRiskForTest({ state: 'paused' })).toBeNull();
  });
});

// PER-TRADE REALISED (2026-09-20). The route attaches this only to a sell leg
// its FIFO matcher could attribute. It is what colours a flying chip in the
// Trading Floor room green or red, so an absent field must stay absent rather
// than become 0, and a junk value must not null the whole trade row.
describe('per-trade realised figure', () => {
  test('a finite figure survives the normaliser, including a true zero', () => {
    expect(normalisePublicTrade({ ...trade, realisedUsd: -3.08 })?.realisedUsd).toBe(-3.08);
    expect(normalisePublicTrade({ ...trade, realisedUsd: 0 })?.realisedUsd).toBe(0);
  });

  test('an absent figure stays absent and never becomes a number', () => {
    const row = normalisePublicTrade(trade);
    expect(row).not.toBeNull();
    expect('realisedUsd' in (row as object)).toBe(false);
  });

  test('a junk figure is dropped and the trade still normalises', () => {
    for (const bad of ['3.08', Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
      const row = normalisePublicTrade({ ...trade, realisedUsd: bad });
      expect(row).not.toBeNull();
      expect('realisedUsd' in (row as object)).toBe(false);
    }
  });
});
