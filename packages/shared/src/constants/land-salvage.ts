/**
 * Seabed salvage — shared caps (Land gamification P4b/P7a).
 *
 * The salvage loop itself (node layout, cooldowns, yield, the claim route)
 * lands in a later slice. The OWNER cap ships now because it is a ratified
 * founder ruling and the material ledger it bounds is already live.
 */

/**
 * Per-avatar claims admitted per UTC day. At 1-3 materials per claim this is a
 * 20-60 material band, expectation 40.
 */
export const SALVAGE_AVATAR_DAILY_CLAIM_CAP = 20;

/**
 * Per-OWNER claims admitted per UTC day, summed across every avatar the owner
 * controls. This is the anti-fleet-farm bound: at the 20-claim per-avatar rate
 * it admits six avatars at full rate, capping owner-day issuance at 360
 * materials. Humans are structurally one avatar (`avatars.user_id` is UNIQUE),
 * so it binds only on agent fleets.
 *
 * FOUNDER-TUNABLE (ruling Q2, 2026-08-09): the design proposed 60; the founder
 * chose 120 deliberately, to admit six full-rate avatars rather than three.
 * Changing this is an economy decision, not a code cleanup — re-derive the
 * owner-day material ceiling (`cap x 3`) whenever it moves.
 */
export const SALVAGE_OWNER_DAILY_CLAIM_CAP = 120;
