/**
 * x402 / PayAI verify→settle PRIMITIVE — the reusable real-money boundary.
 *
 * x402/PayAI is the ONLY place USDC/SOL touches ClawVille; everything internal
 * settles in ClawTokens (CT) via `claw-token-ledger`. This module is the thin,
 * dependency-light wrapper every payment surface reuses:
 *
 *   - `buildTopupQuote()`  → an x402 v2 `PaymentRequirements` set the route
 *     returns inside a 402 challenge (base64 `PAYMENT-REQUIRED` header).
 *   - `verifyAndSettle()`  → drives the facilitator `/verify` then (only on
 *     isValid) `/settle`, returning a normalized `{settled, txSignature, …}`.
 *   - `usdToCt()`          → the single one-way store buy-price (1 USDC = 10 vCLAW,
 *     i.e. $0.10 per coin; $10 = 100 vCLAW). This is a BUY price only — vCLAW is
 *     never redeemed back through here (BOUGHT is non-cashable; cash-out is the
 *     separate EARNED→CLV path).
 *
 * `payTo` is a PARAMETER on `buildTopupQuote` so the SAME primitive serves both
 * the USDC→CT on-ramp (Phase A — merchant pubkey) AND a future partner direct-
 * USDC settlement (Phase D — partner payoutPubkey). We never sign or custody on
 * our side: the facilitator (PayAI in prod, the mock in tests) performs the
 * on-chain verify+settle; we only orchestrate the two HTTP calls through the
 * official `@x402/core` `HTTPFacilitatorClient` (permissive Apache-2.0 — we do
 * NOT import the Proprietary `@payai/*` SDK; the facilitator is plain HTTP).
 *
 * SAFETY CONTRACT (money path — every caller depends on these):
 *   1. `verifyAndSettle` NEVER throws on a facilitator 4xx/5xx or a malformed
 *      payment header — it returns `{settled:false, …}` so the ROUTE maps the
 *      outcome to a clean 4xx and NEVER leaks a 5xx (and never half-credits).
 *   2. We settle ONLY when `/verify` returned `isValid:true`. A failed verify
 *      short-circuits — `/settle` is never called, so no on-chain move happens.
 *   3. `settled:true` is returned ONLY when `/settle` reported `success:true`
 *      AND produced a non-empty `transaction` (the tx signature). A success with
 *      an empty signature is treated as NOT settled — the route's double-credit
 *      guard keys on the signature, so a blank one must never credit CT.
 */

import { HTTPFacilitatorClient } from '@x402/core/server';
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
} from '@x402/core/types';
import { loadX402Config } from './x402-config';

// ---------------------------------------------------------------------------
// Network + asset constants (CAIP-2 + USDC SPL mints)
// ---------------------------------------------------------------------------

/** CAIP-2 network id is a `namespace:reference` template (x402 v2 typing). */
type Caip2 = `${string}:${string}`;

/** Solana mainnet-beta CAIP-2 (genesis-hash prefix). PayAI advertises this. */
export const SOLANA_MAINNET_CAIP2: Caip2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
/** Solana devnet CAIP-2. Devnet-first per the plan; this is the DEFAULT. */
export const SOLANA_DEVNET_CAIP2: Caip2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/** Circle USDC SPL mint — mainnet. */
export const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Circle USDC SPL mint — devnet. */
export const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/** USDC has 6 decimals — 1 USDC = 1_000_000 atomic units (micro-USDC). */
const USDC_DECIMALS = 6;
const USDC_ATOMIC_PER_UNIT = 10 ** USDC_DECIMALS; // 1_000_000

