import { Connection } from '@solana/web3.js';
import {
  and,
  agentPayments,
  asc,
  bounties,
  bountyAttempts,
  bountyUsdcHolds,
  db,
  eq,
  isNull,
  lte,
  sql,
  type BountyUsdcHold,
} from '@clawville/database';
import { payAgent, resolveAgentPayRail, type AgentPayResult } from './agent-pay';
import { recordCovenantAction, type CovenantActorKind } from './covenant-action-recorder';
import { alertError } from './alert-error';
import { readSplTokenBalance } from './solana-token-balance';
import { usdcMintForNetwork } from './x402-payai';
import {
  admitPosterUsdcSpend,
  lockPosterUsdcSpend,
  PosterUsdcSpendAdmissionError,
} from './usdc-spend-admission';

const DEFAULT_TIER1_MAX_USD_CENTS = 5_000;
const MIN_TIER1_MAX_USD_CENTS = 100;
const HARD_TIER1_MAX_USD_CENTS = 5_000;
export const TIER1_OPEN_BOUNTY_CAP = 2;
export const TIER1_SETTLEMENT_MAX_ATTEMPTS = 5;

export function resolveTier1BountyMaxUsdCents(raw = process.env.TIER1_BOUNTY_MAX_USD_CENTS): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return DEFAULT_TIER1_MAX_USD_CENTS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_TIER1_MAX_USD_CENTS;
  return Math.min(
    HARD_TIER1_MAX_USD_CENTS,
    Math.max(MIN_TIER1_MAX_USD_CENTS, parsed),
  );
}

export class Tier1HoldAdmissionError extends Error {
  constructor(
    readonly code:
      | 'open_cap_exceeded'
      | 'wallet_missing'
      | 'balance_unavailable'
      | 'insufficient_usdc',
    message: string,
    readonly detail?: Record<string, string | number>,
  ) {
    super(message);
    this.name = 'Tier1HoldAdmissionError';
  }
}

export class Tier1LifecycleConflictError extends Error {
  constructor(readonly code: 'bounty_not_open' | 'approved_attempt_exists') {
    super(code === 'bounty_not_open'
      ? 'The Tier-1 bounty is no longer open.'
      : 'The Tier-1 bounty already has an approved attempt.');
    this.name = 'Tier1LifecycleConflictError';
  }
}

type BountyTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function readPosterUsdcBalance(publicKey: string): Promise<bigint> {
  const rail = resolveAgentPayRail();
  if (!rail.rpcUrl) throw new Error('agent-pay RPC is unavailable');
  const balance = await readSplTokenBalance(
    new Connection(rail.rpcUrl, 'confirmed'),
    usdcMintForNetwork(rail.network),
    publicKey,
  );
  return balance.amountAtomic;
}

/**
 * Admit one hold under a poster-scoped database lock. The read-only RPC balance
 * probe occurs under that lock so concurrent Tier-1 posts cannot over-reserve.
 */
export async function insertTier1BountyHold(
  tx: BountyTx,
  input: {
    bountyId: string;
    posterAvatarId: string;
    amountBaseUnits: bigint;
    readBalance?: (publicKey: string) => Promise<bigint>;
  },
): Promise<BountyUsdcHold> {
  await lockPosterUsdcSpend(tx, input.posterAvatarId);
  const [usage] = await tx
    .select({
      openCount: sql<number>`count(*)::int`,
      held: sql<string>`COALESCE(sum(${bountyUsdcHolds.amountBaseUnits}), 0)`,
    })
    .from(bountyUsdcHolds)
    .where(and(
      eq(bountyUsdcHolds.posterAvatarId, input.posterAvatarId),
      eq(bountyUsdcHolds.status, 'open'),
    ));
  const openCount = Number(usage?.openCount ?? 0);
  if (openCount >= TIER1_OPEN_BOUNTY_CAP) {
    throw new Tier1HoldAdmissionError(
      'open_cap_exceeded',
      `A poster may have at most ${TIER1_OPEN_BOUNTY_CAP} open Tier-1 USDC bounties.`,
      { openCount, cap: TIER1_OPEN_BOUNTY_CAP },
    );
  }

  try {
    await admitPosterUsdcSpend(tx, {
      posterAvatarId: input.posterAvatarId,
      amountAtomic: input.amountBaseUnits,
      readBalance: input.readBalance ?? readPosterUsdcBalance,
    });
  } catch (error) {
    if (!(error instanceof PosterUsdcSpendAdmissionError)) throw error;
    throw new Tier1HoldAdmissionError(
      error.code === 'wallet_missing'
        ? 'wallet_missing'
        : error.code === 'insufficient_usdc'
          ? 'insufficient_usdc'
          : 'balance_unavailable',
      error.message,
      error.detail,
    );
  }

  const [hold] = await tx
    .insert(bountyUsdcHolds)
    .values({
      bountyId: input.bountyId,
      posterAvatarId: input.posterAvatarId,
      amountBaseUnits: input.amountBaseUnits.toString(),
      status: 'open',
    })
    .returning();
  if (!hold) throw new Error('Tier-1 bounty hold insert returned no row');
  return hold;
}

