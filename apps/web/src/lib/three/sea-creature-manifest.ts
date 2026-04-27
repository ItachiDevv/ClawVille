import type { SeaCreatureManifest, SeaCreatureAnimState } from './sea-creature-types';

const empty: ReadonlySet<SeaCreatureAnimState> = new Set();

export const SEA_CREATURE_MANIFEST: SeaCreatureManifest = {
  lobster:   { hasRig: false, availableStates: empty },
  crayfish:  { hasRig: false, availableStates: empty },
  sea_horse: { hasRig: false, availableStates: empty },
};

/**
 * To enable a species after dropping rigged + animated GLBs at
 *   /models/sea-creatures/<species>/base.glb
 *   /models/sea-creatures/<species>/animations/<state>.glb
 * flip `hasRig: true` and add the per-state names to availableStates, e.g.:
 *   lobster: { hasRig: true, availableStates: new Set(['idle', 'swim', 'boost']) },
 * Missing states fall through to whichever of {idle, swim} is closest, then to
 * the no-anim static-mesh fallback if neither.
 */
