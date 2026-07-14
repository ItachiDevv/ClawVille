import { afterEach, describe, expect, it } from 'bun:test';
import {
  exactRedemptionMoney,
  calculateEarnedBackingSolvency,
  classifyDurableRedemptionStatus,
  claimThenPrepareAndCapture,
  executeCapturedSend,
  isConfirmedFundingSweep,
  fundingContextLagReason,
  maxRequiredFundingContextSlot,
  planRedeemableEarnedAllocations,
  quarantineNullFundingClaim,
  requestEarnedRedemptionWithStore,
  requireTokenomicsRedeemEnabled,
  resolveMinRedemptionVclaw,
  sumConservativeQueueOutput,
  validateRedemptionQueueFills,
  sameFundingClaimSnapshot,
  sameCapturedFundingSnapshot,
  type EarnedRedemptionRequestStore,
  type RedeemableLotCandidate,
} from '../earned-redemption';
import {
  summarizeEarnedBackingIntegrity,
  type EarnedBackingIntegrityCounts,
} from '../earned-solvency';
import { assertMinimumContextSlot } from '../solana-token-balance';
import type { EarnedRedemption } from '@clawville/database';

const originalGate = process.env.TOKENOMICS_REDEEM_ENABLED;
const originalMin = process.env.TOKENOMICS_REDEEM_MIN_VCLAW;

const NOW = new Date('2026-07-14T12:00:00.000Z');
const SUBJECT = { kind: 'user' as const, avatarId: 'avatar-1', userId: 'user-1' };

function eligibleLot(overrides: Partial<RedeemableLotCandidate> = {}): RedeemableLotCandidate {
  return {
    mintLotId: 'lot-1',
    remainingVclaw: 100,
    backingKind: 'backed',
    backingNetwork: 'mainnet',
    custodyWalletId: 'custody-1',
    backingRemainingUsdcAtomic: '1000000',
    payerVerification: 'verified',
    vestsAt: new Date(NOW.getTime() - 1),
    clawedBackAt: null,
    ...overrides,
  };
}

function memoryRequestStore(lots: RedeemableLotCandidate[]): {
  store: EarnedRedemptionRequestStore;
  rows: Map<string, EarnedRedemption>;
  debitCalls: () => number;
} {
  const rows = new Map<string, EarnedRedemption>();
  let nextId = 0;
  let debits = 0;
  const idem = (kind: string, avatarId: string, key: string) => `${kind}:${avatarId}:${key}`;
  const find = (kind: string, avatarId: string, key: string) => rows.get(idem(kind, avatarId, key)) ?? null;
  const replace = (row: EarnedRedemption, patch: Partial<EarnedRedemption>) => {
    const changed = { ...row, ...patch, updatedAt: new Date(NOW) } as EarnedRedemption;
    rows.set(idem(changed.subjectType, changed.avatarId, changed.idempotencyKey), changed);
    return changed;
  };

  const store: EarnedRedemptionRequestStore = {
    findByIdempotency: async (input) => find(
      input.subject.kind,
      input.subject.avatarId,
      input.idempotencyKey,
    ),
    insert: async (input, money) => {
      const key = idem(input.subject.kind, input.subject.avatarId, input.idempotencyKey);
      if (rows.has(key)) return null;
      const row = {
        id: `redemption-${++nextId}`,
        subjectType: input.subject.kind,
        avatarId: input.subject.avatarId,
        idempotencyKey: input.idempotencyKey,
        amountVclaw: input.amountVclaw,
        grossUsdcAtomic: money.grossUsdcAtomic.toString(),
        exitFeeUsdcAtomic: money.exitFeeUsdcAtomic.toString(),
        exitFeeRetainedAt: null,
        buyUsdcAtomic: money.buyUsdcAtomic.toString(),
        status: 'requested',
        ledgerDebitId: null,
        backingCustodyWalletId: null,
        clvBuyQueueId: null,
        clvSwapFundingId: null,
        deliveryClaimId: null,
        deliveryClaimedAt: null,
        deliveryTxSignature: null,
        deliveryClvAtomic: null,
        deliveryWalletPubkey: null,
        deliveredAt: null,
        failureReason: null,
        metadata: {},
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      } as EarnedRedemption;
      rows.set(key, row);
      return row;
    },
    debit: async (id) => {
      debits += 1;
      const row = [...rows.values()].find((candidate) => candidate.id === id);
      if (!row) return 'internal';
      const plan = planRedeemableEarnedAllocations({
        amountVclaw: row.amountVclaw,
        custodyWalletId: 'custody-1',
        now: NOW,
        lots,
      });
      if (!plan.ok) {
        replace(row, { status: 'refused', failureReason: plan.code });
        return plan.code;
      }
      replace(row, {
        status: 'debited',
        ledgerDebitId: `ledger-${id}`,
        backingCustodyWalletId: 'custody-1',
        exitFeeRetainedAt: new Date(NOW),
      });
      return null;
    },
    enqueue: async (id) => {
      const row = [...rows.values()].find((candidate) => candidate.id === id);
      if (row?.status === 'debited') replace(row, { status: 'buy_queued', clvBuyQueueId: `queue-${id}` });
    },
    get: async (id, subject) => [...rows.values()].find(
      (candidate) => candidate.id === id &&
        candidate.subjectType === subject.kind &&
        candidate.avatarId === subject.avatarId,
    ) ?? null,
  };
  return { store, rows, debitCalls: () => debits };
}

