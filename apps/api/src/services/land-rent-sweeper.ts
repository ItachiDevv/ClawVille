/**
 * Land rent sweeper (builder-economics, 2026-06-24) — the recurring CT sink.
 *
 * A RENTED parcel owes `rent_ct_weekly` every `RENT_PERIOD_DAYS`. This periodic
 * pass finds every rented parcel that is due (or in an elapsed grace window) and,
 * PER PARCEL under the same money discipline as the buy/rent route (per-avatar
 * advisory lock + `SELECT … FOR UPDATE`):
 *
 *   - rent due, charge succeeds  → debit the owner one week, advance
 *     `rent_paid_through = now() + period`, clear `grace_until`, audit `rent_payment`.
 *   - rent due, charge fails (insufficient CT) → open a `RENT_GRACE_DAYS` grace
 *     window (`grace_until = now() + grace`) if not already open; perks/listings
 *     are paused while in grace (the route/render read the flag). NO partial debit.
 *   - grace window elapsed       → EVICT: parcel returns to the pool
 *     (`status='available'`, owner/tenure/rent fields cleared), its structure is
 *     ARCHIVED (soft, restored on a same-avatar re-acquire / purged on re-lease),
 *     audit `eviction`. The for-sale sign reappears live via `broadcastLandEvent`.
 *
 * SAFETY (mirrors agent-body-idle-sweeper):
 *   - Re-entrant + idempotent: every decision is re-read UNDER THE LOCK against the
 *     DB clock (`now()`), so two overlapping ticks cannot double-charge or
 *     double-evict (the second sees the first's committed advance / available flip).
 *   - On a successful charge we set `rent_paid_through = now() + period` (a fresh
 *     week from now) rather than `+= period`, so a multi-week outage forgives the
 *     missed weeks instead of charging a pile of arrears in a burst.
 *   - PER-PARCEL try/catch: one bad row never aborts the rest of the pass, and the
 *     sweep never throws to its caller.
 *   - Side effects (cache bust + SSE broadcast) run AFTER each parcel's tx commits,
 *     so a notification failure can never affect the settled charge/eviction.
 */

import { sql } from 'drizzle-orm';
import { db } from '@clawville/database';
import { RENT_PERIOD_DAYS, RENT_GRACE_DAYS, type LandTier } from '@clawville/shared';
import { creditClawTokens, debitClawTokens, InsufficientTokensError } from './claw-token-ledger';
import { getHouseTreasuryAvatarId } from './house-treasury-seeder';
import { broadcastLandEvent } from '../routes/world';
import { bustOwnedCache, bustParcelsAvailableCache } from '../routes/land';

const DEFAULT_SWEEP_PERIOD_MS = 60 * 60 * 1000; // 1 hour
const MIN_SWEEP_PERIOD_MS = 5 * 60 * 1000; // 5 min floor (mis-set guard)
/** Bound a pathological pass; the rented set is tiny in practice. Logged if hit. */
const MAX_CANDIDATES_PER_PASS = 2000;

/** Resolve the sweep cadence from env, floored so a tiny value can't thrash. */
export function resolveRentSweepPeriodMs(): number {
  const raw = process.env.LAND_RENT_SWEEP_PERIOD_MS;
  if (!raw) return DEFAULT_SWEEP_PERIOD_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_SWEEP_PERIOD_MS) return DEFAULT_SWEEP_PERIOD_MS;
  return n;
}

/** PG wire booleans arrive as `true`/`'t'`/`'true'` depending on driver path. */
function isTrue(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}

type SweepAction =
  | { kind: 'charged'; parcelCode: string; ownerAvatarId: string }
  | { kind: 'graced' }
  | { kind: 'evicted'; parcelCode: string; tier: LandTier; ownerAvatarId: string }
  | { kind: 'skip' };

/**
 * Process ONE due parcel atomically. Returns the action taken (the caller runs
 * the post-commit side effects). Throws only on an unexpected (non-insufficient)
 * error, which the caller isolates per-parcel.
 */
