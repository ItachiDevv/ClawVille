import type { IsolatedTaskBinding, IsolatedTaskProxyRequest, IsolatedTaskProxyResponse, IsolatedTaskRuntimeConfig } from './types';
import type { IsolatedTaskResult } from './runtime';

export const TASK_STDIO_VERSION = 1;
export const TASK_STDIO_MAX_FRAME_BYTES = 262_144;
export type TaskWorkerInput =
  | { type: 'initialize'; version: 1; binding: IsolatedTaskBinding; brief: string }
  | { type: 'generated'; version: 1; response: IsolatedTaskProxyResponse }
  | { type: 'refused'; version: 1; code: 'budget_refused' | 'execution_refused' | 'expired' | 'uncertain' | 'unavailable' }
  | { type: 'cancel'; version: 1 };
export type TaskWorkerOutput =
  | { type: 'generate'; version: 1; request: IsolatedTaskProxyRequest }
  | { type: 'result'; version: 1; result: IsolatedTaskResult }
  | { type: 'error'; version: 1; code: 'invalid_frame' | 'unexpected_frame' | 'input_closed' | 'expired' | 'proxy_refused' | 'runtime_refused' };
export class TaskStdioError extends Error {
  constructor(readonly code: Extract<TaskWorkerOutput, { type: 'error' }>['code']) { super(`Task channel refused: ${code}`); }
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
export function parseTaskWorkerInput(value: unknown): TaskWorkerInput {
  if (!record(value) || value.version !== 1) throw new TaskStdioError('invalid_frame');
  if (value.type === 'initialize' && keys(value, ['type', 'version', 'binding', 'brief']) && typeof value.brief === 'string' && record(value.binding)) {
    // The runtime's strict profile validator checks every binding field before initialization.
    return { type: 'initialize', version: 1, binding: value.binding as unknown as IsolatedTaskBinding, brief: value.brief };
  }
  if (value.type === 'generated' && keys(value, ['type', 'version', 'response']) && record(value.response)) {
    const response = value.response;
    if (keys(response, ['callId', 'model', 'promptHash', 'text', 'inputTokens', 'outputTokens'])
      && typeof response.callId === 'string' && typeof response.model === 'string' && typeof response.promptHash === 'string'
      && typeof response.text === 'string' && typeof response.inputTokens === 'number' && typeof response.outputTokens === 'number') {
      return { type: 'generated', version: 1, response: response as unknown as IsolatedTaskProxyResponse };
    }
  }
  if (value.type === 'refused' && keys(value, ['type', 'version', 'code'])
    && ['budget_refused', 'execution_refused', 'expired', 'uncertain', 'unavailable'].includes(String(value.code))) {
    return value as unknown as TaskWorkerInput;
  }
  if (value.type === 'cancel' && keys(value, ['type', 'version'])) return { type: 'cancel', version: 1 };
  throw new TaskStdioError('invalid_frame');
}

export function encodeTaskFrame(frame: TaskWorkerInput | TaskWorkerOutput): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(frame));
  if (bytes.length > TASK_STDIO_MAX_FRAME_BYTES) throw new TaskStdioError('invalid_frame');
  const output = new Uint8Array(bytes.length + 1); output.set(bytes); output[bytes.length] = 10;
  return output;
}

/** Bounded UTF-8 JSON-lines reader. A caller owns the absolute deadline for each phase. */
export class TaskFrameReader {
  private readonly reader: { read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: Uint8Array }>; cancel(): Promise<void> };
  private pending = new Uint8Array(0);
  constructor(input: ReadableStream<Uint8Array>) { this.reader = input.getReader(); }
  async next(deadlineMs: number, signal?: AbortSignal): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TaskStdioError('expired')), Math.max(1, deadlineMs - Date.now()));
    });
    let refuse!: () => void;
    const canceled = new Promise<never>((_, reject) => { refuse = () => reject(new TaskStdioError('expired')); });
    signal?.addEventListener('abort', refuse, { once: true });
    try {
      if (signal?.aborted || Date.now() >= deadlineMs) throw new TaskStdioError('expired');
      for (;;) {
        const newline = this.pending.indexOf(10);
        if (newline >= 0) {
          if (!newline || newline > TASK_STDIO_MAX_FRAME_BYTES) throw new TaskStdioError('invalid_frame');
          const bytes = this.pending.slice(0, newline); this.pending = this.pending.slice(newline + 1);
          try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
          catch { throw new TaskStdioError('invalid_frame'); }
        }
        const chunk = await Promise.race([this.reader.read(), abort, canceled]);
        if (chunk.done) throw new TaskStdioError('input_closed');
        if (this.pending.length + chunk.value.length > TASK_STDIO_MAX_FRAME_BYTES + 1) throw new TaskStdioError('invalid_frame');
        const joined = new Uint8Array(this.pending.length + chunk.value.length);
        joined.set(this.pending); joined.set(chunk.value, this.pending.length); this.pending = joined;
      }
    } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', refuse); }
  }
  hasBufferedInput(): boolean { return this.pending.length > 0; }
  async close(): Promise<void> { this.pending = new Uint8Array(0); await this.reader.cancel(); }
}

export function taskConfigFromFrame(frame: Extract<TaskWorkerInput, { type: 'initialize' }>, proxy: IsolatedTaskRuntimeConfig['executionProfile']['proxy']): IsolatedTaskRuntimeConfig {
  return { executionProfile: { kind: 'isolated-task', binding: frame.binding, brief: frame.brief, proxy } };
}
