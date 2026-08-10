/**
 * Shop service-listing slot rent sweeper (Land gamification P5a).
 *
 * WHAT IT IS
 * ----------
 * The recurring SHOP-side sink that funds the home-side giveback. A shop's
 * service-listing slot is rented weekly (400 vCLAW) rather than owned outright,
 * and the premium featured placement costs more (1,200 vCLAW/week) on its own
 * independent cursor.
 *
 * WHY IT IS A SEPARATE SWEEPER FROM `land-rent-sweeper.ts`
 * -------------------------------------------------------
 * The parcel sweeper's period keying is a SINGLE `land_parcels.rent_paid_through`
 * cursor per parcel row. One cursor cannot carry two independent weekly
 * cadences, and bolting listing rent onto the tenure branch dispatch would put
 * a new money path inside the eviction machinery. This owns its own cursors on
 * `service_listings` and never touches parcel tenure.
 *
 * LOCK ORDER — deliberately identical to the parcel sweeper and the land routes
 * -----------------------------------------------------------------------------
 * `withKeyedMutex('land-tenure:<ownerAvatarId>')` (in-process, OUTER) ->
 * `pg_advisory_xact_lock(hashtextextended(ownerAvatarId, 0))` (cross-process) ->
 * `SELECT ... FOR UPDATE` on the listing row (INNER). Sharing the OWNER key with
 * the parcel sweeper is the point: the two sweepers can never interleave on the
 * same owner, so no AB-BA cycle is constructible between them.
 *
 * IDEMPOTENCY has no period key and needs none. `slot_paid_through` is read
 * under the row lock against the DATABASE clock and advanced under that same
 * lock, so two overlapping ticks serialize and the second re-reads a
 * not-yet-due row. Like the parcel sweeper this advances to
 * `now() + 7 days`, NOT `+= 7 days`: a multi-week outage forgives the missed
 * weeks rather than charging arrears in a burst.
 *
 * FAIL-CLOSED MEANS SUSPEND, NEVER DELETE. An unaffordable week stamps
 * `slot_suspended_at`, leaves the row/title/price untouched, and does NOT
 * advance the cursor, so the next sweep retries. Funding the account
 * un-suspends it. A suspended listing cannot be bought (`routes/land.ts`
 * refuses `listing_suspended`) and is hidden from the public feeds.
 *
 * TREASURY POLICY matches the parcel sweeper, not the kit route: this is a
 * post-settlement sweep, so a missing treasury degrades to a burn and the sweep
 * proceeds rather than wedging every shop in the world on one missing row.
 */

import { db, sql } from '@clawville/database';
import {
  RENT_PERIOD_DAYS,
  SERVICE_LISTING_SLOT_RENT_CT_WEEKLY,
  SERVICE_FEATURED_SLOT_RENT_CT_WEEKLY,
} from '@clawville/shared';
import {
  debitClawTokens,
  creditClawTokens,
  InsufficientTokensError,
} from './claw-token-ledger';
import { getHouseTreasuryAvatarId } from './house-treasury-seeder';
import { withKeyedMutex } from './keyed-mutex';

// FEATURE_GATE: shop_featured_placement
// Status: DARK — the column, the constant, the index, and the charge branch
//   below all exist, but NOTHING WRITES `service_listings.featured = true`.
//   Both listing schemas are `.strict()` and carry no `featured` field, so the
//   1,200/week charge is unreachable and this branch is dead code today.
// Why it is here: the schema + charge groundwork is the expensive half and it
//   is verified by the executed suite (which sets the flag directly). Adding
//   the writer is a small follow-up; shipping the writer WITHOUT the ordering
//   fix below would have sold placement that sorted to the BOTTOM of the board.
// Metric to graduate: a listing mutation accepts `featured`, AND the public
//   board test exercises all three featured states together — live-featured
//   (cursor in the future), featured-PENDING (featured = true with a NULL
//   cursor, the state a row sits in between switching featured on and its
//   first successful charge), and not-featured — asserting the paid row ranks
//   first and the PENDING row does NOT. The pending case is the one that broke:
//   `featured AND cursor > now()` is three-valued, and NULL sorts first under
//   DESC, so an unpaid row outranked a paid one until COALESCE was added.
// Current reading: 0 rows with `featured = true`.
// Review deadline: the slice that adds the featured writer.
// On deadline: if no writer has landed, DELETE this branch, the constant, and
//   `service_listings_featured_sweep_idx` rather than carrying dead money code.
// Reference: money review 2026-08-09 findings M1/M2.
//
// The knowledge surfaces (manual §10, Nori, orientation) deliberately do NOT
// mention featured placement while this gate is open — advertising a product
// the server cannot sell is the exact defect class the world-scope rule exists
// for.

