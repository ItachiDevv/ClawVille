import type { Provider, ProviderResult } from './types';
import { embedText } from '../plugins/embed-text';

/**
 * Knowledge Provider — surfaces the avatar's learned skills in the prompt.
 *
 * Phase 2 upgrade: instead of dumping the entire characterConfig.knowledge[]
 * array (which overflows the context window at 30+ entries), this provider
 * embeds the user's current message and retrieves the top-K most relevant
 * knowledge entries from ElizaOS's memories table via vector similarity.
 *
 * Falls back to the old characterConfig.knowledge[] read if:
 * - No vector memories exist yet (avatar learned skills before Phase 2)
 * - The runtime doesn't expose searchMemories (shouldn't happen but safe)
 * - The OpenAI embedding call fails (API outage, missing key, etc.)
 *
 * Expects:
 *   state.characterConfig — { knowledge?: string[] }   (fallback)
 *   state.userMessage — the current user message text   (for embedding)
 *   state.avatarId — avatar ID for scoping the knowledge search
 *   runtime — ElizaOS runtime with searchMemories() + generateText()
 */

const TOP_K = 5;
const MATCH_THRESHOLD = 0.3;

export const knowledgeProvider: Provider = {
  name: 'knowledge',
  description: 'Relevant learned knowledge retrieved by semantic similarity',
  position: 50,

  async get(runtime: any, message: any, state: any): Promise<ProviderResult> {
    const config = state?.characterConfig as { knowledge?: string[] } | undefined;
    const allKnowledge = config?.knowledge ?? [];
    const userMessage = state?.userMessage ?? message?.content?.text ?? '';
    const avatarId = state?.avatarId;

    // Try vector retrieval first (Phase 2 path)
    if (runtime?.searchMemories && userMessage && avatarId) {
      try {
        const queryEmbedding = await embedText(userMessage);
        const agentId = state?.platformAgentId ?? avatarId;
        const results = await runtime.searchMemories({
          embedding: queryEmbedding,
          tableName: 'knowledge',
          match_threshold: MATCH_THRESHOLD,
          count: TOP_K,
          roomId: agentId,
          entityId: agentId,
          unique: true,
        });

        if (results && results.length > 0) {
          const entries = results
            .map((m: any) => m.content?.text)
            .filter(Boolean);

          if (entries.length > 0) {
            const totalCount = allKnowledge.length || entries.length;
            const lines = [
              `[Knowledge — ${totalCount} skills learned, ${entries.length} relevant to this conversation]`,
              ...entries.map((e: string, i: number) => `${i + 1}. ${e}`),
            ];

            return {
              text: lines.join('\n'),
              values: {
                knowledgeCount: totalCount,
                relevantCount: entries.length,
                retrievalMode: 'vector',
              },
              data: {
                knowledgeEntries: entries,
                knowledgeCount: totalCount,
                relevantCount: entries.length,
                retrievalMode: 'vector',
              },
            };
          }
        }
      } catch (err) {
        console.warn(`[KnowledgeProvider] Vector retrieval failed, falling back to JSONB: ${(err as Error).message}`);
      }
    }

    // Fallback: read from characterConfig.knowledge[] (pre-Phase 2 path)
    if (allKnowledge.length === 0) {
      return { text: '', values: {}, data: {} };
    }

    const count = allKnowledge.length;

    // Show up to 5 recent entries as short labels (first ~40 chars)
    const recentLabels = allKnowledge
      .slice(-5)
      .map((entry) => {
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
        retrievalMode: 'jsonb-fallback',
      },
      data: {
        knowledgeEntries: allKnowledge,
        knowledgeCount: count,
        retrievalMode: 'jsonb-fallback',
      },
    };
  },
};
