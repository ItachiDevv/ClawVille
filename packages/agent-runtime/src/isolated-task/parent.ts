import { validateIsolatedTaskConfig } from './profile';
import { TaskFrameReader, encodeTaskFrame } from './stdio';
import type { IsolatedTaskBinding, IsolatedTaskProxyRequest, IsolatedTaskProxyResponse } from './types';

export class TaskParentError extends Error {
  constructor(readonly code: 'invalid_request' | 'invalid_child' | 'proxy_refused' | 'expired' | 'unavailable') {
    super(`Task parent refused: ${code}`); this.name = 'TaskParentError';
  }
}
export interface TaskChildChannel {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  write(bytes: Uint8Array): Promise<void>;
  closeInput(): Promise<void>;
  /** Must kill the owned process/container; never select a caller-supplied target. */
  terminate(): Promise<void>;
}
export interface TaskParentProxy {
  generate(request: IsolatedTaskProxyRequest, signal: AbortSignal): Promise<IsolatedTaskProxyResponse>;
  /** Recheck the actual durable receipt and current task fence before releasing output. */
  confirm(request: IsolatedTaskProxyRequest, signal: AbortSignal): Promise<IsolatedTaskProxyResponse>;
}
export interface VerifiedTaskChildResult {
  readonly runtimeId: string;
  readonly binding: Readonly<IsolatedTaskBinding>;
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stderrBytes: number;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function sameBinding(value: unknown, binding: IsolatedTaskBinding): boolean {
  return object(value) && exact(value, Object.keys(binding))
    && Object.entries(binding).every(([key, expected]) => value[key] === expected);
}
function sameResponse(value: IsolatedTaskProxyResponse, expected: IsolatedTaskProxyResponse): boolean {
  return value.callId === expected.callId && value.model === expected.model && value.promptHash === expected.promptHash
    && value.text === expected.text && value.inputTokens === expected.inputTokens && value.outputTokens === expected.outputTokens;
}
function approvedResponse(value: IsolatedTaskProxyResponse, binding: IsolatedTaskBinding): IsolatedTaskProxyResponse {
  if (!value || value.callId !== binding.callId || value.model !== binding.model || value.promptHash !== binding.promptHash
    || typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text, 'utf8') > 32768
    || !Number.isSafeInteger(value.inputTokens) || value.inputTokens < 0 || value.inputTokens > binding.maxInputTokens
    || !Number.isSafeInteger(value.outputTokens) || value.outputTokens < 1 || value.outputTokens > binding.maxOutputTokens) throw new TaskParentError('proxy_refused');
  return Object.freeze({ callId: value.callId, model: value.model, promptHash: value.promptHash, text: value.text,
    inputTokens: value.inputTokens, outputTokens: value.outputTokens });
}
async function terminateChild(child: TaskChildChannel): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([child.terminate(), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TaskParentError('unavailable')), 3000);
  })]); }
  catch { throw new TaskParentError('unavailable'); }
  finally { if (timer) clearTimeout(timer); }
}

