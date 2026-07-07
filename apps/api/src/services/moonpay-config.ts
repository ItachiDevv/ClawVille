/**
 * MOONPAY CONFIG (Tokenomics C2, 2026-07-07) — TEST-MODE card→USDC rail
 * primitives: env resolution, the signed-widget-URL builder, the webhook
 * signature verifier, and the +4.5% card-fee pass-through constant.
 *
 * TEST-MODE ONLY — MECHANICALLY PINNED:
 *   - The widget base URL is the CODE CONSTANT `https://buy-sandbox.moonpay.com`
 *     (MoonPay's sandbox). It is deliberately NOT env-overridable: flipping to
 *     the live `buy.moonpay.com` is a Codex-reviewed CODE change, not an env
 *     tweak (mirrors the SAP_ALLOW_MAINNET code-gate posture).
 *   - `buildSignedWidgetUrl` REFUSES (returns null) unless the publishable key
 *     starts with `pk_test_` — a live key can never be signed into a URL by
 *     this build even if someone sets one.
 *
 * NO SDK: MoonPay's URL signature is a plain HMAC-SHA256 — hand-rolled on Node
 * `crypto` (zero new dependencies, zero license surface):
 *   - WIDGET URL: `signature = base64(hmacSha256(secretKey, url.search))`
 *     computed over the query string (leading '?', WITHOUT the signature
 *     param), then appended as `&signature=<urlencoded>`. MoonPay re-derives
 *     it server-side; a tampered param invalidates the URL.
 *   - WEBHOOK (v2): header `Moonpay-Signature-V2: t=<unix>,s=<hex>`, where
 *     `s = hex(hmacSha256(webhookKey, `${t}.${rawBody}`))` (Stripe-style).
 *     Verified timing-safe. Replay of a captured payload is defused by the
 *     `moonpay_events.external_tx_id` UNIQUE index (DB idempotency), not by a
 *     timestamp window — MoonPay retries failed deliveries hours later, so a
 *     tight freshness window would reject legitimate retries.
 *
 * SECRETS: `MOONPAY_SECRET_KEY` + `MOONPAY_WEBHOOK_KEY` are NEVER logged,
 * echoed, or included in any response. Only the publishable `MOONPAY_API_KEY`
 * ever appears in a URL (that is its purpose).
 *
 * This module never touches `avatars.clawTokens`, the CT ledger, or any
 * custodial secret.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * TEST-MODE widget base — a CODE CONSTANT, not env. Flipping to the live
 * `https://buy.moonpay.com` is a deliberate, Codex-reviewed code change.
 */
export const MOONPAY_WIDGET_BASE_URL = 'https://buy-sandbox.moonpay.com';

/** The asset the rail delivers: USDC on Solana (funds the custodial wallet). */
export const MOONPAY_CURRENCY_CODE = 'usdc_sol';

/** Default card-fee pass-through: +4.5% (450 bps), surfaced in every quote. */
export const DEFAULT_MOONPAY_CARD_FEE_BPS = 450;

export interface MoonpayConfig {
  /** Publishable key (pk_test_…). Appears in widget URLs by design. */
  apiKey: string | null;
  /** URL-signing secret (sk_test_…). NEVER logged/echoed. */
  secretKey: string | null;
  /** Webhook-signature key (wk_test_…). NEVER logged/echoed. */
  webhookKey: string | null;
  /** Card pass-through fee in bps (default 450 = +4.5%). */
  cardFeeBps: number;
}

/** `MOONPAY_CARD_FEE_BPS` — integer bps, clamped to [0, 2000] (sane ceiling). */
export function resolveMoonpayCardFeeBps(): number {
  const raw = process.env.MOONPAY_CARD_FEE_BPS;
  if (!raw) return DEFAULT_MOONPAY_CARD_FEE_BPS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MOONPAY_CARD_FEE_BPS;
  return Math.min(n, 2_000);
}

export function loadMoonpayConfig(): MoonpayConfig {
  return {
    apiKey: process.env.MOONPAY_API_KEY?.trim() || null,
    secretKey: process.env.MOONPAY_SECRET_KEY?.trim() || null,
    webhookKey: process.env.MOONPAY_WEBHOOK_KEY?.trim() || null,
    cardFeeBps: resolveMoonpayCardFeeBps(),
  };
}

