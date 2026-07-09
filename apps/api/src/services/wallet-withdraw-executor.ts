/**
 * CUSTODIAL WALLET WITHDRAW EXECUTOR (2026-07-08).
 * ============================================================================
 * ███ DARK. NOTHING HERE SENDS TODAY. ███
 *
 * Moves a user's OWN deposited on-chain assets (SOL / USDC / CLV) out of their
 * in-game custodial avatar wallet to a self-custody destination. This SIGNS
 * with the user's custodial keypair and moves REAL mainnet assets — a
 * double-send is a real double-withdrawal — so the whole flow runs the
 * market-payout-executor / x402-checkout exactly-once discipline. Ships
 * ENTIRELY behind the default-OFF `WALLET_WITHDRAW_ENABLED` flag; the route
 * (`routes/wallet-withdraw.ts`) refuses with a typed `withdraw_disabled`
 * while it is unset.
 *
 * ── EXACTLY-ONCE MACHINE (rows in the `withdrawals` table, migration 0021) ───
 *   pending → sending      ATOMIC CLAIM (claim_id, WHERE status='pending'
 *                          RETURNING) BEFORE any decrypt/sign/send;
 *                          double-claim ⇒ 0 rows ⇒ refuse.
 *   CAPTURE-BEFORE-SEND    build tx with a fresh blockhash → sign with the
 *                          custodial keypair → the deterministic FIRST
 *                          signature persists in its OWN committed UPDATE
 *                          (partial-UNIQUE) BEFORE sendRawTransaction.
 *   ambiguous send/confirm → TERMINAL 'reconcile' — money-state UNKNOWN and
 *                          NEVER auto-retried; the captured signature is the
 *                          operator's chain-poll anchor.
 *   definitive on-chain err → 'failed' (tx landed with an error; no assets
 *                          moved). Terminal, auditable.
 *   pre-capture failure    → claim released to 'pending' (guarded
 *                          tx_signature IS NULL): nothing signed ⇒ nothing
 *                          sent ⇒ clean retry.
 *   resume (stale 'sending') → FORWARD-ONLY via getSignatureStatus:
 *                          confirmed ⇒ 'sent'; on-chain err ⇒ 'failed';
 *                          not_found/unresolved ⇒ 'reconcile'. NO code path
 *                          re-signs or re-sends a captured signature.
 *
 * ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 * `POST /api/wallet/withdraw` REQUIRES an `Idempotency-Key` header; the
 * partial-UNIQUE (subject_type, avatar_id, idempotency_key) makes a retry
 * replay the EXISTING row's state — never a second withdrawal. A replayed
 * 'pending' row is re-executed (claim races decide a single winner); a
 * replayed 'sending' row reports in-flight; 'sent'/'failed'/'reconcile'
 * replay their terminal state.
 *
 * ── CUSTODY (defense-in-depth, the clv-swap-custody discipline) ─────────────
 * `loadAvatarWithdrawKeypair(avatarId)`: wallets row (subject_type='avatar')
 * → `decryptWalletRow` → the decrypted pubkey MUST equal the row's own
 * `public_key` AND (when present) the `avatars.wallet_address` mirror —
 * mismatch = refuse-to-sign, terminal. Key bytes are NEVER logged, echoed,
 * persisted, or returned; errors carry PUBLIC keys only. NO memoization —
 * per-user keys are decrypted on demand and held only in local scope. The
 * "one approved export channel" doctrine stands: withdraw signs SERVER-SIDE,
 * the secret never leaves the process.
 *
 * ── THE SENDS (mainnet-only; mints + decimals PINNED as code constants) ─────
 *   SOL  — SystemProgram.transfer (9 dp lamports).
 *   USDC — classic-SPL TransferChecked (Token program, USDC_MINT_MAINNET, 6 dp).
 *   CLV  — Token-2022 TransferChecked (CLV_MINT, 6 dp) — mirrors the
 *          market-payout-executor's clvTransferCheckedIx.
 * Token sends resolve source+dest ATAs and create the DEST ATA idempotently
 * (payer = the custodial wallet) when missing — that rent is part of the fee
 * headroom below. NETWORK GUARD: `assertMainnetWithdrawConnection` refuses any
 * connection whose endpoint is not unambiguously mainnet (devnet/testnet/
 * localhost can never reach a real send); the default connection is the PINNED
 * `getClvMainnetConnection()` which cannot be env-pointed at devnet.
 *
 * ── VALIDATION (all BEFORE any claim/sign) ──────────────────────────────────
 *   destination — base58, 32 bytes, ON-CURVE (`PublicKey.isOnCurve`; PDAs /
 *                 off-curve/unspendable keys refused), != the caller's own
 *                 custodial wallet.
 *   amount      — positive integer string (BigInt), ≤ u64 max.
 *   balance     — amount ≤ on-chain balance; the source keeps
 *                 rent-exempt-minimum + tx fee (+ dest-ATA rent when the token
 *                 destination has no ATA yet) of SOL — never drained below.
 *   CLV hold    — INFORMED-CONSENT gate (2026-07-09; NOT enforcement — the
 *                 land rent sweeper owns enforcement): a CLV withdrawal that
 *                 would drop the custodial balance below the avatar's stacked
 *                 AGENT-subject land-hold requirement refuses typed
 *                 `hold_at_risk` (409) UNLESS the request carries
 *                 `acknowledgeHoldLoss: true`. PRE-ROW (no row inserted on
 *                 refusal); FAIL-OPEN on the threshold-query error only.
 *                 There are NO daily caps (removed 2026-07-09 by founder
 *                 decision — the balance/fee guards are the only limits).
 *   Balance-read failure ⇒ REFUSE (`balance_unavailable`) — never fail-open.
 *
 * ── LEDGER-UNTOUCHED ────────────────────────────────────────────────────────
 * This moves ON-CHAIN custody assets, NOT internal vCLAW. Nothing in this file
 * (or the route) imports `claw-token-ledger` or writes `avatars.clawTokens` —
 * a withdrawal is NOT a cash-out.
 *
 * ── E5 PARITY ───────────────────────────────────────────────────────────────
 * `resolveWithdrawSubject` maps the middleware identity: a human (Lucia) and a
 * connected/hosted agent BOTH withdraw from THEIR OWN avatar's custodial
 * wallet (never body-supplied). Non-ledger agent sessions are refused
 * (`agent_not_ledger_capable`, 403 at the route); guests are 403'd by
 * `requireNonGuestIdentity`. NO KYC.
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
import {
  db,
  withdrawals,
  wallets,
  avatars,
  and,
  eq,
  lt,
  sql,
  type WithdrawalRow,
} from '@clawville/database';
import { alertError, type AlertErrorParams } from './alert-error';
import { decryptWalletRow } from './keypair-vault';
import { getClvMainnetConnection } from './clv-swap-custody';
import { readSplTokenBalance } from './solana-token-balance';
import { CLV_MINT } from './clv-price-oracle';
import { USDC_MINT_MAINNET } from './x402-payai';
import type { ActivityIdentity } from '../middleware/require-auth-or-agent';

// ---------------------------------------------------------------------------
// Gate (default OFF) + network guard
// ---------------------------------------------------------------------------

/** True ONLY when `WALLET_WITHDRAW_ENABLED === 'true'`. Default OFF. */
export function isWalletWithdrawEnabled(): boolean {
  return process.env.WALLET_WITHDRAW_ENABLED === 'true';
}

/** Re-asserted inside the claimed execute path (belt-and-suspenders on top of
 *  the request-path typed refusal). Throws unless the env is literally 'true'. */
export function requireWalletWithdrawEnabled(): void {
  if (!isWalletWithdrawEnabled()) {
    throw new Error(
      `[wallet-withdraw] executor is DARK — WALLET_WITHDRAW_ENABLED is not 'true' ` +
        `(default-OFF; opening it is a reviewed change, never an env flip alone)`,
    );
  }
}

/** The ONLY network this executor knows. Stamped on every row; devnet is
 *  structurally unreachable (see the guard + the pinned default connection). */
export const WITHDRAW_NETWORK = 'mainnet' as const;

