/**
 * Reef Race v2 start-grid formation shared by the authoritative spline sim
 * and the countdown-only client display. Keeping this pure math in the shared
 * layer makes the staged grid and the first live snapshot occupy the same
 * coordinates, so GO never causes a visual teleport.
 */

export interface ReefRaceStartFrame {
  center: { x: number; z: number };
  tangent: { x: number; z: number };
  normal: { x: number; z: number };
}

export interface ReefRaceStartGridPose {
  x: number;
  z: number;
  heading: number;
}

/** Authoritative Reef Race pre-start window shared by server and HUD. */
export const REEF_RACE_COUNTDOWN_DURATION_MS = 5_000;

/** Back-stagger between successive two-racer rows.
 * 176wu preserves ~25wu nose-to-tail clearance around the 151wu boards. */
// Founder knob: raise/lower the two-racer row spacing as board length changes.
export const REEF_START_GRID_ROW_SPACING_WU = 176;

/** Lateral half-gap between the left and right grid columns. */
export const REEF_START_GRID_COLUMN_OFFSET_WU = 320;

/** Distance the front row parks behind the start/finish line. */
export const REEF_START_GRID_FRONT_ROW_BACK_WU = 40;

/**
 * Return the exact pose for a participant's insertion-order grid index.
 *
 * IMPORTANT: callers must enumerate the canonical room-participant order.
 * Display metadata order is not authoritative (the metadata loader groups
 * bots and humans), while room participants determine the server spawn order.
 */
export function reefRaceStartGridPose(
  frame: ReefRaceStartFrame,
  participantIndex: number,
): ReefRaceStartGridPose {
  const row = Math.floor(participantIndex / 2);
  const col = participantIndex % 2 === 0 ? -1 : 1;
  const back = row * REEF_START_GRID_ROW_SPACING_WU + REEF_START_GRID_FRONT_ROW_BACK_WU;

  return {
    x:
      frame.center.x +
      frame.tangent.x * (-back) +
      frame.normal.x * col * REEF_START_GRID_COLUMN_OFFSET_WU,
    z:
      frame.center.z +
      frame.tangent.z * (-back) +
      frame.normal.z * col * REEF_START_GRID_COLUMN_OFFSET_WU,
    heading: Math.atan2(frame.tangent.x, frame.tangent.z),
  };
}
