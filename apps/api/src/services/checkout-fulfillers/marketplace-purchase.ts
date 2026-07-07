/**
 * MARKETPLACE PURCHASE FULFILLER (Tokenomics C — marketplace stage / C4, 2026-07-07).
 *
 * The buyer path of the P2P marketplace IS a generic x402 checkout
 * (`itemKind:'marketplace_purchase'`, `itemRef` = the listing id): the buyer
 * calls the EXISTING `/api/x402/checkout/quote` + `/settle`; this module is
 * the kind-specific quote resolver + preflight + fulfiller. Registers itself
 * on import (side-effect) — `routes/x402-checkout.ts` imports the resolver,
 * so mounting the checkout route wires the fulfiller.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⛔ FLAG-GATED OFF — `MARKETPLACE_SETTLE_ENABLED` (default: DISABLED)
 * ═══════════════════════════════════════════════════════════════════════════
 * Settlement refuses at THREE layers unless the env is EXACTLY 'true':
 *   1. QUOTE  — `resolveMarketplaceCheckoutItem` refuses
 *      `marketplace_settle_disabled`, so no 402 challenge (and no pending
 *      checkout row) is ever issued while gated: a buyer can't even be ASKED
 *      to pay.
 *   2. PREFLIGHT — the settle-side re-check refuses the same code BEFORE the
 *      facilitator is called: the row stays PENDING and NO USDC moves.
 *   3. FULFILLER — the in-tx hard gate (the C4-specified refusal): a stray
 *      settle that somehow reaches fulfillment throws
 *      `CheckoutFulfillmentRefusal('marketplace_settle_disabled')`, the whole
 *      settle tx rolls back, and the checkout engine records the LOUD
 *      manual-refund terminal state — nothing half-completes.
 * Flipping the flag is a deliberate ops action AFTER the review chain
 * (token-economy manager → adversarial money auditor → Codex) clears this
 * stage. This diff flips NOTHING.
 *
 * ── THE MONEY MODEL (trap 1 + 2 — LEDGER-ONLY, USDC-settles-underneath) ─────
 * The buyer paid REAL USDC to the merchant wallet. This fulfiller:
 *   - debits ZERO internal vCLAW from the buyer and credits ZERO to the seller
 *     or treasury — it imports NOTHING from claw-token-ledger; the seller is
 *     paid in ON-CHAIN CLV, later, behind review (below);
 *   - owes the market the FULL settled USDC as a CLV buy:
 *     `enqueueClvBuy(reason:'marketplace_purchase', sourceRef: checkoutId)` on
 *     the SAME settle tx (the C3 queue — buyer USDC → swap wallet → planned
 *     CLV buy);
 *   - records the 4.44% (444 bps) treasury CLV RAKE as an INTENT and the
 *     seller's 95.56% CLV payout as a QUEUED `payout_status='pending_review'`
 *     row on `market_settlements` — NEVER an internal-vCLAW credit, NEVER an
 *     on-chain send. ¢-peg exactness: `usd_cents × 444` and `usd_cents × 9556`
 *     are EXACT integer µUSD, so rake + payout == usd_basis with ZERO rounding
 *     (`splitMarketplaceUsd`; DB CHECK `market_settlements_conservation`).
 *
 * ── EXACTLY-ONCE (trap 3) ────────────────────────────────────────────────────
 * The checkout engine already guarantees the fulfiller runs once per settled
 * signature (partial-UNIQUE `x402_checkouts_txsig_unique`; a 23505 replay
 * never re-runs fulfillment). ON TOP of that, defense-in-depth INSIDE the
 * fulfiller: `market_settlements.checkout_id` is UNIQUE and an existing
 * settlement row for this checkoutId short-circuits to a no-op replay — a
 * replay can never double-queue the CLV buy or double-record the seller
 * payout intent.
 *
 * ── LOCK ORDER ───────────────────────────────────────────────────────────────
 * (1) the LISTING row FOR UPDATE (market-owned — serializes settle vs cancel),
 * (2) per-SELLER advisory lock, (3) the parcel row FOR UPDATE — (2)→(3) is the
 * land lock order every land mutation uses (advisory OUTER, parcel INNER), so
 * no AB-BA edge against land paths; (1) is a market-only table land never
 * locks.
 *
 * ── CODEX-GATED SEAMS (recorded intent → later, reviewed execution) ─────────
 * 1. SELLER CLV PAYOUT + TREASURY RAKE EXECUTION — a later, Codex-reviewed
 *    payout executor reads `market_settlements` rows in 'pending_review',
 *    re-validates the destination wallet, executes the on-chain CLV sends
 *    (95.56% seller / 4.44% treasury) out of the executed C3 buy, and flips
 *    `payout_status`. v1 NEVER signs or sends — see the marked seam below.
 * 2. DEED TRANSFER — `land_parcels.owner_avatar_id` flips ONLY via a later
 *    Codex+land-domain-gated transfer executor (tenure/escrow semantics are
 *    land's to review). Until it runs, the `market_deed_locks` row stays HELD
 *    and the settlement's `deed_transferred_at` stays NULL. v1 records the
 *    transfer INTENT (the settled listing + settlement row) and never touches
 *    land ownership.
 */