afterEach(() => {
  if (originalGate === undefined) delete process.env.TOKENOMICS_REDEEM_ENABLED;
  else process.env.TOKENOMICS_REDEEM_ENABLED = originalGate;
  if (originalMin === undefined) delete process.env.TOKENOMICS_REDEEM_MIN_VCLAW;
  else process.env.TOKENOMICS_REDEEM_MIN_VCLAW = originalMin;
});

describe('E3 integer economics + dark gate', () => {
  it('is default-off and accepts only the literal true', () => {
    delete process.env.TOKENOMICS_REDEEM_ENABLED;
    expect(() => requireTokenomicsRedeemEnabled()).toThrow('not \'true\'');
    process.env.TOKENOMICS_REDEEM_ENABLED = 'TRUE';
    expect(() => requireTokenomicsRedeemEnabled()).toThrow('not \'true\'');
    process.env.TOKENOMICS_REDEEM_ENABLED = 'true';
    expect(() => requireTokenomicsRedeemEnabled()).not.toThrow();
  });

  it('never hides durable reconcile/refused states on idempotent replay', () => {
    expect(classifyDurableRedemptionStatus('reconcile', 'funding_ambiguous')).toEqual({
      ok: false,
      code: 'reconcile',
    });
    expect(classifyDurableRedemptionStatus('refused', 'insufficient_redeemable_earned')).toEqual({
      ok: false,
      code: 'insufficient_redeemable_earned',
    });
    expect(classifyDurableRedemptionStatus('delivered', null)).toEqual({ ok: true });
  });

  it('computes gross, 444-bps retained fee, and net buy integer-exact', () => {
    expect(exactRedemptionMoney(100)).toEqual({
      grossUsdcAtomic: 1_000_000n,
      exitFeeUsdcAtomic: 44_400n,
      buyUsdcAtomic: 955_600n,
    });
  });

  it('defaults the floor to 100 vCLAW and rejects unsafe env values', () => {
    delete process.env.TOKENOMICS_REDEEM_MIN_VCLAW;
    expect(resolveMinRedemptionVclaw()).toBe(100);
    process.env.TOKENOMICS_REDEEM_MIN_VCLAW = '0';
    expect(resolveMinRedemptionVclaw()).toBe(100);
    process.env.TOKENOMICS_REDEEM_MIN_VCLAW = '250';
    expect(resolveMinRedemptionVclaw()).toBe(250);
  });
});

