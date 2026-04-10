/**
 * Shared types for the simulation package.
 *
 * NpcActivity and related constants are imported directly from
 * @clawville/shared — single source of truth. Pathfinding is still
 * injected via PathfindFn to avoid depending on apps/api.
 */

import type { NpcActivity as SharedNpcActivity } from '@clawville/shared';

export type PetDirection = 'idle' | 'left' | 'right' | 'up' | 'down';

// Re-export the shared NpcActivity type so consumers within agent-runtime
// have a stable local import without reaching into @clawville/shared
export type NpcActivity = SharedNpcActivity;

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
 * Building metadata required by the avatar actions. Shape matches
 * NPC_BUILDING_CENTERS in @clawville/shared.
 */
export interface BuildingCenter {
  x: number;
  y: number;
}

export type BuildingCenters = Record<string, BuildingCenter>;

/** Map of building ID → activity names that avatars can perform there */
export type BuildingActivities = Record<string, NpcActivity[]>;

/** Map of activity name → emoji string */
export type ActivityEmojis = Record<NpcActivity, string>;

/**
 * DB write hooks — the bridge injects real DB functions so that
 * agent-runtime doesn't depend on @clawville/database directly.
 */
export interface PetDbHooks {
  awardToken: (avatarId: string) => Promise<void>;
  logActivity: (
    avatarId: string,
    activityType: string,
    description: string,
    tokensEarned: number,
  ) => Promise<void>;
}
