import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { deriveUsdcAta } from '../x402-chain-verifier';
import {
  deriveBulkReconcileWindow,
  parseBulkReconcileCliArgs,
  runBulkReconcileSweep,
  type BulkReconcileDeps,
} from '../x402-bulk-reconcile';
import type {
  ReconcileApplyStore,
  ReconcileRow,
} from '../x402-reconcile';
import { usdcMintForNetwork } from '../x402-payai';

const APPLY_WAS = process.env.RECONCILE_APPLY;
const GRACE_WAS = process.env.RECONCILE_NO_MONEY_GRACE_MS;
const PAYER = '11111111111111111111111111111111';
const MERCHANT = 'So11111111111111111111111111111111111111112';
const MINT = usdcMintForNetwork('devnet');
const DESTINATION_ATA = deriveUsdcAta(MERCHANT, MINT);
const NOW = new Date('2026-07-23T12:00:00.000Z');

function row(id: string, at: string, overrides: Partial<ReconcileRow> = {}): ReconcileRow {
  return {
    table: 'agent_payments',
    id,
    usdCents: 100,
    createdAt: at,
    settlingStartedAt: new Date(new Date(at).getTime() + 60_000).toISOString(),
    destinationOwner: MERCHANT,
    metadata: {
      reconcileReason: 'stale_settling',
      expectedPayer: PAYER,
      settleNetwork: 'devnet',
    },
    ...overrides,
  };
}

function transaction(signature: string, blockTime: number, atomic = '1000000') {
  return {
    blockTime,
    meta: { err: null, innerInstructions: [] },
    transaction: {
      message: {
        instructions: [{
          program: 'spl-token',
          parsed: {
            type: 'transferChecked',
            info: {
              source: PAYER,
              destination: DESTINATION_ATA,
              authority: PAYER,
              mint: MINT,
              tokenAmount: {
                amount: atomic,
                decimals: 6,
                uiAmount: Number(atomic) / 1_000_000,
              },
            },
          },
        }],
      },
    },
    signature,
  };
}

function harness(
  sourceRows: ReconcileRow[],
  transfers: Array<{ signature: string; blockTime: number; atomic?: string }>,
) {
  const states = new Map(sourceRows.map((candidate) => [
    candidate.id,
    'reconcile' as 'reconcile' | 'settling' | 'settled' | 'failed',
  ]));
  const bound = new Set<string>();
  const calls = {
    pages: 0,
    parsed: 0,
    captures: 0,
    noMoney: 0,
    fulfill: 0,
  };
  const store: ReconcileApplyStore = {
    async isSignatureBound(signature) {
      return bound.has(signature);
    },
    async claimVerifiedCapture(candidate, signature) {
      calls.captures += 1;
      if (bound.has(signature)) return 'signature_conflict';
      if (states.get(candidate.id) !== 'reconcile') return 'lost';
      states.set(candidate.id, 'settling');
      bound.add(signature);
      return 'captured';
    },
    async markRefundRequired() {
      throw new Error('bulk sweep must not record refunds');
    },
    async markNoMoneyFailed(candidate) {
      calls.noMoney += 1;
      if (states.get(candidate.id) !== 'reconcile') return false;
      states.set(candidate.id, 'failed');
      return true;
    },
  };
  const deps: BulkReconcileDeps = {
    readRows: async () => sourceRows.filter((candidate) =>
      states.get(candidate.id) === 'reconcile'),
    store,
    chain: {
      async getSignaturesForAddress(_network, address) {
        calls.pages += 1;
        expect(address).toBe(DESTINATION_ATA);
        return transfers
          .slice()
          .sort((left, right) => right.blockTime - left.blockTime)
          .map((entry) => ({
            signature: entry.signature,
            blockTime: entry.blockTime,
            err: null,
          }));
      },
      async getParsedTransaction(_network, signature) {
        calls.parsed += 1;
        const entry = transfers.find((candidate) => candidate.signature === signature);
        return entry
          ? transaction(signature, entry.blockTime, entry.atomic)
          : null;
      },
      isSignatureBound: (signature) => store.isSignatureBound(signature),
    },
    loadConfig: () => ({
      enabled: true,
      facilitatorPreset: 'payai',
      facilitatorUrlExplicit: false,
      facilitatorUrl: 'https://facilitator.payai.network',
      payaiApiKeyId: '',
      payaiApiKeySecret: '',
      merchantWalletPubkey: MERCHANT,
      network: 'devnet',
    }),
    now: () => new Date(NOW),
    randomId: () => '00000000-0000-4000-8000-000000000001',
    fulfillAgentPayment: async (id) => {
      calls.fulfill += 1;
      states.set(id, 'settled');
      return {
        ok: true,
        paymentId: id,
        status: 'settled',
        replay: false,
        txSignature: [...bound][0] ?? 'signature',
        senderAvatarId: 'sender',
        recipientAvatarId: 'recipient',
        usdCents: 100,
        earnedVclaw: 100,
        earnedLedgerId: 'ledger',
      };
    },
    alert: async () => {},
    sleep: async () => {},
    log: () => {},
  };
  return { deps, states, bound, calls };
}

