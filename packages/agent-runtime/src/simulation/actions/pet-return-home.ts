/**
 * PET_RETURN_HOME action
 *
 * Starts the pet walking back to the map center (spawn point).
 * Used when the LLM planner decides the pet should rest.
 * The subsequent arrival is handled by the bridge's path-arrival
 * handler which transitions to 'sleeping' or 'idle'.
 */

import type { Action, ActionResult } from '@elizaos/core';
import type { PetStateStore } from '../pet-state-store';
import type { PathfindFn } from '../types';

export interface PetReturnHomeDeps {
  stateStore: PetStateStore;
  pathfind: PathfindFn;
  homeX?: number;
  homeY?: number;
}

export function createPetReturnHomeAction(deps: PetReturnHomeDeps): Action {
  const { stateStore, pathfind } = deps;
  const homeX = deps.homeX ?? 2560; // default: center of 5120x5120 map
  const homeY = deps.homeY ?? 2560;

  return {
    name: 'PET_RETURN_HOME',
    description:
      'Sends the pet walking back to its home spawn point. Use when the pet should stop exploring for a while. Parameters: userId.',
    similes: ['GO_HOME', 'RETURN_TO_SPAWN', 'REST'],
    parameters: [
      {
        name: 'userId',
        description: 'The owner userId of the pet to send home',
        required: true,
        schema: { type: 'string' },
      },
    ],
    examples: [],
    validate: async (_runtime, _message, _state) => {
      return true;
    },
    handler: async (_runtime, _message, _state, options): Promise<ActionResult> => {
      const params = options?.parameters as { userId?: string } | undefined;
      const userId = params?.userId;
      if (!userId) {
        return { success: false, error: 'PET_RETURN_HOME requires userId parameter' };
      }

      const pet = stateStore.get(userId);
      if (!pet) {
        return { success: false, error: `No pet registered for userId ${userId}` };
      }

      const path = pathfind(pet.x, pet.y, homeX, homeY);
      if (path.length === 0) {
        pet.behaviorCooldown = 10;
        return { success: false, error: 'No path home from current position' };
      }

      pet.activity = 'walking';
      pet.activityEmoji = '';
      pet.destinationBuildingId = null; // null destination = going home
      pet.path = path;
      pet.pathIndex = 0;
      pet.behaviorCooldown = 200;
      pet.chatMessage = null;

      return {
        success: true,
        text: `${pet.name} is heading home`,
        values: { pathLength: path.length },
        data: { userId, petId: pet.petId },
      };
    },
  };
}
