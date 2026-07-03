// FEATURE_GATE: partner_storefront_tier
// Status: VISIBLE-BUT-GATED (Phase D). The partner direct-USDC settlement
//   PRIMITIVE (x402-payai buildPartnerPurchaseQuote/settlePartnerPurchase), the
//   ed25519-signed partner-storefront REGISTRATION, and the admin-only
//   `fulfillment_enabled` flip are all REAL and wired. BUT /quote and /settle
//   return 503 `partner_fulfillment_gated` BEFORE any settlement while a
//   storefront is not fulfillment-enabled (the schema default — always, today,
//   for every partner), and even an enabled storefront cannot transact yet
//   because the server-priced partner OFFERING CATALOG is land-owned + deferred
//   (`resolvePartnerOffering` returns null → 400 `offering_required`). So this
//   Phase ships the settlement primitive + gated registration + the gate itself,
//   NOT a live buy path. We never accept a client-supplied price (the 58d0caf3
//   design flaw this rebuild fixes): a purchase MUST reference a server-priced
//   offering, and there are none until the catalog lands.
// Metric to graduate: a partner cleared a custody/KYC/age safety review AND an
//   admin flipped `fulfillment_enabled=true` for a real storefront AND a real
//   buyer→partner USDC purchase settled (once the offering catalog exists).
// Current reading: 0 (no storefront fulfillment-enabled; no partner offering
//   catalog; no settled partner purchase).
// Review deadline: 2026-09-01.
// On deadline: keep gated (do NOT enable any fulfillment); re-evaluate whether the
//   partner tier graduates once the land-owned offering catalog exists.
// Reference: PLAN.md §2 Phase D · CLAUDE.md "PROTECTED partner surface" + Rule E5
//   (human/agent parity) · land.ts schema `partner_storefronts`.

/**
 * Partner DIRECT-USDC storefront routes (Phase D — buyer → partner, WE NEVER
 * CUSTODY). Mounted at `/api/partner/storefront`.
 *
 *   POST /register            — register/upsert a partner storefront (ed25519
 *        partner-signed write, ±5 min window). NEVER sets `fulfillment_enabled`.
 *   POST /admin/fulfillment   — admin-only flip of `fulfillment_enabled`
 *        (ADMIN_USER_IDS / dash cookie — NEVER the partner key).
 *   POST /quote               — buyer (human OR connected/hosted agent, Rule E5
 *        parity) requests an x402 quote for a SERVER-PRICED partner offering.
 *        503 `partner_fulfillment_gated` while gated (always today); 400
 *        `offering_required` because the offering catalog is land-deferred.
 *   POST /settle              — buyer settles a paid partner purchase. Same gate,
 *        same offering-deferral; Idempotency-Key + per-key mutex on the (future)
 *        settle critical section. Credits NO CT (buyer got off-platform value).
 *
 * ADDITIVE — a NEW router at a NEW path. It does NOT touch the live
 * `/api/partner/hatcher/*` registration / cognition / launch routes or their
 * behavior. The Hatcher partner runs LIVE against our staging/prod, so this Phase
 * is STRICTLY additive (the protected-partner-surface rule); the two
 * `/api/partner/hatcher` mounts match BEFORE this one in index.ts.
 *
 * NO-CUSTODY INVARIANT: a partner purchase pays the partner's OWN Solana pubkey
 * (`partner_storefronts.payout_pubkey`) DIRECTLY — never our merchant/treasury
 * wallet — and the FACILITATOR (PayAI in prod, the mock in tests) performs the
 * on-chain verify+settle. ClawVille never signs, never broadcasts, never holds
 * the USDC, and NEVER credits CT for a partner purchase (the buyer already
 * received real off-platform value; a durable `service_purchases` recording is
 * land-owned and deferred).
 *
 * SECURITY:
 *   - Partner WRITES (register) are ed25519-verified over the domain-separated
 *     write challenge (method+path+timestamp+body-hash) with a ±5 min window via
 *     `verifyPartnerWriteSignature` — the SAME primitive the live partner-hatcher
 *     route uses (`ALLOW_TEST_PARTNER_PUBKEY` stays staging-only, crash-loud on
 *     prod). A partner can register/update its OWN storefront but CANNOT flip the
 *     fulfillment gate, and a payout-pubkey CHANGE force-resets the gate (a prior
 *     custody review is void for a new destination).
 *   - The fulfillment gate flips ONLY via `adminOnly`, after an out-of-band
 *     custody/KYC/age safety review — never a partner key.
 *   - `payoutPubkey` is base58-validated (32-byte ed25519) at write time AND
 *     re-validated before any quote so a malformed recipient can never be
 *     persisted and later quoted/settled.
 *   - SERVER-SIDE price ONLY: /quote + /settle reject any client-supplied price;
 *     a purchase MUST name a server-priced offering (`resolvePartnerOffering`).
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import bs58 from 'bs58';
import { db, partnerStorefronts, and, eq, sql } from '@clawville/database';
import type { AppContext } from '../types';
import { sessionMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/admin-only';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { verifyPartnerWriteSignature } from '../services/partner-signature';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { withKeyedMutex } from '../services/keyed-mutex';
import {
  buildPartnerPurchaseQuote,
  resolveFacilitatorFeePayer,
  settlePartnerPurchase,
  type X402Asset,
  type X402Network,
} from '../services/x402-payai';

/**
 * `DualContext` = base app context (user/session for the admin + partner-signed
 * paths) + the `identity` variable `requireAuthOrAgentSession` sets on the
 * buyer routes. Mirrors the prior storefront design + land.ts so `c.get('identity')`
 * is typed without a cast, and the partner-signed/admin routes (which never read
 * identity) still typecheck against the AppContext-typed middlewares.
 */
