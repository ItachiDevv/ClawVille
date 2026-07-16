/**
 * Post-entity-interpolation output damping for server-driven NPC bodies.
 *
 * The target passed here must already be the confirmed prev→latest entity-
 * interpolation result. This helper never predicts a target and returns only
 * a scalar, so useFrame callers add no allocations.
 */
export const NPC_INTERP_DAMPING_STIFFNESS = 10;

const MAX_DAMPING_DELTA_SECONDS = 0.1;

export function dampTowardConfirmedTarget(
  current: number,
  confirmedTarget: number,
  deltaSeconds: number,
): number {
  const dt = Math.max(0, Math.min(deltaSeconds, MAX_DAMPING_DELTA_SECONDS));
  const alpha = 1 - Math.exp(-NPC_INTERP_DAMPING_STIFFNESS * dt);
  return current + (confirmedTarget - current) * alpha;
}
