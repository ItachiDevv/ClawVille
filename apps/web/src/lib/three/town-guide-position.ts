/**
 * Nori's world position for the web client.
 *
 * The position itself lives in `@clawville/shared` (world-colliders-data.ts)
 * so the web mesh, the client collider table and the SERVER collider table all
 * read the same numbers. Before 2026-09-18 both collider tables carried their
 * own copy, (0, 240), while the mesh rendered at (0, 400) after Nori moved
 * south on 2026-05-21: players and server-driven agents walked through her and
 * were blocked by an invisible 80x80 box 160 wu short of her (found by session
 * bountyFix2's collider audit).
 *
 * Pure (no React, no three.js) so the collision table can import it.
 */
export { NORI_WORLD_X, NORI_WORLD_Z } from '@clawville/shared';

/**
 * Squared talk radius. 320 wu is a slightly larger pull-in circle than the
 * 260 wu building characters use, since she stands in the open town centre
 * where proximity is the only chat affordance.
 */
export const NORI_TALK_RADIUS_SQ = 320 * 320;
