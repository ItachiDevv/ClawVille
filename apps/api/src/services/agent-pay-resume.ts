/**
 * Forward-only recovery for agent payments stranded in `settling`.
 *
 * This service never prepares, signs, sends, or calls the facilitator. A
 * captured signature is read-only chain evidence; all mutations stay inside
 * the existing agent-pay state machine.
 */
import { Connection } from '@solana/web3.js';
import {
  agentPayments,
  and,
  asc,
  db,
  eq,
  isNull,
  lt,
  sql,
  type AgentPayment,
} from '@clawville/database';
import { alertError, type AlertErrorParams } from './alert-error';
import {
  fulfillReconciledAgentPayment,
  markAgentPaymentReconcile,
  resolveAgentPayRail,
  resolveAgentPayStaleMs,
  type AgentPayResult,
  type AgentPayRail,
} from './agent-pay';

const SETTLING_CANDIDATE_AGE_MS = 120_000;
const STALE_PENDING_AGE_MS = 24 * 60 * 60 * 1_000;
const RESUME_POLL_MS_DEFAULT = 300_000;
const RESUME_POLL_MS_FLOOR = 60_000;

export interface AgentPayResumeDb {
  listSettlingBefore(cutoff: Date): Promise<AgentPayment[]>;
  expireStalePending(cutoff: Date): Promise<number>;
  countPendingBefore(cutoff: Date): Promise<number>;
  markReconcile(
    id: string,
    settlingId: string | null,
    reason: string,
    observedSignature?: string | null,
    expectedTxSignature?: string | null,
  ): Promise<boolean>;
}

export interface AgentPayChainTransaction {
  meta: { err: unknown } | null;
}

export interface AgentPayResumeDeps {
  db?: AgentPayResumeDb;
  fulfill?: (paymentId: string) => Promise<AgentPayResult>;
  getTransaction?: (
    rpcUrl: string,
    signature: string,
  ) => Promise<AgentPayChainTransaction | null>;
  resolveRail?: () => AgentPayRail;
  resolveStaleMs?: () => number;
  now?: () => number;
  alert?: (params: AlertErrorParams) => Promise<void>;
  logError?: (message: string, error: unknown) => void;
  resumeTier1?: () => Promise<number>;
}

export interface AgentPayResumeTickResult {
  scanned: number;
  fulfilled: number;
  reconciled: number;
  failed: number;
  stalePendingExpired: number;
  stalePending: number;
}

export interface AgentPayResumePassResult extends AgentPayResumeTickResult {
  skippedOverlap: boolean;
}

const defaultDb: AgentPayResumeDb = {
  async listSettlingBefore(cutoff) {
    return db
      .select()
      .from(agentPayments)
      .where(and(
        eq(agentPayments.status, 'settling'),
        lt(agentPayments.settlingStartedAt, cutoff),
      ))
      .orderBy(asc(agentPayments.settlingStartedAt), asc(agentPayments.id));
  },
  async expireStalePending(cutoff) {
    const reconciledAt = new Date();
    const rows = await db
      .update(agentPayments)
      .set({
        status: 'failed',
        failureReason: 'stale_pending_expired',
        settlingId: null,
        settlingStartedAt: null,
        updatedAt: reconciledAt,
        metadata: sql`COALESCE(${agentPayments.metadata}, '{}'::jsonb) || ${JSON.stringify({
          reconcileResolution: 'no_money',
          failureReason: 'stale_pending_expired',
          reconciledAt: reconciledAt.toISOString(),
          terminalClosedBy: 'agent-pay-resume-auto-expiry',
        })}::jsonb`,
      })
      .where(and(
        eq(agentPayments.status, 'pending'),
        eq(agentPayments.countCapExempt, false),
        lt(agentPayments.createdAt, cutoff),
        isNull(agentPayments.txSignature),
        isNull(agentPayments.settlePayer),
        isNull(agentPayments.settlingStartedAt),
        isNull(agentPayments.reconcileTxSignature),
      ))
      .returning({ id: agentPayments.id });
    return rows.length;
  },
  async countPendingBefore(cutoff) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentPayments)
      .where(and(
        eq(agentPayments.status, 'pending'),
        lt(agentPayments.createdAt, cutoff),
      ));
    return Number(row?.count ?? 0);
  },
  markReconcile: markAgentPaymentReconcile,
};

function resolveDeps(input: AgentPayResumeDeps = {}) {
  return {
    db: input.db ?? defaultDb,
    fulfill: input.fulfill ?? fulfillReconciledAgentPayment,
    getTransaction: input.getTransaction ?? (async (rpcUrl: string, signature: string) => {
      const connection = new Connection(rpcUrl, 'confirmed');
      return connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    }),
    resolveRail: input.resolveRail ?? resolveAgentPayRail,
    resolveStaleMs: input.resolveStaleMs ?? resolveAgentPayStaleMs,
    now: input.now ?? Date.now,
    alert: input.alert ?? alertError,
    logError: input.logError ?? ((message: string, error: unknown) => {
      console.error(message, error);
    }),
    resumeTier1: input.resumeTier1 ?? (async () => {
      const { resumeTier1BountySettlements } = await import('./bounty-tier1');
      return resumeTier1BountySettlements();
    }),
  };
}

