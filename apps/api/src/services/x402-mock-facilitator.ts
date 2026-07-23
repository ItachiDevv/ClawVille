/**
 * MOCK x402 facilitator — a local stand-in for PayAI's hosted facilitator
 * (`https://facilitator.payai.network`) so we can exercise the full x402
 * payment handshake END TO END without touching a real chain or moving real
 * funds.
 *
 * WHY THIS EXISTS
 * ---------------
 * ClawVille is a pure x402 *resource server*: `@x402/hono`'s
 * `paymentMiddleware` + `@x402/core`'s `HTTPFacilitatorClient` delegate the
 * actual on-chain verify+settle to a REMOTE HTTP facilitator over three
 * endpoints — `GET /supported`, `POST /verify`, `POST /settle`. PayAI runs a
 * standards-compliant facilitator at those exact paths, so going live is just
 * `X402_FACILITATOR_URL=https://facilitator.payai.network`. This module serves
 * the SAME three endpoints locally, returning schema-valid responses WITHOUT
 * doing any chain work — so a developer can prove the wiring (paywall → 402 →
 * pay → 200 + settlement header) with no devnet funds and no signer.
 *
 * The response shapes here are transcribed verbatim from the zod schemas in
 * the installed `@x402/core` (`verifyResponseSchema`, `settleResponseSchema`,
 * `supportedResponseSchema`) so the real `HTTPFacilitatorClient` parses them
 * without complaint. The `/supported` kinds mirror PayAI's live response,
 * scoped to the Solana networks ClawVille uses.
 *
 * SAFETY
 * ------
 * - This is a TEST FIXTURE. It performs NO on-chain settlement — every payment
 *   is rubber-stamped. It must NEVER be mounted on a production deployment.
 *   `apps/api/src/index.ts` mounts it only when `X402_MOCK_FACILITATOR==='true'`.
 * - It holds no keys and reads no secrets.
 *
 * NEGATIVE TESTING
 * ----------------
 * The harness controls outcomes by planting a sentinel inside the payment
 * payload (the only client-controlled blob that reaches the facilitator):
 *   paymentPayload.payload.__mock === 'verify-invalid' → /verify returns isValid:false
 *   paymentPayload.payload.__mock === 'settle-fail'    → /settle returns success:false
 *   paymentPayload.payload.__mock === 'verify-error-400' → /verify returns HTTP 400
 *   paymentPayload.payload.__mock === 'verify-error'     → /verify returns HTTP 500
 *   paymentPayload.payload.__mock === 'settle-error-400' → /settle returns HTTP 400
 *   paymentPayload.payload.__mock === 'settle-error'     → /settle returns HTTP 500
 *   paymentPayload.payload.__mock === 'settle-empty-signature'
 *                                                      → /settle reports success:true
 *                                                        with an empty transaction
 * Additional settle-rejection directives cover allowlisted, unknown, missing,
 * compound, and generic-error reason shapes for cap-exemption conformance.
 */

import { Hono } from 'hono';
import { createHash } from 'node:crypto';

/** Solana CAIP-2 network ids (genesis-hash prefixes) — match @x402/svm + PayAI. */
const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/** Bitcoin/Solana base58 alphabet (no 0, O, I, l). */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Fixed mock payer pubkey used when we can't derive one from the payload. */
const MOCK_PAYER_PUBKEY = 'MockPayer1111111111111111111111111111111111';

/**
 * Deterministically derive a realistic-looking (88-char base58) Solana tx
 * signature from the payment payload, so repeated runs of the same payload
 * yield the same "transaction" — handy for assertions.
 */
function mockTxSignature(seed: unknown): string {
  const hash = createHash('sha512')
    .update(typeof seed === 'string' ? seed : JSON.stringify(seed ?? ''))
    .digest();
  let out = '';
  for (let i = 0; i < 88; i++) {
    out += BASE58_ALPHABET[hash[i % hash.length] % BASE58_ALPHABET.length];
  }
  return out;
}

/** Best-effort extraction of the buyer pubkey from a payment payload. */
function extractPayer(paymentPayload: any): string {
  return (
    paymentPayload?.payload?.payer ??
    paymentPayload?.payload?.from ??
    paymentPayload?.payer ??
    MOCK_PAYER_PUBKEY
  );
}

/** Read the test sentinel a harness plants in the client-controlled payload. */
function mockDirective(paymentPayload: any): string | undefined {
  const v = paymentPayload?.payload?.__mock;
  return typeof v === 'string' ? v : undefined;
}

export interface MockFacilitatorOptions {
  /** Emit a one-line log per request. Default true. */
  log?: boolean;
}

/**
 * Build the mock-facilitator Hono router. Mount it under a base path (e.g.
 * `app.route('/api/x402-mock', buildMockFacilitator())`) and point
 * `X402_FACILITATOR_URL` at that base path.
 */
