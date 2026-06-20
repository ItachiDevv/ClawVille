// FEATURE_GATE: partner_storefront_tier
// Status: VISIBLE-BUT-GATED (Phase D, 2026-06-19). The partner direct-USDC
//   settlement PRIMITIVE (x402-payai buildPartnerPurchaseQuote/settlePartnerPurchase),
//   the ed25519-signed partner-storefront REGISTRATION, and the admin-only
//   `fulfillmentEnabled` flip are all REAL and wired. The purchase endpoint is
//   reachable but returns 503 `partner_fulfillment_gated` BEFORE any settlement
//   while `fulfillment_enabled=false` (the schema default — always, until an
//   admin flips it post a custody/KYC/age safety review). The land-BOUND listing
//   UX (per-parcel `service_listings.kind='partner'`) is DEFERRED to land Phase 5
//   (the listing table needs a land `structure_id` FK that doesn't exist yet) —
//   so this Phase ships the settlement primitive + gated registration only.
// Metric to graduate: a partner cleared a custody/KYC/age safety review AND an
//   admin flipped `fulfillment_enabled=true` for a real storefront AND a real
//   buyer→partner USDC purchase settled (records a `service_purchases` row).
// Current reading: 0 (no storefront fulfillment-enabled; no settled partner purchase).
// Review deadline: 2026-09-19.
// On deadline: if no partner is review-cleared, keep gated (do NOT enable any
//   fulfillment); re-evaluate whether the partner tier graduates or is removed.
// Reference: PLAN.md §2 Phase D · land.ts schema `partner_storefronts` · CLAUDE.md
//   Rule E5 (parity) + "PROTECTED partner surface" · improvements.md §7.

/**
 * Partner DIRECT-USDC storefront routes (Phase D — buyer → partner, WE NEVER
 * CUSTODY).
 *
 *   POST /api/partner/:partnerId/storefront                  — register/upsert a
 *        partner storefront (ed25519 partner-signed write, ±5 min window).
 *   POST /api/partner/:partnerId/storefront/admin/fulfillment — admin-only flip
 *        of `fulfillment_enabled` (ADMIN_USER_IDS via adminOnly — NEVER the
 *        partner key).
 *   POST /api/partner/:partnerId/storefront/purchase          — gated partner
 *        direct-USDC purchase. Returns 503 `partner_fulfillment_gated` BEFORE any
 *        settlement while the storefront is not fulfillment-enabled (always, today).
 *
 * ADDITIVE — this is a NEW router mounted at a NEW path. It does NOT touch the
 * live `/api/partner/hatcher/*` registration / cognition / launch routes or their
 * behavior. The Hatcher partner runs LIVE against our staging/prod and this Phase
 * is STRICTLY additive (the protected-partner-surface rule).
 *
 * NO-CUSTODY INVARIANT: a partner purchase pays the partner's OWN Solana pubkey
 * (`partner_storefronts.payout_pubkey`) directly — never our merchant/treasury
 * wallet — and the FACILITATOR (PayAI in prod, the mock in tests) performs the
 * on-chain verify+settle. ClawVille never signs, never broadcasts, never holds
 * the USDC. We only RECORD the settled tx (and credit NO CT — the buyer received
 * real off-platform value).
 *
 * SECURITY:
 *   - Partner WRITES (register) are ed25519-verified over the domain-separated
 *     write challenge (method+path+timestamp+body-hash) with a ±5 min window via
 *     `verifyPartnerWriteSignature` — the SAME primitive the live partner-hatcher
 *     route uses (`ALLOW_TEST_PARTNER_PUBKEY` stays staging-only, crash-loud on
 *     prod). A partner can register/update its OWN storefront but CANNOT flip the
 *     fulfillment gate.
 *   - The fulfillment gate flips ONLY via `adminOnly` (ADMIN_USER_IDS / the dash
 *     cookie), after a custody/KYC/age safety review — out-of-band, never via a
 *     partner key.
 *   - `payoutPubkey` is base58-validated (32-byte ed25519) at write time so a
 *     malformed recipient can never be persisted and later quoted.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import bs58 from 'bs58';
import {
  db,
  partnerStorefronts,
  and,
  eq,
  sql,
} from '@clawville/database';
import type { AppContext } from '../types';
import { sessionMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/admin-only';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { verifyPartnerWriteSignature } from '../services/partner-signature';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import {
  buildPartnerPurchaseQuote,
  type X402Asset,
  type X402Network,
} from '../services/x402-payai';

// `DualContext` = base app context (user/session for the admin + partner-signed
// paths) + the `identity` variable `requireAuthOrAgentSession` sets on the
// purchase route. Mirrors land.ts so `c.get('identity')` is typed without a cast
// and the partner-signed/admin routes (which never read identity) still typecheck.
type DualContext = AppContext & ActivityAuthContext;

export const partnerStorefrontRoutes = new Hono<DualContext>();

// Bound the request body on EVERY route BEFORE the handlers run. The register
// path does `await c.req.text()` (buffering the whole body) and verifies the
// ed25519 signature AFTER the read, so without this an UNAUTHENTICATED caller
// could stream a huge body and exhaust memory before the 401 fires (the SEC-1
// guard the live partner-hatcher mount applies). 64 KB is far above any
// legitimate compact-JSON storefront payload. Mirrors the partner-hatcher cap.
partnerStorefrontRoutes.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large', code: 'payload_too_large' }, 413),
  }),
);

// Populate `c.get('user')` from the Lucia cookie so the admin-flip route's
// `adminOnly` can read it. The partner-signed register/purchase paths read their
// own headers, so a null user here is harmless for them.
partnerStorefrontRoutes.use('*', sessionMiddleware);

/** Per-IP register limiter (mirrors partner-hatcher's per-IP guard — a single
 *  partner's egress collapses to one IP; a per-partner-keyed limiter is the
 *  later Redis fix). */
