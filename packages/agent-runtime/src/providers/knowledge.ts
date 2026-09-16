import type { Provider, ProviderResult } from './types';
import { embedText } from '../plugins/embed-text';
import {
  protocolKnowledgeEntityId,
  protocolKnowledgeRoomId,
} from '../protocol-knowledge';

/**
 * Knowledge Provider — surfaces the avatar's learned skills in the prompt.
 *
 * Phase 2 upgrade: instead of dumping the entire characterConfig.knowledge[]
 * array (which overflows the context window at 30+ entries), this provider
 * embeds the user's current message and retrieves the top-K most relevant
 * knowledge entries from ElizaOS's memories table via vector similarity.
 *
 * The hosted game manual lives in a separate, per-agent room and is queried
 * with the same embedding so it cannot bleed across agents or consume a second
 * embed call.
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
const PROTOCOL_TOP_K = 2;
const MATCH_THRESHOLD = 0.3;

/**
 * Manual sections that are ALWAYS on the wire, regardless of similarity:
 * section 0 (front-matter: title + `protocol_version` + the pointer the agent
 * must re-pull on a bump) and section 1 ("Connect": identity, session and the
 * wallet-address invariant). Everything else is retrieved by relevance.
 *
 * Why pinned (2026-09-16): the manual grew to 19 `## ` sections and the
 * hosted-skill-runtime-probe showed that for a "which protocol version am I
 * on" question, top-2 similarity returned sections 0 and 3a (proxy cognition)
 * — the Connect section that carries the wallet invariant ranked 4th by a
 * 0.008 margin. The CONSUMPTION MANDATE (CLAUDE.md) says the deciding model
 * must always see the current world scope; version + identity fundamentals
 * are that scope, so they do not compete with 17 other sections for two slots.
 */
const PINNED_PROTOCOL_SECTIONS = [0, 1] as const;
const PINNED_FETCH_COUNT = 256;

interface ProtocolCandidate {
  text: string;
  version: number;
  sectionKey: string;
  pinnedOrder: number; // 0..n for pinned sections, Infinity for relevance hits
}

function protocolCandidates(results: unknown, keyPrefix: string): ProtocolCandidate[] {
  if (!Array.isArray(results)) return [];
  const out: ProtocolCandidate[] = [];
  for (let i = 0; i < results.length; i++) {
    const memory = results[i] as Record<string, any>;
    const metadata = (memory?.metadata ?? {}) as Record<string, unknown>;
    if (metadata.subtype !== 'protocol-knowledge') continue;

    const text = memory?.content?.text;
    if (typeof text !== 'string' || text.length === 0) continue;

    const section = metadata.section;
    const sectionKey =
      typeof section === 'number' || typeof section === 'string'
        ? String(section)
        : `${keyPrefix}:${i}`;
    const version =
      typeof metadata.version === 'number' && Number.isFinite(metadata.version)
        ? metadata.version
        : Number.NEGATIVE_INFINITY;
    out.push({ text, version, sectionKey, pinnedOrder: Number.POSITIVE_INFINITY });
  }
  return out;
}

/** Dedupe by section (highest version wins), pinned sections first, then hit order. */
function protocolKnowledgeEntries(
  results: unknown,
  pinned: ProtocolCandidate[] = [],
): string[] {
  const bySection = new Map<string, ProtocolCandidate>();
  for (const candidate of [...pinned, ...protocolCandidates(results, 'result')]) {
    const previous = bySection.get(candidate.sectionKey);
    if (!previous || candidate.version > previous.version) {
      bySection.set(candidate.sectionKey, {
        ...candidate,
        pinnedOrder: Math.min(candidate.pinnedOrder, previous?.pinnedOrder ?? Number.POSITIVE_INFINITY),
      });
    } else if (candidate.pinnedOrder < previous.pinnedOrder) {
      bySection.set(candidate.sectionKey, { ...previous, pinnedOrder: candidate.pinnedOrder });
    }
  }
  const ordered = [...bySection.values()];
  ordered.sort((a, b) => a.pinnedOrder - b.pinnedOrder); // stable: relevance hits keep their order
  return ordered.map(({ text }) => text);
}

/**
 * The pinned fundamentals of the CURRENT manual version for this agent.
 * Fail-soft: any error or a runtime without `getMemories` yields [] and the
 * provider falls back to pure relevance retrieval (the pre-2026-09-16 shape).
 */
async function pinnedProtocolSections(runtime: any, agentId: string): Promise<ProtocolCandidate[]> {
  if (typeof runtime?.getMemories !== 'function') return [];
  try {
    const memories = await runtime.getMemories({
      roomId: protocolKnowledgeRoomId(agentId),
      tableName: 'knowledge',
      count: PINNED_FETCH_COUNT,
    });
    const candidates = protocolCandidates(memories, 'pinned');
    if (candidates.length === 0) return [];
    const latest = Math.max(...candidates.map((c) => c.version));
    if (!Number.isFinite(latest)) return [];
    const pinned: ProtocolCandidate[] = [];
    PINNED_PROTOCOL_SECTIONS.forEach((section, order) => {
      const hit = candidates.find((c) => c.version === latest && c.sectionKey === String(section));
      if (hit) pinned.push({ ...hit, pinnedOrder: order });
    });
    return pinned;
  } catch (err) {
    console.warn(
      `[KnowledgeProvider] Pinned protocol sections unavailable (non-fatal): ${(err as Error).message}`,
    );
    return [];
  }
}

