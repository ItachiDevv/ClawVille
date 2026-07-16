import { describe, expect, it } from "bun:test";
import {
  buildingSkillMemoryId,
  installBuildingSkillIntoAgent,
  mergeBuildingSkillMarker,
  type BuildingSkillLockedStore,
  type BuildingSkillInstallDependencies,
} from "../building-skill-install";

const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const CONTENT = [
  "---",
  "name: test",
  "---",
  "",
  "# Intro",
  "intro",
  "",
  "## One",
  "one",
].join("\n");

type TestOverrides = Partial<BuildingSkillInstallDependencies> & {
  retireStaleSections?: BuildingSkillLockedStore["retireStaleSections"];
};

function dependencies(
  overrides: TestOverrides = {},
): BuildingSkillInstallDependencies {
  const loadSkill =
    overrides.loadSkill ??
    (async () => ({ content: CONTENT, contentHash: CONTENT_HASH }));
  const installedSections =
    overrides.installedSections ?? (async () => new Set<number>());
  const retireStaleSections =
    overrides.retireStaleSections ?? (async () => true);
  return {
    loadSkill,
    resolvePlatformAgentId: async () => "platform-agent-1",
    installedSections,
    getRuntime: async () => ({
      getElizaRuntime: () => ({ createMemory: async () => {} }),
    }),
    embed: async () => [0.1, 0.2],
    mergeConnectedMarkers: async () => true,
    withLocalInstallLock: async (_key, operation) => operation(),
    withCrossPodInstallLock:
      overrides.withCrossPodInstallLock ??
      (async (_key, operation) =>
        operation({ loadSkill, installedSections, retireStaleSections })),
    withGlobalInstallSlot: async (operation) => operation(),
    ...overrides,
  };
}

const INPUT = {
  userId: "user-1",
  avatarId: "avatar-1",
  buildingId: "agent-security",
  provenAgentId: "connected-agent-1",
};