const DEFAULT_SWEEP_PERIOD_MS = 60 * 60 * 1000; // hourly, like the parcel sweeper
const MIN_SWEEP_PERIOD_MS = 5 * 60 * 1000;
/**
 * Per-pass candidate ceiling. Beyond this many due listings a single pass never
 * reaches the tail — but nothing is LOST: an un-swept row keeps its cursor and
 * is picked up next pass. The real consequence at scale is drift: the effective
 * billing period stretches past 7 days once sustained due-volume exceeds this
 * per hour. Revisit if active listings ever approach 2,000.
 */
const MAX_CANDIDATES_PER_PASS = 2000;

/** Only knob. Unset or below the floor falls back to hourly. */
export function resolveSlotSweepPeriodMs(): number {
  const raw = process.env.SERVICE_SLOT_SWEEP_PERIOD_MS;
  if (!raw) return DEFAULT_SWEEP_PERIOD_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_SWEEP_PERIOD_MS) return DEFAULT_SWEEP_PERIOD_MS;
  return n;
}

/**
 * postgres.js can hand a boolean back over the wire as `'t'`/`'f'` rather than
 * a real boolean, and `'f'` is TRUTHY in JavaScript. Every boolean read below
 * goes through this — reading `slot_due` raw would charge rent on every listing
 * every pass. Mirrors `land-rent-sweeper.ts`.
 */
function isTrue(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}

export type SlotSweepAction =
  | { kind: 'charged'; slotCt: number; featuredCt: number }
  | { kind: 'suspended' }
  | { kind: 'skip' };

interface LockedListingRow extends Record<string, unknown> {
  id: string;
  owner_avatar_id: string;
  status: string;
  // Wire booleans — ALWAYS read through `isTrue`, never directly.
  featured: unknown;
  slot_due: unknown;
  featured_due: unknown;
  suspended: unknown;
}

/**
 * Move one CT amount from the listing owner to the house treasury.
 * Returns false when the owner cannot afford it — the debit throws BEFORE any
 * write, so the caller's transaction stays healthy and can suspend cleanly.
 */
async function chargeOwner(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ownerAvatarId: string,
  amountCt: number,
  reason: 'land_service_slot_rent' | 'land_service_featured_rent',
  listingId: string,
): Promise<boolean> {
  try {
    await debitClawTokens(
      {
        avatarId: ownerAvatarId,
        amount: amountCt,
        reason,
        source: 'system',
        metadata: { listingId },
        actorKind: 'system',
      },
      tx,
    );
  } catch (err) {
    if (err instanceof InsufficientTokensError) return false;
    throw err;
  }

  const treasuryId = await getHouseTreasuryAvatarId();
  if (treasuryId) {
    await creditClawTokens(
      {
        avatarId: treasuryId,
        amount: amountCt,
        reason: reason === 'land_service_slot_rent'
          ? 'house_fee_service_slot_rent'
          : 'house_fee_service_featured_rent',
        source: 'system',
        metadata: { listingId, ownerAvatarId },
        actorKind: 'system',
      },
      tx,
    );
  } else {
    // Post-settlement path: degrade to a burn rather than wedging every shop.
    console.error(
      `[ServiceSlotSweeper] house treasury unavailable — ${amountCt} CT ${reason} burned for listing ${listingId}`,
    );
  }
  return true;
}

