/**
 * MARKET PAYOUT EXECUTOR (Tokenomics GoLive executors, 2026-07-07).
 * ============================================================================
 * ███ DARK. NOTHING HERE RUNS TODAY. ███
 *
 * Delivers the two on-chain CLV legs of a settled marketplace sale out of the
 * clv-swap wallet: the SELLER's 95.56% (`seller_payout_usd`) and the treasury's
 * 4.44% rake (`rake_usd`), both converted at the EXECUTED C3 buy rate. Ships
 * ENTIRELY behind the default-OFF `MARKET_PAYOUT_EXECUTE` flag + the
 * mainnet/real-facilitator network guard; NOTHING imports this from index.ts
 * boot (running it is a deliberate, Codex-reviewed wiring change).
 *
 * // FEATURE_GATE: market_payout_executor
 * // Status: dark plumbing — exported but unreachable (default-OFF gate +
 * //   mainnet/mock network guard at every entrypoint); NOT wired into index.ts.
 * // Metric to graduate: Codex adversarial review PASSED on this file +
 * //   migration 0020/0020a/0020b, AND a staging harness smoke of one settled
 * //   deed payout against a funded swap wallet.
 * // Current reading: 0 executions (gate has never been opened).
 * // Review deadline: 2026-08-07.
 * // On deadline: if the go-live is not scheduled, stays dark or is deleted —
 * //   never rots half-reviewed.
 * // Reference: CLAUDE.md kill-the-build invariants; market.ts schema header.
 *
 * ── ORDERING: DEED FIRST, PAYOUT SECOND (Codex, BLOCKING) ────────────────────
 * Eligibility REQUIRES `deed_transferred_at IS NOT NULL` (stamped only by
 * `market-deed-transfer-executor.ts` when the parcel flip COMMITTED). Funds
 * were secured before either executor runs (the settlement row is written
 * post-USDC-capture inside the settle tx), so: money in → deed flips → seller
 * paid. A seller whose deed CONFLICTED (lost the parcel post-settle) is
 * structurally unpayable. A crash between deed and payout is resumable — the
 * payout tick finds the row later.
 *
 * ── CONSERVATION (the keystone): NEVER pay CLV that wasn't bought ────────────
 * All paid CLV derives from the settlement's recorded USD intents at the
 * EXECUTED swap rate of THIS settlement's own C3 funding buy
 * (`clv_buy_queue.executed_price`, joined via `clv_buy_queue_id`; the row must
 * be status='executed'). EXACT-INTEGER, floor, house-favorable:
 *
 *   clvAtomic = ⌊ usdMicro × 10¹² / ratePico ⌋      (pure BigInt division)
 *
 * and the hard tripwire: sellerClv + rakeClv ≤ Σ(outAmountAtomic over the
 * buy's captured fills) — the CLV that was actually bought. Violation ⇒
 * TERMINAL 'reconcile' (conservation_violated), zero sends. The house never
 * custodies proceeds longer than the pipeline needs — the executor exists to
 * drain the swap wallet's bought CLV to its owners.
 *
 * ── E5 PARITY (destination resolution — the branch MUST exist) ───────────────
 *   HUMAN seller ('user')  → `seller_payout_pubkey` stamped on the settlement,
 *     RE-VALIDATED against the seller's CURRENT `users.linked_wallet_pubkey`
 *     (drift ⇒ terminal mismatch — we never guess which wallet to pay).
 *   AGENT seller ('agent') → the agent's CURRENT custodial
 *     `avatars.wallet_address` (cross-checked against the stamped pubkey).
 *   GUEST → REFUSED, always (`guest_seller_refused`). Guests cannot list
 *     (license gate) — this is defense-in-depth, terminal, loud.
 * The seller's subject kind comes from the LISTING's metadata.subjectKind
 * (stamped by createMarketListing from the middleware-resolved subject — NOT
 * the settlement metadata, whose subjectKind is the BUYER's).
 *
 * ── EXACTLY-ONCE MACHINE (the x402/sweep discipline) ─────────────────────────
 *   pending_review → sending   ATOMIC CLAIM (payout_claim_id) BEFORE any
 *                              decrypt/sign/send; double-claim ⇒ 0 rows ⇒ refuse.
 *   CAPTURE-BEFORE-SEND        each leg's signature persists in its OWN
 *                              committed UPDATE (partial-UNIQUE) BEFORE the
 *                              wire is touched; an ambiguous send can never
 *                              lose its money proof.
 *   ambiguous send/confirm     → TERMINAL 'reconcile' — a send that threw is
 *                              money-state UNKNOWN and is NEVER auto-retried.
 *   captured-but-unmarked      → RESUMED, never re-sent: the resume path
 *                              chain-checks the captured signature
 *                              (getSignatureStatuses) and only moves FORWARD
 *                              (confirmed ⇒ next leg / paid; unresolved ⇒
 *                              reconcile). No code path re-sends a captured sig.
 *   pre-capture failure        → claim released to pending_review (nothing was
 *                              signed-and-captured ⇒ nothing sent ⇒ clean retry).
 *
 * ── THE SEND ─────────────────────────────────────────────────────────────────
 * CLV is a MAINNET Token-2022 mint (`CLV_MINT`, 6 decimals — BOTH pinned as
 * code constants). Plain TransferChecked (mint + decimals enforced on-chain)
 * from the clv-swap wallet (`loadClvSwapKeypair()` — the audited shared
 * custody helper; key bytes never logged), with an idempotent ATA create for
 * the destination. Rake destination: the env-pinned
 * `MARKET_RAKE_TREASURY_PUBKEY` (fail closed — unset ⇒ nothing sends; the pin
 * is the deliberate operator statement of where house CLV accrues).
 *
 * LEDGER-ONLY DISCIPLINE: never imports `claw-token-ledger`, never writes
 * `avatars.clawTokens` — real on-chain CLV only, no internal vCLAW.
 */

import { randomUUID } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';
import {
  db,
  marketSettlements,
  marketListings,
  clvBuyQueue,
  avatars,
  users,
  and,
  eq,
  lt,
  sql,
} from '@clawville/database';
import { loadClvSwapKeypair, getClvMainnetConnection } from './clv-swap-custody';
import { assertMainnetRealMoneyContext } from './clv-swap-live';
import { usdcToMicro } from './clv-swap-executor';
import { CLV_MINT } from './clv-price-oracle';
import { readSplTokenBalance } from './solana-token-balance';

// ---------------------------------------------------------------------------
// Gates (default OFF + the shared mainnet/real-facilitator network guard)
// ---------------------------------------------------------------------------

/** True ONLY when `MARKET_PAYOUT_EXECUTE === 'true'`. Default OFF. */
export function isMarketPayoutExecuteEnabled(): boolean {
  return process.env.MARKET_PAYOUT_EXECUTE === 'true';
}