/**
 * The +cardFeeBps pass-through on a USD amount in integer cents. Fee rounds UP
 * (house-favorable: the buyer covers the whole processor cost; the house never
 * absorbs a rounding penny). Throws on a non-positive/non-integer cents value
 * so a bad quote can never surface.
 */
export function computeCardFee(
  usdCents: number,
  bps: number = resolveMoonpayCardFeeBps(),
): { feeUsdCents: number; totalUsdCents: number; cardFeeBps: number } {
  if (!Number.isInteger(usdCents) || usdCents <= 0) {
    throw new Error(`computeCardFee: usdCents must be a positive integer, got ${usdCents}`);
  }
  const cleanBps = Number.isFinite(bps) && bps >= 0 ? Math.min(Math.floor(bps), 2_000) : DEFAULT_MOONPAY_CARD_FEE_BPS;
  const feeUsdCents = Math.ceil((usdCents * cleanBps) / 10_000);
  return { feeUsdCents, totalUsdCents: usdCents + feeUsdCents, cardFeeBps: cleanBps };
}

export interface BuildSignedWidgetUrlInput {
  /** Destination custodial wallet (base58 Solana pubkey). */
  walletAddress: string;
  /** Optional fiat amount to pre-fill (USD, integer cents). */
  usdCents?: number;
  /** OUR opaque checkout reference — MoonPay echoes it back in the webhook
   *  (`data.externalTransactionId`) and we persist it as `client_ref`. */
  externalTransactionId?: string;
}

/**
 * Build the SIGNED MoonPay widget URL (sandbox base, usdc_sol, the caller's
 * custodial wallet). Returns null when unconfigured OR when the publishable
 * key is not a `pk_test_` key (test-mode pin — see module header). The route
 * maps null to a clean 503, never a 5xx throw.
 *
 * Signature scheme (MoonPay docs): HMAC-SHA256 of `url.search` (the '?'-
 * prefixed query WITHOUT the signature param) under the secret key, base64,
 * appended as `&signature=<urlencoded>`.
 */
export function buildSignedWidgetUrl(input: BuildSignedWidgetUrlInput): string | null {
  const { apiKey, secretKey } = loadMoonpayConfig();
  if (!apiKey || !secretKey) return null;
  if (!apiKey.startsWith('pk_test_')) {
    // Test-mode pin: this build refuses to sign a LIVE publishable key into a
    // URL. Going live is a code change (see module header), not a key swap.
    console.warn('[moonpay] MOONPAY_API_KEY is not a pk_test_ key — refusing (test-mode only build)');
    return null;
  }
  if (!input.walletAddress || typeof input.walletAddress !== 'string') return null;

  const url = new URL(MOONPAY_WIDGET_BASE_URL);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('currencyCode', MOONPAY_CURRENCY_CODE);
  url.searchParams.set('walletAddress', input.walletAddress);
  if (typeof input.usdCents === 'number' && Number.isInteger(input.usdCents) && input.usdCents > 0) {
    url.searchParams.set('baseCurrencyCode', 'usd');
    url.searchParams.set('baseCurrencyAmount', (input.usdCents / 100).toFixed(2));
  }
  if (input.externalTransactionId) {
    url.searchParams.set('externalTransactionId', input.externalTransactionId);
  }

  const signature = createHmac('sha256', secretKey).update(url.search).digest('base64');
  return `${url.toString()}&signature=${encodeURIComponent(signature)}`;
}

/**
 * Verify a MoonPay v2 webhook signature against the RAW request body.
 * Header format: `Moonpay-Signature-V2: t=<unix>,s=<hex>`; signed payload is
 * `${t}.${rawBody}`, HMAC-SHA256 under the webhook key, hex. Timing-safe
 * compare; ANY malformed header/handle is a clean `false` (route → 401),
 * never a throw.
 */
export function verifyMoonpayWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined | null,
  webhookKey: string,
): boolean {
  try {
    if (!signatureHeader || typeof signatureHeader !== 'string' || !webhookKey) return false;
    let t: string | null = null;
    let s: string | null = null;
    for (const part of signatureHeader.split(',')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k === 't') t = v;
      else if (k === 's') s = v;
    }
    if (!t || !s || !/^\d{1,13}$/.test(t) || !/^[0-9a-f]{64}$/i.test(s)) return false;
    const expectedHex = createHmac('sha256', webhookKey).update(`${t}.${rawBody}`).digest('hex');
    const a = Buffer.from(expectedHex, 'hex');
    const b = Buffer.from(s, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
