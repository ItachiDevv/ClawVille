import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runTaskParent, type TaskChildChannel, type TaskParentProxy } from './parent';
import { buildIsolatedTaskPrompt, isolatedTaskPromptHash } from './profile';
import { encodeTaskFrame, type TaskWorkerOutput } from './stdio';
import type { IsolatedTaskBinding, IsolatedTaskProxyResponse } from './types';

function task() {
  const brief = 'Return bounded text.'; const prompt = buildIsolatedTaskPrompt(brief);
  const binding: IsolatedTaskBinding = { jobId: randomUUID(), avatarId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), generation: 1,
    callId: randomUUID(), reservationId: randomUUID(), model: 'fixture-model', promptHash: isolatedTaskPromptHash(prompt),
    maxInputTokens: 32768, maxOutputTokens: 100, deadlineMs: Date.now()+2000 };
  const response: IsolatedTaskProxyResponse = { callId: binding.callId, model: binding.model, promptHash: binding.promptHash,
    text: ' exact approved answer ', inputTokens: 50, outputTokens: 5 };
  return { binding, brief, prompt, response };
}
function peer(input: ReturnType<typeof task>, fault?: 'request' | 'result' | 'duplicate' | 'stderr' | 'stdout' | 'early-result' | 'cost' | 'result-binding') {
  let out!: ReadableStreamDefaultController<Uint8Array>, err!: ReadableStreamDefaultController<Uint8Array>;
  let exited!: (code: number) => void; let terminated = 0; let writes = 0; let closed = false;
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { out = controller; } });
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { err = controller; } });
  const finish = (code: number) => { if (!closed) { closed = true; try { out.close(); } catch {} try { err.close(); } catch {} exited(code); } };
  const channel: TaskChildChannel = { stdout, stderr, exited: new Promise(resolve => { exited = resolve; }),
    write: async () => {
      writes++;
      if (writes === 1) {
        if (fault === 'stdout') { out.enqueue(new Uint8Array(262146).fill(32)); return; }
        if (fault === 'stderr') err.enqueue(new Uint8Array(4097));
        const frame: unknown = fault === 'early-result' ? { type: 'result', version: 1, result: {} }
          : { type: 'generate', version: 1, request: { binding: fault === 'request' ? { ...input.binding, avatarId: randomUUID() } : input.binding, prompt: input.prompt } };
        out.enqueue(encodeTaskFrame(frame as TaskWorkerOutput));
      } else {
        const result = { type: 'result', version: 1, result: { runtimeId: randomUUID(), binding: fault === 'result-binding' ? { ...input.binding, callId: randomUUID() } : input.binding,
          text: fault === 'result' ? 'forged output' : input.response.text, inputTokens: input.response.inputTokens,
          outputTokens: fault === 'cost' ? 1 : input.response.outputTokens } };
        if (fault === 'duplicate') out.enqueue(encodeTaskFrame({ type: 'generate', version: 1, request: { binding: input.binding, prompt: input.prompt } }));
        out.enqueue(encodeTaskFrame(result as TaskWorkerOutput)); finish(0);
      }
    }, closeInput: async () => {}, terminate: async () => { terminated++; finish(1); },
  };
  return { channel, terminations: () => terminated };
}

test('parent returns only the exact trusted proxy result after a fresh receipt check', async () => {
  const input = task(), child = peer(input); let generated = 0, confirmed = 0;
  const proxy: TaskParentProxy = { generate: async request => { generated++; expect(request.binding).toEqual(input.binding); return input.response; },
    confirm: async () => { confirmed++; return input.response; } };
  const result = await runTaskParent({ ...input, child: child.channel, proxy });
  expect(result.text).toBe(input.response.text); expect(generated).toBe(1); expect(confirmed).toBe(1); expect(child.terminations()).toBe(1);
});
test('forged task authority, counterfeit success, text, cost, or duplicate generation never becomes a verified result', async () => {
  for (const fault of ['request', 'early-result', 'result', 'result-binding', 'cost', 'duplicate', 'stderr', 'stdout'] as const) {
    const input = task(), child = peer(input, fault); let calls = 0;
    await expect(runTaskParent({ ...input, child: child.channel, proxy: { generate: async () => { calls++; return input.response; }, confirm: async () => input.response } })).rejects.toMatchObject({ code: 'invalid_child' });
    expect(calls).toBe(['request', 'early-result', 'stderr', 'stdout'].includes(fault) ? 0 : 1);
    expect(child.terminations()).toBe(1);
  }
});
test('fresh receipt disagreement refuses output and does not request another generation', async () => {
  const input = task(), child = peer(input); let calls = 0;
  await expect(runTaskParent({ ...input, child: child.channel, proxy: { generate: async () => { calls++; return input.response; },
    confirm: async () => ({ ...input.response, text: 'different durable result' }) } })).rejects.toMatchObject({ code: 'proxy_refused' });
  expect(calls).toBe(1); expect(child.terminations()).toBe(1);
});
test('cancellation aborts the retained proxy signal and terminates the child', async () => {
  const input = task(), child = peer(input), controller = new AbortController(); let signal: AbortSignal | undefined;
  let called!: () => void; const started = new Promise<void>(resolve => { called = resolve; });
  const pending = runTaskParent({ ...input, child: child.channel, signal: controller.signal, proxy: {
    generate: async (_request, received) => { signal = received; called(); return new Promise(() => {}); }, confirm: async () => input.response } });
  await started; controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'expired' }); expect(signal?.aborted).toBe(true); expect(child.terminations()).toBe(1);
});
test('the parent drives an actual clean Eliza child without a provider or paid call', async () => {
  const input = task(); const worker = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, 'process-entry.ts')], {
    env: { SystemRoot: process.env.SystemRoot ?? '', NODE_ENV: 'test' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const result = await runTaskParent({ ...input, child: { stdout: worker.stdout, stderr: worker.stderr, exited: worker.exited,
    write: async bytes => { worker.stdin.write(bytes); await worker.stdin.flush(); }, closeInput: async () => { await worker.stdin.end(); },
    terminate: async () => { worker.kill(); } }, proxy: { generate: async () => input.response, confirm: async () => input.response } });
  expect(result.text).toBe(input.response.text); expect(result.stderrBytes).toBe(0); expect(await worker.exited).toBe(0);
});

test('cleanup cannot release output after the binding deadline', async () => {
  const input = task(); input.binding.deadlineMs = Date.now() + 100;
  const child = peer(input); const terminate = child.channel.terminate; let confirmations = 0;
  child.channel.terminate = async () => { await Bun.sleep(180); await terminate(); };
  await expect(runTaskParent({ ...input, child: child.channel, proxy: {
    generate: async () => input.response, confirm: async () => { confirmations++; return input.response; },
  } })).rejects.toMatchObject({ code: 'expired' });
  expect(confirmations).toBe(0); expect(child.terminations()).toBe(1);
});
test('final durable confirmation observes revocation during cleanup', async () => {
  const input = task(), child = peer(input); const terminate = child.channel.terminate;
  let revoked = false, confirmations = 0;
  child.channel.terminate = async () => { await Bun.sleep(10); revoked = true; await terminate(); };
  await expect(runTaskParent({ ...input, child: child.channel, proxy: {
    generate: async () => input.response, confirm: async () => {
      confirmations++; if (revoked) throw new Error('fixture revocation'); return input.response;
    },
  } })).rejects.toMatchObject({ code: 'proxy_refused' });
  expect(confirmations).toBe(1); expect(child.terminations()).toBe(1);
});
