/**
 * CLV SWAP EXECUTOR — LIVE PATH (Tokenomics GoLive executors, 2026-07-07).
 * ============================================================================
 * ███ LIVE GATE OPENED 2026-07-13 — DEFAULT OFF, LITERAL OPT-IN ONLY. ███
 *
 * This module is the fully-plumbed LIVE execution path for the C3 buy queue:
 * funding sweep (merchant USDC → clv-swap wallet) + atomic claim + per-clip
 * Jupiter USDC→CLV swaps. Its execution boundary is:
 *
 *   LOCK 1 — OPENED by the founder's no-dark-flags ruling (2026-07-13).
 *     `clv-swap-executor.ts` no longer calls `assertNoLiveClvSwapExecution()`
 *     at module scope, so a box explicitly configured with
 *     `CLV_SWAP_EXECUTE=true` can boot into the live worker. The assertion is
 *     retained on the dry-run worker/tick to prevent both modes running.
 *   LOCK 2 — every live entrypoint here re-asserts the DEFAULT-OFF gate
 *     (`requireLiveClvSwapExecution()`): it throws UNLESS
 *     `CLV_SWAP_EXECUTE === 'true'`.
 *
 * The existing conditional boot wiring now selects exactly one mode: flag
 * unset/false ⇒ dry-run worker; literal 'true' ⇒ this live worker. Mainnet and
 * real-facilitator guards remain mandatory at every live entrypoint.
 *
 * // FEATURE_GATE: clv_swap_live_execution
 * // Status: founder-opened under the no-dark-flags ruling (2026-07-13);
 * //   default OFF, literal CLV_SWAP_EXECUTE='true' selects live execution.
 * // Metric to graduate: adversarial pass on the complete live money path AND
 * //   a staging live smoke of the funding sweep + one clip, with signatures.
 * // Current reading: adversarial pass complete; staging live smoke pending.
 * // Review deadline: 2026-08-07.
 * // On deadline: if the metric is not recorded, delete this live path; do not
 * //   silently extend or re-dark an unverified money executor.
 * // Reference: clv-swap-executor.ts mode separation + network guards below.
 *
 * ── MONEY MODEL ──────────────────────────────────────────────────────────────
 * Real on-chain USDC and CLV ONLY. This module NEVER imports
 * `claw-token-ledger`, NEVER writes `avatars.clawTokens`, and never mints
 * anything. The flow per owed buy (one `clv_buy_queue` row):
 *
 *   1. FUNDING SWEEP (`claimAndSweepFundingForQueueRow`) — the owed USDC sits
 *      in the x402-merchant wallet from a SETTLED checkout. We: verify the
 *      source checkout is `settled` on MAINNET with a captured signature and
 *      that the queued amount ≤ the checkout's settled USD (amounts tied to
 *      SETTLED checkouts ONLY — no out-of-band manual custody); upsert the
 *      `clv_swap_funding` row (source_ref UNIQUE = double-sweep guard);
 *      ATOMICALLY claim it (pending→sweeping, claim_id); build + sign a
 *      transferChecked of the exact µUSD; CAPTURE the sweep tx signature in
 *      its OWN committed UPDATE BEFORE sending; send + confirm; mark swept.
 *      An AMBIGUOUS send/confirm ⇒ status 'reconcile', NEVER retried (the
 *      x402-checkout settle_ambiguous discipline); a definitive on-chain
 *      failure ⇒ 'failed' (no money moved), terminal + loud.
 *
 *   2. EXECUTION (`executeQueuedClvBuy`) — requires the funding row SWEPT.
 *      ATOMIC CLAIM FIRST: `UPDATE clv_buy_queue SET status='executing',
 *      claim_id, claimed_at WHERE id=$1 AND status='planned' RETURNING *`
 *      happens BEFORE any decrypt/sign/send (double-claim ⇒ 0 rows ⇒ refuse;
 *      a row left 'executing' by a crash is NEVER auto-resumed — reconciler
 *      case, partial fills durable in tx_signatures). A zero-clip stop before
 *      signing/sending safely releases the empty claim back to `planned`.
 *      Then per clip:
 *        a. RE-FETCH `getClvPrice()` — `available===false` HARD-STOPS sizing
 *           (for BOTH quoteUsd and poolLiquidityUsd; a present-but-stale depth
 *           never sizes a clip);
 *        b. size the clip from the CURRENT depth (same constant-product cap
 *           math as `planClips`, µUSD-floored, house-favorable);
 *        c. Jupiter /quote (lite-api v1) — zod-parsed; quoted `outAmount`
 *           MUST be ≥ the oracle mid less the independent oracle-tolerance
 *           allowance. Jupiter slippage remains separate and is bound to the
 *           amount encoded in the transaction, not a response-only field;
 *        d. Jupiter /swap → deserialize → resolve v0 lookup tables → bind the
 *           pinned V1 route to OUR wallet, canonical token accounts, exact
 *           amounts/slippage, zero platform fee, bounded compute fee, and a
 *           narrow outer-program set → sign and capture before sending;
 *        e. send + confirm; spacing sleep; loop.
 *      Conservation: Σ clip µUSD === the queued amount exactly (BigInt);
 *      completion sets executed_at + executed_price (conservative
 *      guaranteed-output accounting avg USD/CLV).
 *
 * ── NETWORK GUARD (devnet/mock can NEVER reach a real send) ─────────────────
 * `assertMainnetRealMoneyContext()` runs at every live entrypoint: the USDC
 * settle network (`resolveTopupNetwork()`) MUST be 'mainnet' (CLV is mainnet
 * Token-2022; devnet USDC cannot fund a mainnet CLV buy) AND the x402 mock
 * facilitator MUST NOT be active (mock-settled checkouts are fake money). The
 * per-checkout mainnet re-check in the sweep is defense-in-depth on top.
 *
 * ── TESTABILITY ─────────────────────────────────────────────────────────────
 * All I/O is behind an injectable `ClvSwapLiveDeps` (db api, oracle, custody,
 * fetch, send/confirm, sleep, ops alert). Defaults are the real implementations; tests
 * inject fakes and assert ORDERING (claim before decrypt, capture before
 * send), refusals, and conservation without touching chain/DB.
 */

import { randomUUID } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  SystemProgram,
  type AddressLookupTableAccount,
  type MessageV0,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';
import {
  db,
  clvBuyQueue,
  clvSwapFunding,
  x402Checkouts,
  and,
  eq,
  asc,
  lt,
  sql,
  type ClvSwapFunding,
} from '@clawville/database';
import { alertError, type AlertErrorParams } from './alert-error';
import { getClvPrice, CLV_MINT, type ClvPriceQuote } from './clv-price-oracle';
import {
  resolveClvSwapMaxImpactBps,
  resolveClvSwapClipSpacingMs,
  usdcToMicro,
  microToUsdc,
  getClvSwapWalletPubkey,
  wouldExceedMaxPlannedClips,
} from './clv-swap-executor';
import {
  loadClvSwapKeypair,
  loadX402MerchantKeypair,
  getClvMainnetConnection,
} from './clv-swap-custody';
import { USDC_MINT_MAINNET, SOLANA_MAINNET_CAIP2 } from './x402-payai';
import { loadX402Config } from './x402-config';
import { resolveTopupNetwork } from '../routes/ct-topup';
import { readSplTokenBalance } from './solana-token-balance';

// ---------------------------------------------------------------------------
// LOCK 2 — default-OFF literal live opt-in (LOCK 1 opened 2026-07-13)
// ---------------------------------------------------------------------------

/** True ONLY when `CLV_SWAP_EXECUTE === 'true'`. The boot wiring uses the same
 *  literal comparison to select this worker instead of the dry-run worker. */
export function isLiveClvSwapExecutionEnabled(): boolean {
  return process.env.CLV_SWAP_EXECUTE === 'true';
}

/** Re-asserted at EVERY live entrypoint. Default-OFF: throws unless the env is
 *  the literal 'true'; mainnet/real-facilitator guards run immediately after. */
export function requireLiveClvSwapExecution(): void {
  if (!isLiveClvSwapExecutionEnabled()) {
    throw new Error(
      `[clv-swap-live] live execution is disabled — CLV_SWAP_EXECUTE is not 'true' ` +
        `(default OFF; literal opt-in required)`,
    );
  }
}

/**
 * NETWORK GUARD — devnet/mock must NEVER attempt a real sweep/swap.
 * CLV is MAINNET Token-2022; the merchant USDC we sweep must be REAL mainnet
 * USDC from a REAL facilitator. Throws unless the USDC settle network is
 * 'mainnet' (a deliberate `X402_TOPUP_NETWORK=mainnet` flip) AND the mock
 * facilitator is inactive.
 */
