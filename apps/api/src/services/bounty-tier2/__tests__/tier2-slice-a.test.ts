import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { selectTier2ActorWallet } from '../tier2-admission';
import { selectTier2ClaimantWallet, sweepExpiredTier2Claims } from '../tier2-claim';
import { assertTier2BootReady, tier2ClaimTtlMs, tier2FeeAtomic, tier2Role } from '../tier2-config';
import { dispatchTier2State, runTier2DriverPass } from '../tier2-driver';
import { classifyLiveOperationForRecovery, createMockTier2ChainAdapter, paymentCoordinateDigest } from '../tier2-send';
import { Tier2Error } from '../tier2-errors';

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe('Tier-2 Slice A offline seams', () => {
  test('A2 precheck portion: boot gate refuses an unconfigured ops surface without connecting', async () => {
    process.env.SAP_USDC_ESCROW_ENABLED = 'true';
    process.env.DATABASE_URL = 'postgres://offline.invalid/app';
    delete process.env.TIER2_OPS_DATABASE_URL;
    await expect(assertTier2BootReady()).rejects.toMatchObject({ code: 'ops_surface_unconfigured' });
  });

  test('role identifiers and claim TTL fail closed', () => {
    process.env.TIER2_APP_DB_ROLE = 'clawville_app; RESET ROLE';
    expect(() => tier2Role('app')).toThrow(Tier2Error);
    process.env.TIER2_CLAIM_TTL_MS = '599999';
    expect(() => tier2ClaimTtlMs()).toThrow(Tier2Error);
  });

  test('the frozen five-dollar fee is 5,000,000 USDC atomic units', () => {
    delete process.env.TIER2_FEE_USD_CENTS;
    expect(tier2FeeAtomic()).toBe(5_000_000n);
  });

  test('A4/A8 pure identity portion: human and agent wallets are strict branches with no fallback', () => {
    const both = { walletAddress: 'agent-wallet', linkedWalletPubkey: 'human-wallet' };
    expect(selectTier2ActorWallet('agent', both)).toBe('agent-wallet');
    expect(selectTier2ActorWallet('human', both)).toBe('human-wallet');
    expect(selectTier2ClaimantWallet('agent', both)).toBe('agent-wallet');
    expect(selectTier2ClaimantWallet('human', both)).toBe('human-wallet');
    expect(selectTier2ClaimantWallet('human', { ...both, linkedWalletPubkey: null })).toBeNull();
    expect(selectTier2ClaimantWallet('agent', { ...both, walletAddress: null })).toBeNull();
  });

  test('dispatcher sends every frozen edge class only to its dedicated door', () => {
    expect(dispatchTier2State('fee_pending').door).toBe('driverTransition');
    expect(dispatchTier2State('vault_confirmed').door).toBe('reconcilerTransition');
    expect(dispatchTier2State('payout_ready').door).toBe('payoutTransition');
    expect(dispatchTier2State('settle_snapshot_ops_pending').door).toBe('consumeSettleSnapshot');
    expect(dispatchTier2State('awaiting_finalize').door).toBe('consumeFinalizeRelease');
    expect(dispatchTier2State('create_failed').door).toBe('consumeRefundStart');
    expect(dispatchTier2State('settle_exhausted').door).toBe('consumeOperationConfirmed');
    expect(dispatchTier2State('finalize_exhausted').door).toBe('consumeOpsContinue');
    expect(dispatchTier2State('arithmetic_branch_violation').door).toBe('opsTransition');
    expect(dispatchTier2State('cleanup_pending').door).toBe('slice_c_cleanup');
  });

  test('mock adapter uses the DB-derived destination, amount, fee, and payment digest', async () => {
    const adapter = createMockTier2ChainAdapter('offline');
    const paymentDigest = new Uint8Array(32).fill(7);
    const built = await adapter.buildLeg({
      bountyId: '00000000-0000-0000-0000-000000000001',
      leg: 'payout',
      operationId: '00000000-0000-0000-0000-000000000002',
      depositorPublicKey: '11111111111111111111111111111111',
      depositorUsdcAta: '11111111111111111111111111111111',
      generation: 3n,
      expectedDestination: '11111111111111111111111111111111',
      expectedAmount: 5_000_000n,
      estimatedFeeLamports: 250_000n,
      paymentDigest,
    });
    expect(built.destination).toBe('11111111111111111111111111111111');
    expect(built.amount).toBe(5_000_000n);
    expect(built.estimatedFeeLamports).toBe(250_000n);
    expect(built.paymentDigest).toEqual(paymentDigest);
  });

  test('canonical payment digest matches the frozen unit-separator encoding', () => {
    const args = [
      '00000000-0000-0000-0000-000000000001',
      'payout',
      '00000000-0000-0000-0000-000000000002',
      '3',
      '5000000',
      '11111111111111111111111111111111',
    ];
    const expected = createHash('sha256')
      .update(['tier2-payment-v1', ...args].join(String.fromCharCode(31)), 'utf8')
      .digest();
    expect(paymentCoordinateDigest(args[0], 'payout', args[2], 3n, 5_000_000n, args[5]))
      .toEqual(expected);
  });

  test('A11 recovery portion retires unsigned live ops and quarantines stored broadcasts', () => {
    expect(classifyLiveOperationForRecovery({ operationId: 'op', state: 'claimed' }))
      .toBe('retire_not_broadcast');
    expect(classifyLiveOperationForRecovery({
      operationId: 'op', state: 'claimed', signature: 'sig', sentAt: new Date(),
    })).toBe('quarantine_broadcast');
    expect(classifyLiveOperationForRecovery({
      operationId: 'op', state: 'broadcast_unknown', signature: 'sig', sentAt: new Date(),
    })).toBe('quarantine_broadcast');
  });

  test('A12 worker portion: flag off makes sweeper and driver pure no-ops', async () => {
    process.env.SAP_USDC_ESCROW_ENABLED = 'false';
    process.env.TIER2_DRIVER_ENABLED = 'true';
    expect(await sweepExpiredTier2Claims()).toEqual({ reverted: 0 });
    expect(await runTier2DriverPass()).toEqual({ advanced: 0 });
  });
});
