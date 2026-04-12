import type { Provider, ProviderResult } from './types';

/**
 * World State Provider — surfaces nearby buildings and NPC activity.
 *
 * Expects:
 *   state.worldSnapshot — { npcs: Array<{name, activity, destinationBuildingId, isDead}> }
 *   state.nearLocation  — current building ID (string) if the pet is inside one
 */
export const worldStateProvider: Provider = {
  name: 'world-state',
  description: 'Nearby buildings, NPC activity, and current location',
  position: 20,

  async get(_runtime: any, _message: any, state: any): Promise<ProviderResult> {
    const snapshot = state?.worldSnapshot;
    const nearLocation = state?.nearLocation as string | undefined;

    if (!snapshot && !nearLocation) {
      return { text: '', values: {}, data: {} };
    }

    const lines: string[] = ['[World State]'];

    if (nearLocation) {
      lines.push(`Current location: ${nearLocation}`);
    }

    const npcs = snapshot?.npcs as Array<{
      name?: string;
      activity?: string;
      destinationBuildingId?: string;
      isDead?: boolean;
    }> | undefined;

    if (npcs && npcs.length > 0) {
      const alive = npcs.filter((n) => !n.isDead);
      const summaries = alive.slice(0, 8).map((n) => {
        const name = n.name ?? 'Unknown NPC';
        const activity = n.activity ?? 'idle';
        const near = n.destinationBuildingId ? ` near ${n.destinationBuildingId}` : '';
        return `${name} is ${activity}${near}`;
      });

      if (summaries.length > 0) {
        lines.push(`Nearby NPCs: ${summaries.join('. ')}.`);
      }
    }

    // If the only line is the header, nothing useful to report
    if (lines.length === 1) {
      return { text: '', values: {}, data: {} };
    }

    return {
      text: lines.join('\n'),
      values: {
        currentLocation: nearLocation ?? '',
      },
      data: {
        worldSnapshot: snapshot ?? null,
        nearLocation: nearLocation ?? null,
      },
    };
  },
};