async function processDueParcel(parcelId: string): Promise<SweepAction> {
  return db.transaction(async (tx): Promise<SweepAction> => {
    // (0) Re-read EVERYTHING under the per-owner advisory lock + the parcel row
    // lock so concurrent ticks / a same-owner acquire serialize correctly. The
    // owner id for the advisory key is read from the row itself, so we lock the
    // parcel first to learn the owner, then take the advisory lock.
    const rows = await tx.execute<{
      id: string;
      parcel_code: string;
      tier: LandTier;
      owner_avatar_id: string | null;
      rent_ct_weekly: number | string | null;
      tenure: string | null;
      rent_due: unknown;
      grace_elapsed: unknown;
    }>(
      sql`SELECT id, parcel_code, tier, owner_avatar_id, rent_ct_weekly, tenure,
                 (rent_paid_through IS NOT NULL AND rent_paid_through <= now()) AS rent_due,
                 (grace_until IS NOT NULL AND grace_until <= now()) AS grace_elapsed
          FROM land_parcels
          WHERE id = ${parcelId}
          FOR UPDATE`,
    );
    const p = rows[0];
    // Tenure/owner can change between the candidate read and the lock (acquire,
    // a prior tick). Only a still-rented parcel with an owner is actionable.
    if (!p || p.tenure !== 'rented' || !p.owner_avatar_id) {
      return { kind: 'skip' };
    }
    const ownerAvatarId = p.owner_avatar_id;
    const graceElapsed = isTrue(p.grace_elapsed);
    const rentDue = isTrue(p.rent_due);

    // (A) EVICTION takes priority — grace window has elapsed.
    if (graceElapsed) {
      await tx.execute(
        sql`UPDATE land_parcels
            SET status = 'available',
                owner_avatar_id = NULL,
                tenure = NULL,
                acquired_at = NULL,
                rent_paid_through = NULL,
                grace_until = NULL,
                updated_at = now()
            WHERE id = ${p.id}`,
      );
      // Archive (soft-delete) the active structure — restored on a same-avatar
      // re-acquire, purged on a re-lease to someone else.
      await tx.execute(
        sql`UPDATE land_structures
            SET status = 'archived', updated_at = now()
            WHERE parcel_id = ${p.id} AND status = 'active'`,
      );
      const meta = JSON.stringify({ reason: 'rent_lapsed', tier: p.tier, parcelCode: p.parcel_code });
      await tx.execute(
        sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, metadata)
            VALUES ('eviction', ${p.id}, ${ownerAvatarId}, 0, ${meta}::jsonb)`,
      );
      return { kind: 'evicted', parcelCode: p.parcel_code, tier: p.tier, ownerAvatarId };
    }

    // (B) Not in elapsed grace, and not due → nothing to do (defensive; the
    // candidate query already filtered, but the lock-time re-read is authoritative).
    if (!rentDue) {
      return { kind: 'skip' };
    }

    // (C) Rent is due — attempt the weekly charge.
    const rentCt = p.rent_ct_weekly == null ? null : Number(p.rent_ct_weekly);
    if (rentCt == null || rentCt <= 0) {
      // A rented parcel with no rent price is a data anomaly — don't charge, don't
      // evict; skip and let it surface in monitoring rather than mis-bill.
      console.warn(`[LandRentSweeper] rented parcel ${p.parcel_code} has NULL/<=0 rent_ct_weekly — skipping`);
      return { kind: 'skip' };
    }

    try {
      const debit = await debitClawTokens(
        {
          avatarId: ownerAvatarId,
          amount: rentCt,
          reason: 'land_parcel_rent',
          source: 'system',
          metadata: { parcelId: p.id, parcelCode: p.parcel_code, tier: p.tier, period: 'weekly' },
        },
        tx,
      );
      // T0 fee routing (2026-07-07): the weekly rent → house treasury, IN THIS
      // SAME per-parcel tx as the tenant's debit (net-neutral supply — there is
      // NO player-landlord; the rent previously burned to nobody). Tenant-side
      // amount UNCHANGED; the lock-time re-read above (rent_due under FOR
      // UPDATE) already makes the charge exactly-once per due week, and this
      // credit rides that same guarantee. A null treasury (unavailable)
      // degrades to the pre-T0 burn — never blocks the charge.
      if (Number.isInteger(rentCt) && rentCt > 0) {
        const treasuryId = await getHouseTreasuryAvatarId();
        if (treasuryId) {
          await creditClawTokens(
            {
              avatarId: treasuryId,
              amount: rentCt,
              reason: 'house_fee_land_rent',
              source: 'system',
              metadata: {
                parcelId: p.id,
                parcelCode: p.parcel_code,
                tier: p.tier,
                period: 'weekly',
                renterAvatarId: ownerAvatarId,
              },
            },
            tx,
          );
        } else {
          console.error(
            `[LandRentSweeper] house treasury unavailable — ${rentCt} CT weekly rent burned (pre-T0 behavior) for parcel ${p.parcel_code}`,
          );
        }
      }
      // Charged — advance a fresh week from now (forgives outage arrears), clear grace.
      await tx.execute(
        sql`UPDATE land_parcels
            SET rent_paid_through = now() + make_interval(days => ${RENT_PERIOD_DAYS}),
                grace_until = NULL,
                updated_at = now()
            WHERE id = ${p.id}`,
      );
      const meta = JSON.stringify({ tier: p.tier, parcelCode: p.parcel_code, period: 'weekly', rentCtWeekly: rentCt });
      await tx.execute(
        sql`INSERT INTO land_transactions
              (kind, parcel_id, avatar_id, amount_ct, debit_ledger_tx_id, metadata)
            VALUES ('rent_payment', ${p.id}, ${ownerAvatarId}, ${rentCt}, ${debit.ledgerId}, ${meta}::jsonb)`,
      );
      return { kind: 'charged', parcelCode: p.parcel_code, ownerAvatarId };
    } catch (err) {
      if (err instanceof InsufficientTokensError) {
        // The debit threw BEFORE any write (balance check precedes the UPDATE), so
        // the tx is healthy. Open a grace window if one is not already open. Charge
        // NOTHING — no partial debit.
        await tx.execute(
          sql`UPDATE land_parcels
              SET grace_until = now() + make_interval(days => ${RENT_GRACE_DAYS}),
                  updated_at = now()
              WHERE id = ${p.id} AND grace_until IS NULL`,
        );
        return { kind: 'graced' };
      }
      throw err;
    }
  });
}

/**
 * One sweep pass. Reads the due-candidate set (cheap, partial-indexed), then
 * processes each parcel in its OWN transaction. Returns the action counts.
 */
export async function sweepDueRents(): Promise<{ charged: number; graced: number; evicted: number }> {
  let candidates: Array<{ id: string }>;
  try {
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM land_parcels
          WHERE tenure = 'rented'
            AND (
              (rent_paid_through IS NOT NULL AND rent_paid_through <= now())
              OR (grace_until IS NOT NULL AND grace_until <= now())
            )
          ORDER BY rent_paid_through ASC NULLS FIRST
          LIMIT ${MAX_CANDIDATES_PER_PASS}`,
    );
    candidates = Array.from(rows as Iterable<{ id: string }>);
  } catch (err) {
    console.warn('[LandRentSweeper] candidate read failed (non-fatal):', err);
    return { charged: 0, graced: 0, evicted: 0 };
  }

  if (candidates.length === 0) return { charged: 0, graced: 0, evicted: 0 };
  if (candidates.length >= MAX_CANDIDATES_PER_PASS) {
    console.warn(
      `[LandRentSweeper] candidate cap hit (${MAX_CANDIDATES_PER_PASS}) — remaining due parcels roll to the next pass`,
    );
  }

  let charged = 0;
  let graced = 0;
  let evicted = 0;

  for (const { id } of candidates) {
    let action: SweepAction;
    try {
      action = await processDueParcel(id);
    } catch (err) {
      console.warn(`[LandRentSweeper] parcel ${id} failed (non-fatal):`, err);
      continue;
    }

    // Post-commit side effects — never inside the money tx.
    try {
      if (action.kind === 'charged') {
        charged++;
        bustOwnedCache(action.ownerAvatarId);
      } else if (action.kind === 'graced') {
        graced++;
      } else if (action.kind === 'evicted') {
        evicted++;
        bustOwnedCache(action.ownerAvatarId);
        bustParcelsAvailableCache(action.tier);
        // Live: the parcel is back in the pool — its for-sale sign reappears for
        // every connected player. Fire-and-forget (already fully guarded).
        broadcastLandEvent({
          parcelCode: action.parcelCode,
          status: 'available',
          ownerAvatarId: null,
        });
      }
    } catch (err) {
      console.warn('[LandRentSweeper] post-commit side effect failed (non-fatal):', err);
    }
  }

  if (charged + graced + evicted > 0) {
    console.log(
      `[LandRentSweeper] pass complete — charged=${charged} graced=${graced} evicted=${evicted}`,
    );
  }
  return { charged, graced, evicted };
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;

/** Wire up the periodic rent sweep. Called once from index.ts at boot. */
export function startLandRentSweeper(): void {
  if (sweepInterval) return;
  const periodMs = resolveRentSweepPeriodMs();
  sweepInterval = setInterval(() => {
    sweepDueRents().catch((err) => {
      console.error('[LandRentSweeper] sweep failed:', err);
    });
  }, periodMs);
  console.log(`[LandRentSweeper] Started — sweeping due rents every ${Math.round(periodMs / 60000)}min`);
}

export function stopLandRentSweeper(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
