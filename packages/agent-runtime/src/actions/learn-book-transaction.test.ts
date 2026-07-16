import { describe, expect, it } from 'bun:test';
import { agents, avatarInventory, avatars } from '@clawville/database';
import { KNOWLEDGE_BOOKS } from '@clawville/shared';
import {
  learnBookAtomically,
  type LearnBookDatabase,
} from './learn-book-transaction';
import { learnSkillAction } from './learn-skill';

const AVATAR_ID = '00000000-0000-4000-8000-000000000001';
const AGENT_ID = '00000000-0000-4000-8000-000000000002';

interface HarnessState {
  characterConfig: Record<string, unknown>;
  inventory: Map<string, number>;
  platformCustomization: Record<string, unknown> | null;
}

interface Harness {
  db: LearnBookDatabase;
  state: HarnessState;
  setAgentUpdateFailure(value: boolean): void;
  transactionCalls(): number;
  executedSql(): string[];
}

function sqlText(query: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if ('value' in value && Array.isArray((value as { value: unknown[] }).value)) {
      const strings = (value as { value: unknown[] }).value.filter(
        (entry): entry is string => typeof entry === 'string',
      );
      parts.push(...strings);
    }
    if ('queryChunks' in value && Array.isArray((value as { queryChunks: unknown[] }).queryChunks)) {
      for (const chunk of (value as { queryChunks: unknown[] }).queryChunks) visit(chunk);
    }
  };

  visit(query);
  return parts.join('');
}

function sqlParams(query: unknown): unknown[] {
  const params: unknown[] = [];
  const seen = new Set<object>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (value.constructor?.name === 'Param' && 'value' in value) {
      params.push((value as { value: unknown }).value);
      return;
    }

    if ('queryChunks' in value && Array.isArray((value as { queryChunks: unknown[] }).queryChunks)) {
      for (const chunk of (value as { queryChunks: unknown[] }).queryChunks) {
        if (typeof chunk === 'string' || typeof chunk === 'number') {
          params.push(chunk);
        } else {
          visit(chunk);
        }
      }
    }
  };

  visit(query);
  return params;
}

function avatarRow(characterConfig: Record<string, unknown>) {
  return {
    id: AVATAR_ID,
    userId: '00000000-0000-4000-8000-000000000003',
    name: 'Atomic Learner',
    species: 'cat' as const,
    color: 'blue' as const,
    gender: 'female' as const,
    archetype: 'curious-scholar',
    learningFocus: null,
    personality: { habitat: 'reef', hobby: 'reading', greeting: 'hi' },
    stats: { strength: 1, defence: 1, movement: 1 },
    characterConfig: characterConfig as any,
    platformAgentId: AGENT_ID,
    clawTokens: 0,
    softBalance: 0,
    boughtBalance: 0,
    earnedBalance: 0,
    isGuest: false,
    isActive: true,
    avatarType: 'glb' as const,
    avatarUrl: null,
    vrmMetadata: null,
    lastHeartbeat: null,
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
    updatedAt: new Date('2026-07-15T00:00:00.000Z'),
  };
}

