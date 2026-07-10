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
 * ── The COMPOSED rail (SLICE 2a): SAP V2 vault (LEG 1) → PayAI x402 (LEG 2) ────
 * When BOTH SAP_USDC_ESCROW_ENABLED and SAP_PAYAI_SETTLEMENT_ENABLED are on,
 * `bountySettlementRail()` returns `'sap-payai-composed'` and bounties settle via
 * the founder-spec two-leg topology (the CLAWVILLE HOUSE is the fixed escrow
 * worker, so an unknown hunter need not be bound at post): LEG 1 custodies the
 * creator's USDC in an on-chain SAP V2 vault AT CREATE (`openComposedBountyEscrow`)
 * and releases the principal to the house at approve (`settleComposedBounty` =
 * approve→settleV2→finalizeV2); LEG 2 then pays the hunter ONE x402 exact USDC
 * payment from the house wallet. FAIL/cancel/expiry refunds the creator the full
 * deposit (`refundComposedBounty`). This SUPERSEDES the legacy single-leg
 * vault-less `payai` path above for bounties (that path stays reachable for any
 * non-composed consumer). Full design + money-conservation + idempotency: the
 * "COMPOSITION RAIL (SLICE 2a)" banner further below.
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
  openEscrowV2,
  approveJob,
  settleJob,
  settleJobV2,
  finalizeJobV2,
  refundEscrow,
  withdrawEscrowV2Idempotent,
  computeV2ProtocolFee,
  type EscrowGateResult,
  type EscrowGateFailure,
  type EscrowGateErrorCode,
  type EscrowSettlementRail,
  type WithdrawEscrowV2IdempotentResult,
} from './sap/escrow-gate';
import { sapConfigSnapshot, updateAgentPricingUsdc } from './sap/sap-client';
import { resolveHouseAvatarId, HOUSE_PRICING_TIER_ID } from './sap/house-sap-provisioning';
import { ensureWallet } from './wallet-service';
import { withKeyedMutex } from './keyed-mutex';

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

// ─── COMPOSITION-RAIL tuning + test seams (SLICE 3) ───────────────────────────

/** The composed-bounty DisputeWindow default: 1 slot ≈ instant. */
const BOUNTY_DISPUTE_WINDOW_SLOTS_DEFAULT = 1n;

/**
 * The DisputeWindow hold (in slots) a COMPOSED bounty's LEG-1 V2 vault is created
 * with — env `SAP_BOUNTY_DISPUTE_WINDOW_SLOTS`, default 1 (≈ instant), floored at
 * the program minimum of 1.
 *
 * WHY the MINIMUM by default (team-lead ruling): a bounty's "verdict" is the
 * creator's own explicit approve (the RequesterApproval provider), so there is no
 * third-party arbiter who needs a dispute window — the composed settle should
 * finalize (leg 1c) and pay the hunter (leg 2) in one shot at approve. The global
 * `SAP_DISPUTE_WINDOW_SLOTS` (default 2160 ≈ 15 min) protects agent↔agent escrows
 * and MUST stay large for them; a bounty-specific window keeps them independent.
 *
 * RAISING it (a larger env value) DELAYS the hunter's payout by that many slots —
 * `settleComposedBounty` returns `awaiting_finalize` at approve and the resume
 * worker (`resumeComposedBounty`) finalizes + pays out once the window elapses.
 * Never below 1 (the on-chain program rejects a 0-slot window).
 */
export function bountyDisputeWindowSlots(): bigint {
  const raw = process.env.SAP_BOUNTY_DISPUTE_WINDOW_SLOTS;
  if (!raw) return BOUNTY_DISPUTE_WINDOW_SLOTS_DEFAULT;
  try {
    const parsed = BigInt(raw);
    return parsed < 1n ? 1n : parsed; // program floor: >= 1 slot
  } catch {
    return BOUNTY_DISPUTE_WINDOW_SLOTS_DEFAULT;
  }
}

/**
 * Injectable gate seams for the composed-bounty orchestration (TESTS ONLY —
 * production passes nothing and gets the real imports). Mirrors the
 * `SettleJobV2Deps` idiom in `escrow-gate.ts`: every field defaults to the real
 * escrow-gate / wallet / house-resolver function, so a test can drive the full
 * open→settle→payout→reclaim / refund lifecycle with in-memory fakes and assert
 * conservation + idempotency WITHOUT an RPC connection, a custodial signer, or a
 * DB. Additive + optional — every existing caller (the bounty route) is unchanged.
 */
export interface ComposedBountyDeps {
  openEscrowV2?: typeof openEscrowV2;
  approveJob?: typeof approveJob;
  settleJobV2?: typeof settleJobV2;
  finalizeJobV2?: typeof finalizeJobV2;
  openEscrow?: typeof openEscrow;
  settleJob?: typeof settleJob;
  withdrawEscrowV2Idempotent?: typeof withdrawEscrowV2Idempotent;
  ensureWallet?: typeof ensureWallet;
  resolveHouseAvatarId?: typeof resolveHouseAvatarId;
  /** The per-bounty house pricing-tier publish (LEG-1 open prerequisite). */
  updateAgentPricingUsdc?: typeof updateAgentPricingUsdc;
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
    rail: legacyBountySettlementRail(),
  });
}

