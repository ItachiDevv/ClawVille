/**
 * MARKET LISTING-EXPIRY SWEEPER (Tokenomics C4 follow-up / task D, 2026-07-08).
 *
 * WHY THIS EXISTS — the squatting hole. `POST /api/market/listings` is LIVE (not
 * flag-gated; only marketplace SETTLEMENT is gated). v1 treated a listing's
 * `expires_at` as a PREDICATE only — an expired listing stayed `status='active'`
 * holding its `market_deed_locks` row indefinitely. Once the land deed-lock guard
 * shipped (`c7826f69`: land's pool-revert PARKS while a lock exists), a
 * never-cancelled expired listing = its deed lock is held forever = the parcel's
 * rent-lapse eviction is parked forever = indefinite rent-free squatting. This
 * sweeper closes that: it flips expired `active` listings to the terminal
 * `expired` state and RELEASES the deed lock, so land's next rent-sweep pass
 * proceeds normally.
 *
 * NOT A MONEY PATH. No CT/CLV/USDC moves; nothing is imported from
 * claw-token-ledger; `avatars.clawTokens` is never touched. This only flips a
 * listing status and deletes a market-owned lock row — safe to run LIVE (like
 * `land-rent-sweeper`), so it is boot-wired, NOT behind a dark flag.
 *
 * SCOPE (the deed-transfer executor owns the rest). It touches ONLY
 * `status='active'` listings whose `expires_at <= now()`. It NEVER touches
 * `pending_settlement`/`settled` — those locks are the deed-transfer executor's
 * (`market-deed-transfer-executor.ts`), which deletes the lock + flips ownership
 * atomically; the land guard auto-unblocks the instant that row is gone. An
 * `active` listing with no `expires_at` (never expires) is untouched; a cancelled
 * listing already released its lock.
 *
 * LOCK ORDER — identical to the marketplace fulfiller + `createMarketListing`, so
 * there is no new deadlock edge: (1) the LISTING row `FOR UPDATE` (serializes vs
 * cancel + the settle fulfiller, both of which lock the listing first), then for
 * a `land_deed` (2) advisory(seller) OUTER via
 * `pg_advisory_xact_lock(hashtextextended(sellerAvatarId, 0))`, then (3) the
 * parcel row `FOR UPDATE` INNER — the SAME order every land mutation + the land
 * deed-lock guard use, so the lock DELETE is atomic w.r.t. the guard's
 * `parcelHasLiveDeedLock` EXISTS read (never a torn read). For an active listing
 * the seller IS the current parcel owner (settlement is gated off, so no deed has
 * moved; the guard blocks any release while the lock is held), so advisory(seller)
 * == advisory(current owner).
 *
 * IDEMPOTENT: the flip is `WHERE id=$ AND status='active'` (a concurrent
 * cancel/settle makes it a 0-row no-op); the lock DELETE is `WHERE listing_id=$`
 * (no-op if already gone). A re-run over an already-expired row is a clean no-op.
 */

import { sql } from 'drizzle-orm';
import { db } from '@clawville/database';

const DEFAULT_SWEEP_PERIOD_MS = 60 * 60 * 1000; // 1 hour (matches land-rent-sweeper)
const MIN_SWEEP_PERIOD_MS = 5 * 60 * 1000; // 5 min floor (mis-set guard)
const MAX_CANDIDATES_PER_PASS = 2000;

/** `MARKET_LISTING_EXPIRY_SWEEP_PERIOD_MS` — floor 5 min; default 1 h. */
export function resolveExpirySweepPeriodMs(): number {
  const raw = process.env.MARKET_LISTING_EXPIRY_SWEEP_PERIOD_MS;
  if (!raw) return DEFAULT_SWEEP_PERIOD_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_SWEEP_PERIOD_MS) return DEFAULT_SWEEP_PERIOD_MS;
  return n;
}

type ExpiredListingRow = {
  id: string;
  seller_avatar_id: string;
  item_kind: string;
  item_ref: string;
  status: string;
  expires_at: string | Date | null;
};

export type ExpirySweepAction =
  | { kind: 'expired'; listingId: string; itemKind: string; itemRef: string; lockReleased: boolean }
  | { kind: 'noop'; listingId: string; reason: 'not_active' | 'not_expired' | 'gone' };

/**
 * Expire ONE listing in its own transaction (locks in the fulfiller order).
 * Returns the action taken. Never throws for an expected concurrent-state race —
 * those resolve to a `noop`.
 */
