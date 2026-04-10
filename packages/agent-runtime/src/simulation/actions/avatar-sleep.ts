/**
 * AVATAR_SLEEP action
 *
 * Terminal autonomous-mode state. The avatar stops moving and displays
 * "*zzz...*" until the user returns (reportUserActivity() snaps them
 * back to user control via the state store).
 *
 * continueChain: false so the planner doesn't try to queue more
 * actions on top of sleeping.
 */

import type { Action, ActionResult } from '@elizaos/core';
import type { AvatarStateStore } from '../avatar-state-store';
import type { ActivityEmojis } from '../types';

export interface PetSleepDeps {
  stateStore: AvatarStateStore;
  activityEmojis: ActivityEmojis;
}

export function createPetSleepAction(deps: PetSleepDeps): Action {
  const { stateStore, activityEmojis } = deps;

  return {
    name: 'AVATAR_SLEEP',
    description:
      'Puts the avatar to sleep. Terminal state — the avatar stays sleeping until the user returns to the game. Parameters: userId.',
    similes: ['REST', 'NAP', 'STOP'],
    parameters: [
      {
        name: 'userId',
        description: 'The owner userId of the avatar to put to sleep',
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
        return { success: false, error: 'AVATAR_SLEEP requires userId parameter' };
      }

      const avatar = stateStore.get(userId);
      if (!avatar) {
        return { success: false, error: `No avatar registered for userId ${userId}` };
      }

      avatar.activity = 'sleeping';
      avatar.activityEmoji = activityEmojis.sleeping ?? '';
      avatar.activityEndsAt = 0; // Never expires — user must take control
      avatar.path = [];
      avatar.pathIndex = 0;
      avatar.destinationBuildingId = null;
      avatar.chatMessage = '*zzz...*';

      return {
        success: true,
        text: `${avatar.name} is sleeping`,
        values: { activity: 'sleeping' },
        data: { userId, avatarId: avatar.avatarId },
        continueChain: false,
      };
    },
  };
}
