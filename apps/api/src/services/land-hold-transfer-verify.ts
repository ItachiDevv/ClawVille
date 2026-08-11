/**
 * Land hold-wallet ownership proof — DOOR 2 (exact-dust transfer + auto-refund).
 *
 * Founder ruling 2026-08-10: declaring a hold wallet you do not control let you
 * claim hold-door land backed by SOMEONE ELSE'S CLV balance, so proof is now
 * REQUIRED before the hold door opens. Door 1 (sign a nonce) is free and
 * instant. THIS file is door 2, the fallback for a user who will not connect a
 * browser wallet: they send an exact, unique dust amount of SOL FROM the
 * declared wallet TO a ClawVille verification address, we attribute it by exact
 * amount + sender, grant verification on FINALIZED confirmation, then refund the
 * same amount back.
 *
 * ── THIS IS A REAL MAINNET SOL MONEY PATH ────────────────────────────────────
 * Get it wrong in one direction and we hand out free verification; get it wrong
 * in the other and we bleed the verify wallet dry. Every rule below is load
 * bearing. The exactly-once discipline is lifted from the reviewed
 * `sap/sap-gas-sponsor.ts` slice (claim lease + capture-before-send + throttled
 * condition alerts) and from the market-payout / wallet-withdraw executors
 * (forward-only recovery, ambiguous ⇒ reconcile, NEVER re-sign or re-send).
 *
 *   T4  MAINNET RPC. CLV and these wallets live on MAINNET. This file builds its
 *       OWN mainnet connection from `HELIUS_API_KEY`, mirroring the seam in
 *       `linked-wallet-clv-balance.ts:51`. It MUST NOT read
 *       `loadSapConfig().rpcUrl` — SAP is cluster-gated to devnet and a
 *       devnet/mainnet mismatch means real user dust lands at an address we
 *       never watch. There is deliberately no `sap-config` import here.
 *   T5  DRAIN GUARD. Every refund burns ~5000 lamports of OUR fee, so unbounded
 *       attempts bleed the wallet. Two caps: a per-user UTC-day challenge cap
 *       and a global rolling-24h refund+fee spend cap. Either cap hit pages ops
 *       through the throttled `alertError` condition emitter.
 *   T6  EXACT-AMOUNT UNIQUENESS. lamports = base + a random 1..9999 lamport
 *       discriminator, admitted through a partial unique index on `lamports`
 *       for pending rows, regenerating on collision. Two concurrent challenges
 *       from the SAME sender therefore get DIFFERENT amounts and attribute
 *       independently.
 *   T7  ONE SIGNATURE, ONE CHALLENGE. A unique index on `inbound_signature`
 *       means a replayed or duplicate scan is a no-op.
 *   T8  FINALIZED ONLY. Attribution reads signatures and transactions at
 *       `finalized` commitment. A `confirmed`-only grant can be rolled back by
 *       a reorg while the verification persists, so it is never granted.
 *   T9  FAIL CLOSED ON THE GRANT, FAIL SOFT ON THE REFUND. A refund failure
 *       NEVER blocks or revokes verification. The refund is idempotent keyed by
 *       the inbound signature, captures its signature BEFORE sending, and an
 *       ambiguous outcome goes to `reconcile` + an ops page. It NEVER blindly
 *       retries and NEVER re-signs or re-sends a captured signature.
 *   T10 NEVER LOG OR ECHO SECRETS. The verify wallet secret is `treasury_wallets`
 *       envelope-encrypted; the loader reuses the gas sponsor's pubkey-mismatch
 *       refusal throw verbatim. No return value, log line, or alert context in
 *       this file carries key material.
 *
 * ── ATTRIBUTION ──────────────────────────────────────────────────────────────
 * A transaction settles a challenge only when ALL of these hold:
 *   - it did not fail (`meta.err` is null),
 *   - it contains a SystemProgram `transfer` whose source is the declared
 *     wallet, destination is our verify address, and lamports is EXACTLY the
 *     challenge amount — searched across BOTH top-level instructions AND every
 *     inner instruction, because a transfer may be one leg of a many-leg
 *     transaction and may be CPI-nested,
 *   - the declared wallet SIGNED the transaction (a plain system transfer always
 *     requires it, so this is belt and braces; `transferWithSeed` is deliberately
 *     NOT accepted because its source is a derived account the base signs for),
 *   - the SAME transaction carries an SPL Memo naming THIS challenge id,
 *   - the block time is inside the challenge window.
 *
 * ── VERIFICATION IS SUBMISSION-BASED, NOT SCAN-DISCOVERED (round 3) ──────────
 * The user (or agent) TELLS US THE SIGNATURE via
 * `POST /verify/transfer/:challengeId/submit`, and we fetch THAT EXACT
 * transaction at `finalized` and run the predicates below on it.
 *
 * The previous design discovered deposits by blind-scanning the verify address's
 * recent signatures, which is inherently lossy under adversarial or merely busy
 * traffic: a cursor that resets each invocation, a page cap, a match window, a
 * candidate batch, and fact truncation each relocated the same failure rather
 * than removing it. A signature the user hands us cannot be eclipsed by spam,
 * and it costs nothing in UX — every wallet, explorer and SDK surfaces the
 * signature immediately after sending.
 *
 * The background scan SURVIVES but is DEMOTED to refund-obligation discovery:
 * money that arrived and was never submitted still has to be found and returned.
 * It attributes such a deposit as `unclaimed` (refund owed, NEVER verified), so
 * its bounds are a refund-latency concern, not a correctness hole. Only
 * `submitTransferSignature` can move a challenge to `observed`/`verified`.
 *
 * Money that cannot be bound to a challenge at all (another sender's legs in the
 * same transaction, or dust at a rotated verify address) is written to
 * `land_hold_wallet_refund_obligations`. An alert is never the only record of
 * retained user funds.
 *
 * ── KNOWN LIMITATION: AUTOMATIC ORPHAN DISCOVERY IS BEST-EFFORT ──────────────
 * Automatic discovery of orphaned deposits is BEST-EFFORT and incomplete. It can
 * miss facts older than the scan reaches, verify addresses that are no longer
 * referenced by a recent challenge, and transactions too large to record whole.
 * What is best-effort is only whether we NOTICE it automatically and open a
 * refund obligation without a person looking. VERIFICATION IS UNAFFECTED — that
 * path is submission-based, so a user who submits their signature is never
 * dependent on any of this.
 *
 * FUNDS ARE NOT LOST, WITH ONE OPERATIONAL PRECONDITION. The money stays on
 * chain at the verify address it was paid to, so it is recoverable — but ONLY
 * while we still hold that address's private key. For the CURRENT verify wallet
 * that is guaranteed (`treasury_wallets`, envelope-encrypted). For a RETIRED
 * verify address it is guaranteed ONLY IF the operator retained the old key.
 * Rotation IS representable, and the schema now supports the obligation rather
 * than contradicting it. `treasury_wallets.retired_at` marks a wallet rotated
 * out, and the `land-hold-verify` singleton index is scoped to ACTIVE rows
 * (`retired_at IS NULL`), so exactly one wallet is live while every retired row
 * persists beside it. `provision-hold-verify-wallet.ts --rotate` retires the
 * current row instead of colliding with the singleton, and
 * `listVerifyDestinations()` returns the active address plus every retired one
 * so rotated-destination discovery can see them.
 *
 * What the code still cannot enforce is DELETION, so this remains an
 * OPERATIONAL OBLIGATION on whoever rotates the wallet:
 *
 *   The retired row and its encrypted key MUST be retained (never deleted,
 *   never re-purposed) for at least as long as any
 *   `land_hold_wallet_refund_obligations` row referencing that destination is
 *   unsettled. Destroying a retired key makes the dust at that address
 *   permanently unrecoverable, and `destination_rotated` obligations name
 *   exactly the addresses this applies to.
 *
 * Two further known gaps in the same subsystem:
 *   - The sweeper lease is PROCESS-LOCAL (`sweepInFlight`), so multiple pods
 *     duplicate scan work. It is wasteful, not incorrect: every write is an
 *     idempotent CAS or an ON CONFLICT DO NOTHING.
 *   - `land_hold_wallet_verify_scans.matched` is WRITTEN but never READ by the
 *     facts query. It is bookkeeping for operators today, not control flow.
 *   - The submitted-signature RPC budget is per-pod and per-account (the
 *     20/min verify limiter), so a fleet-wide submission burst is not centrally
 *     bounded.
 *
 * The follow-up that makes discovery COMPLETE is a durable scan cursor
 * (persisting how far back each destination has been walked, instead of
 * restarting the `before` cursor every invocation) plus a distributed sweeper
 * lease (so exactly one pod owns a destination's scan at a time). Tracked by the
 * FEATURE_GATE below.
 *
 * FEATURE_GATE: land_hold_verify_orphan_discovery
 * Status: Best-effort automatic orphan discovery. Verification does not depend
 *   on it; funds stay on chain and are recoverable while the destination's key
 *   is retained, only potentially unnoticed until an operator looks. Bounded
 *   scan, per-invocation cursor, process-local sweeper lease. Retired-verify-key
 *   retention is an OPERATIONAL obligation, not enforced by code (see above).
 * Metric to graduate: zero `unclaimed_inbound` obligations discovered late by a
 *   manual audit that the automatic sweep had missed, over 30 days of door-2 use
 *   on prod; plus a durable cursor + distributed lease implemented.
 * Current reading: door 2 is not yet live on prod, so the count is 0 of 0.
 * Review deadline: 2026-10-01
 * On deadline: either implement the durable cursor + distributed sweeper lease,
 *   or (if door-2 volume stays negligible) delete automatic discovery entirely
 *   and make operator reconciliation the documented, only path. Do NOT renew
 *   this gate without a fresh reading.
 * Reference: ARCHITECTURE.md (land hold-wallet ownership proof entry)
 *
 * ── WHY THE MEMO IS LOAD BEARING (adversarial review 2026-08-10) ─────────────
 * Amount + sender alone prove only "this wallet sent us N lamports" — they do
 * NOT prove the sender meant to bind that wallet to THIS account. An attacker
 * who declares a whale's pubkey first (winning the users_land_hold_wallet_pubkey
 * _unique race) can phish or support-desk the whale into sending exactly
 * 0.010042 SOL to our verify address; every amount/sender/destination check
 * would pass and the attacker's declaration would be stamped verified against
 * the whale's balance. That is precisely the defect this whole slice exists to
 * close. Door 1 is immune because the signed text NAMES the claiming account; a
 * bare SOL transfer names nothing.
 *
 * So the memo is the STATEMENT OF INTENT and the exact amount is only the
 * matching index. `transactionCarriesChallengeMemo` is the single, deliberately
 * isolated predicate for that requirement: it fails CLOSED, and relaxing it (if
 * the founder ever rules that the Phantom-style send UIs without a memo field
 * make it unusable) is a one-line change there and nowhere else.
 *
 * ── STATE MACHINE ────────────────────────────────────────────────────────────
 *   pending  → observed  (inbound attributed inside the TTL, memo present)
 *            → expired   (TTL lapsed with nothing attributed, OR an inbound
 *                         arrived late — money still gets refunded, but NO
 *                         verification is granted)
 *            → rejected  (an EXACT-amount inbound from the declared wallet
 *                         arrived but cannot be proof: `memo_missing` (no memo
 *                         naming this challenge) or `source_not_signer` (a
 *                         program/smart-wallet signed for the source). The
 *                         signature is still consumed so the money is REFUNDED,
 *                         and the user is told exactly what went wrong instead
 *                         of waiting out the TTL.)
 *   observed → verified  (users verification columns written, method 'transfer')
 *            → failed    (the declared wallet changed under us; fail closed,
 *                         refund still owed)
 * Refund runs off `inbound_signature` and is orthogonal to the grant:
 *   none → sending → sent | reconcile, or none → skipped when a cap refuses it.
 *
 * Doc trail: ARCHITECTURE.md (routes + tables + service catalog), CLAUDE.md env
 * rows for the four LAND_HOLD_VERIFY_* knobs, GameFeatures.md land tenure.
 */