export async function processExpiredListing(listingId: string): Promise<ExpirySweepAction> {
  return db.transaction(async (tx) => {
    // (1) LISTING row FOR UPDATE — serializes against cancel + the settle
    //     fulfiller (both lock the listing first).
    const rows = await tx.execute<ExpiredListingRow>(
      sql`SELECT id, seller_avatar_id, item_kind, item_ref, status, expires_at
          FROM market_listings
          WHERE id = ${listingId}
          FOR UPDATE`,
    );
    const listing = rows[0];
    if (!listing) return { kind: 'noop' as const, listingId, reason: 'gone' as const };
    // ONLY active listings — pending_settlement/settled locks belong to the
    // deed-transfer executor; cancelled/expired are already terminal.
    if (listing.status !== 'active') {
      return { kind: 'noop' as const, listingId, reason: 'not_active' as const };
    }
    // Re-verify expiry UNDER the lock (a candidate read is a snapshot; never
    // expire a still-live listing).
    if (listing.expires_at == null || new Date(listing.expires_at).getTime() > Date.now()) {
      return { kind: 'noop' as const, listingId, reason: 'not_expired' as const };
    }

    // (2)+(3) land lock order for a deed: advisory(seller) OUTER, parcel INNER —
    //     so the lock DELETE is atomic w.r.t. land's deed-lock guard read.
    if (listing.item_kind === 'land_deed') {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${listing.seller_avatar_id}, 0))`,
      );
      await tx.execute(sql`SELECT id FROM land_parcels WHERE id = ${listing.item_ref} FOR UPDATE`);
    }

    // Flip active → expired + clear the escrow marker (mirrors cancel).
    const updated = await tx.execute<{ id: string }>(
      sql`UPDATE market_listings
          SET status = 'expired', escrow_state = NULL, updated_at = now()
          WHERE id = ${listing.id} AND status = 'active'
          RETURNING id`,
    );
    if (!updated[0]) {
      // Lost the race to a concurrent cancel/settle after our lock — no-op.
      return { kind: 'noop' as const, listingId, reason: 'not_active' as const };
    }

    // Release the deed escrow-lock (no-op for a non-deed kind or an already-gone
    // lock). The land guard's next pass now proceeds with eviction/revert.
    const releasedRows = await tx.execute<{ parcel_id: string }>(
      sql`DELETE FROM market_deed_locks WHERE listing_id = ${listing.id} RETURNING parcel_id`,
    );

    return {
      kind: 'expired' as const,
      listingId: listing.id,
      itemKind: listing.item_kind,
      itemRef: listing.item_ref,
      lockReleased: releasedRows.length > 0,
    };
  });
}

/**
 * One sweep pass: expire every `active` listing past its `expires_at`, releasing
 * each deed lock. Per-listing tx (one failure never aborts the batch), capped per
 * pass (remaining roll to the next). Fail-soft candidate read.
 */
export async function sweepExpiredListings(): Promise<{ expired: number; locksReleased: number; noop: number }> {
  let candidates: Array<{ id: string }>;
  try {
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM market_listings
          WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()
          ORDER BY expires_at ASC
          LIMIT ${MAX_CANDIDATES_PER_PASS}`,
    );
    candidates = Array.from(rows as Iterable<{ id: string }>);
  } catch (err) {
    console.warn('[MarketExpirySweeper] candidate read failed (non-fatal):', err);
    return { expired: 0, locksReleased: 0, noop: 0 };
  }

  if (candidates.length === 0) return { expired: 0, locksReleased: 0, noop: 0 };
  if (candidates.length >= MAX_CANDIDATES_PER_PASS) {
    console.warn(
      `[MarketExpirySweeper] candidate cap hit (${MAX_CANDIDATES_PER_PASS}) — remaining expired listings roll to the next pass`,
    );
  }

  let expired = 0;
  let locksReleased = 0;
  let noop = 0;
  for (const { id } of candidates) {
    let action: ExpirySweepAction;
    try {
      action = await processExpiredListing(id);
    } catch (err) {
      console.warn(`[MarketExpirySweeper] listing ${id} failed (non-fatal):`, err);
      continue;
    }
    if (action.kind === 'expired') {
      expired++;
      if (action.lockReleased) locksReleased++;
    } else {
      noop++;
    }
  }
  if (expired > 0) {
    console.log(
      `[MarketExpirySweeper] expired ${expired} listing(s), released ${locksReleased} deed lock(s), ${noop} no-op(s) this pass`,
    );
  }
  return { expired, locksReleased, noop };
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;

/** Start the recurring expiry sweep (idempotent). Boot-wired in index.ts. */
export function startMarketListingExpirySweeper(): void {
  if (sweepInterval) return;
  const periodMs = resolveExpirySweepPeriodMs();
  sweepInterval = setInterval(() => {
    sweepExpiredListings().catch((err) => {
      console.error('[MarketExpirySweeper] sweep failed:', err);
    });
  }, periodMs);
  console.log(
    `[MarketExpirySweeper] Started — expiring stale marketplace listings every ${Math.round(periodMs / 60000)}min`,
  );
}

/** Stop the sweep interval (graceful shutdown). Idempotent. */
export function stopMarketListingExpirySweeper(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