/**
 * The 2-value rail the LEGACY single-leg bounty escrow path
 * (`openBountyEscrow` / `runBountyUsdcSettle`) opens on: `payai` when the PayAI
 * settlement rail is enabled (the actual USDC settlement routes through the PayAI
 * facilitator); the on-chain SAP vault otherwise. This predates the COMPOSED rail
 * and can never open a `'sap-payai-composed'` job — that is the separate two-leg
 * `openComposedBountyEscrow` path. Kept internal so the public
 * `bountySettlementRail()` can widen to the 3-value SELECTOR (below) without
 * breaking the `EscrowSettlementRail` (`'onchain' | 'payai'`) contract this
 * legacy `openEscrow` call requires.
 */
function legacyBountySettlementRail(): EscrowSettlementRail {
  return sapConfigSnapshot().payaiSettlementEnabled ? 'payai' : 'onchain';
}

/**
 * The rail a NEW bounty settles on — the top-level SELECTOR the release path
 * (slice 2b) branches on:
 *   'sap-payai-composed' — BOTH the SAP V2 USDC escrow rail
 *     (`SAP_USDC_ESCROW_ENABLED`) AND the PayAI x402 settlement rail
 *     (`SAP_PAYAI_SETTLEMENT_ENABLED`) are on. The founder-spec topology:
 *     LEG 1 custodies the creator's USDC in an on-chain SAP V2 vault AT POST
 *     (worker = the ClawVille house), then LEG 2 pays the winning hunter via ONE
 *     x402 exact USDC payment from the house wallet. This is
 *     `openComposedBountyEscrow` + `settleComposedBounty` + `refundComposedBounty`.
 *   'payai'   — ONLY the PayAI settlement rail is on (no V2 vault): the legacy
 *     vault-LESS single-leg path (creator custodial wallet → hunter at settle,
 *     one x402 payment, no on-chain custody at post).
 *   'onchain' — neither PayAI-flag path: the on-chain SAP vault, single-leg.
 *
 * The COMPOSED rail SUPERSEDES the legacy vault-less `payai` path for bounties,
 * but the vault-less path stays reachable for any non-composed consumer (the
 * legacy `openBountyEscrow` / `runBountyUsdcSettle`, driven by
 * `legacyBountySettlementRail()` above). The underlying gate fns self-gate
 * (`gate_disabled`) if the deeper SAP flags are off, so a `'sap-payai-composed'`
 * verdict with the escrow gate closed fails closed — no money moves.
 */
