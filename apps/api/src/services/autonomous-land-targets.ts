import { db, sql } from '@clawville/database';
import {
  LAND_PARCELS,
  holdThresholdForTier,
  parcelDisplayName,
  tenureRentCtWeeklyForTier,
  type LandTier,
} from '@clawville/shared';

const TARGET_LIMIT = 5;
const WORLD_HALF_WU = 11_264;
const RENDERED = new Map(LAND_PARCELS.map((parcel) => [parcel.id, parcel]));

export interface AutonomousLandClaimTarget {
  parcelCode: string;
  displayName: string;
  tier: LandTier;
  holdThresholdClv: number | null;
  weeklyRentVclaw: number | null;
  distanceWu: number;
}

export interface AutonomousLandOwnedTarget {
  parcelCode: string;
  displayName: string;
  tier: LandTier;
  tenure: 'hold' | 'deposit' | 'legacy';
  holdThresholdClv: number | null;
  weeklyRentVclaw: number | null;
  prepaidWeeksRemaining: number | null;
  grace: 'active' | 'grace';
}

export interface AutonomousLandTargets {
  claimable: AutonomousLandClaimTarget[];
  owned: AutonomousLandOwnedTarget[];
}

type LandTargetRow = {
  parcel_code: string;
  tier: LandTier;
  status: string;
  owner_avatar_id: string | null;
  tenure: string | null;
  rent_ct_weekly: number | string | null;
  deposit_remaining_ct: number | string | null;
  hold_threshold_ct: number | string | null;
  grace_until: string | Date | null;
};

/** Closed-field, bounded projection for hosted cognition. No player prose enters it. */
export async function readAutonomousLandTargets(input: {
  avatarId: string;
  x: number;
  y: number;
}): Promise<AutonomousLandTargets> {
  // Deliberately one bounded scan: rendered supply is frozen at 56 rows and
  // owner_avatar_id already has an index. If supply grows materially, split
  // the OR branches and add a new forward migration instead of copying this
  // query into a hot path or editing frozen migrations 0051/0052.
  const rows = await db.execute<LandTargetRow>(
    sql`SELECT parcel_code, tier, status, owner_avatar_id, tenure,
               rent_ct_weekly, deposit_remaining_ct, hold_threshold_ct, grace_until
        FROM land_parcels
        WHERE status = 'available' OR owner_avatar_id = ${input.avatarId}`,
  );

  const claimable = Array.from(rows)
    .filter((row) => row.status === 'available' && RENDERED.has(row.parcel_code))
    .map((row): AutonomousLandClaimTarget => {
      const slot = RENDERED.get(row.parcel_code)!;
      const dx = slot.cx + WORLD_HALF_WU - input.x;
      const dy = slot.cz + WORLD_HALF_WU - input.y;
      return {
        parcelCode: row.parcel_code,
        displayName: parcelDisplayName(row.parcel_code, row.tier),
        tier: row.tier,
        holdThresholdClv: holdThresholdForTier(row.tier),
        weeklyRentVclaw: tenureRentCtWeeklyForTier(row.tier),
        distanceWu: Math.round(Math.hypot(dx, dy)),
      };
    })
    .filter((row) => row.holdThresholdClv != null || row.weeklyRentVclaw != null)
    .sort((a, b) => a.distanceWu - b.distanceWu)
    .slice(0, TARGET_LIMIT);

  const owned = Array.from(rows)
    .filter((row) => row.owner_avatar_id === input.avatarId && RENDERED.has(row.parcel_code))
    .slice(0, TARGET_LIMIT)
    .map((row): AutonomousLandOwnedTarget => {
      const weekly = row.rent_ct_weekly == null ? null : Number(row.rent_ct_weekly);
      const remaining = row.deposit_remaining_ct == null ? null : Number(row.deposit_remaining_ct);
      return {
        parcelCode: row.parcel_code,
        displayName: parcelDisplayName(row.parcel_code, row.tier),
        tier: row.tier,
        tenure: row.tenure === 'hold' || row.tenure === 'deposit' ? row.tenure : 'legacy',
        holdThresholdClv: row.hold_threshold_ct == null
          ? (row.tenure === 'hold' ? holdThresholdForTier(row.tier) : null)
          : Number(row.hold_threshold_ct),
        weeklyRentVclaw: weekly,
        prepaidWeeksRemaining:
          row.tenure === 'deposit' && weekly != null && weekly > 0 && remaining != null
            ? Math.floor(remaining / weekly)
            : null,
        grace: row.grace_until == null ? 'active' : 'grace',
      };
    });

  return { claimable, owned };
}
