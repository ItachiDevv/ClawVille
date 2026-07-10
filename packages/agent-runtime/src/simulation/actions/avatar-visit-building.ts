/**
 * AVATAR_VISIT_BUILDING action
 *
 * Called when an avatar arrives at its destination building. Picks a
 * themed activity from BUILDING_ACTIVITIES, sets the activity timer,
 * awards a ClawToken, and inserts an activity log row.
 *
 * This action is normally dispatched by the bridge's path-arrival
 * handler rather than chosen by the LLM planner — but it's still
 * a registered Action so ActionResult chaining and evaluators work.
 */

import type { Action, ActionResult } from '@elizaos/core';
import type { AvatarStateStore } from '../avatar-state-store';
import type { ActivityEmojis, BuildingActivities, AvatarDbHooks } from '../types';

export interface AvatarVisitBuildingDeps {
  stateStore: AvatarStateStore;
  buildingActivities: BuildingActivities;
  activityEmojis: ActivityEmojis;
  dbHooks: AvatarDbHooks;
}

export function createAvatarVisitBuildingAction(deps: AvatarVisitBuildingDeps): Action {
  const { stateStore, buildingActivities, activityEmojis, dbHooks } = deps;

  return {
    name: 'AVATAR_VISIT_BUILDING',
    description:
      "Avatar arrives at its destination and performs a building-themed activity. Awards 1 vCLAW. Parameters: userId (whose avatar). The building is inferred from the avatar's destinationBuildingId.",
    similes: ['ARRIVE_AT', 'ENTER_BUILDING', 'START_ACTIVITY'],
    parameters: [
      {
        name: 'userId',
        description: 'The owner userId of the avatar completing the visit',
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
        return { success: false, error: 'AVATAR_VISIT_BUILDING requires userId parameter' };
      }

      const avatar = stateStore.get(userId);
      if (!avatar) {
        return { success: false, error: `No avatar registered for userId ${userId}` };
      }

      const buildingId = avatar.destinationBuildingId;
      if (!buildingId) {
        return { success: false, error: `Avatar ${avatar.name} has no destinationBuildingId` };
      }

      // Pick a themed activity from the building's activity list
      const activities = buildingActivities[buildingId] ?? (['thinking'] as const);
      const picked = activities[Math.floor(Math.random() * activities.length)];

      const now = Date.now();
      avatar.activity = picked;
      avatar.activityEmoji = activityEmojis[picked] ?? '';
      avatar.activityEndsAt = now + 10_000 + Math.random() * 15_000; // 10–25 s
      avatar.path = [];
      avatar.pathIndex = 0;
      avatar.visitCount++;

      // Award token + log activity (limits removed per user decision for Phase 2)
      avatar.tokensEarned++;
      dbHooks.awardToken(avatar.avatarId).catch((err) => {
        console.error('[AVATAR_VISIT_BUILDING] awardToken failed:', err);
      });
      dbHooks
        .logActivity(
          avatar.avatarId,
          'visit',
          `Visited ${buildingId} and earned 1 vCLAW`,
          1,
        )
        .catch((err) => {
          console.error('[AVATAR_VISIT_BUILDING] logActivity failed:', err);
        });

      return {
        success: true,
        text: `${avatar.name} is ${picked} at ${buildingId}`,
        values: {
          tokensEarned: 1,
          visitCount: avatar.visitCount,
          activity: picked,
        },
        data: {
          userId,
          avatarId: avatar.avatarId,
          buildingId,
        },
      };
    },
  };
}