import { sql } from 'drizzle-orm';
import { db } from '@clawville/database';
import {
  registerFulfiller,
  registerCheckoutPreflight,
  CheckoutFulfillmentRefusal,
  type CheckoutFulfiller,
  type CheckoutPreflight,
} from '../x402-checkout';
import { enqueueClvBuy } from '../clv-swap-executor';

// ---------------------------------------------------------------------------
// Flag gate + rake split (exported for tests + the routes layer)
// ---------------------------------------------------------------------------

/** Treasury rake on every marketplace settlement: 4.44% of the USD basis. */
export const MARKETPLACE_RAKE_BPS = 444;
/** The seller's share: 95.56%. */
export const MARKETPLACE_SELLER_BPS = 10_000 - MARKETPLACE_RAKE_BPS;

/** The settlement flag — DEFAULT OFF. Only the literal string 'true' enables. */
export function isMarketplaceSettleEnabled(): boolean {
  return process.env.MARKETPLACE_SETTLE_ENABLED === 'true';
}

/** Render integer µUSD to a plain 6-dp decimal string (numeric(20,6) shape). */
function microToUsd(micro: bigint): string {
  const ints = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0');
  return `${ints}.${frac}`;
}

export interface MarketplaceUsdSplit {
  /** 4.44% of the basis — the treasury CLV-rake intent. */
  rakeUsd: string;
  /** 95.56% of the basis — the seller CLV-payout intent. */
  sellerPayoutUsd: string;
  /** The full settled basis (rake + payout, exactly). */
  totalUsd: string;
}

/**
 * Split the settled cents into the rake + seller-payout intents. EXACT at the
 * ¢-peg: 1¢ = 10,000 µUSD, so `usdCents × 444` (rake) and `usdCents × 9556`
 * (seller) are integers that sum to `usdCents × 10,000` — zero rounding, no
 * µUSD created or destroyed. The DB `market_settlements_conservation` CHECK
 * (rake + payout = basis) is the backstop.
 */
export function splitMarketplaceUsd(usdCents: number): MarketplaceUsdSplit {
  if (!Number.isInteger(usdCents) || usdCents <= 0) {
    throw new Error(`[market] splitMarketplaceUsd: usdCents must be a positive integer, got ${usdCents}`);
  }
  const cents = BigInt(usdCents);
  const rakeMicro = cents * BigInt(MARKETPLACE_RAKE_BPS);
  const sellerMicro = cents * BigInt(MARKETPLACE_SELLER_BPS);
  const totalMicro = cents * 10_000n;
  // Tripwire (unreachable by construction — RAKE + SELLER == 10_000 bps).
  if (rakeMicro + sellerMicro !== totalMicro) {
    throw new Error('[market] rake split conservation violated');
  }
  return {
    rakeUsd: microToUsd(rakeMicro),
    sellerPayoutUsd: microToUsd(sellerMicro),
    totalUsd: microToUsd(totalMicro),
  };
}

// ---------------------------------------------------------------------------
// Quote resolver + preflight (read-only)
// ---------------------------------------------------------------------------

export type MarketplaceCheckoutRefusal =
  | 'marketplace_settle_disabled'
  | 'listing_not_found'
  | 'listing_not_active'
  | 'listing_expired'
  | 'own_listing'
  | 'earned_not_available'
  | 'seller_no_longer_owns_parcel';

export type MarketplaceCheckoutItem =
  | { ok: true; priceVclaw: number; listingId: string; sellerAvatarId: string }
  | { ok: false; code: MarketplaceCheckoutRefusal };

