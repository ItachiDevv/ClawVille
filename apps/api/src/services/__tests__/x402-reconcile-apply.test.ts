import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type {
  ReconcileApplyStore,
  ReconcileRow,
  ReconcileScanDeps,
  RefundEvidence,
} from '../x402-reconcile';
import {
  normalizeAgentReconcileReason,
  resolveReconcileNoMoneyGraceMs,
  runReconcileScan,
} from '../x402-reconcile';
import { parseReconcileCliArgs } from '../x402-reconcile';

const APPLY_WAS = process.env.RECONCILE_APPLY;
const GRACE_WAS = process.env.RECONCILE_NO_MONEY_GRACE_MS;

const NOW = new Date('2026-07-13T12:00:00.000Z');
const PAYER = 'payer-wallet';
const MERCHANT = 'merchant-wallet';
const SIGNATURE = 'verified-signature';

function row(
  table: ReconcileRow['table'] = 'x402_checkouts',
  overrides: Partial<ReconcileRow> = {},
): ReconcileRow {
  return {
    table,
    id: `${table}-1`,
    usdCents: 100,
    createdAt: '2026-07-11T00:00:00.000Z',
    settlingStartedAt: '2026-07-11T00:01:00.000Z',
    metadata: {
      reconcileReason: 'capture_lost',
      spentTxSignature: SIGNATURE,
      expectedPayer: PAYER,
      settleNetwork: 'devnet',
    },
    ...overrides,
  };
}

function confirmed(signature = SIGNATURE) {
  return {
    kind: 'confirmed_match' as const,
    transfer: {
      signature,
      atomicAmount: '1000000',
      mint: 'mint',
      destinationAta: 'destination-ata',
      sourceAta: 'source-ata',
      payer: PAYER,
      blockTime: Math.floor(NOW.getTime() / 1_000),
    },
  };
}

type State = {
  status: 'reconcile' | 'settling' | 'settled' | 'failed';
  reconcileResolution?: 'refund_required' | 'no_money';
  signature?: string;
  payer?: string | null;
  refund?: RefundEvidence;
};