/**
 * MAINNET GUARD — refuses any connection whose RPC endpoint is not
 * unambiguously mainnet. The default connection is `getClvMainnetConnection()`
 * (Helius mainnet / public mainnet-beta — never env-pointable at devnet); this
 * guard is defense-in-depth against an injected/mocked connection reaching a
 * real send. Runs BEFORE any balance read, claim, decrypt, sign, or send.
 */
export function assertMainnetWithdrawConnection(conn: Connection): void {
  const endpoint = conn.rpcEndpoint ?? '';
  if (!/mainnet/i.test(endpoint) || /devnet|testnet|localhost|127\.0\.0\.1/i.test(endpoint)) {
    throw new Error(
      `[wallet-withdraw] NETWORK GUARD: connection endpoint is not mainnet — real ` +
        `withdrawals are mainnet-only; devnet/testnet/local can never reach a send.`,
    );
  }
}

/**
 * `WALLET_WITHDRAW_STALE_MS` — how old a 'sending' claim must be before the
 * resume path may take it over. Floor 180_000 (must exceed a live
 * send+confirm cycle with margin so an in-flight withdrawal is never
 * mis-resumed — the x402/payout stale floor). Default 300_000.
 */
const WITHDRAW_STALE_MS_DEFAULT = 5 * 60_000;
const WITHDRAW_STALE_MS_FLOOR = 180_000;
export function resolveWithdrawStaleMs(): number {
  const raw = process.env.WALLET_WITHDRAW_STALE_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= WITHDRAW_STALE_MS_FLOOR ? n : WITHDRAW_STALE_MS_DEFAULT;
}

// ---------------------------------------------------------------------------
// Assets (mints + decimals PINNED as code constants — never env)
// ---------------------------------------------------------------------------

export const WITHDRAW_ASSETS = ['SOL', 'USDC', 'CLV'] as const;
export type WithdrawAsset = (typeof WITHDRAW_ASSETS)[number];

export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;
export const CLV_DECIMALS = 6;

/** Classic SPL Token program (USDC). */
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** Token-2022 program (CLV). */
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

interface TokenAssetSpec {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
}

function tokenSpec(asset: 'USDC' | 'CLV'): TokenAssetSpec {
  return asset === 'USDC'
    ? { mint: new PublicKey(USDC_MINT_MAINNET), tokenProgram: TOKEN_PROGRAM_ID, decimals: USDC_DECIMALS }
    : { mint: new PublicKey(CLV_MINT), tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: CLV_DECIMALS };
}

/** Base fee for our single-signer legacy tx (no priority fee is attached). */
export const WITHDRAW_TX_FEE_LAMPORTS = 5_000n;
/** SPL token account size — drives the dest-ATA rent part of the fee headroom. */
const TOKEN_ACCOUNT_BYTES = 165;
/** u64 ceiling — the on-wire amount encoding (and SPL amounts) are u64. */
const U64_MAX = 2n ** 64n - 1n;

// ---------------------------------------------------------------------------
// SPL / ATA plumbing (hand-rolled, dependency-light — mirrors the
// market-payout-executor / clv-swap-live helpers, parameterized by program)
// ---------------------------------------------------------------------------

