import type { Provider, ProviderResult } from './types';

/**
 * Quest Provider — surfaces active and available quests.
 *
 * Expects:
 *   state.activeQuests    — Array<{ name: string; status?: string; reward?: number }>
 *   state.availableQuests — Array<{ name: string; reward?: number }>
 */
export const questProvider: Provider = {
  name: 'quest',
  description: 'Active and available quests with rewards',
  position: 40,

  async get(_runtime: any, _message: any, state: any): Promise<ProviderResult> {
    const activeQuests = state?.activeQuests as Array<{
      name?: string;
      status?: string;
      reward?: number;
    }> | undefined;

    const availableQuests = state?.availableQuests as Array<{
      name?: string;
      reward?: number;
    }> | undefined;

    const hasActive = activeQuests && activeQuests.length > 0;
    const hasAvailable = availableQuests && availableQuests.length > 0;

    if (!hasActive && !hasAvailable) {
      return { text: '', values: {}, data: {} };
    }

    const lines: string[] = ['[Quests]'];

    if (hasActive) {
      const entries = activeQuests.map((q) => {
        const name = q.name ?? 'Unnamed Quest';
        const status = q.status ?? 'in progress';
        const reward = q.reward ? `, ${q.reward} vCLAW reward` : '';
        return `"${name}" (${status}${reward})`;
      });
      lines.push(`Active: ${entries.join('; ')}`);
    }

    if (hasAvailable) {
      const entries = availableQuests.map((q) => {
        const name = q.name ?? 'Unnamed Quest';
        const reward = q.reward ? ` (${q.reward} vCLAW reward)` : '';
        return `"${name}"${reward}`;
      });
      lines.push(`Available: ${entries.join('; ')}`);
    }

    return {
      text: lines.join('\n'),
      values: {
        activeQuestCount: activeQuests?.length ?? 0,
        availableQuestCount: availableQuests?.length ?? 0,
      },
      data: {
        activeQuests: activeQuests ?? [],
        availableQuests: availableQuests ?? [],
      },
    };
  },
};