export function assertMainnetRealMoneyContext(): void {
  const network = resolveTopupNetwork();
  if (network !== 'mainnet') {
    throw new Error(
      `[clv-swap-live] USDC settle network is '${network}' — live sweep/swap REFUSED. ` +
        `CLV is mainnet-only; devnet USDC can never fund a real CLV buy. ` +
        `Mainnet requires the deliberate X402_TOPUP_NETWORK=mainnet flip.`,
    );
  }
  const cfg = loadX402Config();
  if (cfg.facilitatorPreset === 'mock' || process.env.X402_MOCK_FACILITATOR === 'true') {
    throw new Error(
      `[clv-swap-live] the MOCK x402 facilitator is active — live sweep/swap REFUSED. ` +
        `Mock-settled checkouts are fake money and must never fund an on-chain CLV buy.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Env resolvers (live-path knobs; floored/clamped like the dry-run resolvers)
// ---------------------------------------------------------------------------

/** Default max slippage for the Jupiter leg: 100 bps = 1%. */
export const DEFAULT_SLIPPAGE_BPS = 100;
/** `CLV_SWAP_SLIPPAGE_BPS` — integer bps, floor 1, cap 1_000 (10%). Drives
 *  ONLY the Jupiter quote's slippageBps / on-chain threshold. */
export function resolveClvSwapSlippageBps(): number {
  const raw = process.env.CLV_SWAP_SLIPPAGE_BPS;
  if (!raw) return DEFAULT_SLIPPAGE_BPS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_SLIPPAGE_BPS;
  return Math.min(Math.max(1, n), 1_000);
}

/** Default route-vs-oracle shortfall tolerance: 300 bps = 3%. */
export const DEFAULT_ORACLE_TOLERANCE_BPS = 300;
/** `CLV_SWAP_ORACLE_TOLERANCE_BPS` — integer bps, floor 1, cap 1_000 (10%).
 *  Independent of Jupiter slippage: this bounds the quoted route output's
 *  shortfall from the oracle mid, covering route fees + price impact. */
export function resolveClvSwapOracleToleranceBps(): number {
  const raw = process.env.CLV_SWAP_ORACLE_TOLERANCE_BPS;
  if (!raw) return DEFAULT_ORACLE_TOLERANCE_BPS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_ORACLE_TOLERANCE_BPS;
  return Math.min(Math.max(1, n), 1_000);
}

/**
 * Per-row slippage override: `clv_buy_queue.max_slippage` is a FRACTION
 * (numeric(6,4), e.g. 0.0100 = 1%). Present + valid ⇒ it overrides the env
 * cap for that row, clamped to the same [1, 1000] bps window (an operator
 * row-tweak can never exceed the global ceiling). Invalid/NULL ⇒ null (env).
 */
export function parseRowSlippageBps(maxSlippage: string | null): number | null {
  if (maxSlippage === null || maxSlippage === undefined) return null;
  const f = Number(maxSlippage);
  if (!Number.isFinite(f) || f <= 0) return null;
  return Math.min(Math.max(1, Math.round(f * 10_000)), 1_000);
}

const DEFAULT_JUPITER_BASE_URL = 'https://lite-api.jup.ag';
/** HOST ALLOWLIST for the Jupiter API base — mirrors the `hatcher-config.ts`
 *  SSRF-allowlist pattern (parse the URL, check the hostname against a pinned
 *  Set, reject otherwise). Only Jupiter's own hosts may serve the money
 *  wire's quotes/swap transactions. */
const JUPITER_ALLOWED_HOSTS = new Set(['lite-api.jup.ag', 'api.jup.ag']);
/** `CLV_SWAP_JUPITER_BASE_URL` — Jupiter API base, HOST-ALLOWLISTED
 *  (2026-07-08, Codex re-review; previously any bare `https://` URL was
 *  accepted). Default: the keyless lite-api. The paid `api.jup.ag` is the
 *  only other accepted host (an ops swap, same wire shape). Anything else —
 *  unparseable, non-https, embedded credentials, or an off-allowlist host —
 *  FALLS BACK to the default with a loud warn, so a mis-set or hostile env
 *  can only ever point the swap wire at Jupiter itself. Exported for tests. */
export function resolveJupiterBaseUrl(): string {
  const raw = process.env.CLV_SWAP_JUPITER_BASE_URL?.trim();
  if (!raw) return DEFAULT_JUPITER_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn(
      `[clv-swap-live] CLV_SWAP_JUPITER_BASE_URL is not a parseable URL — ` +
        `falling back to ${DEFAULT_JUPITER_BASE_URL}`,
    );
    return DEFAULT_JUPITER_BASE_URL;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !JUPITER_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    console.warn(
      `[clv-swap-live] CLV_SWAP_JUPITER_BASE_URL (host '${parsed.hostname}') is not an allowed ` +
        `Jupiter base — must be https, credential-free, host ∈ {${[...JUPITER_ALLOWED_HOSTS].join(', ')}} — ` +
        `falling back to ${DEFAULT_JUPITER_BASE_URL}`,
    );
    return DEFAULT_JUPITER_BASE_URL;
  }
  return raw.replace(/\/+$/, '');
}

/**
 * `CLV_SWAP_EXECUTING_STALE_MS` — how old an 'executing' claim must be before
 * the live tick treats it as a CRASHED claim and PAGES OPS (2026-07-08, Codex
 * re-review). ALERT-ONLY: the row is NEVER auto-resumed/auto-retried — a
 * resume cannot prove the money-state of the stopping clip, so resolution is
 * a manual reconcile decision; the confirmed fills stay durable in
 * `tx_signatures`. Default 300_000; hard floor 180_000 (mirrors
 * `MARKET_PAYOUT_STALE_MS`: must exceed a live clip send+confirm cycle with
 * margin so an in-flight execution is never mis-paged).
 */
const EXECUTING_STALE_MS_DEFAULT = 5 * 60_000;
const EXECUTING_STALE_MS_FLOOR = 180_000;
export function resolveClvSwapExecutingStaleMs(): number {
  const raw = process.env.CLV_SWAP_EXECUTING_STALE_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= EXECUTING_STALE_MS_FLOOR ? n : EXECUTING_STALE_MS_DEFAULT;
}

/** CLV is a 6-decimal Token-2022 mint (see clv-price-oracle.ts header). */
const CLV_DECIMALS = 6;
/** USDC is 6-decimal — 1 µUSD == 1 atomic USDC unit (the sweep/quote identity). */
const USDC_DECIMALS = 6;
const OUTBOUND_FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// SPL plumbing (hand-rolled, dependency-light — fetch + web3.js only)
// ---------------------------------------------------------------------------

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');
const JUPITER_V6_PROGRAM_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const JUPITER_EVENT_AUTHORITY = new PublicKey('D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf');
const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n;
const MAX_COMPUTE_UNITS = 1_400_000n;
const MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS =
  (MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n) / MAX_COMPUTE_UNITS;

const JUPITER_ROUTE_DISCRIMINATOR = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]);
const JUPITER_SHARED_ROUTE_DISCRIMINATOR = Buffer.from([193, 32, 155, 51, 65, 214, 156, 129]);

