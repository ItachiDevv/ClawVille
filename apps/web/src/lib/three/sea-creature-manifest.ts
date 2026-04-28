import type { SeaCreatureManifest, SeaCreatureAnimState } from './sea-creature-types';

const empty: ReadonlySet<SeaCreatureAnimState> = new Set();

export const SEA_CREATURE_MANIFEST: SeaCreatureManifest = {
  // Enabled 2026-04-27 after staging A/B preview: rigged-swim was the clear
  // visual winner over procedural sway. GLBs from blender07 hand-rig:
  //   base.glb       — 1588 tris, 9-bone armature
  //   idle.glb       — 60-frame loop @ 24fps (2.46s) — breathing + antennae
  //   swim.glb       — 30-frame loop @ 24fps (1.21s) — tail propulsion
  //   hit.glb        — 12-frame one-shot @ 24fps (0.46s) — body recoil
  // Missing: boost / victory / wipeout — fall through to swim → idle per
  // animator's resolveState chain in sea-creature-animator.ts.
  lobster:   { hasRig: true,  availableStates: new Set(['idle', 'swim', 'hit']) },
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
