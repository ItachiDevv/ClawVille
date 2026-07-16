import { createHash } from "node:crypto";
import {
  agentBots,
  agents,
  and,
  avatars,
  buildingSkills,
  db,
  eq,
  sql,
} from "@clawville/database";
import {
  embedText,
  splitProtocolManualSections,
} from "@clawville/agent-runtime";
import { v5 as uuidv5 } from "uuid";
import { agentOrchestrator } from "./agent-orchestrator";
import { withKeyedMutex } from "./keyed-mutex";

// Shared with hosted-agent-knowledge.ts. This is intentionally a valid UUIDv5
// namespace; changing it would orphan every deterministic hosted knowledge id.
export const BUILDING_SKILL_KNOWLEDGE_NAMESPACE =
  "a1b2c3d4-e5f6-5890-abcd-ef1234567890";

export type BuildingSkillInstallStatus = "runtime" | "marker" | "already";

export interface BuildingSkillInstallResult {
  buildingId: string;
  contentHash: string;
  installed: BuildingSkillInstallStatus;
}

export class BuildingSkillInstallError extends Error {
  constructor(
    readonly code:
      | "skill_not_found"
      | "entry_skill_auto_installed"
      | "agent_not_connected"
      | "runtime_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "BuildingSkillInstallError";
  }
}

interface BuildingSkillSource {
  content: string;
  /** Canonical manifest shape: `sha256:<hex>`. */
  contentHash: string;
}

interface BuildingSkillMemoryWriter {
  createMemory?: (
    memory: Record<string, unknown>,
    tableName: string,
    unique?: boolean,
  ) => Promise<unknown>;
}

export interface BuildingSkillLockedStore {
  loadSkill: (buildingId: string) => Promise<BuildingSkillSource | null>;
  installedSections: (input: {
    platformAgentId: string;
    buildingId: string;
    contentHash: string;
  }) => Promise<Set<number>>;
  retireStaleSections: (input: {
    platformAgentId: string;
    buildingId: string;
    contentHash: string;
  }) => Promise<boolean>;
}

