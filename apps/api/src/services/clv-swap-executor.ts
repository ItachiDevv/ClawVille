/**
 * CLV SWAP EXECUTOR (Tokenomics C3, 2026-07-07) — the shared buy-queue seam +
 * a DRY-RUN-ONLY clip planner/worker. NO live DEX execution exists here.
 *
 * WHAT THIS IS
 *   The whole tokenomics spine (checkout USDC splits, marketplace fee routing —
 *   the stages built after this one) owes the market CLV buys. This module is
 *   the ONE seam they all call:
 *
 *     - `enqueueClvBuy(input, tx?)` — record ONE owed buy as a `clv_buy_queue`
 *       row (status='planned'), stamping the oracle's current house-favorable
 *       quote. Composable into the caller's settle transaction via the SAME
 *       `LedgerTx` type `claw-token-ledger.ts` uses (pass the tx ⇒ the intent
 *       row commits/rolls back atomically WITH the settle; omit ⇒ own tx).
 *       It does NO CT-ledger write and NO on-chain action — it records INTENT.
 *
 *     - `planClips(...)` — PURE price-impact math: split a queued USD amount
 *       into clips small enough that each moves the thin CLV pool ≤ the impact
 *       cap. Constant-product approximation: a buy of ΔUSD against one-side
 *       depth D moves price ≈ ΔUSD/D, so the per-clip cap is
 *       `p × oneSideDepth` where `oneSideDepth ≈ poolLiquidityUsd / 2` and `p`
 *       = `maxImpactBps/10_000` (default 1%). Clip sizes round DOWN to µUSD
 *       (house-favorable — never a clip that overshoots the cap by rounding
 *       up); the µUSD sum of the clips equals the queued amount exactly.
 *
 *     - the DRY-RUN worker — periodically reads `status='planned'` rows, logs
 *       the clip plan it WOULD execute (oracle quote + LP depth + planClips),
 *       and marks NOTHING executed. NO signing, NO tx, NO row mutation.
 *
 *     - `getClvSwapWalletPubkey()` — READ-ONLY pubkey lookup of the ONE
 *       `treasury_wallets` row purpose='clv-swap' (provisioned by
 *       `scripts/generate-clv-swap-wallet.ts`). The dry-run NEVER touches the
 *       encrypted secret.
 *
 * HARD GATE — LIVE EXECUTION IS CODEX-REVIEW-GATED
 *   `CLV_SWAP_EXECUTE` must NEVER be 'true'. It is checked at MODULE LOAD
 *   (this file is on index.ts's static import graph, so a box carrying the
 *   flag refuses to boot — the x402-config mock-facilitator crash-loud
 *   pattern), at worker start, and on every tick. Real swap execution (wallet
 *   decrypt → Jupiter/DEX route → sign → send) lands ONLY behind a Codex
 *   review; see the `CODEX-GATED SEAM` marker in `dryRunTick`.
 *
 * MONEY DISCIPLINE
 *   Every value here is a USD DECIMAL (µUSD precision via BigInt) — NEVER a
 *   ClawToken amount. This module never imports credit/debit and never writes
 *   `avatars.clawTokens`.
 */

import { db, clvBuyQueue, treasuryWallets, eq, asc, desc } from '@clawville/database';
import { getClvPrice } from './clv-price-oracle';
import type { LedgerTx } from './claw-token-ledger';

// Re-export so downstream stages (checkout, marketplace) can import the settle
// transaction type from the seam they already depend on.
export type { LedgerTx };

// ---------------------------------------------------------------------------
// HARD GATE — refuse to run with live execution flagged on
// ---------------------------------------------------------------------------

const EXECUTE_GATE_MESSAGE =
  'CLV_SWAP_EXECUTE=true but live CLV swap execution is Codex-review-gated — refusing to execute';

/**
 * Throws when `CLV_SWAP_EXECUTE` is 'true'. Called at module load (crash-loud
 * boot refusal — this module is statically imported by index.ts), at
 * `startClvSwapWorker()`, and at the top of every dry-run tick.
 */