function jsonbFallbackResult(allKnowledge: string[]): ProviderResult {
  if (allKnowledge.length === 0) {
    return { text: '', values: {}, data: {} };
  }

  const count = allKnowledge.length;
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
}

export const knowledgeProvider: Provider = {
  name: 'knowledge',
  description: 'Relevant learned knowledge retrieved by semantic similarity',
  position: 50,

  async get(runtime: any, message: any, state: any): Promise<ProviderResult> {
    const config = state?.characterConfig as { knowledge?: string[] } | undefined;
    const allKnowledge = config?.knowledge ?? [];
    const userMessage = state?.userMessage ?? message?.content?.text ?? '';
    const agentId = state?.platformAgentId ?? state?.avatarId;

    // Try vector retrieval first (Phase 2 path)
    if (runtime?.searchMemories && userMessage && agentId) {
      try {
        const queryEmbedding = await embedText(userMessage);
        let entries: string[] = [];
        let protocolEntries: string[] = [];

        try {
          const results = await runtime.searchMemories({
            embedding: queryEmbedding,
            tableName: 'knowledge',
            match_threshold: MATCH_THRESHOLD,
            count: TOP_K,
            roomId: agentId,
            entityId: agentId,
            unique: true,
          });
          if (Array.isArray(results)) {
            entries = results
              .map((memory: any) => memory.content?.text)
              .filter(
                (text: unknown): text is string =>
                  typeof text === 'string' && text.length > 0,
              );
          }
        } catch (err) {
          console.warn(
            `[KnowledgeProvider] Vector retrieval failed, falling back to JSONB: ${(err as Error).message}`,
          );
        }

        // The game manual is isolated from ordinary learned knowledge. Reuse the
        // one query embedding and fail soft so this bounded secondary search can
        // never suppress the primary result. The pinned fundamentals (version +
        // Connect) ride along regardless of the similarity ranking.
        try {
          const [pinned, protocolResults] = await Promise.all([
            pinnedProtocolSections(runtime, agentId),
            runtime.searchMemories({
              embedding: queryEmbedding,
              tableName: 'knowledge',
              match_threshold: MATCH_THRESHOLD,
              count: PROTOCOL_TOP_K,
              roomId: protocolKnowledgeRoomId(agentId),
              entityId: protocolKnowledgeEntityId(agentId),
              unique: true,
            }),
          ]);
          protocolEntries = protocolKnowledgeEntries(protocolResults, pinned);
        } catch (err) {
          console.warn(
            `[KnowledgeProvider] Protocol retrieval failed (non-fatal): ${(err as Error).message}`,
          );
        }

        // If ordinary vector retrieval failed/returned no matches, retain its
        // JSONB fallback before appending protocol matches. The manual augments
        // learned knowledge; it must never replace it in either failure direction.
        if (
          entries.length === 0 &&
          protocolEntries.length > 0 &&
          allKnowledge.length > 0
        ) {
          const fallback = jsonbFallbackResult(allKnowledge);
          return {
            text: `${fallback.text}\n[Game manual \u2014 relevant sections]\n${protocolEntries.join('\n')}`,
            values: {
              ...(fallback.values ?? {}),
              protocolRelevantCount: protocolEntries.length,
            },
            data: {
              ...(fallback.data ?? {}),
              protocolKnowledgeEntries: protocolEntries,
              protocolRelevantCount: protocolEntries.length,
            },
          };
        }

        if (entries.length > 0 || protocolEntries.length > 0) {
          const totalCount = allKnowledge.length || entries.length;
          const lines: string[] = [];
          if (entries.length > 0) {
            lines.push(
              `[Knowledge \u2014 ${totalCount} skills learned, ${entries.length} relevant to this conversation]`,
              ...entries.map((entry, i) => `${i + 1}. ${entry}`),
            );
          }
          if (protocolEntries.length > 0) {
            lines.push(
              '[Game manual \u2014 relevant sections]',
              ...protocolEntries,
            );
          }

          return {
            text: lines.join('\n'),
            values: {
              knowledgeCount: totalCount,
              relevantCount: entries.length,
              ...(protocolEntries.length > 0
                ? { protocolRelevantCount: protocolEntries.length }
                : {}),
              retrievalMode: 'vector',
            },
            data: {
              knowledgeEntries: entries,
              knowledgeCount: totalCount,
              relevantCount: entries.length,
              ...(protocolEntries.length > 0
                ? {
                    protocolKnowledgeEntries: protocolEntries,
                    protocolRelevantCount: protocolEntries.length,
                  }
                : {}),
              retrievalMode: 'vector',
            },
          };
        }
      } catch (err) {
        console.warn(
          `[KnowledgeProvider] Vector retrieval failed, falling back to JSONB: ${(err as Error).message}`,
        );
      }
    }

    // Fallback: read from characterConfig.knowledge[] (pre-Phase 2 path)
    return jsonbFallbackResult(allKnowledge);
  },
};
