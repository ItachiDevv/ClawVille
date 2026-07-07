/**
 * MOONPAY CARD RAIL (Tokenomics C2, 2026-07-07) — TEST-MODE ONLY.
 *
 *   POST /api/moonpay/widget-url — issue a SIGNED sandbox widget URL that
 *     funds the CALLER'S OWN custodial wallet with USDC (usdc_sol).
 *   POST /api/moonpay/webhook    — signature-verified, DB-idempotent receiver
 *     that RECORDS USDC arrivals. It never signs, never moves CT, never
 *     completes settlement.
 *
 * PARITY (Rule E5): `/widget-url` goes through `requireAuthOrAgentSession` +
 * `requireNonGuestIdentity` — a logged-in human (Lucia cookie) AND a
 * connected/hosted agent (X-Clawville-Agent-Session → its bound avatar) both
 * get a URL funding THEIR OWN custodial wallet (`getWalletAddress('avatar',
 * identity.avatarId)` — the avatar the middleware resolved, never a
 * body-supplied address). Guests 403 (demo economy); unbound/expired agents
 * 401/403 in the middleware.
 *
 * TEST-MODE PIN: the widget base is the SANDBOX code constant and the builder
 * refuses non-`pk_test_` keys (`moonpay-config.ts`) — this build cannot mint a
 * live-money URL. Going live is a Codex-reviewed code change.
 *
 * WEBHOOK SAFETY CONTRACT (mirrors ct-topup's never-throw discipline):
 *   - Bad/missing signature ⇒ 401. Malformed body ⇒ 400. Unconfigured ⇒ 503
 *     (MoonPay retries — correct for a not-yet-provisioned box). Never a 5xx
 *     on bad INPUT; a genuine DB outage 500s so MoonPay retries later.
 *   - IDEMPOTENT BY THE DB, never SELECT-then-act: `moonpay_events
 *     .external_tx_id` (MoonPay's `data.id`) is UNIQUE. First delivery INSERTs
 *     (`ON CONFLICT DO NOTHING`); a conflict applies a GUARDED progression
 *     update `WHERE processed_at IS NULL`, so the terminal "checkout ready"
 *     marker (`processed_at`) is claimed EXACTLY ONCE and a replayed webhook
 *     is answered 200 `{replay:true}` with zero re-processing.
 *   - The v1 side effect is the marker ONLY — the checkout stage (next in the
 *     pipeline) reads `client_ref` + `processed_at` to complete the pending
 *     checkout through the normal AUTHED settle path.
 *
 * CODEX-GATED SEAM — CUSTODIAL AUTO-SIGN: a LATER, Codex-review-gated slice
 * could, on a 'completed' USDC arrival, auto-complete the pending checkout by
 * decrypting the avatar's custodial wallet (keypair-vault `decryptWalletRow`)
 * and signing the x402 settle payment server-side. v1 DELIBERATELY does not:
 * this webhook NEVER decrypts a key, NEVER moves CT, NEVER settles — the
 * client completes settlement itself via the authed ct-topup path.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { db, moonpayEvents, eq, and, isNull } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { getWalletAddress } from '../services/wallet-service';
import {
  buildSignedWidgetUrl,
  computeCardFee,
  loadMoonpayConfig,
  verifyMoonpayWebhookSignature,
  MOONPAY_CURRENCY_CODE,
} from '../services/moonpay-config';

export const moonpayRoutes = new Hono<ActivityAuthContext>();

// Populate `c.get('user')` from the Lucia cookie BEFORE requireAuthOrAgentSession
// runs (the agent path reads its header directly). Mirrors ct-topup.ts.
moonpayRoutes.use('*', sessionMiddleware);

// ---------------------------------------------------------------------------
// POST /widget-url — signed sandbox widget URL for the caller's OWN wallet
// ---------------------------------------------------------------------------

const widgetUrlSchema = z.object({
  // Optional fiat pre-fill, USD integer cents. Same $10k single-quote ceiling
  // as the ct-topup on-ramp.
  usdCents: z.number().int().positive().max(1_000_000).optional(),
  // OUR opaque checkout reference (the checkout stage generates it); MoonPay
  // echoes it back in the webhook as data.externalTransactionId → client_ref.
  externalTransactionId: z.string().min(1).max(64).optional(),
});

moonpayRoutes.post(
  '/widget-url',
  requireAuthOrAgentSession,
  requireNonGuestIdentity,
  async (c) => {
    const identity = c.get('identity');

    let body: unknown = {};
    // An empty body is fine (all fields optional) — only reject when a body is
    // present but not JSON.
    const rawLen = c.req.header('content-length');
    if (rawLen && rawLen !== '0') {
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json_body', code: 'invalid_json' }, 400);
      }
    }
    const parsed = widgetUrlSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_request', code: 'invalid_request', details: parsed.error.flatten() },
        400,
      );
    }

    // E5: the DESTINATION is the middleware-resolved identity's OWN custodial
    // wallet — an agent funds ITS avatar's wallet, a human theirs. Never a
    // body-supplied address.
    const walletAddress = await getWalletAddress('avatar', identity.avatarId);
    if (!walletAddress) {
      // Avatars get wallets at creation; a missing one is a provisioning gap,
      // not something to silently create on a quote path.
      return c.json({ error: 'wallet_not_provisioned', code: 'wallet_not_provisioned' }, 409);
    }

    const url = buildSignedWidgetUrl({
      walletAddress,
      usdCents: parsed.data.usdCents,
      externalTransactionId: parsed.data.externalTransactionId,
    });
    if (!url) {
      // Unconfigured keys OR a non-test key (the test-mode pin) — clean 503.
      return c.json({ error: 'moonpay_unconfigured', code: 'moonpay_unconfigured' }, 503);
    }

    // Surface the +4.5% card pass-through in the quote (spec: the constant is
    // part of the quote response, so the client can show the true total).
    const { cardFeeBps } = loadMoonpayConfig();
    const fee =
      typeof parsed.data.usdCents === 'number' ? computeCardFee(parsed.data.usdCents, cardFeeBps) : null;

    return c.json({
      url,
      walletAddress,
      currencyCode: MOONPAY_CURRENCY_CODE,
      testMode: true,
      cardFeeBps,
      ...(fee
        ? {
            usdCents: parsed.data.usdCents,
            cardFeeUsdCents: fee.feeUsdCents,
            totalUsdCents: fee.totalUsdCents,
          }
        : {}),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /webhook — signature-verified, DB-idempotent USDC-arrival recorder
// ---------------------------------------------------------------------------

/** MoonPay webhook body (loose passthrough — MoonPay owns the vocabulary; we
 *  validate only what we persist/branch on). */