/** Charge (or suspend) ONE due listing. Exported for the executed DB suite. */
export async function processDueListing(listingId: string): Promise<SlotSweepAction> {
  const peekRows = await db.execute<{ owner_avatar_id: string; status: string }>(
    sql`SELECT owner_avatar_id, status FROM service_listings WHERE id = ${listingId}`,
  );
  const peek = Array.from(peekRows)[0];
  if (!peek?.owner_avatar_id || peek.status !== 'active') return { kind: 'skip' };

  return withKeyedMutex(`land-tenure:${peek.owner_avatar_id}`, () =>
    db.transaction(async (tx): Promise<SlotSweepAction> => {
      // Per-owner advisory lock (OUTER) — same key and order as the parcel
      // sweeper and the land routes.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${peek.owner_avatar_id}, 0))`,
      );

      // Listing row lock (INNER) + authoritative re-read against the DB clock.
      const rows = await tx.execute<LockedListingRow>(
        sql`SELECT id, owner_avatar_id, status, featured,
                   (slot_paid_through IS NULL OR slot_paid_through <= now()) AS slot_due,
                   (featured_paid_through IS NULL OR featured_paid_through <= now()) AS featured_due,
                   (slot_suspended_at IS NOT NULL) AS suspended
            FROM service_listings
            WHERE id = ${listingId}
            FOR UPDATE`,
      );
      const listing = Array.from(rows)[0];
      if (!listing) return { kind: 'skip' };
      // Re-verify under the lock: the owner or status may have changed between
      // the unlocked peek and here.
      if (listing.owner_avatar_id !== peek.owner_avatar_id) return { kind: 'skip' };
      if (listing.status !== 'active') return { kind: 'skip' };
      const slotDue = isTrue(listing.slot_due);
      const featured = isTrue(listing.featured);
      const featuredDue = isTrue(listing.featured_due);
      if (!slotDue && !(featured && featuredDue)) {
        return { kind: 'skip' };
      }

      let slotCt = 0;
      let featuredCt = 0;

      if (slotDue) {
        const paid = await chargeOwner(
          tx,
          listing.owner_avatar_id,
          SERVICE_LISTING_SLOT_RENT_CT_WEEKLY,
          'land_service_slot_rent',
          listing.id,
        );
        if (!paid) {
          // Suspend, keep everything else. The cursor does NOT advance, so the
          // next sweep retries and a funded owner is restored automatically.
          await tx.execute(
            sql`UPDATE service_listings
                SET slot_suspended_at = COALESCE(slot_suspended_at, now()), updated_at = now()
                WHERE id = ${listing.id}`,
          );
          return { kind: 'suspended' };
        }
        slotCt = SERVICE_LISTING_SLOT_RENT_CT_WEEKLY;
        await tx.execute(
          sql`UPDATE service_listings
              SET slot_paid_through = now() + make_interval(days => ${RENT_PERIOD_DAYS}),
                  slot_suspended_at = NULL,
                  updated_at = now()
              WHERE id = ${listing.id}`,
        );
      }

      // The featured charge is independent: failing it never suspends the
      // listing, it just lets the premium placement lapse until it can be paid.
      // FEATURE_GATE shop_featured_placement — unreachable today (no writer
      // sets `featured`). Kept charging-correct so graduating the gate is a
      // one-line schema change, not a money-path rewrite.
      if (featured && featuredDue) {
        const paid = await chargeOwner(
          tx,
          listing.owner_avatar_id,
          SERVICE_FEATURED_SLOT_RENT_CT_WEEKLY,
          'land_service_featured_rent',
          listing.id,
        );
        if (paid) {
          featuredCt = SERVICE_FEATURED_SLOT_RENT_CT_WEEKLY;
          await tx.execute(
            sql`UPDATE service_listings
                SET featured_paid_through = now() + make_interval(days => ${RENT_PERIOD_DAYS}),
                    updated_at = now()
                WHERE id = ${listing.id}`,
          );
        }
      }

      return { kind: 'charged', slotCt, featuredCt };
    }),
  );
}

/** One sweep pass over every due listing. */
export async function sweepDueServiceSlots(): Promise<{
  charged: number;
  suspended: number;
  skipped: number;
}> {
  const candidates = await db.execute<{ id: string }>(
    sql`SELECT id FROM service_listings
        WHERE status = 'active'
          AND (
            (slot_paid_through IS NULL OR slot_paid_through <= now())
            OR (featured = true AND (featured_paid_through IS NULL OR featured_paid_through <= now()))
          )
        ORDER BY slot_paid_through NULLS FIRST
        LIMIT ${MAX_CANDIDATES_PER_PASS}`,
  );

  let charged = 0;
  let suspended = 0;
  let skipped = 0;

  for (const row of Array.from(candidates)) {
    try {
      const action = await processDueListing(row.id);
      if (action.kind === 'charged') charged += 1;
      else if (action.kind === 'suspended') suspended += 1;
      else skipped += 1;
    } catch (err) {
      // Per-listing catch so one bad row never aborts the pass.
      console.error(`[ServiceSlotSweeper] listing ${row.id} failed:`, err);
      skipped += 1;
    }
  }

  if (charged > 0 || suspended > 0) {
    console.log(
      `[ServiceSlotSweeper] pass complete — charged=${charged} suspended=${suspended} skipped=${skipped}`,
    );
  }
  return { charged, suspended, skipped };
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;

/** Wire up the periodic slot sweep. Called once from index.ts at boot. */
export function startServiceSlotRentSweeper(): void {
  if (sweepInterval) return;
  const periodMs = resolveSlotSweepPeriodMs();
  sweepInterval = setInterval(() => {
    sweepDueServiceSlots().catch((err) => {
      console.error('[ServiceSlotSweeper] sweep failed:', err);
    });
  }, periodMs);
  console.log(
    `[ServiceSlotSweeper] Started — sweeping due shop slot rents every ${Math.round(periodMs / 60000)}min`,
  );
}

export function stopServiceSlotRentSweeper(): void {
  if (!sweepInterval) return;
  clearInterval(sweepInterval);
  sweepInterval = null;
}