/** Canonical ATA for a particular token program (Tokenkeg or Token-2022). */
function findAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Canonical associated-token-account PDA for (owner, mint) — classic SPL
 *  token program (mainnet USDC is Tokenkeg; CLV's Token-2022 side is handled
 *  entirely by Jupiter's swap tx, never built here). */
export function findUsdcAta(owner: PublicKey): PublicKey {
  return findAta(owner, new PublicKey(USDC_MINT_MAINNET), TOKEN_PROGRAM_ID);
}

export function findClvAta(owner: PublicKey): PublicKey {
  return findAta(owner, new PublicKey(CLV_MINT), TOKEN_2022_PROGRAM_ID);
}

/** ATA-program CreateIdempotent (discriminator 1) — creates the destination
 *  ATA when missing, no-ops when present. Payer = the merchant (sweeps only). */
function createAtaIdempotentIx(payer: PublicKey, ata: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(USDC_MINT_MAINNET), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

/** SPL TransferChecked (discriminator 12): [12, u64le amount, u8 decimals].
 *  TransferChecked (not Transfer) so the mint + decimals are enforced on-chain
 *  — a wrong-mint/wrong-scale sweep is structurally impossible. */
function transferCheckedIx(
  sourceAta: PublicKey,
  destAta: PublicKey,
  owner: PublicKey,
  amountAtomic: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amountAtomic, 1);
  data.writeUInt8(USDC_DECIMALS, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(USDC_MINT_MAINNET), isSigner: false, isWritable: false },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Pure sizing helpers (unit-tested; mirror planClips' house-favorable math)
// ---------------------------------------------------------------------------

/**
 * Per-clip cap in µUSD from the CURRENT depth — identical constant-product
 * math to `planClips` (cap = (bps/10k) × poolLiquidityUsd/2, µUSD-floored,
 * house-favorable). Returns null when there is NO safe clip size (missing /
 * non-positive depth, or a dust pool whose cap floors to 0 µUSD).
 */
export function sizeClipMicro(
  remainingMicro: bigint,
  poolLiquidityUsd: number | null,
  maxImpactBps: number,
): bigint | null {
  if (
    typeof poolLiquidityUsd !== 'number' ||
    !Number.isFinite(poolLiquidityUsd) ||
    poolLiquidityUsd <= 0
  ) {
    return null;
  }
  const bps = Math.min(Math.max(1, Math.floor(maxImpactBps)), 10_000);
  const maxClipMicro = BigInt(Math.floor(((poolLiquidityUsd / 2) * bps) / 10_000 * 1_000_000));
  if (maxClipMicro <= 0n) return null;
  return remainingMicro >= maxClipMicro ? maxClipMicro : remainingMicro;
}

/**
 * The ORACLE-derived minimum quoted CLV out (atomic, 6-dp) for a clip: what the
 * house-favorable oracle mid says the clip should buy, less the independent
 * route-vs-oracle tolerance. Floor is fine here: the ≤1-atomic-unit (1e-6 CLV)
 * rounding is ~$1e-10 at any plausible price.
 */
export function oracleMinOutClvAtomic(
  clipMicro: bigint,
  quoteUsd: number,
  toleranceBps: number,
): bigint {
  const clipUsd = Number(clipMicro) / 1_000_000;
  const expectedClv = clipUsd / quoteUsd;
  const minOut = Math.floor(expectedClv * (1 - toleranceBps / 10_000) * 10 ** CLV_DECIMALS);
  return BigInt(Math.max(0, minOut));
}

// ---------------------------------------------------------------------------
// Jupiter wire schemas (zod on every network input — never trust the wire)
// ---------------------------------------------------------------------------

const jupQuoteSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string().regex(/^\d+$/),
    outAmount: z.string().regex(/^\d+$/),
    /** Informational only; `/swap` does not use this field to build the ix. */
    otherAmountThreshold: z.string().regex(/^\d+$/),
    swapMode: z.literal('ExactIn'),
    slippageBps: z.number().int().min(1).max(1_000),
    instructionVersion: z.literal('V1').optional(),
    priceImpactPct: z.string(),
    platformFee: z.null().optional(),
    routePlan: z
      .array(
        z.object({
          swapInfo: z.object({
            ammKey: z.string(),
            label: z.string().nullable().optional(),
            inputMint: z.string(),
            outputMint: z.string(),
            inAmount: z.string().regex(/^\d+$/),
            outAmount: z.string().regex(/^\d+$/),
            feeAmount: z.string().regex(/^\d+$/).optional(),
            feeMint: z.string().optional(),
          }),
          percent: z.number().int().min(0).max(100).nullable().optional(),
          bps: z.number().int().min(0).max(10_000).nullable().optional(),
        }),
      )
      .min(1),
    contextSlot: z.number().int().nonnegative().optional(),
    timeTaken: z.number().nonnegative().optional(),
  })
  .strip();
export type JupQuote = z.infer<typeof jupQuoteSchema>;

const jupSwapSchema = z
  .object({
    swapTransaction: z.string().min(1),
    lastValidBlockHeight: z.number().int().positive().optional(),
  })
  .passthrough();

type DecodedJupiterRoute = {
  kind: 'route' | 'shared_accounts_route';
  inAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  platformFeeBps: number;
};

function skipRemainingAccountsInfo(data: Buffer, offset: number): number | null {
  if (offset + 4 > data.length) return null;
  const count = data.readUInt32LE(offset);
  const end = offset + 4 + count * 2; // AccountsType enum(u8) + length(u8)
  return end <= data.length ? end : null;
}

/** Skip one current Jupiter-v6 `Swap` enum payload. Indexes/layouts are from
 * jup-ag/jupiter-amm-implementation/idls/jupiter_aggregator_v6.json. Unknown
 * future variants fail closed instead of guessing an amount-field offset. */
function skipJupiterSwapPayload(data: Buffer, variant: number, offset: number): number | null {
  const fixed: Record<number, number> = {
    8: 1, 12: 1, 15: 1, 16: 1, 17: 1, 18: 1, 21: 1, 23: 1, 24: 1,
    27: 1, 28: 1, 29: 16, 33: 4, 39: 1, 41: 4, 42: 3, 43: 10,
    44: 5, 45: 5, 58: 1, 60: 1, 61: 1, 64: 1, 71: 2, 81: 8, 82: 8,
    85: 1, 86: 2, 87: 9, 89: 1,
  };
  if (variant === 47) {
    if (offset + 2 > data.length) return null; // a_to_b + Option tag
    const option = data[offset + 1];
    if (option === 0) return offset + 2;
    if (option !== 1) return null;
    return skipRemainingAccountsInfo(data, offset + 2);
  }
  if (variant === 75) return skipRemainingAccountsInfo(data, offset);
  if (variant < 0 || variant > 89) return null;
  const end = offset + (fixed[variant] ?? 0);
  return end <= data.length ? end : null;
}

export function decodeJupiterV6RouteInstruction(dataBytes: Uint8Array): DecodedJupiterRoute | null {
  const data = Buffer.from(dataBytes);
  let kind: DecodedJupiterRoute['kind'];
  let offset = 8;
  if (data.subarray(0, 8).equals(JUPITER_ROUTE_DISCRIMINATOR)) {
    kind = 'route';
  } else if (data.subarray(0, 8).equals(JUPITER_SHARED_ROUTE_DISCRIMINATOR)) {
    kind = 'shared_accounts_route';
    offset += 1; // shared-account route id
  } else {
    return null; // exact-out/token-ledger/V2/unknown instructions are forbidden
  }
  if (offset + 4 > data.length) return null;
  const stepCount = data.readUInt32LE(offset);
  offset += 4;
  if (stepCount === 0 || stepCount > 64) return null;
  for (let i = 0; i < stepCount; i += 1) {
    if (offset >= data.length) return null;
    const variant = data[offset];
    offset += 1;
    const afterPayload = skipJupiterSwapPayload(data, variant, offset);
    if (afterPayload === null || afterPayload + 3 > data.length) return null;
    offset = afterPayload + 3; // percent + input_index + output_index
  }
  if (offset + 19 !== data.length) return null; // reject trailing-byte amount spoofing
  const inAmount = data.readBigUInt64LE(offset);
  const quotedOutAmount = data.readBigUInt64LE(offset + 8);
  const slippageBps = data.readUInt16LE(offset + 16);
  const platformFeeBps = data[offset + 18];
  return { kind, inAmount, quotedOutAmount, slippageBps, platformFeeBps };
}

/** Jupiter v6 ExactIn uses ceiling division for its on-chain minimum. */
export function jupiterExactInMinimumOut(quotedOutAmount: bigint, slippageBps: number): bigint {
  const keepBps = BigInt(10_000 - slippageBps);
  return (quotedOutAmount * keepBps + 9_999n) / 10_000n;
}

export type SwapTransactionBindingResult =
  | { ok: true; minimumOutAmount: bigint }
  | { ok: false; detail: string };

/** Pure pre-sign validator for the opaque transaction returned by `/swap`. */
export function validateJupiterSwapTransaction(input: {
  transaction: VersionedTransaction;
  wallet: PublicKey;
  inputAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  addressLookupTableAccounts?: AddressLookupTableAccount[];
}): SwapTransactionBindingResult {
  const { transaction: tx, wallet } = input;
  if (tx.message.version !== 0) return { ok: false, detail: 'message_not_v0' };
  const message = tx.message as MessageV0;
  if (message.header.numRequiredSignatures !== 1 || tx.signatures.length !== 1) {
    return { ok: false, detail: 'required_signer_count' };
  }
  if (!message.staticAccountKeys[0]?.equals(wallet)) return { ok: false, detail: 'payer_mismatch' };
  if (tx.signatures.some((sig) => sig.some((byte) => byte !== 0))) {
    return { ok: false, detail: 'preexisting_signature' };
  }

  let keys: ReturnType<MessageV0['getAccountKeys']>;
  try {
    keys = message.getAccountKeys({
      addressLookupTableAccounts: input.addressLookupTableAccounts ?? [],
    });
  } catch (err) {
    return { ok: false, detail: `lookup_resolution:${(err as Error).message}` };
  }
  const keyAt = (index: number): PublicKey | null => keys.get(index) ?? null;
  const usdcAta = findUsdcAta(wallet);
  const clvAta = findClvAta(wallet);
  const clvMint = new PublicKey(CLV_MINT);
  const [jupiterAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('authority')],
    JUPITER_V6_PROGRAM_ID,
  );
  let jupiterCount = 0;
  let ataSetupCount = 0;
  const computeKinds = new Set<number>();
  let decodedMinimum = 0n;

  for (const ix of message.compiledInstructions) {
    const programId = keyAt(ix.programIdIndex);
    if (!programId) return { ok: false, detail: 'program_index_oob' };
    const accounts = Array.from(ix.accountKeyIndexes);
    const data = Buffer.from(ix.data);

    if (programId.equals(COMPUTE_BUDGET_PROGRAM_ID)) {
      if (accounts.length !== 0 || data.length < 1 || computeKinds.has(data[0])) {
        return { ok: false, detail: 'compute_budget_shape' };
      }
      computeKinds.add(data[0]);
      if (data[0] === 1) {
        if (data.length !== 5 || data.readUInt32LE(1) > 262_144) return { ok: false, detail: 'heap_budget' };
      } else if (data[0] === 2) {
        if (data.length !== 5 || BigInt(data.readUInt32LE(1)) > MAX_COMPUTE_UNITS) return { ok: false, detail: 'compute_limit' };
      } else if (data[0] === 3) {
        if (data.length !== 9 || data.readBigUInt64LE(1) > MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS) {
          return { ok: false, detail: 'priority_fee' };
        }
      } else if (data[0] === 4) {
        if (data.length !== 5 || data.readUInt32LE(1) > 64 * 1024 * 1024) return { ok: false, detail: 'loaded_accounts_limit' };
      } else {
        return { ok: false, detail: 'compute_budget_variant' };
      }
      continue;
    }

    if (programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      ataSetupCount += 1;
      if (ataSetupCount > 1) return { ok: false, detail: 'multiple_ata_setup' };
      if (
        data.length !== 1 || data[0] !== 1 || accounts.length !== 6 ||
        !keyAt(accounts[0])?.equals(wallet) || !keyAt(accounts[1])?.equals(clvAta) ||
        !keyAt(accounts[2])?.equals(wallet) || !keyAt(accounts[3])?.equals(clvMint) ||
        !keyAt(accounts[4])?.equals(SystemProgram.programId) ||
        !keyAt(accounts[5])?.equals(TOKEN_2022_PROGRAM_ID)
      ) return { ok: false, detail: 'ata_setup_mismatch' };
      continue;
    }

    if (!programId.equals(JUPITER_V6_PROGRAM_ID)) {
      return { ok: false, detail: `outer_program:${programId.toBase58()}` };
    }
    jupiterCount += 1;
    if (jupiterCount !== 1) return { ok: false, detail: 'multiple_jupiter_instructions' };
    const decoded = decodeJupiterV6RouteInstruction(data);
    if (!decoded) return { ok: false, detail: 'jupiter_instruction_decode' };
    if (
      decoded.inAmount !== input.inputAmount ||
      decoded.quotedOutAmount !== input.quotedOutAmount ||
      decoded.slippageBps !== input.slippageBps ||
      decoded.platformFeeBps !== 0
    ) return { ok: false, detail: 'jupiter_amount_binding' };

    const expected = decoded.kind === 'shared_accounts_route'
      ? [null, jupiterAuthority, wallet, usdcAta, null, null, clvAta,
          new PublicKey(USDC_MINT_MAINNET), clvMint, JUPITER_V6_PROGRAM_ID,
          TOKEN_2022_PROGRAM_ID, JUPITER_EVENT_AUTHORITY, JUPITER_V6_PROGRAM_ID]
      : [null, wallet, usdcAta, clvAta, null, clvMint, JUPITER_V6_PROGRAM_ID,
          JUPITER_EVENT_AUTHORITY, JUPITER_V6_PROGRAM_ID];
    if (accounts.length < expected.length) return { ok: false, detail: 'jupiter_accounts_short' };
    for (let pos = 0; pos < expected.length; pos += 1) {
      const wanted = expected[pos];
      if (wanted && !keyAt(accounts[pos])?.equals(wanted)) {
        return { ok: false, detail: `jupiter_account_${pos}` };
      }
    }
    const tokenProgram = keyAt(accounts[0]);
    if (!tokenProgram ||
        (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID))) {
      return { ok: false, detail: 'jupiter_route_token_program' };
    }
    if (decoded.kind === 'route') {
      const explicitDestination = keyAt(accounts[4]);
      if (!explicitDestination ||
          (!explicitDestination.equals(clvAta) && !explicitDestination.equals(JUPITER_V6_PROGRAM_ID))) {
        return { ok: false, detail: 'jupiter_route_explicit_destination' };
      }
    }
    decodedMinimum = jupiterExactInMinimumOut(decoded.quotedOutAmount, decoded.slippageBps);
  }
  return jupiterCount === 1
    ? { ok: true, minimumOutAmount: decodedMinimum }
    : { ok: false, detail: 'missing_jupiter_instruction' };
}

