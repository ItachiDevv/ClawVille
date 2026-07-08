/**
 * P2P MARKETPLACE v1 — listing lifecycle + seller license (Tokenomics C4, 2026-07-07).
 *
 * The service layer behind `routes/market.ts`: the CLV seller-license gate and
 * the listing state machine's seller-driven transitions (create → active,
 * active → cancelled). The buyer-driven transitions (active →
 * pending_settlement → settled) live in the checkout fulfiller
 * (`checkout-fulfillers/marketplace-purchase.ts`) — the buyer path IS a C1
 * checkout, never a parallel buy route. Full state machine + escrow-lock doc:
 * `packages/database/src/schema/market.ts`.
 *
 * ── SELLER LICENSE (Resident license, trap 5 — FAIL-SOFT = REFUSE) ───────────
 * Listing requires holding ≥ `MARKET_SELLER_MIN_CLV` CLV (uiAmount — the human
 * token count; default 50,000; env can retune but never disable — invalid/
 * non-positive values fall back to the default). The balance source is the E5
 * subject split pinned by the C4 spec:
 *   - human  → `getLinkedWalletClvBalance(userId)` (their proven self-custody
 *     wallet, `users.linked_wallet_pubkey`);
 *   - agent  → `getWalletClvBalance(avatars.wallet_address)` (its custodial
 *     wallet — the agent lists for ITS OWN avatar).
 * The balance service is fail-soft (`available:false`, never throws) — this
 * gate therefore REFUSES to list when the balance cannot be confirmed
 * (`clv_balance_unavailable`). Never fail-open: an RPC outage must not mint
 * unlicensed sellers.
 *
 * ── LOCK ORDER (matches every land mutation + the rent-prepay fulfiller) ─────
 * per-owner advisory lock OUTER (`pg_advisory_xact_lock(hashtextextended(
 * sellerAvatarId, 0))`), THEN the parcel row `FOR UPDATE` INNER. Inverting it
 * would create an AB-BA deadlock edge against land's claim/topup/release/
 * sweeper paths. Cancel touches ONLY market-owned rows (listing FOR UPDATE →
 * lock-row delete) so it takes neither land lock.
 *
 * LEDGER-ONLY (trap 1): this module never imports claw-token-ledger and never
 * writes `avatars.clawTokens` — nothing here moves internal vCLAW.
 */

import { sql } from 'drizzle-orm';
import { db, avatars, eq } from '@clawville/database';
import {
  getLinkedWalletClvBalance,
  getWalletClvBalance,
  type ClvBalanceResult,
} from './linked-wallet-clv-balance';
import type { CheckoutSubject } from './x402-checkout';

// ---------------------------------------------------------------------------
// Seller license — CLV hold gate
// ---------------------------------------------------------------------------

/** Default Resident-license threshold: 50,000 CLV (uiAmount). */
export const MARKET_SELLER_MIN_CLV_DEFAULT = 50_000;

/**
 * `MARKET_SELLER_MIN_CLV` — env-retunable license threshold. Invalid /
 * non-positive values fall back to the default so a mis-set env can LOWER the
 * bar deliberately but never silently DISABLE the license gate.
 */
export function resolveMarketSellerMinClv(): number {
  const raw = process.env.MARKET_SELLER_MIN_CLV;
  if (!raw) return MARKET_SELLER_MIN_CLV_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return MARKET_SELLER_MIN_CLV_DEFAULT;
  return n;
}

export type SellerLicenseRefusal =
  | 'wallet_not_linked' // human: no linked wallet; agent: no custodial wallet provisioned
  | 'clv_balance_unavailable' // balance read failed — FAIL-SOFT ⇒ REFUSE, never assume pass
  | 'seller_license_required'; // confirmed balance below the threshold

export type SellerLicenseResult =
  | { ok: true; walletPubkey: string; clvUiAmount: number; thresholdClv: number }
  | {
      ok: false;
      code: SellerLicenseRefusal;
      thresholdClv: number;
      /** The confirmed balance when the refusal is threshold-based; null otherwise. */
      clvUiAmount: number | null;
    };

/**
 * The Resident-license check. READ-ONLY — consults the shared cached CLV
 * balance service; never throws (the balance service is fail-soft and every
 * failure mode maps to a refusal).
 */