/** Re-asserted at EVERY entrypoint. Throws unless the env is literally 'true'. */
export function requireMarketPayoutExecution(): void {
  if (!isMarketPayoutExecuteEnabled()) {
    throw new Error(
      `[market-payout] executor is DARK — MARKET_PAYOUT_EXECUTE is not 'true' ` +
        `(default-OFF; opening it is a Codex-reviewed change, never an env flip alone)`,
    );
  }
}

/**
 * The rake destination — env-pinned base58 pubkey (`MARKET_RAKE_TREASURY_
 * PUBKEY`). Fail closed: unset/invalid ⇒ null ⇒ the executor refuses BEFORE
 * anything is signed (we never guess where house CLV accrues). Read-only
 * destination — its secret never exists in this process.
 */
export function resolveMarketRakeTreasuryPubkey(): PublicKey | null {
  const raw = process.env.MARKET_RAKE_TREASURY_PUBKEY?.trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    console.error('[market-payout] MARKET_RAKE_TREASURY_PUBKEY is not a valid base58 pubkey');
    return null;
  }
}

/**
 * `MARKET_PAYOUT_STALE_MS` — how old a 'sending' claim must be before the
 * resume path may take it over. Floor 180_000 (same rationale as the x402
 * stale floor: must exceed a live send+confirm cycle with margin so an
 * in-flight payout is never mis-resumed). Default 300_000.
 */
const PAYOUT_STALE_MS_DEFAULT = 5 * 60_000;
const PAYOUT_STALE_MS_FLOOR = 180_000;
export function resolvePayoutStaleMs(): number {
  const raw = process.env.MARKET_PAYOUT_STALE_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= PAYOUT_STALE_MS_FLOOR ? n : PAYOUT_STALE_MS_DEFAULT;
}

// ---------------------------------------------------------------------------
// Exact-integer money math (unit-tested; floor = house-favorable)
// ---------------------------------------------------------------------------

/** CLV is a 6-decimal Token-2022 mint — PINNED (clv-price-oracle.ts header). */
export const CLV_DECIMALS = 6;

/**
 * Parse an executed rate (`clv_buy_queue.executed_price`, numeric(20,12)
 * decimal string, USD per CLV) into integer picoUSD-per-CLV. null on invalid /
 * non-positive input — a payout can never divide by garbage.
 */
export function parseExecutedRateToPico(rate: string): bigint | null {
  if (typeof rate !== 'string') return null;
  const trimmed = rate.trim();
  if (!/^\d{1,8}(\.\d{1,12})?$/.test(trimmed)) return null;
  const [ints, frac = ''] = trimmed.split('.');
  const pico = BigInt(ints) * 10n ** 12n + BigInt((frac + '000000000000').slice(0, 12));
  return pico > 0n ? pico : null;
}

/**
 * usdMicro (µUSD) at ratePico (picoUSD/CLV) → CLV atomic (6 dp), EXACT-INTEGER
 * floor (BigInt division), house-favorable: we never round a payout UP.
 *   clvAtomic = (usdMicro / 1e6) / (ratePico / 1e12) × 1e6 = usdMicro×1e12/ratePico
 */
export function clvAtomicForUsdMicro(usdMicro: bigint, ratePico: bigint): bigint {
  return (usdMicro * 10n ** 12n) / ratePico;
}

// ---------------------------------------------------------------------------
// Token-2022 plumbing (hand-rolled, dependency-light — mirrors clv-swap-live's
// classic-SPL helpers, but against the Token-2022 program CLV lives under)
// ---------------------------------------------------------------------------

const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** Canonical associated-token-account PDA for (owner, CLV mint) under the
 *  Token-2022 program (the token program id is part of the ATA seeds). */
export function findClvAta(owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), new PublicKey(CLV_MINT).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/** ATA-program CreateIdempotent (discriminator 1) for the CLV Token-2022 ATA. */
function createClvAtaIdempotentIx(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(CLV_MINT), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

/** Token-2022 TransferChecked (discriminator 12): [12, u64le amount, u8 decimals].
 *  Checked (not plain Transfer) so the CLV mint + 6 decimals are enforced
 *  ON-CHAIN — a wrong-mint/wrong-scale payout is structurally impossible. */
function clvTransferCheckedIx(
  sourceAta: PublicKey,
  destAta: PublicKey,
  owner: PublicKey,
  amountAtomic: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amountAtomic, 1);
  data.writeUInt8(CLV_DECIMALS, 9);
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(CLV_MINT), isSigner: false, isWritable: false },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Injectable dependencies (tests stub these; defaults are the real impls)
// ---------------------------------------------------------------------------

export interface PayoutSettlementRow {
  id: string;
  listingId: string;
  sellerAvatarId: string;
  buyerAvatarId: string;
  clvBuyQueueId: string;
  sellerPayoutUsd: string;
  rakeUsd: string;
  usdBasis: string;
  payoutStatus: string;
  sellerPayoutPubkey: string | null;
  deedTransferredAt: Date | null;
  payoutClaimId: string | null;
  payoutClaimedAt: Date | null;
  payoutSellerTxSignature: string | null;
  payoutRakeTxSignature: string | null;
  payoutClvAtomic: string | null;
  payoutExecutedRate: string | null;
  payoutFailureReason: string | null;
}

export interface SellerIdentity {
  /** Custodial `avatars.wallet_address` (agent payout destination). */
  walletAddress: string | null;
  avatarIsGuest: boolean;
  userIsGuest: boolean;
  /** The human's CURRENT proven self-custody wallet (`users.linked_wallet_pubkey`). */
  linkedWalletPubkey: string | null;
}

export interface BuyQueueExecution {
  status: string;
  executedPrice: string | null;
  /** Captured per-clip fills; null when tx_signatures is missing/unparseable. */
  fills: Array<{ outAmountAtomic: string }> | null;
}

export interface MarketPayoutDb {
  listEligibleSettlements(limit: number): Promise<PayoutSettlementRow[]>;
  listStaleSending(cutoff: Date, limit: number): Promise<PayoutSettlementRow[]>;
  getSettlement(id: string): Promise<PayoutSettlementRow | null>;
  /** THE atomic claim: pending_review→sending, deed-precondition-checked, RETURNING. */
  claimPayout(id: string, claimId: string): Promise<PayoutSettlementRow | null>;
  /** Resume takeover of a STALE 'sending' claim (payout_claimed_at < cutoff). */
  takeoverStaleClaim(id: string, claimId: string, cutoff: Date): Promise<PayoutSettlementRow | null>;
  /** Pre-capture definitive failure ONLY (guarded: seller signature IS NULL). */
  releasePayoutClaim(id: string, claimId: string): Promise<void>;
  /** Capture-before-send, seller leg (+ the stamped amount + rate), checked. */
  captureSellerSignature(
    id: string,
    claimId: string,
    signature: string,
    sellerClvAtomic: string,
    executedRate: string,
  ): Promise<boolean>;
  /** Capture-before-send, rake leg (+ rake amount into metadata), checked. */
  captureRakeSignature(
    id: string,
    claimId: string,
    signature: string,
    rakeClvAtomic: string,
  ): Promise<boolean>;
  markPaid(id: string, claimId: string): Promise<boolean>;
  /** TERMINAL — operator resolution, never auto-retried. */
  markReconcile(id: string, claimId: string, reason: string): Promise<void>;
  getListingPayoutContext(listingId: string): Promise<{
    itemKind: string;
    /** listing metadata.subjectKind — the SELLER's kind at listing time. */
    sellerSubjectKind: string | null;
    sellerWalletPubkey: string | null;
  } | null>;
  getSellerIdentity(avatarId: string): Promise<SellerIdentity | null>;
  getBuyQueueExecution(queueId: string): Promise<BuyQueueExecution | null>;
}