export type WritableAccountValidationResult =
  | { ok: true }
  | { ok: false; detail: string };

/**
 * RPC-backed ownership gate for every writable account in the fully resolved
 * v0 message (static + ALT). Jupiter legitimately repeats the wallet and its
 * canonical ATAs in remaining accounts, so position-based duplicate bans are
 * incorrect. Instead, fail closed if ANY other writable SPL/Token-2022 token
 * account is currently controlled by the signing wallet.
 */
export async function validateJupiterWritableTokenAccounts(input: {
  transaction: VersionedTransaction;
  wallet: PublicKey;
  connection: Connection;
  addressLookupTableAccounts?: AddressLookupTableAccount[];
}): Promise<WritableAccountValidationResult> {
  if (input.transaction.message.version !== 0) return { ok: false, detail: 'message_not_v0' };
  const message = input.transaction.message as MessageV0;
  let keys: ReturnType<MessageV0['getAccountKeys']>;
  try {
    keys = message.getAccountKeys({
      addressLookupTableAccounts: input.addressLookupTableAccounts ?? [],
    });
  } catch (err) {
    return { ok: false, detail: `lookup_resolution:${(err as Error).message}` };
  }

  const writable = new Map<string, PublicKey>();
  for (let index = 0; index < keys.length; index += 1) {
    if (!message.isAccountWritable(index)) continue;
    const key = keys.get(index);
    if (key) writable.set(key.toBase58(), key);
  }
  const writableKeys = [...writable.values()];
  const infos: Array<Awaited<ReturnType<Connection['getMultipleAccountsInfo']>>[number]> = [];
  try {
    for (let offset = 0; offset < writableKeys.length; offset += 100) {
      const chunk = writableKeys.slice(offset, offset + 100);
      const chunkInfos = await input.connection.getMultipleAccountsInfo(chunk, 'confirmed');
      if (chunkInfos.length !== chunk.length) return { ok: false, detail: 'writable_account_rpc_shape' };
      infos.push(...chunkInfos);
    }
  } catch (err) {
    return { ok: false, detail: `writable_account_rpc:${(err as Error).message}` };
  }

  const usdcAta = findUsdcAta(input.wallet);
  const clvAta = findClvAta(input.wallet);
  for (let index = 0; index < writableKeys.length; index += 1) {
    const key = writableKeys[index];
    const info = infos[index];
    if (!info ||
        (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))) {
      continue;
    }
    const data = Buffer.from(info.data);
    if (data.length < 165) continue; // token-program mint/multisig, not a token account
    const tokenMint = new PublicKey(data.subarray(0, 32));
    const tokenAuthority = new PublicKey(data.subarray(32, 64));
    const delegate = data.readUInt32LE(72) === 1
      ? new PublicKey(data.subarray(76, 108))
      : null;
    const closeAuthority = data.readUInt32LE(129) === 1
      ? new PublicKey(data.subarray(133, 165))
      : null;
    const canonical = key.equals(usdcAta) || key.equals(clvAta);
    if (canonical) {
      const expectedProgram = key.equals(usdcAta) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
      const expectedMint = key.equals(usdcAta)
        ? new PublicKey(USDC_MINT_MAINNET)
        : new PublicKey(CLV_MINT);
      if (!info.owner.equals(expectedProgram) ||
          !tokenMint.equals(expectedMint) ||
          !tokenAuthority.equals(input.wallet) ||
          data[108] !== 1) {
        return { ok: false, detail: 'canonical_wallet_token_account_invalid' };
      }
      continue;
    }
    if (tokenAuthority.equals(input.wallet) ||
        delegate?.equals(input.wallet) ||
        closeAuthority?.equals(input.wallet)) {
      return { ok: false, detail: `unexpected_wallet_token_account:${key.toBase58()}` };
    }
  }
  return { ok: true };
}

async function existingClvDestinationAta(
  conn: Connection,
  wallet: PublicKey,
): Promise<string | undefined> {
  const ata = findClvAta(wallet);
  const info = await conn.getAccountInfo(ata, 'confirmed');
  if (!info) return undefined;
  const data = Buffer.from(info.data);
  if (
    !info.owner.equals(TOKEN_2022_PROGRAM_ID) ||
    data.length < 165 ||
    !data.subarray(0, 32).equals(new PublicKey(CLV_MINT).toBuffer()) ||
    !data.subarray(32, 64).equals(wallet.toBuffer()) ||
    data[108] !== 1 // AccountState::Initialized; frozen/uninitialized cannot receive safely
  ) {
    throw new Error('existing_clv_ata_invalid');
  }
  return ata.toBase58();
}

async function resolveJupiterLookupTables(
  tx: VersionedTransaction,
  conn: Connection,
): Promise<AddressLookupTableAccount[]> {
  if (tx.message.version !== 0) throw new Error('message_not_v0');
  return Promise.all(
    (tx.message as MessageV0).addressTableLookups.map(async ({ accountKey }) => {
      const lookup = await conn.getAddressLookupTable(accountKey);
      if (!lookup.value) throw new Error(`lookup_table_missing:${accountKey.toBase58()}`);
      return lookup.value;
    }),
  );
}

// ---------------------------------------------------------------------------
// Injectable dependencies (tests stub these; defaults are the real impls)
// ---------------------------------------------------------------------------

type QueueRow = typeof clvBuyQueue.$inferSelect;
type FundingRow = ClvSwapFunding;
interface CheckoutRowLite {
  id: string;
  status: string;
  txSignature: string | null;
  usdCents: number;
  metadata: Record<string, unknown> | null;
}

export interface ClipFillRecord {
  index: number;
  amountUsdc: string;
  signature: string;
  /**
   * Conservative CLV output floor (atomic string), decoded from the signed
   * Jupiter instruction's quoted-out + slippage fields. The quote response's
   * `otherAmountThreshold` is informational and never used for accounting.
   */
  outAmountAtomic: string;
  quotedAt: string;
}

export interface ClvSwapLiveDb {
  getQueueRow(queueId: string): Promise<QueueRow | null>;
  listPlannedQueueRows(limit: number): Promise<QueueRow[]>;
  /** Rows stuck 'executing' with `claimed_at` older than the cutoff — CRASHED
   *  claims (their confirmed fills are durable in tx_signatures). READ-ONLY:
   *  the live tick only ALERTS on these; it never mutates or resumes them. */
  listStaleExecutingQueueRows(cutoff: Date, limit: number): Promise<QueueRow[]>;
  /** THE atomic claim: planned→executing, checked, RETURNING the row. */
  claimQueueRow(queueId: string, claimId: string): Promise<QueueRow | null>;
  /** Definitive PRE-SIGN/PRE-SEND zero-fill stop only: executing→planned. */
  releaseQueueClaim(queueId: string, claimId: string): Promise<boolean>;
  /** Capture-before-send: append one clip fill, checked to the claim. */
  appendClipFill(queueId: string, claimId: string, entry: ClipFillRecord): Promise<boolean>;
  markQueueExecuted(queueId: string, claimId: string, executedPrice: string): Promise<boolean>;
  getSettledCheckout(checkoutId: string): Promise<CheckoutRowLite | null>;
  /** Upsert-by-source_ref (UNIQUE) — the double-sweep guard. */
  ensureFundingRow(input: {
    sourceRef: string;
    checkoutId: string;
    amountUsdc: string;
    metadata: Record<string, unknown>;
  }): Promise<FundingRow>;
  claimFundingRow(fundingId: string, claimId: string): Promise<FundingRow | null>;
  /** Definitive PRE-SEND failure only (nothing signed/sent): back to pending. */
  releaseFundingClaim(fundingId: string, claimId: string): Promise<void>;
  /** Capture-before-send: persist the sweep signature, checked to the claim. */
  captureSweepSignature(fundingId: string, claimId: string, signature: string): Promise<boolean>;
  markFundingSwept(fundingId: string, claimId: string): Promise<boolean>;
  markFundingFailed(fundingId: string, claimId: string, reason: string): Promise<void>;
  markFundingReconcile(fundingId: string, claimId: string, reason: string): Promise<void>;
  getFundingBySourceRef(sourceRef: string): Promise<FundingRow | null>;
}

export interface ClvSwapLiveDeps {
  db?: ClvSwapLiveDb;
  getPrice?: () => ClvPriceQuote;
  loadSwapKeypair?: () => Promise<Keypair>;
  loadMerchantKeypair?: () => Promise<Keypair>;
  /** READ-ONLY swap-wallet pubkey (the sweep DESTINATION — the sweep never
   *  decrypts the swap secret; least-privilege). */
  getSwapWalletPubkey?: () => Promise<string | null>;
  connection?: () => Connection;
  fetchImpl?: typeof fetch;
  /** Injectable local signer seam for post-sign/pre-capture failure tests. */
  signFundingTransaction?: (transaction: Transaction, signer: Keypair) => void;
  /** Send a fully-signed raw tx; resolves to the signature the RPC echoed. */
  sendRawTransaction?: (conn: Connection, raw: Uint8Array) => Promise<string>;
  /** Confirm by blockhash strategy. 'failed' = definitive on-chain failure
   *  (no money moved); a THROW = ambiguous (timeout/transport). */
  confirmTransaction?: (
    conn: Connection,
    signature: string,
    blockhash: string,
    lastValidBlockHeight: number,
  ) => Promise<'confirmed' | 'failed'>;
  sleep?: (ms: number) => Promise<void>;
  /** Ops pager for stale-claim alerts (defaults to the shared Telegram
   *  `alertError`; never throws). Injectable so tests assert the page. */
  alert?: (params: AlertErrorParams) => Promise<void>;
}