export function bountySettlementRail(): 'onchain' | 'payai' | 'sap-payai-composed' {
  const cfg = sapConfigSnapshot();
  if (cfg.usdcEscrowEnabled && cfg.payaiSettlementEnabled) return 'sap-payai-composed';
  return cfg.payaiSettlementEnabled ? 'payai' : 'onchain';
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

// ════════════════════════════════════════════════════════════════════════════
// COMPOSITION RAIL (SLICE 2a) — SAP V2 USDC vault (LEG 1) → PayAI x402 (LEG 2)
// ════════════════════════════════════════════════════════════════════════════
//
// Founder spec: "bounties are done via escrow through SAP and then settled via
// x402 with PayAI." The deployed SAP program seeds every escrow with the WORKER's
// key at open, so an unknown hunter (not chosen until approve) CANNOT be the
// escrow worker at POST time. The composition therefore uses TWO legs with the
// CLAWVILLE HOUSE avatar (Coralia, `resolveHouseAvatarId()`) as the FIXED worker:
//
//   LEG 1 (on-chain V2 vault): at bounty CREATE open a SAP V2 USDC escrow
//     depositor=CREATOR, worker=HOUSE, funded → the creator's USDC is custodied
//     on-chain AT POST. At approve: approve(creator) → settleV2(house) reserves the
//     principal in a PendingSettlement → finalizeV2(permissionless) releases the
//     principal to the HOUSE custodial wallet (treasury takes the 0.5% fee).
//   LEG 2 (payai): house→hunter is ONE x402 exact USDC payment through the EXISTING
//     PayAI rail (a V1 `rail:'payai'` escrow depositor=house, worker=hunter), from
//     the house wallet.
//
// ── FEE / DEPOSIT MODEL (Model A) + THE DEPOSIT-FLOOR CORRECTION ──────────────
// A V2 settle debits `principal + computeV2ProtocolFee(principal)` from the vault
// (fee = principal·50/10000 = 0.5%). Model A prices the call at `reward` and would
// fund the vault with `reward + fee`. BUT `openEscrowV2`'s create preflight
// CONSERVATIVELY requires `initialDeposit >= obligation + ceil(1% of obligation)`
// (a 100-bps headroom, DISTINCT from the 50-bps fee actually debited at settle;
// see `computeV2ProtocolFee`'s own doc). `reward + 0.5%` is BELOW that floor, so
// Model A's literal deposit would be rejected `invalid_amount`. We therefore fund
// the MAX(reward + fee, openEscrowV2 floor) = the floor (`bountyVaultDeposit`), so
// the deposit BOTH passes the gate preflight AND covers the settle debit. The
// spread (~0.5% of reward) is the creator's RECLAIMABLE free vault balance
// (`refundComposedBounty` reclaims the FULL deposit). Nothing is lost or trapped.
//
// ── CONSERVATION (a $100 bounty; base units = 100_000_000) ───────────────────
//   deposit          = 100_000_000 + max(500_000, 1_000_000) = 101_000_000 (101 USDC)
//   settle debit     = principal 100_000_000 + fee 500_000     = 100_500_000
//   → house receives  100_000_000 (principal, at finalize); treasury 500_000 (fee)
//   → leg 2 pays hunter EXACTLY 100_000_000 (one x402 payment from the house)
//   → 500_000 (the headroom spread) stays as the creator's reclaimable free vault
//     balance. Ledger: creator(101) = hunter(100) + treasury(0.5) + house(0) +
//     creator-reclaimable(0.5). No mint, no burn, no double-pay.
//
// ── IDEMPOTENCY / REPLAY (every phase re-runs safely) ────────────────────────
//   LEG 1 open   — deterministic `bountyEscrowNonce(bountyId)` ⇒ same V2 PDA ⇒ the
//     gate's claim-first insert REPLAYS (no double-fund).
//   LEG 1 approve — upserts one authoritative approval; on a REPLAY where the row
//     has already advanced past open|submitted, approve returns `job_not_open`,
//     which the settle step (below) tolerates (the approval persisted on pass 1).
//   LEG 1 settleV2 — an already-`pending`/`settled` row REPLAYS (phase pending /
//     settled, chain=null); a fresh settle claims exactly once (at-most-once index).
//   LEG 1 finalizeV2 — an already-`settled` row REPLAYS; a not-yet-elapsed dispute
//     window returns `finalize_not_ready`; a retry after the window completes it.
//   LEG 2 open/approve/settle — the (payoutPda, `${bountyId}:payout`) claim + the
//     V1 at-most-once settle make the payout replay-safe; a retry after a leg-1
//     finalize re-derives the same payout escrow and replays.
// The two legs use DIFFERENT (escrowPda, jobId) keys (LEG 1: V2 creator↔house,
// jobId=bountyId; LEG 2: V1 house↔hunter, jobId=`${bountyId}:payout`), so they can
// never collide, and exactly ONE money movement exists per leg.
//
// ALL money moves are gated OFF + dry-run by default — the imported gate fns
// self-gate (`gate_disabled`) and dry-run (build + simulate only). This service
// adds NO live movement on its own.

/**
 * Deterministic SAP V2 escrow nonce derived from the bounty UUID: the first 8
 * bytes of the (dash-stripped) UUID, interpreted BIG-ENDIAN, as a u64.
 *
 * Determinism is the money invariant here: a retried `openComposedBountyEscrow`
 * derives the SAME nonce ⇒ the SAME V2 escrow PDA (`["sap_escrow_v2", agent,
 * depositor, nonce]`) ⇒ the escrow gate's claim-first insert REPLAYS the existing
 * row instead of funding a second vault. A bounty's UUID is a stable primary key,
 * so this is a pure, side-effect-free derivation.
 */
export function bountyEscrowNonce(bountyId: string): bigint {
  const hex = bountyId.replace(/-/g, '').toLowerCase();
  // First 8 bytes = the first 16 hex chars. Big-endian: the leading hex char is
  // the most-significant nibble, which `BigInt('0x' + …)` reads exactly.
  const first8 = hex.slice(0, 16);
  if (first8.length !== 16 || !/^[0-9a-f]{16}$/.test(first8)) {
    throw new Error(
      `bountyEscrowNonce: bountyId '${bountyId}' is not a valid UUID (need >= 8 hex bytes).`,
    );
  }
  return BigInt('0x' + first8);
}

/**
 * The USDC base-unit amount funded into the LEG-1 V2 vault for a bounty of
 * `tokenReward` whole USDC. `pricePerCall = reward` and `maxCalls = 1`, so the
 * settle obligation is `reward` and the settle debit is `reward + 0.5% fee`.
 *
 * We fund `MAX(reward + computeV2ProtocolFee(reward), openEscrowV2's create
 * floor)`. `openEscrowV2`'s floor is `obligation + ceil(1% of obligation)` — a
 * conservative 100-bps headroom that is DISTINCT from (and larger than) the
 * 50-bps fee the settle actually debits — so the floor always wins and the
 * deposit is exactly `openEscrowV2`'s minimum. The `MAX` keeps it correct even if
 * that headroom formula ever changed to be smaller than the fee. The spread
 * (`deposit − (reward + fee)`, ~0.5% of reward) is the creator's reclaimable free
 * vault balance, NOT a loss (`refundComposedBounty` reclaims the whole deposit).
 */
export function bountyVaultDeposit(tokenReward: number): bigint {
  const principal = usdcRewardBaseUnits(tokenReward); // = pricePerCall (maxCalls=1)
  const modelAFee = computeV2ProtocolFee(principal); // 50 bps, the real settle fee
  // Mirror openEscrowV2's create preflight EXACTLY (obligation = principal·1):
  // headroom = ceil(obligation·100/10000) with a floor of 1 base unit.
  const createFloorHeadroom = (principal * 100n + 9_999n) / 10_000n || 1n;
  const headroom = modelAFee > createFloorHeadroom ? modelAFee : createFloorHeadroom;
  return principal + headroom;
}

/**
 * Per-house-avatar mutex key — serializes a composed bounty's tier-publish +
 * escrow-create so a concurrent bounty cannot overwrite the house pricing menu
 * between another bounty's tier-set and its create. Mirrors `escrowMutexKey` in
 * escrow-gate.ts (`sap-escrow:<pda>`). See `openComposedBountyEscrow`.
 */
function housePricingMutexKey(houseAvatarId: string): string {
  return `sap-house-pricing:${houseAvatarId}`;
}

/**
 * LEG 1 open — at bounty CREATE, custody the creator's USDC in an on-chain SAP V2
 * escrow with the HOUSE as the fixed worker counterparty. depositor=creator,
 * worker=house, jobId=bountyId, single call priced at the reward, funded to
 * `bountyVaultDeposit`, nonce=`bountyEscrowNonce(bountyId)`.
 *
 * ── PER-BOUNTY PRICING TIER (the 6148 fix) ───────────────────────────────────
 * `create_escrow_v2` REQUIRES the escrow's `price_per_call` to match a tier in the
 * worker's on-chain pricing_menu, else it rejects `PricingTierNotFound` 6148. The
 * house provisioner publishes ONE fixed NOMINAL tier (1 USDC), but bounty rewards
 * are arbitrary (≥10 whole USDC), so that fixed tier can NEVER match an arbitrary
 * bounty. So this slice — which OWNS the per-bounty escrow↔tier arithmetic — first
 * (re)publishes the house tier at THIS bounty's exact price (`pricePerCall =
 * usdcRewardBaseUnits(reward)`), THEN opens the vault. `update_agent(pricing)`
 * REPLACES the whole menu (last-write-wins), so a constant `tierId` at the new
 * price is correct.
 *
 * ── WHY THE MUTEX MUST COVER THE CREATE TOO ──────────────────────────────────
 * The tier-set and the create are held together under a per-house keyed mutex.
 * Because the menu is replaced whole, a concurrent bounty B's tier-set could
 * otherwise land BETWEEN bounty A's tier-set and A's create, so A's create would
 * read B's price and fail 6148. Serializing the whole (set → create) critical
 * section per house avatar prevents that interleave. The in-process mutex is
 * sufficient because a SINGLE API container serves this rail (staging and prod are
 * each one container) — same rationale as escrow-gate's per-escrow `withKeyedMutex`;
 * the create itself is FURTHER serialized per-PDA by `openEscrowV2`'s own
 * `withKeyedMutex` + `pg_advisory_xact_lock`, so no new infra is introduced here.
 *
 * Returns the raw escrow-gate result — the caller (slice 2b) persists
 * `settlement.escrowPda` onto the bounty row (`escrow_pda`) + sets
 * `composition_state='vault_held'`. Idempotent: a retry re-publishes the same tier
 * (whole-menu replace is idempotent in effect) then derives the same nonce ⇒ same
 * PDA ⇒ the gate replays the open (no double-fund). If the house avatar has not
 * been seeded/provisioned, returns a typed `internal` failure (never funds). If the
 * tier publish fails, returns that typed failure WITHOUT opening the vault — never
 * fund a vault the create would reject 6148.
 */
export async function openComposedBountyEscrow(
  input: {
    bountyId: string;
    creatorAvatarId: string;
    tokenReward: number;
    /** Absolute bounty expiry (converted to unix-seconds); null/absent ⇒ no expiry. */
    expiresAt?: Date | null;
  },
  deps: ComposedBountyDeps = {},
): Promise<EscrowGateResult> {
  const house = await resolveHouseOrFail(deps.resolveHouseAvatarId);
  if (!house.ok) return house;

  const expiresAtUnix = input.expiresAt
    ? BigInt(Math.floor(input.expiresAt.getTime() / 1000))
    : 0n;

  const pricePerCall = usdcRewardBaseUnits(input.tokenReward);
  const _updateAgentPricingUsdc = deps.updateAgentPricingUsdc ?? updateAgentPricingUsdc;
  const _openEscrowV2 = deps.openEscrowV2 ?? openEscrowV2;

  return withKeyedMutex(housePricingMutexKey(house.houseAvatarId), async () => {
    // 1. Publish the house pricing tier at the bounty's EXACT price. The menu is
    // replaced whole, so the constant `HOUSE_PRICING_TIER_ID` at the new price is
    // the correct, legible on-chain state. Self-gates + dry-runs inside the
    // sap-client (this reads no flag).
    const priced = await _updateAgentPricingUsdc({
      workerAvatarId: house.houseAvatarId,
      tierId: HOUSE_PRICING_TIER_ID,
      pricePerCall,
    });
    if (priced.ok === false) {
      // Fail closed: if the tier could not be published, NEVER open the vault — a
      // create against a menu missing this price rejects `PricingTierNotFound` 6148,
      // which would strand the creator's USDC in a vault the create can't consume.
      //
      // CODE = 'internal' (mirrors `resolveHouseOrFail`) ON PURPOSE, not the raw
      // SapFailure code: `openEscrowV2` was NEVER reached, so there is PROVABLY no
      // vault custody (update_agent moves NO USDC). The create route classifies
      // delete-vs-keep off `PRE_BROADCAST_NO_CUSTODY`, whose members are exactly
      // `openEscrowV2`'s pre-broadcast codes; `'internal'` is in that set, so the
      // route DELETES the phantom bounty (correct — nothing to orphan). Surfacing a
      // raw tier-publish code outside that set (e.g. `rpc_unreachable`) would make
      // the route KEEP a `vault_pending` row implying possible custody that cannot
      // exist. The specific sap error is preserved in the message for diagnostics.
      return {
        ok: false,
        code: 'internal',
        message: `house pricing tier publish failed before composed escrow open (${priced.code}): ${priced.message}`,
      };
    }

    // 2. Open the vault. `price_per_call === the tier we just published`, so
    // `create_escrow_v2` finds its tier. SAFE UNDER THE LOCK RELEASE: `settle_calls_v2`
    // does NOT read the pricing_menu — the escrow captures its price at CREATE — so a
    // LATER bounty overwriting the menu can never break this escrow's settle/finalize.
    // The lock therefore only needs to cover THIS (tier-set → create), not the whole
    // escrow lifecycle. Idempotent: same nonce ⇒ same PDA ⇒ the gate replays.
    return _openEscrowV2({
      depositorAvatarId: input.creatorAvatarId,
      workerAvatarId: house.houseAvatarId,
      jobId: input.bountyId,
      pricePerCall,
      maxCalls: 1n,
      initialDeposit: bountyVaultDeposit(input.tokenReward),
      escrowNonce: bountyEscrowNonce(input.bountyId),
      expiresAt: expiresAtUnix,
      // SLICE 3: the composed vault takes the BOUNTY-specific dispute window (default
      // 1 slot ≈ instant) so approve → settle → finalize → hunter payout completes in
      // one shot; the global agent↔agent window is untouched. See bountyDisputeWindowSlots.
      disputeWindowSlots: bountyDisputeWindowSlots(),
    });
  });
}

/**
 * The PASS-verdict two-leg settle outcome. Discriminates EVERY money state so the
 * caller (slice 2b) can persist the right `composition_state` and know exactly
 * where the reward is:
 *   - `paid`                    → both legs done: house finalized the principal AND
 *     the leg-2 x402 paid the hunter the reward. Route: `composition_state='paid'`.
 *   - `awaiting_finalize`       → leg 1b settled (principal reserved on-chain), leg
 *     1c finalize NOT yet confirmed (DisputeWindow not elapsed ⇒ `finalize_not_ready`
 *     is AUTO-RETRYABLE; other `code`s ⇒ ops reconcile). The hunter is UNPAID, leg 2
 *     has NOT run, no double-pay is possible. Route: `composition_state='awaiting_finalize'`,
 *     a later re-call completes it once resolved.
 *   - `reconcile_payout_failed` → leg 1 FINALIZED (the house HAS the funds) but leg
 *     2 (payout) failed. Funds sit safely in the house wallet; leg 2 replays
 *     idempotently. Route: `composition_state='reconcile_payout_failed'` + alertError;
 *     ops re-runs `settleComposedBounty` (it replays legs 1a-1c then retries leg 2).
 *   - `failed`                  → leg 1a/1b failed BEFORE any settle. The creator's
 *     USDC is still fully in the vault; safe to retry. Route: leave the state as-is.
 */
export type SettleComposedBountyResult =
  | {
      ok: true;
      phase: 'paid';
      escrowPda: string;
      payoutEscrowPda: string;
      auditRootHex: string | null;
      dryRun: boolean;
    }
  | {
      ok: false;
      phase: 'awaiting_finalize';
      escrowPda: string;
      code: EscrowGateErrorCode;
      message: string;
    }
  | {
      ok: false;
      phase: 'reconcile_payout_failed';
      escrowPda: string;
      payoutEscrowPda: string | null;
      code: EscrowGateErrorCode;
      message: string;
    }
  | {
      ok: false;
      phase: 'failed';
      escrowPda: string;
      code: EscrowGateErrorCode;
      message: string;
    };

/**
 * LEG 1 (approve → settleV2 → finalizeV2) then LEG 2 (payai house→hunter) — the
 * PASS-verdict two-leg settle. `escrowPda` is the persisted LEG-1 V2 vault PDA
 * from `openComposedBountyEscrow`. Every phase is idempotent-replayable (see the
 * section header); the two legs use disjoint (escrowPda, jobId) keys so exactly
 * one USDC movement exists per leg and no double-pay is constructible.
 */
export async function settleComposedBounty(
  input: {
    bountyId: string;
    /** The persisted LEG-1 V2 vault PDA (from `openComposedBountyEscrow`). */
    escrowPda: string;
    creatorAvatarId: string;
    hunterAvatarId: string;
    tokenReward: number;
  },
  deps: ComposedBountyDeps = {},
): Promise<SettleComposedBountyResult> {
  // Test seams (production ⇒ the real escrow-gate fns). See `ComposedBountyDeps`.
  const _approveJob = deps.approveJob ?? approveJob;
  const _settleJobV2 = deps.settleJobV2 ?? settleJobV2;
  const _finalizeJobV2 = deps.finalizeJobV2 ?? finalizeJobV2;
  const _openEscrow = deps.openEscrow ?? openEscrow;
  const _settleJob = deps.settleJob ?? settleJob;

  const reward = usdcRewardBaseUnits(input.tokenReward);
  const payoutJobId = `${input.bountyId}:payout`;

  const house = await resolveHouseOrFail(deps.resolveHouseAvatarId);
  if (!house.ok) {
    return { ok: false, phase: 'failed', escrowPda: input.escrowPda, code: house.code, message: house.message };
  }
  const houseAvatarId = house.houseAvatarId;

  // ── LEG 1a — creator approves the vault release (idempotent-tolerant). ──────
  const approved = await _approveJob({
    escrowPda: input.escrowPda,
    jobId: input.bountyId,
    callerAvatarId: input.creatorAvatarId,
    approvedCalls: 1n,
  });
  // A REPLAY where the row already advanced past open|submitted makes approve
  // return `job_not_open` — NOT a failure: the depositor's approval persisted on
  // pass 1, and settleJobV2 re-reads it + replays the row. ANY OTHER approve
  // failure (approver_mismatch, self_dealing, gate_disabled, wallet_missing, …)
  // is real and safe-to-retry (funds still in the vault).
  if (approved.ok === false && approved.code !== 'job_not_open') {
    return { ok: false, phase: 'failed', escrowPda: input.escrowPda, code: approved.code, message: approved.message };
  }

  // ── LEG 1b — house settles the vault (reserve principal in a PendingSettlement). ──
  const settledV2 = await _settleJobV2({
    escrowPda: input.escrowPda,
    jobId: input.bountyId,
    callerAvatarId: houseAvatarId,
    callsToSettle: 1n,
  });
  if (settledV2.ok === false) {
    // Pre-settle failure or a leg-1 reconcile state (settle_unconfirmed, etc.).
    // The reward is still custodied on-chain (vault, or quarantined for ops); the
    // hunter is unpaid; safe to retry / reconcile. Never reaches leg 2.
    return { ok: false, phase: 'failed', escrowPda: input.escrowPda, code: settledV2.code, message: settledV2.message };
  }
  // Capture the leg-1 provenance now (survives the finalize + leg-2 steps). On a
  // fresh settle the row is `pending`; on a full replay it is already `settled`.
  const auditRootHex = settledV2.settlement.auditRootHex ?? null;
  const dryRun = settledV2.settlement.dryRun;

  // ── LEG 1c — finalize the reserved principal to the house (permissionless). ──
  // Skip when leg 1b already replayed `settled` (finalize completed on a prior pass).
  if (settledV2.phase === 'pending') {
    const finalized = await _finalizeJobV2({
      escrowPda: input.escrowPda,
      jobId: input.bountyId,
      callerAvatarId: houseAvatarId,
    });
    if (finalized.ok === false) {
      // The DisputeWindow has not elapsed (`finalize_not_ready`, auto-retryable) or
      // another crank holds it (`finalize_in_progress`); other finalize failures
      // (`finalize_unconfirmed`, disputed, …) need ops reconcile. In EVERY case leg
      // 2 has NOT run: the reward is still on-chain (vault-pending, or — for an
      // unconfirmed-but-landed finalize — at the house), the hunter is UNPAID, and
      // no double-pay is possible. The carried `code` distinguishes the cases.
      return {
        ok: false,
        phase: 'awaiting_finalize',
        escrowPda: input.escrowPda,
        code: finalized.code,
        message: finalized.message,
      };
    }
    // finalized.ok === true → the principal is provably at the house. Fall through.
  }

  // ── LEG 1d (AUTO-RECLAIM, non-fatal, SLICE 3) — leg 1 is provably finalized, so
  // the creator's ~0.5% headroom dust is now FREE vault balance. Reclaim it to the
  // creator idempotently (`${bountyId}:reclaim`). A failure NEVER changes the
  // settle outcome — the dust stays reclaimable (manually, or on the next pass).
  // Placed AFTER the finalize block (fires on BOTH the fresh-finalize and the
  // replayed-`settled` path) and BEFORE leg 2, so EVERY caller — the approve route
  // AND the resume crank, whether the settle ends `paid` or `reconcile_payout_failed`
  // — reclaims exactly once (the deterministic requestId dedupes re-runs). NOT
  // reached on the `awaiting_finalize` early-return above (leg 1 not yet finalized).
  await reclaimComposedBountyDustSafe(
    { bountyId: input.bountyId, creatorAvatarId: input.creatorAvatarId, tokenReward: input.tokenReward },
    deps,
  );

  // ── LEG 2 — house → hunter: ONE x402 exact USDC payment on the PayAI rail. ──
  // Reached ONLY after leg 1c is provably finalized (the house holds the reward).
  const payoutOpened = await _openEscrow({
    depositorAvatarId: houseAvatarId,
    workerAvatarId: input.hunterAvatarId,
    jobId: payoutJobId,
    pricePerCall: reward,
    maxCalls: 1n,
    initialDeposit: reward,
    expiresAt: 0n,
    rail: 'payai',
  });
  if (payoutOpened.ok === false) {
    // RECONCILE — leg 1 finalized (house HAS the funds) but the payout leg could
    // not open. Funds are safe in the house wallet; leg 2 replays idempotently.
    return { ok: false, phase: 'reconcile_payout_failed', escrowPda: input.escrowPda, payoutEscrowPda: null, code: payoutOpened.code, message: payoutOpened.message };
  }
  const payoutEscrowPda = escrowPdaOf(payoutOpened);
  if (!payoutEscrowPda) {
    return { ok: false, phase: 'reconcile_payout_failed', escrowPda: input.escrowPda, payoutEscrowPda: null, code: 'internal', message: 'payout escrow opened but no escrow PDA was recorded.' };
  }

  // LEG 2 approve — the house authorizes its OWN payout release (idempotent-tolerant,
  // same `job_not_open`-on-replay tolerance as leg 1a).
  const payoutApproved = await _approveJob({
    escrowPda: payoutEscrowPda,
    jobId: payoutJobId,
    callerAvatarId: houseAvatarId,
    approvedCalls: 1n,
  });
  if (payoutApproved.ok === false && payoutApproved.code !== 'job_not_open') {
    return { ok: false, phase: 'reconcile_payout_failed', escrowPda: input.escrowPda, payoutEscrowPda, code: payoutApproved.code, message: payoutApproved.message };
  }

  // LEG 2 settle — the hunter settles AS ITSELF; the payai rail drives the single
  // x402 house→hunter payment. At-most-once via the (payoutPda, jobId) claim.
  const payoutSettled = await _settleJob({
    escrowPda: payoutEscrowPda,
    jobId: payoutJobId,
    callerAvatarId: input.hunterAvatarId,
    callsToSettle: 1n,
  });
  if (payoutSettled.ok === false) {
    return { ok: false, phase: 'reconcile_payout_failed', escrowPda: input.escrowPda, payoutEscrowPda, code: payoutSettled.code, message: payoutSettled.message };
  }

  // ── SUCCESS — leg 1 finalized to the house, leg 2 paid the hunter the reward. ──
  return { ok: true, phase: 'paid', escrowPda: input.escrowPda, payoutEscrowPda, auditRootHex, dryRun };
}

/**
 * FAIL / cancel / expiry — refund the creator the FULL leg-1 deposit
 * (`bountyVaultDeposit` = reward + headroom) from the V2 vault via the idempotent
 * V2 withdraw path. The bounty flow only refunds a NEVER-settled job, so the whole
 * deposit is free (unspent) vault balance; the on-chain free-balance check bounds
 * any misuse (a partly-settled job's withdraw of more than its free balance simply
 * fails clean). The `requestId` is deterministic (`${bountyId}:refund`) so a
 * retried refund replays the recorded outcome — no double-withdraw.
 *
 * Returns the withdraw gate result. Uses only the deterministic nonce +
 * `creatorAvatarId` + the HOUSE wallet pubkey (the worker seed) to address the
 * vault; `escrowPda` is the persisted PDA for the caller's bookkeeping — the
 * withdraw re-derives the canonical PDA from the same nonce, so they agree by
 * construction.
 */
export async function refundComposedBounty(
  input: {
    bountyId: string;
    escrowPda: string;
    creatorAvatarId: string;
    tokenReward: number;
  },
  deps: ComposedBountyDeps = {},
): Promise<WithdrawEscrowV2IdempotentResult> {
  const house = await resolveHouseOrFail(deps.resolveHouseAvatarId);
  if (!house.ok) return house; // { ok:false, code:'internal', … } — house not provisioned

  // The V2 vault PDA is derived from (worker = HOUSE wallet, depositor = creator
  // wallet, nonce); the withdraw needs the house WALLET pubkey. `ensureWallet`
  // fast-paths the existing house wallet (identity-only — no money, no keypair gen
  // for an already-provisioned wallet).
  let houseWalletPubkey: string;
  try {
    houseWalletPubkey = (await (deps.ensureWallet ?? ensureWallet)('avatar', house.houseAvatarId)).publicKey;
  } catch (err) {
    return {
      ok: false,
      code: 'avatar_wallet_missing',
      message: `house custodial wallet unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return (deps.withdrawEscrowV2Idempotent ?? withdrawEscrowV2Idempotent)({
    depositorAvatarId: input.creatorAvatarId,
    workerWalletPubkey: houseWalletPubkey,
    escrowNonce: bountyEscrowNonce(input.bountyId),
    amount: bountyVaultDeposit(input.tokenReward),
    requestId: `${input.bountyId}:refund`,
  });
}

/**
 * The RECLAIMABLE dust a creator is owed back AFTER a composed bounty's leg 1
 * settle+finalize: the deposit's headroom spread that the settle did not debit.
 *
 *   deposit      = `bountyVaultDeposit` = principal + headroom (headroom = the
 *                  1% create-floor, which beats the 0.5% fee ⇒ ~0.5% of principal
 *                  survives the settle)
 *   settle debit = principal + `computeV2ProtocolFee` (0.5%)
 *   dust (free)  = deposit − principal − fee = headroom − fee  (≈ 0.5% of principal)
 *
 * Always ≥ 0 for a positive reward (the 1% floor > the 0.5% fee); clamped to 0 for
 * safety. This is the exact free-vault balance the on-chain withdraw can reclaim
 * once the principal has been settled to the house.
 */
export function bountyReclaimDustBaseUnits(tokenReward: number): bigint {
  const principal = usdcRewardBaseUnits(tokenReward);
  const dust = bountyVaultDeposit(tokenReward) - principal - computeV2ProtocolFee(principal);
  return dust > 0n ? dust : 0n;
}

/** `reclaimComposedBountyDust` result: a withdraw outcome, or a no-dust skip. */
export type ReclaimComposedBountyResult =
  | WithdrawEscrowV2IdempotentResult
  | { ok: true; skipped: 'no_dust' };

/**
 * AUTO-RECLAIM leg (SLICE 3) — after a composed bounty's leg 1 settle+finalize
 * releases the principal to the house, the creator's ~0.5% headroom spread is left
 * as FREE (unspent) balance in the V2 vault. This idempotently withdraws that dust
 * back to the creator (depositor-bound, reusing the proven
 * `withdrawEscrowV2Idempotent` primitive with a deterministic `${bountyId}:reclaim`
 * requestId so a replay never double-withdraws).
 *
 * NON-FATAL by contract: the caller (`applyComposedSettleOutcome`) fires this on
 * the transition into `paid` and IGNORES a failure — the dust stays reclaimable
 * manually and no bounty state changes. A `no_dust` (0-dust) reward skips the
 * chain call entirely. DRY-RUN is a full passthrough (no persistence, no move).
 */
export async function reclaimComposedBountyDust(
  input: { bountyId: string; creatorAvatarId: string; tokenReward: number },
  deps: ComposedBountyDeps = {},
): Promise<ReclaimComposedBountyResult> {
  const dust = bountyReclaimDustBaseUnits(input.tokenReward);
  if (dust <= 0n) return { ok: true, skipped: 'no_dust' };

  const house = await resolveHouseOrFail(deps.resolveHouseAvatarId);
  if (!house.ok) return house; // { ok:false, code:'internal', … }

  let houseWalletPubkey: string;
  try {
    houseWalletPubkey = (await (deps.ensureWallet ?? ensureWallet)('avatar', house.houseAvatarId)).publicKey;
  } catch (err) {
    return {
      ok: false,
      code: 'avatar_wallet_missing',
      message: `house custodial wallet unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return (deps.withdrawEscrowV2Idempotent ?? withdrawEscrowV2Idempotent)({
    depositorAvatarId: input.creatorAvatarId,
    workerWalletPubkey: houseWalletPubkey,
    escrowNonce: bountyEscrowNonce(input.bountyId),
    amount: dust,
    requestId: `${input.bountyId}:reclaim`,
  });
}

/**
 * NON-FATAL wrapper around `reclaimComposedBountyDust` used inside
 * `settleComposedBounty` (leg 1d): a reclaim failure/throw is logged and
 * swallowed, NEVER propagated — the dust stays reclaimable and the settle outcome
 * is unaffected. A `no_dust` skip is a silent no-op.
 */
async function reclaimComposedBountyDustSafe(
  input: { bountyId: string; creatorAvatarId: string; tokenReward: number },
  deps: ComposedBountyDeps,
): Promise<void> {
  try {
    const r = await reclaimComposedBountyDust(input, deps);
    if (r.ok === false) {
      console.warn(
        `[bounty-composition] dust reclaim failed for ${input.bountyId} ` +
          `(${r.code}): ${r.message} — non-fatal; dust stays reclaimable.`,
      );
    }
  } catch (err) {
    console.warn(`[bounty-composition] dust reclaim threw for ${input.bountyId} (non-fatal):`, err);
  }
}

/**
 * Resolve the CLAWVILLE house (Coralia) avatar id for the composition legs, or a
 * typed `internal` failure if it is not yet seeded/provisioned. Shared by all
 * three composed-rail functions so the house-missing posture is uniform + fails
 * closed (never funds/settles/refunds against a missing counterparty).
 */
async function resolveHouseOrFail(
  resolveFn: typeof resolveHouseAvatarId = resolveHouseAvatarId,
): Promise<
  { ok: true; houseAvatarId: string } | { ok: false; code: 'internal'; message: string }
> {
  let houseAvatarId: string | null;
  try {
    houseAvatarId = await resolveFn();
  } catch (err) {
    return {
      ok: false,
      code: 'internal',
      message: `house avatar lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!houseAvatarId) {
    return {
      ok: false,
      code: 'internal',
      message:
        'house agent not provisioned; run the API once so ensureHouseAgent() seeds ' +
        "Coralia's user + avatar, then ensureHouseSapIdentity().",
    };
  }
  return { ok: true, houseAvatarId };
}