export interface MarketPayoutDeps {
  db?: MarketPayoutDb;
  loadSwapKeypair?: () => Promise<Keypair>;
  connection?: () => Connection;
  readTokenBalance?: (
    conn: Connection,
    mint: string,
    ownerPubkey: string,
  ) => Promise<{ amountAtomic: bigint }>;
  /** Send a fully-signed raw tx; resolves to the RPC-echoed signature. */
  sendRawTransaction?: (conn: Connection, raw: Uint8Array) => Promise<string>;
  /** 'failed' = definitive on-chain failure (no tokens moved); a THROW = ambiguous. */
  confirmTransaction?: (
    conn: Connection,
    signature: string,
    blockhash: string,
    lastValidBlockHeight: number,
  ) => Promise<'confirmed' | 'failed'>;
  /** Resume chain-check of a CAPTURED signature. A THROW = transient/unresolved. */
  getSignatureStatus?: (
    conn: Connection,
    signature: string,
  ) => Promise<'confirmed' | 'failed' | 'not_found'>;
}

const fillsSchema = z.array(
  z.object({ outAmountAtomic: z.string().regex(/^\d+$/) }).passthrough(),
);

type SettlementSelect = typeof marketSettlements.$inferSelect;

function toPayoutRow(r: SettlementSelect): PayoutSettlementRow {
  return {
    id: r.id,
    listingId: r.listingId,
    sellerAvatarId: r.sellerAvatarId,
    buyerAvatarId: r.buyerAvatarId,
    clvBuyQueueId: r.clvBuyQueueId,
    sellerPayoutUsd: r.sellerPayoutUsd,
    rakeUsd: r.rakeUsd,
    usdBasis: r.usdBasis,
    payoutStatus: r.payoutStatus,
    sellerPayoutPubkey: r.sellerPayoutPubkey,
    deedTransferredAt: r.deedTransferredAt,
    payoutClaimId: r.payoutClaimId,
    payoutClaimedAt: r.payoutClaimedAt,
    payoutSellerTxSignature: r.payoutSellerTxSignature,
    payoutRakeTxSignature: r.payoutRakeTxSignature,
    payoutClvAtomic: r.payoutClvAtomic,
    payoutExecutedRate: r.payoutExecutedRate,
    payoutFailureReason: r.payoutFailureReason,
  };
}

const defaultDb: MarketPayoutDb = {
  async listEligibleSettlements(limit) {
    const n = Math.min(Math.max(1, Math.floor(limit)), 100);
    const rows = await db
      .select()
      .from(marketSettlements)
      .where(
        and(
          eq(marketSettlements.payoutStatus, 'pending_review'),
          sql`${marketSettlements.deedTransferredAt} IS NOT NULL`,
        ),
      )
      .orderBy(marketSettlements.createdAt)
      .limit(n);
    return rows.map(toPayoutRow);
  },
  async listStaleSending(cutoff, limit) {
    const n = Math.min(Math.max(1, Math.floor(limit)), 100);
    const rows = await db
      .select()
      .from(marketSettlements)
      .where(
        and(
          eq(marketSettlements.payoutStatus, 'sending'),
          lt(marketSettlements.payoutClaimedAt, cutoff),
        ),
      )
      .orderBy(marketSettlements.createdAt)
      .limit(n);
    return rows.map(toPayoutRow);
  },
  async getSettlement(id) {
    const [row] = await db
      .select()
      .from(marketSettlements)
      .where(eq(marketSettlements.id, id))
      .limit(1);
    return row ? toPayoutRow(row) : null;
  },
  async claimPayout(id, claimId) {
    const rows = await db
      .update(marketSettlements)
      .set({ payoutStatus: 'sending', payoutClaimId: claimId, payoutClaimedAt: new Date() })
      .where(
        and(
          eq(marketSettlements.id, id),
          eq(marketSettlements.payoutStatus, 'pending_review'),
          sql`${marketSettlements.deedTransferredAt} IS NOT NULL`,
        ),
      )
      .returning();
    return rows[0] ? toPayoutRow(rows[0]) : null;
  },
  async takeoverStaleClaim(id, claimId, cutoff) {
    const rows = await db
      .update(marketSettlements)
      .set({ payoutClaimId: claimId, payoutClaimedAt: new Date() })
      .where(
        and(
          eq(marketSettlements.id, id),
          eq(marketSettlements.payoutStatus, 'sending'),
          lt(marketSettlements.payoutClaimedAt, cutoff),
        ),
      )
      .returning();
    return rows[0] ? toPayoutRow(rows[0]) : null;
  },
  async releasePayoutClaim(id, claimId) {
    await db
      .update(marketSettlements)
      .set({ payoutStatus: 'pending_review', payoutClaimId: null, payoutClaimedAt: null })
      .where(
        and(
          eq(marketSettlements.id, id),
          eq(marketSettlements.payoutClaimId, claimId),
          eq(marketSettlements.payoutStatus, 'sending'),
          // Belt-and-suspenders: a row with a CAPTURED signature may NEVER
          // release back to pending_review (a re-claim could double-send).
          sql`${marketSettlements.payoutSellerTxSignature} IS NULL`,
        ),
      );
  },
  async captureSellerSignature(id, claimId, signature, sellerClvAtomic, executedRate) {
    const rows = await db
      .update(marketSettlements)
      .set({
        payoutSellerTxSignature: signature,
        payoutClvAtomic: sellerClvAtomic,
        payoutExecutedRate: executedRate,
      })
      .where(
        and(
          eq(marketSettlements.id, id),
          eq(marketSettlements.payoutClaimId, claimId),
          eq(marketSettlements.payoutStatus, 'sending'),
          sql`${marketSettlements.payoutSellerTxSignature} IS NULL`,
        ),
      )
      .returning({ id: marketSettlements.id });
    return rows.length > 0;
  },
  async captureRakeSignature(id, claimId, signature, rakeClvAtomic) {
    const rows = await db
      .update(marketSettlements)
      .set({
        payoutRakeTxSignature: signature,
        // MERGE (jsonb ||) — never clobber the settlement metadata.
        metadata: sql`${marketSettlements.metadata} || ${JSON.stringify({ payoutRakeClvAtomic: rakeClvAtomic })}::jsonb`,
      })
      .where(
        and(
          eq(marketSettlements.id, id),
          eq(marketSettlements.payoutClaimId, claimId),
          eq(marketSettlements.payoutStatus, 'sending'),
          sql`${marketSettlements.payoutRakeTxSignature} IS NULL`,
        ),
      )
      .returning({ id: marketSettlements.id });
    return rows.length > 0;
  },
  async markPaid(id, claimId) {
    const rows = await db
      .update(marketSettlements)
      .set({ payoutStatus: 'paid', payoutExecutedAt: new Date() })
      .where(
        and(
          eq(marketSettlements.id, id),
          eq(marketSettlements.payoutClaimId, claimId),
          eq(marketSettlements.payoutStatus, 'sending'),
        ),
      )
      .returning({ id: marketSettlements.id });
    return rows.length > 0;
  },
  async markReconcile(id, claimId, reason) {
    await db
      .update(marketSettlements)
      .set({ payoutStatus: 'reconcile', payoutFailureReason: reason })
      .where(
        and(
          eq(marketSettlements.id, id),
          eq(marketSettlements.payoutClaimId, claimId),
          eq(marketSettlements.payoutStatus, 'sending'),
        ),
      );
  },
  async getListingPayoutContext(listingId) {
    const [row] = await db
      .select({
        itemKind: marketListings.itemKind,
        metadata: marketListings.metadata,
        sellerWalletPubkey: marketListings.sellerWalletPubkey,
      })
      .from(marketListings)
      .where(eq(marketListings.id, listingId))
      .limit(1);
    if (!row) return null;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const kind = meta.subjectKind;
    return {
      itemKind: row.itemKind,
      sellerSubjectKind: kind === 'user' || kind === 'agent' ? kind : null,
      sellerWalletPubkey: row.sellerWalletPubkey,
    };
  },
  async getSellerIdentity(avatarId) {
    const [row] = await db
      .select({
        walletAddress: avatars.walletAddress,
        avatarIsGuest: avatars.isGuest,
        userIsGuest: users.isGuest,
        linkedWalletPubkey: users.linkedWalletPubkey,
      })
      .from(avatars)
      .leftJoin(users, eq(users.id, avatars.userId))
      .where(eq(avatars.id, avatarId))
      .limit(1);
    if (!row) return null;
    return {
      walletAddress: row.walletAddress,
      avatarIsGuest: row.avatarIsGuest,
      userIsGuest: row.userIsGuest ?? false,
      linkedWalletPubkey: row.linkedWalletPubkey,
    };
  },
  async getBuyQueueExecution(queueId) {
    const [row] = await db
      .select({
        status: clvBuyQueue.status,
        executedPrice: clvBuyQueue.executedPrice,
        txSignatures: clvBuyQueue.txSignatures,
      })
      .from(clvBuyQueue)
      .where(eq(clvBuyQueue.id, queueId))
      .limit(1);
    if (!row) return null;
    const parsed = fillsSchema.safeParse(row.txSignatures ?? []);
    return {
      status: row.status,
      executedPrice: row.executedPrice,
      fills: parsed.success ? parsed.data : null,
    };
  },
};

