import { afterEach, describe, expect, it } from 'bun:test';
import {
  atomicToUsdString,
  earnFromExternalSettlement,
  isEarnBackingNetworkAllowed,
  loadTokenomicsEarnConfig,
  toAtomicBigint,
} from '../earned-import';
import { calculateEarnedBackingSolvency } from '../earned-solvency';

describe('earned import founder-locked policy', () => {
  const originalClawvilleEnv = process.env.CLAWVILLE_ENV;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalRakeFloor = process.env.TOKENOMICS_EARN_RAKE_FLOOR_BPS;

  afterEach(() => {
    if (originalClawvilleEnv === undefined) delete process.env.CLAWVILLE_ENV;
    else process.env.CLAWVILLE_ENV = originalClawvilleEnv;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalRakeFloor === undefined) delete process.env.TOKENOMICS_EARN_RAKE_FLOOR_BPS;
    else process.env.TOKENOMICS_EARN_RAKE_FLOOR_BPS = originalRakeFloor;
  });

  it('never accepts devnet backing proof in production, even under a test runner', () => {
    process.env.CLAWVILLE_ENV = 'production';
    process.env.NODE_ENV = 'test';
    expect(isEarnBackingNetworkAllowed('devnet')).toBe(false);
    expect(isEarnBackingNetworkAllowed('mainnet')).toBe(true);
  });

  it('allows devnet backing proof only in isolated staging/test environments', () => {
    process.env.CLAWVILLE_ENV = 'staging';
    process.env.NODE_ENV = 'production';
    expect(isEarnBackingNetworkAllowed('devnet')).toBe(true);

    delete process.env.CLAWVILLE_ENV;
    process.env.NODE_ENV = 'test';
    expect(isEarnBackingNetworkAllowed('devnet')).toBe(true);

    delete process.env.CLAWVILLE_ENV;
    process.env.NODE_ENV = 'production';
    expect(isEarnBackingNetworkAllowed('devnet')).toBe(false);
  });

  it('keeps the entry rake disabled and converts cents with integer exactness', () => {
    process.env.TOKENOMICS_EARN_RAKE_FLOOR_BPS = '9999';
    expect(loadTokenomicsEarnConfig().rakeFloorBps).toBe(0);
    expect(toAtomicBigint('1000000')).toBe(1_000_000n);
    expect(atomicToUsdString(1_000_000n)).toBe('1.000000');
    expect(1_000_000n / 10_000n).toBe(100n);
  });

  it('reserves current backing, retained fees, and unswept principal before minting', () => {
    const exact = calculateEarnedBackingSolvency({
      onchainUsdcAtomic: 2_000_000n,
      outstandingBackingUsdcAtomic: 900_000n,
      retainedExitFeesUsdcAtomic: 44_400n,
      principals: [{
        redemptionId: 'redeem-1',
        buyUsdcAtomic: '955600',
        fundingStatus: 'pending',
        fundingSignature: null,
        fundingConfirmedSlot: null,
      }],
      newBackingUsdcAtomic: 100_000n,
    });
    expect(exact.requiredUsdcAtomic).toBe(2_000_000n);
    expect(exact.solvent).toBe(true);

    expect(calculateEarnedBackingSolvency({
      onchainUsdcAtomic: 1_999_999n,
      outstandingBackingUsdcAtomic: 900_000n,
      retainedExitFeesUsdcAtomic: 44_400n,
      principals: [{
        redemptionId: 'redeem-1',
        buyUsdcAtomic: '955600',
        fundingStatus: 'pending',
        fundingSignature: null,
        fundingConfirmedSlot: null,
      }],
      newBackingUsdcAtomic: 100_000n,
    }).solvent).toBe(false);
  });

  it('refuses new backing while a captured funding transfer is ambiguous', () => {
    const result = calculateEarnedBackingSolvency({
      onchainUsdcAtomic: 10_000_000n,
      outstandingBackingUsdcAtomic: 1_000_000n,
      retainedExitFeesUsdcAtomic: 0n,
      principals: [{
        redemptionId: 'redeem-ambiguous',
        buyUsdcAtomic: '9556',
        fundingStatus: 'reconcile',
        fundingSignature: 'captured-before-send',
        fundingConfirmedSlot: null,
      }],
      newBackingUsdcAtomic: 10_000n,
    });
    expect(result.indeterminateReasons).toEqual(['redeem-ambiguous:reconcile']);
    expect(result.solvent).toBe(false);
  });

  it('refuses a swept principal without a confirmed slot for an RPC freshness floor', () => {
    const result = calculateEarnedBackingSolvency({
      onchainUsdcAtomic: 10_000_000n,
      outstandingBackingUsdcAtomic: 1_000_000n,
      retainedExitFeesUsdcAtomic: 44_400n,
      principals: [{
        redemptionId: 'redeem-swept',
        buyUsdcAtomic: '955600',
        fundingStatus: 'swept',
        fundingSignature: 'confirmed-signature',
        fundingConfirmedSlot: null,
      }],
      newBackingUsdcAtomic: 10_000n,
    });
    expect(result.indeterminateReasons).toContain('redeem-swept:swept_without_confirmed_slot');
    expect(result.solvent).toBe(false);
  });

  it('replays only an identical immutable backing proof and skips chain RPC', async () => {
    process.env.TOKENOMICS_EARN_ENABLED = 'true';
    process.env.CLAWVILLE_ENV = 'production';
    let verifyCalls = 0;
    const database = {
      async execute() {
        return [{
          id: '00000000-0000-4000-8000-000000000001',
          ledger_id: '00000000-0000-4000-8000-000000000002',
          vclaw_minted: 100,
          gross_usdc_atomic: '1000000',
          earner_avatar_id: '00000000-0000-4000-8000-000000000003',
          payer_wallet: '11111111111111111111111111111111',
          source: 'x402',
          backing_network: 'mainnet',
          source_ref: 'usdc:mainnet:proof-signature-1',
          proof_count: 1,
        }];
      },
      async transaction() {
        throw new Error('replay must return before transaction');
      },
    };
    const base = {
      earnerAvatarId: '00000000-0000-4000-8000-000000000003',
      payerWallet: '11111111111111111111111111111111',
      usdcAmountAtomic: '1000000',
      source: 'x402' as const,
      idempotencyKey: 'immutable-replay',
      backingTxSignature: 'proof-signature-1',
      backingNetwork: 'mainnet' as const,
    };
    const deps = {
      database: database as never,
      verifyTransfer: async () => {
        verifyCalls += 1;
        throw new Error('must not verify an immutable replay');
      },
    };

    expect(await earnFromExternalSettlement(base, deps)).toMatchObject({ status: 'duplicate' });
    expect(verifyCalls).toBe(0);
    expect(await earnFromExternalSettlement({
      ...base,
      backingTxSignature: 'different-proof-signature',
    }, deps)).toEqual({ status: 'rejected', reason: 'idempotency_conflict' });
    expect(verifyCalls).toBe(0);
  });

  it('refuses a custody balance observation older than the latest confirmed sweep', async () => {
    process.env.TOKENOMICS_EARN_ENABLED = 'true';
    process.env.CLAWVILLE_ENV = 'production';
    const custody = {
      id: '00000000-0000-4000-8000-000000000010',
      public_key: '22222222222222222222222222222222',
    };
    let outerCalls = 0;
    let txCalls = 0;
    const tx = {
      async execute() {
        txCalls += 1;
        if (txCalls === 1 || txCalls === 2 || txCalls === 4) return [];
        if (txCalls === 3) return [custody];
        if (txCalls === 5) return [{
          mismatch_count: '0', missing_event_count: '0', missing_backing_count: '0',
          wrong_custody_count: '0', original_amount_count: '0', remaining_amount_count: '0',
          event_lot_count: '0', event_gross_count: '0', event_ledger_count: '0',
          event_avatar_count: '0', missing_ledger_count: '0', ledger_provenance_count: '0',
          ledger_amount_count: '0', ledger_avatar_count: '0', none_positive_count: '0',
        }];
        if (txCalls === 6) return [{
          outstanding_usdc_atomic: '1000000',
          retained_fees_usdc_atomic: '44400',
        }];
        if (txCalls === 7) return [{
          redemptionId: 'redemption-1',
          buyUsdcAtomic: '955600',
          fundingStatus: 'swept',
          fundingSignature: 'sweep-signature',
          fundingConfirmedSlot: 500,
        }];
        throw new Error(`unexpected tx execute ${txCalls}`);
      },
    };
    const database = {
      async execute() {
        outerCalls += 1;
        return outerCalls === 1 ? [] : [custody];
      },
      async transaction<T>(fn: (inner: typeof tx) => Promise<T>): Promise<T> { return fn(tx); },
    };
    const result = await earnFromExternalSettlement({
      earnerAvatarId: '00000000-0000-4000-8000-000000000011',
      payerWallet: '11111111111111111111111111111111',
      usdcAmountAtomic: '10000',
      source: 'x402',
      idempotencyKey: 'stale-context-slot',
      backingTxSignature: 'proof-signature-stale-context',
      backingNetwork: 'mainnet',
    }, {
      database: database as never,
      verifyTransfer: async () => ({
        kind: 'confirmed_match',
        transfer: {
          signature: 'proof-signature-stale-context',
          atomicAmount: '10000',
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          destinationAta: 'destination',
          sourceAta: 'source',
          payer: '11111111111111111111111111111111',
          blockTime: 1,
        },
      }),
      readCustodyUsdcBalance: async (_network, _owner, options) => {
        expect(options?.minContextSlot).toBe(500);
        return { amountAtomic: 10_000_000n, contextSlot: 499 };
      },
    });
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'backing_custody_indeterminate',
    });
  });
});