export async function checkSellerLicense(subject: CheckoutSubject): Promise<SellerLicenseResult> {
  const thresholdClv = resolveMarketSellerMinClv();

  let walletPubkey: string | null = null;
  let clv: ClvBalanceResult;
  if (subject.kind === 'user') {
    if (!subject.userId) {
      return { ok: false, code: 'wallet_not_linked', thresholdClv, clvUiAmount: null };
    }
    const linked = await getLinkedWalletClvBalance(subject.userId);
    if (!linked.linked || !linked.walletPubkey) {
      return { ok: false, code: 'wallet_not_linked', thresholdClv, clvUiAmount: null };
    }
    walletPubkey = linked.walletPubkey;
    clv = linked.clv;
  } else {
    // Agent → its custodial avatar wallet (the C4-pinned split).
    const avatar = await db.query.avatars.findFirst({
      where: eq(avatars.id, subject.avatarId),
      columns: { walletAddress: true },
    });
    walletPubkey = avatar?.walletAddress ?? null;
    if (!walletPubkey) {
      return { ok: false, code: 'wallet_not_linked', thresholdClv, clvUiAmount: null };
    }
    clv = await getWalletClvBalance(walletPubkey);
  }

  // FAIL-SOFT ⇒ REFUSE (trap 5): `available:false` / null uiAmount means the
  // hold cannot be CONFIRMED right now — that is a refusal, not a pass.
  if (!clv.available || clv.uiAmount === null) {
    return { ok: false, code: 'clv_balance_unavailable', thresholdClv, clvUiAmount: null };
  }
  if (clv.uiAmount < thresholdClv) {
    return { ok: false, code: 'seller_license_required', thresholdClv, clvUiAmount: clv.uiAmount };
  }
  return { ok: true, walletPubkey, clvUiAmount: clv.uiAmount, thresholdClv };
}

// ---------------------------------------------------------------------------
// Row shapes (PG wire types — coerce!) + DTO
// ---------------------------------------------------------------------------

type ListingRow = {
  id: string;
  seller_avatar_id: string;
  item_kind: string;
  item_ref: string;
  price_vclaw: number | string;
  status: string;
  escrow_state: string | null;
  created_at: string | Date;
  expires_at: string | Date | null;
};

export interface MarketListingDTO {
  id: string;
  sellerAvatarId: string;
  itemKind: string;
  itemRef: string;
  priceVclaw: number;
  status: string;
  escrowState: string | null;
  createdAt: string;
  expiresAt: string | null;
}

function toListingDTO(row: ListingRow): MarketListingDTO {
  return {
    id: row.id,
    sellerAvatarId: row.seller_avatar_id,
    itemKind: row.item_kind,
    itemRef: row.item_ref,
    priceVclaw: Number(row.price_vclaw),
    status: row.status,
    escrowState: row.escrow_state,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: row.expires_at == null ? null : new Date(row.expires_at).toISOString(),
  };
}

const LISTING_SELECT_COLS = sql.raw(
  'id, seller_avatar_id, item_kind, item_ref, price_vclaw, status, escrow_state, created_at, expires_at',
);

// ---------------------------------------------------------------------------
// createMarketListing — (create) → active [+ deed escrow-lock, same tx]
// ---------------------------------------------------------------------------

/** Tenures whose holder OWNS the deed OUTRIGHT and may list it.
 *  'rented'/'deposit'/'starter' refuse (`not_transferable_tenure`) — a renter/
 *  depositor does not own the parcel. 'hold' refuses with its OWN typed code
 *  (`hold_transfer_not_supported`) — see the gate block below.
 *
 *  // FEATURE_GATE: market_hold_deed_transfer
 *  // Status: 'hold' tenure REFUSED at list time (narrowed from ['owned','hold']
 *  //   2026-07-08, Codex re-review). The deed-transfer executor's flip
 *  //   normalizes tenure='owned' + NULLs hold_threshold_ct/hold_subject, so a
 *  //   sold HOLD parcel would permanently escape BOTH the CLV-holding
 *  //   obligation AND the weekly tenure sweep (land_parcels tenureSweepIdx
 *  //   excludes 'owned') — an economic hole, not a scope cut. Data-driven:
 *  //   ZERO 'hold' parcels exist on prod or staging today, so narrowing costs
 *  //   nothing.
 *  // Metric to graduate: the designed HOLD-deed transfer ships BEFORE any
 *  //   hold parcel ever lists — the buyer INHERITS the hold obligation,
 *  //   re-stamped to the BUYER's subject (hold_subject = buyer) with an
 *  //   INDEPENDENT CLV-threshold check against the buyer's wallet mirroring
 *  //   the primary hold-claim flow, and the executor flip keeps tenure='hold'
 *  //   + the re-stamped hold cols instead of the fresh-owned reset.
 *  // Current reading: 0 hold parcels on prod/staging; 0 refused hold listings.
 *  // Review deadline: 2026-08-07 (rides the deed-transfer executor gate).
 *  // On deadline: if hold parcels still don't exist, keep refusing; if land
 *  //   ships hold tenure at scale first, this becomes a BLOCKING follow-up.
 *  // Reference: market-deed-transfer-executor.ts flip semantics; land tenure
 *  //   model (ARCHITECTURE.md §13, 2026-07-07 Phase B entry).
 */