function resolveDeps(deps?: MarketPayoutDeps): Required<MarketPayoutDeps> {
  return {
    db: deps?.db ?? defaultDb,
    loadSwapKeypair: deps?.loadSwapKeypair ?? loadClvSwapKeypair,
    connection: deps?.connection ?? getClvMainnetConnection,
    readTokenBalance:
      deps?.readTokenBalance ??
      (async (conn, mint, owner) => {
        const b = await readSplTokenBalance(conn, mint, owner);
        return { amountAtomic: b.amountAtomic };
      }),
    sendRawTransaction:
      deps?.sendRawTransaction ??
      (async (conn, raw) => conn.sendRawTransaction(raw, { skipPreflight: false })),
    confirmTransaction:
      deps?.confirmTransaction ??
      (async (conn, signature, blockhash, lastValidBlockHeight) => {
        const res = await conn.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed',
        );
        return res.value.err ? 'failed' : 'confirmed';
      }),
    getSignatureStatus:
      deps?.getSignatureStatus ??
      (async (conn, signature) => {
        const res = await conn.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        const st = res.value[0];
        if (!st) return 'not_found';
        if (st.err) return 'failed';
        // Only confirmed/finalized count — 'processed' can still be rolled
        // back, and the resume path must never move forward on a maybe.
        return st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized'
          ? 'confirmed'
          : 'not_found';
      }),
  };
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type MarketPayoutResult =
  | {
      ok: true;
      settlementId: string;
      sellerTxSignature: string;
      /** null when the rake floored to 0 atomic (dust — stays in the swap wallet). */
      rakeTxSignature: string | null;
      sellerClvAtomic: string;
      rakeClvAtomic: string;
      sellerDestination: string;
      rakeDestination: string | null;
      replay: boolean;
      resumed: boolean;
    }
  | {
      ok: false;
      code:
        | 'invalid_settlement_id'
        | 'settlement_not_found'
        | 'deed_not_transferred' // precondition — deed first, payout second
        | 'payout_in_flight' // a live claim holds the row
        | 'payout_terminal' // reconcile/rejected — operator resolution
        | 'payout_not_resumable'
        | 'claim_lost'
        | 'seller_subject_unresolvable' // → reconcile
        | 'guest_seller_refused' // → reconcile (NEVER pay a guest)
        | 'payout_destination_missing' // → reconcile
        | 'payout_destination_mismatch' // → reconcile
        | 'clv_buy_not_executed' // claim released — retry after the C3 buy fills
        | 'usd_amount_unparseable' // → reconcile
        | 'executed_rate_invalid' // → reconcile
        | 'no_recorded_fills' // → reconcile
        | 'conservation_violated' // → reconcile — NEVER pay CLV that wasn't bought
        | 'payout_dust' // → reconcile (seller amount floors to 0)
        | 'rake_treasury_unpinned' // claim released — set MARKET_RAKE_TREASURY_PUBKEY
        | 'insufficient_swap_wallet_clv' // claim released — retry once funded
        | 'capture_lost'
        | 'send_ambiguous' // → reconcile — money-state UNKNOWN, never retried
        | 'seller_tx_failed' // → reconcile — definitive on-chain failure
        | 'rake_tx_failed' // → reconcile — seller paid, rake tx failed on-chain
        | 'resume_unresolved' // → reconcile — captured sig not provable on chain
        | 'resume_transient' // chain check errored — row stays 'sending', retried later
        | 'released_for_retry'; // resume found nothing captured — clean re-claim
      detail?: string;
    };

const uuidSchema = z.string().uuid();

function replayResult(row: PayoutSettlementRow, resumed: boolean): MarketPayoutResult {
  return {
    ok: true,
    settlementId: row.id,
    sellerTxSignature: row.payoutSellerTxSignature ?? '',
    rakeTxSignature: row.payoutRakeTxSignature,
    sellerClvAtomic: row.payoutClvAtomic ?? '0',
    rakeClvAtomic: '0',
    sellerDestination: row.sellerPayoutPubkey ?? '',
    rakeDestination: null,
    replay: true,
    resumed,
  };
}