import { randomInt, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from '@solana/web3.js';
import { db, sql } from '@clawville/database';
import { decryptSecretKey } from './keypair-vault';
import { alertError, type AlertErrorParams } from './alert-error';

// ---------------------------------------------------------------------------
// Frozen public contract (spec §9). The route layer codes against exactly these.
// ---------------------------------------------------------------------------

export type TransferDoorAvailability = { available: boolean; destination: string | null };

export type OpenTransferChallengeResult = {
  challengeId: string;
  destination: string;
  lamports: number;
  amountSol: number;
  /** The SPL Memo text the transfer MUST carry. Without it the send is refunded, never accepted. */
  memo: string;
  expiresAt: string;
};

export type TransferChallengeState =
  | 'pending'
  | 'observed'
  | 'verified'
  | 'expired'
  | 'failed'
  | 'rejected'
  /**
   * The background scan found this challenge's money on chain, but the user
   * never SUBMITTED the signature, so it is refunded and NOT verified.
   * Verification is submission-only by design — see the header.
   */
  | 'unclaimed';
export type TransferRejectedReason =
  | 'memo_missing'
  | 'source_not_signer'
  | 'transfer_not_top_level';
export type TransferRefundState = 'none' | 'sending' | 'sent' | 'reconcile' | 'skipped';

export type TransferChallengeStatus = {
  challengeId: string;
  state: TransferChallengeState;
  /** Why an EXACT-amount inbound could not be proof. Non-null only when state is 'rejected'. */
  rejectedReason: TransferRejectedReason | null;
  refundState: TransferRefundState | null;
  inboundSignature: string | null;
  refundSignature: string | null;
  destination: string;
  lamports: number;
  memo: string;
  expiresAt: string;
};

export class LandHoldVerifyError extends Error {
  constructor(
    public code: string,
    public status: number,
    public detail?: unknown,
  ) {
    super(code);
    this.name = 'LandHoldVerifyError';
  }
}

// ---------------------------------------------------------------------------
// Configuration (spec §6). Documented in CLAUDE.md + .env.example.
// ---------------------------------------------------------------------------

const BASE_LAMPORTS_DEFAULT = 10_000_000; // 0.01 SOL
const BASE_LAMPORTS_FLOOR = 1_000_000; // 0.001 SOL
const TTL_MS_DEFAULT = 45 * 60 * 1000;
const TTL_MS_FLOOR = 5 * 60 * 1000;
const DAILY_REFUND_CAP_SOL_DEFAULT = 0.5;
const DAILY_REFUND_CAP_SOL_FLOOR = 0.01;
const USER_DAILY_ATTEMPTS_DEFAULT = 5;
const USER_DAILY_ATTEMPTS_FLOOR = 1;

/** Base fee for the one-signature refund transfer. Charged to the verify wallet. */
export const REFUND_FEE_LAMPORTS = 5_000n;

/** Span of the random trailing-lamport discriminator that makes amounts unique (T6). */
const UNIQUE_LAMPORT_SPAN = 9_999;
/** Bounded regenerate-on-collision attempts for the unique amount (T6). */
const UNIQUE_AMOUNT_ATTEMPTS = 12;

/** How long past expiry a challenge is still scanned so a LATE transfer is refunded. */
const LATE_ARRIVAL_GRACE_MS = 30 * 60 * 1000;

/**
 * How long a challenge must have been CLOSED before the scan may terminalize it
 * as `unclaimed`.
 *
 * Without this the sweep could mark a challenge `unclaimed` (refund owed, never
 * verified) while the user was still inside their window, and their perfectly
 * good submission moments later would find nothing left to settle — the
 * scanner destroying a valid proof. The margin covers block-time skew plus the
 * ordinary gap between sending and pasting a signature.
 */
const UNCLAIMED_CLOSED_MARGIN_MS = 5 * 60 * 1000;

/**
 * How old inbound funds must be before `discoverUnclaimedInbound` may call them
 * ORPHANED and record a refund obligation.
 *
 * DERIVED from the configured TTL, never a standalone constant: a fixed 30
 * minutes was SHORTER than the 45-minute default TTL, so a live challenge's
 * money could be booked as an obligation and then ALSO auto-refunded through
 * the challenge, leaving an open duplicate debt. By construction this can never
 * undercut the TTL — asserted by a test.
 */
export function landHoldVerifyOrphanThresholdMs(): number {
  return landHoldVerifyTtlMs() + LATE_ARRIVAL_GRACE_MS + UNCLAIMED_CLOSED_MARGIN_MS;
}
/** Clock-skew tolerance when comparing a block time against the challenge window. */
const BLOCK_TIME_SKEW_MS = 60 * 1000;

/** Stale-claim takeover window for the refund lease (mirrors the other executors). */
const REFUND_CLAIM_STALE_MS = 5 * 60 * 1000;
/** How long a captured-but-unresolved refund signature may stay `sending`. */
const REFUND_RESOLVE_STALE_MS = 10 * 60 * 1000;

const SCAN_SIGNATURE_LIMIT = 100;
const SCAN_PARSE_LIMIT = 50;
/** Backwards pages per pass: 20 x 100 signatures of reachable history. */
const SCAN_MAX_PAGES = 20;
/** Durable facts considered per match phase. */
const SCAN_MATCH_LIMIT = 200;
/** Retention for the durable scan ledger; well past the longest live window. */
const SCAN_LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Verify addresses examined per obligation sweep (rotation makes this > 1). */
const OBLIGATION_DESTINATION_LIMIT = 4;

// Bounds on the persisted facts, so a hostile transaction cannot bloat the row.
const SCAN_FACT_MAX_SIGNERS = 16;
const SCAN_FACT_MAX_TRANSFERS = 32;
const SCAN_FACT_MAX_MEMOS = 8;
const SCAN_FACT_MAX_MEMO_CHARS = 512;
const SWEEP_CHALLENGE_LIMIT = 50;
const SWEEP_INTERVAL_MS = 60_000;

/** Minimum gap between on-demand scans for ONE challenge (poll rate limit). */
const POLL_SCAN_MIN_INTERVAL_MS = 5_000;

const DOOR_AVAILABILITY_TTL_MS = 60_000;
const GLOBAL_REFUND_CAP_LOCK_KEY = 'land:hold-verify:daily-refund-cap';

const ALERT_WINDOW_MS = 60 * 60 * 1000;
const ALERT_THROTTLE_MAX = 1_024;
const ALERT_SOURCE = 'land-hold-transfer-verify';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function configuredInt(name: string, fallback: number, floor: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(Math.floor(parsed), floor);
}

function configuredSol(name: string, fallback: number, floor: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.max(parsed, floor) : fallback;
}

export function landHoldVerifyBaseLamports(): number {
  return configuredInt('LAND_HOLD_VERIFY_BASE_LAMPORTS', BASE_LAMPORTS_DEFAULT, BASE_LAMPORTS_FLOOR);
}

export function landHoldVerifyTtlMs(): number {
  return configuredInt('LAND_HOLD_VERIFY_TTL_MS', TTL_MS_DEFAULT, TTL_MS_FLOOR);
}

export function landHoldVerifyDailyRefundCapLamports(): bigint {
  return BigInt(
    Math.ceil(
      configuredSol(
        'LAND_HOLD_VERIFY_DAILY_REFUND_CAP_SOL',
        DAILY_REFUND_CAP_SOL_DEFAULT,
        DAILY_REFUND_CAP_SOL_FLOOR,
      ) * LAMPORTS_PER_SOL,
    ),
  );
}

export function landHoldVerifyUserDailyAttempts(): number {
  return configuredInt(
    'LAND_HOLD_VERIFY_USER_DAILY_ATTEMPTS',
    USER_DAILY_ATTEMPTS_DEFAULT,
    USER_DAILY_ATTEMPTS_FLOOR,
  );
}

// ---------------------------------------------------------------------------
// Throttled condition alerts (same shape as the gas sponsor's emitConditionAlert)
// ---------------------------------------------------------------------------

const alertLastSentAt = new Map<string, number>();
let alertCapacitySuppressed = 0;

async function emitConditionAlert(key: string, params: AlertErrorParams): Promise<void> {
  const now = deps.now();
  for (const [condition, sentAt] of alertLastSentAt) {
    if (now - sentAt >= ALERT_WINDOW_MS) alertLastSentAt.delete(condition);
  }
  const last = alertLastSentAt.get(key);
  if (last != null && now - last < ALERT_WINDOW_MS) return;
  if (!alertLastSentAt.has(key) && alertLastSentAt.size >= ALERT_THROTTLE_MAX) {
    alertCapacitySuppressed += 1;
    console.warn(
      `[${ALERT_SOURCE}] alert throttle at capacity; suppressed=${alertCapacitySuppressed} key=${key}`,
    );
    return;
  }
  try {
    await deps.alert(params);
    alertLastSentAt.delete(key);
    alertLastSentAt.set(key, now);
  } catch {
    // A broken alert channel must never break the money path.
  }
}

// ---------------------------------------------------------------------------
// Rows + store seam. Every statement is raw SQL so this service compiles and
// runs before the sibling lane's Drizzle table module lands (spec allows it).
// ---------------------------------------------------------------------------

export interface ChallengeRow {
  id: string;
  userId: string;
  walletPubkey: string;
  lamports: number;
  /** What we actually received in the attributed tx; the refund pays THIS. */
  inboundLamports: number | null;
  destinationPubkey: string;
  status: TransferChallengeState;
  rejectedReason: TransferRejectedReason | null;
  expiresAt: Date;
  createdAt: Date;
  inboundSignature: string | null;
  refundState: TransferRefundState | null;
  refundSignature: string | null;
  refundClaimId: string | null;
  refundClaimedAt: Date | null;
  /** Immutable authorization stamp; the cap is summed over these, not created_at. */
  refundCapDay: string | null;
  refundCapLamports: bigint | null;
  refundAuthorizedAt: Date | null;
}

/** Lamports the refund must return: what we received, falling back to the ask. */
export function refundLamportsOf(row: ChallengeRow): number {
  return row.inboundLamports != null && row.inboundLamports > 0
    ? row.inboundLamports
    : row.lamports;
}

export interface VerifyWalletRow {
  publicKey: string;
  encryptedSecretKey: string;
  encryptionIv: string;
  encryptionTag: string;
}

export type OpenChallengeOutcome =
  | { kind: 'ok'; row: ChallengeRow }
  | { kind: 'wallet_not_declared' }
  | { kind: 'attempt_cap'; used: number; cap: number }
  | { kind: 'amount_exhausted' };

export type GrantOutcome = 'granted' | 'wallet_changed' | 'missing' | 'not_observed';

export type RefundAdmission =
  /** `claimedAt` is the lease this worker JUST took — never a pre-takeover stamp. */
  | { kind: 'claimed'; claimedAt: Date; capDay: string; capLamports: bigint }
  | { kind: 'claim_lost' }
  | { kind: 'cap'; capDay: string; usedLamports: bigint; capLamports: bigint }
  /** This pod's configured cap disagrees with the day's DB-owned policy. */
  | { kind: 'cap_mismatch'; capDay: string; recordedLamports: bigint; callLamports: bigint };

/**
 * Attribution outcome. `refundQuarantined` means an operator had ALREADY settled
 * an obligation for these funds, so the automatic refund is held at `reconcile`
 * rather than paying the same deposit a second time.
 */
export type AttributeOutcome = { bound: boolean; refundQuarantined: boolean };

/** Capture outcome. `collision` means another row already owns those exact bytes. */
export type RefundCaptureOutcome = 'captured' | 'lost' | 'collision';

/**
 * The durable facts a parsed transaction contributes, scoped to ONE verify
 * address. Persisting these (rather than a bare "seen" flag) is what lets a
 * later challenge be matched against an earlier parse: the parse cost is paid
 * once, but the matching opportunity never expires.
 */
export interface ScanFacts {
  failed: boolean;
  signers: string[];
  /**
   * Legs addressed to ANY verify address we know about, each carrying its own
   * destination. Scoping these to a single destination hid the case where ONE
   * transaction funds a live challenge at the CURRENT address and also pays a
   * RETIRED one: the retired leg was invisible, so its debt was never recorded.
   */
  transfers: Array<{ destination: string; source: string; lamports: number; topLevel: boolean }>;
  memos: ProbedMemo[];
}

export interface ScanLedgerRow {
  signature: string;
  blockTimeMs: number | null;
  facts: ScanFacts;
}

/** Why user funds are sitting with us that no challenge row can return. */
export type RefundObligationReason =
  /** Another sender's legs in a transaction we settled for someone else. */
  | 'retained_leg'
  /** Paid to a verify address whose key we no longer hold. */
  | 'destination_rotated'
  /** Arrived, never submitted, and now past every live challenge window. */
  | 'unclaimed_inbound';

export interface RefundObligationInput {
  destination: string;
  signature: string;
  recipientPubkey: string;
  lamports: number;
  reason: RefundObligationReason;
  challengeId: string | null;
}

export interface LandHoldVerifyStore {
  findVerifyWallet(): Promise<VerifyWalletRow | null>;
  openChallenge(input: {
    userId: string;
    declaredWallet: string;
    destination: string;
    baseLamports: number;
    ttlMs: number;
    attemptCap: number;
    /** Amounts held by a still-SCANNABLE lapsed row are not reusable yet. */
    graceMs: number;
  }): Promise<OpenChallengeOutcome>;
  getChallengeForUser(challengeId: string, userId: string): Promise<ChallengeRow | null>;
  expireLapsedChallenges(): Promise<number>;
  /** CLOSED challenges only — `closedForMs` keeps a live window off the scan. */
  listScannableChallenges(
    limit: number,
    graceMs: number,
    closedForMs: number,
  ): Promise<ChallengeRow[]>;
  listGrantableChallenges(limit: number): Promise<ChallengeRow[]>;
  listRefundableChallenges(limit: number, staleMs: number): Promise<ChallengeRow[]>;
  listUnresolvedRefunds(limit: number): Promise<ChallengeRow[]>;
  isSignatureAttributed(signature: string): Promise<boolean>;
  attributeInbound(input: {
    challengeId: string;
    /** Serializes submit against the sweep on the per-user lock. */
    userId: string;
    signature: string;
    /** TOTAL received from the sender in that transaction — the refund pays this. */
    inboundLamports: number;
    /** `unclaimed` is the scan-only, refund-owed, never-verified outcome. */
    nextStatus: 'observed' | 'expired' | 'rejected' | 'unclaimed';
    rejectedReason: TransferRejectedReason | null;
    /**
     * Refuse unless the challenge has been CLOSED at least this long. The scan
     * sets it so it can never terminalize a window the user is still inside;
     * submission leaves it undefined because the user owns their own window.
     */
    onlyIfClosedForMs?: number;
    /** Written in the SAME transaction, so retained funds cannot be lost. */
    obligations?: RefundObligationInput[];
    /** Scopes the settled-obligation guard and the void to ONE verify address. */
    destination: string;
    /**
     * Every transfer leg of the attributed transaction. Rotated-destination
     * debts are derived from these against a FRESH in-transaction read of the
     * verify addresses, so a rotation can never be missed by a stale cache.
     */
    legs?: ReadonlyArray<{ destination: string; source: string; lamports: number }>;
  }): Promise<AttributeOutcome>;
  /** Signatures at this destination not yet parsed — the durable work queue. */
  filterUnscannedSignatures(destination: string, signatures: string[]): Promise<Set<string>>;
  /** Persist one parse. Idempotent on (destination, signature). */
  recordScannedSignature(input: {
    destination: string;
    signature: string;
    blockTimeMs: number | null;
    facts: ScanFacts;
  }): Promise<void>;
  /** Durable facts inside the window, NEWEST first, for matching. */
  listScannedSignatures(input: {
    destination: string;
    fromMs: number;
    toMs: number;
    limit: number;
  }): Promise<ScanLedgerRow[]>;
  markSignatureMatched(destination: string, signature: string): Promise<void>;
  /** Retention sweep so the scan ledger stays bounded. Returns rows removed. */
  pruneScanLedger(olderThanMs: number): Promise<number>;
  /**
   * DURABLE record of user funds we hold that no challenge row can return.
   * Idempotent on (signature, recipient, reason). Returns true when newly
   * recorded. An alert must never be the only record of retained user funds.
   */
  recordRefundObligation(input: RefundObligationInput): Promise<boolean>;
  /** Verify addresses seen on recent challenges — the scan's search space. */
  listRecentDestinations(sinceMs: number): Promise<string[]>;
  /**
   * EVERY `land-hold-verify` treasury pubkey, current and RETIRED. Attribution
   * uses it to spot legs of the same transaction that paid a different verify
   * address, which this challenge's refund can never return.
   */
  listVerifyDestinations(): Promise<string[]>;
  /** Today's DB-owned cap policy, or null when the day has none yet. */
  readTodayCapPolicy(): Promise<bigint | null>;
  grantVerification(input: {
    challengeId: string;
    userId: string;
    walletPubkey: string;
  }): Promise<GrantOutcome>;
  admitRefund(input: {
    challengeId: string;
    claimId: string;
    feeLamports: bigint;
    capLamports: bigint;
    staleMs: number;
  }): Promise<RefundAdmission>;
  captureRefundSignature(input: {
    challengeId: string;
    claimId: string;
    signature: string;
  }): Promise<RefundCaptureOutcome>;
  /**
   * Terminal transition, BOUND to the worker that owns the row: `claimId` for a
   * pre-capture state, the exact `signature` for a post-capture one. Without the
   * binding a stale worker could mark a row `skipped`/`reconcile` after another
   * took over, or while its own captured send was still landing.
   */
  finishRefund(input: {
    challengeId: string;
    state: 'sent' | 'reconcile' | 'skipped';
    claimId?: string;
    signature?: string;
    /**
     * Written in the SAME transaction as the terminalization. `skipped` money is
     * still owed, and refundable selection requires `refund_state='none'`, so a
     * separate write that failed left the debt unrecorded and unretryable.
     */
    obligations?: RefundObligationInput[];
  }): Promise<boolean>;
  releaseRefundClaim(challengeId: string, claimId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Narrow RPC seam — only what this service uses, so tests can stub it whole.
// ---------------------------------------------------------------------------

export interface SignatureRef {
  signature: string;
  err: unknown;
  blockTime?: number | null;
  confirmationStatus?: string | null;
}

export interface LandHoldVerifyRpc {
  getSignaturesForAddress(
    address: PublicKey,
    options: { limit: number; before?: string },
    commitment: 'finalized',
  ): Promise<SignatureRef[]>;
  /** Verify-wallet float check — the door closes when we cannot pay refund fees. */
  getBalance(address: PublicKey, commitment: 'confirmed'): Promise<number>;
  getParsedTransaction(
    signature: string,
    config: { commitment: 'finalized'; maxSupportedTransactionVersion: number },
  ): Promise<ParsedTransactionWithMeta | null>;
  getLatestBlockhash(
    commitment: 'confirmed',
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendRawTransaction(raw: Buffer): Promise<string>;
  confirmTransaction(
    strategy: { signature: string; blockhash: string; lastValidBlockHeight: number },
    commitment: 'confirmed',
  ): Promise<{ value: { err: unknown } }>;
  getSignatureStatuses(
    signatures: string[],
    config: { searchTransactionHistory: boolean },
  ): Promise<{ value: Array<{ err: unknown; confirmationStatus?: string | null } | null> }>;
}

export interface LandHoldVerifyDeps {
  store: LandHoldVerifyStore;
  rpc: () => LandHoldVerifyRpc;
  loadVerifyKeypair: () => Promise<Keypair>;
  alert: (params: AlertErrorParams) => Promise<void>;
  now: () => number;
}

// ---------------------------------------------------------------------------
// T4 — MAINNET RPC. Mirrors linked-wallet-clv-balance.ts:51. Never sap-config.
// ---------------------------------------------------------------------------

let connectionCache: Connection | null = null;

/** The mainnet endpoint this service talks to. Exported so a test can assert T4. */
export function landHoldVerifyRpcUrl(): string {
  const key = process.env.HELIUS_API_KEY?.trim();
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : 'https://api.mainnet-beta.solana.com';
}

function getConnection(): Connection {
  if (!connectionCache) {
    connectionCache = new Connection(landHoldVerifyRpcUrl(), 'confirmed');
  }
  return connectionCache;
}

// ---------------------------------------------------------------------------
// Verify keypair — envelope decrypt + pubkey-mismatch refusal (T10).
// ---------------------------------------------------------------------------

let verifyKeypairCache: Keypair | null = null;

async function loadVerifyKeypair(): Promise<Keypair> {
  if (verifyKeypairCache) return verifyKeypairCache;
  const row = await deps.store.findVerifyWallet();
  if (!row) {
    throw new LandHoldVerifyError('transfer_door_unavailable', 503, {
      reason:
        "treasury_wallets purpose='land-hold-verify' is missing; run apps/api/scripts/land/provision-hold-verify-wallet.ts",
    });
  }
  const keypair = decryptSecretKey(row.encryptedSecretKey, row.encryptionIv, row.encryptionTag);
  const actual = keypair.publicKey.toBase58();
  if (actual !== row.publicKey) {
    // Only PUBLIC keys appear here. Never the secret (T10).
    throw new Error(
      `land-hold-verify pubkey mismatch: decrypted ${actual} != row public_key ${row.publicKey}; refusing to sign`,
    );
  }
  verifyKeypairCache = keypair;
  return keypair;
}

// ---------------------------------------------------------------------------
// Attribution — pure, exported, and directly unit tested.
// ---------------------------------------------------------------------------

export interface ProbedTransfer {
  source: string;
  destination: string;
  lamports: number;
  /**
   * True only for an instruction in the SIGNED transaction message. A CPI-
   * emitted leg is `false` — it was produced by a program the signer invoked,
   * not written by the signer.
   */
  topLevel: boolean;
}

export interface ProbedMemo {
  text: string;
  topLevel: boolean;
}

export interface TransferProbe {
  failed: boolean;
  blockTimeMs: number | null;
  signers: string[];
  /** Every SystemProgram transfer, top level and CPI-nested, flagged by depth. */
  transfers: ProbedTransfer[];
  /** Every SPL Memo, top level and CPI-nested, flagged by depth. */
  memos: ProbedMemo[];
}

/**
 * SPL Memo program ids. v2 is what every current wallet and CLI emits; v1 is
 * accepted as well because an older client emitting it authored the same
 * statement of intent. Both programs only log their instruction data.
 */
export const REFUND_MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const MEMO_PROGRAM_IDS = new Set([
  REFUND_MEMO_PROGRAM_ID,
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

/** Longest base58 memo payload we will decode. A memo is a few dozen bytes. */
const MEMO_DATA_MAX_CHARS = 2_048;

/** The exact memo text a door-2 transfer must carry: the challenge id itself. */
export function challengeMemo(challengeId: string): string {
  return challengeId;
}

function memoTextOf(ix: ParsedInstruction | PartiallyDecodedInstruction): string | null {
  if ('parsed' in ix) {
    // The memo program's parsed form is the memo STRING itself, not the
    // `{ type, info }` object every other parsed program uses.
    const parsed = (ix as ParsedInstruction).parsed as unknown;
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const info = (parsed as { info?: unknown }).info;
      if (typeof info === 'string') return info;
    }
    return null;
  }
  // Raw (partially decoded) form: base58 instruction data holding UTF-8 bytes.
  const data = (ix as PartiallyDecodedInstruction).data;
  if (typeof data !== 'string' || data.length === 0) return null;
  if (data.length > MEMO_DATA_MAX_CHARS) return null;
  try {
    return new TextDecoder().decode(bs58.decode(data));
  } catch {
    return null;
  }
}

type DepthTaggedInstruction = {
  ix: ParsedInstruction | PartiallyDecodedInstruction;
  topLevel: boolean;
};

/**
 * Every instruction, tagged by DEPTH. The distinction is load bearing, not
 * cosmetic: a top-level instruction is text the signer put in the message they
 * signed, while an inner instruction was emitted by a program they invoked. See
 * the header note on the CPI-memo bypass.
 */
function instructionsOf(tx: ParsedTransactionWithMeta): DepthTaggedInstruction[] {
  const top = ((tx.transaction?.message?.instructions ?? []) as Array<
    ParsedInstruction | PartiallyDecodedInstruction
  >).map((ix) => ({ ix, topLevel: true }));
  // Inner instructions still matter for IDENTIFICATION: a transfer may be
  // CPI-nested, and we must still recognise the money so we can refund it.
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) =>
    ((group?.instructions ?? []) as Array<ParsedInstruction | PartiallyDecodedInstruction>).map(
      (ix) => ({ ix, topLevel: false }),
    ),
  );
  return [...top, ...inner];
}

/**
 * Reduce a parsed transaction to the facts attribution needs. Only plain
 * SystemProgram `transfer` legs are collected — `transferWithSeed` is
 * deliberately excluded because its source is a derived account signed for by a
 * different base key, so it is not proof that the declared wallet's key was used.
 */
export function probeTransaction(tx: ParsedTransactionWithMeta | null): TransferProbe | null {
  if (!tx) return null;
  const signers: string[] = [];
  for (const account of tx.transaction?.message?.accountKeys ?? []) {
    if (account?.signer) signers.push(String(account.pubkey));
  }
  const transfers: ProbedTransfer[] = [];
  const memos: ProbedMemo[] = [];
  for (const { ix, topLevel } of instructionsOf(tx)) {
    if (!ix) continue;
    const programId = 'programId' in ix && ix.programId != null ? String(ix.programId) : '';
    if (MEMO_PROGRAM_IDS.has(programId)) {
      const memo = memoTextOf(ix);
      if (memo) memos.push({ text: memo, topLevel });
      continue;
    }
    if (!('parsed' in ix)) continue;
    const parsed = ix as ParsedInstruction;
    if (parsed.program !== 'system') continue;
    const body = parsed.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
    if (!body || body.type !== 'transfer' || !body.info) continue;
    const source = body.info.source;
    const destination = body.info.destination;
    const lamports = Number(body.info.lamports);
    if (typeof source !== 'string' || typeof destination !== 'string') continue;
    if (!Number.isSafeInteger(lamports) || lamports <= 0) continue;
    transfers.push({ source, destination, lamports, topLevel });
  }
  return {
    failed: tx.meta?.err != null,
    blockTimeMs: typeof tx.blockTime === 'number' ? tx.blockTime * 1000 : null,
    signers,
    transfers,
    memos,
  };
}

/**
 * Does this transaction carry the challenge's dust leg? Successful transaction,
 * EXACT-lamports SystemProgram transfer, declared wallet → our verify address.
 *
 * This is the MATCHING INDEX, deliberately separate from the two PROOF
 * predicates below. A transaction that matches the leg is money we can identify
 * as this user's, so it is always attributed and refunded even when it cannot
 * be proof.
 */
export function transactionMatchesTransferLeg(
  probe: TransferProbe | null,
  params: { from: string; to: string; lamports: number },
): boolean {
  if (!probe) return false;
  if (probe.failed) return false;
  return probe.transfers.some(
    (t) =>
      t.source === params.from &&
      t.destination === params.to &&
      t.lamports === params.lamports,
  );
}

/**
 * PROOF PREDICATE 0 — the qualifying leg is in the SIGNED MESSAGE, not emitted
 * by a program the signer invoked. Pairs with the top-level memo rule: proof
 * must be something the key holder wrote, end to end.
 */
export function transactionHasTopLevelTransferLeg(
  probe: TransferProbe | null,
  params: { from: string; to: string; lamports: number },
): boolean {
  if (!probe) return false;
  if (probe.failed) return false;
  return probe.transfers.some(
    (t) =>
      t.topLevel &&
      t.source === params.from &&
      t.destination === params.to &&
      t.lamports === params.lamports,
  );
}

/**
 * TOTAL lamports this transaction actually moved from `from` to `to`, counting
 * EVERY leg at every depth.
 *
 * The refund pays this, not the challenge amount. One transaction can carry the
 * exact amount twice (or carry extra legs to us): matching used `.some()` and
 * the ledger binds one challenge per signature, so we were paid `2 x lamports`
 * and refunded `1 x lamports`, silently keeping the rest. An alert must never be
 * the only record of retained user funds.
 */
export function receivedLamportsFrom(
  probe: TransferProbe | null,
  params: { from: string; to: string },
): number {
  if (!probe || probe.failed) return 0;
  let total = 0;
  for (const t of probe.transfers) {
    if (t.source === params.from && t.destination === params.to) total += t.lamports;
  }
  return total;
}

/**
 * PROOF PREDICATE 1 — the source key itself signed. A plain system transfer
 * always requires this, so a matching leg WITHOUT the source among the signers
 * means a program signed for it (a Squads vault or another smart wallet). We
 * cannot treat that as proof of key control, and such a wallet cannot use door
 * 1 either, so the caller turns it into a `source_not_signer` rejection with a
 * clear message rather than an endless pending state.
 */
export function transactionSignedBySource(probe: TransferProbe | null, from: string): boolean {
  return probe != null && probe.signers.includes(from);
}

/**
 * PROOF PREDICATE 2 — the sender NAMED this challenge in the message they
 * SIGNED. The amount only says "someone sent us N lamports"; the memo is what
 * makes the transfer a statement of intent by the key holder, which is what
 * kills the phished-whale attack.
 *
 * ONLY TOP-LEVEL MEMOS COUNT. A CPI-emitted memo is not the signer's statement:
 * an attacker who declares a victim's wallet can induce the victim to sign an
 * opaque call to an attacker-controlled program, and that program can CPI both
 * the exact transfer AND a memo naming the challenge. The victim never saw a
 * memo, yet we would have granted verification — reopening the exact phishing
 * hole the memo exists to close. Inner memos are still PARSED (so a scan can
 * describe what happened) but they can never establish intent.
 *
 * Matching stays forgiving about surrounding text and case so a wallet that
 * decorates the field still passes.
 *
 * THIS IS THE SINGLE PLACE THE MEMO REQUIREMENT LIVES. If the founder ever
 * rules that memo-less send UIs make door 2 unusable, relaxing it is one line
 * here and nowhere else.
 */
export function transactionCarriesChallengeMemo(
  probe: TransferProbe | null,
  challengeId: string,
): boolean {
  if (!probe) return false;
  const token = challengeMemo(challengeId).trim().toLowerCase();
  if (!token) return false;
  return probe.memos.some((memo) => memo.topLevel && memo.text.toLowerCase().includes(token));
}

/**
 * Full proof: a TOP-LEVEL exact leg AND the source signed AND a TOP-LEVEL memo
 * naming this challenge. Kept as one call for readers and tests; the attribution
 * loop uses the parts separately so it can tell the user WHICH one failed.
 */
export function transactionSettlesChallenge(
  probe: TransferProbe | null,
  params: { from: string; to: string; lamports: number; challengeId: string },
): boolean {
  return (
    transactionHasTopLevelTransferLeg(probe, params) &&
    transactionSignedBySource(probe, params.from) &&
    transactionCarriesChallengeMemo(probe, params.challengeId)
  );
}

/** Is the observed block time inside the challenge's acceptance window? */
export function blockTimeInsideWindow(
  blockTimeMs: number | null,
  row: Pick<ChallengeRow, 'createdAt' | 'expiresAt'>,
  fallbackNowMs: number,
): boolean {
  const at = blockTimeMs ?? fallbackNowMs;
  return (
    at >= row.createdAt.getTime() - BLOCK_TIME_SKEW_MS &&
    at <= row.expiresAt.getTime() + BLOCK_TIME_SKEW_MS
  );
}

// ---------------------------------------------------------------------------
// Real store — raw SQL against `land_hold_wallet_transfer_challenges` (spec §2).
// ---------------------------------------------------------------------------

type RawChallenge = {
  id: string;
  user_id: string;
  wallet_pubkey: string;
  lamports: string | number | bigint;
  inbound_lamports: string | number | bigint | null;
  destination_pubkey: string;
  status: string;
  rejected_reason: string | null;
  expires_at: string | Date;
  created_at: string | Date;
  inbound_signature: string | null;
  refund_state: string | null;
  refund_signature: string | null;
  refund_cap_day: string | null;
  refund_cap_lamports: string | number | bigint | null;
  refund_authorized_at: string | Date | null;
  refund_claim_id: string | null;
  refund_claimed_at: string | Date | null;
};

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapChallenge(raw: RawChallenge): ChallengeRow {
  return {
    id: raw.id,
    userId: raw.user_id,
    walletPubkey: raw.wallet_pubkey,
    lamports: Number(raw.lamports),
    inboundLamports: raw.inbound_lamports == null ? null : Number(raw.inbound_lamports),
    destinationPubkey: raw.destination_pubkey,
    status: raw.status as TransferChallengeState,
    rejectedReason: (raw.rejected_reason as TransferRejectedReason | null) ?? null,
    expiresAt: toDate(raw.expires_at),
    createdAt: toDate(raw.created_at),
    inboundSignature: raw.inbound_signature,
    refundState: (raw.refund_state as TransferRefundState | null) ?? null,
    refundSignature: raw.refund_signature,
    refundClaimId: raw.refund_claim_id,
    refundClaimedAt: raw.refund_claimed_at == null ? null : toDate(raw.refund_claimed_at),
    refundCapDay: raw.refund_cap_day == null ? null : String(raw.refund_cap_day),
    refundCapLamports:
      raw.refund_cap_lamports == null ? null : BigInt(String(raw.refund_cap_lamports)),
    refundAuthorizedAt:
      raw.refund_authorized_at == null ? null : toDate(raw.refund_authorized_at),
  };
}

const CHALLENGE_COLUMNS = sql`id, user_id, wallet_pubkey, lamports, inbound_lamports,
  destination_pubkey, status, rejected_reason, expires_at, created_at, inbound_signature,
  refund_state, refund_signature, refund_cap_day, refund_cap_lamports, refund_authorized_at,
  refund_claim_id, refund_claimed_at`;

function isUniqueViolation(err: unknown): boolean {
  const error = err as { code?: string; cause?: { code?: string } } | undefined;
  return error?.code === '23505' || error?.cause?.code === '23505';
}

/**
 * T6 — mint a challenge amount that is UNIQUE among open challenges.
 *
 * `attempt` performs ONE insert with the candidate amount and returns null when
 * the partial unique index over `lamports WHERE status = 'pending'` rejects it.
 * Amounts already known to have collided are never retried, so two concurrent
 * challenges from the SAME sender always end up with different amounts and can
 * be attributed independently. Exported so the regenerate-on-collision loop is
 * exercised directly rather than through a test double.
 */
export async function insertWithUniqueAmount<T>(
  baseLamports: number,
  attempt: (lamports: number) => Promise<T | null>,
  maxAttempts: number = UNIQUE_AMOUNT_ATTEMPTS,
): Promise<T | null> {
  const tried = new Set<number>();
  for (let i = 0; i < maxAttempts; i += 1) {
    let lamports = baseLamports + randomInt(1, UNIQUE_LAMPORT_SPAN + 1);
    for (let guard = 0; tried.has(lamports) && guard < UNIQUE_LAMPORT_SPAN; guard += 1) {
      lamports = baseLamports + randomInt(1, UNIQUE_LAMPORT_SPAN + 1);
    }
    tried.add(lamports);
    const row = await attempt(lamports);
    if (row) return row;
  }
  return null;
}

const databaseStore: LandHoldVerifyStore = {
  async findVerifyWallet() {
    // `purpose::text` on purpose (T4 sibling concern): comparing as text can
    // never throw "invalid input value for enum treasury_purpose" on a database
    // that has not taken the enum migration yet, so the read degrades to
    // "door unavailable" instead of 500-ing the hold-wallet GET.
    const rows = await db.execute<{
      public_key: string;
      encrypted_secret_key: string;
      encryption_iv: string;
      encryption_tag: string;
    }>(sql`
      SELECT public_key, encrypted_secret_key, encryption_iv, encryption_tag
      FROM treasury_wallets
      WHERE purpose::text = 'land-hold-verify' AND retired_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`);
    const row = rows[0];
    if (!row) return null;
    return {
      publicKey: row.public_key,
      encryptedSecretKey: row.encrypted_secret_key,
      encryptionIv: row.encryption_iv,
      encryptionTag: row.encryption_tag,
    };
  },

  async openChallenge(input) {
    return db.transaction(async (tx): Promise<OpenChallengeOutcome> => {
      // Same advisory key `declareLandHoldWallet` takes, so opening a challenge
      // serializes against a concurrent wallet re-declaration.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`);

      const declared = await tx.execute<{ land_hold_wallet_pubkey: string | null }>(
        sql`SELECT land_hold_wallet_pubkey FROM users WHERE id = ${input.userId} FOR SHARE`,
      );
      const current = declared[0]?.land_hold_wallet_pubkey ?? null;
      if (current == null || current !== input.declaredWallet) {
        return { kind: 'wallet_not_declared' };
      }

      // T5 — per-user UTC-day attempt cap, counted under the user's lock so two
      // concurrent opens cannot both pass the check.
      const counted = await tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n
        FROM land_hold_wallet_transfer_challenges
        WHERE user_id = ${input.userId}
          AND created_at >= (date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')`);
      const used = Number(counted[0]?.n ?? '0');
      if (used >= input.attemptCap) {
        return { kind: 'attempt_cap', used, cap: input.attemptCap };
      }

      const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
      // T6 — regenerate on collision against the partial unique index over
      // `lamports WHERE status = 'pending'`. ON CONFLICT DO NOTHING keeps the
      // transaction alive across a collision (a raw 23505 would abort it).
      //
      // The NOT EXISTS guard widens that index from "pending" to "still
      // SCANNABLE": expiring a lapsed row frees its amount for the index while
      // the row keeps being scanned for the late-arrival grace window, so a
      // re-issued identical amount would let the OLDER row win the
      // single-signature binding and the NEWER user would be refunded but never
      // verified. An amount is reusable only once nothing is watching for it.
      const row = await insertWithUniqueAmount(input.baseLamports, async (lamports) => {
        const inserted = await tx.execute<RawChallenge>(sql`
          INSERT INTO land_hold_wallet_transfer_challenges
            (id, user_id, wallet_pubkey, lamports, destination_pubkey, status,
             expires_at, refund_state, created_at, updated_at)
          SELECT gen_random_uuid(), ${input.userId}, ${input.declaredWallet}, ${lamports},
                 ${input.destination}, 'pending', ${expiresAt}::timestamptz,
                 'none', now(), now()
          WHERE NOT EXISTS (
            SELECT 1 FROM land_hold_wallet_transfer_challenges
            WHERE lamports = ${lamports}
              AND inbound_signature IS NULL
              AND status IN ('pending', 'expired')
              AND expires_at > now() - (${input.graceMs} * interval '1 millisecond')
          )
          ON CONFLICT DO NOTHING
          RETURNING ${CHALLENGE_COLUMNS}`);
        return inserted[0] ?? null;
      });
      return row ? { kind: 'ok', row: mapChallenge(row) } : { kind: 'amount_exhausted' };
    });
  },

  async getChallengeForUser(challengeId, userId) {
    const rows = await db.execute<RawChallenge>(sql`
      SELECT ${CHALLENGE_COLUMNS}
      FROM land_hold_wallet_transfer_challenges
      WHERE id = ${challengeId}::uuid AND user_id = ${userId}
      LIMIT 1`);
    const row = rows[0];
    return row ? mapChallenge(row) : null;
  },

  async expireLapsedChallenges() {
    const rows = await db.execute<{ id: string }>(sql`
      UPDATE land_hold_wallet_transfer_challenges
      SET status = 'expired', updated_at = now()
      WHERE status = 'pending' AND inbound_signature IS NULL AND expires_at < now()
      RETURNING id`);
    return rows.length;
  },

  async listScannableChallenges(limit, graceMs, closedForMs) {
    // CLOSED rows only. A challenge still inside its window belongs to the USER:
    // they may be about to submit, and terminalizing it as `unclaimed` under
    // them would destroy a valid proof. Once closed, the row stays scannable for
    // the grace window so a LATE transfer is still attributed and REFUNDED — it
    // never grants verification (T8).
    const rows = await db.execute<RawChallenge>(sql`
      SELECT ${CHALLENGE_COLUMNS}
      FROM land_hold_wallet_transfer_challenges
      WHERE inbound_signature IS NULL
        AND status IN ('pending', 'expired')
        AND expires_at <= now() - (${closedForMs} * interval '1 millisecond')
        AND expires_at > now() - (${graceMs} * interval '1 millisecond')
      ORDER BY created_at ASC
      LIMIT ${limit}`);
    return rows.map(mapChallenge);
  },

  async listGrantableChallenges(limit) {
    const rows = await db.execute<RawChallenge>(sql`
      SELECT ${CHALLENGE_COLUMNS}
      FROM land_hold_wallet_transfer_challenges
      WHERE status = 'observed'
      ORDER BY created_at ASC
      LIMIT ${limit}`);
    return rows.map(mapChallenge);
  },

  async listRefundableChallenges(limit, staleMs) {
    const rows = await db.execute<RawChallenge>(sql`
      SELECT ${CHALLENGE_COLUMNS}
      FROM land_hold_wallet_transfer_challenges
      WHERE inbound_signature IS NOT NULL
        AND refund_state = 'none'
        AND (refund_claimed_at IS NULL
             OR refund_claimed_at < now() - (${staleMs} * interval '1 millisecond'))
      ORDER BY created_at ASC
      LIMIT ${limit}`);
    return rows.map(mapChallenge);
  },

  async listUnresolvedRefunds(limit) {
    const rows = await db.execute<RawChallenge>(sql`
      SELECT ${CHALLENGE_COLUMNS}
      FROM land_hold_wallet_transfer_challenges
      WHERE refund_state = 'sending' AND refund_signature IS NOT NULL
      ORDER BY created_at ASC
      LIMIT ${limit}`);
    return rows.map(mapChallenge);
  },

  async filterUnscannedSignatures(destination, signatures) {
    if (signatures.length === 0) return new Set<string>();
    // Parameterized one-by-one via sql.join — a raw JS array fed to `= ANY(...)`
    // is a known runtime crash in this codebase (see routes/cosmetics.ts).
    const list = sql.join(
      signatures.map((signature) => sql`${signature}`),
      sql`, `,
    );
    const rows = await db.execute<{ signature: string }>(sql`
      SELECT signature FROM land_hold_wallet_verify_scans
      WHERE destination_pubkey = ${destination} AND signature IN (${list})`);
    const seen = new Set(rows.map((row) => row.signature));
    return new Set(signatures.filter((signature) => !seen.has(signature)));
  },

  async recordScannedSignature({ destination, signature, blockTimeMs, facts }) {
    await db.execute(sql`
      INSERT INTO land_hold_wallet_verify_scans
        (destination_pubkey, signature, block_time, facts, matched, scanned_at)
      VALUES (${destination}, ${signature},
              ${blockTimeMs == null ? null : new Date(blockTimeMs).toISOString()}::timestamptz,
              ${JSON.stringify(facts)}::jsonb, false, now())
      ON CONFLICT (destination_pubkey, signature) DO UPDATE
        SET facts = EXCLUDED.facts, block_time = EXCLUDED.block_time`);
  },

  async listScannedSignatures({ destination, fromMs, toMs, limit }) {
    // A NULL block_time is kept: the RPC omits it occasionally and dropping the
    // row would lose a real payment. Ordering puts the newest first so a fresh
    // payment settles before an older look-alike.
    const rows = await db.execute<{
      signature: string;
      block_time: string | Date | null;
      facts: ScanFacts | string;
    }>(sql`
      SELECT signature, block_time, facts
      FROM land_hold_wallet_verify_scans
      WHERE destination_pubkey = ${destination}
        AND (
          block_time IS NULL
          OR block_time BETWEEN ${new Date(fromMs).toISOString()}::timestamptz
                            AND ${new Date(toMs).toISOString()}::timestamptz
        )
      ORDER BY block_time DESC NULLS LAST, scanned_at DESC
      LIMIT ${limit}`);
    return rows.map((row) => ({
      signature: row.signature,
      blockTimeMs: row.block_time == null ? null : toDate(row.block_time).getTime(),
      facts: (typeof row.facts === 'string' ? JSON.parse(row.facts) : row.facts) as ScanFacts,
    }));
  },

  async markSignatureMatched(destination, signature) {
    await db.execute(sql`
      UPDATE land_hold_wallet_verify_scans SET matched = true
      WHERE destination_pubkey = ${destination} AND signature = ${signature}`);
  },

  async recordRefundObligation(input) {
    const rows = await db.execute<{ id: string }>(sql`
      INSERT INTO land_hold_wallet_refund_obligations
        (destination_pubkey, signature, recipient_pubkey, lamports, reason, state, challenge_id)
      VALUES (${input.destination}, ${input.signature}, ${input.recipientPubkey},
              ${input.lamports}, ${input.reason}, 'open',
              ${input.challengeId == null ? null : sql`${input.challengeId}::uuid`})
      ON CONFLICT (destination_pubkey, signature, recipient_pubkey, reason) DO NOTHING
      RETURNING id`);
    return rows.length === 1;
  },

  async listVerifyDestinations() {
    // `purpose::text` for the same reason findVerifyWallet uses it: a database
    // that has not taken the enum migration must degrade, never throw.
    const rows = await db.execute<{ public_key: string }>(sql`
      SELECT public_key FROM treasury_wallets
      WHERE purpose::text = 'land-hold-verify'
      ORDER BY (retired_at IS NULL) DESC, created_at DESC`);
    return rows.map((row) => row.public_key);
  },

  async listRecentDestinations(sinceMs) {
    const rows = await db.execute<{ destination_pubkey: string }>(sql`
      SELECT DISTINCT destination_pubkey
      FROM land_hold_wallet_transfer_challenges
      WHERE created_at > now() - (${sinceMs} * interval '1 millisecond')`);
    return rows.map((row) => row.destination_pubkey);
  },

  async readTodayCapPolicy() {
    const rows = await db.execute<{ cap_lamports: string }>(sql`
      SELECT cap_lamports::text AS cap_lamports FROM land_hold_verify_cap_policies
      WHERE cap_day = (now() AT TIME ZONE 'utc')::date`);
    const value = rows[0]?.cap_lamports;
    return value == null ? null : BigInt(value);
  },

  async pruneScanLedger(olderThanMs) {
    const rows = await db.execute<{ signature: string }>(sql`
      DELETE FROM land_hold_wallet_verify_scans
      WHERE scanned_at < now() - (${olderThanMs} * interval '1 millisecond')
      RETURNING signature`);
    return rows.length;
  },

  async isSignatureAttributed(signature) {
    const rows = await db.execute<{ hit: number }>(sql`
      SELECT 1 AS hit FROM land_hold_wallet_transfer_challenges
      WHERE inbound_signature = ${signature} LIMIT 1`);
    return rows.length > 0;
  },

  async attributeInbound({
    challengeId,
    userId,
    destination,
    signature,
    inboundLamports,
    nextStatus,
    rejectedReason,
    onlyIfClosedForMs,
    obligations = [],
    legs = [],
  }) {
    try {
      return await db.transaction(async (tx): Promise<AttributeOutcome> => {
        // EXPLICIT ORDERING, not timing luck: submit and sweep serialize on the
        // same per-user lock, so whichever takes it first wins the CAS below and
        // the loser sees `inbound_signature` already set.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
        const closedGuard =
          onlyIfClosedForMs == null
            ? sql``
            : // The scan may ONLY terminalize a challenge whose window has
              // actually closed. Enforced in SQL, not merely in the list query,
              // so a stale batch row can never terminalize a live challenge.
              sql`AND expires_at <= now() - (${onlyIfClosedForMs} * interval '1 millisecond')`;
        const rows = await tx.execute<{ id: string }>(sql`
          UPDATE land_hold_wallet_transfer_challenges
          SET inbound_signature = ${signature}, status = ${nextStatus},
              inbound_lamports = ${inboundLamports},
              rejected_reason = ${rejectedReason}, updated_at = now()
          WHERE id = ${challengeId}::uuid AND inbound_signature IS NULL
            ${closedGuard}
          RETURNING id`);
        if (rows.length !== 1) return { bound: false, refundQuarantined: false };

        // FRESH, IN-TRANSACTION read of every verify address we own. A cached
        // set populated before a rotation is stale, and attributing against a
        // stale set consumes the signature globally while the retired-address
        // debt is never generated — unrecoverable, because ON CONFLICT cannot
        // resurrect a row nobody tried to insert. Reading it here makes the
        // debt derivation atomic with the attribution it belongs to.
        const knownRows = await tx.execute<{ public_key: string }>(sql`
          SELECT public_key FROM treasury_wallets
          WHERE purpose::text = 'land-hold-verify'`);
        const knownDestinations = new Set(knownRows.map((row) => row.public_key));
        const allObligations = [
          ...obligations,
          ...rotatedDestinationObligations(
            legs,
            destination,
            knownDestinations,
            signature,
            challengeId,
          ),
        ];

        // ATOMIC with the attribution. Retained funds used to be written after
        // the fact, so a crash or a transient error between the two left an
        // alert as the only record of money we owe. The unique index carries the
        // retry.
        for (const obligation of allObligations) {
          await tx.execute(sql`
            INSERT INTO land_hold_wallet_refund_obligations
              (destination_pubkey, signature, recipient_pubkey, lamports, reason, state, challenge_id)
            VALUES (${obligation.destination}, ${obligation.signature},
                    ${obligation.recipientPubkey}, ${obligation.lamports},
                    ${obligation.reason}, 'open',
                    ${obligation.challengeId == null ? null : sql`${obligation.challengeId}::uuid`})
            ON CONFLICT (destination_pubkey, signature, recipient_pubkey, reason) DO NOTHING`);
        }

        // DOUBLE-PAY GUARD, in the SAME transaction and under the SAME lock as
        // the attribution. If an operator has ALREADY SETTLED an obligation for
        // these funds, letting this row enter the automatic refund queue would
        // pay the same deposit twice. Quarantine the refund instead: the proof
        // still stands, but only a person may release money after that.
        const settled = await tx.execute<{ hit: number }>(sql`
          SELECT 1 AS hit FROM land_hold_wallet_refund_obligations
          WHERE destination_pubkey = ${destination}
            AND signature = ${signature}
            AND state = 'settled'
          LIMIT 1`);
        const refundQuarantined = settled.length > 0;
        if (refundQuarantined) {
          await tx.execute(sql`
            UPDATE land_hold_wallet_transfer_challenges
            SET refund_state = 'reconcile', updated_at = now()
            WHERE id = ${challengeId}::uuid AND refund_state = 'none'`);
        }

        // These funds are refunded THROUGH the challenge now, so an OPEN orphan
        // claim on them is not a debt. Scoped by DESTINATION as well: one
        // transaction can fund several historical verify addresses, and voiding
        // by signature alone erased a debt belonging to a different address.
        await tx.execute(sql`
          UPDATE land_hold_wallet_refund_obligations
          SET state = 'void', updated_at = now()
          WHERE destination_pubkey = ${destination}
            AND signature = ${signature}
            AND reason = 'unclaimed_inbound'
            AND state = 'open'`);
        return { bound: true, refundQuarantined };
      });
    } catch (err) {
      // T7 — the unique index on inbound_signature already bound this signature
      // to another challenge. A replayed scan is a no-op, never an error.
      if (isUniqueViolation(err)) return { bound: false, refundQuarantined: false };
      throw err;
    }
  },

  async grantVerification({ challengeId, userId, walletPubkey }) {
    return db.transaction(async (tx): Promise<GrantOutcome> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const rows = await tx.execute<{ land_hold_wallet_pubkey: string | null }>(
        sql`SELECT land_hold_wallet_pubkey FROM users WHERE id = ${userId} FOR UPDATE`,
      );
      if (rows.length === 0) return 'missing';
      if (rows[0]!.land_hold_wallet_pubkey !== walletPubkey) {
        // Fail CLOSED: the declaration moved under us, so this proof no longer
        // proves the declared wallet. The refund is still owed and still runs.
        await tx.execute(sql`
          UPDATE land_hold_wallet_transfer_challenges
          SET status = 'failed', updated_at = now()
          WHERE id = ${challengeId}::uuid AND status = 'observed'`);
        return 'wallet_changed';
      }
      const claimed = await tx.execute<{ id: string }>(sql`
        UPDATE land_hold_wallet_transfer_challenges
        SET status = 'verified', updated_at = now()
        WHERE id = ${challengeId}::uuid AND status = 'observed'
        RETURNING id`);
      if (claimed.length !== 1) return 'not_observed';
      // All three verification columns move together — the schema CHECK requires
      // all-NULL or all-NON-NULL. The grandfather column is NEVER written here
      // (T2 permits application code to NULL it, never to set it).
      await tx.execute(sql`
        UPDATE users
        SET land_hold_wallet_verified_at = now(),
            land_hold_wallet_verified_method = 'transfer',
            land_hold_wallet_verified_pubkey = ${walletPubkey},
            updated_at = now()
        WHERE id = ${userId}`);
      return 'granted';
    });
  },

  async admitRefund({ challengeId, claimId, feeLamports, capLamports, staleMs }) {
    return db.transaction(async (tx): Promise<RefundAdmission> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${GLOBAL_REFUND_CAP_LOCK_KEY}, 0))`,
      );
      // The DB owns the day's cap, exactly like `bounty_gas_cap_policies`: the
      // first cap-consuming admission of a UTC day writes the value, and a pod
      // carrying a DIFFERENT configured cap (a rolling deploy mid-day) must
      // agree with it or be refused, so the number the spend was measured
      // against is always reconstructable after the fact.
      await tx.execute(sql`
        INSERT INTO land_hold_verify_cap_policies (cap_day, cap_lamports, created_at, updated_at)
        VALUES ((now() AT TIME ZONE 'utc')::date, ${capLamports}::bigint, now(), now())
        ON CONFLICT (cap_day) DO NOTHING`);
      const policyRows = await tx.execute<{ cap_day: string; cap_lamports: string }>(sql`
        SELECT cap_day::text AS cap_day, cap_lamports::text AS cap_lamports
        FROM land_hold_verify_cap_policies
        WHERE cap_day = (now() AT TIME ZONE 'utc')::date`);
      const policy = policyRows[0];
      if (!policy) throw new Error('land hold verify cap policy was not readable after claim');
      const capDay = policy.cap_day;
      const recordedLamports = BigInt(policy.cap_lamports);
      if (recordedLamports !== capLamports) {
        return { kind: 'cap_mismatch', capDay, recordedLamports, callLamports: capLamports };
      }

      // Spend is summed over the AUTHORIZATION stamp, never over `created_at`.
      // Counting by row creation let a deferred backlog age out of the window
      // and then spend past the cap all at once when processing resumed.
      //
      // ONLY THE FEE IS COUNTED. The principal is the user's own dust going
      // straight back to the wallet it came from, so it is not a cost to us —
      // counting it made the 0.5 SOL default cap out at ~49 refunds a day, which
      // ten accounts at the per-user cap could saturate, parking ordinary users'
      // money and paging ops. The per-user attempt cap is the anti-spam lever.
      //
      // Rows merely CLAIMED (lease taken, bytes not yet captured) count too, so
      // two concurrent admissions cannot both squeeze past a nearly-full cap.
      const usage = await tx.execute<{ used_lamports: string }>(sql`
        SELECT (COUNT(*) * ${feeLamports}::bigint)::text AS used_lamports
        FROM land_hold_wallet_transfer_challenges
        WHERE refund_cap_day = ${capDay}::date
          AND id <> ${challengeId}::uuid
          AND (
            refund_state IN ('sending', 'sent', 'reconcile')
            OR (refund_state = 'none'
                AND refund_claim_id IS NOT NULL
                AND refund_claimed_at > now() - (${staleMs} * interval '1 millisecond'))
          )`);
      const usedLamports = BigInt(usage[0]?.used_lamports ?? '0');
      if (usedLamports + feeLamports > recordedLamports) {
        return { kind: 'cap', capDay, usedLamports, capLamports: recordedLamports };
      }
      const claimed = await tx.execute<{ refund_claimed_at: string | Date }>(sql`
        UPDATE land_hold_wallet_transfer_challenges
        SET refund_claim_id = ${claimId}::uuid, refund_claimed_at = now(),
            refund_cap_day = ${capDay}::date,
            refund_cap_lamports = ${recordedLamports}::bigint,
            refund_authorized_at = now(),
            updated_at = now()
        WHERE id = ${challengeId}::uuid
          AND inbound_signature IS NOT NULL
          AND refund_state = 'none'
          AND (refund_claimed_at IS NULL
               OR refund_claimed_at < now() - (${staleMs} * interval '1 millisecond'))
        RETURNING refund_claimed_at`);
      const claimedAt = claimed[0]?.refund_claimed_at;
      // The lease stamp is returned so the caller ages the resolve window from
      // the claim it JUST took, never from a pre-takeover stamp.
      return claimedAt != null
        ? { kind: 'claimed', claimedAt: toDate(claimedAt), capDay, capLamports: recordedLamports }
        : { kind: 'claim_lost' };
    });
  },

  async captureRefundSignature({ challengeId, claimId, signature }) {
    // CAPTURE BEFORE SEND. Nothing reaches the RPC until this row owns the
    // signature, so a lost response can never become a second send.
    try {
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE land_hold_wallet_transfer_challenges
        SET refund_state = 'sending', refund_signature = ${signature}, updated_at = now()
        WHERE id = ${challengeId}::uuid
          AND refund_claim_id = ${claimId}::uuid
          AND refund_state = 'none'
        RETURNING id`);
      return rows.length === 1 ? 'captured' : 'lost';
    } catch (err) {
      // The unique index on refund_signature already binds these exact bytes to
      // ANOTHER row. Sending them would let Solana dedupe the second while both
      // rows recorded `sent`, so one user's deposit stayed with us. Quarantine.
      if (isUniqueViolation(err)) return 'collision';
      throw err;
    }
  },

  async finishRefund({ challengeId, state, claimId, signature, obligations = [] }) {
    // Terminal transitions are BOUND to the owner: a claim id before capture,
    // the exact captured signature after it. Without that binding a stale worker
    // could finish a row another worker had taken over, or write `skipped` over
    // a send that was still landing.
    const ownership =
      signature != null
        ? sql`AND refund_state = 'sending' AND refund_signature = ${signature}`
        : claimId != null
          ? sql`AND refund_state = 'none' AND refund_claim_id = ${claimId}::uuid`
          : null;
    if (!ownership) {
      throw new Error('finishRefund requires either a claimId or the captured signature');
    }
    return await db.transaction(async (tx): Promise<boolean> => {
      const rows = await tx.execute<{ id: string }>(sql`
        UPDATE land_hold_wallet_transfer_challenges
        SET refund_state = ${state},
            refund_claim_id = NULL,
            refund_claimed_at = NULL,
            updated_at = now()
        WHERE id = ${challengeId}::uuid
          ${ownership}
        RETURNING id`);
      if (rows.length !== 1) return false;
      // ATOMIC with the terminalization. `skipped` means money we still owe but
      // cannot sign for, and refundable selection requires `refund_state='none'`
      // — so a crash between terminalizing and inserting the obligation left the
      // debt permanently unrecorded, with nothing able to retry it.
      for (const obligation of obligations) {
        await tx.execute(sql`
          INSERT INTO land_hold_wallet_refund_obligations
            (destination_pubkey, signature, recipient_pubkey, lamports, reason, state, challenge_id)
          VALUES (${obligation.destination}, ${obligation.signature},
                  ${obligation.recipientPubkey}, ${obligation.lamports},
                  ${obligation.reason}, 'open',
                  ${obligation.challengeId == null ? null : sql`${obligation.challengeId}::uuid`})
          ON CONFLICT (destination_pubkey, signature, recipient_pubkey, reason) DO NOTHING`);
      }
      return true;
    });
  },

  async releaseRefundClaim(challengeId, claimId) {
    await db.execute(sql`
      UPDATE land_hold_wallet_transfer_challenges
      SET refund_claim_id = NULL, refund_claimed_at = NULL, updated_at = now()
      WHERE id = ${challengeId}::uuid
        AND refund_claim_id = ${claimId}::uuid
        AND refund_state = 'none'`);
  },
};