export interface BuildingSkillInstallDependencies {
  loadSkill: (buildingId: string) => Promise<BuildingSkillSource | null>;
  resolvePlatformAgentId: (input: {
    userId: string;
    avatarId: string;
  }) => Promise<string | null>;
  installedSections: (input: {
    platformAgentId: string;
    buildingId: string;
    contentHash: string;
  }) => Promise<Set<number>>;
  getRuntime: (
    platformAgentId: string,
    userId: string,
  ) => Promise<{ getElizaRuntime(): unknown } | null>;
  embed: (text: string) => Promise<number[]>;
  mergeConnectedMarkers: (input: {
    userId: string;
    buildingId: string;
    contentHash: string;
    provenAgentId?: string;
  }) => Promise<boolean>;
  withLocalInstallLock: <T>(
    key: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  withCrossPodInstallLock: <T>(
    key: string,
    operation: (store: BuildingSkillLockedStore) => Promise<T>,
  ) => Promise<T>;
  withGlobalInstallSlot: <T>(operation: () => Promise<T>) => Promise<T>;
}

function canonicalContentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function retireStaleSectionsOrThrow(
  store: BuildingSkillLockedStore,
  input: {
    platformAgentId: string;
    buildingId: string;
    contentHash: string;
  },
): Promise<void> {
  try {
    const retired = await store.retireStaleSections(input);
    if (!retired) {
      throw new Error("canonical building skill changed during install");
    }
  } catch (error) {
    throw new BuildingSkillInstallError(
      "runtime_unavailable",
      `Building skill refresh could not retire stale sections: ${(error as Error).message}`,
    );
  }
}

export function buildingSkillMemoryId(input: {
  platformAgentId: string;
  buildingId: string;
  contentHash: string;
  section: number;
}): string {
  return uuidv5(
    `building-skill:${input.platformAgentId}:${input.buildingId}:v${input.contentHash}:${input.section}`,
    BUILDING_SKILL_KNOWLEDGE_NAMESPACE,
  );
}

/** Replace any stale marker for this building while preserving other knowledge. */
export function mergeBuildingSkillMarker(
  current: readonly unknown[],
  buildingId: string,
  contentHash: string,
): string[] {
  const prefix = `skill:${buildingId}@`;
  const marker = `${prefix}${contentHash.replace(/^sha256:/, "").slice(0, 8)}`;
  return [
    ...current.filter(
      (entry): entry is string =>
        typeof entry === "string" && !entry.startsWith(prefix),
    ),
    marker,
  ];
}

const defaultDependencies: BuildingSkillInstallDependencies = {
  async loadSkill(buildingId) {
    const row = await db.query.buildingSkills.findFirst({
      where: eq(buildingSkills.buildingId, buildingId),
      columns: { content: true },
    });
    if (!row) return null;
    // Match the manifest route: hash the exact served bytes live. The nullable
    // raw-hex DB column is an optimization/backfill aid and may be stale.
    return {
      content: row.content,
      contentHash: canonicalContentHash(row.content),
    };
  },

  async resolvePlatformAgentId(input) {
    const [target] = await db
      .select({ platformAgentId: avatars.platformAgentId })
      .from(avatars)
      .innerJoin(
        agents,
        and(
          eq(agents.id, avatars.platformAgentId),
          eq(agents.userId, input.userId),
        ),
      )
      .where(
        and(
          eq(avatars.id, input.avatarId),
          eq(avatars.userId, input.userId),
          eq(avatars.isActive, true),
        ),
      )
      .limit(1);
    return target?.platformAgentId ?? null;
  },

  async installedSections(input) {
    try {
      const rows = await db.execute<{ section: string | null }>(sql`
        SELECT metadata->>'section' AS section
        FROM memories
        WHERE type = 'knowledge'
          AND agent_id = ${input.platformAgentId}
          AND room_id = ${input.platformAgentId}
          AND entity_id = ${input.platformAgentId}
          AND metadata->>'subtype' = 'building-skill'
          AND metadata->>'buildingId' = ${input.buildingId}
          AND metadata->>'contentHash' = ${input.contentHash}
      `);
      const sections = new Set<number>();
      for (const row of rows) {
        const section = Number(row.section);
        if (Number.isInteger(section) && section >= 0) sections.add(section);
      }
      return sections;
    } catch {
      // A brand-new DB may not have the plugin-sql table until a runtime starts;
      // a transient read failure is also non-fatal. The deterministic unique ids
      // below remain the final duplicate-write guard.
      return new Set<number>();
    }
  },

  async getRuntime(platformAgentId, userId) {
    return (
      agentOrchestrator.getRunningAgentRuntime(platformAgentId) ??
      (await agentOrchestrator.ensureAgentRuntime(platformAgentId, userId))
    );
  },

  embed: embedText,

  async mergeConnectedMarkers(input) {
    return db.transaction(async (tx) => {
      // An agent-session claim targets that exact ownership-proven bot. A Lucia
      // human has no singular agent id in context, so follow the reconnect/auth
      // convention and choose the most recently seen bot deterministically.
      const bots = input.provenAgentId
        ? await tx.execute<{ id: string; knowledge: string[] | null }>(sql`
            SELECT id, knowledge
            FROM openclaw_bots
            WHERE user_id = ${input.userId}
              AND agent_id = ${input.provenAgentId}
            FOR UPDATE
          `)
        : await tx.execute<{ id: string; knowledge: string[] | null }>(sql`
            SELECT id, knowledge
            FROM openclaw_bots
            WHERE user_id = ${input.userId}
            ORDER BY last_seen_at DESC, id DESC
            LIMIT 1
            FOR UPDATE
          `);
      if (bots.length === 0) return false;

      for (const bot of bots) {
        const bounded = mergeBuildingSkillMarker(
          Array.isArray(bot.knowledge) ? bot.knowledge : [],
          input.buildingId,
          input.contentHash,
        );
        await tx
          .update(agentBots)
          .set({ knowledge: bounded, updatedAt: new Date() })
          .where(eq(agentBots.id, bot.id));
      }
      return true;
    });
  },

  withLocalInstallLock(key, operation) {
    return withKeyedMutex(`building-skill-install:${key}`, operation);
  },

  async withCrossPodInstallLock(key, operation) {
    // Transaction-scoped (never session-scoped) so Supavisor transaction mode
    // cannot strand a lock on a pooled connection. This intentionally holds one
    // connection while first-install embeddings run: claims are rare, and the
    // cross-pod lock is what prevents duplicate embedding spend.
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`building-skill-install:${key}`}, 0))`,
      );
      const store: BuildingSkillLockedStore = {
        async loadSkill(buildingId) {
          const rows = await tx.execute<{ content: string }>(sql`
            SELECT content
            FROM building_skills
            WHERE building_id = ${buildingId}
          `);
          const content = rows[0]?.content;
          return content
            ? { content, contentHash: canonicalContentHash(content) }
            : null;
        },
        async installedSections(input) {
          // A brand-new deployment may not have plugin-sql's `memories` table
          // until ensureRuntime initializes it. Probe without raising
          // undefined_table (catching that error would leave this tx aborted).
          const catalog = await tx.execute<{ memory_table: string | null }>(sql`
            SELECT to_regclass('memories')::text AS memory_table
          `);
          if (!catalog[0]?.memory_table) return new Set<number>();

          const rows = await tx.execute<{ section: string | null }>(sql`
            SELECT metadata->>'section' AS section
            FROM memories
            WHERE type = 'knowledge'
              AND agent_id = ${input.platformAgentId}
              AND room_id = ${input.platformAgentId}
              AND entity_id = ${input.platformAgentId}
              AND metadata->>'subtype' = 'building-skill'
              AND metadata->>'buildingId' = ${input.buildingId}
              AND metadata->>'contentHash' = ${input.contentHash}
          `);
          const sections = new Set<number>();
          for (const row of rows) {
            const section = Number(row.section);
            if (Number.isInteger(section) && section >= 0)
              sections.add(section);
          }
          return sections;
        },
        async retireStaleSections(input) {
          const rows = await tx.execute<{ content: string }>(sql`
            SELECT content
            FROM building_skills
            WHERE building_id = ${input.buildingId}
            FOR UPDATE
          `);
          const current = rows[0]?.content;
          if (!current || canonicalContentHash(current) !== input.contentHash) {
            return false;
          }
          await tx.execute(sql`
            DELETE FROM memories
            WHERE type = 'knowledge'
              AND agent_id = ${input.platformAgentId}
              AND room_id = ${input.platformAgentId}
              AND entity_id = ${input.platformAgentId}
              AND metadata->>'subtype' = 'building-skill'
              AND metadata->>'buildingId' = ${input.buildingId}
              AND metadata->>'contentHash' <> ${input.contentHash}
          `);
          return true;
        },
      };
      return operation(store);
    });
  },

  withGlobalInstallSlot(operation) {
    // Phase 2 holds one application DB transaction while external embedding and
    // Eliza writes complete. Cap that occupancy at one connection per process so
    // a burst across many subjects cannot exhaust the postgres.js pool.
    return withKeyedMutex("building-skill-install:global-phase2", operation);
  },
};

/**
 * Install a canonical building curriculum into the subject's agent.
 *
 * Hosted agents receive embedded chunks in their main ElizaOS knowledge room.
 * Connected-only agents receive one bounded, versioned bot marker per building
 * and can fetch the canonical markdown through their live session. No avatar or
 * platform-agent customization JSONB is changed by this service.
 */
export async function installBuildingSkillIntoAgent(
  input: {
    userId: string;
    avatarId: string;
    buildingId: string;
    /** Exact live agent proven by the caller, when the subject is an agent. */
    provenAgentId?: string;
  },
  dependencies: BuildingSkillInstallDependencies = defaultDependencies,
): Promise<BuildingSkillInstallResult> {
  if (input.buildingId === "clawville-play") {
    throw new BuildingSkillInstallError(
      "entry_skill_auto_installed",
      "clawville-play installs automatically; claim a building skill instead",
    );
  }

  const skill = await dependencies.loadSkill(input.buildingId);
  if (!skill) {
    throw new BuildingSkillInstallError(
      "skill_not_found",
      `No skill registered for ${input.buildingId}`,
    );
  }

  const platformAgentId = await dependencies.resolvePlatformAgentId(input);
  if (!platformAgentId) {
    const marked = await dependencies.mergeConnectedMarkers({
      userId: input.userId,
      buildingId: input.buildingId,
      contentHash: skill.contentHash,
      provenAgentId: input.provenAgentId,
    });
    if (!marked) {
      throw new BuildingSkillInstallError(
        "agent_not_connected",
        "Connect or host an agent before claiming a building skill",
      );
    }
    return {
      buildingId: input.buildingId,
      contentHash: skill.contentHash,
      installed: "marker",
    };
  }

  // Serialize every building for one hosted subject. This bounds same-subject
  // concurrency locally and uses the same key for the cross-pod advisory lock.
  const installKey = platformAgentId;
  return dependencies.withLocalInstallLock(installKey, async () => {
    // Phase 1 is deliberately short and DB-only. A cold same-version re-claim
    // returns here without starting Eliza (runtime startup injects/embeds the
    // protocol manual), preserving the pre-embed idempotence guarantee.
    const already = await dependencies.withCrossPodInstallLock(
      installKey,
      async (store) => {
        const lockedSkill = await store.loadSkill(input.buildingId);
        if (!lockedSkill) {
          throw new BuildingSkillInstallError(
            "skill_not_found",
            `No skill registered for ${input.buildingId}`,
          );
        }
        const chunks = splitProtocolManualSections(lockedSkill.content);
        if (chunks.length === 0) {
          throw new BuildingSkillInstallError(
            "runtime_unavailable",
            "Building skill content has no installable sections",
          );
        }
        const installed = await store.installedSections({
          platformAgentId,
          buildingId: input.buildingId,
          contentHash: lockedSkill.contentHash,
        });
        if (!chunks.every((_, section) => installed.has(section))) return null;

        await retireStaleSectionsOrThrow(store, {
          platformAgentId,
          buildingId: input.buildingId,
          contentHash: lockedSkill.contentHash,
        });
        return {
          buildingId: input.buildingId,
          contentHash: lockedSkill.contentHash,
          installed: "already" as const,
        };
      },
    );
    if (already) return already;

    // Runtime startup can use the application DB, so resolve it before holding
    // the phase-2 advisory transaction connection. Eliza memory writes use the
    // runtime's own adapter; all Drizzle reads/deletes flow through one `store`.
    const runtime = await dependencies.getRuntime(
      platformAgentId,
      input.userId,
    );
    return dependencies.withGlobalInstallSlot(() =>
      dependencies.withCrossPodInstallLock(installKey, async (store) => {
        // Re-read only after both locks. A request that waited behind a content
        // refresh must install the latest canonical bytes, not its pre-lock snapshot.
        const lockedSkill = await store.loadSkill(input.buildingId);
        if (!lockedSkill) {
          throw new BuildingSkillInstallError(
            "skill_not_found",
            `No skill registered for ${input.buildingId}`,
          );
        }

        const chunks = splitProtocolManualSections(lockedSkill.content);
        if (chunks.length === 0) {
          throw new BuildingSkillInstallError(
            "runtime_unavailable",
            "Building skill content has no installable sections",
          );
        }
        const installed = await store.installedSections({
          platformAgentId,
          buildingId: input.buildingId,
          contentHash: lockedSkill.contentHash,
        });
        // Cross-pod requests may both observe phase-1 incomplete while the first
        // is starting its runtime. Re-check after reacquiring: only one request
        // embeds; later contenders return already.
        if (chunks.every((_, section) => installed.has(section))) {
          await retireStaleSectionsOrThrow(store, {
            platformAgentId,
            buildingId: input.buildingId,
            contentHash: lockedSkill.contentHash,
          });
          return {
            buildingId: input.buildingId,
            contentHash: lockedSkill.contentHash,
            installed: "already",
          };
        }

        const confirmedSections = new Set(
          [...installed].filter(
            (section) => section >= 0 && section < chunks.length,
          ),
        );
        try {
          const writer = runtime?.getElizaRuntime() as
            | BuildingSkillMemoryWriter
            | null
            | undefined;
          if (writer?.createMemory) {
            for (let section = 0; section < chunks.length; section += 1) {
              if (installed.has(section)) continue;
              const text = chunks[section];
              try {
                const embedding = await dependencies.embed(text);
                await writer.createMemory(
                  {
                    id: buildingSkillMemoryId({
                      platformAgentId,
                      buildingId: input.buildingId,
                      contentHash: lockedSkill.contentHash,
                      section,
                    }),
                    agentId: platformAgentId,
                    entityId: platformAgentId,
                    roomId: platformAgentId,
                    content: { text, source: "building-skill" },
                    embedding,
                    createdAt: Date.now(),
                    metadata: {
                      type: "custom",
                      subtype: "building-skill",
                      buildingId: input.buildingId,
                      contentHash: lockedSkill.contentHash,
                      section,
                    },
                  },
                  "knowledge",
                  true,
                );
                confirmedSections.add(section);
              } catch (error) {
                console.warn(
                  `[building-skill-install] Section ${section} persist failed (non-fatal): ${(error as Error).message}`,
                );
              }
            }
          }
        } catch (error) {
          console.warn(
            `[building-skill-install] Runtime unavailable (non-fatal): ${(error as Error).message}`,
          );
        }

        if (confirmedSections.size === 0) {
          throw new BuildingSkillInstallError(
            "runtime_unavailable",
            "Hosted agent runtime could not persist any building skill sections",
          );
        }

        if (confirmedSections.size === chunks.length) {
          await retireStaleSectionsOrThrow(store, {
            platformAgentId,
            buildingId: input.buildingId,
            contentHash: lockedSkill.contentHash,
          });
        }

        return {
          buildingId: input.buildingId,
          contentHash: lockedSkill.contentHash,
          installed: "runtime",
        };
      }),
    );
  });
}
