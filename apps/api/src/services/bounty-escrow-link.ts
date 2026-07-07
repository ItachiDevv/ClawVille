/**
 * Bounty ↔ SAP USDC escrow linkage (Phase 1 of the agent-economy path-to-live).
 *
 * The seam that binds a `payment_rail='usdc'` bounty to the (already-built,
 * already-gated) SAP Option-C USDC escrow gate. It does NOT re-implement any
 * money logic — it maps a bounty's lifecycle onto the escrow-gate primitives:
 *
 *   bounty create (usdc)   → openEscrow   (depositor=creator, worker=<deferred>)
 *   attempt submit         → submitJob    (worker records the deliverable)
 *   creator/admin approve  → approveJob + settleJob   (PASS verdict → release)
 *   creator/admin reject   → refundEscrow (FAIL verdict → refund to creator)
 *
 * ── The (escrow, job) mapping (the money invariant) ───────────────────────────
 * We bind `jobId === bounty.id` so the SAP settlement ledger's at-most-once-settle
 * guard (the (escrow_pda, job_id) UNIQUE index) maps 1:1 to a bounty. A bounty is
 * a SINGLE-call escrow job: `pricePerCall = maxCalls = 1 call = the whole reward`,
 * `initialDeposit = the whole reward`, so exactly ONE settle of one call releases
 * the full reward to the worker, and the escrow gate's per-job/per-escrow funds
 * ledger enforces it can never over-release.
 *
 * ── The worker binding (deferred to claim/approve time) ───────────────────────
 * A bounty's worker (hunter) is NOT known at create time — the escrow is opened
 * against the creator (depositor) only. The escrow gate REQUIRES a distinct
 * worker avatar at open (`openEscrow` rejects depositor==worker as self-dealing),
 * so we CANNOT open the on-chain escrow until a hunter is bound. We therefore:
 *   - at create: validate criteria + gate + persist the bounty as usdc-rail with
 *     NO escrow row yet (escrow_pda NULL). No money leg runs at create.
 *   - at APPROVE (the single winning hunter is now known): open the escrow
 *     (depositor=creator, worker=hunter, jobId=bounty.id), approve it (depositor),
 *     then settle it (worker) — all under the escrow gate's own idempotency +
 *     ceiling guards. This keeps a single, real, distinct (depositor, worker)
 *     pair, which is what the self-dealing + release guards require.
 *
 * This module is a thin adapter: every guarded transition still runs through
 * `escrow-gate.ts` (self-deal / persisted-approval / at-most-once / funds-ledger).
 * It writes NO `avatars.clawTokens` (USDC path) and moves NO money when the SAP
 * gate is off — `openEscrow`/`settleJob`/`refundEscrow` all short-circuit with
 * `gate_disabled` and this module surfaces that verbatim.
 *
 * ── The PayAI settlement rail (the three-party topology, wired 2026-07-06) ────
 * Founder constraint: SAP handles the ESCROW RECORD, Covenant RECORDS/VERIFIES
 * the work (the verdict + audit root authorize release), and the actual
 * SETTLEMENT goes through PayAI. With `SAP_PAYAI_SETTLEMENT_ENABLED=true`, NEW
 * bounty escrows open on the `payai` rail: no on-chain SAP vault is funded; on
 * the PASS verdict the escrow gate's settle step drives ONE x402 exact-scheme
 * USDC payment (creator's custodial wallet → hunter's wallet) through the PayAI
 * facilitator via `x402-payai.verifyAndSettle` (see `sap/payai-release.ts`).
 * The (escrow_pda, job_id) at-most-once claim, the persisted creator approval,
 * and the funds ceilings gate that payment exactly as they gate the vault
 * release — and because a payai job NEVER runs the vault leg, exactly one USDC
 * movement exists per bounty (conservation; no double-pay is constructible).
 * On this rail a reject-path "refund" is a pure ledger close (the creator's
 * USDC never left their wallet), and `SAP_DRY_RUN=true` maps to facilitator
 * VERIFY-only (payload built + verified, `/settle` never called).
 *
 * ── OPERATOR CAVEAT: one escrow VAULT per (creator, hunter) pair, NOT per bounty ─
 * The V1 USDC escrow PDA is `["sap_escrow", agentPda, depositor]` with NO nonce,
 * so ONE on-chain vault is shared by every job for a given (creator=depositor,
 * hunter=worker) pair. `openEscrow` disambiguates jobs by `jobId` (=bounty.id):
 * the FIRST bounty a creator settles to a given hunter CREATES the vault; a SECOND
 * bounty between the SAME pair is a DEPOSIT TOP-UP of the same vault (a distinct
 * settlement row, same `escrow_pda`). So DO NOT assume "1 bounty = 1 vault" at
 * reconciliation — a vault's on-chain balance can back several bounties. The
 * per-job + escrow-wide funds ledger in `escrow-gate.ts` enforces that no job can
 * over-release the vault, but an operator reading the chain must group by
 * `(escrow_pda)` and split by `job_id` to attribute funds to a specific bounty.
 */