export async function findTier1BountyHold(bountyId: string): Promise<BountyUsdcHold | null> {
  return (await db.query.bountyUsdcHolds.findFirst({
    where: eq(bountyUsdcHolds.bountyId, bountyId),
  })) ?? null;
}

export async function releaseTier1BountyHold(
  tx: BountyTx,
  input: {
    bountyId: string;
    posterAvatarId: string;
    reason: 'cancelled' | 'rejected' | 'expired';
    actorKind: CovenantActorKind;
  },
): Promise<{ released: boolean }> {
  await lockPosterUsdcSpend(tx, input.posterAvatarId);
  const now = new Date();
  const rows = await tx
    .update(bountyUsdcHolds)
    .set({ status: 'released', releasedAt: now, updatedAt: now })
    .where(and(
      eq(bountyUsdcHolds.bountyId, input.bountyId),
      eq(bountyUsdcHolds.posterAvatarId, input.posterAvatarId),
      eq(bountyUsdcHolds.status, 'open'),
    ))
    .returning({ bountyId: bountyUsdcHolds.bountyId });
  if (rows.length === 0) {
    const current = await tx.query.bountyUsdcHolds.findFirst({
      where: eq(bountyUsdcHolds.bountyId, input.bountyId),
    });
    if (!current || current.status === 'settled') {
      throw new Error('Tier-1 bounty hold release CAS lost');
    }
    return { released: false };
  }
  if (rows.length !== 1) throw new Error('Tier-1 bounty hold release changed multiple rows');
  await recordCovenantAction({
    action: 'bounty.tier1_released',
    subjectType: 'avatar',
    subjectId: input.posterAvatarId,
    actorKind: input.actorKind,
    dedupeKey: `bounty:${input.bountyId}:tier1-release`,
    payload: {
      bountyId: input.bountyId,
      rail: 'tier1-agent-pay',
      reason: input.reason,
    },
  }, tx);
  return { released: true };
}