/** Network discriminator used by callers + this module. */
export type X402Network = 'devnet' | 'mainnet';
/** Asset the on-ramp accepts. USDC-ONLY today. `sol` was previously accepted at
 *  the route boundary but `buildTopupQuote` ALWAYS quotes the USDC SPL mint (the
 *  SVM exact scheme settles SPL tokens; native-SOL support is a later facilitator
 *  capability), so a caller paying `sol` would have been mis-quoted the USDC mint.
 *  Until native-SOL settlement exists, `sol` is rejected at every route boundary
 *  (zod `z.enum(['usdc'])`) and the type is narrowed to `'usdc'` so a stray `sol`
 *  can never type-check its way back into the quote path. When native SOL lands,
 *  widen this union AND branch the mint in `buildTopupQuote` in the same diff. */
export type X402Asset = 'usdc';

/** Resolve the CAIP-2 network id for a discriminator. */
export function caip2ForNetwork(network: X402Network): Caip2 {
  return network === 'mainnet' ? SOLANA_MAINNET_CAIP2 : SOLANA_DEVNET_CAIP2;
}

/** Resolve the USDC SPL mint for a discriminator. */
export function usdcMintForNetwork(network: X402Network): string {
  return network === 'mainnet' ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;
}

// ---------------------------------------------------------------------------
// Conversion rate — the SINGLE source of truth (used by service + route)
// ---------------------------------------------------------------------------

/**
 * vCLAW (ClawTokens) minted per 1 USDC at the one-way store buy-price.
 *
 * Tokenomics A3 (¢-peg redenomination, founder decision 2026-07-07): the store
 * price is $1 = 100 vCLAW = $0.01 per coin, so 1 USDC buys 100 vCLAW. (Was 10 at
 * the F2 $0.10/coin rate; the ×10 redenomination migration `0011` multiplied ALL
 * CT balances + purchasing-power-preserving prices in lockstep, so nothing
 * changed in USD terms — a coin is now worth 1¢ and there are 10× as many of them.)
 *
 * This is a ONE-WAY BUY price, NOT a peg and NOT a redeem rate: BOUGHT vCLAW is
 * non-cashable (V-Bucks — you bought spend power, not a withdrawal right). The
 * cashable path (EARNED→CLV at live market) is entirely separate and never uses
 * this constant. Changing this number only changes how many coins a buyer gets;
 * it can never make BOUGHT redeemable. The SINGLE source of truth for the rate.
 */
export const CT_PER_USDC = 100;

/**
 * Convert a USD amount (in integer cents) to vCLAW. vCLAW is an INTEGER currency
 * (the ledger rejects non-integers), so we floor — a fractional cent can never
 * mint a fractional coin. Throws on a non-finite / non-positive / non-integer
 * cents value so a bad quote can never reach a credit.
 *
 *   100 cents  (=$1  = 1 USDC)  → 100 vCLAW.
 *   1000 cents (=$10 = 10 USDC) → 1000 vCLAW.  (the headline store price)
 */
export function usdToCt(usdCents: number): number {
  if (!Number.isInteger(usdCents) || usdCents <= 0) {
    throw new Error(`usdToCt: usdCents must be a positive integer, got ${usdCents}`);
  }
  // cents → dollars (÷100) → vCLAW (×CT_PER_USDC). With CT_PER_USDC=100 this yields
  // $0.01/coin (the ¢-peg). The rate is editable in ONE place (CT_PER_USDC).
  // floor() guards any future non-divisible rate (e.g. an odd-cent amount).
  return Math.floor((usdCents / 100) * CT_PER_USDC);
}

/**
 * Convert a USD amount (integer cents) to the on-chain atomic USDC `amount`
 * STRING the x402 v2 requirement carries. USDC is 6-decimal, USD is 2-decimal,
 * so 1 cent = 10^4 atomic units. Integer math throughout — no float drift.
 *
 *   1 cent  → "10000"
 *   100 c   → "1000000"  (= 1 USDC)
 */
export function usdCentsToUsdcAtomic(usdCents: number): string {
  if (!Number.isInteger(usdCents) || usdCents <= 0) {
    throw new Error(`usdCentsToUsdcAtomic: usdCents must be a positive integer, got ${usdCents}`);
  }
  // atomic-per-cent = atomic-per-USDC / cents-per-USDC = 1_000_000 / 100 = 10_000
  const atomicPerCent = USDC_ATOMIC_PER_UNIT / 100;
  return String(usdCents * atomicPerCent);
}

