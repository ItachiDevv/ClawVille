/**
 * Nori's world position — the ONE source for where she stands.
 *
 * Pure (no React, no three.js) so the collision table can import it. Before
 * this module, `world-colliders.ts` carried its own copy (0, 240) while the
 * mesh rendered at (0, 400) after Nori moved south on 2026-05-21: the player
 * walked straight through her and hit an invisible 80x80 box 160 wu short of
 * her (found 2026-09-18 by session bountyFix2's collider audit).
 */

/** Town centre on X. */
export const NORI_WORLD_X = 0;
/** 2026-05-21: moved south 240 -> 400 to clear the town-directory sign. */
export const NORI_WORLD_Z = 400;
/**
 * Squared talk radius. 320 wu is a slightly larger pull-in circle than the
 * 260 wu building characters use, since she stands in the open town centre
 * where proximity is the only chat affordance.
 */
export const NORI_TALK_RADIUS_SQ = 320 * 320;