type DualContext = AppContext & ActivityAuthContext;

export const partnerStorefrontRoutes = new Hono<DualContext>();

/**
 * The ONLY live partner today. Hardcoded (a comment, not a TODO) so a future
 * second partner is a single path/header-param change here — matches
 * partner-hatcher.ts, which is likewise `hatcher`-scoped. The header names below
 * (`X-Hatcher-*`) match the Hatcher signing scheme; a generic partner would read
 * the same headers keyed by its own allowlist entry.
 */
const PARTNER_ID = 'hatcher';

/** Max length on the Idempotency-Key header (Stripe convention; matches cove + ct-topup). */
const IDEMPOTENCY_KEY_MAX_LEN = 64;

// Bound the request body on EVERY route BEFORE the handlers run. `/register`
// does `await c.req.text()` (buffering the whole body) and verifies the ed25519
// signature AFTER the read, so without this an UNAUTHENTICATED caller could
// stream a huge body and exhaust memory before the 401 fires (the SEC-1 guard the
// live partner-hatcher mount applies). 64 KB is far above any legitimate compact-
// JSON storefront payload. Mirrors the partner-hatcher cap.
partnerStorefrontRoutes.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large', code: 'payload_too_large' }, 413),
  }),
);

// Populate `c.get('user')` from the Lucia cookie so the admin-flip route's
// `adminOnly` and the buyer routes' human path can read it. The partner-signed
// register path reads its own headers, so a null user here is harmless for it.
partnerStorefrontRoutes.use('*', sessionMiddleware);

/** Per-IP register limiter (mirrors partner-hatcher's per-IP guard — a single
 *  partner's egress collapses to one IP; a per-partner-keyed limiter is the
 *  later Redis fix). */
const storefrontWriteRateLimiter = createRateLimiter({ maxPerWindow: 30, windowMs: 60_000 });
/** Per-IP purchase limiter — separate bucket so a buy loop can't starve writes. */
const storefrontPurchaseRateLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });

/** Resolve the partner-USDC network from the EXISTING `X402_TOPUP_NETWORK` env
 *  (NO new env var). Devnet-first; mainnet is an intentional config flip after a
 *  funded settled smoke — the SAME rule as the on-ramp. Unset ⇒ devnet (we never
 *  inherit the legacy x402-config mainnet default for money). */
function resolvePartnerNetwork(): X402Network {
  const explicit = process.env.X402_TOPUP_NETWORK?.trim().toLowerCase();
  if (explicit === 'mainnet') return 'mainnet';
  return 'devnet';
}

