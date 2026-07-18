export const KELP_FOREST_PORTAL_ID = 'kelp-forest-portal';

export const KELP_FOREST_CENTER = Object.freeze({ x: 7808, z: -9900 });

/** Keep the returning avatar outside the portal's expanded prop collider. */
export const KELP_FOREST_EXIT_WORLD = Object.freeze({
  x: KELP_FOREST_CENTER.x,
  z: KELP_FOREST_CENTER.z + 240,
});

export const KELP_FOREST_PORTAL_PROMPT_RADIUS_WU = 360;
