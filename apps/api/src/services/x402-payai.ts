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
 * official `@x402/core` `HTTPFacilitatorClient`, with PayAI's official
 * `@payai/facilitator` helper providing signed-JWT transport authentication.
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
import { clearJwtCache, createPayAIAuthHeaders } from '@payai/facilitator';
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
} from '@x402/core/types';
import { Connection } from '@solana/web3.js';
import { z } from 'zod';
import { decodeTransactionFromPayload, getTokenPayerFromTransaction } from '@x402/svm';
import { isHostedPayAiFacilitatorUrl, loadX402Config } from './x402-config';
import { isFacilitatorOutageError } from './x402-facilitator-selection';

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
      description: `Buy ${usdToCt(usdCents)} vCLAW for $${(usdCents / 100).toFixed(2)} ${asset.toUpperCase()}`,
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
  /** Custodial callers pin the decoded payload payer to their own signer. */
  expectedPayer?: string;
  /** Test seam only; production callers use the default independent RPC proof. */
  independentVerifier?: IndependentSettlementVerifier;
  /**
   * Optional behavior-neutral telemetry seam for callers that must distinguish
   * provider outage from payment rejection. Callback failures are swallowed.
   */
  onFacilitatorError?: (
    stage: 'verify' | 'settle',
    error: unknown,
  ) => void;
}

function reportFacilitatorError(
  input: VerifyAndSettleInput,
  stage: 'verify' | 'settle',
  error: unknown,
): void {
  try {
    input.onFacilitatorError?.(stage, error);
  } catch {
    // Observability must never alter the established never-throw contract.
  }
}

export interface IndependentSettlementVerificationInput {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  txSignature: string;
  facilitatorPayer: string | null;
  reportedNetwork: string | null;
  expectedPayer?: string;
}

export type IndependentSettlementVerifier = (
  input: IndependentSettlementVerificationInput,
) => Promise<
  | { ok: true; payer: string }
  | {
      ok: false;
      reason: 'independent_chain_unavailable' | 'independent_chain_mismatch';
      /** Authoritative only when decoded from the signed SVM payload. */
      payer: string | null;
    }
>;

const settlementRequirementSchema = z.object({
  scheme: z.literal('exact'),
  network: z.enum([SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2]),
  amount: z.string().regex(/^[1-9]\d*$/),
  asset: z.string().min(32).max(64),
  payTo: z.string().min(32).max(64),
}).passthrough();

let _devnetSettlementConnection: Connection | null = null;

function payerFromSignedPayload(payload: PaymentPayload): string | null {
  const svmPayload = payload.payload as { transaction?: unknown; payer?: unknown } | undefined;
  if (typeof svmPayload?.transaction === 'string') {
    try {
      const transaction = decodeTransactionFromPayload({ transaction: svmPayload.transaction });
      return getTokenPayerFromTransaction(transaction);
    } catch {
      return null;
    }
  }
  return null;
}

/** Bind a facilitator-returned signature to the exact transaction message the
 * payer signed. The facilitator may add its fee-payer signature, but it must not
 * substitute another transaction (even one with the same payer/amount/payee). */
export function signedPayloadMessageMatchesChain(
  payload: PaymentPayload,
  chainMessageBytes: Uint8Array,
): boolean {
  const svmPayload = payload.payload as { transaction?: unknown } | undefined;
  if (typeof svmPayload?.transaction !== 'string') return false;
  try {
    const signed = decodeTransactionFromPayload({ transaction: svmPayload.transaction });
    const signedBytes = signed.messageBytes;
    if (signedBytes.length !== chainMessageBytes.length) return false;
    return signedBytes.every((byte, index) => byte === chainMessageBytes[index]);
  } catch {
    return false;
  }
}

const waitForChainIndex = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Preserve signed-payload identity across an RPC/connection setup exception.
 * Without a decoded payer the outcome is mismatch/manual, never an unbound
 * auto-capture candidate. Exported for the regression test. */
export function independentUnavailableAfterPayerDecode(
  payer: string | null,
): Awaited<ReturnType<IndependentSettlementVerifier>> {
  return payer
    ? { ok: false, reason: 'independent_chain_unavailable', payer }
    : { ok: false, reason: 'independent_chain_mismatch', payer: null };
}

