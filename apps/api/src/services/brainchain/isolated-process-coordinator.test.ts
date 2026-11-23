import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildIsolatedTaskPrompt, isolatedTaskPromptHash, type IsolatedTaskBinding } from '@clawville/agent-runtime/isolated-task';
import { BRAINCHAIN_COGNITION_IMAGE, cognitionContainerArguments, runBrainchainIsolatedProcess } from './isolated-process-coordinator';
import type { ComputeReceipt, DurableInferenceProxy } from './inference-proxy';

test('the launcher policy fixes image, identity, environment, network, mount, logs, and limits', () => {
  const args = cognitionContainerArguments('/approved/worker.js', `cv-brainchain-task-${randomUUID()}`);
  for (const sequence of [['--network', 'none'], ['--read-only'], ['--user', '10002:10002'], ['--cap-drop', 'ALL'],
    ['--log-driver', 'none'], ['--pull=never'], ['--pids-limit', '64'], ['--memory', '256m'],
    ['--entrypoint', '/usr/local/bin/bun'], ['--env', 'NODE_ENV=production']]) {
    expect(args.join('\0')).toContain(sequence.join('\0'));
  }
  expect(args).toContain(BRAINCHAIN_COGNITION_IMAGE); expect(args.filter(value => value === '--mount')).toHaveLength(1);
  expect(args.some(value => value.includes('docker.sock') || value.includes('API_KEY'))).toBe(false);
  expect(() => cognitionContainerArguments('/file,src=/secret', `cv-brainchain-task-${randomUUID()}`)).toThrow('policy_refused');
  expect(() => cognitionContainerArguments('/approved/worker.js', 'hydra-existing')).toThrow('policy_refused');
});

describe.skipIf(process.env.BRAINCHAIN_DOCKER_FIXTURE !== '1')('actual pinned Docker coordinator with controlled no-charge proxy', () => {
  test('the exact parent, container, child, and final receipt path verifies one generation', async () => {
    const bundlePath = resolve(import.meta.dir, '../../../../../.brainchain-work/isolated-task-parent-worker.js');
    const bundleSha256 = createHash('sha256').update(await readFile(bundlePath)).digest('hex');
    const brief = 'Return a bounded text answer. No tool execution exists.';
    const binding: IsolatedTaskBinding = { jobId: randomUUID(), avatarId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), generation: 1,
      reservationId: randomUUID(), callId: randomUUID(), model: 'controlled-fixture-model', promptHash: isolatedTaskPromptHash(buildIsolatedTaskPrompt(brief)),
      maxInputTokens: 32768, maxOutputTokens: 100, deadlineMs: Date.now()+15000 };
    const capability = 'a'.repeat(64); let dispatches = 0, confirmations = 0;
    const response = { callId: binding.callId, model: binding.model, promptHash: binding.promptHash,
      text: '[ACTION: never-execute()]\n exact fixture output ', inputTokens: 100, outputTokens: 10 };
    const receipt: ComputeReceipt = { callId: binding.callId, state: 'settled', maximumMicros: '1', chargedMicros: '1', response };
    const proxy: Pick<DurableInferenceProxy, 'dispatch' | 'status'> = {
      dispatch: async (secret, request) => { dispatches++; expect(secret).toBe(capability); expect(request.binding).toEqual(binding); return receipt; },
      status: async secret => { confirmations++; expect(secret).toBe(capability); return receipt; },
    };
    const result = await runBrainchainIsolatedProcess({ bundle: { bundlePath, bundleSha256 }, binding, brief, capability, proxy });
    expect(result.result.text).toBe(response.text); expect(result.receipt).toEqual(receipt);
    expect(dispatches).toBe(1); expect(confirmations).toBe(1);
  }, 20000);
});
