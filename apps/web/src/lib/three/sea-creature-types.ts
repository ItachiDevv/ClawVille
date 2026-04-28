export const SEA_CREATURE_SPECIES = ['lobster', 'crayfish', 'sea_horse'] as const;
export type SeaCreatureSpecies = typeof SEA_CREATURE_SPECIES[number];

export const SEA_CREATURE_ANIM_STATES = [
  'idle',     // resting / cruising slow
  'swim',     // active locomotion
  'boost',    // boost active (faster cycle)
  'hit',      // knockback reaction (one-shot, returns to prior state)
  'victory',  // post-finish celebration
  'wipeout',  // off-track respawn freeze
] as const;
export type SeaCreatureAnimState = typeof SEA_CREATURE_ANIM_STATES[number];

export interface SeaCreatureManifestEntry {
  /** True when a rigged base GLB exists at /models/sea-creatures/<species>/base.glb */
  hasRig: boolean;
  /** Set of states for which an animation clip GLB exists. */
  availableStates: ReadonlySet<SeaCreatureAnimState>;
}

export type SeaCreatureManifest = Record<SeaCreatureSpecies, SeaCreatureManifestEntry>;
