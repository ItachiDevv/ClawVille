import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test';
import {
  protocolKnowledgeEntityId,
  protocolKnowledgeRoomId,
} from '../protocol-knowledge';
import { knowledgeProvider } from './knowledge';

const PLATFORM_AGENT_ID = '30000000-0000-0000-0000-000000000003';
const AVATAR_ID = '40000000-0000-0000-0000-000000000004';
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'provider-test-key';
  globalThis.fetch = mock(async () =>
    new Response(
      JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  ) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalApiKey;
  }
});

const state = {
  avatarId: AVATAR_ID,
  platformAgentId: PLATFORM_AGENT_ID,
  userMessage: 'How do I claim a building skill?',
  characterConfig: { knowledge: ['Learned skill'] },
};

describe('knowledgeProvider protocol manual retrieval', () => {
  it('returns teacher-corpus memories from the main agent-scoped search', async () => {
    const teacherCorpusText =
      'Use a cron expression to schedule recurring autonomous work.';
    const searchMemories = mock(async (input: Record<string, unknown>) => {
      if (input.roomId === PLATFORM_AGENT_ID) {
        return [
          {
            content: { text: teacherCorpusText },
            metadata: {
              subtype: 'teacher-corpus',
              corpusHash: 'current-corpus-hash',
              index: 2,
            },
          },
        ];
      }
      return [];
    });

    const result = await knowledgeProvider.get(
      { searchMemories },
      { content: { text: state.userMessage } },
      state,
    );

    expect(searchMemories.mock.calls[0]![0]).toMatchObject({
      tableName: 'knowledge',
      count: 5,
      roomId: PLATFORM_AGENT_ID,
      entityId: PLATFORM_AGENT_ID,
      unique: true,
    });
    expect(result.text).toContain(teacherCorpusText);
    expect(result.data?.knowledgeEntries).toEqual([teacherCorpusText]);
    expect(result.values).toMatchObject({
      relevantCount: 1,
      retrievalMode: 'vector',
    });
  });

  it('uses the verified platform agent for both rooms without requiring an avatar id', async () => {
    const searchMemories = mock(async () => []);

    await knowledgeProvider.get(
      { searchMemories },
      { content: { text: state.userMessage } },
      {
        platformAgentId: PLATFORM_AGENT_ID,
        userMessage: state.userMessage,
        characterConfig: { knowledge: [] },
      },
    );

    expect(searchMemories).toHaveBeenCalledTimes(2);
    expect(searchMemories.mock.calls[0]![0]).toMatchObject({
      roomId: PLATFORM_AGENT_ID,
      entityId: PLATFORM_AGENT_ID,
    });
    expect(searchMemories.mock.calls[1]![0]).toMatchObject({
      roomId: protocolKnowledgeRoomId(PLATFORM_AGENT_ID),
      entityId: protocolKnowledgeEntityId(PLATFORM_AGENT_ID),
    });
  });

  it('issues the agent-scoped second search and keeps the highest version per section', async () => {
    const queryEmbedding = [0.1, 0.2, 0.3];
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ data: [{ embedding: queryEmbedding }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const searchMemories = mock(async (input: Record<string, unknown>) => {
      if (input.roomId === PLATFORM_AGENT_ID) {
        return [{ content: { text: 'Primary learned knowledge' } }];
      }
      return [
        {
          content: { text: 'Old claim instructions' },
          metadata: { subtype: 'protocol-knowledge', version: 19, section: 4 },
        },
        {
          content: { text: 'Current claim instructions' },
          metadata: { subtype: 'protocol-knowledge', version: 20, section: 4 },
        },
        {
          content: { text: 'Wrong subtype' },
          metadata: { subtype: 'building-skill', version: 99, section: 4 },
        },
      ];
    });

    const result = await knowledgeProvider.get(
      { searchMemories },
      { content: { text: state.userMessage } },
      state,
    );

    expect(searchMemories).toHaveBeenCalledTimes(2);
    const firstCall = searchMemories.mock.calls[0]![0];
    const secondCall = searchMemories.mock.calls[1]![0];
    expect(secondCall).toMatchObject({
      tableName: 'knowledge',
      count: 2,
      roomId: protocolKnowledgeRoomId(PLATFORM_AGENT_ID),
      entityId: protocolKnowledgeEntityId(PLATFORM_AGENT_ID),
      unique: true,
    });
    expect(secondCall.embedding).toBe(firstCall.embedding);
    expect(result.text).toContain('[Game manual \u2014 relevant sections]');
    expect(result.text).toContain('Current claim instructions');
    expect(result.text).not.toContain('Old claim instructions');
    expect(result.text).not.toContain('Wrong subtype');
  });

  it('returns relevant protocol sections when the main room has no matches', async () => {
    const searchMemories = mock(async (input: Record<string, unknown>) => {
      if (input.roomId === PLATFORM_AGENT_ID) return [];
      return [
        {
          content: { text: 'Manual-only result' },
          metadata: { subtype: 'protocol-knowledge', version: 20, section: 2 },
        },
      ];
    });

    const result = await knowledgeProvider.get(
      { searchMemories },
      { content: { text: state.userMessage } },
      { ...state, characterConfig: { knowledge: [] } },
    );

    expect(result.text).toBe(
      '[Game manual \u2014 relevant sections]\nManual-only result',
    );
    expect(result.data?.protocolKnowledgeEntries).toEqual([
      'Manual-only result',
    ]);
  });

  it('keeps the primary knowledge result when the protocol search throws', async () => {
    const searchMemories = mock(async (input: Record<string, unknown>) => {
      if (input.roomId === PLATFORM_AGENT_ID) {
        return [{ content: { text: 'Primary survives' } }];
      }
      throw new Error('protocol room unavailable');
    });

    const result = await knowledgeProvider.get(
      { searchMemories },
      { content: { text: state.userMessage } },
      state,
    );

    expect(searchMemories).toHaveBeenCalledTimes(2);
    expect(result.text).toContain('Primary survives');
    expect(result.text).not.toContain('[Game manual');
    expect(result.values).toEqual({
      knowledgeCount: 1,
      relevantCount: 1,
      retrievalMode: 'vector',
    });
    expect(result.data).toEqual({
      knowledgeEntries: ['Primary survives'],
      knowledgeCount: 1,
      relevantCount: 1,
      retrievalMode: 'vector',
    });
  });

  it('keeps JSONB fallback knowledge when the main search throws and protocol succeeds', async () => {
    const searchMemories = mock(async (input: Record<string, unknown>) => {
      if (input.roomId === PLATFORM_AGENT_ID) {
        throw new Error('main room unavailable');
      }
      return [
        {
          content: { text: 'Current manual section' },
          metadata: { subtype: 'protocol-knowledge', version: 20, section: 5 },
        },
      ];
    });

    const result = await knowledgeProvider.get(
      { searchMemories },
      { content: { text: state.userMessage } },
      state,
    );

    expect(searchMemories).toHaveBeenCalledTimes(2);
    expect(result.text).toContain('[Knowledge]');
    expect(result.text).toContain('Recent: Learned skill');
    expect(result.text).toContain('[Game manual \u2014 relevant sections]');
    expect(result.text).toContain('Current manual section');
    expect(result.values).toEqual({
      knowledgeCount: 1,
      retrievalMode: 'jsonb-fallback',
      protocolRelevantCount: 1,
    });
    expect(result.data).toEqual({
      knowledgeEntries: ['Learned skill'],
      knowledgeCount: 1,
      retrievalMode: 'jsonb-fallback',
      protocolKnowledgeEntries: ['Current manual section'],
      protocolRelevantCount: 1,
    });
  });
});