export function assertNoLiveClvSwapExecution(): void {
  if (process.env.CLV_SWAP_EXECUTE === 'true') {
    throw new Error(EXECUTE_GATE_MESSAGE);
  }
}
assertNoLiveClvSwapExecution();

// ---------------------------------------------------------------------------
// Env resolvers (floored/clamped so a mis-set value can't produce absurd math)
// ---------------------------------------------------------------------------

/** Default per-clip price-impact cap: 100 bps = 1%. */
export const DEFAULT_MAX_IMPACT_BPS = 100;
/** Default spacing between clips in a plan (dry-run: informational only). */
export const DEFAULT_CLIP_SPACING_MS = 60_000;
const DEFAULT_WORKER_POLL_MS = 300_000; // 5 min
const MIN_WORKER_POLL_MS = 30_000;
/** Total-function guard: refuse plans that would explode into absurd clip counts. */
const MAX_PLANNED_CLIPS = 10_000n;

/** `CLV_SWAP_MAX_IMPACT_BPS` — integer bps, floor 1 (spec), cap 10_000 (=100%). */
export function resolveClvSwapMaxImpactBps(): number {
  const raw = process.env.CLV_SWAP_MAX_IMPACT_BPS;
  if (!raw) return DEFAULT_MAX_IMPACT_BPS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_IMPACT_BPS;
  return Math.min(Math.max(1, n), 10_000);
}

/** `CLV_SWAP_CLIP_SPACING_MS` — floor 1s. */
export function resolveClvSwapClipSpacingMs(): number {
  const raw = process.env.CLV_SWAP_CLIP_SPACING_MS;
  if (!raw) return DEFAULT_CLIP_SPACING_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1_000) return DEFAULT_CLIP_SPACING_MS;
  return n;
}

/** `CLV_SWAP_POLL_MS` — dry-run worker tick, floor 30s. */
function resolveWorkerPollMs(): number {
  const raw = process.env.CLV_SWAP_POLL_MS;
  if (!raw) return DEFAULT_WORKER_POLL_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_WORKER_POLL_MS) return DEFAULT_WORKER_POLL_MS;
  return n;
}

// ---------------------------------------------------------------------------
// µUSD decimal-string helpers (BigInt — no float drift on money strings)
// ---------------------------------------------------------------------------

/**
 * Positive plain decimal, ≤ 6 fractional digits (µUSD), ≤ 14 integer digits
 * (numeric(20,6) headroom), and not all-zero. No exponents, no signs.
 */
const AMOUNT_USDC_RE = /^(?!0+(?:\.0*)?$)\d{1,14}(?:\.\d{1,6})?$/;