export function buildMockFacilitator(opts: MockFacilitatorOptions = {}): Hono {
  const log = opts.log ?? true;
  const router = new Hono();

  const say = (msg: string) => {
    if (log) console.log(`[x402-mock] ${msg}`);
  };

  // GET /supported — the kinds the resource server reads at initialize() time.
  // Mirrors PayAI's live shape, scoped to the Solana networks we settle on.
  router.get('/supported', (c) => {
    say('GET /supported');
    return c.json({
      kinds: [
        { x402Version: 2, scheme: 'exact', network: SOLANA_MAINNET_CAIP2 },
        { x402Version: 2, scheme: 'exact', network: SOLANA_DEVNET_CAIP2 },
      ],
      extensions: [],
      signers: {},
    });
  });

  // POST /verify — body: { x402Version, paymentPayload, paymentRequirements }.
  // Returns verifyResponseSchema: { isValid, invalidReason?, invalidMessage?, payer?, extensions? }.
  router.post('/verify', async (c) => {
    const body = await c.req.json().catch(() => ({}) as any);
    const { paymentPayload } = body ?? {};
    const directive = mockDirective(paymentPayload);
    const payer = extractPayer(paymentPayload);

    if (directive === 'verify-error-400') {
      say('POST /verify → HTTP 400 (forced)');
      return c.json({ error: 'mock_forced_facilitator_client_error' }, 400);
    }
    if (directive === 'verify-error') {
      say('POST /verify → HTTP 500 (forced)');
      return c.json({ error: 'mock_forced_facilitator_error' }, 500);
    }
    if (directive === 'verify-invalid') {
      say(`POST /verify → isValid:false (forced) payer=${payer}`);
      return c.json({
        isValid: false,
        invalidReason: 'mock_forced_invalid',
        invalidMessage: 'Mock facilitator was told to reject this payment.',
        payer,
      });
    }

    say(`POST /verify → isValid:true payer=${payer}`);
    return c.json({ isValid: true, payer });
  });

  // POST /settle — body: { x402Version, paymentPayload, paymentRequirements }.
  // Returns settleResponseSchema: { success, errorReason?, errorMessage?, payer?, transaction, network, extensions? }.
  router.post('/settle', async (c) => {
    const body = await c.req.json().catch(() => ({}) as any);
    const { paymentPayload, paymentRequirements } = body ?? {};
    const directive = mockDirective(paymentPayload);
    const payer = extractPayer(paymentPayload);
    // The real HTTPFacilitatorClient.settle always sends paymentRequirements, so
    // that is the canonical source. The accepted/constant fallbacks only matter
    // for direct/manual calls to this endpoint (e.g. a raw curl probe).
    const network =
      paymentRequirements?.network ??
      paymentPayload?.accepted?.network ??
      SOLANA_MAINNET_CAIP2;

    if (directive === 'settle-fail') {
      say(`POST /settle → success:false (forced) network=${network}`);
      return c.json({
        success: false,
        errorReason: 'mock_forced_settlement_failure',
        errorMessage: 'Mock facilitator was told to fail settlement.',
        payer,
        transaction: '',
        network,
      });
    }
    if (directive === 'settle-error-400') {
      say(`POST /settle → HTTP 400 (forced) network=${network}`);
      return c.json({ error: 'mock_forced_settlement_client_error' }, 400);
    }
    if (
      directive === 'settle-rejected-structured'
      || directive === 'settle-rejected-with-signature'
      || directive === 'settle-rejected-free-tier-message'
    ) {
      const transaction =
        directive === 'settle-rejected-with-signature'
          ? 'MockObservedSignature111111111111111111111111111111111111111111'
          : '';
      say(`POST /settle → structured HTTP 402 rejection network=${network}`);
      return c.json({
        success: false,
        ...(directive === 'settle-rejected-free-tier-message'
          ? { errorMessage: 'Mock rejection: FREE_TIER_EXHAUSTED.' }
          : {
              errorReason: 'free_tier_exhausted',
              errorMessage: 'Mock facilitator quota exhausted.',
            }),
        payer,
        transaction,
        network,
      }, 402);
    }
    if (
      directive === 'settle-rejected-unknown'
      || directive === 'settle-rejected-suffixed'
      || directive === 'settle-rejected-no-reason'
    ) {
      say(`POST /settle → structured unknown HTTP 402 rejection network=${network}`);
      return c.json({
        success: false,
        ...(directive === 'settle-rejected-unknown'
          ? { errorReason: 'not_free_tier_exhausted' }
          : directive === 'settle-rejected-suffixed'
            ? { errorReason: 'free_tier_exhausted_maybe' }
            : {}),
        errorMessage:
          directive === 'settle-rejected-unknown'
            ? 'Incidental message mentions free_tier_exhausted.'
            : 'Mock rejection has no proven pre-broadcast reason.',
        payer,
        transaction: '',
        network,
      }, 402);
    }
    if (directive === 'settle-error-free-tier-message') {
      say(`POST /settle → generic HTTP 503 with quota text network=${network}`);
      return c.json({ error: 'free_tier_exhausted' }, 503);
    }
    if (directive === 'settle-error') {
      say(`POST /settle → HTTP 500 (forced) network=${network}`);
      return c.json({ error: 'mock_forced_settlement_error' }, 500);
    }
    if (directive === 'settle-empty-signature') {
      say(`POST /settle → success:true, empty signature (forced) network=${network}`);
      return c.json({ success: true, payer, transaction: '', network });
    }

    const transaction = mockTxSignature(paymentPayload);
    say(`POST /settle → success:true tx=${transaction.slice(0, 12)}… network=${network}`);
    return c.json({ success: true, payer, transaction, network });
  });

  return router;
}
