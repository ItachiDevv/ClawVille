/**
 * Reef Race Phase 4 — streak milestone constants.
 *
 * Single source of truth for both the server (`event.streak_milestone`
 * broadcast trigger in reef-race-sim) and the client (HUD glow tier
 * + match-end modal copy). N4 fix — no client-side milestone re-derivation.
 *
 * Total checkpoints in a 3-lap race = REEF_CHECKPOINT_COUNT (12) × REEF_LAPS
 * (3) = 36. Hitting 36 = perfect race = perfect-lap bonus credited.
 *
 * Spec: `.claude/plans/reef-race-phase4-detailed.md` §3.
 */

/**
 * Total clean checkpoint crosses required for a "perfect" 3-lap race.
 * Mirrors `REEF_CHECKPOINT_COUNT * REEF_LAPS` from
 * `apps/api/src/services/activity/sim/reef-race-config.ts`. Hard-coded
 * here so the shared layer doesn't pull a server-only import.
 */
export const TOTAL_CHECKPOINTS_PER_RACE = 36 as const;

/**
 * Edge-triggered streak milestones. Server broadcasts `event.streak_milestone`
 * exactly when `body.currentStreak` reaches one of these values.
 *
 * S2 FIX — compressed from 7 candidate milestones to 5 to match the
 * `tier-1`..`tier-4` + `perfect` union of `streakMilestoneKind`.
 */
export const STREAK_MILESTONES = [5, 10, 20, 30, 36] as const;

export type StreakMilestoneKind =
  | 'tier-1'
  | 'tier-2'
  | 'tier-3'
  | 'tier-4'
  | 'perfect';

/**
 * Map a streak count to the HUD glow tier kind. Used by both the server
 * (when emitting `event.streak_milestone`) and the client HUD chip
 * (CSS class table indexed by tier — no per-frame work).
 *
 * Returns `'tier-1'` for streaks below 5 so callers can light up the chip
 * gracefully without a separate "no tier" branch.
 */
export function streakMilestoneKind(streak: number): StreakMilestoneKind {
  if (streak >= TOTAL_CHECKPOINTS_PER_RACE) return 'perfect';
  if (streak >= 30) return 'tier-4';
  if (streak >= 20) return 'tier-3';
  if (streak >= 10) return 'tier-2';
  return 'tier-1';
}