// ---------------------------------------------------------------------------
// buildTopupQuote — produce the x402 v2 PaymentRequirements (the 402 body)
// ---------------------------------------------------------------------------

export interface BuildTopupQuoteInput {
  /** Recipient pubkey. On-ramp = merchant wallet; Phase D = partner payoutPubkey. */
  payTo: string;
  /** Asset the buyer pays. `usdc` is the funded Phase A path. */
  asset: X402Asset;
  /** USD amount in integer cents (the size of the top-up). */
  usdCents: number;
  /** Solana network — devnet by default (devnet-first). */
  network: X402Network;
  /** Resource URL/description echoed in the 402 (the thing being paid for). */
  resource?: { url: string; description?: string };
  /** Facilitator settle deadline. Default 120s (matches PayAI gasless settle). */
  maxTimeoutSeconds?: number;
  /**
   * The facilitator's gas fee-payer pubkey, surfaced in `extra.feePayer`.
   * REQUIRED by real SVM facilitators (PayAI /verify hard-rejects requirements
   * without it: 400 `missing_fee_payer` — live-probed 2026-07-03) AND by the
   * @x402/svm exact CLIENT (it throws unless `extra.feePayer` is set, because
   * the payment tx must name the facilitator as fee payer for co-signing).
   * Resolve via `resolveFacilitatorFeePayer()` at the route boundary; omitted →
   * `extra` carries no feePayer (the mock facilitator path doesn't need one).
   */
  feePayer?: string;
}

/**
 * The x402 v2 `PaymentRequired` body. We return the WHOLE thing (x402Version +
 * resource + accepts) so the route can base64-encode it into the
 * `PAYMENT-REQUIRED` header AND echo the `accepts[0]` requirement back as the
 * quote the settle step re-validates against.
 */
export interface TopupQuote {
  x402Version: 2;
  resource: { url: string; description?: string };
  accepts: PaymentRequirements[];
}

/**
 * Build an x402 v2 top-up quote. The buyer (human or agent) takes
 * `accepts[0]`, produces a signed payment payload off-chain (their wallet),
 * and re-submits with the payment header; the settle route re-derives the SAME
 * requirements deterministically (NOT trusting the client's echoed `accepted`)
 * and hands BOTH to `verifyAndSettle`.
 *
 * `payTo` is the trust anchor: the facilitator only settles a payment whose
 * on-chain recipient matches this. Mismatched/forged requirements therefore
 * cannot credit — verify fails at the facilitator.
 */
export function buildTopupQuote(input: BuildTopupQuoteInput): TopupQuote {
  const { payTo, asset, usdCents, network } = input;
  if (!payTo || typeof payTo !== 'string') {
    throw new Error('buildTopupQuote: payTo (recipient pubkey) is required');
  }
  // Validates cents up front (throws on bad input) — a quote can never carry a
  // non-positive / non-integer amount into the wire.
  const amount = usdCentsToUsdcAtomic(usdCents);

  // USDC-only today (`asset` is narrowed to `'usdc'`): the asset is the USDC mint
  // for the network, settled on the SPL exact scheme. When native-SOL support
  // lands, widen X402Asset and branch the mint here on `asset`.
  const assetMint = usdcMintForNetwork(network);
  const caip2 = caip2ForNetwork(network);

  const requirement: PaymentRequirements = {
    scheme: 'exact',
    network: caip2,
    amount,
    asset: assetMint,
    payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? 120,
    // Provenance the facilitator/scheme may read; harmless to honest flows.
    // feePayer (when resolved) is the facilitator's gas signer — the SVM exact
    // scheme requires it in BOTH the client's signing input and the server-side
    // requirements the facilitator re-validates (missing → 400 missing_fee_payer).
    extra: {
      railAsset: asset,
      usdCents,
      ...(input.feePayer ? { feePayer: input.feePayer } : {}),
    },
  };

  return {
    x402Version: 2,
    resource: input.resource ?? {
      url: '/api/ct/topup',
      description: `Buy ${usdToCt(usdCents)} ClawTokens for $${(usdCents / 100).toFixed(2)} ${asset.toUpperCase()}`,
    },
    accepts: [requirement],
  };
}

