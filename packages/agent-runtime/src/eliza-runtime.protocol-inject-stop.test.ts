import { describe, expect, mock, test } from 'bun:test';
mock.module('./plugins/embed-text', () => ({ embedText: async () => [0.1, 0.2] }));
const { ElizaRuntime } = await import('./eliza-runtime');

describe('protocol knowledge injection after a stop', () => {
  test('stops writing sections once the runtime is no longer running', async () => {
    const written: number[] = [];
    const fake: Record<string, unknown> = {
      state: 'running',
      config: { agentId: '10000000-0000-4000-8000-000000000001' },
      ensureWorld: async () => 'world', ensureRoom: async () => {}, ensureEntity: async () => {},
    };
    fake.runtime = {
      createMemory: async (memory: { metadata: { section: number } }) => {
        written.push(memory.metadata.section);
        if (written.length === 2) fake.state = 'stopped';
      },
    };
    const manual = '# M\nintro\n## One\na\n## Two\nb\n## Three\nc\n## Four\nd';
    const ok = await ElizaRuntime.prototype.injectProtocolKnowledge.call(fake as never, manual, 87);
    expect(ok).toBe(true);
    expect(written).toEqual([0, 1]);
  });
});