/** The columns every check/mutation here reads (PG wire types — coerce!). */
type MarketListingRow = {
  id: string;
  seller_avatar_id: string;
  item_kind: string;
  item_ref: string;
  price_vclaw: number | string;
  status: string;
  seller_wallet_pubkey: string | null;
  expires_at: string | Date | null;
};

const LISTING_COLS = sql.raw(
  'id, seller_avatar_id, item_kind, item_ref, price_vclaw, status, seller_wallet_pubkey, expires_at',
);

function guardListing(
  row: MarketListingRow | undefined,
  buyerAvatarId: string,
): { ok: true; listing: MarketListingRow } | { ok: false; code: MarketplaceCheckoutRefusal } {
  if (!row) return { ok: false, code: 'listing_not_found' };
  // trap 6 — no earned_bundle can exist in v1 (list-time blocked); total anyway.
  if (row.item_kind === 'earned_bundle') return { ok: false, code: 'earned_not_available' };
  if (row.status !== 'active') return { ok: false, code: 'listing_not_active' };
  if (row.expires_at != null && new Date(row.expires_at).getTime() <= Date.now()) {
    // v1 expiry is a PREDICATE (see the schema state machine): refused here,
    // hidden from browse; the row itself stays 'active' and cancellable.
    return { ok: false, code: 'listing_expired' };
  }
  // Self-buy refused: no wash-trading a deed to yourself through the rake.
  if (row.seller_avatar_id === buyerAvatarId) return { ok: false, code: 'own_listing' };
  return { ok: true, listing: row };
}

/**
 * QUOTE-TIME resolver — the checkout route calls this to price the item
 * SERVER-SIDE (the listing's `price_vclaw`; the client never supplies a
 * price). Read-only, unlocked — the fulfiller re-checks authoritatively under
 * the row locks. Refuses `marketplace_settle_disabled` while the flag is off
 * so NO 402 challenge (and no pending checkout row) is ever issued while
 * settlement is gated.
 */
export async function resolveMarketplaceCheckoutItem(
  buyerAvatarId: string,
  listingId: string,
): Promise<MarketplaceCheckoutItem> {
  if (!isMarketplaceSettleEnabled()) {
    return { ok: false, code: 'marketplace_settle_disabled' };
  }
  const rows = await db.execute<MarketListingRow>(
    sql`SELECT ${LISTING_COLS} FROM market_listings WHERE id = ${listingId}`,
  );
  const guarded = guardListing(rows[0], buyerAvatarId);
  if (!guarded.ok) return { ok: false, code: guarded.code };
  const listing = guarded.listing;

  // Read-only deed sanity: the seller must still own the parcel. (Land-side
  // release/eviction paths don't consult the market lock — C4 constraint — so
  // this predicate + the fulfiller's under-lock re-check are the real guard.)
  if (listing.item_kind === 'land_deed') {
    const parcels = await db.execute<{ owner_avatar_id: string | null }>(
      sql`SELECT owner_avatar_id FROM land_parcels WHERE id = ${listing.item_ref}`,
    );
    if (!parcels[0] || parcels[0].owner_avatar_id !== listing.seller_avatar_id) {
      return { ok: false, code: 'seller_no_longer_owns_parcel' };
    }
  }

  return {
    ok: true,
    priceVclaw: Number(listing.price_vclaw),
    listingId: listing.id,
    sellerAvatarId: listing.seller_avatar_id,
  };
}

/** Settle-time READ-ONLY preflight — same checks, run just before the
 *  facilitator call, so a listing cancelled/expired/parcel-released since the
 *  quote (or a still-gated flag) refuses with the row still PENDING and NO
 *  money moved. */
const marketplacePreflight: CheckoutPreflight = async ({ subject, itemRef }) => {
  const item = await resolveMarketplaceCheckoutItem(subject.avatarId, itemRef);
  return item.ok ? { ok: true } : { ok: false, code: item.code };
};

// ---------------------------------------------------------------------------
// The fulfiller — runs INSIDE the checkout settle tx (all writes on ctx.tx)
// ---------------------------------------------------------------------------

type SettlementRow = {
  id: string;
  clv_buy_queue_id: string;
  rake_usd: string;
  seller_payout_usd: string;
  payout_status: string;
};

