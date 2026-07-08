// FEATURE_GATE: p2p_marketplace_v1
// Status: listing surface LIVE-capable (list/browse/cancel, CLV seller
//   license, deed escrow-lock); SETTLEMENT flag-gated OFF
//   (MARKETPLACE_SETTLE_ENABLED, default disabled — quote/preflight/fulfiller
//   all refuse `marketplace_settle_disabled`). On-chain CLV payouts + rake +
//   deed transfer are QUEUED Codex-gated intents, never sends. No flag flips
//   in this diff.
// Metric to graduate: ≥1 real settled marketplace checkout on /dash after the
//   review chain (token-economy manager → adversarial money auditor → Codex)
//   clears the flag flip, with its settlement row conservation-clean.
// Current reading: 0 (settlement gated off; flag never flipped).
// Review deadline: 2026-08-21 (aligned with the x402_checkout gate — one
//   USDC-in family, one decision).
// On deadline: if settlement hasn't graduated, keep gated (do NOT flip); the
//   listing surface is retired with the checkout gate if that family dies.
// Reference: Tokenomics plan Phase C · CLAUDE.md Priority #3 · improvements.md §7.

/**
 * P2P MARKETPLACE v1 routes (Tokenomics C4, 2026-07-07).
 *
 *   POST /api/market/listings            — create (seller; CLV license gated)
 *   GET  /api/market/listings            — public browse (active + unexpired)
 *   GET  /api/market/listings/mine       — the caller's own (every status)
 *   POST /api/market/listings/:id/cancel — seller-only, active → cancelled
 *
 * THE BUYER PATH IS NOT HERE: buying a listing is a generic x402 checkout —
 * `POST /api/x402/checkout/quote` with `{itemKind:'marketplace_purchase',
 * itemRef: <listingId>}` then `/settle` (see `routes/x402-checkout.ts` + the
 * fulfiller in `services/checkout-fulfillers/marketplace-purchase.ts`).
 * Settlement is FLAG-GATED OFF (`MARKETPLACE_SETTLE_ENABLED`).
 *
 * PARITY (Rule E5): every write route runs `requireAuthOrAgentSession` +
 * `requireNonGuestIdentity` — a logged-in human (Lucia cookie) AND a
 * connected/hosted agent (`X-Clawville-Agent-Session` → its bound avatar)
 * both list/cancel AS THEMSELVES (`identity.avatarId`, never body-supplied,
 * never a guest demotion). A `land_deed` seller's CLV license reads the
 * HUMAN's linked wallet or the AGENT's custodial wallet
 * (`avatars.wallet_address`) per the C4-pinned split. Non-ledger agent
 * sessions (ownership unproven) are 403'd — the cove/checkout real-money
 * convention: listings escrow-lock persistent land state.
 *
 * LEDGER-ONLY: no route here touches `avatars.clawTokens` — nothing in the
 * marketplace mints, debits, or transfers internal vCLAW.
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
import { CHECKOUT_MAX_PRICE_VCLAW, type CheckoutSubject } from '../services/x402-checkout';
import {
  checkSellerLicense,
  createMarketListing,
  cancelMarketListing,
  browseActiveListings,
  listMyListings,
} from '../services/market-listings';

export const marketRoutes = new Hono<ActivityAuthContext>();

// Populate `c.get('user')` from the Lucia cookie BEFORE requireAuthOrAgentSession
// (it reads `c.get('user')` for the human path). Mirrors x402-checkout/ct-topup.
marketRoutes.use('*', sessionMiddleware);

/** Map the middleware identity to the E5 subject; refuses a non-ledger agent
 *  session (checkout/cove real-money convention — an ownership-unproven or
 *  restored session may perceive but never mutate persistent economy state). */
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

/** Max listing lifetime when the seller sets an expiry: 30 days. */
const MAX_EXPIRES_IN_HOURS = 720;

// ---------------------------------------------------------------------------
// POST /listings — create (seller license + deed escrow-lock)
// ---------------------------------------------------------------------------

