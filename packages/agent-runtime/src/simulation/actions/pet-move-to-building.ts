/**
 * PET_MOVE_TO_BUILDING action
 *
 * Computes a path from the pet's current position to the target
 * building center and sets the pet's activity to 'walking'. The
 * actual per-tick movement along the path is handled by
 * movePet() in movement.ts (pure, no LLM).
 */

import type { Action, ActionResult } from '@elizaos/core';
import type { PetStateStore } from '../pet-state-store';
import type { BuildingCenters, PathfindFn } from '../types';

export interface PetMoveToBuildingDeps {
  stateStore: PetStateStore;
  buildingCenters: BuildingCenters;
  pathfind: PathfindFn;
}

export function createPetMoveToBuildingAction(deps: PetMoveToBuildingDeps): Action {
  const { stateStore, buildingCenters, pathfind } = deps;

  return {
    name: 'PET_MOVE_TO_BUILDING',
    description:
      "Starts the pet walking toward a specific building. Parameters: userId (whose pet to move), buildingId (target building). The pet's path is computed and activity is set to 'walking'. Movement along the path happens automatically each tick.",
    similes: ['WALK_TO', 'GO_TO_BUILDING', 'VISIT_NEXT'],
    parameters: [
      {
        name: 'userId',
        description: 'The owner userId of the pet to move',
        required: true,
        schema: { type: 'string' },
      },
      {
        name: 'buildingId',
        description: 'The building ID to walk toward (e.g. "cron-hub", "webhook-gateway")',
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
          error: 'PET_MOVE_TO_BUILDING requires userId and buildingId parameters',
        };
      }

      const pet = stateStore.get(userId);
      if (!pet) {
        return { success: false, error: `No pet registered for userId ${userId}` };
      }

      const center = buildingCenters[buildingId];
      if (!center) {
        return { success: false, error: `Unknown buildingId: ${buildingId}` };
      }

      // Add small randomized offset so multiple pets don't stack on the exact same point
      const offsetX = (Math.random() - 0.5) * 30;
      const offsetY = 15 + Math.random() * 15;
      const path = pathfind(pet.x, pet.y, center.x + offsetX, center.y + offsetY);

      if (path.length === 0) {
        // Pathfinding failed — reset cooldown so we can try again soon
        pet.behaviorCooldown = 10;
        return { success: false, error: `No path found from (${pet.x}, ${pet.y}) to ${buildingId}` };
      }

      pet.activity = 'walking';
      pet.activityEmoji = '';
      pet.destinationBuildingId = buildingId;
      pet.path = path;
      pet.pathIndex = 0;
      pet.behaviorCooldown = 100;
      pet.chatMessage = null;

      return {
        success: true,
        text: `${pet.name} is walking to ${buildingId}`,
        values: {
          destinationBuildingId: buildingId,
          pathLength: path.length,
        },
        data: {
          userId,
          petId: pet.petId,
        },
      };
    },
  };
}