function harness(
  sourceRows: ReconcileRow[],
  options: {
    captureResult?: 'captured' | 'lost' | 'signature_conflict';
    probeResult?: 'match' | 'ambiguous' | 'none' | 'indeterminate';
    fulfillmentSuccess?: boolean;
    loadConfigThrows?: boolean;
  } = {},
) {
  const states = new Map(sourceRows.map((candidate) => [candidate.id, { status: 'reconcile' } as State]));
  const calls = {
    verify: 0,
    probe: 0,
    capture: 0,
    refund: 0,
    noMoney: 0,
    checkoutFulfill: 0,
    topupFulfill: 0,
    agentFulfill: 0,
    alerts: 0,
  };
  const verifyInputs: Array<Record<string, unknown>> = [];

  const store: ReconcileApplyStore = {
    async isSignatureBound() { return false; },
    async claimVerifiedCapture(candidate, signature, payer) {
      calls.capture += 1;
      if (options.captureResult && options.captureResult !== 'captured') return options.captureResult;
      const state = states.get(candidate.id);
      if (!state || state.status !== 'reconcile') return 'lost';
      Object.assign(state, { status: 'settling', signature, payer });
      return 'captured';
    },
    async markRefundRequired(candidate, evidence) {
      calls.refund += 1;
      const state = states.get(candidate.id);
      if (!state || state.status !== 'reconcile' || state.reconcileResolution === 'refund_required') {
        return false;
      }
      Object.assign(state, { reconcileResolution: 'refund_required', refund: evidence });
      return true;
    },
    async markNoMoneyFailed(candidate) {
      calls.noMoney += 1;
      const state = states.get(candidate.id);
      if (!state || state.status !== 'reconcile') return false;
      Object.assign(state, { status: 'failed', reconcileResolution: 'no_money' });
      return true;
    },
  };

  const deps: ReconcileScanDeps = {
    readRows: async () => sourceRows
      .filter((candidate) => states.get(candidate.id)?.status === 'reconcile')
      .map((candidate) => {
        const resolution = states.get(candidate.id)?.reconcileResolution;
        return resolution
          ? { ...candidate, metadata: { ...candidate.metadata, reconcileResolution: resolution } }
          : candidate;
      }),
    store,
    chain: {
      async getParsedTransaction() { return null; },
      async getSignaturesForAddress() { return []; },
      async isSignatureBound() { return false; },
    },
    verifyTransfer: async (input) => {
      calls.verify += 1;
      verifyInputs.push(input as unknown as Record<string, unknown>);
      return confirmed(input.signature);
    },
    probeTransfers: async () => {
      calls.probe += 1;
      switch (options.probeResult ?? 'none') {
        case 'match': return { kind: 'match', match: confirmed('probed-signature').transfer, examined: 1, excludedBound: 0 };
        case 'ambiguous': return { kind: 'ambiguous', matches: [confirmed('a').transfer, confirmed('b').transfer], examined: 2, excludedBound: 0 };
        case 'indeterminate': return { kind: 'indeterminate', reason: 'lookback_cap_exhausted', examined: 500, excludedBound: 0 };
        case 'none': return { kind: 'none', examined: 1, excludedBound: 0 };
      }
    },
    loadConfig: () => {
      if (options.loadConfigThrows) throw new Error('config unavailable');
      return {
        enabled: true,
        facilitatorPreset: 'payai',
        facilitatorUrlExplicit: false,
        facilitatorUrl: 'https://facilitator.payai.network',
        payaiApiKeyId: '',
        payaiApiKeySecret: '',
        merchantWalletPubkey: MERCHANT,
        network: 'devnet',
      };
    },
    now: () => new Date(NOW),
    randomId: () => '00000000-0000-4000-8000-000000000001',
    fulfillCheckout: async (id) => {
      calls.checkoutFulfill += 1;
      if (options.fulfillmentSuccess === false) return { ok: false, code: 'settle_failed', transient: true };
      const state = states.get(id);
      if (state) state.status = 'settled';
      return {
        ok: true,
        checkoutId: id,
        itemKind: 'cosmetic_purchase',
        itemRef: 'sku-1',
        priceVclaw: 100,
        replay: false,
        txSignature: SIGNATURE,
        fulfillment: null,
      };
    },
    fulfillTopup: async (id) => {
      calls.topupFulfill += 1;
      if (options.fulfillmentSuccess === false) return { httpStatus: 500, json: { error: 'settle_failed' } };
      const state = states.get(id);
      if (state) state.status = 'settled';
      return {
        httpStatus: 200,
        json: { ctCredited: 100, balance: 100, txSignature: SIGNATURE },
      };
    },
    fulfillAgentPayment: async (id) => {
      calls.agentFulfill += 1;
      if (options.fulfillmentSuccess === false) return { ok: false, code: 'fulfillment_pending', paymentId: id, status: 'settling' };
      const state = states.get(id);
      if (state) state.status = 'settled';
      return {
        ok: true,
        paymentId: id,
        status: 'settled',
        replay: false,
        txSignature: SIGNATURE,
        senderAvatarId: 'sender',
        recipientAvatarId: 'recipient',
        usdCents: 100,
        earnedVclaw: 100,
        earnedLedgerId: 'ledger',
      };
    },
    alert: async () => { calls.alerts += 1; },
  };
  return { deps, states, calls, verifyInputs };
}

