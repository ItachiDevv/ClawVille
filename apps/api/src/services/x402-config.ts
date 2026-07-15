// FEATURE_GATE: x402_payment_middleware
// Status: scaffold live, flag OFF (X402_ENABLED defaults to false).
// Retained, not deleted, on 2026-04-21 per founder call — reserved for later
// metered-access features unrelated to peer skill commerce (removed 2026-07-02).
// Metric to graduate: any future feature requiring per-call metered access is
//   proposed AND has a traction signal (e.g. gated API tier with visible
//   demand on /dash).
// Review deadline: 2026-07-21.
// On deadline: if no metered feature is proposed, rip @x402/* + agent-v2.ts;
//   if a feature IS proposed, convert this gate to a specific metric for that
//   feature.
// Reference: Brand Identity §4, CLAUDE.md Priority #3, improvements.md §7.
/**
 * x402 payment middleware configuration for ClawVille.
 *
 * This module builds the facilitator client, the Solana-first
 * `x402ResourceServer`, and the protected-routes map consumed by
 * `paymentMiddleware` from `@x402/hono`.
 *
 * Activation is gated on the `X402_ENABLED=true` env var so that the rest of
 * the API keeps working while we iterate on payment testing (we need funded
 * wallets + a facilitator endpoint before we can actually serve paid traffic).
 *
 * Environment variables consumed:
 *   X402_ENABLED                       — "true" to register the middleware on
 *                                        /api/v2/* routes. Default: off.
 *   X402_FACILITATOR_PRESET            — Named facilitator: "cdp" (Coinbase
 *                                        CDP, default), "payai" (PayAI hosted
 *                                        facilitator — standards-compliant,
 *                                        no API key, live Solana mainnet+devnet),
 *                                        or "mock" (the local mock facilitator
 *                                        in x402-mock-facilitator.ts, for tests).
 *   X402_FACILITATOR_URL               — Explicit facilitator base URL. When
 *                                        set it OVERRIDES the preset. The
 *                                        @x402/core HTTPFacilitatorClient appends
 *                                        /verify, /settle, /supported to it.
 *   X402_MOCK_FACILITATOR_URL          — Base URL used by the "mock" preset.
 *                                        Default: http://localhost:4000/api/x402-mock.
 *   CLAWVILLE_MERCHANT_WALLET_PUBKEY   — Base58 Solana public key that receives
 *                                        USDC settlements. Pulled from
 *                                        treasury_wallets via
 *                                        scripts/import-treasury-wallet.ts.
 *   X402_NETWORK                       — CAIP-2 network id. Default:
 *                                        solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
 *                                        (Solana mainnet).
 *
 * v1/v2 Solana coexistence note:
 *   `@x402/svm` uses `@solana/kit` (Web3.js v2) internally. Our
 *   `keypair-vault.ts` uses `@solana/web3.js@1.x`. The merchant wallet is
 *   referenced here only as a base58 public key string, so neither SDK
 *   touches the other's object graph — no v1↔v2 interop needed for the
 *   server-side payment verification path. If and when we add x402-client
 *   code that needs to sign payment payloads (e.g. the api paying out to
 *   other agents), we'll need to decide on the migration at that point.
 */

import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { registerExactSvmScheme } from '@x402/svm/exact/server';
import type { paymentMiddleware } from '@x402/hono';

