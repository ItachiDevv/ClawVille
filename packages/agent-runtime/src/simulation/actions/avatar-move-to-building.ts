/**
 * AVATAR_MOVE_TO_BUILDING action
 *
 * Computes a path from the avatar's current position to the target
 * building center and sets the avatar's activity to 'walking'. The
 * actual per-tick movement along the path is handled by
 * stepMovement() in movement.ts (pure, no LLM).
 */

import type { Action, ActionResult } from '@elizaos/core';
import type { AvatarStateStore } from '../avatar-state-store';
import type { BuildingCenters, PathfindFn } from '../types';

export interface AvatarMoveToBuildingDeps {
  stateStore: AvatarStateStore;
  buildingCenters: BuildingCenters;
  pathfind: PathfindFn;
}

export function createAvatarMoveToBuildingAction(deps: AvatarMoveToBuildingDeps): Action {
  const { stateStore, buildingCenters, pathfind } = deps;

  return {
    name: 'AVATAR_MOVE_TO_BUILDING',
    description:
      "Starts the avatar walking toward a specific building. Parameters: userId (whose avatar to move), buildingId (target building). The avatar's path is computed and activity is set to 'walking'. Movement along the path happens automatically each tick.",
    similes: ['WALK_TO', 'GO_TO_BUILDING', 'VISIT_NEXT'],
    parameters: [
      {
        name: 'userId',
        description: 'The owner userId of the avatar to move',
        required: true,
        schema: { type: 'string' },
      },
      {
        name: 'buildingId',
        description: 'The building ID to walk toward (e.g. "cron-automation", "api-integrations")',
        required: true,
        schema: { type: 'string' },
      },
    ],
    examples: [],
    validate: async (_runtime, _message, _state) => {
      return true;
    },
    handler: async (_runtime, _message, _state, options): Promise<ActionResult> => {
      const params = options?.parameters as { userId?: string; buildingId?: string } | undefined;
      const userId = params?.userId;
      const buildingId = params?.buildingId;

      if (!userId || !buildingId) {
        return {
          success: false,
          error: 'AVATAR_MOVE_TO_BUILDING requires userId and buildingId parameters',
        };
      }

      const avatar = stateStore.get(userId);
      if (!avatar) {
        return { success: false, error: `No avatar registered for userId ${userId}` };
      }

      const center = buildingCenters[buildingId];
      if (!center) {
        return { success: false, error: `Unknown buildingId: ${buildingId}` };
      }

      // Add small randomized offset so multiple avatars don't stack on the exact same point
      const offsetX = (Math.random() - 0.5) * 30;
      const offsetY = 15 + Math.random() * 15;
      const path = pathfind(avatar.x, avatar.y, center.x + offsetX, center.y + offsetY);

      if (path.length === 0) {
        // Pathfinding failed — reset cooldown so we can try again soon
        avatar.behaviorCooldown = 10;
        return { success: false, error: `No path found from (${avatar.x}, ${avatar.y}) to ${buildingId}` };
      }

      avatar.activity = 'walking';
      avatar.activityEmoji = '';
      avatar.destinationBuildingId = buildingId;
      avatar.path = path;
      avatar.pathIndex = 0;
      avatar.behaviorCooldown = 100;
      avatar.chatMessage = null;

      return {
        success: true,
        text: `${avatar.name} is walking to ${buildingId}`,
        values: {
          destinationBuildingId: buildingId,
          pathLength: path.length,
        },
        data: {
          userId,
          avatarId: avatar.avatarId,
        },
      };
    },
  };
}
