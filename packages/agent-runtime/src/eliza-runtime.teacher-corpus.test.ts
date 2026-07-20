import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { ElizaRuntime } from './eliza-runtime';

const AGENT_ID = '50000000-0000-0000-0000-000000000005';
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'teacher-corpus-test-key';
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
});

describe('teacher corpus runtime-start injector', () => {
  it('writes each chunk once, skips the same hash, and replaces a changed corpus', async () => {
    let rows: any[] = [];
    const createMemory = mock(async (memory: any) => {
      rows.push(memory);
      return memory.id;
    });
    const deleteManyMemories = mock(async (ids: string[]) => {
      rows = rows.filter((row) => !ids.includes(row.id));
    });
    const adapter = {
      getMemories: mock(async () => rows),
      createMemory,
      deleteManyMemories,
    };
    const runtime = new ElizaRuntime({
      agentId: AGENT_ID,
      agentType: 'location-agent',
      agentConfig: {},
      customization: {
        name: 'Corpus Teacher',
        bio: ['A concise teacher.'],
        knowledge: ['first chunk', 'second chunk'],
      },
    });
    (runtime as any).state = 'running';
    (runtime as any).runtime = adapter;

    expect(await runtime.injectTeacherCorpusKnowledge()).toBe(true);
    expect(createMemory).toHaveBeenCalledTimes(2);
    const expectedHash = createHash('sha256')
      .update('first chunk\nsecond chunk')
      .digest('hex');
    for (let index = 0; index < rows.length; index++) {
      expect(rows[index]).toMatchObject({
        agentId: AGENT_ID,
        roomId: AGENT_ID,
        entityId: AGENT_ID,
        content: { text: index === 0 ? 'first chunk' : 'second chunk' },
        metadata: {
          subtype: 'teacher-corpus',
          corpusHash: expectedHash,
          index,
        },
      });
      expect(Object.keys(rows[index].metadata).sort()).toEqual([
        'corpusHash',
        'index',
        'subtype',
      ]);
    }

    expect(await runtime.injectTeacherCorpusKnowledge()).toBe(false);
    expect(createMemory).toHaveBeenCalledTimes(2);

    (runtime as any).teacherCorpus = ['replacement chunk'];
    expect(await runtime.injectTeacherCorpusKnowledge()).toBe(true);
    expect(createMemory).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(1);
    expect(rows[0].content.text).toBe('replacement chunk');
    expect(deleteManyMemories).toHaveBeenCalledTimes(1);
  });
});
