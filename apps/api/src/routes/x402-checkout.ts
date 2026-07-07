// FEATURE_GATE: x402_payment_middleware → x402_checkout
// Status: generic vCLAW-priced USDC checkout (Tokenomics C, checkout stage) —
//   quote + settle wired through the SAME x402/PayAI primitive as ct-topup,
//   onto the LIVE `x402_checkouts` table, with per-kind fulfillers (cosmetic
//   purchase + land rent/deposit prepay). Devnet-first (X402_TOPUP_NETWORK,
//   shared with ct-topup). Human + connected-agent parity via
//   requireAuthOrAgentSession. NO LIVE VALUE: 503 on_ramp_unconfigured until
//   the merchant wallet is configured; X402_ENABLED untouched; no flag flips
//   in this diff.
// Metric to graduate: settled checkout volume > 0 on /dash (a real settled
//   USDC cosmetic/rent checkout against the PayAI devnet facilitator, then a
//   mainnet config flip).
// Current reading: 0 (route just shipped; no live settle yet).
// Review deadline: 2026-08-21 (aligned with ct_topup — one on-ramp family).
// On deadline: if no settled checkout volume, keep gated (do NOT enable
//   mainnet); re-evaluate with the ct_topup gate as one decision.
// Reference: Tokenomics plan Phase C · CLAUDE.md Priority #3 · improvements.md §7.

/**
 * Generic x402 checkout routes — ANY vCLAW-priced thing, settled in USDC.
 *
 *   POST /api/x402/checkout/quote   — price the item SERVER-SIDE, persist a
 *                                     pending checkout, return a 402 challenge.
 *   POST /api/x402/checkout/settle  — verify+settle the payment, run the
 *                                     item's fulfiller EXACTLY ONCE.
 *
 * THE MONEY PATH (structure copied from ct-topup.ts). All settle machinery
 * (per-checkout mutex, fast idem replay, caller-bound row load, server-side
 * requirement re-derivation, verify-never-throws, ONE tx {flip + fulfill},
 * 23505 replay) lives in `services/x402-checkout.ts`; this file is the thin
 * HTTP adapter + the kind-specific quote pricing.
 *
 * PARITY (Rule E5): both a logged-in human (Lucia cookie) AND a connected/
 * hosted agent (X-Clawville-Agent-Session → its bound avatar) reach BOTH
 * routes through `requireAuthOrAgentSession` + `requireNonGuestIdentity`. An
 * agent checks out for ITS OWN avatar (identity.avatarId) — never a
 * body-supplied avatarId, never a guest demotion. Additionally (stricter than
 * ct-topup, matching the cove real-money convention): an agent session that
 * has NOT proven avatar ownership (`ledgerCapable === false`) is 403'd —
 * checkouts mutate the avatar's persistent economy (skins, land escrow).
 *
 * IMPORTING THE FULFILLERS IS LOAD-BEARING: the three imports below are the
 * side-effect registrations (`registerFulfiller`) — index.ts pulling this
 * route pulls the fulfillers, so `getFulfiller` is always populated before
 * any request runs. Removing an import silently 503s that kind (fail-closed,
 * never a mis-fulfill).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
  type ActivityIdentity,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import {
  createCheckoutQuote,
  settleCheckout,
  checkoutSubjectBalance,
  CHECKOUT_MAX_PRICE_VCLAW,
  type CheckoutSubject,
} from '../services/x402-checkout';
// SIDE-EFFECT IMPORTS — register the fulfillers + preflights (see header).
import { resolveCosmeticCheckoutItem } from '../services/checkout-fulfillers/cosmetic-purchase';
import { resolveRentPrepayCheckoutItem } from '../services/checkout-fulfillers/rent-prepay';
import { resolveMarketplaceCheckoutItem } from '../services/checkout-fulfillers/marketplace-purchase';
import { bustOwnedCache } from './land';

export const x402CheckoutRoutes = new Hono<ActivityAuthContext>();

// Populate `c.get('user')` from the Lucia cookie BEFORE requireAuthOrAgentSession
// (it reads `c.get('user')` for the human path). Mirrors ct-topup.
x402CheckoutRoutes.use('*', sessionMiddleware);

/** Max length on the Idempotency-Key header (Stripe convention; matches ct-topup). */
const IDEMPOTENCY_KEY_MAX_LEN = 64;

/** Map the middleware identity to the E5 checkout subject; refuses a
 *  non-ledger agent session (see header — the cove real-money convention: an
 *  ownership-unproven/restored session may perceive but never settle). */
function resolveSubject(
  identity: ActivityIdentity,
): { subject: CheckoutSubject } | { error: 'agent_not_ledger_capable' } {
  if (identity.kind === 'agent' && !identity.ledgerCapable) {
    return { error: 'agent_not_ledger_capable' };
  }
  return {
    subject: { avatarId: identity.avatarId, userId: identity.userId ?? null, kind: identity.kind },
  };
}