async function defaultIndependentSettlementVerifier(
  input: IndependentSettlementVerificationInput,
): ReturnType<IndependentSettlementVerifier> {
  let authoritativePayer: string | null = null;
  try {
    const requirements = settlementRequirementSchema.parse(input.requirements);
    const network: X402Network = requirements.network === SOLANA_MAINNET_CAIP2 ? 'mainnet' : 'devnet';
    if (
      requirements.asset !== usdcMintForNetwork(network)
      || (input.reportedNetwork !== null && input.reportedNetwork !== requirements.network)
    ) {
      return { ok: false, reason: 'independent_chain_mismatch', payer: null };
    }
    const decodedPayer = payerFromSignedPayload(input.payload);
    authoritativePayer = decodedPayer;
    if (!decodedPayer || (input.expectedPayer && decodedPayer !== input.expectedPayer)) {
      return { ok: false, reason: 'independent_chain_mismatch', payer: decodedPayer };
    }

    const connection = network === 'mainnet'
      ? (await import('./clv-swap-custody')).getClvMainnetConnection()
      : (_devnetSettlementConnection ??= new Connection(
          process.env.SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com',
          'confirmed',
        ));
    const { verifyUsdcTransfer } = await import('./x402-chain-verifier');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const chainTransaction = await connection.getTransaction(input.txSignature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (chainTransaction === null) {
          if (attempt < 2) await waitForChainIndex(attempt === 0 ? 250 : 750);
          continue;
        }
        if (!signedPayloadMessageMatchesChain(
          input.payload,
          chainTransaction.transaction.message.serialize(),
        )) {
          return { ok: false, reason: 'independent_chain_mismatch', payer: decodedPayer };
        }
        const verdict = await verifyUsdcTransfer({
          network,
          signature: input.txSignature,
          expectedAtomic: requirements.amount,
          expectedMint: requirements.asset,
          destinationOwner: requirements.payTo,
          expectedPayer: decodedPayer,
          amountMode: 'at_least',
        }, {
          getParsedTransaction: async (_network, signature) => connection.getParsedTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          }),
        });
        if (verdict.kind === 'confirmed_match') return { ok: true, payer: decodedPayer };
        if (verdict.kind !== 'not_found') {
          return { ok: false, reason: 'independent_chain_mismatch', payer: decodedPayer };
        }
      } catch {
        // A transient RPC/parse failure is retried below, never the facilitator.
      }
      if (attempt < 2) await waitForChainIndex(attempt === 0 ? 250 : 750);
    }
    return { ok: false, reason: 'independent_chain_unavailable', payer: decodedPayer };
  } catch {
    return independentUnavailableAfterPayerDecode(authoritativePayer);
  }
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
  /** Buyer pubkey derived from the signed SVM payload after settlement proof. */
  payer: string | null;
  /** A short machine reason when NOT settled (for the route's clean 4xx body). */
  failureReason: string | null;
  /**
   * Internal availability signal for circuit breakers. Present only when the
   * original facilitator error proves a provider-wide condition rather than a
   * rejection of this payment.
   */
  facilitatorFailure?: 'unavailable';
  /** Raw verify/settle responses for logging — never surfaced to the agent. */
  raw: { verify?: VerifyResponse; settle?: SettleResponse };
}

const FREE_TIER_EXHAUSTED_RE =
  /(?:^|[^a-z0-9])free_tier_exhausted(?:[^a-z0-9]|$)/i;

/**
 * Provider-wide failures safe to count toward an outbound circuit breaker.
 * Payment-specific 4xx rejections deliberately remain false.
 */
export function isFacilitatorLevelFailure(error: unknown): boolean {
  if (isFacilitatorOutageError(error)) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    statusCode?: unknown;
    invalidReason?: unknown;
    errorReason?: unknown;
  };
  if (
    typeof candidate.statusCode === 'number'
    && candidate.statusCode >= 500
    && candidate.statusCode <= 599
  ) {
    return true;
  }
  if (
    candidate.invalidReason === 'free_tier_exhausted'
    || candidate.errorReason === 'free_tier_exhausted'
  ) {
    return true;
  }
  if (error instanceof Error) {
    const plainStatus =
      /^Facilitator (?:verify|settle) failed \((\d{3})\):/.exec(error.message);
    if (plainStatus) {
      const status = Number(plainStatus[1]);
      return status >= 500 && status <= 599;
    }
  }
  return error instanceof Error && FREE_TIER_EXHAUSTED_RE.test(error.message);
}

/** Lazily-built facilitator client, memoized by resolved URL + non-secret auth
 *  shape (so URL/auth env changes in tests rebuild it). The API key secret is
 *  deliberately absent from the cache key and every diagnostic. */
