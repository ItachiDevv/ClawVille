import { beforeEach, describe, expect, it } from 'bun:test';
import type { AgentPayment } from '@clawville/database';
import type { PaymentRequirements } from '@x402/core/types';
import type { AgentPayDb, AgentPayDeps, AgentPayRecipient } from '../agent-pay';
import type {
  ExecutePreparedExactPaymentOutcome,
  PreparedCustodialExactPayment,
} from '../custodial-x402';

const {
  payAgent,
  resolveAgentPayDailySendUsdCents,
  resolveAgentPayDailyReceiveUsdCents,
} = await import('../agent-pay');

const SENDER = '11111111-1111-4111-8111-111111111111';
const SENDER_TWO = '33333333-3333-4333-8333-333333333333';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';
const SENDER_WALLET = '11111111111111111111111111111111';
const SENDER_TWO_WALLET = '33333333333333333333333333333333';
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
    signature: null,
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
  now?: Date;
} = {}) {
  const rows = new Map<string, AgentPayment>();
  let ids = 0;
  let executeCalls = 0;
  let mintCalls = 0;
  const mintBackings: unknown[] = [];
  let failFulfillment = options.failFirstFulfillment ?? false;
  let fulfillmentBarrier = Promise.resolve();

  function seedRow(overrides: Partial<AgentPayment> = {}): AgentPayment {
    const now = options.now ?? new Date();
    const row = {
      id: `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      senderAvatarId: SENDER,
      recipientAvatarId: RECIPIENT,
      recipientKind: 'avatar',
      recipientRef: RECIPIENT,
      senderWallet: SENDER_WALLET,
      recipientWallet: RECIPIENT_WALLET,
      usdCents: 100,
      usdcAtomic: '1000000',
      network: 'devnet',
      idempotencyKey: `seed-${ids}`,
      status: 'pending', settlingId: null, settlingStartedAt: null,
      txSignature: null, reconcileTxSignature: null, settlePayer: null,
      earnedVclaw: 0, earnedUsdBasis: null, earnedLedgerId: null,
      fulfilledAt: null, failureReason: null, createdAt: now, updatedAt: now,
      metadata: {},
      ...overrides,
    } as AgentPayment;
    rows.set(row.id, row);
    return row;
  }

  const db: AgentPayDb = {
    async findByIdempotency(sender, key) {
      return [...rows.values()].find(
        (r) => r.senderAvatarId === sender && r.idempotencyKey === key,
      ) ?? null;
    },
    async resolveRecipient(recipient: AgentPayRecipient) {
      if (recipient.kind === 'avatar'
        && [RECIPIENT, SENDER, SENDER_TWO].includes(recipient.avatarId)) {
        return { avatarId: recipient.avatarId };
      }
      return { error: 'not_found' };
    },
    async findAvatarWallet(avatarId) {
      if (avatarId === SENDER) return { publicKey: SENDER_WALLET };
      if (avatarId === SENDER_TWO) return { publicKey: SENDER_TWO_WALLET };
      if (avatarId === RECIPIENT) return { publicKey: RECIPIENT_WALLET };
      return null;
    },
    async admitPending(input, limits, dayStart) {
      const prior = [...rows.values()].find(
        (r) => r.senderAvatarId === input.senderAvatarId
          && r.idempotencyKey === input.idempotencyKey,
      );
      if (prior) return { kind: 'existing', row: prior };
      const counted = [...rows.values()].filter(
        (row) => row.status !== 'failed' && row.createdAt >= dayStart,
      );
      const sent = counted
        .filter((row) => row.senderAvatarId === input.senderAvatarId)
        .reduce((sum, row) => sum + row.usdCents, 0);
      const received = counted
        .filter((row) => row.recipientAvatarId === input.recipientAvatarId)
        .reduce((sum, row) => sum + row.usdCents, 0);
      if (sent > limits.sendUsdCents - input.usdCents) {
        return {
          kind: 'daily_cap_exceeded',
          cap: limits.sendUsdCents,
          usedTodayUsdCents: sent,
        };
      }
      if (received > limits.receiveUsdCents - input.usdCents) {
        return {
          kind: 'daily_cap_exceeded',
          cap: limits.receiveUsdCents,
          usedTodayUsdCents: received,
        };
      }
      return { kind: 'inserted', row: seedRow({ ...input, createdAt: options.now ?? new Date() }) };
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
          backing: {
            kind: 'none', mintRef: `agent-pay:${row.id}`,
            reason: 'recipient_received_usdc_directly',
          },
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
    loadSigningWallet: async (avatarId) => ({
      publicKey: avatarId === SENDER_TWO ? SENDER_TWO_WALLET : SENDER_WALLET,
      secretKey: new Uint8Array(64),
    }),
    prepare: async () => prepared,
    execute: async () => {
      executeCalls += 1;
      if (options.executeThrows) throw new Error('synthetic ambiguous transport failure');
      return options.outcome ?? settledOutcome();
    },
    mintEarned: async (input) => {
      mintCalls += 1;
      mintBackings.push(input.backing);
      return { ledgerId: `ledger-${mintCalls}`, balanceAfter: 0 };
    },
    resolveFeePayer: async () => '33333333333333333333333333333333',
    resolveRail: () => ({ network: 'devnet', rpcUrl: 'http://rpc.test', allowed: true }),
    randomId: () => `00000000-0000-4000-9000-${String(ids).padStart(12, '0')}`,
    now: () => options.now ?? new Date(),
  };
  return {
    deps,
    rows,
    executeCalls: () => executeCalls,
    mintCalls: () => mintCalls,
    mintBackings,
    seedRow,
  };
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
    delete process.env.AGENT_PAY_DAILY_SEND_USD_CENTS;
    delete process.env.AGENT_PAY_DAILY_RECEIVE_USD_CENTS;
  });

  it('settles, mints full-basis EARNED once, and replays without a second settle/mint', async () => {
    const h = harness();
    const first = await payAgent(request(), h.deps);
    const replay = await payAgent(request(), h.deps);
    expect(first).toMatchObject({ ok: true, replay: false, earnedVclaw: 100 });
    expect(replay).toMatchObject({ ok: true, replay: true, earnedVclaw: 100 });
    expect(h.executeCalls()).toBe(1);
    expect(h.mintCalls()).toBe(1);
    expect(h.mintBackings).toEqual([{
      kind: 'none',
      mintRef: `agent-pay:${[...h.rows.values()][0]!.id}`,
      reason: 'recipient_received_usdc_directly',
    }]);
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

  it('strictly parses daily-cap env values with defaults and a 100-cent floor', () => {
    expect(resolveAgentPayDailySendUsdCents()).toBe(2_000);
    expect(resolveAgentPayDailyReceiveUsdCents()).toBe(2_000);

    process.env.AGENT_PAY_DAILY_SEND_USD_CENTS = '2000suffix';
    process.env.AGENT_PAY_DAILY_RECEIVE_USD_CENTS = '99';
    expect(resolveAgentPayDailySendUsdCents()).toBe(2_000);
    expect(resolveAgentPayDailyReceiveUsdCents()).toBe(2_000);

    process.env.AGENT_PAY_DAILY_SEND_USD_CENTS = '2500';
    process.env.AGENT_PAY_DAILY_RECEIVE_USD_CENTS = '100';
    expect(resolveAgentPayDailySendUsdCents()).toBe(2_500);
    expect(resolveAgentPayDailyReceiveUsdCents()).toBe(100);
  });

  it('admits a payment whose cumulative sender and recipient usage equals each cap', async () => {
    process.env.AGENT_PAY_DAILY_SEND_USD_CENTS = '200';
    process.env.AGENT_PAY_DAILY_RECEIVE_USD_CENTS = '200';
    const h = harness({ now: new Date('2026-07-21T12:00:00.000Z') });
    h.seedRow({ usdCents: 100, idempotencyKey: 'prior-equality' });

    const result = await payAgent(request({ idempotencyKey: 'at-equality' }), h.deps);

    expect(result).toMatchObject({ ok: true, usdCents: 100 });
    expect([...h.rows.values()].reduce((sum, row) => sum + row.usdCents, 0)).toBe(200);
  });

  it('blocks a sender already at cap before creating a pending row', async () => {
    const h = harness({ now: new Date('2026-07-21T12:00:00.000Z') });
    h.seedRow({ usdCents: 2_000, idempotencyKey: 'sender-at-cap' });

    const result = await payAgent(request({ usdCents: 1, idempotencyKey: 'blocked-sender' }), h.deps);

    expect(result).toEqual({
      ok: false,
      code: 'daily_cap_exceeded',
      detail: { cap: 2_000, usedTodayUsdCents: 2_000 },
    });
    expect(h.rows.size).toBe(1);
    expect(h.executeCalls()).toBe(0);
  });

  it('blocks the recipient cap independently of unused sender capacity', async () => {
    const h = harness({ now: new Date('2026-07-21T12:00:00.000Z') });
    h.seedRow({
      senderAvatarId: SENDER_TWO,
      senderWallet: SENDER_TWO_WALLET,
      usdCents: 1_950,
      idempotencyKey: 'recipient-prior',
    });

    const result = await payAgent(request({ usdCents: 51, idempotencyKey: 'blocked-recipient' }), h.deps);

    expect(result).toEqual({
      ok: false,
      code: 'daily_cap_exceeded',
      detail: { cap: 2_000, usedTodayUsdCents: 1_950 },
    });
    expect(h.rows.size).toBe(1);
    expect(h.executeCalls()).toBe(0);
  });

  it('excludes failed payments from daily usage', async () => {
    const h = harness({ now: new Date('2026-07-21T12:00:00.000Z') });
    h.seedRow({
      status: 'failed',
      failureReason: 'definitive_failure',
      usdCents: 2_000,
      idempotencyKey: 'failed-prior',
    });

    const result = await payAgent(request({ idempotencyKey: 'after-failure' }), h.deps);

    expect(result).toMatchObject({ ok: true, usdCents: 100 });
    expect(h.rows.size).toBe(2);
  });

  it('does not count payments created before the current UTC day', async () => {
    const h = harness({ now: new Date('2026-07-21T00:00:01.000Z') });
    h.seedRow({
      usdCents: 2_000,
      createdAt: new Date('2026-07-20T23:59:59.999Z'),
      idempotencyKey: 'yesterday',
    });

    const result = await payAgent(request({ idempotencyKey: 'today' }), h.deps);

    expect(result).toMatchObject({ ok: true, usdCents: 100 });
  });

  it('serializes distinct senders near one recipient cap and admits at most the cap', async () => {
    process.env.AGENT_PAY_DAILY_RECEIVE_USD_CENTS = '100';
    const h = harness({ balance: 0n, now: new Date('2026-07-21T12:00:00.000Z') });

    const results = await Promise.all([
      payAgent(request({ usdCents: 60, idempotencyKey: 'race-one' }), h.deps),
      payAgent(request({
        senderAvatarId: SENDER_TWO,
        usdCents: 60,
        idempotencyKey: 'race-two',
      }), h.deps),
    ]);

    const admitted = [...h.rows.values()].filter(
      (row) => row.recipientAvatarId === RECIPIENT && row.status !== 'failed',
    );
    expect(admitted.reduce((sum, row) => sum + row.usdCents, 0)).toBeLessThanOrEqual(100);
    expect(admitted).toHaveLength(1);
    expect(results.filter(
      (result) => !result.ok && result.code === 'daily_cap_exceeded',
    )).toHaveLength(1);
    expect(h.executeCalls()).toBe(0);
  });
});