/** Canonical ATA PDA for (owner, mint) under the given token program. */
export function findAtaForProgram(owner: PublicKey, spec: TokenAssetSpec): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), spec.tokenProgram.toBuffer(), spec.mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/** ATA-program CreateIdempotent (discriminator 1). Payer = the custodial wallet. */
function createAtaIdempotentIx(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  spec: TokenAssetSpec,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: spec.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: spec.tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

/** TransferChecked (discriminator 12): [12, u64le amount, u8 decimals].
 *  Checked (not plain Transfer) so mint + decimals are enforced ON-CHAIN —
 *  a wrong-mint/wrong-scale withdrawal is structurally impossible. Same wire
 *  layout for classic SPL and Token-2022. */
function transferCheckedIx(
  sourceAta: PublicKey,
  destAta: PublicKey,
  owner: PublicKey,
  amountAtomic: bigint,
  spec: TokenAssetSpec,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amountAtomic, 1);
  data.writeUInt8(spec.decimals, 9);
  return new TransactionInstruction({
    programId: spec.tokenProgram,
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: spec.mint, isSigner: false, isWritable: false },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Custody — the avatar's custodial keypair (defense-in-depth; never cached)
// ---------------------------------------------------------------------------

/** Tagged custody error so the executor can pattern-match without string-parsing. */
export class WalletWithdrawCustodyError extends Error {
  constructor(
    message: string,
    public readonly code: 'wallet_missing' | 'avatar_missing' | 'pubkey_mismatch',
  ) {
    super(message);
    this.name = 'WalletWithdrawCustodyError';
  }
}

/**
 * Load + decrypt the avatar's custodial signing keypair with the
 * clv-swap-custody defense-in-depth discipline:
 *   1. decrypted pubkey MUST equal the wallets row's own `public_key`;
 *   2. it MUST equal the `avatars.wallet_address` mirror WHEN the mirror is
 *      present (a NULL mirror — a not-yet-backfilled legit state — does NOT
 *      lock the user out; only present-and-mismatched refuses, per the
 *      fail-closed-null-init rule).
 * Key bytes are NEVER logged/echoed/persisted; error messages carry PUBLIC
 * keys only. NOT memoized — decrypted on demand, held only in local scope.
 */
export async function loadAvatarWithdrawKeypair(avatarId: string): Promise<Keypair> {
  const row = await db.query.wallets.findFirst({
    where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
  });
  if (!row) {
    throw new WalletWithdrawCustodyError(
      `[wallet-withdraw] avatar ${avatarId} has no custodial wallet row — refusing to sign.`,
      'wallet_missing',
    );
  }
  const keypair = await decryptWalletRow(row);
  const actual = keypair.publicKey.toBase58();
  // Defense-in-depth 1: the decrypted secret must reproduce the row's OWN
  // public_key column (catches a corrupted/mismatched row).
  if (actual !== row.publicKey) {
    throw new WalletWithdrawCustodyError(
      `[wallet-withdraw] custody pubkey mismatch for avatar ${avatarId}: decrypted ${actual} != ` +
        `row public_key ${row.publicKey}. Refusing to sign — re-provision the wallet row.`,
      'pubkey_mismatch',
    );
  }
  // Defense-in-depth 2: the avatars.wallet_address mirror must agree WHEN set.
  const [avatarRow] = await db
    .select({ walletAddress: avatars.walletAddress })
    .from(avatars)
    .where(eq(avatars.id, avatarId))
    .limit(1);
  if (!avatarRow) {
    throw new WalletWithdrawCustodyError(
      `[wallet-withdraw] avatar ${avatarId} not found — refusing to sign.`,
      'avatar_missing',
    );
  }
  if (avatarRow.walletAddress && avatarRow.walletAddress !== actual) {
    throw new WalletWithdrawCustodyError(
      `[wallet-withdraw] custody pubkey mismatch for avatar ${avatarId}: decrypted ${actual} != ` +
        `avatars.wallet_address mirror ${avatarRow.walletAddress}. Refusing to sign.`,
      'pubkey_mismatch',
    );
  }
  return keypair;
}

// ---------------------------------------------------------------------------
// E5 subject resolution (route imports this; tests hit it without the route)
// ---------------------------------------------------------------------------

export interface WithdrawSubject {
  avatarId: string;
  userId: string | null;
  kind: 'user' | 'agent';
  agentId: string | null;
}

/** Map the middleware identity to the withdraw subject; refuses a non-ledger
 *  agent session (the cove/checkout/market real-money convention — an
 *  ownership-unproven or restored session may perceive but never trigger a
 *  custodial decrypt/sign). */
export function resolveWithdrawSubject(
  identity: ActivityIdentity,
): { subject: WithdrawSubject } | { error: 'agent_not_ledger_capable' } {
  if (identity.kind === 'agent' && !identity.ledgerCapable) {
    return { error: 'agent_not_ledger_capable' };
  }
  return {
    subject: {
      avatarId: identity.avatarId,
      userId: identity.userId ?? null,
      kind: identity.kind,
      agentId: identity.kind === 'agent' ? identity.agentId : null,
    },
  };
}

// ---------------------------------------------------------------------------
// CLV land-hold consent gate (2026-07-09) — types + formatting
// ---------------------------------------------------------------------------
// There are NO daily caps (removed 2026-07-09 by founder decision). The only
// per-request limits are the balance/fee guards above and, for CLV, the
// informed-consent hold gate below — which warns, never enforces (the land
// rent sweeper owns hold enforcement; see land-rent-sweeper.ts `sweepHold`).

/** The avatar's stacked AGENT-subject land-hold requirement (CLV uiAmount). */
export interface HoldRequirement {
  /** SUM(hold_threshold_ct) over the avatar's agent-subject, non-grandfathered
   *  'hold' parcels — CLV **uiAmount** integer (despite the `_ct` suffix; see
   *  packages/database/src/schema/land.ts `holdThresholdCt`). */
  requiredUiAmount: number;
  parcels: Array<{ parcelCode: string; holdThresholdCt: number }>;
}

/** The `hold_at_risk` refusal payload (surfaced verbatim in the 409 body). */
export interface HoldAtRiskDetail {
  /** Total CLV (uiAmount, integer) the avatar's agent-subject holds require. */
  requiredUiAmount: number;
  /** Post-withdrawal CLV balance as an exact 6dp decimal string (e.g. "400.000000"). */
  postUiAmount: string;
  parcels: Array<{ parcelCode: string; holdThresholdCt: number }>;
}

/** Exact decimal string for an atomic amount (no float math on money). */
export function atomicToDecimalString(atomic: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = atomic / base;
  const frac = (atomic % base).toString().padStart(decimals, '0');
  return `${whole}.${frac}`;
}

// ---------------------------------------------------------------------------
// Injectable dependencies (tests stub these; defaults are the real impls)
// ---------------------------------------------------------------------------

export interface WithdrawInsert {
  subjectType: 'user' | 'agent';
  avatarId: string;
  userId: string | null;
  asset: WithdrawAsset;
  amountAtomic: string;
  destination: string;
  idempotencyKey: string;
  network: typeof WITHDRAW_NETWORK;
  metadata: Record<string, unknown>;
}

export interface WalletWithdrawDb {
  /** The caller's custodial wallet pubkey (wallets row — the canonical source). */
  getWalletPubkey(avatarId: string): Promise<string | null>;
  /** INSERT the pending row; null when the (subject, idempotency_key) UNIQUE
   *  tripped (a concurrent retry won the insert — caller re-fetches). */
  insertWithdrawal(input: WithdrawInsert): Promise<WithdrawalRow | null>;
  findById(id: string): Promise<WithdrawalRow | null>;
  findByIdempotencyKey(
    subjectType: 'user' | 'agent',
    avatarId: string,
    key: string,
  ): Promise<WithdrawalRow | null>;
  /** THE atomic claim: pending→sending, WHERE status='pending', RETURNING. */
  claimPending(id: string, claimId: string): Promise<WithdrawalRow | null>;
  /** Resume takeover of a STALE 'sending' claim (claimed_at < cutoff). */
  takeoverStaleClaim(id: string, claimId: string, cutoff: Date): Promise<WithdrawalRow | null>;
  /** Pre-capture failure ONLY (guarded: tx_signature IS NULL) → back to 'pending'. */
  releaseClaim(id: string, claimId: string): Promise<void>;
  /** Capture-before-send. 'sig_conflict' = the partial-UNIQUE tripped (another
   *  row owns this signature) — nothing was sent; release + retry is safe. */
  captureSignature(
    id: string,
    claimId: string,
    signature: string,
  ): Promise<'captured' | 'lost' | 'sig_conflict'>;
  markSent(id: string, claimId: string): Promise<boolean>;
  /** Definitive failure of a CLAIMED row (on-chain err / custody refusal). */
  markFailed(id: string, claimId: string, reason: string): Promise<void>;
  /** TERMINAL — money-state UNKNOWN; operator resolution, never auto-retried. */
  markReconcile(id: string, claimId: string, reason: string): Promise<void>;
  /** The avatar's stacked AGENT-subject land-hold requirement (consent gate).
   *  Mirrors the land-rent-sweeper stacked-SUM semantics: tenure='hold' AND
   *  hold_subject='agent' AND grandfathered=false. A THROW here FAILS OPEN
   *  (the gate is consent, not enforcement). */
  getAgentHoldRequirement(avatarId: string): Promise<HoldRequirement>;
  listStaleSending(cutoff: Date, limit: number): Promise<WithdrawalRow[]>;
}

export interface WalletWithdrawDeps {
  db?: WalletWithdrawDb;
  loadKeypair?: (avatarId: string) => Promise<Keypair>;
  connection?: () => Connection;
  getLatestBlockhash?: (
    conn: Connection,
  ) => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** Lamport balance of a system account. */
  getSolBalance?: (conn: Connection, ownerPubkey: string) => Promise<bigint>;
  /** SPL/Token-2022 balance (summed over the owner's accounts of the mint). */
  getTokenBalance?: (
    conn: Connection,
    mint: string,
    ownerPubkey: string,
  ) => Promise<{ amountAtomic: bigint }>;
  /** Whether the account exists (dest-ATA probe for the rent headroom). */
  getAccountExists?: (conn: Connection, pubkey: PublicKey) => Promise<boolean>;
  /** Rent-exempt minimum for an account of `bytes` data. */
  getRentExemptMinimum?: (conn: Connection, bytes: number) => Promise<bigint>;
  /** Send a fully-signed raw tx; resolves to the RPC-echoed signature. */
  sendRawTransaction?: (conn: Connection, raw: Uint8Array) => Promise<string>;
  /** 'failed' = definitive on-chain failure (no assets moved); a THROW = ambiguous. */
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
  /** Ops alert channel (resume worker pages on reconcile). Default: alertError
   *  (Telegram, never-throws). Injectable so tests observe the page. */
  alert?: (params: AlertErrorParams) => Promise<void>;
}

function pgUniqueViolation(err: unknown): boolean {
  const code =
    (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === '23505';
}

const defaultDb: WalletWithdrawDb = {
  async getWalletPubkey(avatarId) {
    const row = await db.query.wallets.findFirst({
      where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
      columns: { publicKey: true },
    });
    return row?.publicKey ?? null;
  },
  async insertWithdrawal(input) {
    try {
      const [row] = await db
        .insert(withdrawals)
        .values({
          subjectType: input.subjectType,
          avatarId: input.avatarId,
          userId: input.userId,
          asset: input.asset,
          amountAtomic: input.amountAtomic,
          destination: input.destination,
          idempotencyKey: input.idempotencyKey,
          network: input.network,
          metadata: input.metadata,
        })
        .returning();
      return row ?? null;
    } catch (err) {
      if (pgUniqueViolation(err)) return null; // concurrent idem retry won
      throw err;
    }
  },
  async findById(id) {
    const [row] = await db.select().from(withdrawals).where(eq(withdrawals.id, id)).limit(1);
    return row ?? null;
  },
  async findByIdempotencyKey(subjectType, avatarId, key) {
    const [row] = await db
      .select()
      .from(withdrawals)
      .where(
        and(
          eq(withdrawals.subjectType, subjectType),
          eq(withdrawals.avatarId, avatarId),
          eq(withdrawals.idempotencyKey, key),
        ),
      )
      .limit(1);
    return row ?? null;
  },
  async claimPending(id, claimId) {
    const rows = await db
      .update(withdrawals)
      .set({ status: 'sending', claimId, claimedAt: new Date() })
      .where(and(eq(withdrawals.id, id), eq(withdrawals.status, 'pending')))
      .returning();
    return rows[0] ?? null;
  },
  async takeoverStaleClaim(id, claimId, cutoff) {
    const rows = await db
      .update(withdrawals)
      .set({ claimId, claimedAt: new Date() })
      .where(
        and(
          eq(withdrawals.id, id),
          eq(withdrawals.status, 'sending'),
          lt(withdrawals.claimedAt, cutoff),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
  async releaseClaim(id, claimId) {
    await db
      .update(withdrawals)
      .set({ status: 'pending', claimId: null, claimedAt: null })
      .where(
        and(
          eq(withdrawals.id, id),
          eq(withdrawals.claimId, claimId),
          eq(withdrawals.status, 'sending'),
          // Belt-and-suspenders: a row with a CAPTURED signature may NEVER
          // release back to pending (a re-claim could double-send).
          sql`${withdrawals.txSignature} IS NULL`,
        ),
      );
  },
  async captureSignature(id, claimId, signature) {
    try {
      const rows = await db
        .update(withdrawals)
        .set({ txSignature: signature })
        .where(
          and(
            eq(withdrawals.id, id),
            eq(withdrawals.claimId, claimId),
            eq(withdrawals.status, 'sending'),
            sql`${withdrawals.txSignature} IS NULL`,
          ),
        )
        .returning({ id: withdrawals.id });
      return rows.length > 0 ? 'captured' : 'lost';
    } catch (err) {
      if (pgUniqueViolation(err)) return 'sig_conflict';
      throw err;
    }
  },
  async markSent(id, claimId) {
    const rows = await db
      .update(withdrawals)
      .set({ status: 'sent', sentAt: new Date() })
      .where(
        and(
          eq(withdrawals.id, id),
          eq(withdrawals.claimId, claimId),
          eq(withdrawals.status, 'sending'),
        ),
      )
      .returning({ id: withdrawals.id });
    return rows.length > 0;
  },
  async markFailed(id, claimId, reason) {
    await db
      .update(withdrawals)
      .set({ status: 'failed', failureReason: reason })
      .where(
        and(
          eq(withdrawals.id, id),
          eq(withdrawals.claimId, claimId),
          eq(withdrawals.status, 'sending'),
        ),
      );
  },
  async markReconcile(id, claimId, reason) {
    await db
      .update(withdrawals)
      .set({ status: 'reconcile', failureReason: reason })
      .where(
        and(
          eq(withdrawals.id, id),
          eq(withdrawals.claimId, claimId),
          eq(withdrawals.status, 'sending'),
        ),
      );
  },
  async getAgentHoldRequirement(avatarId) {
    // Mirrors the land-rent-sweeper stacked-requirement semantics (its
    // `resolveHoldClv` + SUM query, land-rent-sweeper.ts ~§hold): ONLY
    // AGENT-subject holds are backed by THIS custodial wallet
    // (hold_subject='user' checks the human's LINKED wallet — unaffected by a
    // custodial withdrawal); grandfathered legacy holds are never CLV-checked
    // and are EXCLUDED from the stacked sum. `hold_threshold_ct` is CLV
    // **uiAmount** (integer), despite the `_ct` suffix — see
    // packages/database/src/schema/land.ts. One query returns the per-parcel
    // list; the stacked SUM derives from the same snapshot in JS (ownership
    // cap keeps this a handful of rows).
    const rows = await db.execute<{ parcel_code: string; hold_threshold_ct: number | string }>(
      sql`SELECT parcel_code, hold_threshold_ct
          FROM land_parcels
          WHERE owner_avatar_id = ${avatarId}
            AND tenure = 'hold'
            AND hold_subject = 'agent'
            AND grandfathered = false
            AND hold_threshold_ct IS NOT NULL`,
    );
    const parcels = Array.from(
      rows as Iterable<{ parcel_code: string; hold_threshold_ct: number | string }>,
    ).map((r) => ({
      parcelCode: r.parcel_code,
      holdThresholdCt: Number(r.hold_threshold_ct),
    }));
    return {
      requiredUiAmount: parcels.reduce((sum, p) => sum + p.holdThresholdCt, 0),
      parcels,
    };
  },
  async listStaleSending(cutoff, limit) {
    const n = Math.min(Math.max(1, Math.floor(limit)), 100);
    return db
      .select()
      .from(withdrawals)
      .where(and(eq(withdrawals.status, 'sending'), lt(withdrawals.claimedAt, cutoff)))
      .orderBy(withdrawals.createdAt)
      .limit(n);
  },
};

function resolveDeps(deps?: WalletWithdrawDeps): Required<WalletWithdrawDeps> {
  return {
    db: deps?.db ?? defaultDb,
    loadKeypair: deps?.loadKeypair ?? loadAvatarWithdrawKeypair,
    connection: deps?.connection ?? getClvMainnetConnection,
    getLatestBlockhash:
      deps?.getLatestBlockhash ?? (async (conn) => conn.getLatestBlockhash('confirmed')),
    getSolBalance:
      deps?.getSolBalance ??
      (async (conn, owner) => BigInt(await conn.getBalance(new PublicKey(owner), 'confirmed'))),
    getTokenBalance:
      deps?.getTokenBalance ??
      (async (conn, mint, owner) => {
        const b = await readSplTokenBalance(conn, mint, owner);
        return { amountAtomic: b.amountAtomic };
      }),
    getAccountExists:
      deps?.getAccountExists ??
      (async (conn, pubkey) => (await conn.getAccountInfo(pubkey, 'confirmed')) !== null),
    getRentExemptMinimum:
      deps?.getRentExemptMinimum ??
      (async (conn, bytes) => BigInt(await conn.getMinimumBalanceForRentExemption(bytes))),
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
    alert: deps?.alert ?? alertError,
  };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface WithdrawalView {
  id: string;
  status: 'pending' | 'sending' | 'sent' | 'reconcile' | 'failed';
  asset: WithdrawAsset;
  amountAtomic: string;
  destination: string;
  txSignature: string | null;
  network: string;
  createdAt: string;
  sentAt: string | null;
}

export type WithdrawErrorCode =
  | 'withdraw_disabled' // flag OFF — the whole feature is dark
  | 'amount_invalid' // not a positive integer string / > u64
  | 'invalid_destination' // not base58 / not 32 bytes / OFF-CURVE (PDA)
  | 'self_send' // destination == the caller's own custodial wallet
  | 'wallet_missing' // the avatar has no custodial wallet row
  | 'balance_unavailable' // on-chain balance read failed — REFUSE, never fail-open
  | 'insufficient_balance' // amount > on-chain balance
  | 'insufficient_sol_for_fee' // source can't keep rent-exempt min + fee (+ dest-ATA rent)
  | 'hold_at_risk' // CLV consent gate: withdrawal would break a land hold; retry with acknowledgeHoldLoss
  | 'idempotency_conflict' // the key was reused with a DIFFERENT asset/amount/destination
  | 'withdrawal_in_flight' // a live 'sending' claim holds the row
  | 'withdrawal_failed' // replay of a terminal 'failed' row
  | 'withdrawal_reconcile' // terminal reconcile — operator resolution
  | 'withdrawal_not_found'
  | 'not_resumable'
  | 'capture_lost' // claim no longer ours at capture time — NOTHING was sent
  | 'custody_failed' // custody refusal (missing row / pubkey mismatch) — terminal
  | 'transient_failure' // pre-capture infra failure — claim released, clean retry
  | 'tx_failed' // DEFINITIVE on-chain failure (no assets moved) → 'failed'
  | 'send_ambiguous' // ambiguous send/confirm → TERMINAL 'reconcile'
  | 'resume_transient' // resume chain-check errored — row stays 'sending'
  | 'released_for_retry'; // resume found nothing captured — clean re-claim

export type WithdrawResult =
  | { ok: true; withdrawal: WithdrawalView; replay: boolean; resumed: boolean }
  | {
      ok: false;
      code: WithdrawErrorCode;
      detail?: string;
      withdrawalId?: string;
      txSignature?: string | null;
      /** Present ONLY on `hold_at_risk` — the consent-gate payload the route
       *  surfaces verbatim in the 409 body. */
      holdAtRisk?: HoldAtRiskDetail;
    };

function toView(row: WithdrawalRow): WithdrawalView {
  return {
    id: row.id,
    status: row.status,
    asset: row.asset as WithdrawAsset,
    amountAtomic: row.amountAtomic,
    destination: row.destination,
    txSignature: row.txSignature,
    network: row.network,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
  };
}

/** Map an existing row's state to a replay result (never a second send). */
function replayRow(row: WithdrawalRow, resumed = false): WithdrawResult {
  switch (row.status) {
    case 'sent':
      return { ok: true, withdrawal: toView(row), replay: true, resumed };
    case 'sending':
      return { ok: false, code: 'withdrawal_in_flight', withdrawalId: row.id };
    case 'failed':
      return {
        ok: false,
        code: 'withdrawal_failed',
        detail: row.failureReason ?? undefined,
        withdrawalId: row.id,
        txSignature: row.txSignature,
      };
    case 'reconcile':
      return {
        ok: false,
        code: 'withdrawal_reconcile',
        detail: row.failureReason ?? undefined,
        withdrawalId: row.id,
        txSignature: row.txSignature,
      };
    default:
      // 'pending' is handled by the caller (re-execute) — this is a fallback.
      return { ok: false, code: 'withdrawal_in_flight', withdrawalId: row.id };
  }
}

/**
 * An Idempotency-Key retry must carry the SAME request the original did — a
 * reused key with a DIFFERENT asset/amount/destination is a client bug (or an
 * attack) and silently replaying the OLD withdrawal would mislead the caller
 * into believing a NEW one happened. Stripe-style: refuse loudly.
 *
 * `acknowledgeHoldLoss` is DELIBERATELY NOT compared — it is a consent flag,
 * not part of the withdrawal identity. The unacknowledged `hold_at_risk`
 * refusal created NO row, so the acknowledged retry with the same key inserts
 * cleanly; and a later replay of an acknowledged row without the flag is
 * still the same withdrawal.
 */
function idempotencyBodyMatches(row: WithdrawalRow, input: WithdrawRequest): boolean {
  const normalizedAmount = /^\d+$/.test(input.amountAtomic)
    ? BigInt(input.amountAtomic).toString()
    : input.amountAtomic;
  return (
    row.asset === input.asset &&
    row.amountAtomic === normalizedAmount &&
    row.destination === input.destination
  );
}

// ---------------------------------------------------------------------------
// Static validation (pure — before any DB row exists)
// ---------------------------------------------------------------------------

export type StaticValidation =
  | { ok: true; amount: bigint; destination: PublicKey }
  | { ok: false; code: 'amount_invalid' | 'invalid_destination' | 'self_send'; detail?: string };

/** All the pre-claim checks that need no I/O. Exported for unit tests. */
export function validateWithdrawStatic(input: {
  amountAtomic: string;
  destination: string;
  sourcePubkey: string;
}): StaticValidation {
  if (!/^\d{1,20}$/.test(input.amountAtomic)) {
    return { ok: false, code: 'amount_invalid', detail: 'not_a_positive_integer_string' };
  }
  const amount = BigInt(input.amountAtomic);
  if (amount <= 0n) return { ok: false, code: 'amount_invalid', detail: 'zero' };
  if (amount > U64_MAX) return { ok: false, code: 'amount_invalid', detail: 'exceeds_u64' };

  let destBytes: Uint8Array;
  try {
    destBytes = bs58.decode(input.destination);
  } catch {
    return { ok: false, code: 'invalid_destination', detail: 'not_base58' };
  }
  if (destBytes.length !== 32) {
    return { ok: false, code: 'invalid_destination', detail: 'not_32_bytes' };
  }
  // ON-CURVE only: PDAs / off-curve keys have no private key — assets sent
  // there are unspendable by any wallet. Refuse rather than burn.
  if (!PublicKey.isOnCurve(destBytes)) {
    return { ok: false, code: 'invalid_destination', detail: 'off_curve' };
  }
  const destination = new PublicKey(destBytes);
  if (destination.toBase58() === input.sourcePubkey) {
    return { ok: false, code: 'self_send' };
  }
  return { ok: true, amount, destination };
}

// ---------------------------------------------------------------------------
// requestWithdrawal — the route entrypoint (validate → insert → execute)
// ---------------------------------------------------------------------------

export interface WithdrawRequest {
  subject: WithdrawSubject;
  asset: WithdrawAsset;
  amountAtomic: string;
  destination: string;
  /** REQUIRED — the (subject, key) UNIQUE makes a retry replay, never re-send. */
  idempotencyKey: string;
  /** CLV-only consent flag: `true` bypasses ONLY the `hold_at_risk` consent
   *  gate (the caller has been told the withdrawal breaks their land hold and
   *  accepts losing the parcel(s) to the rent sweeper). It relaxes NOTHING
   *  else — balance/fee/on-curve/self-send and every exactly-once guard are
   *  untouched. NOT part of the idempotency identity. */
  acknowledgeHoldLoss?: boolean;
}

/**
 * Validate → idempotency-replay → balance/fee guards → CLV hold consent gate →
 * insert 'pending' → claim+sign+capture+send+confirm, synchronously. Every
 * path either returns a typed refusal or drives the row to a terminal/'sent'
 * state. NEVER throws for expected money-path outcomes; throws only on the
 * dark-gate/network-guard violations (programming/config errors, loud by
 * design).
 */
export async function requestWithdrawal(
  input: WithdrawRequest,
  deps?: WalletWithdrawDeps,
): Promise<WithdrawResult> {
  // The flag gates the ENTIRE write path (reads live in getCustodialWalletBalances).
  if (!isWalletWithdrawEnabled()) {
    return { ok: false, code: 'withdraw_disabled' };
  }
  const d = resolveDeps(deps);

  // 0) Idempotency replay FIRST — a retry must never re-validate into a
  //    different answer than the original request produced.
  const existing = await d.db.findByIdempotencyKey(
    input.subject.kind,
    input.subject.avatarId,
    input.idempotencyKey,
  );
  if (existing) {
    if (!idempotencyBodyMatches(existing, input)) {
      return {
        ok: false,
        code: 'idempotency_conflict',
        detail: 'key_reused_with_different_request',
        withdrawalId: existing.id,
      };
    }
    if (existing.status === 'pending') {
      // The original request crashed pre-claim (or was released pre-capture):
      // nothing was ever signed — re-execute the SAME row (claim races decide
      // a single winner; never a second row).
      return executeClaimedWithdrawal(existing.id, d);
    }
    return replayRow(existing);
  }

  // 1) Source custodial wallet (public key only — no decrypt yet).
  const sourcePubkey = await d.db.getWalletPubkey(input.subject.avatarId);
  if (!sourcePubkey) return { ok: false, code: 'wallet_missing' };

  // 2) Static validation (amount / destination / self-send).
  const v = validateWithdrawStatic({
    amountAtomic: input.amountAtomic,
    destination: input.destination,
    sourcePubkey,
  });
  if (!v.ok) return { ok: false, code: v.code, detail: v.detail };

  // 3) Connection + NETWORK GUARD (before any balance read or row write).
  const conn = d.connection();
  assertMainnetWithdrawConnection(conn);

  // 4) Balance + fee headroom (fail CLOSED on read failure — never fail-open).
  let feeReserveLamports: bigint;
  let destAtaMissing = false;
  // The live CLV atomic balance, captured on the CLV branch below — feeds the
  // hold consent gate (4b) without a second RPC read.
  let currentClvAtomic = 0n;
  try {
    const rentMin = await d.getRentExemptMinimum(conn, 0);
    const solBalance = await d.getSolBalance(conn, sourcePubkey);
    if (input.asset === 'SOL') {
      if (v.amount > solBalance) {
        return {
          ok: false,
          code: 'insufficient_balance',
          detail: `have=${solBalance} want=${v.amount}`,
        };
      }
      feeReserveLamports = WITHDRAW_TX_FEE_LAMPORTS + rentMin;
      if (solBalance - v.amount < feeReserveLamports) {
        // The source NEVER drains below rent-exempt minimum + the tx fee.
        return {
          ok: false,
          code: 'insufficient_sol_for_fee',
          detail: `remaining=${solBalance - v.amount} reserve=${feeReserveLamports}`,
        };
      }
    } else {
      const spec = tokenSpec(input.asset);
      const token = await d.getTokenBalance(conn, spec.mint.toBase58(), sourcePubkey);
      if (v.amount > token.amountAtomic) {
        return {
          ok: false,
          code: 'insufficient_balance',
          detail: `have=${token.amountAtomic} want=${v.amount}`,
        };
      }
      if (input.asset === 'CLV') currentClvAtomic = token.amountAtomic;
      // Dest ATA rent rides the fee headroom when the ATA doesn't exist yet
      // (the CreateIdempotent's rent is paid by the SOURCE custodial wallet).
      const destAta = findAtaForProgram(v.destination, spec);
      destAtaMissing = !(await d.getAccountExists(conn, destAta));
      const ataRent = destAtaMissing ? await d.getRentExemptMinimum(conn, TOKEN_ACCOUNT_BYTES) : 0n;
      feeReserveLamports = WITHDRAW_TX_FEE_LAMPORTS + ataRent + rentMin;
      if (solBalance < feeReserveLamports) {
        return {
          ok: false,
          code: 'insufficient_sol_for_fee',
          detail: `have=${solBalance} reserve=${feeReserveLamports}${destAtaMissing ? ' (incl dest ATA rent)' : ''}`,
        };
      }
    }
  } catch (err) {
    console.error(
      `[wallet-withdraw] balance read failed (refusing, fail-closed): ${(err as Error).message}`,
    );
    return { ok: false, code: 'balance_unavailable' };
  }

  // 4b) CLV HOLD CONSENT GATE (2026-07-09) — INFORMED CONSENT ONLY;
  //     enforcement stays with the land rent sweeper (nothing is released,
  //     graced, or lapsed here). PRE-ROW: this refusal happens BEFORE the
  //     insert, so no withdrawal row ever exists for an unacknowledged
  //     attempt and the acknowledged retry with the SAME Idempotency-Key
  //     proceeds cleanly. Only AGENT-subject holds are checked — they are the
  //     ones backed by THIS custodial wallet ('user' holds check the human's
  //     LINKED wallet and are unaffected); grandfathered holds are excluded —
  //     both exactly matching the sweeper's stacked-requirement semantics.
  //     `acknowledgeHoldLoss === true` bypasses ONLY this gate; every guard
  //     above (balance/fee/on-curve/self-send) already ran and every
  //     exactly-once guard below is untouched.
  if (input.asset === 'CLV' && input.acknowledgeHoldLoss !== true) {
    try {
      const hold = await d.db.getAgentHoldRequirement(input.subject.avatarId);
      if (hold.requiredUiAmount > 0) {
        // Compare in ATOMIC BigInt (CLV 6dp pinned) — never float math on
        // money. `hold_threshold_ct` is a CLV uiAmount integer.
        const requiredAtomic = BigInt(hold.requiredUiAmount) * 10n ** BigInt(CLV_DECIMALS);
        const postAtomic = currentClvAtomic - v.amount; // ≥ 0 (balance-checked in step 4)
        if (postAtomic < requiredAtomic) {
          return {
            ok: false,
            code: 'hold_at_risk',
            detail: 'clv_withdrawal_breaks_land_hold',
            holdAtRisk: {
              requiredUiAmount: hold.requiredUiAmount,
              postUiAmount: atomicToDecimalString(postAtomic, CLV_DECIMALS),
              parcels: hold.parcels,
            },
          };
        }
      }
    } catch (err) {
      // FAIL-OPEN on the threshold-query error ONLY (deliberate, per spec):
      // a DB/infra hiccup must never block a user withdrawing their OWN
      // assets. Safe because this gate is CONSENT, not enforcement — the
      // land rent sweeper re-checks the live CLV balance every pass and its
      // grace window catches an unbacked hold next sweep; the worst case is
      // a missed warning, never lost funds or a bypassed money guard.
      console.warn(
        `[wallet-withdraw] hold-threshold query failed (fail-open, consent gate skipped): ` +
          `${(err as Error).message}`,
      );
    }
  }

  // 5) INSERT the pending row (durable intent BEFORE anything signs).
  const inserted = await d.db.insertWithdrawal({
    subjectType: input.subject.kind,
    avatarId: input.subject.avatarId,
    userId: input.subject.userId,
    asset: input.asset,
    amountAtomic: v.amount.toString(),
    destination: v.destination.toBase58(),
    idempotencyKey: input.idempotencyKey,
    network: WITHDRAW_NETWORK,
    metadata: {
      requestedBy: input.subject.kind,
      ...(input.subject.agentId ? { agentId: input.subject.agentId } : {}),
      feeReserveLamports: feeReserveLamports.toString(),
      destAtaMissing,
    },
  });
  if (!inserted) {
    // A concurrent retry with the same idempotency key won the INSERT — replay it.
    const winner = await d.db.findByIdempotencyKey(
      input.subject.kind,
      input.subject.avatarId,
      input.idempotencyKey,
    );
    if (!winner) return { ok: false, code: 'transient_failure', detail: 'idem_race_unresolved' };
    if (!idempotencyBodyMatches(winner, input)) {
      return {
        ok: false,
        code: 'idempotency_conflict',
        detail: 'key_reused_with_different_request',
        withdrawalId: winner.id,
      };
    }
    if (winner.status === 'pending') return executeClaimedWithdrawal(winner.id, d);
    return replayRow(winner);
  }

  // 6) Execute (claim → custody → sign → capture → send → confirm).
  //    (No daily cap — removed 2026-07-09 by founder decision; the balance +
  //    fee guards in step 4 are the only per-request limits.)
  return executeClaimedWithdrawal(inserted.id, d);
}

// ---------------------------------------------------------------------------
// executeClaimedWithdrawal — the exactly-once send (one row)
// ---------------------------------------------------------------------------

async function executeClaimedWithdrawal(
  withdrawalId: string,
  d: Required<WalletWithdrawDeps>,
): Promise<WithdrawResult> {
  // Belt-and-suspenders: the request path already refused when dark; a direct
  // caller (worker/harness) hits the loud throw.
  requireWalletWithdrawEnabled();

  // 1) ATOMIC CLAIM — pending→sending BEFORE any decrypt/sign/send.
  const claimId = randomUUID();
  const claimed = await d.db.claimPending(withdrawalId, claimId);
  if (!claimed) {
    const row = await d.db.findById(withdrawalId);
    if (!row) return { ok: false, code: 'withdrawal_not_found' };
    return replayRow(row);
  }
  if (claimed.txSignature) {
    // A 'pending' row can never carry a captured signature — corruption; the
    // signature is durable, so this is operator territory, never a re-send.
    console.error(
      `[wallet-withdraw] CLAIMED ROW CARRIES A PRIOR SIGNATURE — withdrawal=${withdrawalId}; → reconcile`,
    );
    await d.db.markReconcile(withdrawalId, claimId, 'claim_with_prior_signature');
    return {
      ok: false,
      code: 'withdrawal_reconcile',
      detail: 'claim_with_prior_signature',
      withdrawalId,
      txSignature: claimed.txSignature,
    };
  }

  const conn = d.connection();
  assertMainnetWithdrawConnection(conn);

  const asset = claimed.asset as WithdrawAsset;
  const amount = BigInt(claimed.amountAtomic);
  const destination = new PublicKey(claimed.destination);

  // Once a signature is captured the claim may NEVER release (reconcile only).
  let sigCaptured = false;
  try {
    // 2) CUSTODY (after the claim — the claim is the exclusivity) + the
    //    defense-in-depth pubkey verification inside loadKeypair.
    const keypair = await d.loadKeypair(claimed.avatarId);

    // Post-decrypt self-send re-check (defense-in-depth — the static
    // validation already refused; a drifted wallet row re-refuses here).
    if (destination.equals(keypair.publicKey)) {
      await d.db.markFailed(withdrawalId, claimId, 'self_send_post_custody');
      return { ok: false, code: 'self_send', withdrawalId };
    }

    // 3) Build + SIGN with a fresh blockhash. The deterministic FIRST
    //    signature (fee payer = the custodial wallet) is the capture key.
    const { blockhash, lastValidBlockHeight } = await d.getLatestBlockhash(conn);
    const txn = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight });
    if (asset === 'SOL') {
      txn.add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: destination,
          lamports: amount,
        }),
      );
    } else {
      const spec = tokenSpec(asset);
      const sourceAta = findAtaForProgram(keypair.publicKey, spec);
      const destAta = findAtaForProgram(destination, spec);
      // Idempotent create — a no-op when the dest ATA already exists; its
      // rent (when created) is paid by the custodial wallet and was part of
      // the fee headroom at validation time.
      txn.add(createAtaIdempotentIx(keypair.publicKey, destAta, destination, spec));
      txn.add(transferCheckedIx(sourceAta, destAta, keypair.publicKey, amount, spec));
    }
    txn.sign(keypair);
    if (!txn.signature) {
      throw new Error('[wallet-withdraw] signing produced no signature');
    }
    const signature = bs58.encode(txn.signature);

    // 4) CAPTURE-BEFORE-SEND — the signature persists in its OWN committed
    //    UPDATE before the wire is touched; an ambiguous send can never lose
    //    its money proof.
    const captured = await d.db.captureSignature(withdrawalId, claimId, signature);
    if (captured === 'sig_conflict') {
      // Another row owns this exact signature (identical message+blockhash).
      // NOTHING was sent for THIS row — release for a clean retry (a later
      // attempt gets a fresh blockhash ⇒ a distinct signature).
      await d.db.releaseClaim(withdrawalId, claimId);
      return { ok: false, code: 'transient_failure', detail: 'signature_conflict', withdrawalId };
    }
    if (captured === 'lost') {
      // Claim no longer ours — do NOT send. Nothing has moved.
      return { ok: false, code: 'capture_lost', withdrawalId };
    }
    sigCaptured = true;

    // 5) SEND + CONFIRM.
    let sent = false;
    try {
      await d.sendRawTransaction(conn, txn.serialize());
      sent = true;
      const outcome = await d.confirmTransaction(conn, signature, blockhash, lastValidBlockHeight);
      if (outcome === 'failed') {
        // DEFINITIVE on-chain failure — the tx landed with an error; no
        // assets moved. Terminal 'failed' (auditable), retry = a NEW request.
        console.error(
          `[wallet-withdraw] TX FAILED ON-CHAIN — withdrawal=${withdrawalId} tx=${signature}; ` +
            `no assets moved; → failed`,
        );
        await d.db.markFailed(withdrawalId, claimId, 'tx_failed_on_chain');
        return { ok: false, code: 'tx_failed', withdrawalId, txSignature: signature };
      }
    } catch (err) {
      const phase = sent ? 'confirm' : 'send';
      console.error(
        `[wallet-withdraw] AMBIGUOUS ${phase.toUpperCase()} — withdrawal=${withdrawalId} ` +
          `tx=${signature}; money-state UNKNOWN → reconcile (no re-send): ${(err as Error).message}`,
      );
      await d.db.markReconcile(withdrawalId, claimId, `${phase}_ambiguous`);
      return {
        ok: false,
        code: 'send_ambiguous',
        detail: `${phase}_ambiguous`,
        withdrawalId,
        txSignature: signature,
      };
    }

    // 6) SENT — confirmed on-chain (checked to our claim).
    const marked = await d.db.markSent(withdrawalId, claimId);
    if (!marked) {
      console.error(
        `[wallet-withdraw] SENT-MARK MISSED after a confirmed send — withdrawal=${withdrawalId} ` +
          `tx=${signature}; the signature IS durable; manual verify`,
      );
    }
    const row = await d.db.findById(withdrawalId);
    return {
      ok: true,
      withdrawal: row
        ? toView(row)
        : {
            id: withdrawalId,
            status: 'sent',
            asset,
            amountAtomic: amount.toString(),
            destination: destination.toBase58(),
            txSignature: signature,
            network: WITHDRAW_NETWORK,
            createdAt: claimed.createdAt.toISOString(),
            sentAt: new Date().toISOString(),
          },
      replay: false,
      resumed: false,
    };
  } catch (err) {
    if (sigCaptured) {
      // A signature exists — a send MAY have happened. NEVER release; the
      // reconciler resolves against the chain.
      console.error(
        `[wallet-withdraw] UNEXPECTED POST-CAPTURE ERROR — withdrawal=${withdrawalId}: ` +
          `${(err as Error).message}; → reconcile (signature is durable)`,
      );
      await d.db.markReconcile(withdrawalId, claimId, 'unexpected_post_capture');
      return { ok: false, code: 'send_ambiguous', detail: 'unexpected_post_capture', withdrawalId };
    }
    if (err instanceof WalletWithdrawCustodyError) {
      // Custody refused BEFORE anything signed — definitive + terminal (a
      // pubkey mismatch is operator territory; nothing was sent).
      console.error(`[wallet-withdraw] CUSTODY REFUSAL — withdrawal=${withdrawalId}: ${err.message}`);
      await d.db.markFailed(withdrawalId, claimId, `custody_${err.code}`);
      return { ok: false, code: 'custody_failed', detail: err.code, withdrawalId };
    }
    // Pre-capture infra failure (RPC/blockhash/decrypt transport) — nothing
    // captured, nothing sent: release for a clean retry.
    console.error(
      `[wallet-withdraw] pre-capture failure — withdrawal=${withdrawalId}: ${(err as Error).message}`,
    );
    await d.db.releaseClaim(withdrawalId, claimId);
    return { ok: false, code: 'transient_failure', detail: 'pre_capture', withdrawalId };
  }
}

// ---------------------------------------------------------------------------
// resumeWithdrawal — restart-after-send-before-mark (FORWARD-ONLY, never re-send)
// ---------------------------------------------------------------------------

/**
 * Resume ONE stale 'sending' withdrawal left behind by a crash. The captured
 * signature is chain-checked and the machine only moves FORWARD:
 *   captured + confirmed      → 'sent' (zero sends).
 *   captured + on-chain err   → 'failed' (definitive — no assets moved).
 *   captured + not_found      → TERMINAL 'reconcile' (the tx may still land
 *                               inside its blockhash window — NEVER re-send).
 *   nothing captured          → nothing was ever sent (capture-before-send)
 *                               → claim released for a clean re-claim.
 * Only claims older than `resolveWithdrawStaleMs()` are taken over — a live
 * in-flight withdrawal is never stolen.
 */
export async function resumeWithdrawal(
  withdrawalId: string,
  deps?: WalletWithdrawDeps,
): Promise<WithdrawResult> {
  if (!isWalletWithdrawEnabled()) {
    return { ok: false, code: 'withdraw_disabled' };
  }
  const d = resolveDeps(deps);

  const row = await d.db.findById(withdrawalId);
  if (!row) return { ok: false, code: 'withdrawal_not_found' };
  if (row.status === 'sent') return { ok: true, withdrawal: toView(row), replay: true, resumed: true };
  if (row.status !== 'sending') {
    return { ok: false, code: 'not_resumable', detail: row.status, withdrawalId };
  }

  const claimId = randomUUID();
  const cutoff = new Date(Date.now() - resolveWithdrawStaleMs());
  const taken = await d.db.takeoverStaleClaim(withdrawalId, claimId, cutoff);
  if (!taken) return { ok: false, code: 'withdrawal_in_flight', withdrawalId };

  // Nothing captured ⇒ nothing sent (capture-before-send) ⇒ clean release.
  if (!taken.txSignature) {
    await d.db.releaseClaim(withdrawalId, claimId);
    return { ok: false, code: 'released_for_retry', withdrawalId };
  }

  const conn = d.connection();
  assertMainnetWithdrawConnection(conn);

  let status: 'confirmed' | 'failed' | 'not_found';
  try {
    status = await d.getSignatureStatus(conn, taken.txSignature);
  } catch (err) {
    console.error(
      `[wallet-withdraw] resume chain-check errored (transient) — withdrawal=${withdrawalId}: ` +
        `${(err as Error).message}; row stays 'sending' for a later resume`,
    );
    return { ok: false, code: 'resume_transient', withdrawalId };
  }

  if (status === 'confirmed') {
    await d.db.markSent(withdrawalId, claimId);
    const fresh = await d.db.findById(withdrawalId);
    return {
      ok: true,
      withdrawal: fresh ? toView(fresh) : toView({ ...taken, status: 'sent' } as WithdrawalRow),
      replay: false,
      resumed: true,
    };
  }
  if (status === 'failed') {
    // The tx LANDED with an error — definitive, no assets moved.
    await d.db.markFailed(withdrawalId, claimId, 'tx_failed_on_chain_resume');
    return { ok: false, code: 'tx_failed', withdrawalId, txSignature: taken.txSignature };
  }
  // not_found: the captured tx is unprovable — it may STILL land inside its
  // blockhash window. NEVER re-send; TERMINAL reconcile for the operator.
  await d.db.markReconcile(withdrawalId, claimId, 'resume_unresolved');
  return {
    ok: false,
    code: 'withdrawal_reconcile',
    detail: 'resume_unresolved',
    withdrawalId,
    txSignature: taken.txSignature,
  };
}

/**
 * One resume pass over stale 'sending' claims (crash recovery — forward-only,
 * never a re-send). Called by the boot-wired resume worker below (which
 * index.ts starts ONLY when `WALLET_WITHDRAW_ENABLED === 'true'`) and usable
 * directly from an ops harness. Returns [] while the feature is dark.
 */
export async function runWithdrawResumeTick(
  deps?: WalletWithdrawDeps,
  limit = 10,
): Promise<Array<{ withdrawalId: string; result: WithdrawResult }>> {
  if (!isWalletWithdrawEnabled()) return [];
  const d = resolveDeps(deps);
  const cutoff = new Date(Date.now() - resolveWithdrawStaleMs());
  const stale = await d.db.listStaleSending(cutoff, limit);
  const out: Array<{ withdrawalId: string; result: WithdrawResult }> = [];
  for (const row of stale) {
    try {
      out.push({ withdrawalId: row.id, result: await resumeWithdrawal(row.id, deps) });
    } catch (err) {
      console.error(
        `[wallet-withdraw] resume failed (non-fatal) — withdrawal=${row.id}: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resume worker (2026-07-09) — boot-wired, GATED on the dark flag
// ---------------------------------------------------------------------------

/**
 * `WALLET_WITHDRAW_RESUME_POLL_MS` — resume-worker poll cadence. Default
 * 300_000 (5 min); floor 60_000 (mis-set guard — the market-listing-expiry
 * sweeper's floor pattern).
 */
const RESUME_POLL_MS_DEFAULT = 300_000;
const RESUME_POLL_MS_FLOOR = 60_000;
export function resolveWithdrawResumePollMs(): number {
  const raw = process.env.WALLET_WITHDRAW_RESUME_POLL_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= RESUME_POLL_MS_FLOOR ? n : RESUME_POLL_MS_DEFAULT;
}

/**
 * One worker pass: run the forward-only resume tick, then page ops (warning
 * severity via `alertError` → itachi-debug Telegram) for every row that
 * RESOLVED TO 'reconcile' this pass — money-state UNKNOWN, operator
 * chain-poll needed, NEVER auto-retried. The alert carries row ids + the
 * captured signature ONLY — never key material, never a decrypted anything.
 */
export async function runWithdrawResumeWorkerPass(
  deps?: WalletWithdrawDeps,
): Promise<Array<{ withdrawalId: string; result: WithdrawResult }>> {
  const d = resolveDeps(deps);
  const results = await runWithdrawResumeTick(deps);
  for (const { withdrawalId, result } of results) {
    if (!result.ok && result.code === 'withdrawal_reconcile') {
      try {
        await d.alert({
          severity: 'warning',
          source: 'wallet-withdraw-resume',
          message:
            `withdrawal ${withdrawalId} resolved to RECONCILE — money-state UNKNOWN; ` +
            `operator chain-poll required (never auto-retried)`,
          context: {
            withdrawalId,
            txSignature: result.txSignature ?? null,
            detail: result.detail ?? null,
          },
        });
      } catch {
        // alertError never throws by contract, but the worker must never die
        // on a broken alert channel either.
      }
    }
  }
  return results;
}

let resumeWorkerInterval: ReturnType<typeof setInterval> | null = null;

/** True while the resume-worker interval is live (tests + ops introspection). */
export function isWithdrawResumeWorkerRunning(): boolean {
  return resumeWorkerInterval !== null;
}

/**
 * Start the recurring resume worker (idempotent). DARK-SAFE double gate: the
 * index.ts boot wiring only calls this when `WALLET_WITHDRAW_ENABLED ===
 * 'true'`, AND this refuses to start while the flag is off — so no worker
 * ever polls a dark feature (and no stuck rows accumulate while off:
 * 'sending' rows can only exist after the flag has been on). Each tick is
 * forward-only crash recovery (`runWithdrawResumeTick`): a captured signature
 * is chain-checked and NEVER re-signed or re-sent.
 */
export function startWithdrawResumeWorker(): void {
  if (resumeWorkerInterval) return;
  if (!isWalletWithdrawEnabled()) return; // dark — never poll while off
  const periodMs = resolveWithdrawResumePollMs();
  resumeWorkerInterval = setInterval(() => {
    runWithdrawResumeWorkerPass().catch((err) => {
      console.error('[wallet-withdraw] resume worker pass failed (non-fatal):', err);
    });
  }, periodMs);
  console.log(
    `[wallet-withdraw] resume worker started — sweeping stale 'sending' claims every ` +
      `${Math.round(periodMs / 60_000)}min (forward-only; a captured sig is never re-sent)`,
  );
}

/** Stop the resume worker interval (graceful shutdown). Idempotent — safe to
 *  call even when the worker never started (e.g. the flag was off at boot). */
export function stopWithdrawResumeWorker(): void {
  if (resumeWorkerInterval) {
    clearInterval(resumeWorkerInterval);
    resumeWorkerInterval = null;
  }
}

// ---------------------------------------------------------------------------
// getCustodialWalletBalances — the read surface (available regardless of flag)
// ---------------------------------------------------------------------------

export interface AssetBalance {
  available: boolean;
  amountAtomic: string | null;
  decimals: number;
  uiAmount: number | null;
}

export type CustodialBalancesResult =
  | {
      ok: true;
      wallet: string;
      network: typeof WITHDRAW_NETWORK;
      withdrawEnabled: boolean;
      balances: Record<WithdrawAsset, AssetBalance>;
    }
  | { ok: false; code: 'wallet_missing' };

/**
 * READ-ONLY: the caller's custodial-wallet SOL/USDC/CLV balances. Never signs,
 * never gated by the withdraw flag (the flag gates SENDS, not visibility).
 * Fail-soft PER ASSET: a read failure reports `available:false` for that asset
 * instead of failing the whole response.
 */
export async function getCustodialWalletBalances(
  avatarId: string,
  deps?: WalletWithdrawDeps,
): Promise<CustodialBalancesResult> {
  const d = resolveDeps(deps);
  const wallet = await d.db.getWalletPubkey(avatarId);
  if (!wallet) return { ok: false, code: 'wallet_missing' };
  const conn = d.connection();

  const unavailable = (decimals: number): AssetBalance => ({
    available: false,
    amountAtomic: null,
    decimals,
    uiAmount: null,
  });

  const balances: Record<WithdrawAsset, AssetBalance> = {
    SOL: unavailable(SOL_DECIMALS),
    USDC: unavailable(USDC_DECIMALS),
    CLV: unavailable(CLV_DECIMALS),
  };

  try {
    const lamports = await d.getSolBalance(conn, wallet);
    balances.SOL = {
      available: true,
      amountAtomic: lamports.toString(),
      decimals: SOL_DECIMALS,
      uiAmount: Number(lamports) / 10 ** SOL_DECIMALS,
    };
  } catch (err) {
    console.warn(`[wallet-withdraw] SOL balance read failed (non-fatal): ${(err as Error).message}`);
  }
  for (const asset of ['USDC', 'CLV'] as const) {
    try {
      const spec = tokenSpec(asset);
      const b = await d.getTokenBalance(conn, spec.mint.toBase58(), wallet);
      balances[asset] = {
        available: true,
        amountAtomic: b.amountAtomic.toString(),
        decimals: spec.decimals,
        uiAmount: Number(b.amountAtomic) / 10 ** spec.decimals,
      };
    } catch (err) {
      console.warn(
        `[wallet-withdraw] ${asset} balance read failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  return {
    ok: true,
    wallet,
    network: WITHDRAW_NETWORK,
    withdrawEnabled: isWalletWithdrawEnabled(),
    balances,
  };
}