// ---------------------------------------------------------------------------
// POST /quote — price the item server-side + issue the 402 challenge
// ---------------------------------------------------------------------------

const quoteSchema = z.discriminatedUnion('itemKind', [
  z.object({
    itemKind: z.literal('cosmetic_purchase'),
    /** The cosmetic SKU id. Price comes from the SKU row — NEVER the client. */
    itemRef: z.string().uuid(),
  }),
  z.object({
    itemKind: z.literal('rent_payment'),
    /** The deposit-tenure parcel id (must be owned by the caller). */
    itemRef: z.string().uuid(),
    /** Caller-chosen prepay amount (a SELF-directed escrow credit, like the
     *  deposit-topup body) — same 1..1_000_000 cap as depositTopupBodySchema. */
    amountVclaw: z.number().int().min(1).max(CHECKOUT_MAX_PRICE_VCLAW),
  }),
  z.object({
    itemKind: z.literal('marketplace_purchase'),
    /** The market listing id. Price comes from the listing row — NEVER the
     *  client. FLAG-GATED: refuses `marketplace_settle_disabled` (503) until
     *  MARKETPLACE_SETTLE_ENABLED='true' — no 402 is issued while gated. */
    itemRef: z.string().uuid(),
  }),
]);

x402CheckoutRoutes.post('/quote', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const resolved = resolveSubject(c.get('identity'));
  if ('error' in resolved) {
    return c.json({ error: resolved.error, code: resolved.error }, 403);
  }
  const { subject } = resolved;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json_body', code: 'invalid_json' }, 400);
  }
  const parsed = quoteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_request', code: 'invalid_request', details: parsed.error.flatten() },
      400,
    );
  }

  // Kind-specific SERVER-SIDE pricing + eligibility. Every refusal answers
  // BEFORE a row or requirement exists.
  let priceVclaw: number;
  if (parsed.data.itemKind === 'cosmetic_purchase') {
    const item = await resolveCosmeticCheckoutItem(subject.avatarId, parsed.data.itemRef);
    if (!item.ok) {
      const status =
        item.code === 'not_found' ? 404 : item.code === 'already_owned' ? 409 : 400;
      return c.json({ error: item.code, code: item.code }, status);
    }
    priceVclaw = item.priceVclaw;
  } else if (parsed.data.itemKind === 'marketplace_purchase') {
    const item = await resolveMarketplaceCheckoutItem(subject.avatarId, parsed.data.itemRef);
    if (!item.ok) {
      const status =
        item.code === 'marketplace_settle_disabled'
          ? 503 // FLAG-GATED OFF — settlement not enabled, no 402 is issued
          : item.code === 'listing_not_found'
            ? 404
            : 409; // not_active / expired / own_listing / earned / owner-drift
      return c.json({ error: item.code, code: item.code }, status);
    }
    priceVclaw = item.priceVclaw;
  } else {
    const item = await resolveRentPrepayCheckoutItem(
      subject.avatarId,
      parsed.data.itemRef,
      parsed.data.amountVclaw,
    );
    if (!item.ok) {
      const status =
        item.code === 'parcel_not_found' ? 404 : item.code === 'not_parcel_owner' ? 403 : 409;
      return c.json({ error: item.code, code: item.code }, status);
    }
    priceVclaw = item.priceVclaw;
  }

  const quote = await createCheckoutQuote({
    subject,
    itemKind: parsed.data.itemKind,
    itemRef: parsed.data.itemRef,
    priceVclaw,
  });
  if (!quote.ok) {
    const status =
      quote.code === 'on_ramp_unconfigured' || quote.code === 'fulfiller_unavailable'
        ? 503
        : quote.code === 'invalid_amount'
          ? 400
          : 500;
    return c.json({ error: quote.code, code: quote.code }, status);
  }

  // Same wire convention as ct-topup: base64 PAYMENT-REQUIRED header + JSON
  // echo for non-x402-aware clients. 402 = pay, then call /settle.
  c.header(
    'PAYMENT-REQUIRED',
    Buffer.from(JSON.stringify(quote.quote), 'utf8').toString('base64'),
  );
  c.header('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED');
  return c.json(
    {
      checkoutId: quote.checkoutId,
      itemKind: quote.itemKind,
      itemRef: quote.itemRef,
      priceVclaw: quote.priceVclaw,
      usdCents: quote.usdCents,
      network: quote.network,
      accepts: quote.quote.accepts,
      x402Version: quote.quote.x402Version,
    },
    402,
  );
});

// ---------------------------------------------------------------------------
// POST /settle — verify+settle the payment, fulfill EXACTLY ONCE
// ---------------------------------------------------------------------------

