/**
 * avatar-world-state provider
 *
 * Formats per-avatar context as a text block for the LLM planner.
 * The bridge populates avatar state into the message metadata before
 * the tick call; this provider reads that metadata and composes
 * the "what does my avatar see right now" view.
 *
 * Output shape follows v2 ProviderResult: { text, values, data }
 * - text: LLM-facing description
 * - values: structured key/value for template substitution
 * - data: programmatic access for other providers / actions
 */

import type { Provider, ProviderResult } from '@elizaos/core';
import type { AvatarStateStore } from '../avatar-state-store';
import type { BuildingCenters } from '../types';

export interface AvatarWorldStateDeps {
  stateStore: AvatarStateStore;
  buildingCenters: BuildingCenters;
}

export function createAvatarWorldStateProvider(deps: AvatarWorldStateDeps): Provider {
  const { stateStore, buildingCenters } = deps;

  return {
    name: 'AVATAR_WORLD_STATE',
    description:
      "Describes the current state of the avatar being controlled in this tick: position, nearby buildings, visit count, activity, and which buildings have already been visited this session.",
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

      const avatar = stateStore.get(userId);
      if (!avatar) {
        return { text: '', values: {}, data: {} };
      }

      // Score nearby buildings by distance (only IDs the LLM needs to pick from)
      const buildingIds = Object.keys(buildingCenters);
      const withDist = buildingIds
        .map((id) => {
          const c = buildingCenters[id];
          const dx = c.x - avatar.x;
          const dy = c.y - avatar.y;
          return { id, dist: Math.round(Math.sqrt(dx * dx + dy * dy)) };
        })
        .sort((a, b) => a.dist - b.dist);

      const nearest = withDist.slice(0, 6);
      const nearbyLines = nearest.map((b) => `  - ${b.id} (distance ${b.dist}px)`).join('\n');

      const text = [
        `Avatar: ${avatar.name} (${avatar.species}, ${avatar.archetype} archetype)`,
        `Position: (${Math.round(avatar.x)}, ${Math.round(avatar.y)})`,
        `Current activity: ${avatar.activity}${avatar.destinationBuildingId ? ` → ${avatar.destinationBuildingId}` : ''}`,
        `Visits this session: ${avatar.visitCount}`,
        `vCLAW earned this session: ${avatar.tokensEarned}`,
        ``,
        `Nearest buildings:`,
        nearbyLines,
      ].join('\n');

      return {
        text,
        values: {
          avatarName: avatar.name,
          avatarArchetype: avatar.archetype,
          avatarSpecies: avatar.species,
          visitCount: avatar.visitCount,
          tokensEarned: avatar.tokensEarned,
          currentActivity: avatar.activity,
        },
        data: {
          userId: avatar.userId,
          avatarId: avatar.avatarId,
          position: { x: avatar.x, y: avatar.y },
          nearestBuildings: nearest,
          destinationBuildingId: avatar.destinationBuildingId,
        },
      };
    },
  };
}