const TRANSFERABLE_TENURES = new Set(['owned']);

export type CreateListingRefusal =
  | 'earned_not_available' // trap 6 — EARNED doesn't exist yet; land_deed only
  | 'parcel_not_found'
  | 'not_parcel_owner'
  | 'not_transferable_tenure'
  | 'hold_transfer_not_supported' // 'hold' deeds can't list until buyer-inherits-obligation ships (gate above)
  | 'parcel_already_listed';

export type CreateListingResult =
  | { ok: true; listing: MarketListingDTO }
  | { ok: false; code: CreateListingRefusal };

/** Internal control-flow: abort the create tx (rolls the listing insert back). */
class ListingRefused extends Error {
  constructor(public readonly code: CreateListingRefusal) {
    super(`market_listing_refused:${code}`);
    this.name = 'ListingRefused';
  }
}

export async function createMarketListing(input: {
  subject: CheckoutSubject;
  itemKind: 'land_deed' | 'earned_bundle';
  itemRef: string;
  priceVclaw: number;
  /** The license-gate wallet (stamped as the default payout destination). */
  sellerWalletPubkey: string;
  expiresAt: Date | null;
}): Promise<CreateListingResult> {
  // trap 6 — BLOCKED until EARNED provenance exists. Checked before any I/O.
  if (input.itemKind === 'earned_bundle') {
    return { ok: false, code: 'earned_not_available' };
  }

  const sellerAvatarId = input.subject.avatarId;
  const expiresAtIso = input.expiresAt ? input.expiresAt.toISOString() : null;

  try {
    const listing = await db.transaction(async (tx) => {
      // Land lock order: per-owner advisory OUTER, parcel row INNER.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${sellerAvatarId}, 0))`,
      );
      const parcels = await tx.execute<{
        id: string;
        parcel_code: string;
        owner_avatar_id: string | null;
        tenure: string | null;
      }>(
        sql`SELECT id, parcel_code, owner_avatar_id, tenure
            FROM land_parcels
            WHERE id = ${input.itemRef}
            FOR UPDATE`,
      );
      const parcel = parcels[0];
      if (!parcel) throw new ListingRefused('parcel_not_found');
      if (parcel.owner_avatar_id !== sellerAvatarId) throw new ListingRefused('not_parcel_owner');
      if (parcel.tenure === 'hold') {
        // SPECIFIC typed refusal (distinct from the generic non-owner tenures):
        // a HOLD deed sale must transfer the CLV-hold obligation to the buyer —
        // unbuilt (FEATURE_GATE market_hold_deed_transfer above). Refusing at
        // list time is what keeps the deed-flip's tenure='owned' normalization
        // sound: only 'owned' parcels can ever enter the transfer pipe.
        throw new ListingRefused('hold_transfer_not_supported');
      } else if (parcel.tenure == null || !TRANSFERABLE_TENURES.has(parcel.tenure)) {
        throw new ListingRefused('not_transferable_tenure');
      }

      const meta = JSON.stringify({
        subjectKind: input.subject.kind,
        parcelCode: parcel.parcel_code,
        tenureAtListing: parcel.tenure,
      });
      // The live-item partial UNIQUE (market_listings_live_item_unique) is the
      // second double-list backstop — a concurrent relist 23505s here and the
      // catch below maps it to parcel_already_listed.
      const inserted = await tx.execute<ListingRow>(
        sql`INSERT INTO market_listings
              (seller_avatar_id, seller_user_id, item_kind, item_ref, price_vclaw,
               status, escrow_state, seller_wallet_pubkey, expires_at, metadata)
            VALUES
              (${sellerAvatarId}, ${input.subject.userId}, 'land_deed', ${input.itemRef},
               ${input.priceVclaw}, 'active', 'deed_locked', ${input.sellerWalletPubkey},
               ${expiresAtIso}, ${meta}::jsonb)
            RETURNING ${LISTING_SELECT_COLS}`,
      );
      const row = inserted[0];
      if (!row) throw new Error('[market] listing insert returned no row');

      // THE ESCROW LOCK (trap 7): PK parcel_id = one live lock per parcel. A
      // conflict means another live listing already holds the deed — abort the
      // whole tx (the listing insert above rolls back with it).
      const lock = await tx.execute<{ parcel_id: string }>(
        sql`INSERT INTO market_deed_locks (parcel_id, listing_id)
            VALUES (${input.itemRef}, ${row.id})
            ON CONFLICT (parcel_id) DO NOTHING
            RETURNING parcel_id`,
      );
      if (!lock[0]) throw new ListingRefused('parcel_already_listed');

      return row;
    });
    return { ok: true, listing: toListingDTO(listing) };
  } catch (err) {
    if (err instanceof ListingRefused) {
      return { ok: false, code: err.code };
    }
    if ((err as { code?: string } | undefined)?.code === '23505') {
      // market_listings_live_item_unique — concurrent double-list race.
      return { ok: false, code: 'parcel_already_listed' };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// cancelMarketListing — active → cancelled [+ deed-lock release, same tx]
// ---------------------------------------------------------------------------

export type CancelListingRefusal = 'listing_not_found' | 'not_your_listing' | 'listing_not_cancellable';

export type CancelListingResult =
  | { ok: true; listing: MarketListingDTO }
  | { ok: false; code: CancelListingRefusal; status?: string };

export async function cancelMarketListing(input: {
  subject: CheckoutSubject;
  listingId: string;
}): Promise<CancelListingResult> {
  return db.transaction(async (tx) => {
    // Serializes against the settle fulfiller (which also takes the listing
    // row lock first) — a cancel and a settle can never interleave.
    const rows = await tx.execute<ListingRow>(
      sql`SELECT ${LISTING_SELECT_COLS}
          FROM market_listings
          WHERE id = ${input.listingId}
          FOR UPDATE`,
    );
    const listing = rows[0];
    if (!listing) return { ok: false as const, code: 'listing_not_found' as const };
    if (listing.seller_avatar_id !== input.subject.avatarId) {
      return { ok: false as const, code: 'not_your_listing' as const };
    }
    // Only 'active' cancels (spec). An EXPIRED-but-active listing is still
    // status='active' (expiry is a predicate in v1) and stays cancellable —
    // that is the lock-release path for expired deeds.
    if (listing.status !== 'active') {
      return {
        ok: false as const,
        code: 'listing_not_cancellable' as const,
        status: listing.status,
      };
    }

    const updated = await tx.execute<ListingRow>(
      sql`UPDATE market_listings
          SET status = 'cancelled', escrow_state = NULL, updated_at = now()
          WHERE id = ${listing.id} AND status = 'active'
          RETURNING ${LISTING_SELECT_COLS}`,
    );
    const row = updated[0];
    if (!row) return { ok: false as const, code: 'listing_not_cancellable' as const };

    // Release the deed escrow-lock (no-op for future non-deed kinds).
    await tx.execute(sql`DELETE FROM market_deed_locks WHERE listing_id = ${listing.id}`);

    return { ok: true as const, listing: toListingDTO(row) };
  });
}

// ---------------------------------------------------------------------------
// Reads — public browse + seller's own
// ---------------------------------------------------------------------------

/** Public browse: ACTIVE + unexpired only, newest first. */
export async function browseActiveListings(limit: number): Promise<MarketListingDTO[]> {
  const n = Math.min(Math.max(1, Math.floor(limit)), 100);
  const rows = await db.execute<ListingRow>(
    sql`SELECT ${LISTING_SELECT_COLS}
        FROM market_listings
        WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC
        LIMIT ${n}`,
  );
  return rows.map(toListingDTO);
}

/** The seller's own listings — every status, newest first. */
export async function listMyListings(
  sellerAvatarId: string,
  limit: number,
): Promise<MarketListingDTO[]> {
  const n = Math.min(Math.max(1, Math.floor(limit)), 100);
  const rows = await db.execute<ListingRow>(
    sql`SELECT ${LISTING_SELECT_COLS}
        FROM market_listings
        WHERE seller_avatar_id = ${sellerAvatarId}
        ORDER BY created_at DESC
        LIMIT ${n}`,
  );
  return rows.map(toListingDTO);
}
