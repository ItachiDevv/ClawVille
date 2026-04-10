/**
 * pet-world-state provider
 *
 * Formats per-pet context as a text block for the LLM planner.
 * The bridge populates pet state into the message metadata before
 * the tick call; this provider reads that metadata and composes
 * the "what does my pet see right now" view.
 *
 * Output shape follows v2 ProviderResult: { text, values, data }
 * - text: LLM-facing description
 * - values: structured key/value for template substitution
 * - data: programmatic access for other providers / actions
 */

import type { Provider, ProviderResult } from '@elizaos/core';
import type { PetStateStore } from '../pet-state-store';
import type { BuildingCenters } from '../types';

export interface PetWorldStateDeps {
  stateStore: PetStateStore;
  buildingCenters: BuildingCenters;
}

export function createPetWorldStateProvider(deps: PetWorldStateDeps): Provider {
  const { stateStore, buildingCenters } = deps;

  return {
    name: 'PET_WORLD_STATE',
    description:
      "Describes the current state of the pet being controlled in this tick: position, nearby buildings, visit count, activity, and which buildings have already been visited this session.",
    dynamic: true,
    get: async (_runtime, message): Promise<ProviderResult> => {
      // The bridge stuffs the target userId into message.metadata.targetUserId
      const metadata = message.metadata as Record<string, unknown> | undefined;
      const userId = metadata?.targetUserId as string | undefined;

      if (!userId) {
        return {
          text: '',
          values: {},
          data: {},
        };
      }

      const pet = stateStore.get(userId);
      if (!pet) {
        return { text: '', values: {}, data: {} };
      }

      // Score nearby buildings by distance (only IDs the LLM needs to pick from)
      const buildingIds = Object.keys(buildingCenters);
      const withDist = buildingIds
        .map((id) => {
          const c = buildingCenters[id];
          const dx = c.x - pet.x;
          const dy = c.y - pet.y;
          return { id, dist: Math.round(Math.sqrt(dx * dx + dy * dy)) };
        })
        .sort((a, b) => a.dist - b.dist);

      const nearest = withDist.slice(0, 6);
      const nearbyLines = nearest.map((b) => `  - ${b.id} (distance ${b.dist}px)`).join('\n');

      const text = [
        `Pet: ${pet.name} (${pet.species}, ${pet.archetype} archetype)`,
        `Position: (${Math.round(pet.x)}, ${Math.round(pet.y)})`,
        `Current activity: ${pet.activity}${pet.destinationBuildingId ? ` → ${pet.destinationBuildingId}` : ''}`,
        `Visits this session: ${pet.visitCount}`,
        `ClawTokens earned this session: ${pet.tokensEarned}`,
        ``,
        `Nearest buildings:`,
        nearbyLines,
      ].join('\n');

      return {
        text,
        values: {
          petName: pet.name,
          petArchetype: pet.archetype,
          petSpecies: pet.species,
          visitCount: pet.visitCount,
          tokensEarned: pet.tokensEarned,
          currentActivity: pet.activity,
        },
        data: {
          userId: pet.userId,
          petId: pet.petId,
          position: { x: pet.x, y: pet.y },
          nearestBuildings: nearest,
          destinationBuildingId: pet.destinationBuildingId,
        },
      };
    },
  };
}
