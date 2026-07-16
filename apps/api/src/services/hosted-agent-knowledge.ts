import {
  agents,
  avatars,
  db,
  eq,
  sql,
  type AvatarCharacterConfigJson,
  type Database,
} from '@clawville/database';
import {
  embedText,
  mergeKnowledgeCustomization,
  mergeKnowledgeEntries,
  recordValue,
} from '@clawville/agent-runtime';
import { v5 as uuidv5 } from 'uuid';
import { agentOrchestrator } from './agent-orchestrator';

// UUIDv5 requires a valid v1-v5 namespace UUID. The former `...-7890-...`
// value looked UUID-shaped but failed uuid.validate(), so every memory write
// was silently caught as "Invalid UUID" before it reached ElizaOS.
const KNOWLEDGE_NAMESPACE = 'a1b2c3d4-e5f6-5890-abcd-ef1234567890';

export type HostedKnowledgeSource = 'book' | 'building-visit';

export interface HostedKnowledgeTarget {
  userId: string;
  avatarId: string;
  platformAgentId: string;
}

/** Preserve the earned-skill avatar fallback when no hosted agent is linked. */
export function connectedAgentLessonTarget(
  provenSubject: Pick<HostedKnowledgeTarget, 'avatarId'> | null,
  hostedTarget: HostedKnowledgeTarget | null,
): { avatarId: string; platformAgentId: string } | null {
  if (!provenSubject) return null;
  return {
    avatarId: provenSubject.avatarId,
    platformAgentId:
      hostedTarget?.avatarId === provenSubject.avatarId
        ? hostedTarget.platformAgentId
        : '',
  };
}

export interface SyncHostedAgentKnowledgeInput {
  userId: string;
  avatarId: string;
  entries: readonly string[];
  source: HostedKnowledgeSource;
  metadata?: Record<string, unknown>;
  /**
   * The book-consumption transaction has already merged both JSONB surfaces.
   * Supplying its platform agent target avoids a second transaction while still
   * routing the ElizaOS memory/restart effects through this shared service.
   */
  databaseAlreadyMerged?: {
    platformAgentId: string;
    mergedKnowledge: readonly string[];
  };
}

export interface HostedKnowledgeMergeResult extends HostedKnowledgeTarget {
  newKnowledge: string[];
  mergedKnowledge: string[];
}

export interface HostedAgentKnowledgeDependencies {
  mergeDatabase: (
    input: Pick<SyncHostedAgentKnowledgeInput, 'userId' | 'avatarId' | 'entries'>,
  ) => Promise<HostedKnowledgeMergeResult | null>;
  ensureRuntime: (
    platformAgentId: string,
    userId: string,
  ) => Promise<{ getElizaRuntime(): unknown } | null>;
  embed: (text: string) => Promise<number[]>;
  stopRuntime: (platformAgentId: string) => Promise<void>;
}

interface KnowledgeMemoryWriter {
  createMemory?: (
    memory: Record<string, unknown>,
    tableName: string,
    unique?: boolean,
  ) => Promise<unknown>;
}

type HostedKnowledgeDatabase = Pick<Database, 'transaction'>;

/**
 * Serialize on the active avatar and merge knowledge into both configuration
 * surfaces without copying avatar persona fields over hosted-agent settings.
 */