import {
  openEscrow,
  approveJob,
  settleJob,
  refundEscrow,
  type EscrowGateResult,
  type EscrowGateFailure,
} from './sap/escrow-gate';
import { sapConfigSnapshot } from './sap/sap-client';

/**
 * The whole-USDC reward → base-unit conversion. `tokenReward` on a bounty is a
 * whole-number reward; for the USDC rail we treat it as WHOLE USDC and scale by
 * the mint's 6 decimals. A single-call escrow releases this exact amount.
 *
 * UNIT CONTRACT (documented for callers + API consumers): a USDC bounty's
 * `tokenReward` and the `usdcReward` field on the `/attempts/:id/review` response
 * are WHOLE USDC (e.g. `250` = 250 USDC). The on-chain escrow moves the base-unit
 * amount `tokenReward × 10^6` (e.g. 250_000_000). The reward is NOT a base-unit
 * value on the wire — it is whole dollars, converted here at the escrow boundary.
 */
const USDC_DECIMALS = 6n;

/** Whole-USDC reward → u64 base units (6 decimals). */
export function usdcRewardBaseUnits(tokenReward: number): bigint {
  if (!Number.isInteger(tokenReward) || tokenReward <= 0) {
    throw new Error(`bounty tokenReward must be a positive integer, got ${tokenReward}`);
  }
  return BigInt(tokenReward) * 10n ** USDC_DECIMALS;
}

/** Is the SAP USDC escrow rail live enough to run a real (or dry-run) leg? */
export function usdcRailGateOpen(): boolean {
  const cfg = sapConfigSnapshot();
  return cfg.enabled && cfg.escrowEnabled && cfg.usdcEscrowEnabled;
}

/**
 * Open the USDC escrow for a bounty against a specific hunter (the winning
 * worker). Called at APPROVE time, once the single winning hunter is known.
 * Depositor = creator, worker = hunter, jobId = bountyId. A single-call escrow
 * funded with the whole reward.
 *
 * Idempotent: a retried open for the same (escrow, job) is served by the gate's
 * claim-first insert (replay=true, no double-fund).
 */
export async function openBountyEscrow(input: {
  bountyId: string;
  creatorAvatarId: string;
  hunterAvatarId: string;
  tokenReward: number;
  /** Absolute unix-seconds expiry (0 = no expiry). */
  expiresAt?: bigint;
}): Promise<EscrowGateResult> {
  const amount = usdcRewardBaseUnits(input.tokenReward);
  return openEscrow({
    depositorAvatarId: input.creatorAvatarId,
    workerAvatarId: input.hunterAvatarId,
    jobId: input.bountyId,
    // Single-call escrow: one call priced at the full reward.
    pricePerCall: amount,
    maxCalls: 1n,
    initialDeposit: amount,
    expiresAt: input.expiresAt ?? 0n,
    // THREE-PARTY TOPOLOGY rail selection (founder constraint: "SAP handles the
    // escrow, Covenant records/verifies, the actual SETTLEMENT goes through
    // PayAI"). With SAP_PAYAI_SETTLEMENT_ENABLED the job opens on the `payai`
    // rail: the settlement ledger (at-most-once + approval + ceilings) is
    // unchanged, but NO on-chain vault leg runs — on the PASS verdict the
    // release is ONE x402 exact-scheme USDC payment (creator custodial wallet →
    // hunter) settled by the PayAI facilitator. The flag is read ONLY here (at
    // open); every later transition dispatches from the rail RECORDED on the
    // row, so a flag flip mid-lifecycle can never double-move the reward.
    rail: bountySettlementRail(),
  });
}

/**
 * The rail NEW bounty escrows open on. `payai` when the PayAI settlement rail is
 * enabled (the target topology — the actual USDC settlement routes through the
 * PayAI facilitator); the on-chain SAP vault otherwise (the pre-PayAI default).
 */
export function bountySettlementRail(): 'onchain' | 'payai' {
  return sapConfigSnapshot().payaiSettlementEnabled ? 'payai' : 'onchain';
}

/**
 * Record the depositor's (creator's) approval of the bounty escrow. The escrow
 * gate re-asserts `callerAvatarId === depositorAvatarId`, so only the creator can
 * approve. Approves the single call (the whole reward).
 */
export async function approveBountyEscrow(input: {
  bountyId: string;
  escrowPda: string;
  creatorAvatarId: string;
}): Promise<EscrowGateResult> {
  return approveJob({
    escrowPda: input.escrowPda,
    jobId: input.bountyId,
    callerAvatarId: input.creatorAvatarId,
    approvedCalls: 1n,
  });
}

/**
 * Settle the bounty escrow → release the reward to the worker (hunter). The
 * escrow gate asserts `callerAvatarId === workerAvatarId`, READS the persisted
 * creator approval (never a body claim), and clamps the release to one call.
 *
 * NOTE the E5 signer binding: the on-chain settle is signed by the WORKER's
 * custodial wallet (per the escrow gate's design). So this MUST be driven with
 * the hunter's avatar id as the caller. Under the requester-approval v1 provider,
 * the creator-review approve is what authorizes it; the settle is the mechanical
 * release once approved. See the route for how the caller is bound.
 */