const settleSchema = z.object({
  checkoutId: z.string().uuid(),
});

x402CheckoutRoutes.post('/settle', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const resolved = resolveSubject(c.get('identity'));
  if ('error' in resolved) {
    return c.json({ error: resolved.error, code: resolved.error }, 403);
  }
  const { subject } = resolved;

  // Idempotency-Key REQUIRED on settle (terminal money action) — ct-topup rule.
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey) {
    return c.json({ error: 'idempotency_key_required', code: 'idempotency_key_required' }, 400);
  }
  if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN) {
    return c.json({ error: 'idempotency_key_too_long', code: 'idempotency_key_too_long' }, 400);
  }

  // Payment header (PAYMENT-SIGNATURE preferred, X-PAYMENT fallback — the
  // @x402/hono read order). Missing ⇒ 402 (pay first).
  const paymentHeader = c.req.header('PAYMENT-SIGNATURE') ?? c.req.header('X-PAYMENT');
  if (!paymentHeader) {
    return c.json({ error: 'payment_header_required', code: 'payment_required' }, 402);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json_body', code: 'invalid_json' }, 400);
  }
  const parsed = settleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_request', code: 'invalid_request', details: parsed.error.flatten() },
      400,
    );
  }

  const result = await settleCheckout({
    checkoutId: parsed.data.checkoutId,
    subject,
    paymentHeader,
    idempotencyKey,
  });

  if (!result.ok) {
    switch (result.code) {
      case 'checkout_not_found':
        return c.json({ error: result.code, code: result.code }, 404);
      case 'checkout_not_pending':
        return c.json({ error: result.code, code: result.code, status: result.status }, 409);
      case 'fulfiller_unavailable':
      case 'on_ramp_unconfigured':
        return c.json({ error: result.code, code: result.code }, 503);
      case 'precondition_failed':
        // Row still PENDING, no money moved — the item's preconditions died
        // since the quote (e.g. cosmetic bought with CT, parcel released).
        return c.json(
          { error: result.code, code: result.code, refusalCode: result.refusalCode },
          409,
        );
      case 'payment_not_settled':
        return c.json(
          {
            error: result.code,
            code: result.code,
            reason: result.reason,
            transient: result.transient,
          },
          402,
        );
      case 'fulfillment_refused':
        // Terminal: USDC settled but the authoritative in-tx re-check refused
        // (near-zero race window past the preflight). The row is failed with
        // the signature claimed; ops follow the logged manual-refund trail.
        return c.json(
          { error: result.code, code: result.code, refusalCode: result.refusalCode },
          409,
        );
      case 'settle_in_flight':
        // Another process holds a fresh settling claim on this checkout — the
        // caller retries the SAME checkoutId shortly (no money moved by us).
        return c.json({ error: result.code, code: result.code }, 409);
      case 'idempotency_key_conflict':
        // This avatar reused an Idempotency-Key on a DIFFERENT checkout. No money
        // moved — the client must use a fresh key per checkout.
        return c.json({ error: result.code, code: result.code }, 409);
      case 'checkout_reconciliation':
      case 'signature_conflict':
        // Money-state needs reconciliation: a stale settling claim (money-state
        // unknown), a capture that could not be recorded, or a settled signature
        // already owned by another checkout. The row is in `reconcile` — a
        // chain-check reconciler resolves it; the settle is NOT auto-retried.
        return c.json({ error: result.code, code: result.code, status: result.status }, 409);
      case 'settle_failed':
      default:
        // Includes the transient post-capture fulfillment failure (result
        // .transient===true): the signature is durable, the row is settling+sig,
        // and a retry of the SAME checkoutId RESUMES fulfillment without
        // re-calling the facilitator.
        return c.json(
          { error: 'settle_failed', code: 'settle_failed', ...(result.transient ? { transient: true } : {}) },
          500,
        );
    }
  }

  // Kind-specific post-commit side effects (cache invalidation only — never
  // money). The land /me view caches the escrow remainder; bust AFTER commit,
  // exactly like the deposit-topup route.
  if (result.itemKind === 'rent_payment') {
    bustOwnedCache(subject.avatarId);
  }

  // `balance` proves the USDC rail moved NO internal vCLAW (it is whatever it
  // was before the checkout; fulfillers never touch the buyer's balance).
  const balance = await checkoutSubjectBalance(subject.avatarId);
  return c.json({
    checkoutId: result.checkoutId,
    itemKind: result.itemKind,
    itemRef: result.itemRef,
    priceVclaw: result.priceVclaw,
    txSignature: result.txSignature,
    fulfillment: result.fulfillment,
    balance,
    ...(result.replay ? { replay: true } : {}),
  });
});

export default x402CheckoutRoutes;