// ---------------------------------------------------------------------------
// Destination + amount resolution (pure-read phase — runs under the claim)
// ---------------------------------------------------------------------------

interface ResolvedPayout {
  sellerDestination: PublicKey;
  sellerClvAtomic: bigint;
  rakeClvAtomic: bigint;
  executedRate: string;
}

type ResolveOutcome =
  | { ok: true; resolved: ResolvedPayout }
  | {
      ok: false;
      /** true ⇒ TERMINAL (markReconcile); false ⇒ release the claim (retryable). */
      terminal: boolean;
      code: Extract<
        MarketPayoutResult,
        { ok: false }
      >['code'];
      reason: string;
      detail?: string;
    };

async function resolvePayoutTargets(
  row: PayoutSettlementRow,
  d: Required<MarketPayoutDeps>,
): Promise<ResolveOutcome> {
  // 1) The seller's subject kind — from the LISTING metadata (the seller's
  //    kind at listing time; the settlement metadata carries the BUYER's).
  const listing = await d.db.getListingPayoutContext(row.listingId);
  if (!listing || !listing.sellerSubjectKind) {
    return {
      ok: false,
      terminal: true,
      code: 'seller_subject_unresolvable',
      reason: 'seller_subject_unresolvable',
    };
  }

  // 2) The seller's CURRENT identity — guest check + live wallet columns.
  const seller = await d.db.getSellerIdentity(row.sellerAvatarId);
  if (!seller) {
    return {
      ok: false,
      terminal: true,
      code: 'seller_subject_unresolvable',
      reason: 'seller_avatar_missing',
    };
  }
  if (seller.avatarIsGuest || seller.userIsGuest) {
    // NEVER pay a guest — guests cannot list (license gate); terminal + loud.
    return {
      ok: false,
      terminal: true,
      code: 'guest_seller_refused',
      reason: 'guest_seller_refused',
    };
  }

  // 3) E5 destination branch (the branch MUST exist).
  let destination: string | null;
  if (listing.sellerSubjectKind === 'user') {
    // HUMAN → the stamped seller_payout_pubkey, RE-VALIDATED against the
    // user's CURRENT proven linked wallet. Drift ⇒ terminal (never guess).
    destination = row.sellerPayoutPubkey;
    if (!destination) {
      return {
        ok: false,
        terminal: true,
        code: 'payout_destination_missing',
        reason: 'human_payout_pubkey_missing',
      };
    }
    if (!seller.linkedWalletPubkey || seller.linkedWalletPubkey !== destination) {
      return {
        ok: false,
        terminal: true,
        code: 'payout_destination_mismatch',
        reason: 'human_linked_wallet_mismatch',
        detail: seller.linkedWalletPubkey ? 'relinked' : 'unlinked',
      };
    }
  } else {
    // AGENT → its CURRENT custodial avatar wallet, cross-checked against the
    // stamped default. The agent plays as ITSELF — real settlement, no demo.
    destination = seller.walletAddress;
    if (!destination) {
      return {
        ok: false,
        terminal: true,
        code: 'payout_destination_missing',
        reason: 'agent_custodial_wallet_missing',
      };
    }
    if (row.sellerPayoutPubkey && row.sellerPayoutPubkey !== destination) {
      return {
        ok: false,
        terminal: true,
        code: 'payout_destination_mismatch',
        reason: 'agent_wallet_mismatch',
      };
    }
  }
  let sellerDestination: PublicKey;
  try {
    sellerDestination = new PublicKey(destination);
  } catch {
    return {
      ok: false,
      terminal: true,
      code: 'payout_destination_missing',
      reason: 'destination_not_base58',
    };
  }

  // 4) CONSERVATION — amounts derive from the EXECUTED C3 buy of THIS
  //    settlement, and can never exceed the CLV that buy actually produced.
  const buy = await d.db.getBuyQueueExecution(row.clvBuyQueueId);
  if (!buy || buy.status !== 'executed' || !buy.executedPrice) {
    // The funding buy hasn't executed yet — RETRYABLE (release the claim).
    return {
      ok: false,
      terminal: false,
      code: 'clv_buy_not_executed',
      reason: 'clv_buy_not_executed',
      detail: buy?.status ?? 'missing',
    };
  }
  const ratePico = parseExecutedRateToPico(buy.executedPrice);
  if (ratePico === null) {
    return {
      ok: false,
      terminal: true,
      code: 'executed_rate_invalid',
      reason: 'executed_rate_invalid',
      detail: buy.executedPrice,
    };
  }
  const sellerUsdMicro = usdcToMicro(row.sellerPayoutUsd);
  // A ZERO rake is legitimate (rake_bps could be 0) — usdcToMicro rejects
  // all-zero strings by design, so special-case it to 0n before parsing.
  const rakeUsdMicro = /^0+(?:\.0+)?$/.test(row.rakeUsd.trim())
    ? 0n
    : usdcToMicro(row.rakeUsd);
  if (sellerUsdMicro === null || rakeUsdMicro === null) {
    return {
      ok: false,
      terminal: true,
      code: 'usd_amount_unparseable',
      reason: 'usd_amount_unparseable',
    };
  }
  const sellerClvAtomic = clvAtomicForUsdMicro(sellerUsdMicro, ratePico);
  const rakeClvAtomic = clvAtomicForUsdMicro(rakeUsdMicro, ratePico);
  if (sellerClvAtomic <= 0n) {
    return { ok: false, terminal: true, code: 'payout_dust', reason: 'seller_amount_floors_to_zero' };
  }
  if (buy.fills === null) {
    return {
      ok: false,
      terminal: true,
      code: 'no_recorded_fills',
      reason: 'fills_unparseable',
    };
  }
  const totalBought = buy.fills.reduce((acc, f) => acc + BigInt(f.outAmountAtomic), 0n);
  if (buy.fills.length === 0 || totalBought <= 0n) {
    return { ok: false, terminal: true, code: 'no_recorded_fills', reason: 'no_recorded_fills' };
  }
  if (sellerClvAtomic + rakeClvAtomic > totalBought) {
    console.error(
      `[market-payout] CONSERVATION VIOLATED — settlement=${row.id} seller=${sellerClvAtomic} + ` +
        `rake=${rakeClvAtomic} > bought=${totalBought} (rate=${buy.executedPrice}); ` +
        `REFUSING — never pay CLV that wasn't bought`,
    );
    return {
      ok: false,
      terminal: true,
      code: 'conservation_violated',
      reason: 'conservation_violated',
    };
  }

  return {
    ok: true,
    resolved: {
      sellerDestination,
      sellerClvAtomic,
      rakeClvAtomic,
      executedRate: buy.executedPrice,
    },
  };
}

// ---------------------------------------------------------------------------
// The send legs
// ---------------------------------------------------------------------------

