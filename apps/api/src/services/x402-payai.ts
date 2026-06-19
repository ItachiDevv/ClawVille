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
 *   - `usdToCt()`          → the single conversion rate (1 USDC = 100 CT).
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
/** Asset the on-ramp accepts. `sol` is reserved (the SVM exact scheme settles
 *  SPL tokens; native-SOL support is a later facilitator capability) — we map
 *  it to the same network's quote but currently price it as USDC-equivalent for
 *  the quote surface. Phase A ships `usdc` as the funded path. */
export type X402Asset = 'usdc' | 'sol';

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

/** ClawTokens minted per 1 USDC. Q3 plan §6.C2: 1 USDC = 100 CT. */
export const CT_PER_USDC = 100;

/**
 * Convert a USD amount (in integer cents) to ClawTokens. CT is an INTEGER
 * currency (the ledger rejects non-integers), so we floor — a fractional cent
 * can never mint a fractional CT. Throws on a non-finite / non-positive /
 * non-integer cents value so a bad quote can never reach a credit.
 *
 *   100 cents (=$1 = 1 USDC) → 100 CT.
 */
export function usdToCt(usdCents: number): number {
  if (!Number.isInteger(usdCents) || usdCents <= 0) {
    throw new Error(`usdToCt: usdCents must be a positive integer, got ${usdCents}`);
  }
  // cents → dollars (÷100) → CT (×CT_PER_USDC). With CT_PER_USDC=100 this is a
  // 1:1 cents↔CT mapping, but we keep the explicit math so the rate is editable
  // in ONE place. floor() guards any future non-divisible rate.
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

  // Both `usdc` and (reserved) `sol` settle on the SAME SPL exact scheme today;
  // the asset is the USDC mint for the network. When native-SOL support lands
  // this branches on `asset`.
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
    extra: { railAsset: asset, usdCents },
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
// verifyAndSettle — the verify→(only-on-valid)settle orchestration
// ---------------------------------------------------------------------------

export interface VerifyAndSettleInput {
  /** The base64(JSON) payment header the buyer submitted (PAYMENT-SIGNATURE / X-PAYMENT). */
  paymentHeader: string;
  /** The requirements the quote issued (server-derived, NOT the client echo). */
  requirements: PaymentRequirements;
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

  const client = facilitatorClient();

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
// Partner DIRECT-USDC settlement (Phase D — buyer → partner, WE NEVER CUSTODY)
// ---------------------------------------------------------------------------
//
// A vetted partner sells a real service for USDC. The buyer pays the partner's
// OWN Solana pubkey (`payoutPubkey`) directly; ClawVille never holds the funds,
// never signs, never broadcasts — the facilitator performs the on-chain
// verify+settle exactly as for the on-ramp. The ONLY difference from the
// USDC→CT on-ramp is the recipient: `payTo` is the partner payout pubkey
// instead of OUR merchant wallet, and a settled tx credits NO CT (the buyer
// already got real USDC value off-platform; we only RECORD the settled tx).
//
// These two helpers are a THIN clarity layer over the SAME `buildTopupQuote`
// (which already takes `payTo` as a parameter) + `verifyAndSettle` primitives —
// they do NOT reimplement verify→settle. Reusing the identical primitive is
// deliberate: the on-ramp's safety contract (never-throw, settle-only-on-valid,
// no-blank-signature) carries over for free, and a single audited code path
// settles both flows.

export interface BuildPartnerPurchaseQuoteInput {
  /** The partner's OWN Solana pubkey — the buyer pays THIS directly. NEVER our
   *  merchant/treasury wallet (the no-custody invariant lives in the caller too,
   *  but the recipient is bound here). */
  payoutPubkey: string;
  /** Asset the buyer pays. `usdc` is the funded path. */
  asset: X402Asset;
  /** Price of the partner service in integer USD cents. */
  usdCents: number;
  /** Solana network — devnet-first. */
  network: X402Network;
  /** Resource URL/description echoed in the 402 (the partner offering). */
  resource?: { url: string; description?: string };
  /** Facilitator settle deadline. Default 120s. */
  maxTimeoutSeconds?: number;
}

/**
 * Build the x402 v2 402-challenge for a partner direct-USDC purchase. Identical
 * shape to a top-up quote, but the recipient is the partner's `payoutPubkey`
 * (the facilitator only settles a payment whose on-chain recipient matches it,
 * so a forged/redirected payment cannot pay anyone else). This is the SAME
 * `buildTopupQuote` under the hood — `payoutPubkey` simply flows into its
 * already-parameterized `payTo`.
 */
export function buildPartnerPurchaseQuote(input: BuildPartnerPurchaseQuoteInput): TopupQuote {
  return buildTopupQuote({
    payTo: input.payoutPubkey,
    asset: input.asset,
    usdCents: input.usdCents,
    network: input.network,
    resource:
      input.resource ?? {
        url: '/api/partner/storefront/purchase',
        description: `Partner service — $${(input.usdCents / 100).toFixed(2)} ${input.asset.toUpperCase()} (paid directly to the partner)`,
      },
    maxTimeoutSeconds: input.maxTimeoutSeconds,
  });
}

/**
 * Verify+settle a partner direct-USDC purchase. A direct passthrough to the
 * shared `verifyAndSettle`, named distinctly so the partner buy-path reads
 * clearly and so a future divergence (e.g. partner-specific settle metadata)
 * has a seam without touching the on-ramp. Same safety contract: never throws,
 * settle only on a valid verify, `settled:true` only with a non-empty tx
 * signature. The caller (the gated purchase route) decides the recipient
 * (`requirements.payTo` MUST be the partner payoutPubkey) and records — but
 * never credits CT for — the settled tx.
 */
export function settlePartnerPurchase(
  input: VerifyAndSettleInput,
): Promise<VerifyAndSettleResult> {
  return verifyAndSettle(input);
}