describe('x402 reconcile apply orchestration', () => {
  beforeEach(() => {
    process.env.RECONCILE_APPLY = 'true';
    process.env.RECONCILE_NO_MONEY_GRACE_MS = '3600000';
  });

  afterAll(() => {
    if (APPLY_WAS === undefined) delete process.env.RECONCILE_APPLY;
    else process.env.RECONCILE_APPLY = APPLY_WAS;
    if (GRACE_WAS === undefined) delete process.env.RECONCILE_NO_MONEY_GRACE_MS;
    else process.env.RECONCILE_NO_MONEY_GRACE_MS = GRACE_WAS;
  });

  it('captures a verified checkout and invokes its own fulfiller exactly once; second scan is a no-op', async () => {
    const candidate = row();
    const h = harness([candidate]);
    const first = await runReconcileScan({ apply: true, deps: h.deps });
    const second = await runReconcileScan({ apply: true, deps: h.deps });
    expect(first.verdicts[0]?.action).toBe('applied_capture_fulfill');
    expect(second.scanned).toBe(0);
    expect(h.calls.capture).toBe(1);
    expect(h.calls.checkoutFulfill).toBe(1);
    expect(h.states.get(candidate.id)?.status).toBe('settled');
  });

  it('turns a capture signature conflict into durable refund-required and never fulfills', async () => {
    const candidate = row();
    const h = harness([candidate], { captureResult: 'signature_conflict' });
    const result = await runReconcileScan({ apply: true, deps: h.deps });
    expect(result.verdicts[0]?.action).toBe('applied_refund_required');
    expect(h.states.get(candidate.id)?.refund).toMatchObject({
      signature: SIGNATURE,
      payer: PAYER,
      expectedUsdcAtomic: '1000000',
    });
    expect(h.calls.checkoutFulfill).toBe(0);
    expect(h.calls.alerts).toBe(1);
  });

  it('records an explicit refund-required recommendation once; repeat is manual with no second alert', async () => {
    const candidate = row('ct_topups', {
      metadata: {
        reconcileReason: 'signature_conflict',
        spentTxSignature: SIGNATURE,
        expectedPayer: PAYER,
        settleNetwork: 'devnet',
      },
    });
    const h = harness([candidate]);
    const first = await runReconcileScan({ apply: true, deps: h.deps });
    const second = await runReconcileScan({ apply: true, deps: h.deps });
    expect(first.verdicts[0]?.action).toBe('applied_refund_required');
    expect(second.verdicts[0]?.action).toBe('manual_review');
    expect(h.calls.refund).toBe(1);
    expect(h.calls.alerts).toBe(1);
    expect(h.calls.topupFulfill).toBe(0);
  });

  it('fails an old no-money row but leaves a younger row untouched', async () => {
    const old = row('ct_topups', {
      id: 'old',
      metadata: { reconcileReason: 'stale_settling', settleNetwork: 'devnet' },
    });
    const young = row('ct_topups', {
      id: 'young',
      createdAt: '2026-07-13T11:30:00.000Z',
      settlingStartedAt: null,
      metadata: { reconcileReason: 'stale_settling', settleNetwork: 'devnet' },
    });
    const h = harness([old, young], { probeResult: 'none' });
    const result = await runReconcileScan({ apply: true, deps: h.deps });
    expect(result.verdicts.find((v) => v.id === 'old')?.action).toBe('applied_no_money');
    expect(result.verdicts.find((v) => v.id === 'young')?.action).toBe('skipped');
    expect(h.states.get('old')?.status).toBe('failed');
    expect(h.states.get('young')?.status).toBe('reconcile');
    expect(h.calls.noMoney).toBe(1);
  });

  it('defaults blank, unset, and non-numeric no-money grace to 24h; explicit numbers retain the 1h floor', () => {
    delete process.env.RECONCILE_NO_MONEY_GRACE_MS;
    expect(resolveReconcileNoMoneyGraceMs()).toBe(86_400_000);
    expect(resolveReconcileNoMoneyGraceMs('')).toBe(86_400_000);
    expect(resolveReconcileNoMoneyGraceMs('   ')).toBe(86_400_000);
    expect(resolveReconcileNoMoneyGraceMs('not-a-number')).toBe(86_400_000);
    expect(resolveReconcileNoMoneyGraceMs('1000')).toBe(3_600_000);
    expect(resolveReconcileNoMoneyGraceMs('7200000')).toBe(7_200_000);
  });

  it('does not mutate or fulfill when the capture CAS is lost', async () => {
    const candidate = row();
    const h = harness([candidate], { captureResult: 'lost' });
    const result = await runReconcileScan({ apply: true, deps: h.deps });
    expect(result.verdicts[0]?.action).toBe('skipped');
    expect(result.verdicts[0]?.detail).toContain('CAS lost');
    expect(h.calls.checkoutFulfill).toBe(0);
    expect(h.states.get(candidate.id)?.status).toBe('reconcile');
  });

  it('captures and fulfills agent_payments using recipientWallet and metadata.network fallback', async () => {
    const candidate = row('agent_payments', {
      destinationOwner: 'agent-recipient-wallet',
      metadata: {
        reconcileReason: 'capture_lost',
        spentTxSignature: SIGNATURE,
        expectedPayer: PAYER,
        network: 'devnet',
      },
    });
    const h = harness([candidate]);
    const result = await runReconcileScan({ apply: true, deps: h.deps });
    expect(result.verdicts[0]?.action).toBe('applied_capture_fulfill');
    expect(h.calls.agentFulfill).toBe(1);
    expect(h.verifyInputs[0]).toMatchObject({
      network: 'devnet',
      destinationOwner: 'agent-recipient-wallet',
    });
  });

  it('normalizes observed agent reconcile signatures to capture_lost and unknown no-signature failures to ambiguous', () => {
    expect(normalizeAgentReconcileReason('settlement_capture_failed', SIGNATURE)).toBe('capture_lost');
    expect(normalizeAgentReconcileReason('signature_conflict', SIGNATURE)).toBe('signature_conflict');
    expect(normalizeAgentReconcileReason('stale_settling', null)).toBe('stale_settling');
    expect(normalizeAgentReconcileReason('facilitator_execute_threw', null)).toBe('settle_ambiguous');
  });

  it('defaults to dry-run even when env consent is present and performs no chain/apply calls', async () => {
    const candidate = row();
    const h = harness([candidate]);
    const result = await runReconcileScan({ deps: h.deps });
    expect(result.verdicts[0]?.action).toBe('dry_run');
    expect(h.calls.verify).toBe(0);
    expect(h.calls.capture).toBe(0);
    expect(h.calls.checkoutFulfill).toBe(0);
  });

  it('treats a capped/indeterminate probe as skipped, never no-money', async () => {
    const candidate = row('x402_checkouts', {
      metadata: { reconcileReason: 'settle_ambiguous', settleNetwork: 'devnet' },
    });
    const h = harness([candidate], { probeResult: 'indeterminate' });
    const result = await runReconcileScan({ apply: true, deps: h.deps });
    expect(result.verdicts[0]?.action).toBe('skipped');
    expect(result.verdicts[0]?.detail).toContain('lookback_cap_exhausted');
    expect(h.calls.noMoney).toBe(0);
  });

  it('keeps a captured row resumable when its native fulfiller returns non-success', async () => {
    const candidate = row();
    const h = harness([candidate], { fulfillmentSuccess: false });
    const result = await runReconcileScan({ apply: true, deps: h.deps });
    expect(result.verdicts[0]?.action).toBe('applied_capture_pending');
    expect(result.verdicts[0]?.detail).toContain('remains resumable');
    expect(h.states.get(candidate.id)?.status).toBe('settling');
    expect(h.calls.alerts).toBe(1);
  });

  it('fails soft per row when config resolution throws', async () => {
    const candidate = row();
    const h = harness([candidate], { loadConfigThrows: true });
    const result = await runReconcileScan({ apply: true, deps: h.deps });
    expect(result.verdicts[0]?.action).toBe('skipped');
    expect(result.verdicts[0]?.detail).toContain('config unavailable');
    expect(h.calls.capture).toBe(0);
  });

  it('requires explicit apply plus env consent and validates CLI row selectors', async () => {
    delete process.env.RECONCILE_APPLY;
    const h = harness([row()]);
    await expect(runReconcileScan({ apply: true, deps: h.deps })).rejects.toThrow(/also required/);
    expect(() => parseReconcileCliArgs(['--apply'])).toThrow(/also requires/);
    process.env.RECONCILE_APPLY = 'true';
    expect(parseReconcileCliArgs(['--apply', '--row', 'agent_payments:payment-1'])).toEqual({
      apply: true,
      row: 'agent_payments:payment-1',
    });
    expect(() => parseReconcileCliArgs(['--row', 'wrong:row'])).toThrow(/Invalid --row/);
  });
});