/** Trusted host helper only. It contains no process command, endpoint, or credential selection. */
export async function runTaskParent(input: {
  binding: IsolatedTaskBinding; brief: string; child: TaskChildChannel; proxy: TaskParentProxy; signal?: AbortSignal;
}): Promise<VerifiedTaskChildResult> {
  let approved: ReturnType<typeof validateIsolatedTaskConfig>;
  const brief = input.brief;
  let generate: TaskParentProxy['generate'], confirm: TaskParentProxy['confirm'];
  try {
    if (!input.proxy || typeof input.proxy.generate !== 'function' || typeof input.proxy.confirm !== 'function') throw new TaskParentError('invalid_request');
    generate = input.proxy.generate.bind(input.proxy); confirm = input.proxy.confirm.bind(input.proxy);
    approved = validateIsolatedTaskConfig({ executionProfile: { kind: 'isolated-task', binding: input.binding, brief, proxy: { generate } } });
  } catch { await terminateChild(input.child); throw new TaskParentError('invalid_request'); }
  const prompt = approved.prompt;
  const binding = approved.binding;
  const controller = new AbortController(); const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  const reader = new TaskFrameReader(input.child.stdout); const errors = input.child.stderr.getReader();
  let stderrBytes = 0; let overflow = false; let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new TaskParentError('expired')); }, Math.max(1, binding.deadlineMs - Date.now()));
    controller.signal.addEventListener('abort', () => reject(new TaskParentError('expired')), { once: true });
  });
  void deadline.catch(() => {});
  // Read concurrently so an untrusted child cannot block behind a full stderr pipe.
  const stderr = (async () => {
    for (;;) {
      const chunk = await errors.read(); if (chunk.done) return;
      stderrBytes += chunk.value.byteLength;
      if (stderrBytes > 4096) { overflow = true; controller.abort(); throw new TaskParentError('invalid_child'); }
    }
  })();
  void stderr.catch(() => {});
  const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, deadline]);
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await terminateChild(input.child);
    let readerTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled([reader.close(), errors.cancel()]), new Promise<void>(resolve => { readerTimer = setTimeout(resolve, 100); })]); }
    finally { if (readerTimer) clearTimeout(readerTimer); }
  };
  try {
    if (input.signal?.aborted || Date.now() >= binding.deadlineMs) throw new TaskParentError('expired');
    await bounded(input.child.write(encodeTaskFrame({ type: 'initialize', version: 1, binding, brief })));
    const first = await reader.next(binding.deadlineMs, controller.signal);
    if (!object(first) || !exact(first, ['type', 'version', 'request']) || first.type !== 'generate' || first.version !== 1
      || !object(first.request) || !exact(first.request, ['binding', 'prompt']) || !sameBinding(first.request.binding, binding)
      || first.request.prompt !== prompt) throw new TaskParentError('invalid_child');
    const request = Object.freeze({ binding, prompt });
    let response: IsolatedTaskProxyResponse;
    try { response = approvedResponse(await bounded(generate(request, controller.signal)), binding); }
    catch { throw new TaskParentError(controller.signal.aborted ? 'expired' : 'proxy_refused'); }
    await bounded(input.child.write(encodeTaskFrame({ type: 'generated', version: 1, response })));
    await bounded(input.child.closeInput());
    const last = await reader.next(binding.deadlineMs, controller.signal);
    if (!object(last) || !exact(last, ['type', 'version', 'result']) || last.type !== 'result' || last.version !== 1 || !object(last.result)) throw new TaskParentError('invalid_child');
    const result = last.result;
    if (!exact(result, ['runtimeId', 'binding', 'text', 'inputTokens', 'outputTokens']) || !sameBinding(result.binding, binding)
      || typeof result.runtimeId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.runtimeId)
      || result.runtimeId === binding.avatarId || result.runtimeId === binding.attemptId
      || result.text !== response.text || result.inputTokens !== response.inputTokens || result.outputTokens !== response.outputTokens) throw new TaskParentError('invalid_child');
    // A child must finish its stream, not keep emitting or wait indefinitely after success.
    try { await reader.next(binding.deadlineMs, controller.signal); throw new TaskParentError('invalid_child'); }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'input_closed') throw error; }
    const exit = await bounded(input.child.exited); await bounded(stderr);
    if (exit !== 0 || overflow || controller.signal.aborted) throw new TaskParentError('invalid_child');
    // Termination can cross a deadline or a task revocation. Confirm only after cleanup.
    await cleanup();
    if (controller.signal.aborted || Date.now() >= binding.deadlineMs) throw new TaskParentError('expired');
    let confirmed: IsolatedTaskProxyResponse;
    try { confirmed = approvedResponse(await bounded(confirm(request, controller.signal)), binding); }
    catch { throw new TaskParentError(controller.signal.aborted ? 'expired' : 'proxy_refused'); }
    if (!sameResponse(response, confirmed) || Date.now() >= binding.deadlineMs) throw new TaskParentError('proxy_refused');
    return Object.freeze({ runtimeId: result.runtimeId, binding, text: confirmed.text,
      inputTokens: confirmed.inputTokens, outputTokens: confirmed.outputTokens, stderrBytes });
  } catch (error) {
    if (overflow) throw new TaskParentError('invalid_child');
    if (error instanceof TaskParentError) throw error;
    throw new TaskParentError(controller.signal.aborted ? 'expired' : 'invalid_child');
  } finally {
    try { await cleanup(); }
    finally { if (timer) clearTimeout(timer); input.signal?.removeEventListener('abort', abort); controller.abort(); }
  }
}