const defaultDb: ClvSwapLiveDb = {
  async getQueueRow(queueId) {
    const [row] = await db.select().from(clvBuyQueue).where(eq(clvBuyQueue.id, queueId)).limit(1);
    return row ?? null;
  },
  async listPlannedQueueRows(limit) {
    return db
      .select()
      .from(clvBuyQueue)
      .where(eq(clvBuyQueue.status, 'planned'))
      .orderBy(asc(clvBuyQueue.createdAt))
      .limit(limit);
  },
  async listStaleExecutingQueueRows(cutoff, limit) {
    return db
      .select()
      .from(clvBuyQueue)
      .where(and(eq(clvBuyQueue.status, 'executing'), lt(clvBuyQueue.claimedAt, cutoff)))
      .orderBy(asc(clvBuyQueue.claimedAt))
      .limit(limit);
  },
  async claimQueueRow(queueId, claimId) {
    const rows = await db
      .update(clvBuyQueue)
      .set({ status: 'executing', claimId, claimedAt: new Date() })
      .where(and(eq(clvBuyQueue.id, queueId), eq(clvBuyQueue.status, 'planned')))
      .returning();
    return rows[0] ?? null;
  },
  async releaseQueueClaim(queueId, claimId) {
    const rows = await db
      .update(clvBuyQueue)
      .set({ status: 'planned', claimId: null, claimedAt: null })
      .where(
        and(
          eq(clvBuyQueue.id, queueId),
          eq(clvBuyQueue.claimId, claimId),
          eq(clvBuyQueue.status, 'executing'),
          sql`jsonb_array_length(COALESCE(${clvBuyQueue.txSignatures}, '[]'::jsonb)) = 0`,
        ),
      )
      .returning({ id: clvBuyQueue.id });
    return rows.length > 0;
  },
  async appendClipFill(queueId, claimId, entry) {
    const rows = await db
      .update(clvBuyQueue)
      .set({
        txSignatures: sql`COALESCE(${clvBuyQueue.txSignatures}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
      })
      .where(
        and(
          eq(clvBuyQueue.id, queueId),
          eq(clvBuyQueue.claimId, claimId),
          eq(clvBuyQueue.status, 'executing'),
        ),
      )
      .returning({ id: clvBuyQueue.id });
    return rows.length > 0;
  },
  async markQueueExecuted(queueId, claimId, executedPrice) {
    const rows = await db
      .update(clvBuyQueue)
      .set({ status: 'executed', executedAt: new Date(), executedPrice })
      .where(
        and(
          eq(clvBuyQueue.id, queueId),
          eq(clvBuyQueue.claimId, claimId),
          eq(clvBuyQueue.status, 'executing'),
        ),
      )
      .returning({ id: clvBuyQueue.id });
    return rows.length > 0;
  },
  async getSettledCheckout(checkoutId) {
    const [row] = await db
      .select({
        id: x402Checkouts.id,
        status: x402Checkouts.status,
        txSignature: x402Checkouts.txSignature,
        usdCents: x402Checkouts.usdCents,
        metadata: x402Checkouts.metadata,
      })
      .from(x402Checkouts)
      .where(eq(x402Checkouts.id, checkoutId))
      .limit(1);
    return row ? { ...row, metadata: (row.metadata ?? null) as Record<string, unknown> | null } : null;
  },
  async ensureFundingRow(input) {
    const inserted = await db
      .insert(clvSwapFunding)
      .values({
        sourceRef: input.sourceRef,
        checkoutId: input.checkoutId,
        amountUsdc: input.amountUsdc,
        status: 'pending',
        metadata: input.metadata,
      })
      .onConflictDoNothing({ target: clvSwapFunding.sourceRef })
      .returning();
    if (inserted[0]) return inserted[0];
    const [existing] = await db
      .select()
      .from(clvSwapFunding)
      .where(eq(clvSwapFunding.sourceRef, input.sourceRef))
      .limit(1);
    if (!existing) throw new Error('[clv-swap-live] funding upsert returned no row');
    return existing;
  },
  async claimFundingRow(fundingId, claimId) {
    const rows = await db
      .update(clvSwapFunding)
      .set({ status: 'sweeping', claimId, claimedAt: new Date() })
      .where(and(eq(clvSwapFunding.id, fundingId), eq(clvSwapFunding.status, 'pending')))
      .returning();
    return rows[0] ?? null;
  },
  async releaseFundingClaim(fundingId, claimId) {
    await db
      .update(clvSwapFunding)
      .set({ status: 'pending', claimId: null, claimedAt: null })
      .where(
        and(
          eq(clvSwapFunding.id, fundingId),
          eq(clvSwapFunding.claimId, claimId),
          eq(clvSwapFunding.status, 'sweeping'),
          sql`${clvSwapFunding.sweepTxSignature} IS NULL`,
        ),
      );
  },
  async captureSweepSignature(fundingId, claimId, signature) {
    const rows = await db
      .update(clvSwapFunding)
      .set({ sweepTxSignature: signature })
      .where(
        and(
          eq(clvSwapFunding.id, fundingId),
          eq(clvSwapFunding.claimId, claimId),
          eq(clvSwapFunding.status, 'sweeping'),
          sql`${clvSwapFunding.sweepTxSignature} IS NULL`,
        ),
      )
      .returning({ id: clvSwapFunding.id });
    return rows.length > 0;
  },
  async markFundingSwept(fundingId, claimId) {
    const rows = await db
      .update(clvSwapFunding)
      .set({ status: 'swept', sweptAt: new Date() })
      .where(
        and(
          eq(clvSwapFunding.id, fundingId),
          eq(clvSwapFunding.claimId, claimId),
          eq(clvSwapFunding.status, 'sweeping'),
        ),
      )
      .returning({ id: clvSwapFunding.id });
    return rows.length > 0;
  },
  async markFundingFailed(fundingId, claimId, reason) {
    await db
      .update(clvSwapFunding)
      .set({ status: 'failed', failureReason: reason })
      .where(and(eq(clvSwapFunding.id, fundingId), eq(clvSwapFunding.claimId, claimId)));
  },
  async markFundingReconcile(fundingId, claimId, reason) {
    await db
      .update(clvSwapFunding)
      .set({ status: 'reconcile', failureReason: reason })
      .where(and(eq(clvSwapFunding.id, fundingId), eq(clvSwapFunding.claimId, claimId)));
  },
  async getFundingBySourceRef(sourceRef) {
    const [row] = await db
      .select()
      .from(clvSwapFunding)
      .where(eq(clvSwapFunding.sourceRef, sourceRef))
      .limit(1);
    return row ?? null;
  },
};

function resolveDeps(deps?: ClvSwapLiveDeps): Required<ClvSwapLiveDeps> {
  return {
    db: deps?.db ?? defaultDb,
    getPrice: deps?.getPrice ?? getClvPrice,
    loadSwapKeypair: deps?.loadSwapKeypair ?? loadClvSwapKeypair,
    loadMerchantKeypair: deps?.loadMerchantKeypair ?? loadX402MerchantKeypair,
    getSwapWalletPubkey: deps?.getSwapWalletPubkey ?? getClvSwapWalletPubkey,
    connection: deps?.connection ?? getClvMainnetConnection,
    fetchImpl: deps?.fetchImpl ?? fetch,
    signFundingTransaction:
      deps?.signFundingTransaction ?? ((transaction, signer) => transaction.sign(signer)),
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
    sleep: deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    alert: deps?.alert ?? alertError,
  };
}

// ---------------------------------------------------------------------------
// FUNDING SWEEP — merchant USDC → clv-swap wallet, exactly once per source
// ---------------------------------------------------------------------------

export type FundingSweepResult =
  | { ok: true; fundingId: string; sweepTxSignature: string; replay: boolean }
  | {
      ok: false;
      code:
        | 'queue_row_not_found'
        | 'queue_row_skipped'
        | 'no_source_ref'
        | 'source_not_checkout_uuid'
        | 'checkout_not_found'
        | 'checkout_not_settled'
        | 'checkout_not_mainnet'
        | 'amount_exceeds_checkout'
        | 'funding_terminal'
        | 'funding_in_flight'
        | 'claim_lost'
        | 'insufficient_merchant_usdc'
        | 'capture_lost'
        | 'send_ambiguous'
        | 'sweep_tx_failed';
      detail?: string;
    };

const uuidSchema = z.string().uuid();

/**
 * Sweep the owed USDC for ONE queued buy from the x402-merchant wallet to the
 * clv-swap wallet, with the full exactly-once trail on `clv_swap_funding`.
 * See the module header for the step-by-step money discipline. LIVE — gated
 * (throws) unless the seam is open AND the mainnet/real-facilitator guard holds.
 */
export async function claimAndSweepFundingForQueueRow(
  queueId: string,
  deps?: ClvSwapLiveDeps,
): Promise<FundingSweepResult> {
  requireLiveClvSwapExecution();
  assertMainnetRealMoneyContext();
  const d = resolveDeps(deps);

  // 1) The queue row + its source event.
  const queueRow = await d.db.getQueueRow(queueId);
  if (!queueRow) return { ok: false, code: 'queue_row_not_found' };
  if (queueRow.status === 'skipped') {
    // NEVER move USDC for a buy an operator decided not to execute — a sweep
    // for a skipped row would park customer USDC in the swap wallet forever.
    return { ok: false, code: 'queue_row_skipped' };
  }
  const sourceRef = queueRow.sourceRef;
  if (!sourceRef) return { ok: false, code: 'no_source_ref' };
  if (!uuidSchema.safeParse(sourceRef).success) {
    // Not checkout-backed (a non-uuid source event) — v1 live funding is
    // SETTLED-CHECKOUT-ONLY; anything else is a documented manual case.
    return { ok: false, code: 'source_not_checkout_uuid' };
  }
  const queueMicro = usdcToMicro(queueRow.amountUsdc);
  if (queueMicro === null || queueMicro <= 0n) {
    return { ok: false, code: 'amount_exceeds_checkout', detail: 'unparseable queue amount' };
  }

  // 2) Amounts tied to SETTLED checkouts ONLY — verify the source checkout.
  const checkout = await d.db.getSettledCheckout(sourceRef);
  if (!checkout) return { ok: false, code: 'checkout_not_found' };
  if (checkout.status !== 'settled' || !checkout.txSignature) {
    return { ok: false, code: 'checkout_not_settled', detail: checkout.status };
  }
  // Defense-in-depth on top of assertMainnetRealMoneyContext: THIS checkout
  // must itself have settled on mainnet (its USDC is what we are sweeping).
  const meta = checkout.metadata ?? {};
  const settledMainnet =
    meta.settleNetwork === SOLANA_MAINNET_CAIP2 ||
    (meta.settleNetwork === undefined && meta.network === 'mainnet');
  if (!settledMainnet) {
    return { ok: false, code: 'checkout_not_mainnet' };
  }
  const checkoutMicro = BigInt(checkout.usdCents) * 10_000n; // cents → µUSD
  if (queueMicro > checkoutMicro) {
    // NEVER sweep more than the checkout actually settled.
    return {
      ok: false,
      code: 'amount_exceeds_checkout',
      detail: `queue=${microToUsdc(queueMicro)} checkout=${microToUsdc(checkoutMicro)}`,
    };
  }
  if (queueMicro < checkoutMicro) {
    console.warn(
      `[clv-swap-live] funding sweep for queue=${queueId} is PARTIAL vs its checkout ` +
        `(${microToUsdc(queueMicro)} of ${microToUsdc(checkoutMicro)}) — expected for split flows, verifying anyway`,
    );
  }

  // 3) Upsert the funding row (source_ref UNIQUE = the double-sweep guard).
  const funding = await d.db.ensureFundingRow({
    sourceRef,
    checkoutId: checkout.id,
    amountUsdc: microToUsdc(queueMicro),
    metadata: { queueId, reason: queueRow.reason },
  });
  if (funding.status === 'swept') {
    // Idempotent replay — the money already moved exactly once.
    return {
      ok: true,
      fundingId: funding.id,
      sweepTxSignature: funding.sweepTxSignature ?? '',
      replay: true,
    };
  }
  if (funding.status === 'failed' || funding.status === 'reconcile') {
    // Terminal — NEVER auto-retried (reconcile = money-state unknown).
    return { ok: false, code: 'funding_terminal', detail: funding.status };
  }
  if (funding.status === 'sweeping') {
    return { ok: false, code: 'funding_in_flight' };
  }
  // Conservation tripwire: an existing pending row must carry the SAME amount.
  const fundingMicro = usdcToMicro(funding.amountUsdc);
  if (fundingMicro !== queueMicro) {
    console.error(
      `[clv-swap-live] FUNDING AMOUNT MISMATCH — funding=${funding.id} carries ` +
        `$${funding.amountUsdc} but queue=${queueId} owes $${microToUsdc(queueMicro)}; refusing`,
    );
    return { ok: false, code: 'amount_exceeds_checkout', detail: 'funding_amount_mismatch' };
  }

  // 4) ATOMIC CLAIM (pending → sweeping) BEFORE any decrypt/sign/send.
  const claimId = randomUUID();
  const claimed = await d.db.claimFundingRow(funding.id, claimId);
  if (!claimed) return { ok: false, code: 'claim_lost' };

  // Once signing starts, the claim may NEVER release back to pending (an
  // unexpected error after that boundary goes to reconcile, not retry).
  let signingStarted = false;
  let sigCaptured = false;
  try {
    // 5) Custody — ONLY the merchant signs a sweep; the swap wallet is just the
    //    destination (READ-ONLY pubkey lookup; its secret is never decrypted
    //    on the sweep path — least-privilege).
    const merchant = await d.loadMerchantKeypair();
    const swapWalletBase58 = await d.getSwapWalletPubkey();
    if (!swapWalletBase58) {
      await d.db.releaseFundingClaim(funding.id, claimId);
      return { ok: false, code: 'sweep_tx_failed', detail: 'clv-swap wallet unprovisioned' };
    }
    const swapWalletPubkey = new PublicKey(swapWalletBase58);
    const conn = d.connection();

    // 6) Fail fast on an unfunded merchant (definitive PRE-SEND check —
    //    releases the claim so a later retry can re-claim once funded).
    const merchantBalance = await readSplTokenBalance(
      conn,
      USDC_MINT_MAINNET,
      merchant.publicKey.toBase58(),
    );
    if (merchantBalance.amountAtomic < queueMicro) {
      await d.db.releaseFundingClaim(funding.id, claimId);
      return {
        ok: false,
        code: 'insufficient_merchant_usdc',
        detail: `have=${merchantBalance.amountAtomic} need=${queueMicro}`,
      };
    }

    // 7) Build + sign the transferChecked (exact µUSD; TransferChecked pins
    //    mint + decimals on-chain).
    const sourceAta = findUsdcAta(merchant.publicKey);
    const destAta = findUsdcAta(swapWalletPubkey);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const txn = new Transaction({
      feePayer: merchant.publicKey,
      blockhash,
      lastValidBlockHeight,
    });
    txn.add(createAtaIdempotentIx(merchant.publicKey, destAta, swapWalletPubkey));
    txn.add(transferCheckedIx(sourceAta, destAta, merchant.publicKey, queueMicro));
    // Set BEFORE the signer call. A signer that throws after partially
    // mutating the transaction is no longer provably unsigned, so this claim
    // may not return to pending under the strict money-path contract.
    signingStarted = true;
    d.signFundingTransaction(txn, merchant);
    if (!txn.signature) {
      await d.db.markFundingReconcile(funding.id, claimId, 'sweep_signing_no_signature');
      return { ok: false, code: 'capture_lost', detail: 'signing produced no signature' };
    }
    const signature = bs58.encode(txn.signature);

    // 8) CAPTURE-BEFORE-SEND — the signature is durable BEFORE the wire is
    //    touched, so an ambiguous send can never lose its money proof.
    const captured = await d.db.captureSweepSignature(funding.id, claimId, signature);
    if (!captured) {
      // Our claim no longer matches — do NOT send. Nothing has moved.
      return { ok: false, code: 'capture_lost' };
    }
    sigCaptured = true;

    // 9) Send + confirm. From here on NOTHING retries: ambiguous ⇒ reconcile.
    let sent = false;
    try {
      await d.sendRawTransaction(conn, txn.serialize());
      sent = true;
      const outcome = await d.confirmTransaction(conn, signature, blockhash, lastValidBlockHeight);
      if (outcome === 'failed') {
        // Definitive on-chain failure — the tx landed and FAILED, no tokens
        // moved. Terminal + loud; ops re-runs via a fresh funding row decision,
        // never an auto-retry.
        console.error(
          `[clv-swap-live] SWEEP TX FAILED ON-CHAIN — funding=${funding.id} tx=${signature}; ` +
            `no USDC moved; row → failed (manual re-run decision)`,
        );
        await d.db.markFundingFailed(funding.id, claimId, `sweep_tx_failed_on_chain`);
        return { ok: false, code: 'sweep_tx_failed' };
      }
    } catch (err) {
      // AMBIGUOUS — the send/confirm attempt errored; the tx MAY have landed.
      // Signature is captured; reconcile resolves against the chain. NEVER retry.
      const phase = sent ? 'confirm' : 'send';
      console.error(
        `[clv-swap-live] AMBIGUOUS SWEEP ${phase.toUpperCase()} — funding=${funding.id} ` +
          `tx=${signature}; money-state UNKNOWN → reconcile (no re-send): ${(err as Error).message}`,
      );
      await d.db.markFundingReconcile(funding.id, claimId, `sweep_${phase}_ambiguous`);
      return { ok: false, code: 'send_ambiguous', detail: phase };
    }

    // 10) Confirmed — mark swept (checked to our claim).
    const marked = await d.db.markFundingSwept(funding.id, claimId);
    if (!marked) {
      console.error(
        `[clv-swap-live] SWEPT-MARK MISSED after confirmed sweep — funding=${funding.id} ` +
          `tx=${signature}; the signature IS captured; manual verify required`,
      );
      await d.db.markFundingReconcile(funding.id, claimId, 'sweep_confirmed_mark_missed');
      return { ok: false, code: 'send_ambiguous', detail: 'confirmed_mark_missed' };
    }
    return { ok: true, fundingId: funding.id, sweepTxSignature: signature, replay: false };
  } catch (err) {
    if (sigCaptured || signingStarted) {
      // Signing started, so this attempt is no longer provably unsigned even
      // when capture itself threw. NEVER release to pending; reconcile is the
      // fail-closed state.
      console.error(
        `[clv-swap-live] UNEXPECTED POST-SIGNING ERROR — funding=${funding.id}: ` +
          `${(err as Error).message}; → reconcile (never release/retry)`,
      );
      const phase = sigCaptured ? 'post_capture' : 'post_signing_pre_capture';
      await d.db.markFundingReconcile(funding.id, claimId, `sweep_unexpected_${phase}`);
      return {
        ok: false,
        code: sigCaptured ? 'send_ambiguous' : 'capture_lost',
        detail: `unexpected_${phase}`,
      };
    }
    // Pre-signing failure (custody/RPC read/blockhash) — nothing was signed,
    // captured, or sent: release the claim for a clean retry.
    console.error(
      `[clv-swap-live] sweep pre-send failure — funding=${funding.id}: ${(err as Error).message}`,
    );
    await d.db.releaseFundingClaim(funding.id, claimId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// LIVE EXECUTION — atomic claim + per-clip Jupiter USDC→CLV swaps
// ---------------------------------------------------------------------------

export type LiveExecuteResult =
  | {
      ok: true;
      queueId: string;
      clipCount: number;
      totalClvOutAtomic: string;
      executedPrice: string;
    }
  | {
      ok: false;
      code:
        | 'queue_row_not_found'
        | 'no_source_ref'
        | 'funding_not_swept'
        | 'claim_lost'
        | 'invalid_amount'
        | 'oracle_unavailable'
        | 'no_liquidity'
        | 'clip_count_excessive'
        | 'jupiter_quote_failed'
        | 'quote_below_oracle_min_out'
        | 'jupiter_swap_failed'
        | 'swap_tx_payer_mismatch'
        | 'swap_tx_binding_failed'
        | 'capture_lost'
        | 'send_ambiguous'
        | 'clip_tx_failed';
      /** Clips that CONFIRMED before the stop (their fills are durable). */
      executedClips: number;
      detail?: string;
    };

/**
 * Execute ONE queued buy live: atomic claim, then price-impact-capped clips
 * against Jupiter with an independent oracle sanity floor on quoted output.
 * See the module header for the full discipline. LIVE — gated (throws) unless
 * the seam is open AND the mainnet/real-facilitator guard holds.
 *
 * A stop after signing or after any confirmed clip leaves the row `executing`
 * with every captured fill durable in `tx_signatures` — it is NEVER
 * auto-resumed (reconciler case), because a resume cannot prove the money-state
 * of the stopping clip. A zero-clip PRE-SIGN/PRE-SEND refusal/error releases
 * the empty claim to `planned`; the DB transition independently requires no
 * captured fills.
 */
export async function executeQueuedClvBuy(
  queueId: string,
  deps?: ClvSwapLiveDeps,
): Promise<LiveExecuteResult> {
  requireLiveClvSwapExecution();
  assertMainnetRealMoneyContext();
  const d = resolveDeps(deps);

  // 1) Row + funding precondition — the owed USDC must ALREADY sit in the swap
  //    wallet (funding row SWEPT). v1 live execution is checkout-funded only.
  const row = await d.db.getQueueRow(queueId);
  if (!row) return { ok: false, code: 'queue_row_not_found', executedClips: 0 };
  if (!row.sourceRef) return { ok: false, code: 'no_source_ref', executedClips: 0 };
  const funding = await d.db.getFundingBySourceRef(row.sourceRef);
  if (!funding || funding.status !== 'swept') {
    return {
      ok: false,
      code: 'funding_not_swept',
      executedClips: 0,
      detail: funding?.status ?? 'missing',
    };
  }
  const amountMicro = usdcToMicro(row.amountUsdc);
  if (amountMicro === null || amountMicro <= 0n) {
    return { ok: false, code: 'invalid_amount', executedClips: 0 };
  }
  const fundingMicro = usdcToMicro(funding.amountUsdc);
  if (fundingMicro !== amountMicro) {
    console.error(
      `[clv-swap-live] EXECUTE AMOUNT MISMATCH — queue=${queueId} owes $${row.amountUsdc} but ` +
        `funding=${funding.id} swept $${funding.amountUsdc}; refusing`,
    );
    return { ok: false, code: 'funding_not_swept', executedClips: 0, detail: 'amount_mismatch' };
  }

  // 2) ATOMIC CLAIM — planned→executing, BEFORE any decrypt/sign/send. A
  //    double-claim (or a restart finding a row already 'executing') matches
  //    zero rows and refuses here; nothing downstream ever runs twice.
  const claimId = randomUUID();
  const claimed = await d.db.claimQueueRow(queueId, claimId);
  if (!claimed) return { ok: false, code: 'claim_lost', executedClips: 0 };

  let clipIndex = 0;
  let signingStarted = false;
  const releaseEmptyClaim = async (): Promise<void> => {
    if (clipIndex !== 0 || signingStarted) return;
    // The DB CAS independently requires the same executing claim AND no
    // captured fills. This in-memory boundary can therefore never erase a
    // signature even if a future caller invokes it from the wrong phase.
    const released = await d.db.releaseQueueClaim(queueId, claimId);
    if (!released) {
      console.error(
        `[clv-swap-live] SAFE CLAIM RELEASE MISSED — queue=${queueId} claim=${claimId}; ` +
          `row was not the same empty executing claim; leaving state untouched`,
      );
    }
  };
  const stopBeforeSigning = async (result: LiveExecuteResult): Promise<LiveExecuteResult> => {
    await releaseEmptyClaim();
    return result;
  };
  const runBeforeSigning = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (err) {
      await releaseEmptyClaim();
      throw err;
    }
  };

  // 3) Custody + wire config (AFTER the claim — the claim is the exclusivity).
  const {
    swapKeypair,
    conn,
    maxImpactBps,
    slippageBps,
    oracleToleranceBps,
    spacingMs,
    jupiterBase,
  } = await runBeforeSigning(async () => ({
    swapKeypair: await d.loadSwapKeypair(),
    conn: d.connection(),
    maxImpactBps: resolveClvSwapMaxImpactBps(),
    // Per-row max_slippage overrides ONLY the Jupiter leg; oracle tolerance
    // is independent so the same factor can never cancel on both sides.
    slippageBps: parseRowSlippageBps(claimed.maxSlippage) ?? resolveClvSwapSlippageBps(),
    oracleToleranceBps: resolveClvSwapOracleToleranceBps(),
    spacingMs: resolveClvSwapClipSpacingMs(),
    jupiterBase: resolveJupiterBaseUrl(),
  }));

  let remaining = amountMicro;
  let totalOutAtomic = 0n;

  while (remaining > 0n) {
    // 4a) PER-CLIP ORACLE RE-FETCH + HARD-STOP. `available === false` stops
    //     sizing outright — BOTH quoteUsd and poolLiquidityUsd are refused
    //     regardless of whether the stale struct still carries numbers.
    const quote = await runBeforeSigning(() => d.getPrice());
    if (!quote.available || quote.quoteUsd === null) {
      console.error(
        `[clv-swap-live] ORACLE UNAVAILABLE mid-execution — queue=${queueId} after ` +
          `${clipIndex} clip(s); stopping before the next clip (partial fills, if any, stay durable)`,
      );
      return stopBeforeSigning({
        ok: false,
        code: 'oracle_unavailable',
        executedClips: clipIndex,
      });
    }

    // 4b) Size THIS clip from the CURRENT depth (re-fetched every iteration).
    const clipMicro = sizeClipMicro(remaining, quote.poolLiquidityUsd, maxImpactBps);
    if (clipMicro === null) {
      console.error(
        `[clv-swap-live] NO SAFE CLIP SIZE (depth=${quote.poolLiquidityUsd ?? 'null'}) — ` +
          `queue=${queueId} after ${clipIndex} clip(s); stopping before the next clip`,
      );
      return stopBeforeSigning({ ok: false, code: 'no_liquidity', executedClips: clipIndex });
    }
    if (wouldExceedMaxPlannedClips(clipIndex, remaining, clipMicro)) {
      return stopBeforeSigning({
        ok: false,
        code: 'clip_count_excessive',
        executedClips: clipIndex,
      });
    }

    // 4c) Jupiter quote, zod-parsed. Oracle sanity is deliberately on quoted
    //     outAmount with an INDEPENDENT tolerance. Comparing Jupiter's
    //     threshold O×(1−s) to oracle M×(1−s) cancels (1−s), requiring O≥M
    //     and making every fee-bearing route structurally impossible. We gate
    //     O≥M×(1−t); Jupiter separately enforces threshold O×(1−s) on-chain.
    const quoteUsd = quote.quoteUsd; // narrowed non-null above; closures don't inherit it
    const minOut = await runBeforeSigning(() =>
      oracleMinOutClvAtomic(clipMicro, quoteUsd, oracleToleranceBps),
    );
    let jupQuote: JupQuote;
    try {
      const url =
        `${jupiterBase}/swap/v1/quote?inputMint=${USDC_MINT_MAINNET}&outputMint=${CLV_MINT}` +
        `&amount=${clipMicro}&slippageBps=${slippageBps}&swapMode=ExactIn` +
        `&instructionVersion=V1&restrictIntermediateTokens=true`;
      const res = await d.fetchImpl(url, { signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        return stopBeforeSigning({
          ok: false,
          code: 'jupiter_quote_failed',
          executedClips: clipIndex,
          detail: `http_${res.status}`,
        });
      }
      jupQuote = jupQuoteSchema.parse(await res.json());
    } catch (err) {
      return stopBeforeSigning({
        ok: false,
        code: 'jupiter_quote_failed',
        executedClips: clipIndex,
        detail: (err as Error).message,
      });
    }
    if (
      jupQuote.inputMint !== USDC_MINT_MAINNET ||
      jupQuote.outputMint !== CLV_MINT ||
      jupQuote.inAmount !== clipMicro.toString() ||
      jupQuote.swapMode !== 'ExactIn' ||
      jupQuote.slippageBps !== slippageBps ||
      (jupQuote.instructionVersion !== undefined && jupQuote.instructionVersion !== 'V1')
    ) {
      return stopBeforeSigning({
        ok: false,
        code: 'jupiter_quote_failed',
        executedClips: clipIndex,
        detail: 'quote_echo_mismatch',
      });
    }
    const routePlanSane =
      jupQuote.routePlan.some((step) => step.swapInfo.inputMint === USDC_MINT_MAINNET) &&
      jupQuote.routePlan.some((step) => step.swapInfo.outputMint === CLV_MINT) &&
      jupQuote.routePlan.every((step) => {
        const swap = step.swapInfo;
        if (BigInt(swap.inAmount) <= 0n || BigInt(swap.outAmount) <= 0n) return false;
        if (swap.feeAmount === undefined && swap.feeMint === undefined) return true;
        if (swap.feeAmount === undefined || swap.feeMint === undefined) return false;
        if (swap.feeMint !== swap.inputMint && swap.feeMint !== swap.outputMint) return false;
        const feeBase = swap.feeMint === swap.inputMint ? swap.inAmount : swap.outAmount;
        return BigInt(swap.feeAmount) <= BigInt(feeBase);
      });
    if (!routePlanSane) {
      return stopBeforeSigning({
        ok: false,
        code: 'jupiter_quote_failed',
        executedClips: clipIndex,
        detail: 'quote_route_mismatch',
      });
    }
    const outAmount = BigInt(jupQuote.outAmount);
    const transactionMinimumOut = jupiterExactInMinimumOut(outAmount, slippageBps);
    // The threshold is untrusted wire data too. Its safe floor applies Jupiter
    // slippage AFTER the independent oracle tolerance: H≥M×(1−t)×(1−s).
    // An honest H=O×(1−s) can pass whenever O≥M×(1−t); cancellation reduces
    // only to that satisfiable quote gate, never to the impossible O≥M.
    const oracleThresholdFloor = (minOut * BigInt(10_000 - slippageBps)) / 10_000n;
    if (outAmount < minOut || transactionMinimumOut < oracleThresholdFloor) {
      console.error(
        `[clv-swap-live] JUPITER QUOTE BELOW ORACLE MIN-OUT — queue=${queueId} clip=${clipIndex} ` +
          `out=${outAmount} transactionMinimum=${transactionMinimumOut} oracleMinOut=${minOut} ` +
          `oracleThresholdFloor=${oracleThresholdFloor} toleranceBps=${oracleToleranceBps} ` +
          `slippageBps=${slippageBps}; refusing this clip`,
      );
      return stopBeforeSigning({
        ok: false,
        code: 'quote_below_oracle_min_out',
        executedClips: clipIndex,
      });
    }

    // 4d) Jupiter swap tx: fetch, deserialize, verify the payer is OUR wallet,
    //     sign locally (the key never leaves the process).
    let swapTx: VersionedTransaction;
    let lastValidBlockHeight: number | undefined;
    try {
      const destinationTokenAccount = await existingClvDestinationAta(conn, swapKeypair.publicKey);
      const res = await d.fetchImpl(`${jupiterBase}/swap/v1/swap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: jupQuote,
          userPublicKey: swapKeypair.publicKey.toBase58(),
          ...(destinationTokenAccount ? { destinationTokenAccount } : {}),
          wrapAndUnwrapSol: false,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              priorityLevel: 'high',
              maxLamports: Number(MAX_PRIORITY_FEE_LAMPORTS),
              global: false,
            },
          },
        }),
        signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        return stopBeforeSigning({
          ok: false,
          code: 'jupiter_swap_failed',
          executedClips: clipIndex,
          detail: `http_${res.status}`,
        });
      }
      const parsed = jupSwapSchema.parse(await res.json());
      lastValidBlockHeight = parsed.lastValidBlockHeight;
      swapTx = VersionedTransaction.deserialize(Buffer.from(parsed.swapTransaction, 'base64'));
    } catch (err) {
      return stopBeforeSigning({
        ok: false,
        code: 'jupiter_swap_failed',
        executedClips: clipIndex,
        detail: (err as Error).message,
      });
    }
    const payer = swapTx.message.staticAccountKeys[0];
    if (!payer || !payer.equals(swapKeypair.publicKey)) {
      // NEVER sign a transaction whose fee payer isn't our swap wallet.
      return stopBeforeSigning({
        ok: false,
        code: 'swap_tx_payer_mismatch',
        executedClips: clipIndex,
      });
    }
    let lookupTables: AddressLookupTableAccount[];
    try {
      lookupTables = await resolveJupiterLookupTables(swapTx, conn);
    } catch (err) {
      return stopBeforeSigning({
        ok: false,
        code: 'swap_tx_binding_failed',
        executedClips: clipIndex,
        detail: (err as Error).message,
      });
    }
    const binding = validateJupiterSwapTransaction({
      transaction: swapTx,
      wallet: swapKeypair.publicKey,
      inputAmount: clipMicro,
      quotedOutAmount: outAmount,
      slippageBps,
      addressLookupTableAccounts: lookupTables,
    });
    if (!binding.ok || binding.minimumOutAmount !== transactionMinimumOut) {
      return stopBeforeSigning({
        ok: false,
        code: 'swap_tx_binding_failed',
        executedClips: clipIndex,
        detail: binding.ok ? 'minimum_out_mismatch' : binding.detail,
      });
    }
    const writableAccounts = await validateJupiterWritableTokenAccounts({
      transaction: swapTx,
      wallet: swapKeypair.publicKey,
      connection: conn,
      addressLookupTableAccounts: lookupTables,
    });
    if (!writableAccounts.ok) {
      return stopBeforeSigning({
        ok: false,
        code: 'swap_tx_binding_failed',
        executedClips: clipIndex,
        detail: writableAccounts.detail,
      });
    }
    // Set BEFORE calling sign: a throwing/partially-mutating signer is not
    // provably unsigned and therefore must never release this row for retry.
    signingStarted = true;
    swapTx.sign([swapKeypair]);
    const signature = bs58.encode(swapTx.signatures[0]);

    // 4e) CAPTURE-BEFORE-SEND — the clip's signature + size are durable BEFORE
    //     the wire is touched.
    const fill: ClipFillRecord = {
      index: clipIndex,
      amountUsdc: microToUsdc(clipMicro),
      signature,
      // Persist the decoded instruction floor, never the quote response's
      // informational otherAmountThreshold or optimistic outAmount.
      outAmountAtomic: transactionMinimumOut.toString(),
      quotedAt: new Date().toISOString(),
    };
    const captured = await d.db.appendClipFill(queueId, claimId, fill);
    if (!captured) {
      // Claim no longer ours — abort WITHOUT sending; nothing moved this clip.
      return { ok: false, code: 'capture_lost', executedClips: clipIndex };
    }

    // 4f) Send + confirm. Ambiguous ⇒ stop forever (reconciler resolves);
    //     definitive on-chain failure ⇒ stop loud (no money moved this clip).
    let sent = false;
    try {
      await d.sendRawTransaction(conn, swapTx.serialize());
      sent = true;
      const blockhash = swapTx.message.recentBlockhash;
      const lvbh =
        lastValidBlockHeight ?? (await conn.getLatestBlockhash('confirmed')).lastValidBlockHeight;
      const outcome = await d.confirmTransaction(conn, signature, blockhash, lvbh);
      if (outcome === 'failed') {
        console.error(
          `[clv-swap-live] CLIP TX FAILED ON-CHAIN — queue=${queueId} clip=${clipIndex} ` +
            `tx=${signature}; no funds moved this clip; row stays 'executing' (manual decision)`,
        );
        return { ok: false, code: 'clip_tx_failed', executedClips: clipIndex };
      }
    } catch (err) {
      const phase = sent ? 'confirm' : 'send';
      console.error(
        `[clv-swap-live] AMBIGUOUS CLIP ${phase.toUpperCase()} — queue=${queueId} clip=${clipIndex} ` +
          `tx=${signature}; money-state UNKNOWN → row stays 'executing', NEVER auto-retried: ` +
          `${(err as Error).message}`,
      );
      return { ok: false, code: 'send_ambiguous', executedClips: clipIndex, detail: phase };
    }

    // Clip confirmed.
    remaining -= clipMicro;
    totalOutAtomic += transactionMinimumOut;
    clipIndex += 1;

    if (remaining > 0n && spacingMs > 0) {
      await d.sleep(spacingMs);
    }
  }

  // 5) CONSERVATION: the loop structurally spends remaining down to exactly 0
  //    (Σ clip µUSD === queued amount). The accounting price is conservative:
  //    each clip contributes the decoded on-chain ExactIn minimum, not the
  //    API's informational threshold or optimistic outAmount.
  const executedPrice =
    totalOutAtomic > 0n
      ? (Number(amountMicro) / 1_000_000 / (Number(totalOutAtomic) / 10 ** CLV_DECIMALS)).toFixed(12)
      : '0.000000000000';
  const marked = await d.db.markQueueExecuted(queueId, claimId, executedPrice);
  if (!marked) {
    console.error(
      `[clv-swap-live] EXECUTED-MARK MISSED — queue=${queueId} completed ${clipIndex} clip(s) ` +
        `but the executed flip matched no row; fills ARE durable in tx_signatures; manual verify`,
    );
  }
  return {
    ok: true,
    queueId,
    clipCount: clipIndex,
    totalClvOutAtomic: totalOutAtomic.toString(),
    executedPrice,
  };
}