export async function mergeHostedAgentKnowledgeAtomically(
  database: HostedKnowledgeDatabase,
  input: Pick<SyncHostedAgentKnowledgeInput, 'userId' | 'avatarId' | 'entries'>,
): Promise<HostedKnowledgeMergeResult | null> {
  return database.transaction(async (tx) => {
    const lockedAvatar = (
      await tx.execute<{
        id: string;
        platform_agent_id: string | null;
        character_config: Record<string, unknown> | null;
      }>(
        sql`SELECT id, platform_agent_id, character_config
            FROM avatars
            WHERE id = ${input.avatarId}
              AND user_id = ${input.userId}
              AND is_active = true
            FOR UPDATE`,
      )
    )[0];
    if (!lockedAvatar?.platform_agent_id) return null;

    const lockedAgent = (
      await tx.execute<{ customization: Record<string, unknown> | null }>(
        sql`SELECT customization
            FROM platform_agents
            WHERE id = ${lockedAvatar.platform_agent_id}
              AND user_id = ${input.userId}
            FOR UPDATE`,
      )
    )[0];
    if (!lockedAgent) return null;

    const avatarConfig = recordValue(lockedAvatar.character_config);
    const avatarMerge = mergeKnowledgeEntries(
      avatarConfig.knowledge,
      input.entries,
    );
    const agentMerge = mergeKnowledgeEntries(
      recordValue(lockedAgent.customization).knowledge,
      input.entries,
    );

    if (avatarMerge.newKnowledge.length > 0 || agentMerge.newKnowledge.length > 0) {
      const now = new Date();
      if (avatarMerge.newKnowledge.length > 0) {
        await tx
          .update(avatars)
          .set({
            characterConfig: {
              ...avatarConfig,
              knowledge: avatarMerge.mergedKnowledge,
            } as AvatarCharacterConfigJson,
            updatedAt: now,
          })
          .where(eq(avatars.id, lockedAvatar.id));
      }
      if (agentMerge.newKnowledge.length > 0) {
        await tx
          .update(agents)
          .set({
            customization: mergeKnowledgeCustomization(
              lockedAgent.customization,
              agentMerge.mergedKnowledge,
            ),
            updatedAt: now,
          })
          .where(eq(agents.id, lockedAvatar.platform_agent_id));
      }
    }

    return {
      userId: input.userId,
      avatarId: lockedAvatar.id,
      platformAgentId: lockedAvatar.platform_agent_id,
      // Runtime memory belongs to the platform agent, so only entries absent
      // from its own customization are candidates for embedding. Avatar-only
      // and agent-only knowledge are both preserved independently.
      newKnowledge: agentMerge.newKnowledge,
      mergedKnowledge: avatarMerge.mergedKnowledge,
    };
  });
}

const defaultDependencies: HostedAgentKnowledgeDependencies = {
  mergeDatabase: (input) => mergeHostedAgentKnowledgeAtomically(db, input),
  ensureRuntime: (platformAgentId, userId) =>
    agentOrchestrator.ensureAgentRuntime(platformAgentId, userId),
  embed: embedText,
  stopRuntime: (platformAgentId) => agentOrchestrator.stopAgent(platformAgentId),
};

/**
 * Make learned knowledge available to the hosted ElizaOS brain.
 *
 * Database persistence is authoritative. Memory creation and runtime restart
 * are deliberately best-effort so an embedding/provider outage cannot undo a
 * visit or a committed book consume.
 */
export async function syncHostedAgentKnowledge(
  input: SyncHostedAgentKnowledgeInput,
  dependencies: HostedAgentKnowledgeDependencies = defaultDependencies,
): Promise<HostedKnowledgeMergeResult | null> {
  const target = input.databaseAlreadyMerged
    ? {
        userId: input.userId,
        avatarId: input.avatarId,
        platformAgentId: input.databaseAlreadyMerged.platformAgentId,
        newKnowledge: [...input.entries],
        mergedKnowledge: [...input.databaseAlreadyMerged.mergedKnowledge],
      }
    : await dependencies.mergeDatabase(input);

  if (!target) return null;

  if (target.newKnowledge.length > 0) {
    try {
      const runtime = await dependencies.ensureRuntime(
        target.platformAgentId,
        target.userId,
      );
      const elizaRuntime = runtime?.getElizaRuntime() as KnowledgeMemoryWriter | null | undefined;
      if (elizaRuntime?.createMemory) {
        for (const entry of target.newKnowledge) {
          try {
            const embedding = await dependencies.embed(entry);
            await elizaRuntime.createMemory(
              {
                id: uuidv5(
                  `knowledge:${target.avatarId}:${entry}`,
                  KNOWLEDGE_NAMESPACE,
                ),
                agentId: target.platformAgentId,
                entityId: target.platformAgentId,
                roomId: target.platformAgentId,
                content: { text: entry, source: input.source },
                embedding,
                createdAt: Date.now(),
                metadata: {
                  ...input.metadata,
                  type: 'custom',
                  subtype: 'knowledge',
                  source: input.source,
                },
              },
              'knowledge',
              true,
            );
          } catch (error) {
            console.warn(
              `[hosted-agent-knowledge] Memory persist failed (non-fatal): ${(error as Error).message}`,
            );
          }
        }
      }
    } catch (error) {
      console.warn(
        `[hosted-agent-knowledge] Runtime unavailable (non-fatal): ${(error as Error).message}`,
      );
    }
  }

  try {
    await dependencies.stopRuntime(target.platformAgentId);
  } catch (error) {
    console.warn(
      `[hosted-agent-knowledge] Runtime restart preparation failed (non-fatal): ${(error as Error).message}`,
    );
  }

  return target;
}