const storefrontWriteRateLimiter = createRateLimiter({ maxPerWindow: 30, windowMs: 60_000 });
/** Per-IP purchase limiter — separate bucket so a buy loop can't starve writes. */
const storefrontPurchaseRateLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });

/** Resolve the partner-USDC network from env. Devnet-first; mainnet is a config
 *  flip after a funded settled smoke — the SAME rule as the on-ramp. Unset ⇒
 *  devnet (we never inherit the legacy x402-config mainnet default for money). */
function resolvePartnerNetwork(): X402Network {
  const explicit = process.env.X402_TOPUP_NETWORK?.trim().toLowerCase();
  if (explicit === 'mainnet') return 'mainnet';
  return 'devnet';
}

/** Validate a base58 ed25519 pubkey (32 bytes). Returns false on any decode
 *  failure or wrong length — a malformed recipient must never be persisted. */
function isValidBase58Pubkey(candidate: string): boolean {
  try {
    return bs58.decode(candidate).length === 32;
  } catch {
    return false;
  }
}

/**
 * Verify the ed25519 partner WRITE signature over the raw body, for `partnerId`
 * from the path. Reads the raw body BEFORE JSON.parse (so the signed bytes are
 * the exact wire bytes) and returns the parsed json only on a valid signature.
 * Mirrors `partner-hatcher.ts readSignedBody` but is path-partner-scoped (the
 * partnerId is a route param, validated against the allowlist inside
 * `verifyPartnerWriteSignature`). Header names match the Hatcher scheme
 * (`X-Hatcher-*`) since `hatcher` is the only live partner — kept generic for a
 * future partner by reading the same headers.
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
// POST /api/partner/:partnerId/storefront — register / upsert a storefront
// ---------------------------------------------------------------------------
// ed25519 partner-signed (±5 min). Upserts on the UNIQUE `slug`. `parcelId` is
// OPTIONAL/nullable (land is deferred). `fulfillment_enabled` is NEVER settable
// here — it defaults false and only an admin flips it.
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
  // RESERVED: land binding is deferred — accepted but the parcel FK is left null
  // in v1 (no land Phase 5 parcels exist to reference). We DO NOT persist a
  // partner-claimed parcelId today (a partner cannot self-assign prime land).
  // platformFeeBps stays 0 (reserved).
});

partnerStorefrontRoutes.post('/:partnerId/storefront', async (c) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!storefrontWriteRateLimiter.check(ip)) {
    return c.json({ error: 'rate_limited', code: 'rate_limited' }, 429);
  }

  const partnerId = c.req.param('partnerId');

  // ed25519 partner-signed write (verifies BEFORE parsing the body). An invalid
  // signature / unknown partner / stale timestamp → opaque 401 (the verify
  // collapses every failure to a generic reason).
  const signed = await readSignedPartnerBody(c, partnerId);
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
  //   - `fulfillment_enabled` is NEVER directly written by a partner (omitted on
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
        partnerId,
        slug,
        displayName,
        payoutPubkey,
        status: status ?? 'pending',
        // fulfillmentEnabled OMITTED → default false. parcelId OMITTED → null.
      })
      .onConflictDoUpdate({
        target: partnerStorefronts.slug,
        set: {
          // Re-bind mutable fields, but ONLY for a row owned by THIS partner —
          // the WHERE guard below prevents partner A from overwriting partner B's
          // slug-owned storefront.
          partnerId,
          displayName,
          payoutPubkey,
          // Gate reset on payout change (see invariant above). If the new payout
          // differs from the stored one, force fulfillment OFF + status back to
          // pending; otherwise leave both as they are (don't clobber an admin's
          // prior enable). EXCLUDED is the proposed (new) row; the bare column is
          // the existing row's value.
          fulfillmentEnabled: sql`CASE WHEN ${partnerStorefronts.payoutPubkey} IS DISTINCT FROM excluded.payout_pubkey THEN false ELSE ${partnerStorefronts.fulfillmentEnabled} END`,
          status: sql`CASE WHEN ${partnerStorefronts.payoutPubkey} IS DISTINCT FROM excluded.payout_pubkey THEN 'pending'::partner_storefront_status ELSE COALESCE(${status ?? null}::partner_storefront_status, ${partnerStorefronts.status}) END`,
          updatedAt: new Date(),
        },
        // Ownership guard: only update if the existing row already belongs to
        // this partner. A slug owned by a different partner → no update → we
        // detect the unchanged/foreign row below and 409.
        setWhere: eq(partnerStorefronts.partnerId, partnerId),
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
// POST /api/partner/:partnerId/storefront/admin/fulfillment — ADMIN-ONLY flip
// ---------------------------------------------------------------------------
// Flips `fulfillment_enabled` for a storefront. Gated by `adminOnly`
// (ADMIN_USER_IDS / dash cookie) — NEVER the partner key. This is the safety
// gate that opens (or closes) a partner's real-USDC fulfillment AFTER an
// out-of-band custody/KYC/age review.
// ---------------------------------------------------------------------------

const flipSchema = z.object({
  slug: z.string().min(3).max(64),
  enabled: z.boolean(),
});

partnerStorefrontRoutes.post('/:partnerId/storefront/admin/fulfillment', adminOnly, async (c) => {
  const partnerId = c.req.param('partnerId');

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
    // enabling fulfillment makes the storefront `active` (the partner can only set
    // pending/suspended, never active, so the admin is the single authority that
    // makes a storefront sellable); disabling sets it back to `suspended` so a
    // closed gate also halts its operational state. The partner's own
    // pending/suspended setting is superseded once an admin has reviewed it.
    const [row] = await db
      .update(partnerStorefronts)
      .set({
        fulfillmentEnabled: enabled,
        status: enabled ? 'active' : 'suspended',
        updatedAt: new Date(),
      })
      .where(and(eq(partnerStorefronts.slug, slug), eq(partnerStorefronts.partnerId, partnerId)))
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
// POST /api/partner/:partnerId/storefront/purchase — GATED partner direct-USDC
// ---------------------------------------------------------------------------
// A buyer (human OR connected/hosted agent — Rule E5 parity via
// requireAuthOrAgentSession) pays the partner's payoutPubkey directly in USDC
// through the x402 facilitator; WE NEVER CUSTODY. BUT while the storefront is not
// fulfillment-enabled (always, today), this returns 503 `partner_fulfillment_gated`
// BEFORE any quote/settle. When the gate is open (admin-flipped), it returns the
// x402 v2 quote bound to the partner's payoutPubkey — the buyer pays the partner,
// settlement is recorded (NO CT credit), and the land-bound `service_listings`/
// `service_purchases` UX lands with land Phase 5.
//
// Why operate at the STOREFRONT level (not a `service_listings` row): a
// `service_listings` row REQUIRES a land `structure_id` FK (a `shop` on an owned
// parcel), and land is deferred — so there are no partner listings to buy today.
// We make the purchase endpoint reachable + correctly gated NOW by operating on a
// storefront-level offering, and 503 cleanly before the listing layer exists.
// ---------------------------------------------------------------------------

const purchaseSchema = z.object({
  slug: z.string().min(3).max(64),
  // USDC-ONLY: the x402 quote path always uses the USDC mint, so `sol` was a
  // mis-quote. Reject it at the boundary (matches ct-topup; X402Asset='usdc').
  asset: z.enum(['usdc']),
  usdCents: z.number().int().positive().max(1_000_000),
});

// Use ActivityAuthContext for the purchase handler so `c.get('identity')` is
// typed. `sessionMiddleware` already ran on '*' above (populates user for the
// human path); `requireAuthOrAgentSession` resolves human OR connected/hosted
// agent → a bound avatar (403 for an unbound/expired agent, never a guest demotion).
partnerStorefrontRoutes.post(
  '/:partnerId/storefront/purchase',
  requireAuthOrAgentSession,
  async (c) => {
    const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
    if (!storefrontPurchaseRateLimiter.check(ip)) {
      return c.json({ error: 'rate_limited', code: 'rate_limited' }, 429);
    }

    const partnerId = c.req.param('partnerId');
    // identity is set by requireAuthOrAgentSession (human OR agent → bound avatar).
    // We don't settle CT, but resolving identity here proves the buyer is a real
    // ledger subject (parity) and gives an audit anchor when fulfillment opens.
    const identity = c.get('identity');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json_body', code: 'invalid_json' }, 400);
    }
    const parsed = purchaseSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_request', code: 'invalid_request', details: parsed.error.flatten() },
        400,
      );
    }
    const { slug, asset, usdCents } = parsed.data as {
      slug: string;
      asset: X402Asset;
      usdCents: number;
    };

    // Load the storefront for THIS partner + slug.
    const storefront = await db.query.partnerStorefronts.findFirst({
      where: and(eq(partnerStorefronts.slug, slug), eq(partnerStorefronts.partnerId, partnerId)),
    });
    if (!storefront) {
      return c.json({ error: 'storefront_not_found', code: 'storefront_not_found' }, 404);
    }

    // ── THE GATE ──────────────────────────────────────────────────────────────
    // 503 BEFORE any quote/settle while fulfillment is disabled. This is the
    // visible-but-gated boundary: the primitive + registration are real, but no
    // partner USDC can be quoted/settled until an admin opens the gate post a
    // custody/KYC/age safety review. `fulfillment_enabled` defaults false and is
    // ONLY flippable by an admin — so this 503 fires for every partner today.
    if (!storefront.fulfillmentEnabled || storefront.status !== 'active') {
      return c.json(
        {
          error: 'partner direct-USDC fulfillment is not enabled for this storefront',
          code: 'partner_fulfillment_gated',
        },
        503,
      );
    }

    // ── THE OFFERING GUARD (FIX-2, price-authority) ────────────────────────────
    // A client-supplied `usdCents` MUST NEVER drive a settlement. There is NO
    // server-authored offering/price table yet — the land-bound
    // `service_listings(kind='partner')` row (price quoted server-side, FK to a
    // land `structure_id`) is DEFERRED to the land epic. Until a server-authored
    // offering exists, a purchase has no trustworthy price to quote, so we 501
    // `offering_required` BEFORE building ANY quote — REGARDLESS of the
    // fulfillment gate above. This makes a 1¢-buy-any-service exploit structurally
    // impossible even after an admin flips `fulfillmentEnabled` to true: the
    // quote is never built from the request body's `usdCents`. When the land epic
    // ships server-priced `service_listings`, this guard is replaced by a lookup
    // of the offering's authoritative price (the body carries an offeringId, not a
    // price). The `asset`/`usdCents` zod fields are accepted (wire-stable) but
    // intentionally NOT used to price anything here.
    void asset;
    void usdCents;
    return c.json(
      {
        error:
          'partner purchases require a server-authored offering; client-priced purchases are not accepted',
        code: 'offering_required',
        // Audit anchor: the buyer was a real ledger subject (parity proven) even
        // though no settlement is reachable yet.
        buyerAvatarId: identity.avatarId,
      },
      501,
    );
  },
);

export default partnerStorefrontRoutes;