async function bookTier1BountyPaid(input: {
  bountyId: string;
  posterAvatarId: string;
  hunterAvatarId: string;
  paymentId: string;
  txSignature: string;
}): Promise<{ replay: boolean }> {
  return db.transaction(async (tx) => {
    await lockPosterUsdcSpend(tx, input.posterAvatarId);
    const now = new Date();
    const holdRows = await tx
      .update(bountyUsdcHolds)
      .set({ status: 'settled', releasedAt: now, updatedAt: now })
      .where(and(
        eq(bountyUsdcHolds.bountyId, input.bountyId),
        eq(bountyUsdcHolds.posterAvatarId, input.posterAvatarId),
        eq(bountyUsdcHolds.status, 'open'),
      ))
      .returning({ bountyId: bountyUsdcHolds.bountyId });
    if (holdRows.length === 0) {
      const [current] = await tx
        .select({ holdStatus: bountyUsdcHolds.status, bountyStatus: bounties.status })
        .from(bountyUsdcHolds)
        .innerJoin(bounties, eq(bounties.id, bountyUsdcHolds.bountyId))
        .where(eq(bountyUsdcHolds.bountyId, input.bountyId))
        .limit(1);
      if (current?.holdStatus === 'settled' && current.bountyStatus === 'completed') {
        return { replay: true };
      }
      throw new Error('Tier-1 settlement hold CAS lost');
    }
    if (holdRows.length !== 1) throw new Error('Tier-1 settlement changed multiple holds');

    const bountyRows = await tx
      .update(bounties)
      .set({
        status: 'completed',
        completedAt: now,
        covenantVerificationPassed: true,
        updatedAt: now,
      })
      .where(and(eq(bounties.id, input.bountyId), eq(bounties.status, 'open')))
      .returning({ id: bounties.id });
    if (bountyRows.length !== 1) throw new Error('Tier-1 settlement bounty CAS lost');

    // Raw-template params bypass Drizzle's column serializers, and the
    // postgres.js driver rejects a bare Date there (ERR_INVALID_ARG_TYPE,
    // caught by the 2026-08-11 staging live smoke) — pass ISO strings.
    const nowIso = now.toISOString();
    await tx.execute(sql`
      INSERT INTO bounty_reputation (
        avatar_id, tier, total_completed, total_earned, total_posted,
        success_rate, last_activity_at, created_at, updated_at
      ) VALUES (
        ${input.hunterAvatarId}, 'newcomer', 1, 0, 0, 100,
        ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${nowIso}::timestamptz
      )
      ON CONFLICT (avatar_id) DO UPDATE SET
        total_completed = bounty_reputation.total_completed + 1,
        tier = CASE
          WHEN bounty_reputation.total_completed + 1 >= 50 THEN 'master'::reputation_tier
          WHEN bounty_reputation.total_completed + 1 >= 25 THEN 'expert'::reputation_tier
          WHEN bounty_reputation.total_completed + 1 >= 10 THEN 'journeyman'::reputation_tier
          WHEN bounty_reputation.total_completed + 1 >= 3 THEN 'apprentice'::reputation_tier
          ELSE 'newcomer'::reputation_tier
        END,
        last_activity_at = ${nowIso}::timestamptz,
        updated_at = ${nowIso}::timestamptz
    `);

    await recordCovenantAction({
      action: 'bounty.tier1_settled',
      subjectType: 'avatar',
      subjectId: input.hunterAvatarId,
      actorKind: 'system',
      dedupeKey: `bounty:${input.bountyId}:tier1-settled`,
      payload: {
        bountyId: input.bountyId,
        rail: 'tier1-agent-pay',
        paymentId: input.paymentId,
        txSignature: input.txSignature,
      },
    }, tx);
    return { replay: false };
  });
}

/**
 * Approval-side lifecycle claim. The no-op timestamp update is a real CAS on
 * status='open' and takes the bounty row lock while holding the same poster
 * spend lock used by expiry. A completed expiry therefore cannot be approved.
 */
export async function assertTier1BountyApprovable(
  tx: BountyTx,
  input: { bountyId: string; posterAvatarId: string; now: Date },
): Promise<void> {
  await lockPosterUsdcSpend(tx, input.posterAvatarId);
  const rows = await tx
    .update(bounties)
    .set({ updatedAt: input.now })
    .where(and(eq(bounties.id, input.bountyId), eq(bounties.status, 'open')))
    .returning({ id: bounties.id });
  if (rows.length !== 1) throw new Tier1LifecycleConflictError('bounty_not_open');
}

/** Expiry-side terminal CAS, paired with assertTier1BountyApprovable's lock. */
export async function claimTier1BountyExpiry(
  tx: BountyTx,
  input: { bountyId: string; posterAvatarId: string; now: Date },
): Promise<boolean> {
  await lockPosterUsdcSpend(tx, input.posterAvatarId);
  const rows = await tx
    .update(bounties)
    .set({ status: 'expired', updatedAt: input.now })
    .where(and(
      eq(bounties.id, input.bountyId),
      eq(bounties.status, 'open'),
      lte(bounties.expiresAt, input.now),
      sql`NOT EXISTS (
        SELECT 1 FROM ${bountyAttempts}
        WHERE ${bountyAttempts.bountyId} = ${input.bountyId}
          AND ${bountyAttempts.status} = 'approved'
      )`,
    ))
    .returning({ id: bounties.id });
  if (rows.length > 1) throw new Error('Tier-1 expiry changed multiple bounties');
  return rows.length === 1;
}

/**
 * Cancellation-side terminal CAS, paired with approval and expiry through the
 * poster spend lock. The preconditions deliberately live in this UPDATE: route
 * preflight reads are only UX and cannot authorize hold release.
 */