// ---------------------------------------------------------------------------
// Injectable deps (module level, because the frozen signatures take no deps arg)
// ---------------------------------------------------------------------------

function defaultDeps(): LandHoldVerifyDeps {
  return {
    store: databaseStore,
    rpc: () => getConnection() as unknown as LandHoldVerifyRpc,
    loadVerifyKeypair,
    alert: alertError,
    now: () => Date.now(),
  };
}

let deps: LandHoldVerifyDeps = defaultDeps();

/** Test-only — swap any dependency (store / rpc / keypair / alert / clock). */
export function _setLandHoldVerifyDepsForTest(partial: Partial<LandHoldVerifyDeps>): void {
  deps = { ...deps, ...partial };
}

/** Test-only — restore real dependencies and drop every cache. */
export function _resetLandHoldVerifyDepsForTest(): void {
  deps = defaultDeps();
  verifyKeypairCache = null;
  connectionCache = null;
  doorAvailabilityCache = null;
  lastScanAt.clear();
  alertLastSentAt.clear();
  alertCapacitySuppressed = 0;
}

/** Test-only — throttle bookkeeping size. */
export function _landHoldVerifyAlertThrottleSizeForTest(): number {
  return alertLastSentAt.size;
}

// ---------------------------------------------------------------------------
// Door availability
// ---------------------------------------------------------------------------

