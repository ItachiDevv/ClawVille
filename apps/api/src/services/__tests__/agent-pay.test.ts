import { beforeEach, describe, expect, it } from 'bun:test';
import type { AgentPayment } from '@clawville/database';
import type { PaymentRequirements } from '@x402/core/types';
import type { AgentPayDb, AgentPayDeps, AgentPayRecipient } from '../agent-pay';
import type {
  ExecutePreparedExactPaymentOutcome,
  PreparedCustodialExactPayment,
} from '../custodial-x402';

const { payAgent } = await import('../agent-pay');

const SENDER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';
const SENDER_WALLET = '11111111111111111111111111111111';
const RECIPIENT_WALLET = '22222222222222222222222222222222';
const TX = 'tx-agent-pay-1';

function requirement(): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    amount: '1000000',
    asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    payTo: RECIPIENT_WALLET,
    maxTimeoutSeconds: 120,
    extra: { feePayer: '33333333333333333333333333333333' },
  };
}

function settledOutcome(signature = TX): ExecutePreparedExactPaymentOutcome {
  return {
    kind: 'settled',
    signature,
    payer: SENDER_WALLET,
    result: {
      settled: true,
      isValid: true,
      txSignature: signature,
      network: requirement().network,
      payer: SENDER_WALLET,
      failureReason: null,
      raw: {},
    },
  };
}

function failedOutcome(): ExecutePreparedExactPaymentOutcome {
  return {
    kind: 'definitive_failure',
    stage: 'verify',
    verifyPassed: false,
    reason: 'insufficient_funds',
    payer: SENDER_WALLET,
    result: {
      settled: false, isValid: false, txSignature: null, network: null,
      payer: SENDER_WALLET, failureReason: 'insufficient_funds', raw: {},
    },
  };
}

function ambiguousOutcome(): ExecutePreparedExactPaymentOutcome {
  return {
    kind: 'ambiguous',
    verifyPassed: true,
    reason: 'facilitator_settle_error',
    payer: SENDER_WALLET,
    result: {
      settled: false, isValid: true, txSignature: null, network: null,
      payer: SENDER_WALLET, failureReason: 'facilitator_settle_error', raw: {},
    },
  };
}