// ---------------------------------------------------------------------------
// resolveFacilitatorFeePayer — the facilitator's gas signer for SVM payments
// ---------------------------------------------------------------------------

/** Memoized /supported feePayer per (facilitatorUrl, caip2). TTL keeps quote
 *  and settle inside one window agreeing on the same signer while still
 *  following a facilitator key rotation eventually. */
let _feePayerCache: {
  url: string;
  caip2: string;
  feePayer: string;
  fetchedAt: number;
} | null = null;
const FEE_PAYER_TTL_MS = 5 * 60_000;

/**
 * Resolve the facilitator's fee-payer pubkey for `network`, for injection into
 * `buildTopupQuote({ feePayer })`. Real SVM facilitators publish it in
 * `GET /supported` → `kinds[].extra.feePayer` (PayAI: one stable signer for
 * both mainnet + devnet); the SVM exact scheme REQUIRES it in
 * `requirements.extra.feePayer` (PayAI /verify → 400 `missing_fee_payer`
 * without it) and the paying client needs it to build the co-signable tx.
 *
 * Order: `X402_FEE_PAYER` env override (ops escape hatch / pin) → memoized
 * `/supported` lookup (5-min TTL) → null. NEVER throws; null = omit feePayer
 * (the mock facilitator path neither publishes nor requires one).
 */
/** A Solana pubkey is base58 of 32 bytes → 32-44 base58 chars. Anything else
 *  (Codex MED: a compromised facilitator injecting megabytes into our 402
 *  header, or a typo'd env override) is REJECTED to null, never propagated. */
const BASE58_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function asValidFeePayer(value: unknown): string | null {
  return typeof value === 'string' && BASE58_PUBKEY_RE.test(value) ? value : null;
}

export async function resolveFacilitatorFeePayer(
  network: X402Network,
): Promise<string | null> {
  // WHOLE body is throw-contained (Codex MED: loadX402Config() throws when
  // X402_ENABLED=true without a merchant pubkey — the partner path doesn't need
  // the merchant wallet, so a config throw here must degrade to null, not a 500).
  try {
    const override = asValidFeePayer(process.env.X402_FEE_PAYER?.trim());
    if (override) return override;
    if (process.env.X402_FEE_PAYER?.trim()) {
      console.warn('[x402-payai] X402_FEE_PAYER is set but not a base58 pubkey — ignoring');
    }

    const { facilitatorUrl } = loadX402Config();
    if (!facilitatorUrl) return null;
    const caip2 = caip2ForNetwork(network);

    if (
      _feePayerCache &&
      _feePayerCache.url === facilitatorUrl &&
      _feePayerCache.caip2 === caip2 &&
      Date.now() - _feePayerCache.fetchedAt < FEE_PAYER_TTL_MS
    ) {
      return _feePayerCache.feePayer;
    }

    const res = await fetch(`${facilitatorUrl}/supported`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      kinds?: Array<{
        scheme?: string;
        network?: string;
        extra?: { feePayer?: unknown };
      }>;
    };
    const hit = body?.kinds?.find(
      (k) =>
        k?.scheme === 'exact' &&
        k?.network === caip2 &&
        asValidFeePayer(k?.extra?.feePayer) !== null,
    );
    if (!hit) return null;
    const feePayer = asValidFeePayer(hit.extra?.feePayer)!;
    _feePayerCache = { url: facilitatorUrl, caip2, feePayer, fetchedAt: Date.now() };
    return feePayer;
  } catch {
    // Unreachable facilitator / bad JSON / timeout / config throw — fail-open to
    // "no feePayer" (verify fails cleanly downstream if the facilitator needs one).
    return null;
  }
}