const webhookSchema = z
  .object({
    type: z.string().min(1).max(80),
    data: z
      .object({
        id: z.string().min(1).max(80),
        status: z.string().max(40).optional().nullable(),
        walletAddress: z.string().max(64).optional().nullable(),
        baseCurrencyAmount: z.number().finite().nonnegative().max(1e12).optional().nullable(),
        quoteCurrencyAmount: z.number().finite().nonnegative().max(1e12).optional().nullable(),
        currency: z.object({ code: z.string().max(20).optional() }).passthrough().optional().nullable(),
        externalTransactionId: z.string().max(128).optional().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

/** Terminal MoonPay statuses — recording one claims the processed_at marker. */
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

moonpayRoutes.post(
  '/webhook',
  // Bound the body BEFORE reading it — the signature check requires buffering
  // the whole raw body, so an unauthenticated caller must not be able to
  // stream an unbounded payload (mirrors the partner-hatcher 64 KB bodyLimit).
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large', code: 'payload_too_large' }, 413),
  }),
  async (c) => {
    const { webhookKey } = loadMoonpayConfig();
    if (!webhookKey) {
      // Not provisioned — 503 so MoonPay retries once the box is configured
      // (mirrors ct-topup's on_ramp_unconfigured posture).
      return c.json({ error: 'moonpay_unconfigured', code: 'moonpay_unconfigured' }, 503);
    }

    // RAW body FIRST — the signature is over the exact bytes.
    const rawBody = await c.req.text();
    const signatureHeader = c.req.header('Moonpay-Signature-V2');
    if (!verifyMoonpayWebhookSignature(rawBody, signatureHeader, webhookKey)) {
      // Bad/missing signature is a clean 401 — NEVER a 5xx (spec).
      return c.json({ error: 'invalid_signature', code: 'invalid_signature' }, 401);
    }

    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'invalid_json_body', code: 'invalid_json' }, 400);
    }
    const parsed = webhookSchema.safeParse(bodyJson);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_request', code: 'invalid_request', details: parsed.error.flatten() },
        400,
      );
    }
    const evt = parsed.data;
    const status = evt.data.status ?? null;
    const isTerminal = status !== null && TERMINAL_STATUSES.has(status);
    const row = {
      externalTxId: evt.data.id,
      eventType: evt.type,
      status,
      clientRef: evt.data.externalTransactionId ?? null,
      walletAddress: evt.data.walletAddress ?? null,
      baseCurrencyAmount:
        typeof evt.data.baseCurrencyAmount === 'number' ? evt.data.baseCurrencyAmount.toFixed(6) : null,
      quoteCurrencyAmount:
        typeof evt.data.quoteCurrencyAmount === 'number' ? evt.data.quoteCurrencyAmount.toFixed(6) : null,
      currencyCode: evt.data.currency?.code ?? null,
      // Full verified body for audit. The signature already authenticated it.
      payload: evt as Record<string, unknown>,
    };

    try {
      // 1) FIRST DELIVERY — insert one row per MoonPay tx id. The UNIQUE index
      //    (`moonpay_events_external_tx_id_unique`) is THE idempotency guard:
      //    a concurrent/replayed delivery conflicts here (absorbed, no throw)
      //    and falls through to the guarded progression below. A terminal
      //    first delivery claims processed_at atomically in the same INSERT.
      const inserted = await db
        .insert(moonpayEvents)
        .values({ ...row, processedAt: isTerminal ? new Date() : null })
        .onConflictDoNothing({ target: moonpayEvents.externalTxId })
        .returning({ id: moonpayEvents.id });
      if (inserted.length > 0) {
        return c.json({ ok: true, replay: false, recorded: 'inserted' });
      }

      // 2) CONFLICT — the tx id exists. GUARDED PROGRESSION (single atomic
      //    UPDATE, no SELECT-then-act): refresh status/payload and claim the
      //    processed_at marker ONLY where it is still NULL. A row already
      //    processed (terminal recorded) matches nothing ⇒ pure replay, 200
      //    cached, ZERO re-processing.
      const updated = await db
        .update(moonpayEvents)
        .set({
          eventType: row.eventType,
          status: row.status,
          payload: row.payload,
          walletAddress: row.walletAddress,
          baseCurrencyAmount: row.baseCurrencyAmount,
          quoteCurrencyAmount: row.quoteCurrencyAmount,
          currencyCode: row.currencyCode,
          updatedAt: new Date(),
          ...(isTerminal ? { processedAt: new Date() } : {}),
        })
        .where(and(eq(moonpayEvents.externalTxId, row.externalTxId), isNull(moonpayEvents.processedAt)))
        .returning({ id: moonpayEvents.id });

      if (updated.length === 0) {
        // Already terminal/processed — a replay. Cached OK, nothing changed.
        return c.json({ ok: true, replay: true });
      }

      // CODEX-GATED SEAM: custodial auto-sign. On `isTerminal &&
      // status==='completed'` a LATER Codex-review-gated slice would complete
      // the pending checkout server-side: decrypt the destination avatar's
      // custodial wallet (decryptWalletRow), sign the x402 settle payment as
      // the payer, and drive the authed settle path — so the card buyer never
      // has to come back online. v1 DELIBERATELY records the arrival ONLY
      // (processed_at = the "checkout ready" marker the checkout stage polls
      // via client_ref); NO key decrypt, NO CT movement, NO settlement here.
      return c.json({ ok: true, replay: false, recorded: 'progressed' });
    } catch (err) {
      // A genuine DB outage — 500 is correct (MoonPay retries; the UNIQUE
      // index makes the retry safe). Bad INPUT never reaches this branch.
      console.error('[moonpay] webhook record failed:', (err as Error).message);
      return c.json({ error: 'webhook_record_failed', code: 'webhook_record_failed' }, 500);
    }
  },
);

export default moonpayRoutes;
