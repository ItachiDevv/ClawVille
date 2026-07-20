import { describe, expect, it, mock } from 'bun:test';
import { ElizaRuntime } from './eliza-runtime';

const AGENT_ID = '60000000-0000-0000-0000-000000000006';

describe('conversation history fetch is bounded', () => {
  it('passes count (the param core actually reads) — never limit — so history cannot fetch the whole room', async () => {
    const getMemories = mock(async (params: Record<string, unknown>) => {
      // Simulate core semantics: `count` bounds the result, `limit` is ignored.
      // Returning a sentinel oversized array when count is absent makes an
      // unbounded fetch fail the assertion below loudly.
      if (typeof params.count !== 'number') {
        return Array.from({ length: 500 }, (_, i) => ({
          content: { text: `msg ${i}` },
          entityId: 'someone',
          createdAt: i,
        }));
      }
      return Array.from({ length: Math.min(20, params.count as number) }, (_, i) => ({
        content: { text: `msg ${i}` },
        entityId: 'someone',
        createdAt: i,
      }));
    });

    const runtime = new ElizaRuntime({
      agentId: AGENT_ID,
      agentType: 'location-agent',
      agentConfig: {},
      customization: { name: 'History Test Teacher', bio: ['Persona.'] },
    });
    (runtime as any).state = 'running';
    (runtime as any).runtime = { getMemories };

    const history = await (runtime as any).getConversationHistory('room-1', 20);

    expect(getMemories).toHaveBeenCalledTimes(1);
    const params = getMemories.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.count).toBe(20);
    expect(params.limit).toBeUndefined();
    expect(params.tableName).toBe('messages');
    expect(history.length).toBeLessThanOrEqual(20);
  });
});
