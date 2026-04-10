/**
 * Shared types for the simulation package.
 *
 * These are re-declarations / narrow types that avoid importing from
 * apps/api (which would create a cyclic dependency). The pathfinding and
 * activity constants live in @clawville/shared and apps/api — we only
 * redeclare the minimal shapes we need here.
 */

export type PetDirection = 'idle' | 'left' | 'right' | 'up' | 'down';

// NpcActivity is defined in @clawville/shared. We mirror the type here to
// avoid agent-runtime depending on shared at runtime (shared imports are
// type-only in most code paths). If shared's NpcActivity ever expands, this
// may need to be updated.
export type NpcActivity =
  | 'idle'
  | 'walking'
  | 'thinking'
  | 'working'
  | 'eating'
  | 'drinking'
  | 'sleeping'
  | 'dancing'
  | 'reading'
  | 'chatting'
  | 'shopping'
  | 'exploring'
  | 'fighting'
  | 'celebrating'
  | 'crafting'
  | 'praying'
  | 'training'
  | 'resting';

export interface PathNode {
  x: number;
  y: number;
}

/**
 * Callback type for path computation. The bridge injects a real
 * pathfinder at construction time — this keeps agent-runtime
 * independent of apps/api's pathfinding service.
 */
export type PathfindFn = (x1: number, y1: number, x2: number, y2: number) => PathNode[];

/**
 * Building metadata required by the pet actions. Shape matches
 * NPC_BUILDING_CENTERS in @clawville/shared.
 */
export interface BuildingCenter {
  x: number;
  y: number;
}

export type BuildingCenters = Record<string, BuildingCenter>;

/** Map of building ID → activity names that pets can perform there */
export type BuildingActivities = Record<string, NpcActivity[]>;

/** Map of activity name → emoji string */
export type ActivityEmojis = Record<NpcActivity, string>;

/**
 * DB write hooks — the bridge injects real DB functions so that
 * agent-runtime doesn't depend on @clawville/database directly.
 */
export interface PetDbHooks {
  awardToken: (petId: string) => Promise<void>;
  logActivity: (
    petId: string,
    activityType: string,
    description: string,
    tokensEarned: number,
  ) => Promise<void>;
}
