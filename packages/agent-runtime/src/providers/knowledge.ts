import type { Provider, ProviderResult } from './types';

/**
 * Knowledge Provider — summarises what the avatar has learned.
 *
 * Expects:
 *   state.characterConfig — { knowledge?: string[] }
 *
 * The knowledge array contains entry strings merged from learned books
 * via the shop → inventory → "Read to Avatar" flow.
 */
export const knowledgeProvider: Provider = {
  name: 'knowledge',
  description: 'Summary of learned knowledge entries',
  position: 50,

  async get(_runtime: any, _message: any, state: any): Promise<ProviderResult> {
    const config = state?.characterConfig as { knowledge?: string[] } | undefined;
    const knowledge = config?.knowledge;

    if (!knowledge || knowledge.length === 0) {
      return { text: '', values: {}, data: {} };
    }

    const count = knowledge.length;

    // Show up to 5 recent entries as short labels (first ~40 chars of each)
    const recentLabels = knowledge
      .slice(-5)
      .map((entry) => {
        // Derive a short label: take first sentence or truncate
        const firstSentence = entry.split(/[.!?]/)[0] ?? entry;
        return firstSentence.length > 40
          ? firstSentence.slice(0, 37) + '...'
          : firstSentence;
      });

    const lines: string[] = [
      `[Knowledge]`,
      `${count} skill${count === 1 ? '' : 's'} learned`,
    ];

    if (recentLabels.length > 0) {
      lines.push(`Recent: ${recentLabels.join(', ')}`);
    }

    return {
      text: lines.join('\n'),
      values: {
        knowledgeCount: count,
      },
      data: {
        knowledgeEntries: knowledge,
        knowledgeCount: count,
      },
    };
  },
};