const marketplaceFulfiller: CheckoutFulfiller = async (ctx) => {
  // ⛔ HARD FLAG GATE (trap 8) — the C4-specified in-tx refusal. Even if a
  // pending checkout somehow exists while gated, fulfillment refuses, the
  // settle tx rolls back, and the engine records the loud manual-refund
  // terminal state. Nothing half-completes.
  if (!isMarketplaceSettleEnabled()) {
    throw new CheckoutFulfillmentRefusal('marketplace_settle_disabled');
  }

  const buyerAvatarId = ctx.subject.avatarId;

  // (1) Listing row FOR UPDATE — serializes against cancel + concurrent settles.
  const listings = await ctx.tx.execute<MarketListingRow>(
    sql`SELECT ${LISTING_COLS} FROM market_listings WHERE id = ${ctx.itemRef} FOR UPDATE`,
  );
  const listingRow = listings[0];
  if (!listingRow) throw new CheckoutFulfillmentRefusal('listing_not_found');

  // (2) EXACTLY-ONCE defense-in-depth: one settled checkout ⇒ one settlement.
  // The engine never re-runs a fulfilled signature, but if this checkoutId is
  // ever re-driven, the existing settlement replays as a NO-OP — no second
  // CLV-buy enqueue, no second payout intent.
  const prior = await ctx.tx.execute<SettlementRow>(
    sql`SELECT id, clv_buy_queue_id, rake_usd, seller_payout_usd, payout_status
        FROM market_settlements WHERE checkout_id = ${ctx.checkoutId}`,
  );
  const priorRow = prior[0];
  if (priorRow) {
    return {
      fulfilled: true,
      detail: {
        replay: true,
        settlementId: priorRow.id,
        listingId: listingRow.id,
        clvBuyQueueId: priorRow.clv_buy_queue_id,
        rakeUsd: priorRow.rake_usd,
        sellerPayoutUsd: priorRow.seller_payout_usd,
        payoutStatus: priorRow.payout_status,
      },
    };
  }

  // (3) AUTHORITATIVE re-checks under the lock (the preflight made every
  // failure here a near-zero race window). A refusal rolls the settle tx back
  // and the engine records the loud fulfillment_refused manual-refund state.
  const guarded = guardListing(listingRow, buyerAvatarId);
  if (!guarded.ok) throw new CheckoutFulfillmentRefusal(guarded.code);
  const listing = guarded.listing;
  if (Number(listing.price_vclaw) !== ctx.priceVclaw) {
    // The checkout row froze the price at quote; a drifted listing price is a
    // wiring bug, not a payable state — refuse rather than mis-split.
    throw new CheckoutFulfillmentRefusal('price_mismatch');
  }

  // (4) Deed guards — land lock order: advisory(SELLER) OUTER, parcel INNER.
  let parcelCode: string | null = null;
  if (listing.item_kind === 'land_deed') {
    await ctx.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${listing.seller_avatar_id}, 0))`,
    );
    const parcels = await ctx.tx.execute<{
      id: string;
      parcel_code: string;
      owner_avatar_id: string | null;
    }>(
      sql`SELECT id, parcel_code, owner_avatar_id
          FROM land_parcels WHERE id = ${listing.item_ref} FOR UPDATE`,
    );
    const parcel = parcels[0];
    if (!parcel || parcel.owner_avatar_id !== listing.seller_avatar_id) {
      throw new CheckoutFulfillmentRefusal('seller_no_longer_owns_parcel');
    }
    parcelCode = parcel.parcel_code;
    const locks = await ctx.tx.execute<{ parcel_id: string }>(
      sql`SELECT parcel_id FROM market_deed_locks
          WHERE parcel_id = ${listing.item_ref} AND listing_id = ${listing.id}`,
    );
    if (!locks[0]) {
      // The market lock vanished out from under a live listing — refuse loud.
      throw new CheckoutFulfillmentRefusal('deed_lock_missing');
    }
  }

  // (5) CLAIM: active → pending_settlement, bound to THIS checkout + buyer.
  const claimed = await ctx.tx.execute<{ id: string }>(
    sql`UPDATE market_listings
        SET status = 'pending_settlement',
            buyer_avatar_id = ${buyerAvatarId},
            settlement_checkout_id = ${ctx.checkoutId},
            updated_at = now()
        WHERE id = ${listing.id} AND status = 'active'
        RETURNING id`,
  );
  if (!claimed[0]) throw new CheckoutFulfillmentRefusal('listing_not_active');

  // (6) The owed USDC→CLV buy — the FULL settled amount, SAME tx (commits or
  // rolls back with the settle). µUSD decimal string per the C3 seam contract.
  const split = splitMarketplaceUsd(ctx.usdCents);
  const { queueId } = await enqueueClvBuy(
    {
      amountUsdc: split.totalUsd,
      reason: 'marketplace_purchase',
      sourceRef: ctx.checkoutId,
      metadata: {
        listingId: listing.id,
        itemKind: listing.item_kind,
        itemRef: listing.item_ref,
        buyerAvatarId,
        sellerAvatarId: listing.seller_avatar_id,
        subjectKind: ctx.subject.kind,
        txSignature: ctx.txSignature,
      },
    },
    ctx.tx,
  );

  // (7) The settlement-intent row: rake + payout intents, payout QUEUED
  // 'pending_review'. checkout_id UNIQUE = the exactly-once settlement key.
  //
  // CODEX-GATED SEAM: on-chain CLV payout + rake EXECUTION. A later,
  // Codex-reviewed payout executor would — for each 'pending_review' row,
  // ONLY after the review chain clears it — re-validate seller_payout_pubkey,
  // send the seller's CLV (seller_payout_usd worth) and the treasury's rake
  // (rake_usd worth) out of the executed C3 buy, and flip payout_status
  // (approved → paid). v1 DELIBERATELY stops at this INSERT: no key is
  // decrypted, no tx is built, no CLV moves.
  const settleMeta = JSON.stringify({
    subjectKind: ctx.subject.kind,
    network: ctx.network,
    settlePayer: ctx.settlePayer,
    itemKind: listing.item_kind,
    itemRef: listing.item_ref,
    parcelCode,
  });
  const inserted = await ctx.tx.execute<{ id: string }>(
    sql`INSERT INTO market_settlements
          (listing_id, checkout_id, tx_signature, buyer_avatar_id, seller_avatar_id,
           price_vclaw, usd_cents, usd_basis, clv_buy_queue_id, rake_bps, rake_usd,
           seller_payout_usd, payout_status, seller_payout_pubkey, metadata)
        VALUES
          (${listing.id}, ${ctx.checkoutId}, ${ctx.txSignature}, ${buyerAvatarId},
           ${listing.seller_avatar_id}, ${ctx.priceVclaw}, ${ctx.usdCents},
           ${split.totalUsd}, ${queueId}, ${MARKETPLACE_RAKE_BPS}, ${split.rakeUsd},
           ${split.sellerPayoutUsd}, 'pending_review', ${listing.seller_wallet_pubkey},
           ${settleMeta}::jsonb)
        RETURNING id`,
  );
  const settlementRow = inserted[0];
  if (!settlementRow) throw new Error('[market] settlement insert returned no row');

  // (8) pending_settlement → settled (same tx — the intents are recorded).
  //
  // CODEX-GATED SEAM: DEED TRANSFER. The parcel's owner_avatar_id flip is a
  // later Codex+land-domain-gated executor (tenure/escrow transfer semantics
  // are land's to review). Until it runs: the market_deed_locks row stays
  // HELD, deed_transferred_at stays NULL, and the parcel remains with the
  // seller. The deed transfer completes ONLY when that executor stamps
  // deed_transferred_at. v1 records the intent and never touches land state.
  await ctx.tx.execute(
    sql`UPDATE market_listings SET status = 'settled', updated_at = now()
        WHERE id = ${listing.id} AND status = 'pending_settlement'`,
  );

  return {
    fulfilled: true,
    detail: {
      listingId: listing.id,
      settlementId: settlementRow.id,
      itemKind: listing.item_kind,
      itemRef: listing.item_ref,
      priceVclaw: ctx.priceVclaw,
      rakeBps: MARKETPLACE_RAKE_BPS,
      rakeUsd: split.rakeUsd,
      sellerPayoutUsd: split.sellerPayoutUsd,
      payoutStatus: 'pending_review',
      clvBuyQueueId: queueId,
      deedTransfer: listing.item_kind === 'land_deed' ? 'pending_codex_gated_transfer' : null,
    },
  };
};

registerFulfiller('marketplace_purchase', marketplaceFulfiller);
registerCheckoutPreflight('marketplace_purchase', marketplacePreflight);
