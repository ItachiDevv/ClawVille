import { describe, expect, it } from 'bun:test';
import { agents, avatars, type Database } from '@clawville/database';
import {
  mergeHostedAgentKnowledgeAtomically,
  readHostedAgentKnowledge,
  syncHostedAgentKnowledge,
  type HostedAgentKnowledgeDependencies,
  type HostedAgentKnowledgeReadDependencies,
} from '../hosted-agent-knowledge';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const AVATAR_ID = '00000000-0000-4000-8000-000000000002';
const AGENT_ID = '00000000-0000-4000-8000-000000000003';

function sqlParams(query: unknown): unknown[] {
  const params: unknown[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value.constructor?.name === 'Param' && 'value' in value) {
      params.push((value as { value: unknown }).value);
      return;
    }
    if ('queryChunks' in value && Array.isArray((value as { queryChunks: unknown[] }).queryChunks)) {
      for (const chunk of (value as { queryChunks: unknown[] }).queryChunks) {
        if (typeof chunk === 'string' || typeof chunk === 'number') params.push(chunk);
        else visit(chunk);
      }
    }
  };
  visit(query);
  return params;
}

function sqlText(query: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if ('value' in value && Array.isArray((value as { value: unknown[] }).value)) {
      parts.push(...(value as { value: unknown[] }).value.filter(
        (entry): entry is string => typeof entry === 'string',
      ));
    }
    if ('queryChunks' in value && Array.isArray((value as { queryChunks: unknown[] }).queryChunks)) {
      for (const chunk of (value as { queryChunks: unknown[] }).queryChunks) visit(chunk);
    }
  };
  visit(query);
  return parts.join('');
}

function makeDatabaseHarness(options: { active?: boolean; platformAgentId?: string | null } = {}) {
  const state = {
    active: options.active ?? true,
    platformAgentId: options.platformAgentId === undefined ? AGENT_ID : options.platformAgentId,
    avatarConfig: { bio: ['avatar bio'], knowledge: ['avatar-only'] } as Record<string, unknown>,
    agentCustomization: {
      gateway: { url: 'wss://gateway.example' },
      persona: { tone: 'curious' },
      knowledge: ['agent-only'],
    } as Record<string, unknown>,
    sql: [] as string[],
  };

  const database = {
    async transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        async execute(query: unknown) {
          const text = sqlText(query);
          const params = sqlParams(query);
          state.sql.push(text);
          if (text.includes('FROM avatars')) {
            if (!state.active || !params.includes(USER_ID) || !params.includes(AVATAR_ID)) return [];
            return [{
              id: AVATAR_ID,
              platform_agent_id: state.platformAgentId,
              character_config: structuredClone(state.avatarConfig),
            }];
          }
          if (text.includes('FROM platform_agents')) {
            if (!params.includes(USER_ID) || !params.includes(AGENT_ID)) return [];
            return [{ customization: structuredClone(state.agentCustomization) }];
          }
          return [];
        },
        update(table: unknown) {
          return {
            set(values: Record<string, unknown>) {
              return {
                async where() {
                  if (table === avatars) {
                    state.avatarConfig = structuredClone(
                      values.characterConfig as Record<string, unknown>,
                    );
                  } else if (table === agents) {
                    state.agentCustomization = structuredClone(
                      values.customization as Record<string, unknown>,
                    );
                  }
                },
              };
            },
          };
        },
      };
      return callback(tx);
    },
  } as unknown as Pick<Database, 'transaction'>;

  return { database, state };
}