/** Parse a validated decimal string to integer µUSD. null on invalid input. */
function usdcToMicro(amount: string): bigint | null {
  if (typeof amount !== 'string' || !AMOUNT_USDC_RE.test(amount)) return null;
  const [ints, frac = ''] = amount.split('.');
  return BigInt(ints) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

/** Render integer µUSD back to a plain 6-dp decimal string. */
function microToUsdc(micro: bigint): string {
  const ints = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0');
  return `${ints}.${frac}`;
}

// ---------------------------------------------------------------------------
// enqueueClvBuy — THE seam the spine calls inside a settle tx
// ---------------------------------------------------------------------------

export interface EnqueueClvBuyInput {
  /** Owed buy size as a positive decimal string (µUSD precision, e.g. "12.500000"). */
  amountUsdc: string;
  /** Why this buy is owed — e.g. 'checkout_clv_leg'. Non-empty. */
  reason: string;
  /** Originating row/tx reference (topupId, order id, ledger id, …). Non-empty. */
  sourceRef: string;
  metadata?: Record<string, unknown>;
}

/**
 * Record ONE owed CLV buy as a `clv_buy_queue` row (status='planned'), stamping
 * the oracle's current `getClvPrice().quoteUsd` as `quoted_price` (NULL when
 * the oracle has no usable quote — the intent is still recorded).
 *
 * Pass the caller's `LedgerTx` to compose into a settle transaction (the intent
 * row commits/rolls back atomically WITH the settle); omit ⇒ own transaction.
 *
 * Does NO CT-ledger write and NO on-chain action. Throws on invalid input
 * (non-positive / NaN / non-decimal amount, empty reason/sourceRef) BEFORE any
 * DB touch, so a bad caller can never persist a malformed intent.
 */
export async function enqueueClvBuy(
  input: EnqueueClvBuyInput,
  tx?: LedgerTx,
): Promise<{ queueId: string }> {
  const amount = typeof input.amountUsdc === 'string' ? input.amountUsdc.trim() : '';
  if (usdcToMicro(amount) === null) {
    throw new Error(
      `[clv-swap] enqueueClvBuy: amountUsdc must be a positive decimal string ` +
        `(≤6 fractional digits, ≤14 integer digits), got ${JSON.stringify(input.amountUsdc)}`,
    );
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length === 0) {
    throw new Error('[clv-swap] enqueueClvBuy: reason is required (non-empty string)');
  }
  const sourceRef = typeof input.sourceRef === 'string' ? input.sourceRef.trim() : '';
  if (sourceRef.length === 0) {
    throw new Error('[clv-swap] enqueueClvBuy: sourceRef is required (non-empty string)');
  }

  // Stamp the CURRENT house-favorable quote (min(spot, 30-min TWAP)) for
  // observability/slippage accounting. Nullable — an oracle outage never
  // blocks recording the intent (the settle that owes the buy must not fail
  // because a price feed hiccuped).
  const quote = getClvPrice();
  const quotedPrice = quote.quoteUsd !== null ? quote.quoteUsd.toFixed(12) : null;

  const insertRow = async (t: LedgerTx): Promise<{ queueId: string }> => {
    const [row] = await t
      .insert(clvBuyQueue)
      .values({
        amountUsdc: amount,
        quotedPrice,
        reason,
        sourceRef,
        metadata: input.metadata ?? {},
      })
      .returning({ id: clvBuyQueue.id });
    if (!row) throw new Error('[clv-swap] enqueueClvBuy: insert returned no row');
    return { queueId: row.id };
  };

  // Mirrors claw-token-ledger's compose-or-own-tx pattern exactly: passing the
  // caller's tx composes; omitting opens a (pooler-durable) own transaction.
  return tx ? insertRow(tx) : db.transaction(insertRow);
}

// ---------------------------------------------------------------------------
// planClips — PURE price-impact clip math (unit-tested)
// ---------------------------------------------------------------------------

export interface PlanClipsInput {
  /** The queued buy size as a positive decimal string (µUSD precision). */
  amountUsdc: string;
  /**
   * Pool depth in USD, BOTH sides (the oracle's `poolLiquidityUsd`). One-side
   * depth ≈ this / 2. null/0/negative/non-finite ⇒ the plan REFUSES.
   */
  poolLiquidityUsd: number | null;
  /** Per-clip price-impact cap in bps. Default 100 (1%); floored to ≥1. */
  maxImpactBps?: number;
  /** Spacing between clips (informational in dry-run). Default 60_000. */
  spacingMs?: number;
}

export interface PlannedClip {
  index: number;
  /** Clip size as a 6-dp decimal string. Always ≤ maxClipUsdc. */
  amountUsdc: string;
}

export type ClipPlanRefusal =
  | 'invalid_amount'
  | 'no_liquidity'
  | 'clip_count_excessive';

export interface ClipPlan {
  ok: boolean;
  refusedReason: ClipPlanRefusal | null;
  /** The intended clips, oldest-first. Empty when refused. */
  clips: PlannedClip[];
  clipCount: number;
  /** Per-clip cap (µUSD-floored — house-favorable). null when refused. */
  maxClipUsdc: string | null;
  /** poolLiquidityUsd / 2 — the constant-product one-side depth. */
  oneSideDepthUsd: number | null;
  /** The impact cap the plan used (sanitized). */
  maxImpactBps: number;
  /** Intended spacing between clips. */
  spacingMs: number;
  /** Echo of the planned total; equals the input amount when ok. */
  totalUsdc: string;
}

const refusedPlan = (
  reason: ClipPlanRefusal,
  ctx: { maxImpactBps: number; spacingMs: number; oneSideDepthUsd?: number | null; totalUsdc?: string },
): ClipPlan => ({
  ok: false,
  refusedReason: reason,
  clips: [],
  clipCount: 0,
  maxClipUsdc: null,
  oneSideDepthUsd: ctx.oneSideDepthUsd ?? null,
  maxImpactBps: ctx.maxImpactBps,
  spacingMs: ctx.spacingMs,
  totalUsdc: ctx.totalUsdc ?? '0.000000',
});

/**
 * Split `amountUsdc` into price-impact-capped clips against the CLV pool.
 *
 * Constant-product approximation: buying ΔUSD against one-side depth D moves
 * the price ≈ ΔUSD/D, so each clip is capped at
 * `maxClip = (maxImpactBps/10_000) × (poolLiquidityUsd/2)`, FLOORED to µUSD
 * (house-favorable — a clip can undershoot the cap, never overshoot it). The
 * plan is `⌈amount/maxClip⌉` clips: full-cap clips plus an exact remainder, so
 * the µUSD sum of the clips equals the queued amount exactly.
 *
 * Degenerate cases REFUSE rather than emit an unsafe plan:
 *   - invalid/non-positive amount            → 'invalid_amount'
 *   - null/0/negative/NaN pool liquidity     → 'no_liquidity'
 *   - a cap that floors to 0 µUSD (dust pool)→ 'no_liquidity'
 *   - > MAX_PLANNED_CLIPS clips              → 'clip_count_excessive'
 *
 * PURE: no env reads, no I/O, deterministic. Callers (the worker) pass the
 * resolved env cap/spacing.
 */
export function planClips(input: PlanClipsInput): ClipPlan {
  const maxImpactBps =
    typeof input.maxImpactBps === 'number' && Number.isFinite(input.maxImpactBps)
      ? Math.min(Math.max(1, Math.floor(input.maxImpactBps)), 10_000)
      : DEFAULT_MAX_IMPACT_BPS;
  const spacingMs =
    typeof input.spacingMs === 'number' && Number.isFinite(input.spacingMs) && input.spacingMs >= 0
      ? Math.floor(input.spacingMs)
      : DEFAULT_CLIP_SPACING_MS;

  const amountMicro = usdcToMicro(
    typeof input.amountUsdc === 'string' ? input.amountUsdc.trim() : '',
  );
  if (amountMicro === null || amountMicro <= 0n) {
    return refusedPlan('invalid_amount', { maxImpactBps, spacingMs });
  }
  const totalUsdc = microToUsdc(amountMicro);

  const liq = input.poolLiquidityUsd;
  if (typeof liq !== 'number' || !Number.isFinite(liq) || liq <= 0) {
    return refusedPlan('no_liquidity', { maxImpactBps, spacingMs, totalUsdc });
  }
  const oneSideDepthUsd = liq / 2;

  // Per-clip cap in µUSD, floored DOWN (house-favorable). Float is safe here:
  // depth × 1e6 stays far under 2^53 for any real pool size.
  const maxClipMicro = BigInt(Math.floor(((oneSideDepthUsd * maxImpactBps) / 10_000) * 1_000_000));
  if (maxClipMicro <= 0n) {
    // The pool is so thin that even the smallest µUSD clip would exceed the
    // impact cap — refuse; there is no safe buy size.
    return refusedPlan('no_liquidity', { maxImpactBps, spacingMs, oneSideDepthUsd, totalUsdc });
  }

  const clipCount = (amountMicro + maxClipMicro - 1n) / maxClipMicro; // ceil
  if (clipCount > MAX_PLANNED_CLIPS) {
    return refusedPlan('clip_count_excessive', {
      maxImpactBps,
      spacingMs,
      oneSideDepthUsd,
      totalUsdc,
    });
  }

  const clips: PlannedClip[] = [];
  let remaining = amountMicro;
  let index = 0;
  while (remaining > 0n) {
    const clip = remaining >= maxClipMicro ? maxClipMicro : remaining;
    clips.push({ index, amountUsdc: microToUsdc(clip) });
    remaining -= clip;
    index += 1;
  }

  return {
    ok: true,
    refusedReason: null,
    clips,
    clipCount: clips.length,
    maxClipUsdc: microToUsdc(maxClipMicro),
    oneSideDepthUsd,
    maxImpactBps,
    spacingMs,
    totalUsdc,
  };
}

// ---------------------------------------------------------------------------
// getClvSwapWalletPubkey — READ-ONLY swap-wallet lookup (never the secret)
// ---------------------------------------------------------------------------

let swapWalletCache: { pubkey: string; at: number } | null = null;
const SWAP_WALLET_CACHE_MS = 5 * 60_000;

/**
 * The base58 pubkey of the dedicated 'clv-swap' treasury wallet (newest row
 * wins if ever rotated), or null when not yet provisioned
 * (`scripts/generate-clv-swap-wallet.ts`). SELECTs ONLY the public key —
 * the encrypted secret is never read here; decrypt/sign is the Codex-gated
 * live-execution seam. Cached 5 min so a fresh provision is picked up without
 * a restart while the worker doesn't re-query every tick.
 */
export async function getClvSwapWalletPubkey(): Promise<string | null> {
  if (swapWalletCache && Date.now() - swapWalletCache.at < SWAP_WALLET_CACHE_MS) {
    return swapWalletCache.pubkey;
  }
  const [row] = await db
    .select({ publicKey: treasuryWallets.publicKey })
    .from(treasuryWallets)
    .where(eq(treasuryWallets.purpose, 'clv-swap'))
    .orderBy(desc(treasuryWallets.createdAt))
    .limit(1);
  if (!row) return null;
  swapWalletCache = { pubkey: row.publicKey, at: Date.now() };
  return row.publicKey;
}

// ---------------------------------------------------------------------------
// The DRY-RUN worker — logs plans, mutates NOTHING
// ---------------------------------------------------------------------------

let workerTimer: ReturnType<typeof setInterval> | null = null;
/** queueId → last logged outcome, so a stable plan isn't re-logged every tick
 *  (log spam) but a CHANGED outcome (liquidity returned, cap changed) is. */
const lastLoggedOutcome = new Map<string, string>();
const LOGGED_OUTCOME_CAP = 10_000;

async function dryRunTick(): Promise<void> {
  // Re-assert the gate EVERY tick — belt-and-suspenders on top of the
  // module-load crash (env can't legitimately change mid-process).
  assertNoLiveClvSwapExecution();

  const rows = await db
    .select({
      id: clvBuyQueue.id,
      amountUsdc: clvBuyQueue.amountUsdc,
      reason: clvBuyQueue.reason,
    })
    .from(clvBuyQueue)
    .where(eq(clvBuyQueue.status, 'planned'))
    .orderBy(asc(clvBuyQueue.createdAt))
    .limit(50);
  if (rows.length === 0) return;

  const quote = getClvPrice();
  const maxImpactBps = resolveClvSwapMaxImpactBps();
  const spacingMs = resolveClvSwapClipSpacingMs();
  const swapWallet = await getClvSwapWalletPubkey();

  let newlyLogged = 0;
  for (const row of rows) {
    const plan = planClips({
      amountUsdc: row.amountUsdc,
      poolLiquidityUsd: quote.poolLiquidityUsd,
      maxImpactBps,
      spacingMs,
    });
    const outcome = plan.ok
      ? `ok:${plan.clipCount}:${plan.maxClipUsdc}`
      : `refused:${plan.refusedReason}`;
    if (lastLoggedOutcome.get(row.id) === outcome) continue;

    if (plan.ok) {
      console.log(
        `[clv-swap:dry-run] queue=${row.id} (${row.reason}) $${plan.totalUsdc} → WOULD execute ` +
          `${plan.clipCount} clip(s) ≤ $${plan.maxClipUsdc} each (impact cap ${plan.maxImpactBps} bps ` +
          `on one-side depth $${plan.oneSideDepthUsd?.toFixed(2)}), spacing ${plan.spacingMs} ms, ` +
          `quote ${quote.quoteUsd ?? 'n/a'} USD/CLV, wallet ${swapWallet ?? 'UNPROVISIONED'} — ` +
          `DRY-RUN: nothing executed, status untouched`,
      );
    } else {
      console.warn(
        `[clv-swap:dry-run] queue=${row.id} (${row.reason}) $${row.amountUsdc} → REFUSED ` +
          `(${plan.refusedReason}; poolLiquidityUsd=${quote.poolLiquidityUsd ?? 'null'}) — ` +
          `DRY-RUN: nothing executed, status untouched`,
      );
    }
    lastLoggedOutcome.set(row.id, outcome);
    newlyLogged += 1;
    // FIFO-cap the outcome memory so the map can't grow unbounded.
    while (lastLoggedOutcome.size > LOGGED_OUTCOME_CAP) {
      const oldest = lastLoggedOutcome.keys().next().value;
      if (oldest === undefined) break;
      lastLoggedOutcome.delete(oldest);
    }
  }
  if (newlyLogged > 0) {
    console.log(
      `[clv-swap:dry-run] ${rows.length} planned row(s) pending; ${newlyLogged} plan(s) (re)logged this tick.`,
    );
  }

  // CODEX-GATED SEAM: live execution. A LATER, Codex-reviewed slice would — for
  // each planned row, ONLY when CLV_SWAP_EXECUTE clears review and this gate is
  // redesigned — load the 'clv-swap' treasury keypair (decryptSecretKey via
  // keypair-vault, never logged), route each planClips clip through a DEX
  // aggregator (Jupiter) honoring maxClipUsdc + spacingMs + max_slippage,
  // send + confirm each swap tx, and flip the row planned→executed (or
  // →skipped) with the fill breakdown in metadata. v1 DELIBERATELY stops at
  // the log line above: no key is decrypted, no tx is built, no row mutates.
}

/**
 * Start the DRY-RUN worker (idempotent). Refuses (throws) if
 * `CLV_SWAP_EXECUTE=true` — same message as the module-load gate. A tick
 * failure (DB/oracle hiccup) logs and retries next interval; it never crashes
 * the process.
 */
export function startClvSwapWorker(): void {
  assertNoLiveClvSwapExecution();
  if (workerTimer) return;
  const periodMs = resolveWorkerPollMs();

  workerTimer = setInterval(() => {
    dryRunTick().catch((err) => {
      console.error('[clv-swap] dry-run tick failed (non-fatal):', err);
    });
  }, periodMs);
  // First pass shortly after boot (detached) so a queued backlog is visible
  // without waiting a full interval.
  void dryRunTick().catch((err) => {
    console.error('[clv-swap] first dry-run tick failed (non-fatal):', err);
  });

  console.log(
    `[clv-swap] DRY-RUN worker started — scanning clv_buy_queue every ${Math.round(periodMs / 1000)}s ` +
      `(impact cap ${resolveClvSwapMaxImpactBps()} bps; CLV_SWAP_EXECUTE is hard-gated OFF; no execution)`,
  );
}

/** Stop the worker interval (graceful shutdown). Idempotent. */
export function stopClvSwapWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