function harness(options: {
  balance?: bigint;
  outcome?: ExecutePreparedExactPaymentOutcome;
  failFirstFulfillment?: boolean;
  executeThrows?: boolean;
  captureReturnsLostAfterWriting?: boolean;
} = {}) {
  const rows = new Map<string, AgentPayment>();
  let ids = 0;
  let executeCalls = 0;
  let mintCalls = 0;
  let failFulfillment = options.failFirstFulfillment ?? false;
  let fulfillmentBarrier = Promise.resolve();

  const db: AgentPayDb = {
    async findByIdempotency(sender, key) {
      return [...rows.values()].find(
        (r) => r.senderAvatarId === sender && r.idempotencyKey === key,
      ) ?? null;
    },
    async resolveRecipient(recipient: AgentPayRecipient) {
      if (recipient.kind === 'avatar'
        && (recipient.avatarId === RECIPIENT || recipient.avatarId === SENDER)) {
        return { avatarId: recipient.avatarId };
      }
      return { error: 'not_found' };
    },
    async findAvatarWallet(avatarId) {
      if (avatarId === SENDER) return { publicKey: SENDER_WALLET };
      if (avatarId === RECIPIENT) return { publicKey: RECIPIENT_WALLET };
      return null;
    },
    async insertPending(input) {
      const prior = [...rows.values()].find(
        (r) => r.senderAvatarId === input.senderAvatarId
          && r.idempotencyKey === input.idempotencyKey,
      );
      if (prior) return null;
      const now = new Date();
      const row = {
        id: `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
        status: 'pending', settlingId: null, settlingStartedAt: null,
        txSignature: null, reconcileTxSignature: null, settlePayer: null,
        earnedVclaw: 0, earnedUsdBasis: null, earnedLedgerId: null,
        fulfilledAt: null, failureReason: null, createdAt: now, updatedAt: now,
        metadata: {},
        ...input,
      } as AgentPayment;
      rows.set(row.id, row);
      return row;
    },
    async getById(id) { return rows.get(id) ?? null; },
    async claimPending(id, settlingId) {
      const row = rows.get(id);
      if (!row || row.status !== 'pending') return null;
      Object.assign(row, { status: 'settling', settlingId, settlingStartedAt: new Date() });
      return row;
    },
    async captureSettled(id, settlingId, signature, payer) {
      const row = rows.get(id);
      if (!row || row.status !== 'settling' || row.settlingId !== settlingId) return 'lost';
      if ([...rows.values()].some((r) => r.id !== id && r.txSignature === signature)) {
        return 'signature_conflict';
      }
      Object.assign(row, { txSignature: signature, settlePayer: payer });
      if (options.captureReturnsLostAfterWriting) return 'lost';
      return 'captured';
    },
    async markFailed(id, settlingId, reason) {
      const row = rows.get(id);
      if (row?.settlingId === settlingId) Object.assign(row, { status: 'failed', failureReason: reason, settlingId: null });
    },
    async markReconcile(id, settlingId, reason, signature = null) {
      const row = rows.get(id);
      if (row && (!settlingId || row.settlingId === settlingId)) {
        Object.assign(row, {
          status: 'reconcile', failureReason: reason, reconcileTxSignature: signature,
          settlingId: null,
        });
      }
    },
    async fulfillCaptured(id, mint) {
      // Mirror production's pg_advisory_xact_lock so duplicate fulfillers see
      // the first committed row and cannot both invoke the mint callback.
      const previous = fulfillmentBarrier;
      let release!: () => void;
      fulfillmentBarrier = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const row = rows.get(id);
        if (!row || (row.status !== 'settling' && row.status !== 'settled')) return { kind: 'not_ready' };
        if (row.status === 'settled') return { kind: 'replay', row };
        if (!row.txSignature) return { kind: 'not_ready' };
        if (failFulfillment) {
          failFulfillment = false;
          throw new Error('synthetic transaction rollback');
        }
        const minted = await mint({
          avatarId: row.recipientAvatarId, amount: row.usdCents,
          reason: 'agent_payai_settlement', source: 'x402',
          usdBasis: (row.usdCents / 100).toFixed(6),
        });
        Object.assign(row, {
          status: 'settled', earnedVclaw: row.usdCents,
          earnedUsdBasis: (row.usdCents / 100).toFixed(6),
          earnedLedgerId: minted.ledgerId, fulfilledAt: new Date(), settlingId: null,
        });
        return { kind: 'settled', row };
      } finally {
        release();
      }
    },
  };

  const prepared: PreparedCustodialExactPayment = {
    paymentHeader: 'header', requirements: requirement(), payerPubkey: SENDER_WALLET,
    feePayer: '33333333333333333333333333333333', network: 'devnet',
  };
  const deps: AgentPayDeps = {
    db,
    readUsdcBalance: async () => options.balance ?? 10_000_000n,
    loadSigningWallet: async () => ({ publicKey: SENDER_WALLET, secretKey: new Uint8Array(64) }),
    prepare: async () => prepared,
    execute: async () => {
      executeCalls += 1;
      if (options.executeThrows) throw new Error('synthetic ambiguous transport failure');
      return options.outcome ?? settledOutcome();
    },
    mintEarned: async () => {
      mintCalls += 1;
      return { ledgerId: `ledger-${mintCalls}`, balanceAfter: 0 };
    },
    resolveFeePayer: async () => '33333333333333333333333333333333',
    resolveRail: () => ({ network: 'devnet', rpcUrl: 'http://rpc.test', allowed: true }),
    randomId: () => `00000000-0000-4000-9000-${String(ids).padStart(12, '0')}`,
  };
  return { deps, rows, executeCalls: () => executeCalls, mintCalls: () => mintCalls };
}

const request = (overrides: Partial<Parameters<typeof payAgent>[0]> = {}) => ({
  senderAvatarId: SENDER,
  recipient: { kind: 'avatar', avatarId: RECIPIENT } as const,
  usdCents: 100,
  idempotencyKey: 'pay-1',
  ...overrides,
});

describe('agent-pay durable x402 machine', () => {
  beforeEach(() => {
    delete process.env.AGENT_PAY_MAX_USD_CENTS;
    delete process.env.AGENT_PAY_STALE_MS;
  });

  it('settles, mints full-basis EARNED once, and replays without a second settle/mint', async () => {
    const h = harness();
    const first = await payAgent(request(), h.deps);
    const replay = await payAgent(request(), h.deps);
    expect(first).toMatchObject({ ok: true, replay: false, earnedVclaw: 100 });
    expect(replay).toMatchObject({ ok: true, replay: true, earnedVclaw: 100 });
    expect(h.executeCalls()).toBe(1);
    expect(h.mintCalls()).toBe(1);
    expect([...h.rows.values()][0]).toMatchObject({ usdCents: 100, earnedUsdBasis: '1.000000' });
  });

  it('same idempotency key with a different payload conflicts', async () => {
    const h = harness();
    await payAgent(request(), h.deps);
    const conflict = await payAgent(request({ usdCents: 200 }), h.deps);
    expect(conflict).toMatchObject({ ok: false, code: 'idempotency_conflict' });
    expect(h.executeCalls()).toBe(1);
  });

  it('concurrent duplicate calls take one CAS claim and settle/mint once', async () => {
    const h = harness();
    const results = await Promise.all([payAgent(request(), h.deps), payAgent(request(), h.deps)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(h.executeCalls()).toBe(1);
    expect(h.mintCalls()).toBe(1);
  });

  it('re-reads a lost capture and fulfills an already-captured signature', async () => {
    const h = harness({ captureReturnsLostAfterWriting: true });
    const result = await payAgent(request(), h.deps);
    expect(result).toMatchObject({ ok: true, earnedVclaw: 100 });
    expect(h.executeCalls()).toBe(1);
    expect(h.mintCalls()).toBe(1);
  });

  it('refuses insufficient USDC before facilitator execution', async () => {
    const h = harness({ balance: 999_999n });
    const result = await payAgent(request(), h.deps);
    expect(result).toMatchObject({ ok: false, code: 'insufficient_usdc', status: 'pending' });
    expect(h.executeCalls()).toBe(0);
    expect(h.mintCalls()).toBe(0);
  });

  it('definitive facilitator failure becomes failed and mints nothing', async () => {
    const h = harness({ outcome: failedOutcome() });
    const result = await payAgent(request(), h.deps);
    expect(result).toMatchObject({ ok: false, code: 'payment_failed', status: 'failed' });
    expect(h.mintCalls()).toBe(0);
  });

  it('ambiguous settle becomes reconcile and mints nothing', async () => {
    const h = harness({ outcome: ambiguousOutcome() });
    const result = await payAgent(request(), h.deps);
    expect(result).toMatchObject({ ok: false, code: 'payment_reconcile', status: 'reconcile' });
    expect(h.mintCalls()).toBe(0);
  });

  it('a thrown post-claim facilitator call becomes reconcile and never retries', async () => {
    const h = harness({ executeThrows: true });
    const first = await payAgent(request(), h.deps);
    const replay = await payAgent(request(), h.deps);
    expect(first).toMatchObject({ ok: false, code: 'payment_reconcile', status: 'reconcile' });
    expect(replay).toMatchObject({ ok: false, code: 'payment_reconcile', status: 'reconcile' });
    expect(h.executeCalls()).toBe(1);
    expect(h.mintCalls()).toBe(0);
  });

  it('enforces one-cent minimum and configured maximum', async () => {
    const h = harness();
    expect(await payAgent(request({ usdCents: 0 }), h.deps)).toMatchObject({ code: 'amount_below_min' });
    process.env.AGENT_PAY_MAX_USD_CENTS = '10';
    expect(await payAgent(request({ usdCents: 11, idempotencyKey: 'over' }), h.deps)).toMatchObject({ code: 'amount_above_max' });
    expect(h.executeCalls()).toBe(0);
  });

  it('settles the one-cent minimum and mints one EARNED vCLAW', async () => {
    const h = harness();
    const result = await payAgent(request({ usdCents: 1, idempotencyKey: 'one-cent' }), h.deps);
    expect(result).toMatchObject({ ok: true, earnedVclaw: 1 });
    expect([...h.rows.values()][0]).toMatchObject({ usdCents: 1, earnedUsdBasis: '0.010000' });
  });

  it('refuses self-payment before looking up the wallet', async () => {
    const h = harness();
    const result = await payAgent(request({
      recipient: { kind: 'avatar', avatarId: SENDER },
      idempotencyKey: 'self-pay',
    }), h.deps);
    expect(result).toMatchObject({ ok: false, code: 'self_pay_forbidden' });
    expect(h.executeCalls()).toBe(0);
    expect(h.mintCalls()).toBe(0);
  });

  it('resumes captured fulfillment without calling the facilitator again', async () => {
    const h = harness({ failFirstFulfillment: true });
    const first = await payAgent(request(), h.deps);
    const resumed = await payAgent(request(), h.deps);
    expect(first).toMatchObject({ ok: false, code: 'fulfillment_pending', status: 'settling' });
    expect(resumed).toMatchObject({ ok: true, earnedVclaw: 100 });
    expect(h.executeCalls()).toBe(1);
    expect(h.mintCalls()).toBe(1);
  });
});