describe('request service with transactional DB adapter', () => {
  it('persists one debit and replays the same durable row for one subject/key', async () => {
    process.env.TOKENOMICS_REDEEM_ENABLED = 'true';
    const harness = memoryRequestStore([eligibleLot()]);
    const input = { subject: SUBJECT, amountVclaw: 100, idempotencyKey: 'idem-1' };
    const first = await requestEarnedRedemptionWithStore(input, harness.store);
    const replay = await requestEarnedRedemptionWithStore(input, harness.store);
    expect(first.ok && first.replay).toBe(false);
    expect(replay.ok && replay.replay).toBe(true);
    expect(first.ok && replay.ok && first.redemption.id).toBe(replay.ok ? replay.redemption.id : '');
    expect(harness.rows.size).toBe(1);
    expect(harness.debitCalls()).toBe(1);
  });

  it('returns idempotency_conflict without a second debit when terms change', async () => {
    process.env.TOKENOMICS_REDEEM_ENABLED = 'true';
    const harness = memoryRequestStore([eligibleLot({ remainingVclaw: 200, backingRemainingUsdcAtomic: '2000000' })]);
    await requestEarnedRedemptionWithStore(
      { subject: SUBJECT, amountVclaw: 100, idempotencyKey: 'idem-conflict' },
      harness.store,
    );
    const conflict = await requestEarnedRedemptionWithStore(
      { subject: SUBJECT, amountVclaw: 101, idempotencyKey: 'idem-conflict' },
      harness.store,
    );
    expect(conflict).toMatchObject({ ok: false, code: 'idempotency_conflict' });
    expect(harness.debitCalls()).toBe(1);
  });

  it('durably refuses an unbacked rail-④ lot and replays that same refusal', async () => {
    process.env.TOKENOMICS_REDEEM_ENABLED = 'true';
    const harness = memoryRequestStore([eligibleLot({
      backingKind: 'none',
      custodyWalletId: null,
      backingRemainingUsdcAtomic: null,
    })]);
    const result = await requestEarnedRedemptionWithStore(
      { subject: SUBJECT, amountVclaw: 100, idempotencyKey: 'idem-unbacked' },
      harness.store,
    );
    const replay = await requestEarnedRedemptionWithStore(
      { subject: SUBJECT, amountVclaw: 100, idempotencyKey: 'idem-unbacked' },
      harness.store,
    );
    const conflict = await requestEarnedRedemptionWithStore(
      { subject: SUBJECT, amountVclaw: 101, idempotencyKey: 'idem-unbacked' },
      harness.store,
    );
    expect(result).toMatchObject({ ok: false, code: 'insufficient_redeemable_earned' });
    expect(replay).toMatchObject({ ok: false, code: 'insufficient_redeemable_earned' });
    expect(conflict).toMatchObject({ ok: false, code: 'idempotency_conflict' });
    expect(!result.ok && !replay.ok && result.redemption?.id).toBe(
      !replay.ok ? replay.redemption?.id : undefined,
    );
    expect(harness.rows.size).toBe(1);
    expect(harness.debitCalls()).toBe(1);
  });

  it('refuses a devnet-backed lot before the mainnet-only E3 machine', async () => {
    process.env.TOKENOMICS_REDEEM_ENABLED = 'true';
    const harness = memoryRequestStore([eligibleLot({ backingNetwork: 'devnet' })]);
    const result = await requestEarnedRedemptionWithStore(
      { subject: SUBJECT, amountVclaw: 100, idempotencyKey: 'idem-devnet' },
      harness.store,
    );
    expect(result).toMatchObject({ ok: false, code: 'insufficient_redeemable_earned' });
    expect(harness.rows.size).toBe(1);
    expect(harness.debitCalls()).toBe(1);
  });

  it('refuses pending, rejected, unvested, and unstamped-vesting lots before any debit', async () => {
    process.env.TOKENOMICS_REDEEM_ENABLED = 'true';
    const cases: Array<[string, RedeemableLotCandidate]> = [
      ['pending-verification', eligibleLot({ payerVerification: 'pending' })],
      ['rejected-verification', eligibleLot({ payerVerification: 'rejected' })],
      ['unvested', eligibleLot({ vestsAt: new Date(NOW.getTime() + 60_000) })],
      ['vesting-missing', eligibleLot({ vestsAt: null })],
    ];
    for (const [label, lot] of cases) {
      const harness = memoryRequestStore([lot]);
      const result = await requestEarnedRedemptionWithStore(
        { subject: SUBJECT, amountVclaw: 100, idempotencyKey: `idem-${label}` },
        harness.store,
      );
      expect(result).toMatchObject({ ok: false, code: 'insufficient_redeemable_earned' });
      expect(harness.rows.size).toBe(1);
      expect(harness.debitCalls()).toBe(1);
    }
  });

  it('allocates oldest-first with integer-exact backing conservation', () => {
    const plan = planRedeemableEarnedAllocations({
      amountVclaw: 100,
      custodyWalletId: 'custody-1',
      now: NOW,
      lots: [
        eligibleLot({ mintLotId: 'lot-a', remainingVclaw: 60, backingRemainingUsdcAtomic: '600000' }),
        eligibleLot({ mintLotId: 'lot-b', remainingVclaw: 50, backingRemainingUsdcAtomic: '500000' }),
      ],
    });
    expect(plan).toEqual({
      ok: true,
      allocations: [
        { mintLotId: 'lot-a', vclawAmount: 60 },
        { mintLotId: 'lot-b', vclawAmount: 40 },
      ],
      backingUsdcAtomic: 1_000_000n,
    });
    if (plan.ok) {
      expect(plan.allocations.reduce((sum, allocation) => sum + allocation.vclawAmount, 0)).toBe(100);
      expect(plan.backingUsdcAtomic).toBe(100n * 10_000n);
    }
  });

  it('never floors a short or misaligned backing row into a partial cash-out', () => {
    for (const backingRemainingUsdcAtomic of ['500000', '999999', '1000001']) {
      const plan = planRedeemableEarnedAllocations({
        amountVclaw: 50,
        custodyWalletId: 'custody-1',
        now: NOW,
        lots: [eligibleLot({ remainingVclaw: 100, backingRemainingUsdcAtomic })],
      });
      expect(plan).toEqual({
        ok: false,
        code: 'insufficient_redeemable_earned',
        ineligibleReasons: ['backing_shortfall'],
      });
    }
  });
});