function emptyTickResult(): AgentPayResumeTickResult {
  return {
    scanned: 0,
    fulfilled: 0,
    reconciled: 0,
    failed: 0,
    stalePendingExpired: 0,
    stalePending: 0,
  };
}

function safeLog(
  logError: (message: string, error: unknown) => void,
  message: string,
  error: unknown,
): void {
  try {
    logError(message, error);
  } catch {
    // Logging is observational; it must never terminate the recovery loop.
  }
}

async function warnReconcile(
  d: ReturnType<typeof resolveDeps>,
  row: AgentPayment,
  reason: string,
): Promise<void> {
  if (process.env.X402_AUTO_RECONCILE === 'true') {
    const createdMs = new Date(row.createdAt).getTime();
    // The enabled sweep is the response to ordinary staleness. Do not page on
    // transition; only a row already surviving beyond 24h merits the legacy
    // warning (manual/indeterminate survivors are also summarized by the sweep).
    if (Number.isFinite(createdMs) && d.now() - createdMs <= STALE_PENDING_AGE_MS) {
      return;
    }
  }
  try {
    await d.alert({
      severity: 'warning',
      source: 'agent-pay-resume',
      message: 'Agent payment moved to reconcile by the resume worker',
      context: {
        paymentId: row.id,
        reason,
        txSignature: row.txSignature,
      },
    });
  } catch (error) {
    safeLog(d.logError, '[agent-pay-resume] reconcile alert failed (non-fatal):', error);
  }
}

async function processCandidate(
  row: AgentPayment,
  nowMs: number,
  staleMs: number,
  d: ReturnType<typeof resolveDeps>,
  result: AgentPayResumeTickResult,
): Promise<void> {
  // Re-assert the query contract before doing any chain work. The mutation
  // paths re-assert status/settlingId/signature again at their DB boundary.
  if (row.status !== 'settling' || !row.settlingStartedAt) return;
  const ageMs = nowMs - new Date(row.settlingStartedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs <= SETTLING_CANDIDATE_AGE_MS) return;

  if (row.txSignature) {
    const rail = d.resolveRail();
    if (!rail.rpcUrl || rail.network !== row.network) {
      throw new Error(`agent-pay rail mismatch for network ${row.network}`);
    }
    const transaction = await d.getTransaction(rail.rpcUrl, row.txSignature);
    const landedSuccessfully = transaction?.meta !== null
      && transaction?.meta !== undefined
      && transaction.meta.err === null;
    if (landedSuccessfully) {
      const fulfilled = await d.fulfill(row.id);
      if (fulfilled.ok) {
        result.fulfilled += 1;
      } else if (fulfilled.code === 'payment_reconcile') {
        result.reconciled += 1;
        await warnReconcile(d, row, fulfilled.detail ?? 'payment_reconcile');
      }
      return;
    }

    if (ageMs <= staleMs) return;
    const reason = transaction?.meta?.err != null ? 'onchain_err' : 'stale_settling';
    const moved = await d.db.markReconcile(
      row.id,
      row.settlingId,
      reason,
      row.txSignature,
      row.txSignature,
    );
    if (!moved) return;
    result.reconciled += 1;
    await warnReconcile(d, row, reason);
    return;
  }

  // No captured signature means the money state is unknown. Never prepare or
  // send again; after the stale threshold, quarantine for operator evidence.
  if (ageMs <= staleMs) return;
  const moved = await d.db.markReconcile(
    row.id,
    row.settlingId,
    'stale_settling',
    null,
    null,
  );
  if (!moved) return;
  result.reconciled += 1;
  await warnReconcile(d, row, 'stale_settling');
}