/** Validate a base58 ed25519 pubkey (32 bytes). Returns false on any decode
 *  failure or wrong length — a malformed recipient must never be persisted or
 *  quoted. */
function isValidBase58Pubkey(candidate: string): boolean {
  try {
    return bs58.decode(candidate).length === 32;
  } catch {
    return false;
  }
}

/**
 * THE GATE predicate. A storefront can only be quoted/settled when an admin has
 * BOTH enabled fulfillment AND the storefront is operationally `active`. This is
 * true for NO partner today (the schema default is `fulfillment_enabled=false`,
 * status `pending`). Exported so the gate logic is DRY across /quote + /settle
 * AND directly unit-testable without a DB/auth round-trip.
 */
export function isStorefrontFulfillmentGated(storefront: {
  fulfillmentEnabled: boolean;
  status: string;
}): boolean {
  return !storefront.fulfillmentEnabled || storefront.status !== 'active';
}

/**
 * Resolve the SERVER-SIDE price of a partner offering. Returns `null` TODAY for
 * every offeringId: the partner-offering CATALOG (the `service_listings(kind=
 * 'partner')` rows a partner attaches to a shop on an owned parcel) is LAND-OWNED
 * and DEFERRED to the land epic — there is no table to price a purchase from yet.
 *
 * This helper is the seam that keeps the money primitives correct + referenced:
 * when the catalog lands, this loads the offering row and returns its
 * server-authored `priceUsdCents`, and the /quote + /settle future paths below
 * (which build the x402 quote from `offering.priceUsdCents`) light up UNCHANGED.
 * Until then, callers 400 `offering_required` — a purchase can NEVER carry a
 * client-supplied price (the 58d0caf3 flaw we are fixing).
 */
async function resolvePartnerOffering(
  _storefront: typeof partnerStorefronts.$inferSelect,
  _offeringId: string,
): Promise<{ priceUsdCents: number } | null> {
  // Land Phase 5 owns the `service_listings(kind='partner')` catalog + the
  // structure_id FK it hangs off. No partner offering exists to price today.
  return null;
}

/**
 * Verify the ed25519 partner WRITE signature over the raw body, for `partnerId`.
 * Reads the raw body BEFORE JSON.parse (so the signed bytes are the exact wire
 * bytes) and returns the parsed json only on a valid signature. Mirrors
 * `partner-hatcher.ts readSignedBody`. Header names match the Hatcher scheme
 * (`X-Hatcher-*`) since `hatcher` is the only live partner.
 */
async function readSignedPartnerBody(
  c: import('hono').Context<DualContext>,
  partnerId: string,
): Promise<{ ok: true; json: unknown } | { ok: false }> {
  const raw = await c.req.text();
  const verify = verifyPartnerWriteSignature(partnerId, {
    method: c.req.method,
    path: c.req.path,
    tsHeader: c.req.header('X-Hatcher-Timestamp') ?? null,
    pubkeyHeader: c.req.header('X-Hatcher-Issuer-Pubkey') ?? null,
    sigHeader: c.req.header('X-Hatcher-Signature') ?? null,
    rawBody: raw,
  });
  if (!verify.ok) return { ok: false };
  if (raw === '') return { ok: true, json: null };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  return { ok: true, json };
}

// ---------------------------------------------------------------------------
// POST /register — register / upsert a storefront (ed25519 partner-signed)
// ---------------------------------------------------------------------------
// Upserts on the UNIQUE `slug`. `parcelId` stays null (land deferred).
// `fulfillment_enabled` is NEVER settable here — it defaults false and only an
// admin flips it; a payout-pubkey CHANGE force-resets it (see the CASE below).
// ---------------------------------------------------------------------------

const registerStorefrontSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'slug must be lowercase alphanumeric + hyphens'),
  displayName: z.string().min(1).max(120),
  payoutPubkey: z.string().min(32).max(64),
  // status is partner-settable between pending/suspended ONLY (never the
  // fulfillment gate, which is a separate admin-only column). Default pending.
  status: z.enum(['pending', 'suspended']).optional(),
});