async function buildAndSignClvSend(
  conn: Connection,
  keypair: Keypair,
  destOwner: PublicKey,
  amountAtomic: bigint,
): Promise<{ txn: Transaction; signature: string; blockhash: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const txn = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight });
  const sourceAta = findClvAta(keypair.publicKey);
  const destAta = findClvAta(destOwner);
  txn.add(createClvAtaIdempotentIx(keypair.publicKey, destAta, destOwner));
  txn.add(clvTransferCheckedIx(sourceAta, destAta, keypair.publicKey, amountAtomic));
  txn.sign(keypair);
  if (!txn.signature) {
    throw new Error('[market-payout] signing produced no signature');
  }
  return { txn, signature: bs58.encode(txn.signature), blockhash, lastValidBlockHeight };
}

/**
 * The RAKE leg (shared by execute + resume). Assumes the seller leg is DONE.
 * rake of 0 atomic (dust floor) ⇒ no send — the dust stays in the swap wallet
 * (house-favorable; recorded via the metadata patch on capture when > 0).
 */
async function runRakeLeg(input: {
  settlementId: string;
  claimId: string;
  rakeClvAtomic: bigint;
  /** May be null ONLY when rakeClvAtomic is 0 (no send happens). */
  rakeDestination: PublicKey | null;
  keypair: Keypair;
  conn: Connection;
  d: Required<MarketPayoutDeps>;
}): Promise<{ ok: true; signature: string | null } | { ok: false; result: MarketPayoutResult }> {
  const { settlementId, claimId, rakeClvAtomic, rakeDestination, keypair, conn, d } = input;
  if (rakeClvAtomic <= 0n) return { ok: true, signature: null };
  if (!rakeDestination) {
    // Callers resolve the pin before reaching here — defensive fail-closed.
    throw new Error('[market-payout] runRakeLeg: rake destination missing with a non-zero rake');
  }

  const built = await buildAndSignClvSend(conn, keypair, rakeDestination, rakeClvAtomic);

  // CAPTURE-BEFORE-SEND (rake).
  const captured = await d.db.captureRakeSignature(
    settlementId,
    claimId,
    built.signature,
    rakeClvAtomic.toString(),
  );
  if (!captured) {
    // Claim no longer ours AFTER the seller was paid — do NOT send; loud
    // terminal (the seller leg's signature is already durable on the row).
    console.error(
      `[market-payout] RAKE CAPTURE LOST after seller paid — settlement=${settlementId}; → reconcile`,
    );
    await d.db.markReconcile(settlementId, claimId, 'rake_capture_lost');
    return { ok: false, result: { ok: false, code: 'capture_lost', detail: 'rake' } };
  }

  let sent = false;
  try {
    await d.sendRawTransaction(conn, built.txn.serialize());
    sent = true;
    const outcome = await d.confirmTransaction(
      conn,
      built.signature,
      built.blockhash,
      built.lastValidBlockHeight,
    );
    if (outcome === 'failed') {
      console.error(
        `[market-payout] RAKE TX FAILED ON-CHAIN — settlement=${settlementId} tx=${built.signature}; ` +
          `seller IS paid; no rake moved; → reconcile (manual re-run decision)`,
      );
      await d.db.markReconcile(settlementId, claimId, 'rake_tx_failed_on_chain');
      return { ok: false, result: { ok: false, code: 'rake_tx_failed' } };
    }
  } catch (err) {
    const phase = sent ? 'confirm' : 'send';
    console.error(
      `[market-payout] AMBIGUOUS RAKE ${phase.toUpperCase()} — settlement=${settlementId} ` +
        `tx=${built.signature}; money-state UNKNOWN → reconcile (no re-send): ${(err as Error).message}`,
    );
    await d.db.markReconcile(settlementId, claimId, `rake_${phase}_ambiguous`);
    return { ok: false, result: { ok: false, code: 'send_ambiguous', detail: `rake_${phase}` } };
  }
  return { ok: true, signature: built.signature };
}

// ---------------------------------------------------------------------------
// executeMarketPayout — the main entrypoint (one settlement)
// ---------------------------------------------------------------------------

/**
 * Pay out ONE settled-and-deed-transferred marketplace sale. LIVE — gated
 * (throws) unless `MARKET_PAYOUT_EXECUTE === 'true'` AND the mainnet/
 * real-facilitator network guard holds. See the module header for the full
 * money discipline.
 */