describe('conservative queue output', () => {
  it('sums signed fill minima and binds exact net-USDC clip inputs', () => {
    const fills = [
      { amountUsdc: '0.500000', outAmountAtomic: '7000000' },
      { amountUsdc: '0.455600', outAmountAtomic: '6000000' },
    ];
    expect(sumConservativeQueueOutput(fills)).toBe(13_000_000n);
    expect(validateRedemptionQueueFills(fills, 955_600n)).toBe(13_000_000n);
    expect(validateRedemptionQueueFills(fills, 955_601n)).toBeNull();
  });

  it('refuses empty, optimistic-only, malformed, zero, or negative fills', () => {
    expect(sumConservativeQueueOutput([])).toBeNull();
    expect(sumConservativeQueueOutput([{ outAmount: '9' }])).toBeNull();
    expect(sumConservativeQueueOutput([{ outAmountAtomic: '0' }])).toBeNull();
    expect(sumConservativeQueueOutput([{ outAmountAtomic: '-1' }])).toBeNull();
  });
});

describe('delivery capture-before-send kernel', () => {
  it('commits the claim before custody preparation/signing and captures before send', async () => {
    const log: string[] = [];
    const prepared = await claimThenPrepareAndCapture({
      claim: async () => { log.push('claim_commit'); return true; },
      prepare: async () => { log.push('key_load_and_sign'); return { signature: 'sig-1' }; },
      capture: async () => { log.push('signature_capture_commit'); return true; },
      releaseUnsigned: async () => { log.push('release_unsigned'); },
    });
    expect(prepared).toEqual({ signature: 'sig-1' });
    expect(log).toEqual(['claim_commit', 'key_load_and_sign', 'signature_capture_commit']);
  });

  it('does zero custody/signing work when the durable claim loses its CAS', async () => {
    const log: string[] = [];
    const prepared = await claimThenPrepareAndCapture({
      claim: async () => { log.push('claim_lost'); return false; },
      prepare: async () => { log.push('must_not_prepare'); return { signature: 'sig-1' }; },
      capture: async () => { log.push('must_not_capture'); return true; },
      releaseUnsigned: async () => { log.push('must_not_release'); },
    });
    expect(prepared).toBeNull();
    expect(log).toEqual(['claim_lost']);
  });

  it('durably captures before send and only then marks delivered', async () => {
    const log: string[] = [];
    const result = await executeCapturedSend({
      signature: 'sig-1',
      raw: new Uint8Array([1]),
      capture: async () => { log.push('capture'); return true; },
      send: async () => { log.push('send'); return 'sig-1'; },
      confirm: async () => { log.push('confirm'); return 'confirmed'; },
      markDelivered: async () => { log.push('delivered'); return true; },
      markReconcile: async () => { log.push('reconcile'); },
    });
    expect(result).toEqual({ ok: true, captured: true });
    expect(log).toEqual(['capture', 'send', 'confirm', 'delivered']);
  });

  it('never sends when capture loses the CAS', async () => {
    const log: string[] = [];
    const result = await executeCapturedSend({
      signature: 'sig-1',
      raw: new Uint8Array([1]),
      capture: async () => { log.push('capture'); return false; },
      send: async () => { log.push('send'); return 'sig-1'; },
      confirm: async () => 'confirmed',
      markDelivered: async () => true,
      markReconcile: async () => { log.push('reconcile'); },
    });
    expect(result).toEqual({ ok: false, captured: false, code: 'capture_lost' });
    expect(log).toEqual(['capture']);
  });

  it('quarantines ambiguous send after capture and never retries', async () => {
    const log: string[] = [];
    let sends = 0;
    const result = await executeCapturedSend({
      signature: 'sig-1',
      raw: new Uint8Array([1]),
      capture: async () => { log.push('capture'); return true; },
      send: async () => { sends += 1; log.push('send'); throw new Error('timeout'); },
      confirm: async () => { log.push('confirm'); return 'confirmed'; },
      markDelivered: async () => { log.push('delivered'); return true; },
      markReconcile: async (reason) => { log.push(`reconcile:${reason}`); },
    });
    expect(result).toEqual({ ok: false, captured: true, code: 'send_ambiguous' });
    expect(sends).toBe(1);
    expect(log).toEqual(['capture', 'send', 'reconcile:send_ambiguous']);
  });

  it('treats an RPC-echo signature mismatch as ambiguous after capture', async () => {
    const reasons: string[] = [];
    const result = await executeCapturedSend({
      signature: 'captured',
      raw: new Uint8Array([1]),
      capture: async () => true,
      send: async () => 'different',
      confirm: async () => 'confirmed',
      markDelivered: async () => true,
      markReconcile: async (reason) => { reasons.push(reason); },
    });
    expect(result).toMatchObject({ ok: false, captured: true });
    expect(reasons).toEqual(['send_ambiguous']);
  });
});