function makeHarness(
  inventory: Record<string, number>,
  initialKnowledge: string[] = ['existing-knowledge'],
  initialPlatformCustomization: Record<string, unknown> | null = {
    bio: ['test'],
    knowledge: [...initialKnowledge],
  },
): Harness {
  const state: HarnessState = {
    characterConfig: { bio: ['test'], knowledge: [...initialKnowledge] },
    inventory: new Map(Object.entries(inventory)),
    platformCustomization: structuredClone(initialPlatformCustomization),
  };
  let failAgentUpdate = false;
  let transactions = 0;
  let tail = Promise.resolve();
  const executedSql: string[] = [];

  const db = {
    async transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      transactions += 1;
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;

      const snapshot = {
        characterConfig: structuredClone(state.characterConfig),
        inventory: new Map(state.inventory),
        platformCustomization: structuredClone(state.platformCustomization),
      };
      const tx = {
        async execute(query: unknown) {
          const text = sqlText(query);
          executedSql.push(text);
          if (text.includes('FROM avatars')) {
            return [{
              id: AVATAR_ID,
              platform_agent_id: AGENT_ID,
              character_config: structuredClone(state.characterConfig),
            }];
          }

          if (text.includes('FROM platform_agents')) {
            return state.platformCustomization === null
              ? [{ customization: null }]
              : [{ customization: structuredClone(state.platformCustomization) }];
          }

          const params = sqlParams(query);
          const bookId = String(params.at(-1));
          const quantity = state.inventory.get(bookId) ?? 0;
          if (quantity <= 0) return [];
          const remaining = quantity - 1;
          state.inventory.set(bookId, remaining);
          return [{ id: `inventory:${bookId}`, quantity: remaining }];
        },
        update(table: unknown) {
          return {
            set(values: Record<string, unknown>) {
              return {
                where() {
                  if (table === avatars) {
                    return {
                      async returning() {
                        state.characterConfig = structuredClone(
                          values.characterConfig as Record<string, unknown>,
                        );
                        return [avatarRow(state.characterConfig)];
                      },
                    };
                  }

                  if (table === agents) {
                    if (failAgentUpdate) throw new Error('injected agent update refusal');
                    state.platformCustomization = structuredClone(
                      values.customization as Record<string, unknown>,
                    );
                  }
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
        delete(table: unknown) {
          return {
            where() {
              if (table === avatarInventory) {
                for (const [bookId, quantity] of state.inventory) {
                  if (quantity === 0) state.inventory.delete(bookId);
                }
              }
              return Promise.resolve([]);
            },
          };
        },
      };

      try {
        return await callback(tx);
      } catch (error) {
        state.characterConfig = snapshot.characterConfig;
        state.inventory = snapshot.inventory;
        state.platformCustomization = snapshot.platformCustomization;
        throw error;
      } finally {
        release();
      }
    },
  } as LearnBookDatabase;

  return {
    db,
    state,
    setAgentUpdateFailure(value) {
      failAgentUpdate = value;
    },
    transactionCalls() {
      return transactions;
    },
    executedSql() {
      return [...executedSql];
    },
  };
}

describe('learnBookAtomically', () => {
  const firstBook = KNOWLEDGE_BOOKS[0]!;
  const secondBook = KNOWLEDGE_BOOKS[1]!;

  it('validates the canonical book before opening a transaction or consuming inventory', async () => {
    const harness = makeHarness({ 'not-a-real-book': 1 });

    await expect(
      learnBookAtomically(harness.db, {
        avatarId: AVATAR_ID,
        bookId: 'not-a-real-book',
      }),
    ).rejects.toMatchObject({ code: 'book_not_found' });
    expect(harness.transactionCalls()).toBe(0);
    expect(harness.state.inventory.get('not-a-real-book')).toBe(1);
  });

  it('records agent.action.learn with stable ids inside the existing transaction', async () => {
    const harness = makeHarness({ [firstBook.id]: 1 });
    let recorded: { input: unknown; tx: unknown } | null = null;

    await learnBookAtomically(
      harness.db,
      { avatarId: AVATAR_ID, bookId: firstBook.id },
      async (input, tx) => {
        recorded = { input, tx };
        return { id: 'learn-record', deduped: false };
      },
    );

    expect(recorded).not.toBeNull();
    expect(recorded!.tx).toBeDefined();
    expect(recorded!.input).toEqual({
      action: 'agent.action.learn',
      subjectType: 'avatar',
      subjectId: AVATAR_ID,
      payload: { bookId: firstBook.id },
    });
  });

  it('serializes two concurrent reads of quantity 2 and consumes both copies', async () => {
    const harness = makeHarness({ [firstBook.id]: 2 });

    const results = await Promise.all([
      learnBookAtomically(harness.db, { avatarId: AVATAR_ID, bookId: firstBook.id }),
      learnBookAtomically(harness.db, { avatarId: AVATAR_ID, bookId: firstBook.id }),
    ]);

    expect(harness.state.inventory.has(firstBook.id)).toBe(false);
    expect(results.map((result) => result.newKnowledge.length).sort((a, b) => a - b))
      .toEqual([0, firstBook.knowledgeEntries.length]);
    expect(harness.state.characterConfig.knowledge).toEqual([
      'existing-knowledge',
      ...firstBook.knowledgeEntries,
    ]);
    expect(harness.executedSql().filter((query) => query.includes('FROM avatars')))
      .toHaveLength(2);
    expect(harness.executedSql().every((query) => query.includes('FOR UPDATE'))).toBe(true);
    expect(harness.executedSql().some((query) => query.includes('quantity > 0'))).toBe(true);
  });

  it('merges different books from concurrent callers without overwriting either result', async () => {
    const harness = makeHarness({ [firstBook.id]: 1, [secondBook.id]: 1 });

    await Promise.all([
      learnBookAtomically(harness.db, { avatarId: AVATAR_ID, bookId: firstBook.id }),
      learnBookAtomically(harness.db, { avatarId: AVATAR_ID, bookId: secondBook.id }),
    ]);

    expect(harness.state.inventory.size).toBe(0);
    expect(new Set(harness.state.characterConfig.knowledge as string[])).toEqual(
      new Set([
        'existing-knowledge',
        ...firstBook.knowledgeEntries,
        ...secondBook.knowledgeEntries,
      ]),
    );
  });

  it('merges learned knowledge without clobbering agent gateway or persona customization', async () => {
    const existingCustomization = {
      gateway: {
        url: 'https://agent.example/v1',
        protocol: 'openai-compat',
        authToken: 'encrypted-at-rest',
      },
      persona: {
        voice: 'measured',
        systemPrompt: 'Preserve this agent-specific prompt.',
      },
      knowledge: ['agent-side-stale-entry'],
    };
    const harness = makeHarness(
      { [firstBook.id]: 1 },
      ['existing-avatar-knowledge'],
      existingCustomization,
    );

    const result = await learnBookAtomically(harness.db, {
      avatarId: AVATAR_ID,
      bookId: firstBook.id,
    });

    expect(harness.state.platformCustomization).toEqual({
      gateway: existingCustomization.gateway,
      persona: existingCustomization.persona,
      knowledge: [
        'agent-side-stale-entry',
        ...result.mergedKnowledge,
      ],
    });
    expect(harness.state.platformCustomization).not.toHaveProperty('bio');
  });

  it('rolls back a captured copy on post-consume refusal so a retry can reuse it', async () => {
    const harness = makeHarness({ [firstBook.id]: 1 });
    harness.setAgentUpdateFailure(true);

    await expect(
      learnBookAtomically(harness.db, { avatarId: AVATAR_ID, bookId: firstBook.id }),
    ).rejects.toThrow('injected agent update refusal');
    expect(harness.state.inventory.get(firstBook.id)).toBe(1);
    expect(harness.state.characterConfig.knowledge).toEqual(['existing-knowledge']);

    harness.setAgentUpdateFailure(false);
    const retry = await learnBookAtomically(harness.db, {
      avatarId: AVATAR_ID,
      bookId: firstBook.id,
    });
    expect(retry.newKnowledge).toEqual(firstBook.knowledgeEntries);
    expect(harness.state.inventory.has(firstBook.id)).toBe(false);
  });

  it('allows only one runtime LEARN_SKILL winner when one copy exists', async () => {
    const harness = makeHarness({ [firstBook.id]: 1 });
    const state = {
      avatarId: AVATAR_ID,
      userId: '00000000-0000-4000-8000-000000000003',
      services: {
        db: harness.db,
        creditClawTokens: async () => ({ balanceAfter: 0 }),
        debitClawTokens: async () => ({ balanceAfter: 0 }),
      },
    };
    const message = {
      content: { text: `learn ${firstBook.id}`, parameters: { itemId: firstBook.id } },
    };

    const results = await Promise.all([
      learnSkillAction.handler(null, message, state),
      learnSkillAction.handler(null, message, state),
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success)).toHaveLength(1);
    expect(results.find((result) => !result.success)?.text).toContain("don't have");
    expect(harness.state.inventory.has(firstBook.id)).toBe(false);
  });
});