// ---------------------------------------------------------------------------
// verifyAndSettle — the verify→(only-on-valid)settle orchestration
// ---------------------------------------------------------------------------

export interface VerifyAndSettleInput {
  /** The base64(JSON) payment header the buyer submitted (PAYMENT-SIGNATURE / X-PAYMENT). */
  paymentHeader: string;
  /** The requirements the quote issued (server-derived, NOT the client echo). */
  requirements: PaymentRequirements;
  /**
   * VERIFY-ONLY mode (the SAP_DRY_RUN analog for the PayAI settlement rail):
   * run the facilitator `/verify` and STOP — `/settle` is NEVER called, so no
   * on-chain money can move. The result is ALWAYS `settled:false`; a passing
   * verify carries `isValid:true` + `failureReason:'verify_only_mode'` so a
   * caller can distinguish "dry-run verified OK" from a real failure. The
   * safety contract is unchanged: `settled:true` still ONLY ever means a real
   * facilitator settle succeeded with a non-empty signature.
   */
  verifyOnly?: boolean;
}

export interface VerifyAndSettleResult {
  /** True ONLY when verify isValid AND settle success AND a non-empty txSignature. */
  settled: boolean;
  /** The facilitator verify verdict (false on any verify failure / decode error). */
  isValid: boolean;
  /** The settled Solana tx signature, or null when not settled. */
  txSignature: string | null;
  /** The CAIP-2 network the settlement reported (echoed from settle, else null). */
  network: string | null;
  /** The buyer pubkey the facilitator resolved (best-effort, for audit). */
  payer: string | null;
  /** A short machine reason when NOT settled (for the route's clean 4xx body). */
  failureReason: string | null;
  /** Raw verify/settle responses for logging — never surfaced to the agent. */
  raw: { verify?: VerifyResponse; settle?: SettleResponse };
}

/** Lazily-built facilitator client, memoized by resolved URL (so a URL change
 *  in tests / between presets rebuilds it). The HTTPFacilitatorClient is a thin
 *  HTTP wrapper — cheap to construct, but we avoid per-call allocation. */
let _cachedClient: { url: string; client: HTTPFacilitatorClient } | null = null;
function facilitatorClient(): HTTPFacilitatorClient {
  const { facilitatorUrl } = loadX402Config();
  if (!facilitatorUrl) {
    throw new Error('[x402-payai] facilitator URL is empty — check X402_FACILITATOR_* env');
  }
  if (!_cachedClient || _cachedClient.url !== facilitatorUrl) {
    _cachedClient = { url: facilitatorUrl, client: new HTTPFacilitatorClient({ url: facilitatorUrl }) };
  }
  return _cachedClient.client;
}

/** Decode the base64(JSON) payment header into an x402 PaymentPayload. Returns
 *  null on any malformed input (the route maps null → clean 402, never a 5xx). */