// ---------------------------------------------------------------------------
// FAIL-BOOT INVARIANT — the mock facilitator must NEVER run on production.
// ---------------------------------------------------------------------------
//
// The in-API mock facilitator (`x402-mock-facilitator.ts`, mounted in index.ts)
// RUBBER-STAMPS every `/settle`, so a settle against it credits CT for a payment
// that never moved on-chain — i.e. it MINTS FREE ClawTokens. It is a test-only
// affordance. This guard converts "never enable the mock on prod" from ops
// discipline into a code-enforced invariant: if the mock facilitator is active
// (`X402_MOCK_FACILITATOR==='true'` OR the resolved preset is `mock`) while the
// immutable deploy signal says production (`CLAWVILLE_ENV==='production'`), the
// API REFUSES TO BOOT — it throws at module load, exactly like the
// `ALLOW_TEST_PARTNER_PUBKEY` guard in partner-signature.ts and the
// `FINGERPRINT_SECRET` guard in middleware/fingerprint.ts, so a misconfigured
// prod box crashes loudly until the var is removed instead of silently minting
// free CT. This module is on the boot import graph (imported by x402-payai.ts ←
// ct-topup.ts, which is mounted), so the throw fires at API startup regardless
// of whether `X402_ENABLED` is set.
//
// `CLAWVILLE_ENV` is the immutable deploy signal (NODE_ENV is 'production' on
// BOTH Coolify boxes, so it cannot discriminate). Production forbids the mock;
// staging and local development retain the test harness.
{
  const mockPresetActive =
    process.env.X402_MOCK_FACILITATOR === 'true' ||
    process.env.X402_FACILITATOR_PRESET?.trim().toLowerCase() === 'mock';
  if (mockPresetActive && process.env.CLAWVILLE_ENV === 'production') {
    throw new Error(
      `[x402] The MOCK x402 facilitator is active (X402_MOCK_FACILITATOR=true and/or ` +
        `X402_FACILITATOR_PRESET=mock) on production. The mock rubber-stamps settlement and ` +
        `would mint unbacked vCLAW. Unset ` +
        `X402_MOCK_FACILITATOR and set X402_FACILITATOR_PRESET to a real facilitator ` +
        `(payai/cdp).`,
    );
  }
}

export type X402FacilitatorPreset = 'cdp' | 'payai' | 'mock';

export interface X402Config {
  enabled: boolean;
  /** Which named facilitator the URL resolved from (for logs). */
  facilitatorPreset: X402FacilitatorPreset;
  /** Whether facilitatorUrl came from an explicit X402_FACILITATOR_URL override. */
  facilitatorUrlExplicit: boolean;
  facilitatorUrl: string;
  merchantWalletPubkey: string;
  network: string;
}

/** Coinbase CDP v2 x402 facilitator (Base/EVM first-party + Solana via CDP). */
const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
/** PayAI hosted facilitator — standards-compliant, no API key, Solana + 20 EVM chains. */
const PAYAI_FACILITATOR_URL = 'https://facilitator.payai.network';
/** Default base path the in-API mock facilitator is mounted at (see index.ts). */
const DEFAULT_MOCK_FACILITATOR_URL = 'http://localhost:4000/api/x402-mock';
const PRODUCTION_FACILITATOR_ORIGINS = new Set([
  'https://facilitator.payai.network',
  'https://api.cdp.coinbase.com',
]);

function isPrivateFacilitatorHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match172 = /^172\.(\d{1,3})\./.exec(host);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  return host === '0.0.0.0' || host === '169.254.169.254' || host.startsWith('fc') || host.startsWith('fd');
}

/** Crash-loud production guard over the fully resolved URL (including explicit
 * overrides). Local/staging are intentionally unchanged for the mock harness. */
export function assertProductionFacilitatorAllowed(
  facilitatorUrl: string,
  environment = process.env.CLAWVILLE_ENV,
): void {
  if (environment !== 'production') return;
  let parsed: URL;
  try {
    parsed = new URL(facilitatorUrl);
  } catch {
    throw new Error('[x402] production facilitator URL is invalid; refusing to boot');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || isPrivateFacilitatorHost(parsed.hostname)
    || !PRODUCTION_FACILITATOR_ORIGINS.has(parsed.origin)
  ) {
    throw new Error(
      `[x402] production facilitator origin is not allowlisted (${parsed.origin}); refusing to boot`,
    );
  }
}

/**
 * True only for the hosted PayAI base URL used by every production USDC rail.
 * URL parsing prevents suffix-host tricks; paths/query/auth/ports are refused
 * because the x402 client appends its own /verify and /settle paths.
 */
export function isHostedPayAiFacilitatorUrl(value: string): boolean {
  try {
    const facilitator = new URL(value);
    return facilitator.protocol === 'https:'
      && facilitator.hostname === 'facilitator.payai.network'
      && facilitator.port === ''
      && facilitator.pathname === '/'
      && facilitator.username === ''
      && facilitator.password === ''
      && facilitator.search === ''
      && facilitator.hash === '';
  } catch {
    return false;
  }
}

/**
 * Resolve the facilitator base URL. An explicit `X402_FACILITATOR_URL` always
 * wins (and is reported as explicit); otherwise the `X402_FACILITATOR_PRESET`
 * selects a known facilitator. Unknown presets fall back to CDP — the historical
 * default — so this change is backward-compatible.
 */
