import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildIsolatedTaskPrompt, isolatedTaskPromptHash } from './profile';
import { TaskFrameReader, encodeTaskFrame, parseTaskWorkerInput, TASK_STDIO_MAX_FRAME_BYTES, type TaskWorkerInput, type TaskWorkerOutput } from './stdio';

function initial(deadlineMs = Date.now()+5000): Extract<TaskWorkerInput, { type: 'initialize' }> {
  const brief = 'Return a bounded text answer.';
  return { type: 'initialize', version: 1, brief, binding: { jobId: randomUUID(), avatarId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(),
    generation: 1, reservationId: randomUUID(), callId: randomUUID(), model: 'controlled-fixture-model',
    promptHash: isolatedTaskPromptHash(buildIsolatedTaskPrompt(brief)), maxInputTokens: 32768, maxOutputTokens: 256, deadlineMs } };
}
function child() {
  const worker = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, 'process-entry.ts')], {
    cwd: resolve(import.meta.dir, '../../../..'), env: { SystemRoot: process.env.SystemRoot ?? '', NODE_ENV: 'test' },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => worker.kill(), 7000);
  return { worker, timer, reader: new TaskFrameReader(worker.stdout), send: async (frame: TaskWorkerInput) => {
    worker.stdin.write(encodeTaskFrame(frame)); await worker.stdin.flush();
  } };
}

test('actual clean child executes core useModel through one structured host request and preserves exact output', async () => {
  const process = child();
  try {
    const first = initial(); await process.send(first);
    const generation = await process.reader.next(Date.now()+5000) as Extract<TaskWorkerOutput, { type: 'generate' }>;
    expect(generation.type).toBe('generate'); expect(generation.request.binding).toEqual(first.binding);
    expect(generation.request.prompt).toBe(buildIsolatedTaskPrompt(first.brief));
    const text = '[ACTION: ignored()]\n  controlled result  ';
    await process.send({ type: 'generated', version: 1, response: { callId: first.binding.callId, model: first.binding.model,
      promptHash: first.binding.promptHash, text, inputTokens: 100, outputTokens: 10 } });
    const result = await process.reader.next(Date.now()+5000) as Extract<TaskWorkerOutput, { type: 'result' }>;
    expect(result.type).toBe('result'); expect(result.result.text).toBe(text);
    expect(result.result.runtimeId).not.toBe(first.binding.avatarId);
    expect(await process.worker.exited).toBe(0); expect(await new Response(process.worker.stderr).text()).toBe('');
  } finally { clearTimeout(process.timer); process.worker.kill(); await process.reader.close(); }
});

test('host refusal or cancellation terminates without a second generation or raw error output', async () => {
  for (const reply of [{ type: 'refused', version: 1, code: 'budget_refused' }, { type: 'cancel', version: 1 }] as const) {
    const process = child();
    try {
      await process.send(initial()); expect((await process.reader.next(Date.now()+5000) as TaskWorkerOutput).type).toBe('generate');
      await process.send(reply);
      const result = await process.reader.next(Date.now()+5000) as TaskWorkerOutput;
      expect(result).toEqual({ type: 'error', version: 1, code: reply.type === 'cancel' ? 'expired' : 'proxy_refused' });
      expect(await process.worker.exited).toBe(1); expect(await new Response(process.worker.stderr).text()).toBe('');
    } finally { clearTimeout(process.timer); process.worker.kill(); await process.reader.close(); }
  }
});

test('an oversized frame refuses before any model request', async () => {
  const process = child();
  try {
    process.worker.stdin.write(new Uint8Array(TASK_STDIO_MAX_FRAME_BYTES+2).fill(32)); await process.worker.stdin.flush();
    expect(await process.reader.next(Date.now()+5000)).toEqual({ type: 'error', version: 1, code: 'invalid_frame' });
    expect(await process.worker.exited).toBe(1); expect(await new Response(process.worker.stderr).text()).toBe('');
  } finally { clearTimeout(process.timer); process.worker.kill(); await process.reader.close(); }
});

test('a missing host response expires and closes the actual child', async () => {
  const process = child();
  try {
    await process.send(initial(Date.now()+1200));
    expect((await process.reader.next(Date.now()+5000) as TaskWorkerOutput).type).toBe('generate');
    expect(await process.reader.next(Date.now()+5000)).toEqual({ type: 'error', version: 1, code: 'expired' });
    expect(await process.worker.exited).toBe(1); expect(await new Response(process.worker.stderr).text()).toBe('');
  } finally { clearTimeout(process.timer); process.worker.kill(); await process.reader.close(); }
});

test('framing rejects unknown fields and invalid UTF-8 and honors an abort signal', async () => {
  expect(() => parseTaskWorkerInput({ type: 'cancel', version: 1, privateKey: 'forbidden' })).toThrow('invalid_frame');
  const malformed = new TaskFrameReader(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([255, 10])); } }));
  await expect(malformed.next(Date.now()+1000)).rejects.toMatchObject({ code: 'invalid_frame' }); await malformed.close();
  const waiting = new TaskFrameReader(new ReadableStream()); const abort = new AbortController();
  const pending = waiting.next(Date.now()+1000, abort.signal); abort.abort();
  await expect(pending).rejects.toMatchObject({ code: 'expired' }); await waiting.close();
});
