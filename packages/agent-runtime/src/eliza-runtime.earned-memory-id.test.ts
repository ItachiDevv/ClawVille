import { describe, expect, mock, test } from 'bun:test';
mock.module('./plugins/embed-text', () => ({ embedText: async () => [0.1, 0.2] }));
const { ElizaRuntime } = await import('./eliza-runtime');

describe('earned lesson memory identity', () => {
  test('identical avatar lessons remain distinct across runtime agents and stable within each agent', async () => {
    const ids: string[] = [];
    const save = async (agentId: string) => {
      const fake = {
        state: 'running', config: { agentId },
        runtime: { createMemory: async (memory: { id: string }) => { ids.push(memory.id); } },
        ensureWorld: async () => 'world', ensureRoom: async () => {}, ensureEntity: async () => {},
      };
      return ElizaRuntime.prototype.recordEarnedSkillMemory.call(fake as never, {
        avatarId: 'shared-avatar', buildingId: 'town-guide', lesson: 'The Bounty Board is at the pavilion.', teacherName: 'Nori',
      });
    };
    expect(await save('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(await save('22222222-2222-4222-8222-222222222222')).toBe(true);
    expect(await save('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toBe(ids[2]);
  });
});