describe("installBuildingSkillIntoAgent", () => {
  it("keeps exactly one current marker per building without disturbing other knowledge", () => {
    const merged = mergeBuildingSkillMarker(
      [
        "ordinary lesson",
        "skill:agent-security@deadbeef",
        "skill:memory-rag@12345678",
        "skill:agent-security@cafebabe",
      ],
      "agent-security",
      CONTENT_HASH,
    );

    expect(merged).toEqual([
      "ordinary lesson",
      "skill:memory-rag@12345678",
      "skill:agent-security@aaaaaaaa",
    ]);
  });

  it("writes heading chunks into the hosted agent main knowledge room with deterministic ids", async () => {
    const writes: Array<{
      memory: Record<string, any>;
      tableName: string;
      unique?: boolean;
    }> = [];
    const result = await installBuildingSkillIntoAgent(
      INPUT,
      dependencies({
        getRuntime: async () => ({
          getElizaRuntime: () => ({
            createMemory: async (
              memory: Record<string, unknown>,
              tableName: string,
              unique?: boolean,
            ) => {
              writes.push({ memory, tableName, unique });
            },
          }),
        }),
      }),
    );

    expect(result).toEqual({
      buildingId: INPUT.buildingId,
      contentHash: CONTENT_HASH,
      installed: "runtime",
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      tableName: "knowledge",
      unique: true,
      memory: {
        id: buildingSkillMemoryId({
          platformAgentId: "platform-agent-1",
          buildingId: INPUT.buildingId,
          contentHash: CONTENT_HASH,
          section: 0,
        }),
        agentId: "platform-agent-1",
        entityId: "platform-agent-1",
        roomId: "platform-agent-1",
        metadata: {
          type: "custom",
          subtype: "building-skill",
          buildingId: INPUT.buildingId,
          contentHash: CONTENT_HASH,
          section: 0,
        },
      },
    });
  });

  it("returns already before embedding when every section exists", async () => {
    let runtimeCalls = 0;
    let embedCalls = 0;
    let globalSlotCalls = 0;
    const result = await installBuildingSkillIntoAgent(
      INPUT,
      dependencies({
        installedSections: async () => new Set([0, 1]),
        getRuntime: async () => {
          runtimeCalls += 1;
          return null;
        },
        embed: async () => {
          embedCalls += 1;
          return [];
        },
        withGlobalInstallSlot: async (operation) => {
          globalSlotCalls += 1;
          return operation();
        },
      }),
    );

    expect(result.installed).toBe("already");
    expect(runtimeCalls).toBe(0);
    expect(embedCalls).toBe(0);
    expect(globalSlotCalls).toBe(0);
  });

  it("serializes different buildings for the same platform agent on one subject key", async () => {
    const keys: string[] = [];
    let active = 0;
    let maxActive = 0;
    let tail = Promise.resolve();
    const deps = dependencies({
      installedSections: async () => new Set([0, 1]),
      withLocalInstallLock: async (key, operation) => {
        keys.push(key);
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
          return await operation();
        } finally {
          active -= 1;
          release();
        }
      },
    });

    const results = await Promise.all([
      installBuildingSkillIntoAgent(INPUT, deps),
      installBuildingSkillIntoAgent(
        { ...INPUT, buildingId: "memory-rag" },
        deps,
      ),
    ]);

    expect(results.map((result) => result.installed)).toEqual([
      "already",
      "already",
    ]);
    expect(keys).toEqual(["platform-agent-1", "platform-agent-1"]);
    expect(maxActive).toBe(1);
  });

  it("wraps only phase 2 in the global install slot and reuses the subject advisory key", async () => {
    let globalSlotCalls = 0;
    const advisoryKeys: string[] = [];
    const deps = dependencies({
      withGlobalInstallSlot: async (operation) => {
        globalSlotCalls += 1;
        return operation();
      },
      withCrossPodInstallLock: async (key, operation) => {
        advisoryKeys.push(key);
        return operation({
          loadSkill: async () => ({
            content: CONTENT,
            contentHash: CONTENT_HASH,
          }),
          installedSections: async () => new Set<number>(),
          retireStaleSections: async () => true,
        });
      },
    });

    const result = await installBuildingSkillIntoAgent(INPUT, deps);

    expect(result.installed).toBe("runtime");
    expect(globalSlotCalls).toBe(1);
    expect(advisoryKeys).toEqual(["platform-agent-1", "platform-agent-1"]);
  });

  it("routes every locked DB operation through the one advisory transaction store", async () => {
    const lockedCalls: string[] = [];
    let unlockedLoads = 0;
    const result = await installBuildingSkillIntoAgent(
      INPUT,
      dependencies({
        loadSkill: async () => {
          unlockedLoads += 1;
          if (unlockedLoads > 1) throw new Error("unlocked canonical re-read");
          return { content: CONTENT, contentHash: CONTENT_HASH };
        },
        installedSections: async () => {
          throw new Error("unlocked precheck");
        },
        withCrossPodInstallLock: async (_key, operation) =>
          operation({
            loadSkill: async () => {
              lockedCalls.push("load");
              return { content: CONTENT, contentHash: CONTENT_HASH };
            },
            installedSections: async () => {
              lockedCalls.push("precheck");
              return new Set<number>();
            },
            retireStaleSections: async () => {
              lockedCalls.push("retire");
              return true;
            },
          }),
      }),
    );

    expect(result.installed).toBe("runtime");
    expect(lockedCalls).toEqual([
      "load",
      "precheck",
      "load",
      "precheck",
      "retire",
    ]);
    expect(unlockedLoads).toBe(1);
  });

  it("continues from a no-table phase-1 precheck into runtime initialization and phase 2", async () => {
    let lockPhase = 0;
    let runtimeCalls = 0;
    let writes = 0;
    const result = await installBuildingSkillIntoAgent(
      INPUT,
      dependencies({
        withCrossPodInstallLock: async (_key, operation) => {
          lockPhase += 1;
          return operation({
            loadSkill: async () => ({
              content: CONTENT,
              contentHash: CONTENT_HASH,
            }),
            // Phase 1 models to_regclass('memories') = NULL. Phase 2 models
            // the table initialized by ensureRuntime, still with no rows yet.
            installedSections: async () => new Set<number>(),
            retireStaleSections: async () => true,
          });
        },
        getRuntime: async () => {
          runtimeCalls += 1;
          return {
            getElizaRuntime: () => ({
              createMemory: async () => {
                writes += 1;
              },
            }),
          };
        },
      }),
    );

    expect(result.installed).toBe("runtime");
    expect(lockPhase).toBe(2);
    expect(runtimeCalls).toBe(1);
    expect(writes).toBe(2);
  });

  it("retries only missing sections after a partial prior install", async () => {
    const embedded: string[] = [];
    const result = await installBuildingSkillIntoAgent(
      INPUT,
      dependencies({
        installedSections: async () => new Set([0]),
        embed: async (text) => {
          embedded.push(text);
          return [0.3];
        },
      }),
    );

    expect(result.installed).toBe("runtime");
    expect(embedded).toEqual(["## One\none"]);
  });

  it("uses the bounded connected-agent marker fallback when no hosted platform agent exists", async () => {
    const markers: Array<Record<string, string>> = [];
    const result = await installBuildingSkillIntoAgent(
      INPUT,
      dependencies({
        resolvePlatformAgentId: async () => null,
        mergeConnectedMarkers: async (input) => {
          markers.push(input);
          return true;
        },
      }),
    );

    expect(result.installed).toBe("marker");
    expect(markers).toEqual([
      {
        userId: INPUT.userId,
        buildingId: INPUT.buildingId,
        contentHash: CONTENT_HASH,
        provenAgentId: INPUT.provenAgentId,
      },
    ]);
  });

  it("fails explicitly when a player has neither a hosted nor connected agent", async () => {
    await expect(
      installBuildingSkillIntoAgent(
        INPUT,
        dependencies({
          resolvePlatformAgentId: async () => null,
          mergeConnectedMarkers: async () => false,
        }),
      ),
    ).rejects.toMatchObject({ code: "agent_not_connected" });
  });

  it("skips only the section whose embedding fails and remains fail-soft overall", async () => {
    let writes = 0;
    const result = await installBuildingSkillIntoAgent(
      INPUT,
      dependencies({
        embed: async (text) => {
          if (text.startsWith("---")) throw new Error("embedding unavailable");
          return [0.5];
        },
        getRuntime: async () => ({
          getElizaRuntime: () => ({
            createMemory: async () => {
              writes += 1;
            },
          }),
        }),
      }),
    );

    expect(result.installed).toBe("runtime");
    expect(writes).toBe(1);
  });

  it("returns runtime_unavailable when no section can be persisted", async () => {
    await expect(
      installBuildingSkillIntoAgent(
        INPUT,
        dependencies({
          getRuntime: async () => ({ getElizaRuntime: () => null }),
        }),
      ),
    ).rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it("keeps partial section success when a later section fails", async () => {
    let embeddings = 0;
    let writes = 0;
    const result = await installBuildingSkillIntoAgent(
      INPUT,
      dependencies({
        embed: async () => {
          embeddings += 1;
          if (embeddings === 2) throw new Error("second embedding unavailable");
          return [0.7];
        },
        getRuntime: async () => ({
          getElizaRuntime: () => ({
            createMemory: async () => {
              writes += 1;
            },
          }),
        }),
      }),
    );

    expect(result.installed).toBe("runtime");
    expect(writes).toBe(1);
  });

  it("serializes concurrent first claims so only one request embeds", async () => {
    const stored = new Set<number>();
    let embedCalls = 0;
    let tail = Promise.resolve();
    const deps = dependencies({
      installedSections: async () => new Set(stored),
      withLocalInstallLock: async (_key, operation) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await operation();
        } finally {
          release();
        }
      },
      embed: async () => {
        embedCalls += 1;
        return [0.8];
      },
      getRuntime: async () => ({
        getElizaRuntime: () => ({
          createMemory: async (memory: Record<string, any>) => {
            stored.add(memory.metadata.section);
          },
        }),
      }),
    });

    const results = await Promise.all([
      installBuildingSkillIntoAgent(INPUT, deps),
      installBuildingSkillIntoAgent(INPUT, deps),
    ]);

    expect(results.map((result) => result.installed).sort()).toEqual([
      "already",
      "runtime",
    ]);
    expect(embedCalls).toBe(2);
  });

  it("retires H1 only after a complete H2 install, never after partial H2", async () => {
    const h1 = `sha256:${"1".repeat(64)}`;
    const h2 = `sha256:${"2".repeat(64)}`;
    let currentHash = h1;
    let failH2SectionOne = true;
    const stored = new Map<string, Set<number>>();
    const retireCalls: string[] = [];
    const deps = dependencies({
      loadSkill: async () => ({ content: CONTENT, contentHash: currentHash }),
      installedSections: async ({ contentHash }) =>
        new Set(stored.get(contentHash) ?? []),
      getRuntime: async () => ({
        getElizaRuntime: () => ({
          createMemory: async (memory: Record<string, any>) => {
            const hash = memory.metadata.contentHash as string;
            const section = memory.metadata.section as number;
            if (hash === h2 && section === 1 && failH2SectionOne) {
              throw new Error("partial H2");
            }
            const sections = stored.get(hash) ?? new Set<number>();
            sections.add(section);
            stored.set(hash, sections);
          },
        }),
      }),
      retireStaleSections: async ({ contentHash }) => {
        retireCalls.push(contentHash);
        return true;
      },
    });

    await installBuildingSkillIntoAgent(INPUT, deps);
    expect(retireCalls).toEqual([h1]);

    currentHash = h2;
    await installBuildingSkillIntoAgent(INPUT, deps);
    expect(retireCalls).toEqual([h1]);

    failH2SectionOne = false;
    await installBuildingSkillIntoAgent(INPUT, deps);
    expect(retireCalls).toEqual([h1, h2]);
  });

  it("does not report success when stale-section retirement cannot be verified", async () => {
    await expect(
      installBuildingSkillIntoAgent(
        INPUT,
        dependencies({ retireStaleSections: async () => false }),
      ),
    ).rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it("rejects the auto-installed entry skill before loading the DB row", async () => {
    let loads = 0;
    await expect(
      installBuildingSkillIntoAgent(
        { ...INPUT, buildingId: "clawville-play" },
        dependencies({
          loadSkill: async () => {
            loads += 1;
            return null;
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "entry_skill_auto_installed",
    });
    expect(loads).toBe(0);
  });
});