let _cachedClient: {
  cacheKey: string;
  apiKeyId: string;
  /** Compared only in memory so secret rotation rebuilds; never logged or serialized. */
  apiKeySecret: string;
  client: HTTPFacilitatorClient;
} | null = null;
export function facilitatorClient(): HTTPFacilitatorClient {
  const {
    facilitatorUrl,
    payaiApiKeyId,
    payaiApiKeySecret,
  } = loadX402Config();
  if (!facilitatorUrl) {
    throw new Error('[x402-payai] facilitator URL is empty — check X402_FACILITATOR_* env');
  }

  const hasAuth = payaiApiKeyId.length > 0 && payaiApiKeySecret.length > 0;
  const cacheKey = JSON.stringify({
    facilitatorUrl,
    hasAuth,
    apiKeyId: payaiApiKeyId,
  });
  if (
    !_cachedClient
    || _cachedClient.cacheKey !== cacheKey
    || _cachedClient.apiKeySecret !== payaiApiKeySecret
  ) {
    if (!hasAuth) {
      // Preserve the historical anonymous constructor exactly when auth is unset.
      _cachedClient = {
        cacheKey,
        apiKeyId: payaiApiKeyId,
        apiKeySecret: payaiApiKeySecret,
        client: new HTTPFacilitatorClient({ url: facilitatorUrl }),
      };
    } else {
      // The package cache is keyed only by key ID. Clear on every authenticated
      // rebuild so returning to an earlier ID with a rotated secret cannot reuse
      // a JWT signed by that ID's previous secret.
      clearJwtCache(payaiApiKeyId);

      console.info(
        `[x402-payai] facilitator auth enabled (PayAI JWT, keyId=${payaiApiKeyId})`,
      );
      if (!isHostedPayAiFacilitatorUrl(facilitatorUrl)) {
        console.warn(
          '[x402-payai] facilitator auth is being sent to a non-PayAI facilitator URL',
        );
      }

      _cachedClient = {
        cacheKey,
        apiKeyId: payaiApiKeyId,
        apiKeySecret: payaiApiKeySecret,
        client: new HTTPFacilitatorClient({
          url: facilitatorUrl,
          createAuthHeaders: createPayAIAuthHeaders(payaiApiKeyId, payaiApiKeySecret),
        }),
      };
    }
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
    reportFacilitatorError(input, 'verify', err);
    console.warn('[x402-payai] verify threw (treated as invalid):', (err as Error).message);
    return failed('facilitator_verify_error', {
      ...(isFacilitatorLevelFailure(err)
        ? { facilitatorFailure: 'unavailable' as const }
        : {}),
    });
  }

  if (!verify || verify.isValid !== true) {
    const facilitatorFailure = isFacilitatorLevelFailure(verify);
    if (facilitatorFailure) {
      // The official client can return a schema-valid provider rejection
      // instead of throwing (notably free_tier_exhausted). Feed the exact same
      // classifier/observation seam used for thrown failures so fallback and
      // circuit-breaker policy cannot diverge by response shape.
      reportFacilitatorError(input, 'verify', verify);
    }
    return failed(verify?.invalidReason ?? 'payment_invalid', {
      isValid: false,
      payer: verify?.payer ?? null,
      raw: { verify },
      ...(facilitatorFailure
        ? { facilitatorFailure: 'unavailable' as const }
        : {}),
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
    reportFacilitatorError(input, 'settle', err);
    console.warn('[x402-payai] settle threw (treated as unsettled):', (err as Error).message);
    return failed('facilitator_settle_error', {
      isValid: true,
      payer: verify.payer ?? null,
      raw: { verify },
      ...(isFacilitatorLevelFailure(err)
        ? { facilitatorFailure: 'unavailable' as const }
        : {}),
    });
  }

  const txSignature =
    typeof settle?.transaction === 'string' && settle.transaction.length > 0
      ? settle.transaction
      : null;

  if (settle?.success !== true || !txSignature) {
    const facilitatorFailure = isFacilitatorLevelFailure(settle);
    if (facilitatorFailure) {
      reportFacilitatorError(input, 'settle', settle);
    }
    // Facilitator reported a settlement failure OR an empty signature. The
    // empty-signature guard matters: the route's double-credit guard keys on
    // the signature, so a blank one must NEVER be allowed to credit.
    return failed(settle?.errorReason ?? 'settlement_failed', {
      isValid: true,
      payer: settle?.payer ?? verify.payer ?? null,
      network: settle?.network ?? null,
      raw: { verify, settle },
      ...(facilitatorFailure
        ? { facilitatorFailure: 'unavailable' as const }
        : {}),
    });
  }

  const facilitatorPayer = settle.payer ?? verify.payer ?? null;
  const reportedNetwork = settle.network ?? requirements.network ?? null;
  let independent: Awaited<ReturnType<IndependentSettlementVerifier>>;
  try {
    independent = await (input.independentVerifier ?? defaultIndependentSettlementVerifier)({
      payload,
      requirements,
      txSignature,
      facilitatorPayer,
      reportedNetwork,
      expectedPayer: input.expectedPayer,
    });
  } catch {
    independent = { ok: false, reason: 'independent_chain_unavailable', payer: null };
  }
  if (!independent.ok) {
    console.error('[x402-payai] independent settlement proof failed', {
      reason: independent.reason,
      txPrefix: txSignature.slice(0, 8),
    });
    return failed(independent.reason, {
      isValid: true,
      txSignature,
      network: reportedNetwork,
      payer: independent.payer,
      raw: { verify, settle },
    });
  }

  return {
    settled: true,
    isValid: true,
    txSignature,
    network: reportedNetwork,
    payer: independent.payer,
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
  return verifyAndSettle({
    paymentHeader: input.paymentHeader,
    requirements: input.requirements,
    verifyOnly: input.verifyOnly,
    expectedPayer: input.expectedPayer,
    independentVerifier: input.independentVerifier,
    onFacilitatorError: input.onFacilitatorError,
  });
}
