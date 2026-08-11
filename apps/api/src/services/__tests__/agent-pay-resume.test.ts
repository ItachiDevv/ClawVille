import { afterEach, describe, expect, it } from 'bun:test';
import type { AgentPayment } from '@clawville/database';
import type { AlertErrorParams } from '../alert-error';
import type { AgentPayResult } from '../agent-pay';
import {
  isAgentPayResumeWorkerRunning,
  resolveAgentPayResumePollMs,
  runAgentPayResumeTick,
  runAgentPayResumeWorkerPass,
  startAgentPayResumeWorker,
  stopAgentPayResumeWorker,
  type AgentPayChainTransaction,
  type AgentPayResumeDb,
  type AgentPayResumeDeps,
} from '../agent-pay-resume';

const NOW = new Date('2026-07-21T12:00:00.000Z').getTime();
const SENDER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';

let nextId = 0;
function payment(overrides: Partial<AgentPayment> = {}): AgentPayment {
  const now = new Date(NOW);
  return {
    id: `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    senderAvatarId: SENDER,
    recipientAvatarId: RECIPIENT,
    recipientKind: 'avatar',
    recipientRef: RECIPIENT,
    senderWallet: '11111111111111111111111111111111',
    recipientWallet: '22222222222222222222222222222222',
    usdCents: 1,
    usdcAtomic: '10000',
    status: 'settling',
    idempotencyKey: `resume-${nextId}`,
    bountyHoldId: null,
    settlingId: `00000000-0000-4000-9000-${String(nextId).padStart(12, '0')}`,
    settlingStartedAt: new Date(NOW - 180_001),
    txSignature: null,
    reconcileTxSignature: null,
    settlePayer: null,
    facilitator: null,
    grossUsdcAtomic: null,
    platformFeeUsdcAtomic: null,
    treasuryFeeUsdcAtomic: null,
    netUsdcAtomic: null,
    network: 'devnet',
    earnedVclaw: 0,
    earnedUsdBasis: null,
    earnedLedgerId: null,
    fulfilledAt: null,
    failureReason: null,
    capExempt: null,
    countCapExempt: false,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface HarnessOptions {
  transaction?: (
    signature: string,
  ) => Promise<AgentPayChainTransaction | null>;
  alertThrows?: boolean;
  expireThrows?: boolean;
}

function harness(seed: AgentPayment[], options: HarnessOptions = {}) {
  const rows = new Map(seed.map((row) => [row.id, row]));
  const markCalls: Array<{ id: string; reason: string; signature: string | null }> = [];
  const alerts: AlertErrorParams[] = [];
  const transactionCalls: string[] = [];
  const fulfillCalls: string[] = [];
  const pendingScanEvents: Array<'expire' | 'count'> = [];
  const expireCutoffs: Date[] = [];
  const countCutoffs: Date[] = [];
  let mintCalls = 0;

  const resumeDb: AgentPayResumeDb = {
    async listSettlingBefore(cutoff) {
      return [...rows.values()].filter((row) =>
        row.status === 'settling'
        && row.settlingStartedAt !== null
        && new Date(row.settlingStartedAt).getTime() < cutoff.getTime());
    },
    async expireStalePending(cutoff) {
      pendingScanEvents.push('expire');
      expireCutoffs.push(cutoff);
      if (options.expireThrows) throw new Error('synthetic pending expiry outage');
      const expired = [...rows.values()].filter((row) =>
        row.status === 'pending'
        && row.countCapExempt === false
        && new Date(row.createdAt).getTime() < cutoff.getTime()
        && row.txSignature === null
        && row.settlePayer === null
        && row.settlingStartedAt === null
        && row.reconcileTxSignature === null);
      const reconciledAt = new Date(NOW);
      for (const row of expired) {
        Object.assign(row, {
          status: 'failed',
          failureReason: 'stale_pending_expired',
          settlingId: null,
          settlingStartedAt: null,
          updatedAt: reconciledAt,
          metadata: {
            ...row.metadata,
            reconcileResolution: 'no_money',
            failureReason: 'stale_pending_expired',
            reconciledAt: reconciledAt.toISOString(),
            terminalClosedBy: 'agent-pay-resume-auto-expiry',
          },
        });
      }
      return expired.length;
    },
    async countPendingBefore(cutoff) {
      pendingScanEvents.push('count');
      countCutoffs.push(cutoff);
      return [...rows.values()].filter((row) =>
        row.status === 'pending'
        && new Date(row.createdAt).getTime() < cutoff.getTime()).length;
    },
    async markReconcile(
      id,
      settlingId,
      reason,
      observedSignature = null,
      expectedTxSignature,
    ) {
      const row = rows.get(id);
      if (!row || row.status !== 'settling') return false;
      if (settlingId && row.settlingId !== settlingId) return false;
      if (expectedTxSignature !== undefined && row.txSignature !== expectedTxSignature) return false;
      Object.assign(row, {
        status: 'reconcile',
        failureReason: reason,
        reconcileTxSignature: observedSignature,
        settlingId: null,
        settlingStartedAt: null,
      });
      markCalls.push({ id, reason, signature: observedSignature });
      return true;
    },
  };

  const success = (row: AgentPayment, replay: boolean): AgentPayResult => ({
    ok: true,
    paymentId: row.id,
    status: 'settled',
    replay,
    txSignature: row.txSignature!,
    senderAvatarId: row.senderAvatarId,
    recipientAvatarId: row.recipientAvatarId,
    usdCents: row.usdCents,
    earnedVclaw: row.usdCents,
    earnedLedgerId: row.earnedLedgerId!,
  });

  const deps: AgentPayResumeDeps = {
    db: resumeDb,
    now: () => NOW,
    resolveStaleMs: () => 180_000,
    resolveRail: () => ({ network: 'devnet', rpcUrl: 'http://rpc.test', allowed: true }),
    getTransaction: async (_rpcUrl, signature) => {
      transactionCalls.push(signature);
      return options.transaction?.(signature) ?? { meta: { err: null } };
    },
    fulfill: async (id) => {
      fulfillCalls.push(id);
      const row = rows.get(id);
      if (!row || (row.status !== 'settling' && row.status !== 'settled')) {
        return { ok: false, code: 'fulfillment_pending', paymentId: id, status: 'settling' };
      }
      if (row.status === 'settled') return success(row, true);
      if (!row.txSignature) {
        return { ok: false, code: 'fulfillment_pending', paymentId: id, status: 'settling' };
      }
      mintCalls += 1;
      Object.assign(row, {
        status: 'settled',
        earnedVclaw: row.usdCents,
        earnedUsdBasis: (row.usdCents / 100).toFixed(6),
        earnedLedgerId: `00000000-0000-4000-a000-${String(mintCalls).padStart(12, '0')}`,
        fulfilledAt: new Date(NOW),
        settlingId: null,
        settlingStartedAt: null,
      });
      return success(row, false);
    },
    alert: async (params) => {
      alerts.push(params);
      if (options.alertThrows) throw new Error('synthetic alert outage');
    },
    logError: () => {},
    resumeTier1: async () => 0,
  };

  return {
    rows,
    deps,
    resumeDb,
    markCalls,
    alerts,
    transactionCalls,
    fulfillCalls,
    pendingScanEvents,
    expireCutoffs,
    countCutoffs,
    mintCalls: () => mintCalls,
  };
}

afterEach(() => {
  stopAgentPayResumeWorker();
  delete process.env.AGENT_PAY_RESUME_POLL_MS;
  delete process.env.X402_AUTO_RECONCILE;
});

describe('agent-pay resume worker', () => {
  it('fulfills a landed captured payment exactly once across two ticks', async () => {
    const row = payment({ txSignature: 'landed-success' });
    const h = harness([row]);

    const first = await runAgentPayResumeTick(h.deps);
    const second = await runAgentPayResumeTick(h.deps);

    expect(first).toMatchObject({ scanned: 1, fulfilled: 1, reconciled: 0, failed: 0 });
    expect(second).toMatchObject({ scanned: 0, fulfilled: 0, reconciled: 0, failed: 0 });
    expect(h.fulfillCalls).toEqual([row.id]);
    expect(h.transactionCalls).toEqual(['landed-success']);
    expect(h.mintCalls()).toBe(1);
    expect(h.markCalls).toEqual([]);
    expect(h.rows.get(row.id)?.status).toBe('settled');
  });

  it('moves a stale captured on-chain error to reconcile without minting', async () => {
    const row = payment({ txSignature: 'landed-error' });
    const h = harness([row], { transaction: async () => ({ meta: { err: { InstructionError: [0, 'Custom'] } } }) });

    const result = await runAgentPayResumeTick(h.deps);

    expect(result).toMatchObject({ scanned: 1, fulfilled: 0, reconciled: 1, failed: 0 });
    expect(h.markCalls).toEqual([{ id: row.id, reason: 'onchain_err', signature: 'landed-error' }]);
    expect(h.fulfillCalls).toEqual([]);
    expect(h.mintCalls()).toBe(0);
    expect(h.alerts[0]).toMatchObject({ severity: 'warning', source: 'agent-pay-resume' });
  });

  it('moves a stale payment with no captured signature to reconcile', async () => {
    const row = payment();
    const h = harness([row]);

    const result = await runAgentPayResumeTick(h.deps);

    expect(result).toMatchObject({ scanned: 1, reconciled: 1, failed: 0 });
    expect(h.markCalls).toEqual([{ id: row.id, reason: 'stale_settling', signature: null }]);
    expect(h.transactionCalls).toEqual([]);
    expect(h.fulfillCalls).toEqual([]);
    expect(h.mintCalls()).toBe(0);
  });

  it('lets auto-reconcile own fresh stale alerts while preserving the >24h survivor alert', async () => {
    process.env.X402_AUTO_RECONCILE = 'true';
    const fresh = payment();
    const old = payment({
      createdAt: new Date(NOW - 24 * 60 * 60 * 1_000 - 1),
      settlingStartedAt: new Date(NOW - 24 * 60 * 60 * 1_000 - 1),
    });
    const h = harness([fresh, old]);

    const result = await runAgentPayResumeTick(h.deps);

    expect(result.reconciled).toBe(2);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({
      severity: 'warning',
      source: 'agent-pay-resume',
      context: { paymentId: old.id, reason: 'stale_settling' },
    });
  });

  it('re-asserts the expected signature at the reconcile mutation boundary', async () => {
    const row = payment();
    const h = harness([row]);
    const racingDb: AgentPayResumeDb = {
      ...h.resumeDb,
      async markReconcile(id, settlingId, reason, observedSignature, expectedTxSignature) {
        // Simulate capture winning after the scan but before the UPDATE reaches
        // Postgres. The expected-null condition must preserve the captured row.
        h.rows.get(id)!.txSignature = 'captured-by-live-settle';
        return h.resumeDb.markReconcile(
          id,
          settlingId,
          reason,
          observedSignature,
          expectedTxSignature,
        );
      },
    };

    await runAgentPayResumeTick({ ...h.deps, db: racingDb });

    expect(h.rows.get(row.id)).toMatchObject({
      status: 'settling',
      txSignature: 'captured-by-live-settle',
    });
    expect(h.markCalls).toEqual([]);
  });

  it('uses strict 120-second candidate and stale-threshold boundaries', async () => {
    const exactlyCandidateAge = payment({ settlingStartedAt: new Date(NOW - 120_000) });
    const exactlyStaleAge = payment({ settlingStartedAt: new Date(NOW - 180_000) });
    const olderThanStale = payment({ settlingStartedAt: new Date(NOW - 180_001) });
    const h = harness([exactlyCandidateAge, exactlyStaleAge, olderThanStale]);

    const result = await runAgentPayResumeTick(h.deps);

    expect(result).toMatchObject({ scanned: 2, reconciled: 1, failed: 0 });
    expect(h.markCalls.map((call) => call.id)).toEqual([olderThanStale.id]);
    expect(h.rows.get(exactlyCandidateAge.id)?.status).toBe('settling');
    expect(h.rows.get(exactlyStaleAge.id)?.status).toBe('settling');
  });

  it('treats a stale missing or metadata-less transaction as stale_settling', async () => {
    const missing = payment({ txSignature: 'missing' });
    const metadataLess = payment({ txSignature: 'metadata-less' });
    const h = harness([missing, metadataLess], {
      transaction: async (signature) => signature === 'missing' ? null : { meta: null },
    });

    const result = await runAgentPayResumeTick(h.deps);

    expect(result).toMatchObject({ scanned: 2, reconciled: 2, failed: 0 });
    expect(h.markCalls.map((call) => call.reason)).toEqual([
      'stale_settling',
      'stale_settling',
    ]);
    expect(h.mintCalls()).toBe(0);
  });

  it('survives one row throwing and continues to the next row', async () => {
    const broken = payment({ txSignature: 'rpc-throws' });
    const recoverable = payment();
    const h = harness([broken, recoverable], {
      transaction: async () => { throw new Error('synthetic RPC outage'); },
    });

    const result = await runAgentPayResumeTick(h.deps);

    expect(result).toMatchObject({ scanned: 2, reconciled: 1, failed: 1 });
    expect(h.rows.get(broken.id)?.status).toBe('settling');
    expect(h.rows.get(recoverable.id)?.status).toBe('reconcile');
    expect(h.markCalls.map((call) => call.id)).toEqual([recoverable.id]);
  });

  it('expires dead pending rows before counting and only pages signed survivors', async () => {
    const deadPending = payment({
      status: 'pending', settlingId: null, settlingStartedAt: null,
      createdAt: new Date(NOW - 24 * 60 * 60 * 1_000 - 1),
      metadata: { existing: 'preserved' },
    });
    const signedSurvivor = payment({
      status: 'pending', settlingId: null, settlingStartedAt: null,
      createdAt: new Date(NOW - 24 * 60 * 60 * 1_000 - 2),
      txSignature: 'ambiguous-pending-signature',
    });
    const h = harness([deadPending, signedSurvivor]);

    const result = await runAgentPayResumeTick(h.deps);

    const expectedCutoff = NOW - 24 * 60 * 60 * 1_000;
    expect(h.pendingScanEvents).toEqual(['expire', 'count']);
    expect(h.expireCutoffs.map((cutoff) => cutoff.getTime())).toEqual([expectedCutoff]);
    expect(h.countCutoffs.map((cutoff) => cutoff.getTime())).toEqual([expectedCutoff]);
    expect(result).toMatchObject({
      scanned: 0,
      reconciled: 0,
      failed: 0,
      stalePendingExpired: 1,
      stalePending: 1,
    });
    expect(h.markCalls).toEqual([]);
    expect(h.fulfillCalls).toEqual([]);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({
      severity: 'warning',
      source: 'agent-pay-resume',
      message: 'Agent payments have remained pending for more than 24 hours',
      context: { pendingCount: 1 },
    });
    expect(h.rows.get(deadPending.id)).toMatchObject({
      status: 'failed',
      failureReason: 'stale_pending_expired',
      settlingId: null,
      settlingStartedAt: null,
      metadata: {
        existing: 'preserved',
        reconcileResolution: 'no_money',
        failureReason: 'stale_pending_expired',
        reconciledAt: new Date(NOW).toISOString(),
        terminalClosedBy: 'agent-pay-resume-auto-expiry',
      },
    });
    expect(h.rows.get(signedSurvivor.id)).toMatchObject({
      status: 'pending',
      txSignature: 'ambiguous-pending-signature',
    });
  });

  it('keeps Tier-1 settlement payments retryable past the generic pending expiry', async () => {
    const tier1Pending = payment({
      status: 'pending', settlingId: null, settlingStartedAt: null,
      countCapExempt: true,
      createdAt: new Date(NOW - 24 * 60 * 60 * 1_000 - 1),
      metadata: { reason: 'platform-mediated-bounty-settlement' },
    });
    const h = harness([tier1Pending]);

    const result = await runAgentPayResumeTick(h.deps);

    expect(result).toMatchObject({ stalePendingExpired: 0, stalePending: 1 });
    expect(h.rows.get(tier1Pending.id)).toMatchObject({
      status: 'pending',
      countCapExempt: true,
    });
  });

  it('continues to count and alert survivors when pending expiry throws', async () => {
    const signedSurvivor = payment({
      status: 'pending', settlingId: null, settlingStartedAt: null,
      createdAt: new Date(NOW - 24 * 60 * 60 * 1_000 - 1),
      txSignature: 'signed-survivor-during-expiry-outage',
    });
    const h = harness([signedSurvivor], { expireThrows: true });

    const result = await runAgentPayResumeTick(h.deps);

    expect(h.pendingScanEvents).toEqual(['expire', 'count']);
    expect(result).toMatchObject({
      failed: 1,
      stalePendingExpired: 0,
      stalePending: 1,
    });
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ context: { pendingCount: 1 } });
    expect(h.rows.get(signedSurvivor.id)?.status).toBe('pending');
  });

  it('pages a steady stale-pending backlog once, re-paging only when the count changes', async () => {
    const oldPending = payment({
      status: 'pending', settlingId: null, settlingStartedAt: null,
      createdAt: new Date(NOW - 24 * 60 * 60 * 1_000 - 1),
      txSignature: 'steady-ambiguous-pending-signature',
    });
    const h = harness([oldPending]);

    const first = await runAgentPayResumeTick(h.deps);
    const second = await runAgentPayResumeTick(h.deps);
    expect(first.stalePending).toBe(1);
    expect(second.stalePending).toBe(1);
    // Same count on the second pass is deduped — one page for a steady backlog.
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ context: { pendingCount: 1 } });
  });

  it('always resolves when both DB scans throw', async () => {
    const h = harness([]);
    const throwingDb: AgentPayResumeDb = {
      ...h.resumeDb,
      async listSettlingBefore() { throw new Error('candidate scan down'); },
      async countPendingBefore() { throw new Error('pending count down'); },
    };

    await expect(runAgentPayResumeTick({ ...h.deps, db: throwingDb })).resolves.toMatchObject({
      scanned: 0,
      failed: 2,
      stalePending: 0,
    });
  });

  it('skips an overlapping pass and releases the guard afterward', async () => {
    const h = harness([]);
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const scanStarted = new Promise<void>((resolve) => { entered = resolve; });
    const blockingDb: AgentPayResumeDb = {
      ...h.resumeDb,
      async listSettlingBefore() {
        entered();
        await barrier;
        return [];
      },
    };

    const first = runAgentPayResumeWorkerPass({ ...h.deps, db: blockingDb });
    await scanStarted;
    const overlap = await runAgentPayResumeWorkerPass(h.deps);
    release();
    const completed = await first;
    const after = await runAgentPayResumeWorkerPass(h.deps);

    expect(overlap).toMatchObject({ skippedOverlap: true, scanned: 0 });
    expect(completed.skippedOverlap).toBe(false);
    expect(after.skippedOverlap).toBe(false);
  });

  it('resolves poll cadence defaults/floor and starts/stops idempotently', () => {
    delete process.env.AGENT_PAY_RESUME_POLL_MS;
    expect(resolveAgentPayResumePollMs()).toBe(300_000);
    process.env.AGENT_PAY_RESUME_POLL_MS = '59999';
    expect(resolveAgentPayResumePollMs()).toBe(300_000);
    process.env.AGENT_PAY_RESUME_POLL_MS = '60000';
    expect(resolveAgentPayResumePollMs()).toBe(60_000);

    expect(isAgentPayResumeWorkerRunning()).toBe(false);
    startAgentPayResumeWorker();
    startAgentPayResumeWorker();
    expect(isAgentPayResumeWorkerRunning()).toBe(true);
    stopAgentPayResumeWorker();
    stopAgentPayResumeWorker();
    expect(isAgentPayResumeWorkerRunning()).toBe(false);
  });
});