export async function claimTier1BountyCancellation(
  tx: BountyTx,
  input: { bountyId: string; posterAvatarId: string; now: Date },
): Promise<boolean> {
  await lockPosterUsdcSpend(tx, input.posterAvatarId);
  const rows = await tx
    .update(bounties)
    .set({ status: 'cancelled', updatedAt: input.now })
    .where(and(
      eq(bounties.id, input.bountyId),
      eq(bounties.status, 'open'),
      eq(bounties.currentAttempts, 0),
      sql`NOT EXISTS (
        SELECT 1 FROM ${bountyAttempts}
        WHERE ${bountyAttempts.bountyId} = ${input.bountyId}
          AND ${bountyAttempts.status} IN ('claimed', 'in_progress', 'submitted', 'approved')
      )`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${agentPayments}
        WHERE ${agentPayments.bountyHoldId} = ${input.bountyId}
      )`,
    ))
    .returning({ id: bounties.id });
  if (rows.length > 1) throw new Error('Tier-1 cancellation changed multiple bounties');
  return rows.length === 1;
}

export function tier1SettlementIdempotencyKey(bountyId: string, attempt = 1): string {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > TIER1_SETTLEMENT_MAX_ATTEMPTS) {
    throw new Error('Tier-1 settlement attempt is outside the bounded range');
  }
  const base = `bounty:${bountyId}:tier1-settle`;
  return attempt === 1 ? base : `${base}:${attempt}`;
}

export interface Tier1SettlementPaymentState {
  id: string;
  status: 'pending' | 'settling' | 'settled' | 'failed' | 'reconcile';
  idempotencyKey: string;
  capExempt: boolean | null;
  txSignature: string | null;
  reconcileTxSignature: string | null;
  settlePayer: string | null;
  failureReason: string | null;
}

export type Tier1SettlementAttemptPlan =
  | { kind: 'drive'; attempt: number; idempotencyKey: string }
  | { kind: 'rearm'; attempt: number; idempotencyKey: string; paymentId: string }
  | { kind: 'frozen'; reason: 'ambiguous' | 'failure_not_proven_safe' | 'invariant_mismatch'; paymentId?: string }
  | { kind: 'exhausted'; attempt: number; paymentId: string };

/** Pure classification seam: only a proven never-broadcast failed row rearms. */
export function planTier1SettlementAttempt(input: {
  bountyId: string;
  settlementAttempt: number;
  payment: Tier1SettlementPaymentState | null;
}): Tier1SettlementAttemptPlan {
  const expectedKey = tier1SettlementIdempotencyKey(input.bountyId, input.settlementAttempt);
  if (!input.payment) {
    return { kind: 'drive', attempt: input.settlementAttempt, idempotencyKey: expectedKey };
  }
  const payment = input.payment;
  if (payment.idempotencyKey !== expectedKey) {
    return { kind: 'frozen', reason: 'invariant_mismatch', paymentId: payment.id };
  }
  if (payment.status === 'reconcile') {
    return { kind: 'frozen', reason: 'ambiguous', paymentId: payment.id };
  }
  if (payment.status !== 'failed') {
    return { kind: 'drive', attempt: input.settlementAttempt, idempotencyKey: expectedKey };
  }
  if (
    payment.capExempt !== true
    || payment.txSignature !== null
    || payment.reconcileTxSignature !== null
    || payment.settlePayer !== null
  ) {
    return { kind: 'frozen', reason: 'failure_not_proven_safe', paymentId: payment.id };
  }
  if (input.settlementAttempt >= TIER1_SETTLEMENT_MAX_ATTEMPTS) {
    return { kind: 'exhausted', attempt: input.settlementAttempt, paymentId: payment.id };
  }
  const nextAttempt = input.settlementAttempt + 1;
  return {
    kind: 'rearm',
    attempt: nextAttempt,
    idempotencyKey: tier1SettlementIdempotencyKey(input.bountyId, nextAttempt),
    paymentId: payment.id,
  };
}

type PreparedTier1SettlementAttempt = Exclude<Tier1SettlementAttemptPlan, { kind: 'rearm' }>;

/**
 * Under the poster lock, archive one definitively failed row and advance the
 * hold generation. The next payAgent call then performs its normal admission
 * (including dollar caps) and binds a fresh row to the hold.
 */
export async function prepareTier1SettlementAttempt(input: {
  bountyId: string;
  posterAvatarId: string;
  hunterAvatarId: string;
  rewardUsdCents: number;
}): Promise<PreparedTier1SettlementAttempt> {
  return db.transaction(async (tx) => {
    await lockPosterUsdcSpend(tx, input.posterAvatarId);
    const states = await tx
      .select({
        bountyStatus: bounties.status,
        bountyRewardUsdCents: bounties.tokenReward,
        holdStatus: bountyUsdcHolds.status,
        holdAmount: bountyUsdcHolds.amountBaseUnits,
        settlementAttempt: bountyUsdcHolds.settlementAttempt,
        approvedHunterId: bountyAttempts.hunterId,
        paymentId: agentPayments.id,
        paymentStatus: agentPayments.status,
        paymentIdempotencyKey: agentPayments.idempotencyKey,
        paymentCapExempt: agentPayments.capExempt,
        paymentTxSignature: agentPayments.txSignature,
        paymentReconcileTxSignature: agentPayments.reconcileTxSignature,
        paymentSettlePayer: agentPayments.settlePayer,
        paymentFailureReason: agentPayments.failureReason,
      })
      .from(bountyUsdcHolds)
      .innerJoin(bounties, eq(bounties.id, bountyUsdcHolds.bountyId))
      .innerJoin(bountyAttempts, and(
        eq(bountyAttempts.bountyId, bounties.id),
        eq(bountyAttempts.hunterId, input.hunterAvatarId),
        eq(bountyAttempts.status, 'approved'),
      ))
      .leftJoin(agentPayments, eq(agentPayments.bountyHoldId, bountyUsdcHolds.bountyId))
      .where(and(
        eq(bountyUsdcHolds.bountyId, input.bountyId),
        eq(bountyUsdcHolds.posterAvatarId, input.posterAvatarId),
      ))
      .limit(2);
    const state = states[0];
    const expectedAmount = BigInt(input.rewardUsdCents) * 10_000n;
    if (
      states.length !== 1
      || !state
      || state.bountyStatus !== 'open'
      || state.holdStatus !== 'open'
      || state.bountyRewardUsdCents !== input.rewardUsdCents
      || BigInt(state.holdAmount) !== expectedAmount
      || state.approvedHunterId !== input.hunterAvatarId
    ) {
      return { kind: 'frozen', reason: 'invariant_mismatch' };
    }

    const payment: Tier1SettlementPaymentState | null = state.paymentId
      ? {
          id: state.paymentId,
          status: state.paymentStatus!,
          idempotencyKey: state.paymentIdempotencyKey!,
          capExempt: state.paymentCapExempt,
          txSignature: state.paymentTxSignature,
          reconcileTxSignature: state.paymentReconcileTxSignature,
          settlePayer: state.paymentSettlePayer,
          failureReason: state.paymentFailureReason,
        }
      : null;
    const plan = planTier1SettlementAttempt({
      bountyId: input.bountyId,
      settlementAttempt: state.settlementAttempt,
      payment,
    });
    if (plan.kind !== 'rearm') return plan;

    const now = new Date();
    const archived = await tx
      .update(agentPayments)
      .set({
        bountyHoldId: null,
        updatedAt: now,
        metadata: sql`COALESCE(${agentPayments.metadata}, '{}'::jsonb) || ${JSON.stringify({
          tier1BountyId: input.bountyId,
          retryDisposition: 'definitive-no-broadcast',
          supersededByAttempt: plan.attempt,
        })}::jsonb`,
      })
      .where(and(
        eq(agentPayments.id, plan.paymentId),
        eq(agentPayments.bountyHoldId, input.bountyId),
        eq(agentPayments.status, 'failed'),
        eq(agentPayments.capExempt, true),
        eq(agentPayments.idempotencyKey, tier1SettlementIdempotencyKey(
          input.bountyId,
          state.settlementAttempt,
        )),
        isNull(agentPayments.txSignature),
        isNull(agentPayments.reconcileTxSignature),
        isNull(agentPayments.settlePayer),
      ))
      .returning({ id: agentPayments.id });
    if (archived.length !== 1) {
      return { kind: 'frozen', reason: 'invariant_mismatch', paymentId: plan.paymentId };
    }

    const advanced = await tx
      .update(bountyUsdcHolds)
      .set({ settlementAttempt: plan.attempt, updatedAt: now })
      .where(and(
        eq(bountyUsdcHolds.bountyId, input.bountyId),
        eq(bountyUsdcHolds.posterAvatarId, input.posterAvatarId),
        eq(bountyUsdcHolds.status, 'open'),
        eq(bountyUsdcHolds.settlementAttempt, state.settlementAttempt),
      ))
      .returning({ bountyId: bountyUsdcHolds.bountyId });
    if (advanced.length !== 1) throw new Error('Tier-1 settlement generation CAS lost');
    return { kind: 'drive', attempt: plan.attempt, idempotencyKey: plan.idempotencyKey };
  });
}

export type Tier1BountySettleResult =
  | { ok: true; replay: boolean; payment: Extract<AgentPayResult, { ok: true }> }
  | { ok: false; payment: Extract<AgentPayResult, { ok: false }> };

export interface Tier1BountySettleDeps {
  pay?: typeof payAgent;
  bookPaid?: typeof bookTier1BountyPaid;
}

export async function settleTier1Bounty(input: {
  bountyId: string;
  posterAvatarId: string;
  hunterAvatarId: string;
  rewardUsdCents: number;
  settlementAttempt?: number;
}, injected: Tier1BountySettleDeps = {}): Promise<Tier1BountySettleResult> {
  const payment = await (injected.pay ?? payAgent)({
    senderAvatarId: input.posterAvatarId,
    recipient: { kind: 'avatar', avatarId: input.hunterAvatarId },
    usdCents: input.rewardUsdCents,
    idempotencyKey: tier1SettlementIdempotencyKey(
      input.bountyId,
      input.settlementAttempt ?? 1,
    ),
    bountyHoldId: input.bountyId,
    countCapExempt: true,
    platformMediatedMaxUsdCents: resolveTier1BountyMaxUsdCents(),
  });
  if (!payment.ok) return { ok: false, payment };
  const booked = await (injected.bookPaid ?? bookTier1BountyPaid)({
    bountyId: input.bountyId,
    posterAvatarId: input.posterAvatarId,
    hunterAvatarId: input.hunterAvatarId,
    paymentId: payment.paymentId,
    txSignature: payment.txSignature,
  });
  return { ok: true, replay: payment.replay || booked.replay, payment };
}

const tier1WedgeAlerts = new Map<string, number>();
const TIER1_WEDGE_ALERT_MS = 60 * 60 * 1_000;

type Tier1ResumeCandidate = {
  bountyId: string;
  posterAvatarId: string;
  hunterAvatarId: string;
  rewardUsdCents: number;
};

async function listTier1ResumeCandidates(limit: number): Promise<Tier1ResumeCandidate[]> {
  return db
    .select({
      bountyId: bountyUsdcHolds.bountyId,
      posterAvatarId: bountyUsdcHolds.posterAvatarId,
      hunterAvatarId: bountyAttempts.hunterId,
      rewardUsdCents: bounties.tokenReward,
    })
    .from(bountyUsdcHolds)
    .innerJoin(bounties, eq(bounties.id, bountyUsdcHolds.bountyId))
    .innerJoin(bountyAttempts, and(
      eq(bountyAttempts.bountyId, bounties.id),
      eq(bountyAttempts.status, 'approved'),
    ))
    .where(and(
      eq(bountyUsdcHolds.status, 'open'),
      eq(bounties.status, 'open'),
    ))
    .orderBy(asc(bountyUsdcHolds.updatedAt))
    .limit(Math.min(Math.max(1, limit), 100));
}

export interface Tier1BountyResumeDeps {
  listCandidates?: (limit: number) => Promise<Tier1ResumeCandidate[]>;
  prepareAttempt?: typeof prepareTier1SettlementAttempt;
  settle?: typeof settleTier1Bounty;
  alert?: typeof alertError;
  now?: () => number;
}

/** Retry approved Tier-1 holds, advancing only proven no-broadcast failures. */
export async function resumeTier1BountySettlements(
  limit = 50,
  injected: Tier1BountyResumeDeps = {},
): Promise<number> {
  const rows = await (injected.listCandidates ?? listTier1ResumeCandidates)(limit);
  const prepare = injected.prepareAttempt ?? prepareTier1SettlementAttempt;
  const settle = injected.settle ?? settleTier1Bounty;
  const alert = injected.alert ?? alertError;
  const readNow = injected.now ?? Date.now;

  let settled = 0;
  for (const row of rows) {
    try {
      const prepared = await prepare(row);
      if (prepared.kind !== 'drive') {
        const now = readNow();
        const last = tier1WedgeAlerts.get(row.bountyId) ?? 0;
        if (now - last >= TIER1_WEDGE_ALERT_MS) {
          await alert({
            severity: 'warning',
            source: 'bounty-tier1-settlement',
            message: prepared.kind === 'exhausted'
              ? `Tier-1 bounty ${row.bountyId} exhausted ${TIER1_SETTLEMENT_MAX_ATTEMPTS} definitive settlement attempts; manual action is required.`
              : `Tier-1 bounty ${row.bountyId} settlement is frozen (${prepared.reason}); manual action is required.`,
            context: {
              bountyId: row.bountyId,
              disposition: prepared.kind,
              ...(prepared.kind === 'frozen' ? { reason: prepared.reason } : {}),
              ...(prepared.paymentId ? { paymentId: prepared.paymentId } : {}),
            },
          });
          tier1WedgeAlerts.set(row.bountyId, now);
        }
        continue;
      }
      const result = await settle({ ...row, settlementAttempt: prepared.attempt });
      if (result.ok) {
        settled += 1;
        tier1WedgeAlerts.delete(row.bountyId);
        continue;
      }
      const now = readNow();
      const last = tier1WedgeAlerts.get(row.bountyId) ?? 0;
      if (now - last >= TIER1_WEDGE_ALERT_MS) {
        const ambiguous = result.payment.code === 'payment_reconcile';
        await alert({
          severity: 'warning',
          source: 'bounty-tier1-settlement',
          message: ambiguous
            ? `Tier-1 bounty ${row.bountyId} has an ambiguous payment and is frozen for operator reconciliation.`
            : `Tier-1 bounty ${row.bountyId} remains approved and unpaid; bounded retry remains active.`,
          context: {
            bountyId: row.bountyId,
            paymentId: result.payment.paymentId,
            code: result.payment.code,
          },
        });
        tier1WedgeAlerts.set(row.bountyId, now);
      }
    } catch (error) {
      console.error(`[bounty-tier1] settlement resume failed for ${row.bountyId}:`, error);
    }
  }
  return settled;
}

/** Pure DB expiry: approved bounties are settlement-owned and never released. */
export async function sweepExpiredTier1Bounties(now = new Date(), limit = 50): Promise<number> {
  const candidates = await db
    .select({ bountyId: bounties.id, posterAvatarId: bountyUsdcHolds.posterAvatarId })
    .from(bountyUsdcHolds)
    .innerJoin(bounties, eq(bounties.id, bountyUsdcHolds.bountyId))
    .where(and(
      eq(bountyUsdcHolds.status, 'open'),
      eq(bounties.status, 'open'),
      lte(bounties.expiresAt, now),
      sql`NOT EXISTS (
        SELECT 1 FROM ${bountyAttempts}
        WHERE ${bountyAttempts.bountyId} = ${bounties.id}
          AND ${bountyAttempts.status} = 'approved'
      )`,
    ))
    .orderBy(asc(bounties.expiresAt))
    .limit(Math.min(Math.max(1, limit), 100));

  let released = 0;
  for (const candidate of candidates) {
    const didRelease = await db.transaction(async (tx) => {
      const claimed = await claimTier1BountyExpiry(tx, {
        bountyId: candidate.bountyId,
        posterAvatarId: candidate.posterAvatarId,
        now,
      });
      if (!claimed) return false;
      await tx
        .update(bountyAttempts)
        .set({
          status: 'rejected',
          reviewNote: 'Auto-rejected: Tier-1 bounty expired',
          reviewedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(bountyAttempts.bountyId, candidate.bountyId),
          sql`${bountyAttempts.status} IN ('claimed', 'in_progress', 'submitted')`,
        ));
      const hold = await releaseTier1BountyHold(tx, {
        bountyId: candidate.bountyId,
        posterAvatarId: candidate.posterAvatarId,
        reason: 'expired',
        actorKind: 'system',
      });
      return hold.released;
    });
    if (didRelease) released += 1;
  }
  return released;
}
