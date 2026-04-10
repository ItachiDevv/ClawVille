/**
 * PET_VISIT_BUILDING action
 *
 * Called when a pet arrives at its destination building. Picks a
 * themed activity from BUILDING_ACTIVITIES, sets the activity timer,
 * awards a NeoToken, and inserts an activity log row.
 *
 * This action is normally dispatched by the bridge's path-arrival
 * handler rather than chosen by the LLM planner — but it's still
 * a registered Action so ActionResult chaining and evaluators work.
 */

import type { Action, ActionResult } from '@elizaos/core';
import type { PetStateStore } from '../pet-state-store';
import type { ActivityEmojis, BuildingActivities, PetDbHooks } from '../types';

export interface PetVisitBuildingDeps {
  stateStore: PetStateStore;
  buildingActivities: BuildingActivities;
  activityEmojis: ActivityEmojis;
  dbHooks: PetDbHooks;
}

export function createPetVisitBuildingAction(deps: PetVisitBuildingDeps): Action {
  const { stateStore, buildingActivities, activityEmojis, dbHooks } = deps;

  return {
    name: 'PET_VISIT_BUILDING',
    description:
      "Pet arrives at its destination and performs a building-themed activity. Awards 1 NeoToken. Parameters: userId (whose pet). The building is inferred from the pet's destinationBuildingId.",
    similes: ['ARRIVE_AT', 'ENTER_BUILDING', 'START_ACTIVITY'],
    parameters: [
      {
        name: 'userId',
        description: 'The owner userId of the pet completing the visit',
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
        return { success: false, error: 'PET_VISIT_BUILDING requires userId parameter' };
      }

      const pet = stateStore.get(userId);
      if (!pet) {
        return { success: false, error: `No pet registered for userId ${userId}` };
      }

      const buildingId = pet.destinationBuildingId;
      if (!buildingId) {
        return { success: false, error: `Pet ${pet.name} has no destinationBuildingId` };
      }

      // Pick a themed activity from the building's activity list
      const activities = buildingActivities[buildingId] ?? (['thinking'] as const);
      const picked = activities[Math.floor(Math.random() * activities.length)];

      const now = Date.now();
      pet.activity = picked;
      pet.activityEmoji = activityEmojis[picked] ?? '';
      pet.activityEndsAt = now + 10_000 + Math.random() * 15_000; // 10–25 s
      pet.path = [];
      pet.pathIndex = 0;
      pet.visitCount++;

      // Award token + log activity (limits removed per user decision for Phase 2)
      pet.tokensEarned++;
      dbHooks.awardToken(pet.petId).catch((err) => {
        console.error('[PET_VISIT_BUILDING] awardToken failed:', err);
      });
      dbHooks
        .logActivity(
          pet.petId,
          'visit',
          `Visited ${buildingId} and earned 1 NeoToken`,
          1,
        )
        .catch((err) => {
          console.error('[PET_VISIT_BUILDING] logActivity failed:', err);
        });

      return {
        success: true,
        text: `${pet.name} is ${picked} at ${buildingId}`,
        values: {
          tokensEarned: 1,
          visitCount: pet.visitCount,
          activity: picked,
        },
        data: {
          userId,
          petId: pet.petId,
          buildingId,
        },
      };
    },
  };
}