describe('hosted agent knowledge synchronization', () => {
  it('merges each knowledge surface independently and preserves customization siblings', async () => {
    const { database, state } = makeDatabaseHarness();
    const result = await mergeHostedAgentKnowledgeAtomically(database, {
      userId: USER_ID,
      avatarId: AVATAR_ID,
      entries: ['new lesson'],
    });

    expect(result?.newKnowledge).toEqual(['new lesson']);
    expect(state.avatarConfig).toEqual({
      bio: ['avatar bio'],
      knowledge: ['avatar-only', 'new lesson'],
    });
    expect(state.agentCustomization).toEqual({
      gateway: { url: 'wss://gateway.example' },
      persona: { tone: 'curious' },
      knowledge: ['agent-only', 'new lesson'],
    });
    expect(state.sql.join('\n')).toContain('is_active = true');
    expect(state.sql.join('\n').match(/user_id =/g)?.length).toBe(2);
  });

  it('rejects a mismatched owner or an avatar without a platform agent', async () => {
    const ownerHarness = makeDatabaseHarness();
    expect(await mergeHostedAgentKnowledgeAtomically(ownerHarness.database, {
      userId: '00000000-0000-4000-8000-000000000099',
      avatarId: AVATAR_ID,
      entries: ['poison'],
    })).toBeNull();
    expect(ownerHarness.state.avatarConfig.knowledge).toEqual(['avatar-only']);

    const noAgentHarness = makeDatabaseHarness({ platformAgentId: null });
    expect(await mergeHostedAgentKnowledgeAtomically(noAgentHarness.database, {
      userId: USER_ID,
      avatarId: AVATAR_ID,
      entries: ['lesson'],
    })).toBeNull();
    expect(noAgentHarness.state.avatarConfig.knowledge).toEqual(['avatar-only']);
  });

  it('creates a knowledge memory with the requested source metadata', async () => {
    const memoryCalls: unknown[][] = [];
    let stopped = false;
    const dependencies: HostedAgentKnowledgeDependencies = {
      mergeDatabase: async () => { throw new Error('unexpected merge'); },
      ensureRuntime: async () => ({
        getElizaRuntime: () => ({
          createMemory: async (...args: unknown[]) => { memoryCalls.push(args); },
        }),
      }),
      embed: async () => [0.25, 0.75],
      stopRuntime: async () => { stopped = true; },
    };

    await syncHostedAgentKnowledge({
      userId: USER_ID,
      avatarId: AVATAR_ID,
      entries: ['learned at Gary'],
      source: 'building-visit',
      metadata: { buildingId: 'cron-automation' },
      databaseAlreadyMerged: {
        platformAgentId: AGENT_ID,
        mergedKnowledge: ['learned at Gary'],
      },
    }, dependencies);

    expect(memoryCalls).toHaveLength(1);
    expect(memoryCalls[0]?.[0]).toMatchObject({
      content: { text: 'learned at Gary', source: 'building-visit' },
      metadata: {
        subtype: 'knowledge',
        source: 'building-visit',
        buildingId: 'cron-automation',
      },
    });
    expect(memoryCalls[0]?.slice(1)).toEqual(['knowledge', true]);
    expect(stopped).toBe(true);
  });

  it('keeps a committed merge successful when memory creation fails', async () => {
    let stopped = false;
    const dependencies: HostedAgentKnowledgeDependencies = {
      mergeDatabase: async () => ({
        userId: USER_ID,
        avatarId: AVATAR_ID,
        platformAgentId: AGENT_ID,
        newKnowledge: ['durable lesson'],
        mergedKnowledge: ['durable lesson'],
      }),
      ensureRuntime: async () => ({
        getElizaRuntime: () => ({
          createMemory: async () => { throw new Error('embedding store offline'); },
        }),
      }),
      embed: async () => [1],
      stopRuntime: async () => { stopped = true; },
    };

    const result = await syncHostedAgentKnowledge({
      userId: USER_ID,
      avatarId: AVATAR_ID,
      entries: ['durable lesson'],
      source: 'building-visit',
    }, dependencies);

    expect(result?.mergedKnowledge).toEqual(['durable lesson']);
    expect(stopped).toBe(true);
  });

  it('does not start or stop the runtime when the merge found nothing new', async () => {
    let ensured = false;
    let stopped = false;
    const dependencies: HostedAgentKnowledgeDependencies = {
      mergeDatabase: async () => ({
        userId: USER_ID,
        avatarId: AVATAR_ID,
        platformAgentId: AGENT_ID,
        newKnowledge: [],
        mergedKnowledge: ['already known'],
      }),
      ensureRuntime: async () => {
        ensured = true;
        return null;
      },
      embed: async () => [1],
      stopRuntime: async () => { stopped = true; },
    };

    const result = await syncHostedAgentKnowledge({
      userId: USER_ID,
      avatarId: AVATAR_ID,
      entries: ['already known'],
      source: 'building-visit',
    }, dependencies);

    expect(result?.newKnowledge).toEqual([]);
    expect(ensured).toBe(false);
    expect(stopped).toBe(false);
  });
});

describe('hosted agent knowledge read', () => {
  function readDependencies(input: {
    runtime: ReturnType<HostedAgentKnowledgeReadDependencies['getRunningRuntime']>;
    customization?: Record<string, unknown> | null;
    databaseError?: boolean;
    onDatabaseRead?: () => void;
  }): HostedAgentKnowledgeReadDependencies {
    return {
      getRunningRuntime: () => input.runtime,
      readCustomization: async () => {
        input.onDatabaseRead?.();
        if (input.databaseError) throw new Error('database offline');
        return input.customization ?? null;
      },
    };
  }

  it('returns a warm-runtime semantic hit without reading the database', async () => {
    let databaseReads = 0;
    const knowledge = await readHostedAgentKnowledge({
      platformAgentId: AGENT_ID,
      query: 'what should I learn?',
      limit: 3,
    }, readDependencies({
      runtime: {
        searchBookKnowledgeMemories: async () => ['semantic result'],
      },
      onDatabaseRead: () => { databaseReads++; },
    }));

    expect(knowledge).toEqual(['semantic result']);
    expect(databaseReads).toBe(0);
  });

  it('falls through from a warm empty runtime to the newest database tail', async () => {
    const knowledge = await readHostedAgentKnowledge({
      platformAgentId: AGENT_ID,
      query: 'recent knowledge',
      limit: 2,
    }, readDependencies({
      runtime: { searchBookKnowledgeMemories: async () => [] },
      customization: { knowledge: ['oldest', 7, '', 'newer', 'newest'] },
    }));

    expect(knowledge).toEqual(['newest', 'newer']);
  });

  it('uses the authoritative database fallback when the runtime is cold', async () => {
    const knowledge = await readHostedAgentKnowledge({
      platformAgentId: AGENT_ID,
      query: 'recent knowledge',
      limit: 3,
    }, readDependencies({
      runtime: null,
      customization: { knowledge: ['first', 'second'] },
    }));

    expect(knowledge).toEqual(['second', 'first']);
  });

  it('returns an empty array when the database fallback fails', async () => {
    expect(await readHostedAgentKnowledge({
      platformAgentId: AGENT_ID,
      query: 'recent knowledge',
    }, readDependencies({
      runtime: null,
      databaseError: true,
    }))).toEqual([]);
  });
});
