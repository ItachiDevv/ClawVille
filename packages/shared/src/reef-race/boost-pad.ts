/**
 * Reef Race boost-pad velocity math shared by authority and self prediction.
 *
 * The output-parameter shape keeps the fixed-tick client path allocation-free.
 * All results depend only on the scalar inputs; callers may safely pass the
 * same object as both the velocity source and destination.
 */

/** Instant along-heading kick as a fraction of the base speed cap. */
export const REEF_BOOST_PAD_KICK_RATIO = 0.32;

/** Maximum legitimate speed after a boost-pad kick. */
export const REEF_BOOST_PAD_HARD_CAP_MULT = 1.85;

export interface ReefBoostPadVelocity {
  vx: number;
  vz: number;
}

/**
 * Write the capped post-pad velocity into `out` without allocating.
 *
 * The existing lateral component is retained, then total speed receives a
 * belt-and-braces clamp because that retained component can otherwise push the
 * recomposed vector above the legitimate 1.85x ceiling.
 */
export function computeReefBoostPadKick(
  vx: number,
  vz: number,
  heading: number,
  baseMaxSpeed: number,
  out: ReefBoostPadVelocity,
): ReefBoostPadVelocity {
  const hardCap = baseMaxSpeed * REEF_BOOST_PAD_HARD_CAP_MULT;
  const fwdX = Math.sin(heading);
  const fwdZ = Math.cos(heading);
  const perpX = Math.cos(heading);
  const perpZ = -Math.sin(heading);
  const kickedAlong = Math.min(
    vx * fwdX + vz * fwdZ + baseMaxSpeed * REEF_BOOST_PAD_KICK_RATIO,
    hardCap,
  );
  const retainedPerp = vx * perpX + vz * perpZ;

  let nextVx = kickedAlong * fwdX + retainedPerp * perpX;
  let nextVz = kickedAlong * fwdZ + retainedPerp * perpZ;
  const speed = Math.hypot(nextVx, nextVz);
  if (speed > hardCap) {
    const clampScale = hardCap / speed;
    nextVx *= clampScale;
    nextVz *= clampScale;
  }

  out.vx = nextVx;
  out.vz = nextVz;
  return out;
}