describe('physical backing solvency calculation', () => {
  const cleanIntegrity = (): EarnedBackingIntegrityCounts => ({
    mismatch_count: '0',
    missing_event_count: '0',
    missing_backing_count: '0',
    wrong_custody_count: '0',
    original_amount_count: '0',
    remaining_amount_count: '0',
    event_lot_count: '0',
    event_gross_count: '0',
    event_ledger_count: '0',
    event_avatar_count: '0',
    missing_ledger_count: '0',
    ledger_provenance_count: '0',
    ledger_amount_count: '0',
    ledger_avatar_count: '0',
    none_positive_count: '0',
  });

  it('fails closed with durable reasons for every structural backing wall', () => {
    const cases: Array<[keyof EarnedBackingIntegrityCounts, string]> = [
      ['missing_backing_count', 'backed_without_backing:1'],
      ['wrong_custody_count', 'backing_wrong_custody:1'],
      ['original_amount_count', 'backing_original_amount_mismatch:1'],
      ['remaining_amount_count', 'backing_remaining_amount_mismatch:1'],
      ['event_lot_count', 'event_lot_amount_mismatch:1'],
      ['event_ledger_count', 'event_lot_ledger_mismatch:1'],
      ['ledger_provenance_count', 'ledger_provenance_mismatch:1'],
      ['none_positive_count', 'none_lot_has_positive_backing:1'],
    ];
    for (const [field, reason] of cases) {
      const row = cleanIntegrity();
      row.mismatch_count = '1';
      row[field] = '1';
      expect(summarizeEarnedBackingIntegrity(row)).toEqual({
        mismatchCount: 1,
        reasons: [reason],
      });
    }
    expect(summarizeEarnedBackingIntegrity(undefined)).toEqual({
      mismatchCount: 1,
      reasons: ['backing_integrity_query_missing'],
    });
  });
  it('counts unswept net buy principal in addition to backing and retained fees', () => {
    const result = calculateEarnedBackingSolvency({
      onchainUsdcAtomic: 1_000_000n,
      outstandingBackingUsdcAtomic: 500_000n,
      retainedExitFeesUsdcAtomic: 44_400n,
      principals: [{
        redemptionId: 'r1',
        buyUsdcAtomic: '455600',
        fundingStatus: 'pending',
        fundingSignature: null,
        fundingConfirmedSlot: null,
      }],
    });
    expect(result.requiredUsdcAtomic).toBe(1_000_000n);
    expect(result.unsweptBuyPrincipalUsdcAtomic).toBe(455_600n);
    expect(result.solvent).toBe(true);
  });

  it('is indeterminate and false-green-proof for a captured ambiguous funding send', () => {
    const result = calculateEarnedBackingSolvency({
      onchainUsdcAtomic: 10_000_000n,
      outstandingBackingUsdcAtomic: 1n,
      retainedExitFeesUsdcAtomic: 1n,
      principals: [{
        redemptionId: 'r2',
        buyUsdcAtomic: '955600',
        fundingStatus: 'reconcile',
        fundingSignature: 'captured-sig',
        fundingConfirmedSlot: null,
      }],
    });
    expect(result.indeterminateReasons).toEqual(['r2:reconcile']);
    expect(result.solvent).toBe(false);
  });

  it('is indeterminate when a swept funding row lacks its captured proof', () => {
    const result = calculateEarnedBackingSolvency({
      onchainUsdcAtomic: 10_000_000n,
      outstandingBackingUsdcAtomic: 0n,
      retainedExitFeesUsdcAtomic: 0n,
      principals: [{
        redemptionId: 'r3',
        buyUsdcAtomic: '955600',
        fundingStatus: 'swept',
        fundingSignature: null,
        fundingConfirmedSlot: null,
      }],
    });
    expect(result.indeterminateReasons).toEqual([
      'r3:swept_without_signature',
      'r3:swept_without_confirmed_slot',
    ]);
    expect(result.solvent).toBe(false);
  });

  it('requires a positive persisted sweep slot and rejects a stale RPC context', () => {
    expect(isConfirmedFundingSweep({
      status: 'swept',
      sweepTxSignature: 'sig',
      sweepConfirmedSlot: null,
    })).toBe(false);
    expect(isConfirmedFundingSweep({
      status: 'swept',
      sweepTxSignature: 'sig',
      sweepConfirmedSlot: 123,
    })).toBe(true);
    expect(maxRequiredFundingContextSlot([{
      redemptionId: 'swept-1',
      buyUsdcAtomic: '955600',
      fundingStatus: 'swept',
      fundingSignature: 'sig',
      fundingConfirmedSlot: 123,
    }])).toBe(123);
    expect(() => assertMinimumContextSlot(122, 123)).toThrow('rpc_context_slot_stale');
    expect(() => assertMinimumContextSlot(123, 123)).not.toThrow();
    expect(fundingContextLagReason(122, 123)).toBe('custody_rpc_context_stale:122<123');
    expect(fundingContextLagReason(123, 123)).toBeNull();
  });

  it('never resets a stale no-signature claim after another worker reclaims it', () => {
    const observed = { claimId: 'old-claim', claimedAt: new Date('2026-07-14T00:00:00Z') };
    expect(sameFundingClaimSnapshot(observed, {
      claimId: 'old-claim',
      claimedAt: new Date('2026-07-14T00:00:00Z'),
    })).toBe(true);
    expect(sameFundingClaimSnapshot(observed, {
      claimId: 'new-claim',
      claimedAt: new Date('2026-07-14T00:05:00Z'),
    })).toBe(false);
  });

  it('never quarantines a stale captured snapshot after the active sender advances it', () => {
    const observed = {
      claimId: 'claim-1',
      claimedAt: new Date('2026-07-14T00:00:00Z'),
      sweepTxSignature: 'captured-sig',
    };
    expect(sameCapturedFundingSnapshot(observed, {
      status: 'sweeping',
      claimId: 'claim-1',
      claimedAt: new Date('2026-07-14T00:00:00Z'),
      sweepTxSignature: 'captured-sig',
    })).toBe(true);
    expect(sameCapturedFundingSnapshot(observed, {
      status: 'swept',
      claimId: 'claim-1',
      claimedAt: new Date('2026-07-14T00:00:00Z'),
      sweepTxSignature: 'captured-sig',
    })).toBe(false);
    expect(sameCapturedFundingSnapshot(observed, {
      status: 'sweeping',
      claimId: 'claim-2',
      claimedAt: new Date('2026-07-14T00:01:00Z'),
      sweepTxSignature: 'captured-sig',
    })).toBe(false);
  });

  it('quarantines a sweeping null claimedAt without resetting or reclaiming it', async () => {
    const state = {
      fundingStatus: 'sweeping',
      redemptionStatus: 'buy_queued',
      claimId: 'malformed-claim',
      sweepTxSignature: null as string | null,
    };
    const result = await quarantineNullFundingClaim({
      claimedAt: null,
      quarantineExactSnapshot: async () => {
        expect(state.fundingStatus).toBe('sweeping');
        expect(state.claimId).toBe('malformed-claim');
        expect(state.sweepTxSignature).toBeNull();
        state.fundingStatus = 'reconcile';
        return true;
      },
      quarantineRedemption: async () => {
        state.redemptionStatus = 'reconcile';
      },
    });

    expect(result).toBe('reconcile');
    expect(state).toEqual({
      fundingStatus: 'reconcile',
      redemptionStatus: 'reconcile',
      claimId: 'malformed-claim',
      sweepTxSignature: null,
    });
  });
});