describe('x402 bulk outage reconciliation', () => {
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

  it('matches one exact transfer and leaves an unmatched young row waiting', async () => {
    const paid = row('paid', '2026-07-23T10:00:00.000Z');
    const young = row('young', '2026-07-23T11:30:00.000Z');
    const h = harness([paid, young], [{
      signature: 'sig-paid',
      blockTime: Date.parse('2026-07-23T10:01:00.000Z') / 1_000,
    }]);
    const result = await runBulkReconcileSweep({
      limit: 2,
      safetyMarginMs: 0,
      matchToleranceMs: 5 * 60_000,
      deps: h.deps,
    });
    expect(result.verdicts.find((verdict) => verdict.row.id === 'paid')?.bucket)
      .toBe('matched');
    expect(result.verdicts.find((verdict) => verdict.row.id === 'young')?.bucket)
      .toBe('waiting');
    expect(h.calls.captures).toBe(0);
    expect(h.calls.pages).toBe(1);
  });

  it('uses the reconcile update anchor when settling_started_at was cleared', async () => {
    const candidate = row('late-attempt', '2026-07-21T10:00:00.000Z', {
      settlingStartedAt: null,
      reconcileAnchorAt: '2026-07-23T10:01:00.000Z',
    });
    const h = harness([candidate], [{
      signature: 'sig-late-attempt',
      blockTime: Date.parse('2026-07-23T10:00:30.000Z') / 1_000,
    }]);
    const result = await runBulkReconcileSweep({
      safetyMarginMs: 0,
      matchToleranceMs: 60_000,
      deps: h.deps,
    });
    expect(result.verdicts[0]?.bucket).toBe('matched');
    expect(result.verdicts[0]?.transfer?.signature).toBe('sig-late-attempt');
  });

  it('puts one-row/two-transfer ambiguity in MANUAL and never guesses', async () => {
    const candidate = row('ambiguous', '2026-07-23T10:00:00.000Z');
    const h = harness([candidate], [
      {
        signature: 'sig-a',
        blockTime: Date.parse('2026-07-23T10:00:30.000Z') / 1_000,
      },
      {
        signature: 'sig-b',
        blockTime: Date.parse('2026-07-23T10:01:30.000Z') / 1_000,
      },
    ]);
    const result = await runBulkReconcileSweep({
      apply: true,
      consent: 'operator',
      matchToleranceMs: 5 * 60_000,
      safetyMarginMs: 0,
      deps: h.deps,
    });
    expect(result.summary.manual).toBe(1);
    expect(result.summary.manualRowIds).toEqual(['agent_payments:ambiguous']);
    expect(h.calls.captures).toBe(0);
    expect(h.calls.noMoney).toBe(0);
    expect(h.states.get('ambiguous')).toBe('reconcile');
  });

  it('pairs equal overlapping components strictly in chronological order', async () => {
    const first = row('first', '2026-07-23T10:00:00.000Z');
    const second = row('second', '2026-07-23T10:02:00.000Z');
    const h = harness([second, first], [
      {
        signature: 'sig-second',
        blockTime: Date.parse('2026-07-23T10:02:30.000Z') / 1_000,
      },
      {
        signature: 'sig-first',
        blockTime: Date.parse('2026-07-23T10:00:30.000Z') / 1_000,
      },
    ]);
    const result = await runBulkReconcileSweep({
      matchToleranceMs: 5 * 60_000,
      safetyMarginMs: 0,
      deps: h.deps,
    });
    expect(result.verdicts.map((verdict) => [
      verdict.row.id,
      verdict.transfer?.signature,
    ])).toEqual([
      ['first', 'sig-first'],
      ['second', 'sig-second'],
    ]);
  });

  it('applies verified capture once and a rerun captures nothing', async () => {
    const candidate = row('idempotent', '2026-07-23T10:00:00.000Z');
    const h = harness([candidate], [{
      signature: 'sig-idempotent',
      blockTime: Date.parse('2026-07-23T10:01:00.000Z') / 1_000,
    }]);
    const first = await runBulkReconcileSweep({
      apply: true,
      consent: 'operator',
      matchToleranceMs: 5 * 60_000,
      safetyMarginMs: 0,
      deps: h.deps,
    });
    const second = await runBulkReconcileSweep({
      apply: true,
      consent: 'operator',
      matchToleranceMs: 5 * 60_000,
      safetyMarginMs: 0,
      deps: h.deps,
    });
    expect(first.summary.captured).toBe(1);
    expect(first.summary.capturedUsdCents).toBe(100);
    expect(second.summary.selected).toBe(0);
    expect(h.calls.captures).toBe(1);
    expect(h.calls.fulfill).toBe(1);
    expect(h.bound).toEqual(new Set(['sig-idempotent']));
  });

  it('closes an unmatched old row only after a complete window', async () => {
    const old = row('old', '2026-07-21T10:00:00.000Z');
    const h = harness([old], []);
    const result = await runBulkReconcileSweep({
      apply: true,
      consent: 'operator',
      safetyMarginMs: 0,
      matchToleranceMs: 0,
      deps: h.deps,
    });
    expect(result.summary.closedNoMoney).toBe(1);
    expect(h.states.get('old')).toBe('failed');
    expect(h.calls.noMoney).toBe(1);
  });

  it('never closes no-money when the signature cap exhausts before the boundary', async () => {
    const old = row('capped', '2026-07-21T10:00:00.000Z');
    const h = harness([old], [{
      signature: 'sig-wrong-amount',
      blockTime: Date.parse('2026-07-21T10:01:00.000Z') / 1_000,
      atomic: '999999',
    }]);
    const result = await runBulkReconcileSweep({
      apply: true,
      consent: 'operator',
      maxSignatures: 1,
      safetyMarginMs: 0,
      matchToleranceMs: 5 * 60_000,
      deps: h.deps,
    });
    expect(result.verdicts[0]?.bucket).toBe('indeterminate');
    expect(h.calls.noMoney).toBe(0);
    expect(h.states.get('capped')).toBe('reconcile');
  });

  it('backs off and retries an RPC 429 while paging the target once', async () => {
    const candidate = row('retry-429', '2026-07-23T10:00:00.000Z');
    const h = harness([candidate], [{
      signature: 'sig-retry',
      blockTime: Date.parse('2026-07-23T10:01:00.000Z') / 1_000,
    }]);
    const original = h.deps.chain!.getSignaturesForAddress;
    let attempts = 0;
    const sleeps: number[] = [];
    h.deps.chain!.getSignaturesForAddress = async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('RPC 429 rate limited'), { status: 429 });
      }
      return original(...args);
    };
    h.deps.sleep = async (ms) => { sleeps.push(ms); };
    const result = await runBulkReconcileSweep({
      rpcRetries: 2,
      rpcBackoffMs: 25,
      safetyMarginMs: 0,
      matchToleranceMs: 5 * 60_000,
      deps: h.deps,
    });
    expect(result.summary.matched).toBe(1);
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([25]);
    expect(h.calls.pages).toBe(1);
  });

  it('enforces the row cap and derives bounds from selected rows plus margins', async () => {
    const rows = [
      row('third', '2026-07-23T10:20:00.000Z'),
      row('first', '2026-07-23T10:00:00.000Z'),
      row('second', '2026-07-23T10:10:00.000Z'),
    ];
    const h = harness(rows, []);
    const result = await runBulkReconcileSweep({
      limit: 2,
      safetyMarginMs: 60_000,
      matchToleranceMs: 120_000,
      deps: h.deps,
    });
    expect(result.summary.selected).toBe(2);
    expect(result.verdicts.map((verdict) => verdict.row.id)).toEqual(['first', 'second']);
    expect(result.window).toEqual(deriveBulkReconcileWindow(
      [rows[1], rows[2]],
      60_000,
      120_000,
    ));
  });

  it('requires double consent for CLI apply and parses operational bounds', () => {
    expect(parseBulkReconcileCliArgs([
      '--limit', '25',
      '--safety-margin-ms', '60000',
      '--match-tolerance-ms', '120000',
      '--tx-concurrency', '4',
      '--max-signatures', '50000',
      '--before', 'newest-anchor',
      '--until', 'oldest-anchor',
    ])).toMatchObject({
      apply: false,
      limit: 25,
      safetyMarginMs: 60_000,
      matchToleranceMs: 120_000,
      txConcurrency: 4,
      maxSignatures: 50_000,
      before: 'newest-anchor',
      until: 'oldest-anchor',
    });
    delete process.env.RECONCILE_APPLY;
    expect(() => parseBulkReconcileCliArgs(['--apply'])).toThrow(/required/);
  });
});
