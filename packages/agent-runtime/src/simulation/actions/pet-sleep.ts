/**
 * PET_SLEEP action
 *
 * Terminal autonomous-mode state. The pet stops moving and displays
 * "*zzz...*" until the user returns (reportUserActivity() snaps them
 * back to user control via the state store).
 *
 * continueChain: false so the planner doesn't try to queue more
 * actions on top of sleeping.
 */

import type { Action, ActionResult } from '@elizaos/core';
import type { PetStateStore } from '../pet-state-store';
import type { ActivityEmojis } from '../types';

export interface PetSleepDeps {
  stateStore: PetStateStore;
  activityEmojis: ActivityEmojis;
}

export function createPetSleepAction(deps: PetSleepDeps): Action {
  const { stateStore, activityEmojis } = deps;

  return {
    name: 'PET_SLEEP',
    description:
      'Puts the pet to sleep. Terminal state — the pet stays sleeping until the user returns to the game. Parameters: userId.',
    similes: ['REST', 'NAP', 'STOP'],
    parameters: [
      {
        name: 'userId',
        description: 'The owner userId of the pet to put to sleep',
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
        return { success: false, error: 'PET_SLEEP requires userId parameter' };
      }

      const pet = stateStore.get(userId);
      if (!pet) {
        return { success: false, error: `No pet registered for userId ${userId}` };
      }

      pet.activity = 'sleeping';
      pet.activityEmoji = activityEmojis.sleeping ?? '';
      pet.activityEndsAt = 0; // Never expires — user must take control
      pet.path = [];
      pet.pathIndex = 0;
      pet.destinationBuildingId = null;
      pet.chatMessage = '*zzz...*';

      return {
        success: true,
        text: `${pet.name} is sleeping`,
        values: { activity: 'sleeping' },
        data: { userId, petId: pet.petId },
        continueChain: false,
      };
    },
  };
}
