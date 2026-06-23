/**
 * Reef Race Phase 4 — streak milestone constants.
 *
 * Single source of truth for both the server (`event.streak_milestone`
 * broadcast trigger in reef-race-sim) and the client (HUD glow tier
 * + match-end modal copy). N4 fix — no client-side milestone re-derivation.
 *
 * Total checkpoints in a race = REEF_CHECKPOINT_COUNT (12) × REEF_LAPS.
 * 2026-06-23: REEF_LAPS dropped 3 → 2 with the v4 WATER-DOMINANT big-ring
 * track (one loop is now ~125–160 s; 3 laps would be ~7–8 min). So the total
 * is now 12 × 2 = 24 (was 36). Hitting 24 = perfect race = perfect-lap bonus.
 *
 * Spec: `.claude/plans/reef-race-phase4-detailed.md` §3.
 */

/**
 * Total clean checkpoint crosses required for a "perfect" race.
 * MUST equal `REEF_CHECKPOINT_COUNT (12) * REEF_LAPS (2)` from
 * `apps/api/src/services/activity/sim/reef-race-config.ts`. Hard-coded here so
 * the shared layer doesn't pull a server-only import — KEEP IN SYNC if either
 * `REEF_CHECKPOINT_COUNT` or `REEF_LAPS` changes (the config's own
 * `TOTAL_CHECKPOINTS_PER_RACE` is the computed mirror). If these two ever
 * disagree the perfect-race bonus can never fire (it would need more clean
 * crosses than the race has checkpoints).
 */
export const TOTAL_CHECKPOINTS_PER_RACE = 24 as const;

/**
 * Edge-triggered streak milestones. Server broadcasts `event.streak_milestone`
 * exactly when `body.currentStreak` reaches one of these values.
 *
 * 5 milestones to match the `tier-1`..`tier-4` + `perfect` union of
 * `streakMilestoneKind`. Re-spaced for the 24-checkpoint 2-lap race (the top
 * milestone equals TOTAL_CHECKPOINTS_PER_RACE = the perfect race).
 */
export const STREAK_MILESTONES = [5, 10, 16, 20, 24] as const;

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
  if (streak >= TOTAL_CHECKPOINTS_PER_RACE) return 'perfect'; // 24 = perfect race
  if (streak >= 20) return 'tier-4';
  if (streak >= 16) return 'tier-3';
  if (streak >= 10) return 'tier-2';
  return 'tier-1';
}
