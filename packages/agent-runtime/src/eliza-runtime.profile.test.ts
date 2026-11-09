import { expect, test } from 'bun:test';
import { ElizaRuntime, createElizaRuntime } from './eliza-runtime';
import { IsolatedTaskRuntime } from './isolated-task/runtime';
import { buildIsolatedTaskPrompt, isolatedTaskPromptHash } from './isolated-task/profile';
import type { ElizaRuntimeConfig } from './eliza-runtime';

const ordinary: ElizaRuntimeConfig = { agentId: '00000000-0000-4000-8000-000000000010', agentType: 'avatar-agent', agentConfig: {},
  customization: { name: 'Regression avatar', knowledge: ['ordinary avatar knowledge'] } };

test('absent and explicit avatar profile preserve the existing character and wrapper', () => {
  const baseline = new ElizaRuntime(ordinary);
  const implicit = createElizaRuntime(ordinary);
  const explicit = createElizaRuntime({ ...ordinary, executionProfile: { kind: 'avatar' } });
  expect(implicit).toBeInstanceOf(ElizaRuntime); expect(explicit).toBeInstanceOf(ElizaRuntime);
  expect(implicit.getCharacter()).toEqual(baseline.getCharacter());
  expect(explicit.getCharacter()).toEqual(baseline.getCharacter());
  expect(JSON.stringify(explicit.getCharacter().knowledge)).toContain('ordinary avatar knowledge');
  expect(explicit.getCharacter().plugins).toContain('@elizaos/plugin-sql');
});

test('the ordinary factory delegates only an exact isolated profile and rejects profile conflicts', () => {
  for (const executionProfile of [{ kind: 'other' }, { kind: 'avatar', databaseUrl: 'ignored' }]) {
    expect(() => createElizaRuntime({ ...ordinary, executionProfile } as ElizaRuntimeConfig)).toThrow('Invalid avatar execution profile');
  }
  const brief = 'Say sea.';
  const executionProfile = { kind: 'isolated-task' as const, brief,
    binding: { jobId: ordinary.agentId, avatarId: ordinary.agentId, taskId: ordinary.agentId, attemptId: ordinary.agentId,
      reservationId: ordinary.agentId, callId: ordinary.agentId, generation: 1, model: 'reviewed-model',
      promptHash: isolatedTaskPromptHash(buildIsolatedTaskPrompt(brief)), maxInputTokens: 32768, maxOutputTokens: 100, deadlineMs: Date.now() + 10_000 },
    proxy: { generate: async () => { throw new Error('not executed'); } } };
  expect(createElizaRuntime({ executionProfile })).toBeInstanceOf(IsolatedTaskRuntime);
  expect(() => createElizaRuntime({ ...ordinary, executionProfile })).toThrow('invalid_configuration');
});