let doorAvailabilityCache: { at: number; value: TransferDoorAvailability } | null = null;
/**
 * Every verify address we have ever used, current and RETIRED.
 *
 * DELIBERATELY UNCACHED. A cache populated BEFORE a rotation is stale, and a
 * stale set reaches the same permanent-loss condition as a failed lookup: the
 * signature is consumed GLOBALLY, so a rotated-destination obligation that was
 * never GENERATED can never be retried — `ON CONFLICT` cannot resurrect a row
 * nobody tried to insert, and later sweeps skip a consumed signature. This is a
 * tiny indexed table and every caller is already doing far more expensive work.
 *
 * FAILS CLOSED for the same reason: a failure throws rather than degrading to an
 * empty set. Fail-soft is right for door AVAILABILITY, which does not decide
 * what we owe; it is wrong here.
 *
 * The authoritative read for OBLIGATIONS is the one inside `attributeInbound`'s
 * transaction — see there. This one scopes which legs the scan PERSISTS.
 */
async function knownVerifyDestinations(): Promise<Set<string>> {
  return new Set(await deps.store.listVerifyDestinations());
}

/**
 * Is door 2 usable? Availability derives from the wallet, never from a flag —
 * CLAUDE.md forbids a dark on/off switch in prod.
 *
 * "Provisioned" is not enough. A row can exist while the signer is UNUSABLE: a
 * missing/rotated `VANITY_ENCRYPTION_KEY`, corrupt ciphertext, a pubkey that
 * does not match the stored one, or a wallet with no fee float. In every one of
 * those states the old check reported the door OPEN, users kept depositing real
 * SOL, and each refund attempt only logged a console warning. So this now proves
 * the signer DECRYPTS, MATCHES, and can PAY before inviting anyone to send
 * money; anything else reports unavailable and pages ops.
 *
 * Fail-soft on the reporting path: an error closes the door rather than throwing
 * into the GET handler.
 */
