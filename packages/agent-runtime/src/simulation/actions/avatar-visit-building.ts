/**
 * AVATAR_VISIT_BUILDING action
 *
 * Called when an avatar arrives at its destination building. Picks a
 * themed activity from BUILDING_ACTIVITIES, sets the activity timer,
 * awards a ClawToken (at most DAILY_REWARD_CAPS.building_visit paid arrivals
 * per avatar per UTC day; the server-side dbHooks.awardToken enforces the
 * cap), and inserts an activity log row.
 *
 * This action is normally dispatched by the bridge's path-arrival
 * handler rather than chosen by the LLM planner — but it's still
 * a registered Action so ActionResult chaining and evaluators work.
 */

import type { Action, ActionResult } from '@elizaos/core';
import type { AvatarStateStore } from '../avatar-state-store';
import { DAILY_REWARD_CAPS } from '@clawville/shared';
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
      `Avatar arrives at its destination and performs a building-themed activity. Awards 1 vCLAW (at most ${DAILY_REWARD_CAPS.building_visit} paid arrivals per avatar per UTC day). Parameters: userId (whose avatar). The building is inferred from the avatar's destinationBuildingId.`,
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

      // Award token + log activity. The server-side hook enforces the durable
      // per-avatar daily cap (DAILY_REWARD_CAPS.building_visit paid arrivals
      // per UTC day, founder decision 2026-10-04) and resolves to the vCLAW it
      // actually credited. Over the cap the visit still happens and pays 0.
      // Read the value defensively and pay only a positive finite number:
      // a hook that resolves to anything else records 0, never a phantom 1.
      let tokensEarned = 0;
      let rewardFailed = false;
      try {
        const credited: unknown = await dbHooks.awardToken(avatar.avatarId);
        if (typeof credited === 'number' && Number.isFinite(credited) && credited > 0) {
          tokensEarned = Math.floor(credited);
        }
      } catch (err) {
        rewardFailed = true;
        console.error('[AVATAR_VISIT_BUILDING] awardToken failed:', err);
      }
      avatar.tokensEarned += tokensEarned;
      const visitNote =
        tokensEarned > 0
          ? `Visited ${buildingId} and earned ${tokensEarned} vCLAW`
          : rewardFailed
            ? `Visited ${buildingId} (reward failed, no vCLAW)`
            : `Visited ${buildingId} (daily paid-visit cap reached, no vCLAW)`;
      dbHooks
        .logActivity(avatar.avatarId, 'visit', visitNote, tokensEarned)
        .catch((err) => {
          console.error('[AVATAR_VISIT_BUILDING] logActivity failed:', err);
        });

      return {
        success: true,
        text: `${avatar.name} is ${picked} at ${buildingId}`,
        values: {
          tokensEarned,
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