export async function executeMarketPayout(
  settlementId: string,
  deps?: MarketPayoutDeps,
): Promise<MarketPayoutResult> {
  requireMarketPayoutExecution();
  assertMainnetRealMoneyContext();
  if (!uuidSchema.safeParse(settlementId).success) {
    return { ok: false, code: 'invalid_settlement_id' };
  }
  const d = resolveDeps(deps);

  // 1) Load + dispatch non-consumable states (idempotent replay for 'paid').
  const row = await d.db.getSettlement(settlementId);
  if (!row) return { ok: false, code: 'settlement_not_found' };
  if (row.payoutStatus === 'paid') return replayResult(row, false);
  if (row.payoutStatus === 'sending') return { ok: false, code: 'payout_in_flight' };
  if (row.payoutStatus !== 'pending_review') {
    return { ok: false, code: 'payout_terminal', detail: row.payoutStatus };
  }
  // 2) DEED PRECONDITION — deed first, payout second (no claim without it).
  if (!row.deedTransferredAt) {
    return { ok: false, code: 'deed_not_transferred' };
  }

  // 3) ATOMIC CLAIM — pending_review→sending BEFORE any decrypt/sign/send.
  const claimId = randomUUID();
  const claimed = await d.db.claimPayout(settlementId, claimId);
  if (!claimed) return { ok: false, code: 'claim_lost' };
  if (claimed.payoutSellerTxSignature) {
    // A pending_review row can never carry a captured signature — corruption.
    console.error(
      `[market-payout] CLAIMED ROW CARRIES A PRIOR SIGNATURE — settlement=${settlementId}; → reconcile`,
    );
    await d.db.markReconcile(settlementId, claimId, 'claim_with_prior_signature');
    return { ok: false, code: 'payout_terminal', detail: 'claim_with_prior_signature' };
  }

  // 4) Resolve destination + amounts (reads only — nothing signed yet).
  const outcome = await resolvePayoutTargets(claimed, d);
  if (!outcome.ok) {
    if (outcome.terminal) {
      console.error(
        `[market-payout] TERMINAL REFUSAL — settlement=${settlementId} reason=${outcome.reason}` +
          `${outcome.detail ? ` (${outcome.detail})` : ''}; → reconcile (operator resolution)`,
      );
      await d.db.markReconcile(settlementId, claimId, outcome.reason);
    } else {
      await d.db.releasePayoutClaim(settlementId, claimId);
    }
    return { ok: false, code: outcome.code, detail: outcome.detail };
  }
  const { sellerDestination, sellerClvAtomic, rakeClvAtomic, executedRate } = outcome.resolved;

  // 5) Rake destination pin — resolved BEFORE anything signs (fail closed;
  //    releasing here is clean: nothing captured, nothing sent).
  const rakeDestination = rakeClvAtomic > 0n ? resolveMarketRakeTreasuryPubkey() : null;
  if (rakeClvAtomic > 0n && !rakeDestination) {
    await d.db.releasePayoutClaim(settlementId, claimId);
    return { ok: false, code: 'rake_treasury_unpinned' };
  }

  // Once a signature is captured the claim may NEVER release (reconcile only).
  let sigCaptured = false;
  try {
    // 6) Custody (AFTER the claim — the claim is the exclusivity) + funds.
    const keypair = await d.loadSwapKeypair();
    const conn = d.connection();
    const balance = await d.readTokenBalance(conn, CLV_MINT, keypair.publicKey.toBase58());
    if (balance.amountAtomic < sellerClvAtomic + rakeClvAtomic) {
      await d.db.releasePayoutClaim(settlementId, claimId);
      return {
        ok: false,
        code: 'insufficient_swap_wallet_clv',
        detail: `have=${balance.amountAtomic} need=${sellerClvAtomic + rakeClvAtomic}`,
      };
    }

    // 7) SELLER LEG — build + sign, CAPTURE-BEFORE-SEND, send + confirm.
    const built = await buildAndSignClvSend(conn, keypair, sellerDestination, sellerClvAtomic);
    const captured = await d.db.captureSellerSignature(
      settlementId,
      claimId,
      built.signature,
      sellerClvAtomic.toString(),
      executedRate,
    );
    if (!captured) {
      // Claim no longer ours — do NOT send. Nothing has moved.
      return { ok: false, code: 'capture_lost', detail: 'seller' };
    }
    sigCaptured = true;

    let sent = false;
    try {
      await d.sendRawTransaction(conn, built.txn.serialize());
      sent = true;
      const legOutcome = await d.confirmTransaction(
        conn,
        built.signature,
        built.blockhash,
        built.lastValidBlockHeight,
      );
      if (legOutcome === 'failed') {
        console.error(
          `[market-payout] SELLER TX FAILED ON-CHAIN — settlement=${settlementId} ` +
            `tx=${built.signature}; no CLV moved; → reconcile (manual re-run decision)`,
        );
        await d.db.markReconcile(settlementId, claimId, 'seller_tx_failed_on_chain');
        return { ok: false, code: 'seller_tx_failed' };
      }
    } catch (err) {
      const phase = sent ? 'confirm' : 'send';
      console.error(
        `[market-payout] AMBIGUOUS SELLER ${phase.toUpperCase()} — settlement=${settlementId} ` +
          `tx=${built.signature}; money-state UNKNOWN → reconcile (no re-send): ${(err as Error).message}`,
      );
      await d.db.markReconcile(settlementId, claimId, `seller_${phase}_ambiguous`);
      return { ok: false, code: 'send_ambiguous', detail: `seller_${phase}` };
    }

    // 8) RAKE LEG (seller confirmed).
    const rake = await runRakeLeg({
      settlementId,
      claimId,
      rakeClvAtomic,
      rakeDestination,
      keypair,
      conn,
      d,
    });
    if (!rake.ok) return rake.result;

    // 9) PAID — both legs confirmed (checked to our claim).
    const marked = await d.db.markPaid(settlementId, claimId);
    if (!marked) {
      console.error(
        `[market-payout] PAID-MARK MISSED after confirmed sends — settlement=${settlementId} ` +
          `sellerTx=${built.signature} rakeTx=${rake.signature ?? 'none'}; signatures ARE durable; manual verify`,
      );
    }
    return {
      ok: true,
      settlementId,
      sellerTxSignature: built.signature,
      rakeTxSignature: rake.signature,
      sellerClvAtomic: sellerClvAtomic.toString(),
      rakeClvAtomic: rakeClvAtomic.toString(),
      sellerDestination: sellerDestination.toBase58(),
      rakeDestination: rakeDestination ? rakeDestination.toBase58() : null,
      replay: false,
      resumed: false,
    };
  } catch (err) {
    if (sigCaptured) {
      // A signature exists — a send MAY have happened. NEVER release; the
      // reconciler resolves against the chain.
      console.error(
        `[market-payout] UNEXPECTED POST-CAPTURE ERROR — settlement=${settlementId}: ` +
          `${(err as Error).message}; → reconcile (signature is durable)`,
      );
      await d.db.markReconcile(settlementId, claimId, 'payout_unexpected_post_capture');
      return { ok: false, code: 'send_ambiguous', detail: 'unexpected_post_capture' };
    }
    // Pre-capture failure (custody/RPC/blockhash/signing) — nothing captured,
    // nothing sent: release for a clean retry, then surface the error.
    console.error(
      `[market-payout] pre-send failure — settlement=${settlementId}: ${(err as Error).message}`,
    );
    await d.db.releasePayoutClaim(settlementId, claimId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// resumeMarketPayout — restart-after-send-before-mark (resume, NEVER re-send)
// ---------------------------------------------------------------------------

/**
 * Resume ONE stale 'sending' payout left behind by a crash. The captured
 * signature is chain-checked and the machine only moves FORWARD:
 *   rake sig captured + confirmed        → markPaid (zero sends).
 *   seller sig captured + confirmed      → run the RAKE leg fresh (the seller
 *                                          leg is proven done — not re-sent),
 *                                          then markPaid.
 *   captured but NOT provable on chain   → TERMINAL reconcile (never re-send —
 *                                          the tx may still land).
 *   nothing captured                     → nothing was ever sent (capture-
 *                                          before-send) → claim released for a
 *                                          clean re-claim.
 * Only claims older than `resolvePayoutStaleMs()` are taken over — a live
 * in-flight payout is never stolen.
 */
export async function resumeMarketPayout(
  settlementId: string,
  deps?: MarketPayoutDeps,
): Promise<MarketPayoutResult> {
  requireMarketPayoutExecution();
  assertMainnetRealMoneyContext();
  if (!uuidSchema.safeParse(settlementId).success) {
    return { ok: false, code: 'invalid_settlement_id' };
  }
  const d = resolveDeps(deps);

  const row = await d.db.getSettlement(settlementId);
  if (!row) return { ok: false, code: 'settlement_not_found' };
  if (row.payoutStatus === 'paid') return replayResult(row, true);
  if (row.payoutStatus !== 'sending') {
    return { ok: false, code: 'payout_not_resumable', detail: row.payoutStatus };
  }

  // Stale takeover — atomic; a fresh claim refuses (payout_in_flight).
  const claimId = randomUUID();
  const cutoff = new Date(Date.now() - resolvePayoutStaleMs());
  const taken = await d.db.takeoverStaleClaim(settlementId, claimId, cutoff);
  if (!taken) return { ok: false, code: 'payout_in_flight' };

  const conn = d.connection();

  // Case A — rake signature captured: the ONLY remaining step is the paid-mark.
  if (taken.payoutRakeTxSignature) {
    let status: 'confirmed' | 'failed' | 'not_found';
    try {
      status = await d.getSignatureStatus(conn, taken.payoutRakeTxSignature);
    } catch (err) {
      console.error(
        `[market-payout] resume chain-check errored (transient) — settlement=${settlementId}: ` +
          `${(err as Error).message}; row stays 'sending' for a later resume`,
      );
      return { ok: false, code: 'resume_transient', detail: 'rake_status_check' };
    }
    if (status === 'confirmed') {
      await d.db.markPaid(settlementId, claimId);
      return {
        ok: true,
        settlementId,
        sellerTxSignature: taken.payoutSellerTxSignature ?? '',
        rakeTxSignature: taken.payoutRakeTxSignature,
        sellerClvAtomic: taken.payoutClvAtomic ?? '0',
        rakeClvAtomic: '0',
        sellerDestination: taken.sellerPayoutPubkey ?? '',
        rakeDestination: null,
        replay: false,
        resumed: true,
      };
    }
    await d.db.markReconcile(
      settlementId,
      claimId,
      status === 'failed' ? 'rake_resume_failed_on_chain' : 'rake_resume_unresolved',
    );
    return { ok: false, code: 'resume_unresolved', detail: `rake_${status}` };
  }

  // Case B — seller signature captured: prove it, then run the rake leg fresh.
  if (taken.payoutSellerTxSignature) {
    let status: 'confirmed' | 'failed' | 'not_found';
    try {
      status = await d.getSignatureStatus(conn, taken.payoutSellerTxSignature);
    } catch (err) {
      console.error(
        `[market-payout] resume chain-check errored (transient) — settlement=${settlementId}: ` +
          `${(err as Error).message}; row stays 'sending' for a later resume`,
      );
      return { ok: false, code: 'resume_transient', detail: 'seller_status_check' };
    }
    if (status !== 'confirmed') {
      // NEVER re-send a captured signature — unresolved/failed goes to the
      // operator (the tx could still land inside its blockhash window).
      await d.db.markReconcile(
        settlementId,
        claimId,
        status === 'failed' ? 'seller_resume_failed_on_chain' : 'seller_resume_unresolved',
      );
      return { ok: false, code: 'resume_unresolved', detail: `seller_${status}` };
    }

    // Seller leg PROVEN done. Recompute the rake from the STAMPED rate (the
    // same rate the seller leg used — a resume never re-prices).
    const stampedRate = taken.payoutExecutedRate;
    const ratePico = stampedRate ? parseExecutedRateToPico(stampedRate) : null;
    const rakeUsdMicro = usdcToMicro(taken.rakeUsd);
    if (ratePico === null || rakeUsdMicro === null) {
      await d.db.markReconcile(settlementId, claimId, 'resume_stamped_rate_invalid');
      return { ok: false, code: 'executed_rate_invalid', detail: 'stamped' };
    }
    const rakeClvAtomic = clvAtomicForUsdMicro(rakeUsdMicro, ratePico);

    // Conservation re-check with the STAMPED seller amount.
    const buy = await d.db.getBuyQueueExecution(taken.clvBuyQueueId);
    const totalBought =
      buy && buy.fills ? buy.fills.reduce((acc, f) => acc + BigInt(f.outAmountAtomic), 0n) : null;
    const stampedSellerClv = taken.payoutClvAtomic ? BigInt(taken.payoutClvAtomic) : null;
    if (totalBought === null || stampedSellerClv === null) {
      await d.db.markReconcile(settlementId, claimId, 'resume_conservation_unverifiable');
      return { ok: false, code: 'no_recorded_fills', detail: 'resume' };
    }
    if (stampedSellerClv + rakeClvAtomic > totalBought) {
      await d.db.markReconcile(settlementId, claimId, 'conservation_violated');
      return { ok: false, code: 'conservation_violated', detail: 'resume' };
    }

    const rakeDestination = rakeClvAtomic > 0n ? resolveMarketRakeTreasuryPubkey() : null;
    if (rakeClvAtomic > 0n && !rakeDestination) {
      // Do NOT release (the seller sig is captured) — the resume simply cannot
      // finish until ops pins the rake destination. Row stays 'sending'.
      return { ok: false, code: 'rake_treasury_unpinned', detail: 'resume' };
    }

    const keypair = await d.loadSwapKeypair();
    const rake = await runRakeLeg({
      settlementId,
      claimId,
      rakeClvAtomic,
      rakeDestination,
      keypair,
      conn,
      d,
    });
    if (!rake.ok) return rake.result;

    await d.db.markPaid(settlementId, claimId);
    return {
      ok: true,
      settlementId,
      sellerTxSignature: taken.payoutSellerTxSignature,
      rakeTxSignature: rake.signature,
      sellerClvAtomic: stampedSellerClv.toString(),
      rakeClvAtomic: rakeClvAtomic.toString(),
      sellerDestination: taken.sellerPayoutPubkey ?? '',
      rakeDestination: rakeDestination ? rakeDestination.toBase58() : null,
      replay: false,
      resumed: true,
    };
  }

  // Case C — nothing captured ⇒ nothing sent (capture-before-send) ⇒ clean
  // release; the next execute tick re-claims from scratch.
  await d.db.releasePayoutClaim(settlementId, claimId);
  return { ok: false, code: 'released_for_retry' };
}

// ---------------------------------------------------------------------------
// runMarketPayoutTick — resume stale rows, then execute fresh ones
// ---------------------------------------------------------------------------

/**
 * One pass: (1) resume stale 'sending' claims (crash recovery — forward-only,
 * never a re-send), then (2) execute eligible fresh payouts oldest-first.
 * Exported for the (future, Codex-gated) worker + staging harness — index.ts
 * does NOT call this; the executor ships dark.
 */
export async function runMarketPayoutTick(
  deps?: MarketPayoutDeps,
  limit = 10,
): Promise<Array<{ settlementId: string; result: MarketPayoutResult }>> {
  requireMarketPayoutExecution();
  assertMainnetRealMoneyContext();
  const d = resolveDeps(deps);
  const out: Array<{ settlementId: string; result: MarketPayoutResult }> = [];

  const cutoff = new Date(Date.now() - resolvePayoutStaleMs());
  const stale = await d.db.listStaleSending(cutoff, limit);
  for (const row of stale) {
    try {
      out.push({ settlementId: row.id, result: await resumeMarketPayout(row.id, deps) });
    } catch (err) {
      console.error(
        `[market-payout] resume failed (non-fatal) — settlement=${row.id}: ${(err as Error).message}`,
      );
    }
  }

  const fresh = await d.db.listEligibleSettlements(limit);
  for (const row of fresh) {
    try {
      out.push({ settlementId: row.id, result: await executeMarketPayout(row.id, deps) });
    } catch (err) {
      console.error(
        `[market-payout] execute failed (non-fatal) — settlement=${row.id}: ${(err as Error).message}`,
      );
    }
  }
  return out;
}