export async function getTransferDoorAvailability(): Promise<TransferDoorAvailability> {
  const now = deps.now();
  if (doorAvailabilityCache && now - doorAvailabilityCache.at < DOOR_AVAILABILITY_TTL_MS) {
    return doorAvailabilityCache.value;
  }
  let value: TransferDoorAvailability = { available: false, destination: null };
  try {
    const row = await deps.store.findVerifyWallet();
    if (row) {
      const readiness = await verifySignerReadiness(row.publicKey);
      if (readiness.ok) value = { available: true, destination: row.publicKey };
      else {
        await emitConditionAlert(`signer-unusable:${readiness.reason}`, {
          severity: 'critical',
          source: ALERT_SOURCE,
          message:
            'Land hold-wallet verify signer is unusable, so the transfer door is CLOSED rather than taking deposits it cannot refund.',
          // Public key only, never key material (T10).
          context: { reason: readiness.reason, verifyWallet: row.publicKey, detail: readiness.detail },
        });
      }
    }
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] verify wallet lookup failed (door reported unavailable):`,
      err instanceof Error ? err.message : String(err),
    );
  }
  doorAvailabilityCache = { at: now, value };
  return value;
}

/** Minimum verify-wallet float: rent exemption plus a working buffer of fees. */
export const VERIFY_WALLET_MIN_FLOAT_LAMPORTS =
  890_880n + REFUND_FEE_LAMPORTS * 20n;

type SignerReadiness =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'undecryptable'
        | 'pubkey_mismatch'
        | 'balance_unknown'
        | 'insufficient_float'
        | 'cap_policy_mismatch';
      detail?: string;
    };

/**
 * Can the verify wallet actually sign and pay a refund RIGHT NOW? Called before
 * the door is reported open, so a user is never invited to deposit into a wallet
 * we cannot refund from.
 */
async function verifySignerReadiness(expectedPubkey: string): Promise<SignerReadiness> {
  let keypair: Keypair;
  try {
    keypair = await deps.loadVerifyKeypair();
  } catch (err) {
    return {
      ok: false,
      reason: 'undecryptable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (keypair.publicKey.toBase58() !== expectedPubkey) {
    return { ok: false, reason: 'pubkey_mismatch' };
  }
  let balance: number;
  try {
    balance = await deps.rpc().getBalance(keypair.publicKey, 'confirmed');
  } catch (err) {
    return {
      ok: false,
      reason: 'balance_unknown',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!Number.isFinite(balance) || BigInt(Math.floor(balance)) < VERIFY_WALLET_MIN_FLOAT_LAMPORTS) {
    return { ok: false, reason: 'insufficient_float', detail: `${balance}` };
  }
  // CAP-POLICY HEALTH. A pod that wrote the day's policy with a different
  // configured cap wedges every correctly-configured pod's refunds for the rest
  // of the UTC day. Leaving the door OPEN in that state invites deposits into a
  // pipeline healthy pods refuse to drain, so the door closes too.
  try {
    const recorded = await deps.store.readTodayCapPolicy();
    const configured = landHoldVerifyDailyRefundCapLamports();
    if (recorded != null && recorded !== configured) {
      return {
        ok: false,
        reason: 'cap_policy_mismatch',
        detail: `recorded=${recorded} configured=${configured}`,
      };
    }
  } catch (err) {
    // A policy read failure is not proof of a mismatch; refunds retry on their
    // own, so do not close the door on a transient database blip.
    console.warn(
      `[${ALERT_SOURCE}] cap-policy health read failed (door left as-is):`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Open a challenge
// ---------------------------------------------------------------------------

/**
 * Open a door-2 challenge for an already-resolved identity. The caller has
 * already run requireAuthOrAgentSession + requireLedgerCapableIdentity +
 * requireNonGuestIdentity (T11); this reuses that identity and NEVER re-resolves
 * it. The declared wallet is re-read from `users` under the per-user advisory
 * lock, so a client-supplied value can never bind a challenge to a wallet the
 * account has not declared.
 */
export async function openTransferChallenge(input: {
  userId: string;
  declaredWallet: string;
}): Promise<OpenTransferChallengeResult> {
  let canonicalWallet: string;
  try {
    canonicalWallet = new PublicKey(input.declaredWallet).toBase58();
  } catch {
    throw new LandHoldVerifyError('wallet_not_declared', 403, { reason: 'invalid_wallet_address' });
  }
  if (canonicalWallet !== input.declaredWallet) {
    throw new LandHoldVerifyError('wallet_not_declared', 403, { reason: 'non_canonical_wallet' });
  }

  const door = await getTransferDoorAvailability();
  if (!door.available || !door.destination) {
    throw new LandHoldVerifyError('transfer_door_unavailable', 503);
  }

  const outcome = await deps.store.openChallenge({
    userId: input.userId,
    declaredWallet: canonicalWallet,
    destination: door.destination,
    baseLamports: landHoldVerifyBaseLamports(),
    ttlMs: landHoldVerifyTtlMs(),
    attemptCap: landHoldVerifyUserDailyAttempts(),
    graceMs: LATE_ARRIVAL_GRACE_MS,
  });

  if (outcome.kind === 'wallet_not_declared') {
    throw new LandHoldVerifyError('wallet_not_declared', 403);
  }
  if (outcome.kind === 'attempt_cap') {
    // T5 — a per-user cap hit is a drain-guard event; page ops once per user/hour.
    await emitConditionAlert(`attempt-cap:${input.userId}`, {
      severity: 'warning',
      source: ALERT_SOURCE,
      message: 'Land hold-wallet verify attempt cap hit; refusing further transfer challenges.',
      context: { userId: input.userId, used: outcome.used, cap: outcome.cap },
    });
    throw new LandHoldVerifyError('verify_attempt_cap', 429, {
      used: outcome.used,
      cap: outcome.cap,
    });
  }
  if (outcome.kind === 'amount_exhausted') {
    // Every generated amount collided with a live pending challenge. Refuse
    // rather than reuse an amount, because a reused amount is a mis-attribution.
    await emitConditionAlert('amount-space-exhausted', {
      severity: 'critical',
      source: ALERT_SOURCE,
      message:
        'Land hold-wallet verify could not mint a unique dust amount after every attempt; the pending amount space is saturated.',
      context: { attempts: UNIQUE_AMOUNT_ATTEMPTS, span: UNIQUE_LAMPORT_SPAN },
    });
    throw new LandHoldVerifyError('transfer_door_unavailable', 503, {
      reason: 'unique_amount_exhausted',
    });
  }

  const row = outcome.row;
  return {
    challengeId: row.id,
    destination: row.destinationPubkey,
    lamports: row.lamports,
    amountSol: row.lamports / LAMPORTS_PER_SOL,
    // The transfer MUST carry this memo. The amount only matches the payment to
    // the row; the memo is what makes it a statement of intent by the key
    // holder, which is the whole point of door 2 being proof at all.
    memo: challengeMemo(row.id),
    expiresAt: row.expiresAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Attribution scan (bounded + rate limited)
// ---------------------------------------------------------------------------

const lastScanAt = new Map<string, number>();
const LAST_SCAN_MAX_ENTRIES = 4_096;

function scanAllowed(key: string): boolean {
  const now = deps.now();
  const last = lastScanAt.get(key);
  if (last != null && now - last < POLL_SCAN_MIN_INTERVAL_MS) return false;
  if (!lastScanAt.has(key) && lastScanAt.size >= LAST_SCAN_MAX_ENTRIES) {
    for (const [k, at] of lastScanAt) {
      if (now - at >= POLL_SCAN_MIN_INTERVAL_MS) lastScanAt.delete(k);
    }
    if (lastScanAt.size >= LAST_SCAN_MAX_ENTRIES) return false;
  }
  lastScanAt.set(key, now);
  return true;
}

/**
 * Reduce a probe to the DURABLE FACTS matching needs, scoped to one verify
 * address. Legs to other addresses are irrelevant to us and are dropped so the
 * ledger row stays small; memos are bounded so a hostile transaction cannot
 * bloat the table.
 */
/**
 * Reduce a probe to the durable facts, or NULL when it cannot be represented
 * WHOLE within the row bounds.
 *
 * Truncating was silently lossy in three ways: a qualifying transfer as the
 * 33rd leg was stored as "no match" and never re-parsed, a correct memo after 8
 * earlier memos was falsely rejected, and more than 32 same-sender legs
 * under-refunded. The caller must therefore leave an over-sized transaction
 * UNSCANNED (so a later full parse can retry) and page ops, rather than record a
 * half-truth as settled fact.
 */
export function scanFactsOf(
  probe: TransferProbe,
  destinations: ReadonlySet<string>,
): ScanFacts | null {
  const transfers = probe.transfers.filter((t) => destinations.has(t.destination));
  if (
    probe.signers.length > SCAN_FACT_MAX_SIGNERS ||
    transfers.length > SCAN_FACT_MAX_TRANSFERS ||
    probe.memos.length > SCAN_FACT_MAX_MEMOS ||
    probe.memos.some((m) => m.text.length > SCAN_FACT_MAX_MEMO_CHARS)
  ) {
    return null;
  }
  return {
    failed: probe.failed,
    signers: probe.signers,
    transfers: transfers.map((t) => ({
      destination: t.destination,
      source: t.source,
      lamports: t.lamports,
      topLevel: t.topLevel,
    })),
    memos: probe.memos.map((m) => ({ text: m.text, topLevel: m.topLevel })),
  };
}

/** Re-inflate stored facts into the probe shape the pure predicates take. */
function probeFromFacts(facts: ScanFacts, blockTimeMs: number | null): TransferProbe {
  return {
    failed: facts.failed,
    blockTimeMs,
    signers: facts.signers,
    transfers: facts.transfers.map((t) => ({
      source: t.source,
      // Each leg carries its OWN destination: one row can describe money paid to
      // several verify addresses by the same transaction.
      destination: t.destination,
      lamports: t.lamports,
      topLevel: t.topLevel,
    })),
    memos: facts.memos,
  };
}

/**
 * PHASE 1 — HARVEST. Page BACKWARDS through this address's signatures until the
 * oldest open challenge window is covered, parse everything not already in the
 * durable ledger, and persist the facts.
 *
 * A single newest-page read was an eclipse vector: 25 one-lamport spam transfers
 * newer than a real deposit were re-parsed on every pass while the deposit at
 * position 26 was never examined at all, so after its grace window the user's
 * SOL was neither attributed nor refunded. Cursor pagination reaches it, and
 * because every parse is RECORDED, each signature costs a parse exactly once
 * ever — the queue drains monotonically instead of spinning on the same spam,
 * and it survives a restart.
 */
async function harvestSignatures(destination: string, windowFromMs: number): Promise<void> {
  // Facts keep legs to ANY verify address we know about, so one row can later
  // reveal that this transaction ALSO paid a retired address. THROWS when that
  // set is unavailable: persisting facts scoped to only the attributed
  // destination would permanently hide the retired leg, and the ledger row is
  // never re-parsed.
  const knownDestinations = new Set(await knownVerifyDestinations());
  knownDestinations.add(destination);
  const address = new PublicKey(destination);
  let before: string | undefined;
  let parsed = 0;

  for (let page = 0; page < SCAN_MAX_PAGES && parsed < SCAN_PARSE_LIMIT; page += 1) {
    let refs: SignatureRef[];
    try {
      refs = await deps
        .rpc()
        .getSignaturesForAddress(
          address,
          before ? { limit: SCAN_SIGNATURE_LIMIT, before } : { limit: SCAN_SIGNATURE_LIMIT },
          'finalized',
        );
    } catch (err) {
      console.warn(
        `[${ALERT_SOURCE}] signature scan failed (non-fatal, retried next pass):`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    if (refs.length === 0) return;

    const usable = refs.filter(
      (ref) =>
        ref.err == null &&
        // T8 — anything below `finalized` is not a grant basis, so it is not
        // harvested either; it will be picked up once it finalizes.
        (ref.confirmationStatus == null || ref.confirmationStatus === 'finalized'),
    );

    let unscanned = new Set<string>();
    if (usable.length > 0) {
      try {
        unscanned = await deps.store.filterUnscannedSignatures(
          destination,
          usable.map((ref) => ref.signature),
        );
      } catch (err) {
        console.warn(
          `[${ALERT_SOURCE}] scan-ledger read failed (page treated as unscanned):`,
          err instanceof Error ? err.message : String(err),
        );
        unscanned = new Set(usable.map((ref) => ref.signature));
      }
    }

    for (const ref of usable) {
      if (parsed >= SCAN_PARSE_LIMIT) break;
      if (!unscanned.has(ref.signature)) continue;
      // Nothing outside the candidate window can settle anything, so it is not
      // worth a parse. NOT recorded either — the window belongs to the rows this
      // pass holds, and a later pass may hold older ones.
      if (typeof ref.blockTime === 'number' && ref.blockTime * 1000 < windowFromMs) continue;
      parsed += 1;
      let probe: TransferProbe | null;
      try {
        probe = probeTransaction(
          await deps.rpc().getParsedTransaction(ref.signature, {
            commitment: 'finalized',
            maxSupportedTransactionVersion: 0,
          }),
        );
      } catch (err) {
        // Leave it UNRECORDED so the next pass retries; a transient RPC error
        // must never look like "this transaction has nothing for us".
        console.warn(
          `[${ALERT_SOURCE}] parse failed for ${ref.signature} (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }
      if (!probe) continue;
      const blockTimeMs =
        probe.blockTimeMs ?? (typeof ref.blockTime === 'number' ? ref.blockTime * 1000 : null);
      const facts = scanFactsOf(probe, knownDestinations);
      if (!facts) {
        // Too large to represent WHOLE. Leave it unscanned so a later full parse
        // can retry, and page ops — recording a truncated view as settled fact
        // would silently drop a qualifying leg or a correct memo.
        await emitConditionAlert(`scan-facts-too-large:${ref.signature}`, {
          severity: 'warning',
          source: ALERT_SOURCE,
          message:
            'A transaction at the land hold-wallet verify address is too large to record whole; it was left unscanned rather than truncated. Verification is unaffected (that path is submission-based); this only delays refund discovery.',
          context: {
            signature: ref.signature,
            destination,
            signers: probe.signers.length,
            transfers: probe.transfers.length,
            memos: probe.memos.length,
          },
        });
        continue;
      }
      try {
        await deps.store.recordScannedSignature({
          destination,
          signature: ref.signature,
          blockTimeMs,
          facts,
        });
      } catch (err) {
        console.warn(
          `[${ALERT_SOURCE}] scan-ledger write failed for ${ref.signature} (re-parsed next pass):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const last = refs[refs.length - 1]!;
    before = last.signature;
    // Stop once this page has walked past the oldest window we still care about.
    if (typeof last.blockTime === 'number' && last.blockTime * 1000 < windowFromMs) return;
    if (refs.length < SCAN_SIGNATURE_LIMIT) return;
  }
}

/**
 * Attribute FINALIZED inbound transfers to the given open challenges.
 *
 * Two phases. HARVEST parses unseen signatures once and persists their facts;
 * MATCH then runs every open challenge against the DURABLE facts — including
 * ones harvested on an earlier pass, by a different worker, or before a restart.
 * Matching against stored facts (rather than only what this pass happened to
 * parse) is what keeps a bounded candidate set from permanently blinding us to a
 * payment: the parse cost is paid once, the matching opportunity never expires.
 *
 * T8: signatures AND transactions are read at `finalized`. A `confirmed` read
 * would let a reorg roll the transfer back while the verification persists.
 */
async function attributeChallenges(candidates: ChallengeRow[]): Promise<void> {
  if (candidates.length === 0) return;
  // Group by destination rather than assuming one: if the verify treasury row
  // is ever rotated, challenges still pointing at the RETIRED address would
  // otherwise never be scanned, so their dust would be neither attributed nor
  // refunded.
  const byDestination = new Map<string, ChallengeRow[]>();
  for (const row of candidates) {
    const bucket = byDestination.get(row.destinationPubkey);
    if (bucket) bucket.push(row);
    else byDestination.set(row.destinationPubkey, [row]);
  }
  for (const [destination, rows] of byDestination) {
    await attributeAtDestination(destination, rows);
  }
}

async function attributeAtDestination(
  destination: string,
  candidates: ChallengeRow[],
): Promise<void> {
  if (candidates.length === 0) return;

  // NEWEST FIRST. A lapsed row keeps being scanned through the grace window
  // while its amount can already be re-minted, so when one transfer matches two
  // rows the NEWER challenge must win the single-signature binding — otherwise
  // the user who just paid is refunded but never verified.
  const ordered = [...candidates].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const open = new Map(ordered.map((row) => [row.id, row]));

  // A transfer older than the oldest open challenge cannot be a payment for an
  // amount that did not exist yet, and a row stops being watched once it is past
  // expiry + grace.
  let windowFromMs = Number.POSITIVE_INFINITY;
  let windowToMs = Number.NEGATIVE_INFINITY;
  for (const row of ordered) {
    windowFromMs = Math.min(windowFromMs, row.createdAt.getTime() - BLOCK_TIME_SKEW_MS);
    windowToMs = Math.max(
      windowToMs,
      row.expiresAt.getTime() + LATE_ARRIVAL_GRACE_MS + BLOCK_TIME_SKEW_MS,
    );
  }

  // FAIL CLOSED: harvest needs the complete destination set to decide which legs
  // to PERSIST, and facts scoped to only the attributed destination would hide a
  // retired-address leg permanently. `harvestSignatures` throws when that lookup
  // fails, so skip this pass; the next sweep retries because nothing was
  // consumed. (The obligation derivation itself reads destinations FRESH inside
  // the attribution transaction, so it never depends on anything cached here.)
  try {
    await harvestSignatures(destination, windowFromMs);
  } catch (err) {
    await emitConditionAlert('destination-set-unavailable', {
      severity: 'critical',
      source: ALERT_SOURCE,
      message:
        'The land hold-wallet verify destination set could not be read, so attribution is deferred rather than risking an unrecorded debt at another verify address.',
      context: { destination, error: err instanceof Error ? err.message : String(err) },
    });
    return;
  }

  let facts: ScanLedgerRow[];
  try {
    facts = await deps.store.listScannedSignatures({
      destination,
      fromMs: windowFromMs,
      toMs: windowToMs,
      limit: SCAN_MATCH_LIMIT,
    });
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] scan-ledger match read failed (retried next pass):`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  for (const entry of facts) {
    if (open.size === 0) break;
    // T7 — a signature already bound to a challenge can never settle another.
    if (await deps.store.isSignatureAttributed(entry.signature)) continue;
    const probe = probeFromFacts(entry.facts, entry.blockTimeMs);

    const legMatches = [...open.values()].filter((row) =>
      transactionMatchesTransferLeg(probe, {
        from: row.walletPubkey,
        to: row.destinationPubkey,
        lamports: row.lamports,
      }),
    );
    if (legMatches.length === 0) continue;

    // The leg identifies this money as a specific user's. When more than one
    // open row shares the amount — only possible for rows the uniqueness guards
    // could not cover — the memo decides which one the sender meant; otherwise
    // the newest takes it (`ordered` above).
    const row =
      legMatches.find(
        (candidate) =>
          transactionSignedBySource(probe, candidate.walletPubkey) &&
          transactionCarriesChallengeMemo(probe, candidate.id),
      ) ?? legMatches[0]!;

    // DEMOTED (round 3): the scan NEVER verifies. Verification comes only from
    // `submitTransferSignature`, where the user hands us the exact signature and
    // cannot be eclipsed by spam. All this pass does is find money that arrived
    // and was never submitted, so it can be REFUNDED. `unclaimed` is terminal:
    // refund owed, no proof granted, and the poll surface explains why.
    const inboundLamports =
      receivedLamportsFrom(probe, { from: row.walletPubkey, to: row.destinationPubkey }) ||
      row.lamports;

    const outcome = await deps.store.attributeInbound({
      challengeId: row.id,
      userId: row.userId,
      destination,
      signature: entry.signature,
      inboundLamports,
      nextStatus: 'unclaimed',
      rejectedReason: null,
      // The scan may only terminalize a CLOSED challenge. A row still inside its
      // window belongs to the user, who may be about to submit.
      onlyIfClosedForMs: UNCLAIMED_CLOSED_MARGIN_MS,
      // Legs from ANY OTHER sender cannot be returned by this challenge's
      // refund. Legs paid to ANY OTHER verify address are derived inside the
      // attribution transaction from a FRESH destination read, so a rotation
      // cannot be missed. Both land in the SAME transaction as the attribution.
      obligations: retainedLegObligations(
        destination,
        entry.signature,
        probe,
        row.walletPubkey,
        row.id,
      ),
      legs: probe.transfers,
    });
    if (outcome.bound) {
      open.delete(row.id);
      await deps.store
        .markSignatureMatched(destination, entry.signature)
        .catch(() => undefined);
      await alertRefundQuarantined(outcome, row.id, entry.signature);
      await emitConditionAlert(`unsubmitted-inbound:${row.userId}`, {
        severity: 'warning',
        source: ALERT_SOURCE,
        message:
          'A land hold-wallet transfer arrived but was never submitted for verification; it is being refunded and the challenge stays unverified.',
        context: { challengeId: row.id, userId: row.userId, signature: entry.signature },
      });
      await alertRetainedLegs(destination, entry.signature, probe, row.walletPubkey, row.id);
    }
  }
}

/**
 * Write a durable refund obligation for every leg in a transaction that our
 * challenge refund cannot return: money from a DIFFERENT sender than the one the
 * settled row belongs to. Same-sender legs are already covered because the
 * refund pays `receivedLamportsFrom` for that sender.
 */
/**
 * Debts for money the SAME transaction paid to a DIFFERENT verify address than
 * the one being attributed.
 *
 * Attribution consumes a signature GLOBALLY (one signature, one challenge), so
 * without this the retired address's leg was never turned into an obligation:
 * the composite key could represent the debt, but nothing ever discovered it.
 * No scanning is needed — the fully parsed transaction is already in hand at
 * attribution time.
 */
export function rotatedDestinationObligations(
  legs: ReadonlyArray<{ destination: string; source: string; lamports: number }>,
  attributedDestination: string,
  knownDestinations: ReadonlySet<string>,
  signature: string,
  challengeId: string | null,
): RefundObligationInput[] {
  const byLeg = new Map<string, number>();
  for (const leg of legs) {
    if (leg.destination === attributedDestination) continue;
    if (!knownDestinations.has(leg.destination)) continue;
    if (leg.lamports <= 0) continue;
    const key = `${leg.destination}\u0000${leg.source}`;
    byLeg.set(key, (byLeg.get(key) ?? 0) + leg.lamports);
  }
  const obligations: RefundObligationInput[] = [];
  for (const [key, lamports] of byLeg) {
    const [destination, recipientPubkey] = key.split('\u0000') as [string, string];
    obligations.push({
      destination,
      signature,
      recipientPubkey,
      lamports,
      reason: 'destination_rotated',
      challengeId,
    });
  }
  return obligations;
}

export function retainedLegObligations(
  destination: string,
  signature: string,
  probe: TransferProbe,
  settledSender: string,
  challengeId: string | null,
  reason: RefundObligationReason = 'retained_leg',
): RefundObligationInput[] {
  const bySender = new Map<string, number>();
  for (const leg of probe.transfers) {
    if (leg.destination !== destination) continue;
    if (leg.source === settledSender) continue;
    bySender.set(leg.source, (bySender.get(leg.source) ?? 0) + leg.lamports);
  }
  const obligations: RefundObligationInput[] = [];
  for (const [recipientPubkey, lamports] of bySender) {
    if (lamports <= 0) continue;
    obligations.push({ destination, signature, recipientPubkey, lamports, reason, challengeId });
  }
  return obligations;
}

/**
 * Page ops when an attribution landed on funds an operator had ALREADY settled
 * by hand. The refund is held at `reconcile` so the automatic queue can never
 * pay the same deposit twice; a person decides what, if anything, is still owed.
 */
async function alertRefundQuarantined(
  outcome: AttributeOutcome,
  challengeId: string,
  signature: string,
): Promise<void> {
  if (!outcome.refundQuarantined) return;
  await emitConditionAlert(`refund-already-settled:${signature}`, {
    severity: 'critical',
    source: ALERT_SOURCE,
    message:
      'A land hold-wallet transfer was attributed to funds an operator had already settled by hand; the automatic refund is quarantined so the same deposit is never paid twice.',
    context: { challengeId, signature },
  });
}

/** Ops page for obligations already WRITTEN atomically with the attribution. */
async function alertRetainedLegs(
  destination: string,
  signature: string,
  probe: TransferProbe,
  settledSender: string,
  challengeId: string | null,
  reason: RefundObligationReason = 'retained_leg',
): Promise<void> {
  for (const obligation of retainedLegObligations(
    destination,
    signature,
    probe,
    settledSender,
    challengeId,
    reason,
  )) {
    await emitConditionAlert(`${reason}:${signature}:${obligation.recipientPubkey}`, {
      severity: 'warning',
      source: ALERT_SOURCE,
      message:
        'Funds arrived at the land hold-wallet verify address that no challenge refund can return; a refund obligation row was recorded for operator settlement.',
      context: {
        signature,
        destination,
        recipientPubkey: obligation.recipientPubkey,
        lamports: obligation.lamports,
        reason,
        challengeId,
      },
    });
  }
}

/**
 * Standalone obligation write for funds with NO attributing challenge (orphans
 * and rotated destinations). The unique index carries the retry, so a repeated
 * pass never double-claims the same money.
 */
async function recordStandaloneObligations(
  obligations: RefundObligationInput[],
): Promise<void> {
  for (const obligation of obligations) {
    let recorded = false;
    try {
      recorded = await deps.store.recordRefundObligation(obligation);
    } catch (err) {
      console.warn(
        `[${ALERT_SOURCE}] refund-obligation write failed for ${obligation.signature} (retried next pass):`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    if (recorded) {
      await emitConditionAlert(
        `${obligation.reason}:${obligation.signature}:${obligation.recipientPubkey}`,
        {
          severity: 'warning',
          source: ALERT_SOURCE,
          message:
            'Funds arrived at the land hold-wallet verify address that no challenge refund can return; a refund obligation row was recorded for operator settlement.',
          context: {
            signature: obligation.signature,
            destination: obligation.destination,
            recipientPubkey: obligation.recipientPubkey,
            lamports: obligation.lamports,
            reason: obligation.reason,
            challengeId: obligation.challengeId,
          },
        },
      );
    }
  }
}

async function grantObserved(rows: ChallengeRow[]): Promise<void> {
  for (const row of rows) {
    const outcome = await deps.store.grantVerification({
      challengeId: row.id,
      userId: row.userId,
      walletPubkey: row.walletPubkey,
    });
    if (outcome === 'wallet_changed') {
      await emitConditionAlert(`wallet-changed:${row.id}`, {
        severity: 'warning',
        source: ALERT_SOURCE,
        message:
          'Land hold-wallet transfer proof arrived after the declaration changed; verification refused, refund still owed.',
        context: { challengeId: row.id, userId: row.userId },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Refund — fail SOFT, exactly once, forward-only (T9)
// ---------------------------------------------------------------------------

/** The memo text our OUTBOUND refund carries. Unique per challenge by construction. */
export function refundMemoText(challengeId: string): string {
  return `clawville land hold refund ${challengeId}`;
}

/**
 * Memo instruction for the refund transaction. Its only job is to make the
 * signed bytes unique per challenge — see the collision note at the call site.
 */
function refundMemoInstruction(payer: PublicKey, challengeId: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(REFUND_MEMO_PROGRAM_ID),
    keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
    data: Buffer.from(refundMemoText(challengeId), 'utf8'),
  });
}

async function sendRefund(row: ChallengeRow): Promise<void> {
  const claimId = randomUUID();
  const capLamports = landHoldVerifyDailyRefundCapLamports();

  let admission: RefundAdmission;
  try {
    admission = await deps.store.admitRefund({
      challengeId: row.id,
      claimId,
      feeLamports: REFUND_FEE_LAMPORTS,
      capLamports,
      staleMs: REFUND_CLAIM_STALE_MS,
    });
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] refund admission failed for ${row.id} (retried next pass):`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  if (admission.kind === 'claim_lost') return;
  if (admission.kind === 'cap_mismatch') {
    // A pod is running a DIFFERENT configured cap from the one the day's policy
    // recorded (a rolling deploy mid-day). Refuse rather than measure spend
    // against a number nobody can reconstruct later.
    await emitConditionAlert(`cap-policy-mismatch:${admission.capDay}`, {
      severity: 'critical',
      source: ALERT_SOURCE,
      message:
        'Land hold-wallet verify refund cap policy disagrees with this process configuration; refunds are deferred until the configuration matches the recorded policy.',
      context: {
        capDay: admission.capDay,
        recordedLamports: admission.recordedLamports.toString(),
        processLamports: admission.callLamports.toString(),
      },
    });
    return;
  }
  if (admission.kind === 'cap') {
    // T5 — refuse the SEND, never the verification. Nothing was claimed, so the
    // row stays refundable and heals itself when the next authorization day
    // opens. Spend stays bounded by the recorded policy either way, and the user
    // keeps the verification they actually proved.
    await emitConditionAlert('daily-refund-cap', {
      severity: 'critical',
      source: ALERT_SOURCE,
      message:
        'Land hold-wallet verify daily refund-fee cap exceeded; refunds are deferred to the next authorization day. Verification is unaffected.',
      context: {
        challengeId: row.id,
        capDay: admission.capDay,
        lamports: refundLamportsOf(row),
        usedLamports: admission.usedLamports.toString(),
        capLamports: admission.capLamports.toString(),
      },
    });
    return;
  }

  let keypair: Keypair;
  try {
    keypair = await deps.loadVerifyKeypair();
  } catch (err) {
    await deps.store.releaseRefundClaim(row.id, claimId).catch(() => undefined);
    console.warn(
      `[${ALERT_SOURCE}] verify keypair unavailable for ${row.id} (retried next pass):`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  // The refund MUST be signed by the wallet that actually RECEIVED the dust. If
  // the verify wallet was rotated after this challenge was issued, the current
  // keypair controls a DIFFERENT treasury address, and signing with it would
  // spend the wrong wallet's SOL while the user's dust stayed stranded. That is
  // terminal for the sweeper: only an operator can settle it.
  if (keypair.publicKey.toBase58() !== row.destinationPubkey) {
    // `skipped` is NOT "no refund needed" — it is money we still owe but cannot
    // sign for, so the obligation is written in the SAME transaction that
    // terminalizes the row. Doing it afterwards meant a crash in between lost
    // the debt forever: refundable selection requires `refund_state='none'`, so
    // nothing could ever retry a `skipped` row with a missing obligation.
    const rotatedObligation: RefundObligationInput = {
      destination: row.destinationPubkey,
      signature: row.inboundSignature ?? row.id,
      recipientPubkey: row.walletPubkey,
      lamports: refundLamportsOf(row),
      reason: 'destination_rotated',
      challengeId: row.id,
    };
    await deps.store.finishRefund({
      challengeId: row.id,
      state: 'skipped',
      claimId,
      obligations: [rotatedObligation],
    });
    await emitConditionAlert(`destination-rotated:${row.destinationPubkey}`, {
      severity: 'critical',
      source: ALERT_SOURCE,
      message:
        'Land hold-wallet verify wallet no longer matches the address a challenge was paid to; refund skipped for manual settlement rather than spending a different treasury wallet.',
      context: {
        challengeId: row.id,
        paidTo: row.destinationPubkey,
        currentVerifyWallet: keypair.publicKey.toBase58(),
      },
    });
    return;
  }

  const refundLamports = refundLamportsOf(row);
  let blockhash: string;
  let lastValidBlockHeight: number;
  let serialized: Buffer;
  let signature: string;
  try {
    const latest = await deps.rpc().getLatestBlockhash('confirmed');
    blockhash = latest.blockhash;
    lastValidBlockHeight = latest.lastValidBlockHeight;
    const tx = new Transaction({
      feePayer: keypair.publicKey,
      recentBlockhash: blockhash,
    })
      .add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(row.walletPubkey),
          lamports: refundLamports,
        }),
      )
      // UNIQUENESS, not decoration. Without this the refund bytes are fully
      // determined by (fee payer, blockhash, destination, amount), and amounts
      // become reusable once a challenge closes — so two backlogged refunds to
      // the same wallet for the same reused amount under the same recent
      // blockhash produced the IDENTICAL signature. Solana deduped the second
      // while BOTH rows recorded `sent`, and one user's deposit stayed with us.
      // The challenge id is unique per row, so the bytes can never coincide.
      .add(refundMemoInstruction(keypair.publicKey, row.id));
    tx.sign(keypair);
    if (!tx.signature) throw new Error('refund signing produced no signature');
    signature = bs58.encode(tx.signature);
    serialized = Buffer.from(tx.serialize());
  } catch (err) {
    // Nothing was captured and nothing was sent, so releasing the lease is safe.
    await deps.store.releaseRefundClaim(row.id, claimId).catch(() => undefined);
    console.warn(
      `[${ALERT_SOURCE}] refund signing failed for ${row.id} (retried next pass):`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  const captured = await deps.store.captureRefundSignature({
    challengeId: row.id,
    claimId,
    signature,
  });
  if (captured === 'lost') {
    // Another worker owns this refund. Do NOT send our bytes.
    return;
  }
  // Our own refund lands on the verify address's signature page. Record it as
  // already-scanned with empty facts so the attribution phase never spends a
  // parse on it: it can never settle a challenge, by construction.
  await deps.store
    .recordScannedSignature({
      destination: row.destinationPubkey,
      signature,
      blockTimeMs: null,
      facts: { failed: false, signers: [], transfers: [], memos: [] },
    })
    .catch(() => undefined);
  if (captured === 'collision') {
    // These exact bytes are already owned by ANOTHER row. Sending them would be
    // deduped on chain while both rows claimed to have paid, so quarantine for
    // an operator instead of pretending. Nothing has been sent.
    await deps.store
      .finishRefund({ challengeId: row.id, state: 'reconcile', claimId })
      .catch(() => false);
    await emitConditionAlert(`refund-signature-collision:${signature}`, {
      severity: 'critical',
      source: ALERT_SOURCE,
      message:
        'Two land hold-wallet refunds produced the SAME signature; the second is quarantined unsent so a deduped transaction can never be recorded as two payments.',
      context: { challengeId: row.id, refundSignature: signature, lamports: refundLamports },
    });
    return;
  }

  try {
    await deps.rpc().sendRawTransaction(serialized);
    const confirmed = await deps
      .rpc()
      .confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (confirmed.value.err == null) {
      // `confirmTransaction` at 'confirmed' commitment IS the confirmation, so
      // this is a legitimate terminal `sent` (unlike a bare status read).
      await deps.store.finishRefund({ challengeId: row.id, state: 'sent', signature });
      return;
    }
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] refund send/confirm was ambiguous for ${row.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  // FORWARD ONLY. The signature is captured, so the row stays `sending` and the
  // resolver chain-checks those exact bytes later. We NEVER re-sign or re-send.
  //
  // The lease stamp is the one THIS worker just took, never the pre-takeover
  // value carried on `row`: an inherited stamp can be arbitrarily old, which
  // made the very first resolve pass look aged and finish an ambiguous send as
  // terminal `reconcile` with no chance for the chain to settle.
  await resolveRefund({
    ...row,
    refundSignature: signature,
    refundState: 'sending',
    refundClaimId: claimId,
    refundClaimedAt: admission.claimedAt,
  });
}

/**
 * Resolve a captured-but-unconfirmed refund by READING the chain. Landed ⇒
 * `sent`. Still unresolved past the stale window ⇒ `reconcile` + an ops page.
 * There is deliberately no re-send branch (T9).
 */
async function resolveRefund(row: ChallengeRow): Promise<void> {
  const signature = row.refundSignature;
  if (!signature) return;
  let status: { err: unknown; confirmationStatus?: string | null } | null = null;
  try {
    const statuses = await deps
      .rpc()
      .getSignatureStatuses([signature], { searchTransactionHistory: true });
    status = statuses.value[0] ?? null;
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] refund chain-check failed for ${row.id} (retried next pass):`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  if (status && status.err == null) {
    // A status with NO error is not the same as a landed payment. A `processed`
    // (or commitment-less) status can still be dropped on a fork, and recording
    // `sent` on it left the ledger terminally wrong about real money. Only
    // `confirmed`/`finalized` is terminal; anything softer keeps checking the
    // same captured signature — never re-signing, never re-sending.
    if (isTerminallyConfirmed(status.confirmationStatus)) {
      await deps.store.finishRefund({ challengeId: row.id, state: 'sent', signature });
      return;
    }
    return;
  }

  const claimedAtMs = row.refundClaimedAt?.getTime() ?? deps.now();
  const aged = deps.now() - claimedAtMs >= REFUND_RESOLVE_STALE_MS;
  if (status && status.err != null) {
    await deps.store.finishRefund({ challengeId: row.id, state: 'reconcile', signature });
    await emitConditionAlert(`refund-reverted:${signature}`, {
      severity: 'critical',
      source: ALERT_SOURCE,
      message:
        'Land hold-wallet verify refund landed reverted; it is quarantined for manual reconciliation and is never re-sent.',
      context: { challengeId: row.id, refundSignature: signature },
    });
    return;
  }
  if (!aged) return; // Still inside the window; the next pass re-checks.

  await deps.store.finishRefund({ challengeId: row.id, state: 'reconcile', signature });
  await emitConditionAlert(`refund-unresolved:${signature}`, {
    severity: 'critical',
    source: ALERT_SOURCE,
    message:
      'Land hold-wallet verify refund has no signature history past the resolve window; quarantined for manual reconciliation and never re-sent.',
    context: {
      challengeId: row.id,
      refundSignature: signature,
      lamports: refundLamportsOf(row),
    },
  });
}

/** Only a confirmed/finalized commitment may close a money row as paid. */
function isTerminallyConfirmed(confirmationStatus: string | null | undefined): boolean {
  return confirmationStatus === 'confirmed' || confirmationStatus === 'finalized';
}

async function advanceRefunds(): Promise<void> {
  const unresolved = await deps.store.listUnresolvedRefunds(SWEEP_CHALLENGE_LIMIT);
  for (const row of unresolved) await resolveRefund(row);
  const refundable = await deps.store.listRefundableChallenges(
    SWEEP_CHALLENGE_LIMIT,
    REFUND_CLAIM_STALE_MS,
  );
  for (const row of refundable) await sendRefund(row);
}

// ---------------------------------------------------------------------------
// Poll (on-demand attribution + grant)
// ---------------------------------------------------------------------------

function toStatus(row: ChallengeRow): TransferChallengeStatus {
  return {
    challengeId: row.id,
    state: row.status,
    rejectedReason: row.status === 'rejected' ? row.rejectedReason : null,
    refundState: row.refundState,
    inboundSignature: row.inboundSignature,
    refundSignature: row.refundSignature,
    destination: row.destinationPubkey,
    lamports: row.lamports,
    memo: challengeMemo(row.id),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * Read one challenge's status.
 *
 * This is READ-ONLY with respect to verification (round 3): only
 * `submitTransferSignature` can settle a challenge. Polling still lapses an
 * expired row so the UI reflects the closed window, and it never drives refunds
 * — `sweepTransferChallenges` owns the send path so there is exactly one
 * money-mover.
 */
export async function pollTransferChallenge(input: {
  userId: string;
  challengeId: string;
}): Promise<TransferChallengeStatus> {
  if (!UUID_RE.test(input.challengeId)) {
    throw new LandHoldVerifyError('challenge_not_found', 404);
  }
  let row = await deps.store.getChallengeForUser(input.challengeId, input.userId);
  if (!row) throw new LandHoldVerifyError('challenge_not_found', 404);

  if (
    row.status === 'pending' &&
    row.inboundSignature == null &&
    row.expiresAt.getTime() <= deps.now() &&
    scanAllowed(row.id)
  ) {
    await deps.store.expireLapsedChallenges().catch(() => 0);
    const refreshed = await deps.store.getChallengeForUser(input.challengeId, input.userId);
    if (refreshed) row = refreshed;
  }

  return toStatus(row);
}

/**
 * Find money at our verify addresses that NO challenge row can return, and write
 * a durable obligation for it.
 *
 * Runs even when there are no open challenges (that is precisely when an
 * orphaned deposit is invisible to the challenge scan). Only transfers older
 * than the late-arrival grace window are considered, so a payment a live
 * challenge could still claim is never mistaken for an orphan.
 */
async function discoverUnclaimedInbound(): Promise<void> {
  const now = deps.now();
  // DERIVED from the configured TTL (+ grace + margin), never a standalone
  // constant. A fixed 30 minutes undercut the 45-minute default TTL, so a LIVE
  // challenge's money could be booked as an obligation and then also refunded
  // through the challenge — the same funds owed twice.
  const cutoffMs = now - landHoldVerifyOrphanThresholdMs();
  let destinations: string[];
  try {
    destinations = await deps.store.listRecentDestinations(SCAN_LEDGER_RETENTION_MS);
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] destination lookup failed (obligation sweep skipped):`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  const door = await getTransferDoorAvailability().catch(() => null);
  if (door?.destination && !destinations.includes(door.destination)) {
    destinations.push(door.destination);
  }

  for (const destination of destinations.slice(0, OBLIGATION_DESTINATION_LIMIT)) {
    try {
      await harvestSignatures(destination, now - SCAN_LEDGER_RETENTION_MS);
    } catch (err) {
      console.warn(
        `[${ALERT_SOURCE}] destination set unavailable, obligation sweep deferred for ${destination}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    let entries: ScanLedgerRow[];
    try {
      entries = await deps.store.listScannedSignatures({
        destination,
        fromMs: now - SCAN_LEDGER_RETENTION_MS,
        toMs: cutoffMs,
        limit: SCAN_MATCH_LIMIT,
      });
    } catch (err) {
      console.warn(
        `[${ALERT_SOURCE}] obligation ledger read failed for ${destination}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    for (const entry of entries) {
      if (entry.blockTimeMs != null && entry.blockTimeMs > cutoffMs) continue;
      // Anything a challenge bound is already being refunded through that row.
      if (await deps.store.isSignatureAttributed(entry.signature)) continue;
      const probe = probeFromFacts(entry.facts, entry.blockTimeMs);
      if (probe.failed) continue;
      // No settled sender here, so EVERY inbound leg is retained money.
      await recordStandaloneObligations(
        retainedLegObligations(destination, entry.signature, probe, '', null, 'unclaimed_inbound'),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Signature submission — THE verification path (round 3)
// ---------------------------------------------------------------------------

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Verify a door-2 challenge from a signature the USER hands us.
 *
 * This replaced blind scanning as the verification path. We fetch THAT EXACT
 * transaction at `finalized` and run the same predicates the scan used to run —
 * top-level System transfer, top-level memo naming the challenge, sender is a
 * signer, exact amount, our destination — none of which changed. Only HOW we
 * find the transaction changed, and a signature handed to us cannot be eclipsed
 * by spam, buried past a page cap, or lost to a batch bound.
 *
 * A transfer that arrives but cannot be proof is still ATTRIBUTED (so the money
 * is refunded) and returned with a reason, exactly as before.
 */
export async function submitTransferSignature(input: {
  userId: string;
  challengeId: string;
  signature: string;
}): Promise<TransferChallengeStatus> {
  if (!UUID_RE.test(input.challengeId)) {
    throw new LandHoldVerifyError('challenge_not_found', 404);
  }
  const signature = input.signature.trim();
  // bs58 length-check BEFORE any RPC work, like the door-1 handler (T13): a
  // garbage input is a clean 400, never a confusing upstream error.
  if (!BASE58_RE.test(signature) || signature.length < 64 || signature.length > 90) {
    throw new LandHoldVerifyError('invalid_signature', 400);
  }
  try {
    if (bs58.decode(signature).length !== 64) {
      throw new LandHoldVerifyError('invalid_signature', 400);
    }
  } catch (err) {
    if (err instanceof LandHoldVerifyError) throw err;
    throw new LandHoldVerifyError('invalid_signature', 400);
  }

  const row = await deps.store.getChallengeForUser(input.challengeId, input.userId);
  if (!row) throw new LandHoldVerifyError('challenge_not_found', 404);

  if (row.inboundSignature != null) {
    // Idempotent replay of the SAME signature returns the settled status; a
    // different one is refused rather than silently ignored.
    if (row.inboundSignature === signature) return toStatus(row);
    throw new LandHoldVerifyError('challenge_already_settled', 409, {
      inboundSignature: row.inboundSignature,
    });
  }

  if (await deps.store.isSignatureAttributed(signature)) {
    // T7 — one signature satisfies at most one challenge, including across
    // accounts. This is what stops a shared transaction being spent twice.
    throw new LandHoldVerifyError('signature_already_used', 409);
  }

  let probe: TransferProbe | null;
  try {
    probe = probeTransaction(
      await deps.rpc().getParsedTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      }),
    );
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] submitted-signature lookup failed for ${signature}:`,
      err instanceof Error ? err.message : String(err),
    );
    throw new LandHoldVerifyError('transaction_lookup_failed', 503);
  }
  // Null covers both "unknown" and "not finalized yet" — T8 means we never grant
  // on anything softer, so the caller is told to wait and retry.
  if (!probe) throw new LandHoldVerifyError('transaction_not_finalized', 404);
  if (probe.failed) throw new LandHoldVerifyError('transaction_failed', 422);

  const leg = {
    from: row.walletPubkey,
    to: row.destinationPubkey,
    lamports: row.lamports,
  };
  if (!transactionMatchesTransferLeg(probe, leg)) {
    // Nothing in this transaction pays this challenge, so there is no money of
    // ours to attribute. Refuse WITHOUT consuming the challenge.
    throw new LandHoldVerifyError('transfer_not_found', 422, {
      expectedLamports: row.lamports,
      expectedDestination: row.destinationPubkey,
      expectedSender: row.walletPubkey,
    });
  }

  // From here the money IS this challenge's, so every outcome attributes and
  // therefore refunds. Strongest refusal first.
  let nextStatus: 'observed' | 'expired' | 'rejected';
  let rejectedReason: TransferRejectedReason | null = null;
  if (!transactionSignedBySource(probe, row.walletPubkey)) {
    nextStatus = 'rejected';
    rejectedReason = 'source_not_signer';
  } else if (!transactionCarriesChallengeMemo(probe, row.id)) {
    nextStatus = 'rejected';
    rejectedReason = 'memo_missing';
  } else if (!transactionHasTopLevelTransferLeg(probe, leg)) {
    nextStatus = 'rejected';
    rejectedReason = 'transfer_not_top_level';
  } else if (!blockTimeInsideWindow(probe.blockTimeMs, row, deps.now())) {
    nextStatus = 'expired';
  } else {
    nextStatus = 'observed';
  }

  // FAIL CLOSED before touching the row. The authoritative destination read is
  // inside the attribution transaction; this is a health probe so an unavailable
  // treasury table becomes a clean 503 the caller can retry, rather than an
  // opaque failure after the row was touched.
  try {
    await knownVerifyDestinations();
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] verify-destination lookup failed; refusing to attribute ${signature}:`,
      err instanceof Error ? err.message : String(err),
    );
    throw new LandHoldVerifyError('destination_set_unavailable', 503);
  }

  const inboundLamports = receivedLamportsFrom(probe, leg) || row.lamports;
  const outcome = await deps.store.attributeInbound({
    challengeId: row.id,
    userId: row.userId,
    destination: row.destinationPubkey,
    signature,
    inboundLamports,
    nextStatus,
    rejectedReason,
    // NO `onlyIfClosedForMs`: the user owns their own window, and submission
    // always beats the sweep because the sweep refuses to touch a live row.
    //
    // Two classes of money this challenge's refund can NEVER return, both
    // recorded in the SAME transaction as the attribution: another sender's legs
    // to our address, and legs paid to a DIFFERENT verify address of ours. The
    // second matters because attributing consumes the signature globally, so
    // nothing would ever look at that transaction again.
    obligations: retainedLegObligations(
      row.destinationPubkey,
      signature,
      probe,
      row.walletPubkey,
      row.id,
    ),
    // Rotated-destination debts come from a FRESH read inside the attribution
    // transaction, never from anything this function cached.
    legs: probe.transfers,
  });
  if (!outcome.bound) {
    // Another writer took the row or the signature between our checks.
    const current = await deps.store.getChallengeForUser(input.challengeId, input.userId);
    if (current) return toStatus(current);
    throw new LandHoldVerifyError('challenge_not_found', 404);
  }

  await deps.store
    .markSignatureMatched(row.destinationPubkey, signature)
    .catch(() => undefined);
  await alertRefundQuarantined(outcome, row.id, signature);
  // The obligation rows were written ATOMICALLY above; this only pages ops.
  await alertRetainedLegs(row.destinationPubkey, signature, probe, row.walletPubkey, row.id);

  if (nextStatus === 'rejected') {
    await emitConditionAlert(`inbound-rejected:${rejectedReason}:${row.userId}`, {
      severity: 'warning',
      source: ALERT_SOURCE,
      message:
        'A submitted land hold-wallet transfer could not be proof; it is being refunded and the user was told why.',
      context: { challengeId: row.id, userId: row.userId, reason: rejectedReason },
    });
  }
  if (inboundLamports > row.lamports) {
    await emitConditionAlert(`over-payment:${signature}`, {
      severity: 'warning',
      source: ALERT_SOURCE,
      message:
        'A land hold-wallet transfer sent MORE than the challenge amount; the full received total is recorded and refunded.',
      context: {
        challengeId: row.id,
        signature,
        askedLamports: row.lamports,
        receivedLamports: inboundLamports,
      },
    });
  }

  if (nextStatus === 'observed') {
    await grantObserved([{ ...row, status: 'observed', inboundSignature: signature }]);
  }
  const settled = await deps.store.getChallengeForUser(input.challengeId, input.userId);
  return settled ? toStatus(settled) : toStatus({ ...row, status: nextStatus });
}

// ---------------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------------

/**
 * Background entrypoint. Since round 3 this sweep NEVER verifies anything: it
 * expires lapsed challenges, finds money that arrived but was never submitted so
 * it can be REFUNDED, records refund obligations for funds no challenge can
 * return, and moves refunds forward. Never throws — a failed pass is retried.
 */
export async function sweepTransferChallenges(): Promise<void> {
  try {
    await deps.store.expireLapsedChallenges();
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] expiry sweep failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    const scannable = await deps.store.listScannableChallenges(
      SWEEP_CHALLENGE_LIMIT,
      LATE_ARRIVAL_GRACE_MS,
      UNCLAIMED_CLOSED_MARGIN_MS,
    );
    // REFUND DISCOVERY ONLY. Bounds here cost refund LATENCY, never correctness:
    // verification cannot be lost to them because it does not come from here.
    await attributeChallenges(scannable);
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] attribution sweep failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    await discoverUnclaimedInbound();
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] refund-obligation sweep failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    await advanceRefunds();
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] refund sweep failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    // Retention on the durable scan ledger. The window is far past the longest
    // live challenge + grace, so pruning can never re-open the eclipse it exists
    // to close; it only stops the table growing without bound.
    await deps.store.pruneScanLedger(SCAN_LEDGER_RETENTION_MS);
  } catch (err) {
    console.warn(
      `[${ALERT_SOURCE}] scan-ledger prune failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

/**
 * Boot wiring for the sweeper. Refunds only flow when this runs, so it MUST be
 * started from `apps/api/src/index.ts` beside the other resume workers.
 */
export function startLandHoldVerifySweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    void sweepTransferChallenges().finally(() => {
      sweepInFlight = false;
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  console.log(`[${ALERT_SOURCE}] sweeper started (every ${SWEEP_INTERVAL_MS}ms)`);
}

export function stopLandHoldVerifySweeper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
