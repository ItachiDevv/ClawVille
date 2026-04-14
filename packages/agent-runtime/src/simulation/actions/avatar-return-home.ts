/**
 * AVATAR_RETURN_HOME action
 *
 * Starts the avatar walking back to the map center (spawn point).
 * Used when the LLM planner decides the avatar should rest.
 * The subsequent arrival is handled by the bridge's path-arrival
 * handler which transitions to 'sleeping' or 'idle'.
 */

import type { Action, ActionResult } from '@elizaos/core';
import type { AvatarStateStore } from '../avatar-state-store';
import type { PathfindFn } from '../types';

export interface PetReturnHomeDeps {
  stateStore: AvatarStateStore;
  pathfind: PathfindFn;
  homeX?: number;
  homeY?: number;
}

export function createPetReturnHomeAction(deps: PetReturnHomeDeps): Action {
  const { stateStore, pathfind } = deps;
  const homeX = deps.homeX ?? 1280; // default: center of 2560x2560 map
  const homeY = deps.homeY ?? 1280;

  return {
    name: 'AVATAR_RETURN_HOME',
    description:
      'Sends the avatar walking back to its home spawn point. Use when the avatar should stop exploring for a while. Parameters: userId.',
    similes: ['GO_HOME', 'RETURN_TO_SPAWN', 'REST'],
    parameters: [
      {
        name: 'userId',
        description: 'The owner userId of the avatar to send home',
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
        return { success: false, error: 'AVATAR_RETURN_HOME requires userId parameter' };
      }

      const avatar = stateStore.get(userId);
      if (!avatar) {
        return { success: false, error: `No avatar registered for userId ${userId}` };
      }

      const path = pathfind(avatar.x, avatar.y, homeX, homeY);
      if (path.length === 0) {
        avatar.behaviorCooldown = 10;
        return { success: false, error: 'No path home from current position' };
      }

      avatar.activity = 'walking';
      avatar.activityEmoji = '';
      avatar.destinationBuildingId = null; // null destination = going home
      avatar.path = path;
      avatar.pathIndex = 0;
      avatar.behaviorCooldown = 200;
      avatar.chatMessage = null;

      return {
        success: true,
        text: `${avatar.name} is heading home`,
        values: { pathLength: path.length },
        data: { userId, avatarId: avatar.avatarId },
      };
    },
  };
}