partnerStorefrontRoutes.post('/register', async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!storefrontWriteRateLimiter.check(ip)) {
    return c.json({ error: 'rate_limited', code: 'rate_limited' }, 429);
  }

  // ed25519 partner-signed write (verifies BEFORE parsing the body). An invalid
  // signature / unknown partner / stale timestamp → opaque 401.
  const signed = await readSignedPartnerBody(c, PARTNER_ID);
  if (!signed.ok) return c.json({ error: 'unauthorized', code: 'unauthorized' }, 401);

  const parsed = registerStorefrontSchema.safeParse(signed.json);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_request', code: 'invalid_request', details: parsed.error.flatten() },
      400,
    );
  }
  const { slug, displayName, payoutPubkey, status } = parsed.data;

  // Base58-validate the payout pubkey — a malformed recipient must never persist
  // (it would later mint an unsettleable quote / pay nobody).
  if (!isValidBase58Pubkey(payoutPubkey)) {
    return c.json({ error: 'invalid_payout_pubkey', code: 'invalid_payout_pubkey' }, 400);
  }

  // Upsert on the UNIQUE slug. CRITICAL invariants:
  //   - `fulfillmentEnabled` is NEVER directly written by a partner (OMITTED on
  //     insert → schema default false; never set to a partner value on update),
  //     so a partner can never self-enable fulfillment.
  //   - SECURITY: changing the PAYOUT DESTINATION re-opens the gate. If a partner
  //     re-registers with a NEW `payout_pubkey`, the prior custody/KYC/age review
  //     no longer applies to the new destination, so we FORCE-RESET
  //     `fulfillment_enabled` to false (and `status` back to `pending`) on a
  //     payout change — an admin must re-review before USDC can flow to the new
  //     key. A re-register that keeps the SAME payout leaves the gate untouched.
  //   - `parcel_id` stays null (land deferred). `platform_fee_bps` stays 0.
  try {
    const [row] = await db
      .insert(partnerStorefronts)
      .values({
        partnerId: PARTNER_ID,
        slug,
        displayName,
        payoutPubkey,
        status: status ?? 'pending',
        // fulfillmentEnabled OMITTED → default false. parcelId OMITTED → null.
      })
      .onConflictDoUpdate({
        target: partnerStorefronts.slug,
        set: {
          // Re-bind mutable fields, but ONLY for a row owned by THIS partner (the
          // setWhere guard below). EXCLUDED is the proposed (new) row; the bare
          // column is the existing row's value.
          partnerId: PARTNER_ID,
          displayName,
          payoutPubkey,
          // Gate reset on payout change: if the new payout differs from the
          // stored one, force fulfillment OFF + status back to pending; otherwise
          // leave both as they are (don't clobber an admin's prior enable).
          fulfillmentEnabled: sql`CASE WHEN ${partnerStorefronts.payoutPubkey} IS DISTINCT FROM excluded.payout_pubkey THEN false ELSE ${partnerStorefronts.fulfillmentEnabled} END`,
          status: sql`CASE WHEN ${partnerStorefronts.payoutPubkey} IS DISTINCT FROM excluded.payout_pubkey THEN 'pending'::partner_storefront_status ELSE COALESCE(${status ?? null}::partner_storefront_status, ${partnerStorefronts.status}) END`,
          updatedAt: new Date(),
        },
        // Ownership guard: only update a row already owned by THIS partner. A slug
        // owned by a different partner → no update → we detect the unreturned row
        // below and 409.
        setWhere: eq(partnerStorefronts.partnerId, PARTNER_ID),
      })
      .returning();

    if (!row) {
      // onConflict matched a row owned by a DIFFERENT partner (setWhere false) →
      // nothing returned. Slug is taken by another partner.
      return c.json({ error: 'slug_taken', code: 'slug_taken' }, 409);
    }

    return c.json({
      storefront: {
        id: row.id,
        partnerId: row.partnerId,
        slug: row.slug,
        displayName: row.displayName,
        payoutPubkey: row.payoutPubkey,
        status: row.status,
        // Echo the gate so the partner sees it is OFF (admin-flip required).
        fulfillmentEnabled: row.fulfillmentEnabled,
        parcelId: row.parcelId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    console.error('[partner-storefront] register upsert failed:', (err as Error).message);
    return c.json({ error: 'register_failed', code: 'register_failed' }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/fulfillment — ADMIN-ONLY flip of `fulfillment_enabled`
// ---------------------------------------------------------------------------
// Gated by `adminOnly` (ADMIN_USER_IDS / dash cookie) — NEVER the partner key.
// This is the safety gate that opens (or closes) a partner's real-USDC
// fulfillment AFTER an out-of-band custody/KYC/age review.
// ---------------------------------------------------------------------------

const flipSchema = z.object({
  slug: z.string().min(3).max(64),
  enabled: z.boolean(),
});

partnerStorefrontRoutes.post('/admin/fulfillment', adminOnly, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json_body', code: 'invalid_json' }, 400);
  }
  const parsed = flipSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_request', code: 'invalid_request', details: parsed.error.flatten() },
      400,
    );
  }
  const { slug, enabled } = parsed.data;

  try {
    // Admin owns BOTH the safety gate AND the live/suspended operational state:
    // enabling makes the storefront `active` (the partner can only set
    // pending/suspended, never active, so the admin is the single authority that
    // makes a storefront sellable); disabling sets it back to `suspended` so a
    // closed gate also halts its operational state.
    const [row] = await db
      .update(partnerStorefronts)
      .set({
        fulfillmentEnabled: enabled,
        status: enabled ? 'active' : 'suspended',
        updatedAt: new Date(),
      })
      .where(and(eq(partnerStorefronts.slug, slug), eq(partnerStorefronts.partnerId, PARTNER_ID)))
      .returning();
    if (!row) {
      return c.json({ error: 'storefront_not_found', code: 'storefront_not_found' }, 404);
    }
    return c.json({
      storefront: {
        id: row.id,
        slug: row.slug,
        partnerId: row.partnerId,
        fulfillmentEnabled: row.fulfillmentEnabled,
        status: row.status,
      },
    });
  } catch (err) {
    console.error('[partner-storefront] fulfillment flip failed:', (err as Error).message);
    return c.json({ error: 'flip_failed', code: 'flip_failed' }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /quote — buyer requests an x402 quote for a SERVER-PRICED offering
// ---------------------------------------------------------------------------
// Rule E5 parity: requireAuthOrAgentSession resolves a human (Lucia cookie) OR a
// connected/hosted agent (X-Clawville-Agent-Session → bound avatar); 403 for an
// unbound/expired agent, never a guest demotion. No client price is accepted —
// the purchase names an `offeringId` the SERVER prices.
// ---------------------------------------------------------------------------

const quoteSchema = z.object({
  slug: z.string().min(3).max(64),
  // A purchase references a SERVER-PRICED partner offering. NO price field is
  // accepted from the client (the 58d0caf3 flaw this rebuild fixes).
  offeringId: z.string().min(1).max(128),
});

partnerStorefrontRoutes.post('/quote', requireAuthOrAgentSession, async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!storefrontPurchaseRateLimiter.check(ip)) {
    return c.json({ error: 'rate_limited', code: 'rate_limited' }, 429);
  }

  // identity is set by requireAuthOrAgentSession (human OR agent → bound avatar).
  // We don't settle CT, but resolving identity proves the buyer is a real ledger
  // subject (parity) and anchors the audit when fulfillment opens.
  const identity = c.get('identity');

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
  const { slug, offeringId } = parsed.data;

  // Load the storefront for THIS partner + slug.
  const storefront = await db.query.partnerStorefronts.findFirst({
    where: and(eq(partnerStorefronts.slug, slug), eq(partnerStorefronts.partnerId, PARTNER_ID)),
  });
  if (!storefront) {
    return c.json({ error: 'storefront_not_found', code: 'storefront_not_found' }, 404);
  }

  // ── THE GATE ──────────────────────────────────────────────────────────────
  // 503 BEFORE anything else while fulfillment is disabled OR the storefront is
  // not active. This is the visible-but-gated boundary: the primitive +
  // registration are real, but no partner USDC can be quoted until an admin opens
  // the gate post a custody/KYC/age review. Fires for EVERY partner today.
  if (isStorefrontFulfillmentGated(storefront)) {
    return c.json(
      {
        error: 'partner direct-USDC fulfillment is not enabled for this storefront',
        code: 'partner_fulfillment_gated',
      },
      503,
    );
  }

  // ── Server-priced offering (catalog is land-deferred) ──────────────────────
  // A purchase MUST reference a server-priced partner offering. The catalog lands
  // with the land epic, so this resolves to null today → 400 `offering_required`.
  const offering = await resolvePartnerOffering(storefront, offeringId);
  if (!offering) {
    return c.json(
      {
        error:
          'a purchase must reference a server-priced partner offering; the catalog lands with the land epic',
        code: 'offering_required',
      },
      400,
    );
  }

  // ── (Reached ONLY when an admin enabled fulfillment AND an offering resolves) ─
  // Defense in depth: re-validate the persisted payout pubkey (a corrupted row
  // must never mint an unsettleable / mis-recipient quote).
  if (!isValidBase58Pubkey(storefront.payoutPubkey)) {
    console.error('[partner-storefront] stored payoutPubkey invalid — refusing quote', { slug });
    return c.json({ error: 'storefront_misconfigured', code: 'storefront_misconfigured' }, 503);
  }

  const network = resolvePartnerNetwork();
  const asset: X402Asset = 'usdc';
  // Facilitator gas signer — same contract as ct-topup: real SVM facilitators
  // 400 missing_fee_payer without it; null (mock) → omitted.
  const feePayer = await resolveFacilitatorFeePayer(network);
  const quote = buildPartnerPurchaseQuote({
    payoutPubkey: storefront.payoutPubkey,
    asset,
    usdCents: offering.priceUsdCents,
    network,
    resource: {
      url: '/api/partner/storefront/settle',
      description: `${storefront.displayName} — $${(offering.priceUsdCents / 100).toFixed(2)} USDC (paid directly to the partner)`,
    },
    feePayer: feePayer ?? undefined,
  });

  // NO-CUSTODY assertion (belt-and-suspenders): the quote recipient MUST be the
  // partner payout pubkey, never any ClawVille-controlled wallet. If a future
  // edit ever bound `payTo` to our merchant wallet this trips.
  if (quote.accepts[0]?.payTo !== storefront.payoutPubkey) {
    console.error('[partner-storefront] payTo binding mismatch — refusing quote');
    return c.json({ error: 'quote_binding_error', code: 'quote_binding_error' }, 500);
  }

  c.header('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(quote), 'utf8').toString('base64'));
  c.header('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED');
  return c.json(
    {
      slug,
      offeringId,
      payTo: storefront.payoutPubkey,
      asset,
      network,
      accepts: quote.accepts,
      x402Version: quote.x402Version,
      buyerAvatarId: identity.avatarId,
    },
    402,
  );
});

// ---------------------------------------------------------------------------
// POST /settle — buyer settles a paid partner purchase
// ---------------------------------------------------------------------------
// Same Rule E5 parity + same gate + same offering-deferral as /quote. When the
// gate opens AND an offering exists (future), the critical section is serialized
// per (slug, idempotencyKey) and the payment is verify+settled through the
// facilitator to the PARTNER'S payout — NEVER our wallet, NEVER a CT credit.
// ---------------------------------------------------------------------------

const settleSchema = z.object({
  slug: z.string().min(3).max(64),
  offeringId: z.string().min(1).max(128),
});

partnerStorefrontRoutes.post('/settle', requireAuthOrAgentSession, async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!storefrontPurchaseRateLimiter.check(ip)) {
    return c.json({ error: 'rate_limited', code: 'rate_limited' }, 429);
  }

  const identity = c.get('identity');

  // 1) Idempotency-Key header is REQUIRED on settle (terminal money action).
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey) {
    return c.json({ error: 'idempotency_key_required', code: 'idempotency_key_required' }, 400);
  }
  if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN) {
    return c.json({ error: 'idempotency_key_too_long', code: 'idempotency_key_too_long' }, 400);
  }

  // 2) Payment header (PAYMENT-SIGNATURE preferred, X-PAYMENT fallback — same
  //    order @x402/hono reads). Missing ⇒ 402 (pay first).
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
  const { slug, offeringId } = parsed.data;

  // Load the storefront for THIS partner + slug.
  const storefront = await db.query.partnerStorefronts.findFirst({
    where: and(eq(partnerStorefronts.slug, slug), eq(partnerStorefronts.partnerId, PARTNER_ID)),
  });
  if (!storefront) {
    return c.json({ error: 'storefront_not_found', code: 'storefront_not_found' }, 404);
  }

  // ── THE GATE ── (fires for every partner today; before any settle) ──────────
  if (isStorefrontFulfillmentGated(storefront)) {
    return c.json(
      {
        error: 'partner direct-USDC fulfillment is not enabled for this storefront',
        code: 'partner_fulfillment_gated',
      },
      503,
    );
  }

  // ── Server-priced offering (catalog is land-deferred) → 400 today ──────────
  const offering = await resolvePartnerOffering(storefront, offeringId);
  if (!offering) {
    return c.json(
      {
        error:
          'a purchase must reference a server-priced partner offering; the catalog lands with the land epic',
        code: 'offering_required',
      },
      400,
    );
  }

  // ── (Reached ONLY when an admin enabled fulfillment AND an offering resolves) ─
  // Defense in depth on the persisted recipient before we settle real USDC.
  if (!isValidBase58Pubkey(storefront.payoutPubkey)) {
    console.error('[partner-storefront] stored payoutPubkey invalid — refusing settle', { slug });
    return c.json({ error: 'storefront_misconfigured', code: 'storefront_misconfigured' }, 503);
  }

  // Serialize the critical section per (slug, idempotencyKey). Two concurrent
  // settles of the SAME (slug, key) run strictly one-after-the-other so a
  // duplicate submit can't double-drive the facilitator settle in-process.
  //
  // IDEMPOTENCY BACKSTOP (this Phase, no durable partner-purchase table — that is
  // land-owned): the FACILITATOR enforces on-chain single-settle of a payment in
  // prod (a payment is bound to its nonce/deadline, so a replayed payment header
  // settles at most once on-chain), and this per-key mutex prevents concurrent
  // double-submit within the process. A durable `service_purchases(kind='partner')`
  // recording (and cross-process idempotency) lands with the land epic.
  return withKeyedMutex(`partner-settle:${slug}:${idempotencyKey}`, async () => {
    const network = resolvePartnerNetwork();
    const asset: X402Asset = 'usdc';
    // Re-derive the EXACT requirements SERVER-SIDE (never the client echo), the
    // SAME way /quote built them, so the facilitator binds the payment to the
    // partner's payout + the server-priced amount. Same memoized feePayer as
    // /quote (real facilitators 400 missing_fee_payer without it).
    const settleFeePayer = await resolveFacilitatorFeePayer(network);
    const quote = buildPartnerPurchaseQuote({
      payoutPubkey: storefront.payoutPubkey,
      asset,
      usdCents: offering.priceUsdCents,
      network,
      feePayer: settleFeePayer ?? undefined,
    });
    const requirements = quote.accepts[0];

    const result = await settlePartnerPurchase({
      paymentHeader,
      requirements,
      expectedPayoutPubkey: storefront.payoutPubkey,
    });
    if (!result.settled || !result.txSignature) {
      // Clean 402 on any verify/settle failure — NEVER a 5xx (verifyAndSettle's
      // contract). No CT is ever credited either way.
      return c.json(
        {
          error: 'payment_not_settled',
          code: 'payment_not_settled',
          reason: result.failureReason ?? 'unsettled',
        },
        402,
      );
    }

    // CREDIT NO CT — the buyer already received real off-platform value from the
    // partner. A durable `service_purchases(kind='partner')` recording is
    // land-owned and deferred.
    return c.json({
      settled: true,
      txSignature: result.txSignature,
      buyerAvatarId: identity.avatarId,
    });
  });
});

export default partnerStorefrontRoutes;