/** One complete pass. It always resolves, including on scan/row/alert errors. */
export async function runAgentPayResumeTick(
  input: AgentPayResumeDeps = {},
): Promise<AgentPayResumeTickResult> {
  const result = emptyTickResult();
  const d = resolveDeps(input);

  let nowMs: number;
  let staleMs: number;
  try {
    nowMs = d.now();
    staleMs = d.resolveStaleMs();
  } catch (error) {
    result.failed += 1;
    safeLog(d.logError, '[agent-pay-resume] clock/config resolution failed (non-fatal):', error);
    return result;
  }

  let candidates: AgentPayment[] = [];
  try {
    candidates = await d.db.listSettlingBefore(
      new Date(nowMs - SETTLING_CANDIDATE_AGE_MS),
    );
    result.scanned = candidates.length;
  } catch (error) {
    result.failed += 1;
    safeLog(d.logError, '[agent-pay-resume] candidate scan failed (non-fatal):', error);
  }

  for (const row of candidates) {
    try {
      await processCandidate(row, nowMs, staleMs, d, result);
    } catch (error) {
      result.failed += 1;
      safeLog(
        d.logError,
        `[agent-pay-resume] payment ${row.id} failed (non-fatal):`,
        error,
      );
    }
  }

  const stalePendingCutoff = new Date(nowMs - STALE_PENDING_AGE_MS);
  try {
    result.stalePendingExpired = await d.db.expireStalePending(stalePendingCutoff);
  } catch (error) {
    result.failed += 1;
    safeLog(d.logError, '[agent-pay-resume] pending expiry failed (non-fatal):', error);
  }

  try {
    result.stalePending = await d.db.countPendingBefore(stalePendingCutoff);
    if (result.stalePending === 0) {
      lastAlertedStalePendingCount = 0;
    } else if (result.stalePending !== lastAlertedStalePendingCount) {
      // Dedupe on the count: pre-money rows are benign and can sit for days, so
      // a steady backlog pages once, not on every pass. A changed count re-pages.
      lastAlertedStalePendingCount = result.stalePending;
      try {
        await d.alert({
          severity: 'warning',
          source: 'agent-pay-resume',
          message: 'Agent payments have remained pending for more than 24 hours',
          context: { pendingCount: result.stalePending },
        });
      } catch (error) {
        safeLog(d.logError, '[agent-pay-resume] pending alert failed (non-fatal):', error);
      }
    }
  } catch (error) {
    result.failed += 1;
    safeLog(d.logError, '[agent-pay-resume] pending count failed (non-fatal):', error);
  }

  // Tier-1 bounties use the same agent-pay state machine and deterministic
  // `bounty:<id>:tier1-settle` key. Re-drive approved open holds here so both a
  // pre-admission breaker refusal and an ordinary pending payment self-heal.
  // The bounty service replays payAgent idempotently and books completion only
  // after the payment is confirmed.
  try {
    await d.resumeTier1();
  } catch (error) {
    result.failed += 1;
    safeLog(d.logError, '[agent-pay-resume] Tier-1 bounty retry failed (non-fatal):', error);
  }

  return result;
}

export function resolveAgentPayResumePollMs(): number {
  const raw = process.env.AGENT_PAY_RESUME_POLL_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= RESUME_POLL_MS_FLOOR
    ? parsed
    : RESUME_POLL_MS_DEFAULT;
}

let resumeWorkerInterval: ReturnType<typeof setInterval> | null = null;
let resumePassRunning = false;
let resumeWorkerGeneration = 0;
let lastAlertedStalePendingCount = 0;

/** Guarded pass: a slow DB/RPC call never stacks another recovery pass. */
export async function runAgentPayResumeWorkerPass(
  input: AgentPayResumeDeps = {},
): Promise<AgentPayResumePassResult> {
  if (resumePassRunning) {
    return { ...emptyTickResult(), skippedOverlap: true };
  }
  resumePassRunning = true;
  try {
    return { ...(await runAgentPayResumeTick(input)), skippedOverlap: false };
  } catch (error) {
    // runAgentPayResumeTick is fail-soft by contract; retain a final backstop.
    const d = resolveDeps(input);
    safeLog(d.logError, '[agent-pay-resume] worker pass failed (non-fatal):', error);
    return { ...emptyTickResult(), failed: 1, skippedOverlap: false };
  } finally {
    resumePassRunning = false;
  }
}

export function isAgentPayResumeWorkerRunning(): boolean {
  return resumeWorkerInterval !== null;
}

/** Start the always-on recurring worker. Idempotent. */
export function startAgentPayResumeWorker(): void {
  if (resumeWorkerInterval) return;
  const periodMs = resolveAgentPayResumePollMs();
  const generation = ++resumeWorkerGeneration;
  const interval = setInterval(() => {
    // Re-assert ownership inside the callback. A queued callback from a prior
    // stop/restart generation must not begin a pass in the new generation.
    if (resumeWorkerInterval !== interval || resumeWorkerGeneration !== generation) return;
    void runAgentPayResumeWorkerPass();
  }, periodMs);
  interval.unref?.();
  resumeWorkerInterval = interval;
  console.log(
    `[agent-pay-resume] worker started — checking stranded payments every ` +
      `${Math.round(periodMs / 60_000)}min (forward-only; never re-sends)`,
  );
}

/** Stop future passes. An already-running bounded pass is allowed to finish. */
export function stopAgentPayResumeWorker(): void {
  resumeWorkerGeneration += 1;
  lastAlertedStalePendingCount = 0;
  if (!resumeWorkerInterval) return;
  clearInterval(resumeWorkerInterval);
  resumeWorkerInterval = null;
}