export async function settleBountyEscrow(input: {
  bountyId: string;
  escrowPda: string;
  hunterAvatarId: string;
}): Promise<EscrowGateResult> {
  return settleJob({
    escrowPda: input.escrowPda,
    jobId: input.bountyId,
    callerAvatarId: input.hunterAvatarId,
    callsToSettle: 1n,
  });
}

/**
 * Refund the bounty escrow back to the creator (depositor) on a FAIL verdict /
 * cancel. Refunds the full remaining funded amount (the whole reward, since a
 * failed job never settled). Only the depositor (creator) can refund; the admin
 * fail-refund route drives this AS the creator (depositor) because the escrow
 * gate binds the withdraw signer to the depositor's wallet.
 */
export async function refundBountyEscrow(input: {
  bountyId: string;
  escrowPda: string;
  creatorAvatarId: string;
  tokenReward: number;
}): Promise<EscrowGateResult> {
  const amount = usdcRewardBaseUnits(input.tokenReward);
  return refundEscrow({
    depositorAvatarId: input.creatorAvatarId,
    escrowPda: input.escrowPda,
    jobId: input.bountyId,
    amount,
  });
}

/** The extracted escrow-pda from a gate result (settlement row), or null. */
function escrowPdaOf(r: EscrowGateResult): string | null {
  return r.ok && 'settlement' in r ? r.settlement.escrowPda : null;
}

/**
 * The v1 requester-approval verdict → settle orchestration for a bounty on the
 * PASS path. Runs, in order (each idempotent via the SAP (escrow, job) ledger):
 *   1. open   — depositor(creator) funds a single-call USDC escrow vs the hunter.
 *   2. approve — depositor(creator) records the persisted approval (the ONLY
 *      thing that authorizes a release; the reviewer's "approve" decision IS the
 *      v1 requester approval).
 *   3. settle  — worker(hunter) releases the escrow (signs as itself), gated by
 *      the persisted approval + the gate's at-most-once + funds-ceiling guards.
 *
 * Returns a normalized result: on success the escrow PDA + the audit-root hex
 * (the verdict provenance) + the dry-run flag; on ANY leg failure the gate's
 * error code/message + the escrow PDA if one was created (so the caller can
 * persist it for reconciliation). A dry-run open/settle simulates only.
 *
 * IMPORTANT: this is NOT wrapped in a DB transaction — every leg is a chain call
 * (or dry-run sim) with its OWN idempotency; a retry of the whole chain re-plays
 * each leg safely (open replays, approve upserts, settle replays the cached
 * result). The caller persists the outcome onto the bounty row.
 */
export async function runBountyUsdcSettle(input: {
  bountyId: string;
  creatorAvatarId: string;
  hunterAvatarId: string;
  tokenReward: number;
  expiresAt?: Date | null;
}): Promise<
  | { ok: true; escrowPda: string; auditRootHex: string | null; dryRun: boolean }
  | { ok: false; code: EscrowGateFailure['code']; message: string; escrowPda: string | null }
> {
  const expiresAtUnix = input.expiresAt
    ? BigInt(Math.floor(input.expiresAt.getTime() / 1000))
    : 0n;

  // 1. OPEN
  const opened = await openBountyEscrow({
    bountyId: input.bountyId,
    creatorAvatarId: input.creatorAvatarId,
    hunterAvatarId: input.hunterAvatarId,
    tokenReward: input.tokenReward,
    expiresAt: expiresAtUnix,
  });
  if (opened.ok === false) {
    return { ok: false, code: opened.code, message: opened.message, escrowPda: null };
  }
  const escrowPda = escrowPdaOf(opened);
  if (!escrowPda) {
    return {
      ok: false,
      code: 'internal',
      message: 'escrow opened but no escrow PDA was recorded.',
      escrowPda: null,
    };
  }

  // 2. APPROVE (depositor=creator)
  const approved = await approveBountyEscrow({
    bountyId: input.bountyId,
    escrowPda,
    creatorAvatarId: input.creatorAvatarId,
  });
  if (approved.ok === false) {
    return { ok: false, code: approved.code, message: approved.message, escrowPda };
  }

  // 3. SETTLE (worker=hunter)
  const settled = await settleBountyEscrow({
    bountyId: input.bountyId,
    escrowPda,
    hunterAvatarId: input.hunterAvatarId,
  });
  if (settled.ok === false) {
    return { ok: false, code: settled.code, message: settled.message, escrowPda };
  }

  // Success — extract the audit-root provenance + dry-run flag from the row.
  const auditRootHex =
    settled.ok && 'settlement' in settled ? settled.settlement.auditRootHex ?? null : null;
  const dryRun =
    settled.ok && 'settlement' in settled ? settled.settlement.dryRun : true;
  return { ok: true, escrowPda, auditRootHex, dryRun };
}