function decodePaymentHeader(headerValue: string): PaymentPayload | null {
  if (!headerValue || typeof headerValue !== 'string') return null;
  try {
    const json = Buffer.from(headerValue, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as PaymentPayload;
  } catch {
    return null;
  }
}

const failed = (
  reason: string,
  extra?: Partial<VerifyAndSettleResult>,
): VerifyAndSettleResult => ({
  settled: false,
  isValid: false,
  txSignature: null,
  network: null,
  payer: null,
  failureReason: reason,
  raw: {},
  ...extra,
});

/**
 * Verify a submitted payment against `requirements`, and ONLY if valid, settle
 * it. Never throws on a facilitator/network/decoding error — always resolves to
 * a `VerifyAndSettleResult` the route maps to a clean status.
 *
 * Order of operations (each step can only WEAKEN the outcome, never skip a
 * guard):
 *   1. decode the header → PaymentPayload (null → fail, no facilitator call).
 *   2. facilitator.verify(payload, requirements) — wrapped in try/catch; a
 *      throw or `isValid:false` → fail, settle NEVER runs (credit-before-settle
 *      is structurally impossible).
 *   3. facilitator.settle(payload, requirements) — wrapped in try/catch; a
 *      throw or `success:false` or empty `transaction` → fail (no signature ⇒
 *      the route can't credit).
 *   4. settled:true with the signature only when all three pass.
 */
export async function verifyAndSettle(
  input: VerifyAndSettleInput,
): Promise<VerifyAndSettleResult> {
  const { paymentHeader, requirements } = input;

  const payload = decodePaymentHeader(paymentHeader);
  if (!payload) {
    return failed('malformed_payment_header');
  }

  // Build the facilitator client INSIDE the never-throw contract. `facilitatorClient()`
  // calls `loadX402Config()`, which THROWS when `X402_ENABLED=true` but the merchant
  // pubkey is missing (x402-config.ts), and could throw on a future config error. Left
  // unguarded that throw would propagate out of verifyAndSettle and the route would map
  // it to a 5xx — violating the documented "verifyAndSettle NEVER throws" safety contract
  // (callers depend on a clean 4xx). Catch it → a normal failed() result so the route
  // returns a clean 402, never a 500.
  let client: HTTPFacilitatorClient;
  try {
    client = facilitatorClient();
  } catch (err) {
    console.warn('[x402-payai] facilitatorClient() threw (config error, treated as fail):', (err as Error).message);
    return failed('facilitator_config_error');
  }

  // --- 1) verify -----------------------------------------------------------
  let verify: VerifyResponse;
  try {
    verify = await client.verify(payload, requirements);
  } catch (err) {
    // Facilitator 4xx/5xx or network error during verify. Clean fail — NO settle.
    console.warn('[x402-payai] verify threw (treated as invalid):', (err as Error).message);
    return failed('facilitator_verify_error');
  }

  if (!verify || verify.isValid !== true) {
    return failed(verify?.invalidReason ?? 'payment_invalid', {
      isValid: false,
      payer: verify?.payer ?? null,
      raw: { verify },
    });
  }

  // --- 1b) verify-only short-circuit (dry-run posture) ----------------------
  // The caller asked for verification WITHOUT settlement. `/settle` is never
  // called; no money moves. `settled` stays false (the safety contract), with
  // `isValid:true` + the sentinel reason marking a PASSING verify-only run.
  if (input.verifyOnly === true) {
    return failed('verify_only_mode', {
      isValid: true,
      payer: verify.payer ?? null,
      raw: { verify },
    });
  }

  // --- 2) settle (only reached when verify.isValid === true) ---------------
  let settle: SettleResponse;
  try {
    settle = await client.settle(payload, requirements);
  } catch (err) {
    // Verify passed but settle errored — NOT settled, no signature ⇒ no credit.
    console.warn('[x402-payai] settle threw (treated as unsettled):', (err as Error).message);
    return failed('facilitator_settle_error', {
      isValid: true,
      payer: verify.payer ?? null,
      raw: { verify },
    });
  }

  const txSignature =
    typeof settle?.transaction === 'string' && settle.transaction.length > 0
      ? settle.transaction
      : null;

  if (settle?.success !== true || !txSignature) {
    // Facilitator reported a settlement failure OR an empty signature. The
    // empty-signature guard matters: the route's double-credit guard keys on
    // the signature, so a blank one must NEVER be allowed to credit.
    return failed(settle?.errorReason ?? 'settlement_failed', {
      isValid: true,
      payer: settle?.payer ?? verify.payer ?? null,
      network: settle?.network ?? null,
      raw: { verify, settle },
    });
  }

  return {
    settled: true,
    isValid: true,
    txSignature,
    network: settle.network ?? requirements.network ?? null,
    payer: settle.payer ?? verify.payer ?? null,
    failureReason: null,
    raw: { verify, settle },
  };
}

// ---------------------------------------------------------------------------
// Phase D — partner direct-USDC settlement (buyer → PARTNER, NO custody, NO CT)
// ---------------------------------------------------------------------------
//
// The on-ramp above credits CT because the buyer pays OUR merchant wallet. Phase
// D is the OPPOSITE money shape: the buyer pays the PARTNER's OWN Solana wallet
// DIRECTLY for a partner-provided service. ClawVille NEVER custodies those funds
// and NEVER credits a single ClawToken for them — we are only the x402 quoting +
// verify/settle orchestrator between the buyer and the partner.
//
// These are DELIBERATELY THIN wrappers over the SAME audited primitives above
// (`buildTopupQuote` + `verifyAndSettle`), NOT a parallel money path. Reusing
// them means the on-ramp's whole safety contract carries over for free:
//   - verify→(only-on-valid)-settle ordering (no credit-before-settle),
//   - `verifyAndSettle` NEVER throws (facilitator/config/decoding errors resolve
//     to `{settled:false}` so the route maps a clean 4xx, never a leaked 5xx),
//   - `settled:true` requires a NON-EMPTY tx signature (a blank-signature settle
//     is treated as unsettled).
// The ONLY thing that differs is the recipient (`payTo` = the partner's payout
// pubkey, never our merchant/treasury wallet) and a defense-in-depth recipient
// binding on the settle call (below). They were previously removed as inert; they
// are re-introduced now because `impl-route` WIRES them behind a FEATURE_GATE, so
// the "no scaffolding theater" policy is satisfied.

export interface BuildPartnerPurchaseQuoteInput {
  /** Partner's OWN Solana pubkey — buyer pays THIS directly. NEVER our merchant/treasury wallet. */
  payoutPubkey: string;
  asset: X402Asset;
  usdCents: number;
  network: X402Network;
  resource?: { url: string; description?: string };
  maxTimeoutSeconds?: number;
  /** Facilitator gas signer — same contract as `BuildTopupQuoteInput.feePayer`. */
  feePayer?: string;
}

/**
 * Build an x402 v2 quote for a DIRECT buyer→partner USDC purchase. Reuses
 * `buildTopupQuote` — the partner `payoutPubkey` flows straight into its
 * already-parameterized `payTo`, so the facilitator only settles a payment whose
 * on-chain recipient is the partner. Nothing here credits CT.
 */
export function buildPartnerPurchaseQuote(input: BuildPartnerPurchaseQuoteInput): TopupQuote {
  // Reuses buildTopupQuote — payoutPubkey flows into its already-parameterized payTo.
  return buildTopupQuote({
    payTo: input.payoutPubkey,
    asset: input.asset,
    usdCents: input.usdCents,
    network: input.network,
    resource: input.resource ?? {
      url: '/api/partner/storefront/purchase',
      description: `Partner service — $${(input.usdCents / 100).toFixed(2)} ${input.asset.toUpperCase()} (paid directly to the partner)`,
    },
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    feePayer: input.feePayer,
  });
}

export interface SettlePartnerPurchaseInput extends VerifyAndSettleInput {
  /** The partner payout pubkey the payment MUST be paying — the NO-CUSTODY binding. */
  expectedPayoutPubkey: string;
}

/**
 * Verify+settle a DIRECT buyer→partner USDC payment. Thin wrapper over the same
 * audited `verifyAndSettle`, with ONE extra guard: a NO-CUSTODY recipient binding.
 * Credits ZERO CT (this function never touches the ledger).
 */
export async function settlePartnerPurchase(
  input: SettlePartnerPurchaseInput,
): Promise<VerifyAndSettleResult> {
  // NO-CUSTODY / recipient binding (defense in depth): refuse to even CALL the
  // facilitator unless the server-derived requirements pay the partner's payout
  // pubkey. A mismatch means the caller mis-bound payTo (e.g. to our merchant
  // wallet) — settle NOTHING. Never throws (mirrors verifyAndSettle's contract).
  if (!input.expectedPayoutPubkey || input.requirements.payTo !== input.expectedPayoutPubkey) {
    return failed('payout_binding_mismatch');
  }
  return verifyAndSettle({ paymentHeader: input.paymentHeader, requirements: input.requirements });
}