const createListingSchema = z
  .object({
    itemKind: z.enum(['land_deed', 'earned_bundle']),
    /** land_deed: the `land_parcels.id` the seller owns. */
    itemRef: z.string().uuid(),
    /** Ask price in vCLAW (¢-peg quote unit) — same cap as the checkout. */
    priceVclaw: z.number().int().min(1).max(CHECKOUT_MAX_PRICE_VCLAW),
    /** Optional expiry window (predicate-expiry in v1 — see schema doc). */
    expiresInHours: z.number().int().min(1).max(MAX_EXPIRES_IN_HOURS).optional(),
  })
  .strict();

marketRoutes.post('/listings', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
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
  const parsed = createListingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_request', code: 'invalid_request', details: parsed.error.flatten() },
      400,
    );
  }

  // trap 6 — earned_bundle BLOCKED until EARNED provenance exists. Answered
  // BEFORE the (RPC-backed) license check: the cheapest structural refusal.
  if (parsed.data.itemKind === 'earned_bundle') {
    return c.json({ error: 'earned_not_available', code: 'earned_not_available' }, 409);
  }

  // SELLER LICENSE (trap 5): ≥ threshold CLV, FAIL-SOFT ⇒ REFUSE.
  const license = await checkSellerLicense(subject);
  if (!license.ok) {
    const status = license.code === 'clv_balance_unavailable' ? 503 : 403;
    return c.json(
      {
        error: license.code,
        code: license.code,
        thresholdClv: license.thresholdClv,
        clvUiAmount: license.clvUiAmount,
      },
      status,
    );
  }

  const expiresAt =
    parsed.data.expiresInHours !== undefined
      ? new Date(Date.now() + parsed.data.expiresInHours * 3_600_000)
      : null;

  const result = await createMarketListing({
    subject,
    itemKind: parsed.data.itemKind,
    itemRef: parsed.data.itemRef,
    priceVclaw: parsed.data.priceVclaw,
    sellerWalletPubkey: license.walletPubkey,
    expiresAt,
  });
  if (!result.ok) {
    const status =
      result.code === 'parcel_not_found'
        ? 404
        : result.code === 'not_parcel_owner'
          ? 403
          : 409; // not_transferable_tenure / hold_transfer_not_supported / parcel_already_listed / earned_not_available
    return c.json({ error: result.code, code: result.code }, status);
  }

  return c.json({ listing: result.listing }, 201);
});

// ---------------------------------------------------------------------------
// GET /listings — public browse (no auth; read-only)
// ---------------------------------------------------------------------------

const browseQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

marketRoutes.get('/listings', async (c) => {
  const parsed = browseQuerySchema.safeParse({ limit: c.req.query('limit') });
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', code: 'invalid_request' }, 400);
  }
  const listings = await browseActiveListings(parsed.data.limit ?? 50);
  return c.json({ listings });
});

// ---------------------------------------------------------------------------
// GET /listings/mine — the caller's own listings (every status)
// ---------------------------------------------------------------------------

marketRoutes.get(
  '/listings/mine',
  requireAuthOrAgentSession,
  requireNonGuestIdentity,
  async (c) => {
    const resolved = resolveSubject(c.get('identity'));
    if ('error' in resolved) {
      return c.json({ error: resolved.error, code: resolved.error }, 403);
    }
    const listings = await listMyListings(resolved.subject.avatarId, 100);
    return c.json({ listings });
  },
);

// ---------------------------------------------------------------------------
// POST /listings/:id/cancel — seller-only; active → cancelled (+ lock release)
// ---------------------------------------------------------------------------

marketRoutes.post(
  '/listings/:id/cancel',
  requireAuthOrAgentSession,
  requireNonGuestIdentity,
  async (c) => {
    const resolved = resolveSubject(c.get('identity'));
    if ('error' in resolved) {
      return c.json({ error: resolved.error, code: resolved.error }, 403);
    }
    const idParse = z.string().uuid().safeParse(c.req.param('id'));
    if (!idParse.success) {
      return c.json({ error: 'invalid_request', code: 'invalid_request' }, 400);
    }

    const result = await cancelMarketListing({
      subject: resolved.subject,
      listingId: idParse.data,
    });
    if (!result.ok) {
      const status =
        result.code === 'listing_not_found' ? 404 : result.code === 'not_your_listing' ? 403 : 409;
      return c.json(
        { error: result.code, code: result.code, ...(result.status ? { status: result.status } : {}) },
        status,
      );
    }
    return c.json({ cancelled: true, listing: result.listing });
  },
);

export default marketRoutes;