function resolveFacilitator(): {
  url: string;
  preset: X402FacilitatorPreset;
  explicit: boolean;
} {
  const explicitUrl = process.env.X402_FACILITATOR_URL?.trim();
  const rawPreset = (process.env.X402_FACILITATOR_PRESET?.trim().toLowerCase() ?? 'cdp');
  const preset: X402FacilitatorPreset =
    rawPreset === 'payai' || rawPreset === 'mock' ? rawPreset : 'cdp';

  if (explicitUrl) {
    return { url: explicitUrl, preset, explicit: true };
  }

  switch (preset) {
    case 'payai':
      return { url: PAYAI_FACILITATOR_URL, preset, explicit: false };
    case 'mock':
      return {
        url: process.env.X402_MOCK_FACILITATOR_URL?.trim() || DEFAULT_MOCK_FACILITATOR_URL,
        preset,
        explicit: false,
      };
    case 'cdp':
    default:
      return { url: CDP_FACILITATOR_URL, preset: 'cdp', explicit: false };
  }
}

// Module-load fail-closed guard: an explicit override cannot bypass preset
// validation, even when the metered x402 middleware itself is disabled.
assertProductionFacilitatorAllowed(resolveFacilitator().url);

/**
 * Read + validate the x402 env config. Always returns a config object even
 * when disabled, so callers can distinguish "no env vars" from "explicitly
 * disabled" in logs.
 */
export function loadX402Config(): X402Config {
  const enabled = process.env.X402_ENABLED === 'true';
  const { url: facilitatorUrl, preset: facilitatorPreset, explicit: facilitatorUrlExplicit } =
    resolveFacilitator();
  assertProductionFacilitatorAllowed(facilitatorUrl);
  const merchantWalletPubkey = process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY ?? '';
  const network = process.env.X402_NETWORK ?? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

  if (enabled && !merchantWalletPubkey) {
    throw new Error(
      '[x402] X402_ENABLED=true but CLAWVILLE_MERCHANT_WALLET_PUBKEY is not set. ' +
        'Run scripts/import-treasury-wallet.ts or scripts/generate-treasury-keypair.ts first.',
    );
  }

  return {
    enabled,
    facilitatorPreset,
    facilitatorUrlExplicit,
    facilitatorUrl,
    merchantWalletPubkey,
    network,
  };
}

/**
 * Build the x402ResourceServer with the Solana Exact scheme registered.
 * Returns null if x402 is disabled — callers must short-circuit in that case.
 */
export function buildX402ResourceServer(config: X402Config): x402ResourceServer | null {
  if (!config.enabled) return null;

  const facilitator = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
  });

  const server = new x402ResourceServer(facilitator);
  registerExactSvmScheme(server);
  return server;
}

/**
 * Route → PaymentOption map consumed by paymentMiddleware. Prices are in USD
 * decimal strings (the Exact scheme auto-converts to USDC smallest units
 * based on network).
 *
 * Keep this list SHORT and well-reasoned — every entry here is a real paywall
 * that will reject unpaid requests. Start with non-essential endpoints and
 * graduate to core game actions once we're confident about UX.
 */
export function buildX402Routes(config: X402Config): Parameters<typeof paymentMiddleware>[0] {
  return {
    // Cheap demo endpoint — $0.001 per call to prove the middleware +
    // facilitator chain is wired without risking real money on a
    // production-critical path.
    'GET /api/v2/agent/ping': {
      accepts: {
        scheme: 'exact',
        payTo: config.merchantWalletPubkey,
        price: '$0.001',
        network: config.network as never,
        maxTimeoutSeconds: 60,
      },
      description: 'Ping the ClawVille agent gateway to prove x402 is wired.',
      mimeType: 'application/json',
    },
    'POST /api/v2/agent/expert-consult': {
      accepts: {
        scheme: 'exact',
        payTo: config.merchantWalletPubkey,
        price: '$0.05',
        network: config.network as never,
        maxTimeoutSeconds: 60,
      },
      description: 'Consult up to two ClawVille building experts on one bounded question.',
      mimeType: 'application/json',
    },
    'GET /api/v2/agent/analytics/:agentId': {
      accepts: {
        scheme: 'exact',
        payTo: config.merchantWalletPubkey,
        price: '$0.01',
        network: config.network as never,
        maxTimeoutSeconds: 60,
      },
      description: 'Get one agent\'s exact 24h, 7d, 30d, and lifetime leaderboard analysis.',
      mimeType: 'application/json',
    },
  };
}