// ---------------------------------------------------------------------------
// LIVE worker — boot-wired ONLY behind CLV_SWAP_EXECUTE='true' (dry-run default)
// ---------------------------------------------------------------------------

/**
 * One live pass: (1) page ops on any STALE 'executing' claim (a crashed
 * mid-execution claim — ALERT-ONLY, never auto-resumed), then (2) scan a small
 * batch of planned rows; for each, sweep its funding then execute. Driven by
 * the live worker below (which index.ts boot-selects only when
 * `CLV_SWAP_EXECUTE === 'true'`) + the staging harness.
 */
export async function runLiveClvSwapTick(
  deps?: ClvSwapLiveDeps,
): Promise<Array<{ queueId: string; sweep: FundingSweepResult; execute: LiveExecuteResult | null }>> {
  requireLiveClvSwapExecution();
  assertMainnetRealMoneyContext();
  const d = resolveDeps(deps);

  // STALE-CLAIM ALERTING (2026-07-08, Codex re-review) — a row stuck
  // 'executing' past the stale floor is a CRASHED claim (its confirmed fills
  // are durable in tx_signatures). ALERT-ONLY: page ops and skip — NO
  // auto-retry, NO auto-resume (a resume cannot prove the money-state of the
  // stopping clip; the row stays for a manual reconcile decision).
  try {
    const staleCutoff = new Date(Date.now() - resolveClvSwapExecutingStaleMs());
    const staleRows = await d.db.listStaleExecutingQueueRows(staleCutoff, 10);
    for (const staleRow of staleRows) {
      console.error(
        `[clv-swap-live] STALE 'executing' CLAIM — queue=${staleRow.id} ` +
          `claimed_at=${staleRow.claimedAt?.toISOString() ?? 'NULL'} amount=$${staleRow.amountUsdc}; ` +
          `crashed claim — manual reconcile required (NEVER auto-resumed)`,
      );
      await d.alert({
        severity: 'warning',
        source: 'clv-swap-live',
        message:
          `clv_buy_queue row stuck 'executing' past the stale floor — queue=${staleRow.id} ` +
          `(crashed claim; manual reconcile, never auto-retried)`,
        context: {
          queueId: staleRow.id,
          claimId: staleRow.claimId,
          claimedAt: staleRow.claimedAt?.toISOString() ?? null,
          amountUsdc: staleRow.amountUsdc,
        },
      });
    }
  } catch (err) {
    // The stale scan is monitoring — it must never block the live pass.
    console.error('[clv-swap-live] stale-claim scan failed (non-fatal):', err);
  }

  const rows = await d.db.listPlannedQueueRows(10);
  const results: Array<{
    queueId: string;
    sweep: FundingSweepResult;
    execute: LiveExecuteResult | null;
  }> = [];
  for (const row of rows) {
    const sweep = await claimAndSweepFundingForQueueRow(row.id, deps);
    let execute: LiveExecuteResult | null = null;
    if (sweep.ok) {
      execute = await executeQueuedClvBuy(row.id, deps);
    }
    results.push({ queueId: row.id, sweep, execute });
  }
  return results;
}

let liveWorkerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The live worker loop. Boot-selected only when
 * `CLV_SWAP_EXECUTE === 'true'`; unset/false keeps the dry-run worker as the
 * default. Gated at start AND inherits every tick's live/network guards.
 */
export function startClvSwapLiveWorker(pollMs = 300_000): void {
  requireLiveClvSwapExecution();
  assertMainnetRealMoneyContext();
  if (liveWorkerTimer) return;
  const periodMs = Math.max(30_000, Math.floor(pollMs));
  liveWorkerTimer = setInterval(() => {
    runLiveClvSwapTick().catch((err) => {
      console.error('[clv-swap-live] live tick failed (non-fatal):', err);
    });
  }, periodMs);
  console.log(
    `[clv-swap-live] LIVE worker started — REAL on-chain execution every ${Math.round(periodMs / 1000)}s`,
  );
}

/** Stop the live worker interval (graceful shutdown). Idempotent. */
export function stopClvSwapLiveWorker(): void {
  if (liveWorkerTimer) {
    clearInterval(liveWorkerTimer);
    liveWorkerTimer = null;
  }
}
