import { createElizaRuntime } from './index';
import { IsolatedTaskError } from './profile';
import { TaskFrameReader, TaskStdioError, encodeTaskFrame, parseTaskWorkerInput, taskConfigFromFrame, type TaskWorkerOutput } from './stdio';

/** Actual single-shot Eliza child lifecycle. The host alone owns provider and budget authority. */
export async function runIsolatedTaskProcess(io: {
  input: ReadableStream<Uint8Array>;
  write: (bytes: Uint8Array) => Promise<void>;
}): Promise<0 | 1> {
  const reader = new TaskFrameReader(io.input);
  let emitted = false;
  let transportError: TaskStdioError | undefined;
  let deadline = Date.now() + 5000;
  const write = async (frame: TaskWorkerOutput) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([io.write(encodeTaskFrame(frame)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TaskStdioError('expired')), Math.max(1, deadline - Date.now()));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    const initial = parseTaskWorkerInput(await reader.next(deadline));
    if (initial.type !== 'initialize') throw new TaskStdioError('unexpected_frame');
    deadline = initial.binding.deadlineMs;
    const runtime = createElizaRuntime(taskConfigFromFrame(initial, {
      generate: async (request, signal) => {
        try {
          if (emitted) throw new TaskStdioError('unexpected_frame');
          emitted = true;
          await write({ type: 'generate', version: 1, request });
          const reply = parseTaskWorkerInput(await reader.next(request.binding.deadlineMs, signal));
          if (reply.type === 'refused') throw new TaskStdioError('proxy_refused');
          if (reply.type === 'cancel') throw new TaskStdioError('expired');
          if (reply.type !== 'generated') throw new TaskStdioError('unexpected_frame');
          return reply.response;
        } catch (error) { if (error instanceof TaskStdioError) transportError = error; throw error; }
      },
    }));
    const result = await runtime.execute();
    if (reader.hasBufferedInput()) throw new TaskStdioError('unexpected_frame');
    await write({ type: 'result', version: 1, result });
    return 0;
  } catch (error) {
    const code: Extract<TaskWorkerOutput, { type: 'error' }>['code'] = transportError?.code ?? (error instanceof TaskStdioError ? error.code
      : error instanceof IsolatedTaskError && error.code === 'expired' ? 'expired' : 'runtime_refused');
    deadline = Math.min(Date.now() + 100, Number.isFinite(deadline) ? deadline : Date.now() + 100);
    try { await write({ type: 'error', version: 1, code }); } catch { /* No raw errors reach stdout or stderr. */ }
    return 1;
  } finally { try { await reader.close(); } catch { /* Host channel already closed. */ } }
}
