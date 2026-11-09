import { randomUUID } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';

export type ProbeEmbeddingSource = 'protocol' | 'brainchain' | 'query' | 'memory';
export interface TrustedProbeRuntimeScope {
  readonly runId: string;
  readonly manifestHash: string;
  readonly platformAgentId: string;
  readonly runtimeAgentId: string;
  readonly deadlineMs: number;
  readonly runtimeStart?: number;
  readonly gatewayUrl: string;
  readonly embeddings: {
    embedExact(input: { requestId: string; source: ProbeEmbeddingSource; text: string; signal: AbortSignal }): Promise<{ vector: readonly number[]; callId: string; inputHash: string }>;
  };
  assertRuntimeCurrent(signal: AbortSignal): Promise<void>;
  failRun(): Promise<void>;
}

/** One instance owns its cancellation, logical request sequence and failure latch. */
export class ProbeRuntimeBoundary {
  private readonly abort = new AbortController();
  private failed = false;
  private intentionalStop = false;
  constructor(readonly scope: TrustedProbeRuntimeScope) {}
  stop(): void { if(!this.failed)this.intentionalStop = true; this.failed = true; this.abort.abort('probe_runtime_intentional_stop'); }
  failLocal(): void { this.failed = true; this.abort.abort('probe_runtime_failure'); }
  async bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = await this.current();
    let onAbort: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_, reject) => { onAbort = () => reject(new Error('probe_runtime_refused')); signal.addEventListener('abort', onAbort, { once: true }); });
      const value = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal); }), stopped]);
      if (signal.aborted) this.refuse();
      this.signal(); return value;
    } catch { return this.refuse(); }
    finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
  }
  refuse(): never {
    this.failed = true;
    this.abort.abort();
    throw new Error('probe_runtime_refused');
  }
  signal(): AbortSignal {
    if (this.failed || Date.now() >= this.scope.deadlineMs) return this.refuse();
    return AbortSignal.any([this.abort.signal, AbortSignal.timeout(Math.max(1, Math.min(30_000, this.scope.deadlineMs - Date.now())))]);
  }
  async current(): Promise<AbortSignal> {
    const signal = this.signal();
    try {
      await Promise.race([
        this.scope.assertRuntimeCurrent(signal),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('probe_runtime_refused')), { once: true })),
      ]);
      if (signal.aborted || this.failed || Date.now() >= this.scope.deadlineMs) this.refuse();
      return signal;
    } catch { return this.refuse(); }
  }
  async embed(text: string, source: ProbeEmbeddingSource, logicalKey?: string): Promise<number[]> {
    try {
    const signal = await this.current();
    if (source === 'protocol' && (!logicalKey || !this.scope.runtimeStart)) this.refuse();
    const requestId = logicalKey ? uuidv5(`${this.scope.runId}:${source}:${source === 'protocol' ? this.scope.runtimeStart : 'install'}:${logicalKey}`, 'ed7ab9ce-346d-48a3-b7e1-9a19e93e0f26') : randomUUID();
      const response = await Promise.race([
        this.scope.embeddings.embedExact({ requestId, source, text, signal }),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('probe_runtime_refused')), { once: true })),
      ]);
      if (signal.aborted || this.failed || Date.now() >= this.scope.deadlineMs || response.vector.length !== 1536 || !response.vector.every(Number.isFinite)) this.refuse();
      await this.current();
      return [...response.vector];
    } catch {
      this.failed=true;this.abort.abort();
      if(this.intentionalStop)return this.refuse();
      try { await this.scope.failRun(); } catch { throw new Error('probe_runtime_terminal_stop_unavailable'); }
      return this.refuse();
    }
  }
}

/** Install before initialize: registration checks precede every plugin init hook. */
export async function guardProbeCore(
  runtime: import('@elizaos/core').AgentRuntime,
  boundary: ProbeRuntimeBoundary,
  plugins: readonly import('@elizaos/core').Plugin[],
): Promise<void> {
  const { createBootstrapPlugin, ModelType } = await import('@elizaos/core');
  const bootstrap = createBootstrapPlugin();
  const snapshots = new Map<import('@elizaos/core').Plugin, import('@elizaos/core').Plugin>();
  for (const plugin of [...plugins, bootstrap]) {
    const handlers = Object.fromEntries(Object.entries(plugin.models ?? {}).map(([type, handler]) => [type, async (...args: Parameters<typeof handler>) => {
      await boundary.current();
      try { const value = await (handler as (runtime: import('@elizaos/core').IAgentRuntime, params: unknown) => Promise<unknown>)(args[0], args[1]); boundary.signal(); return value; }
      catch { return boundary.refuse(); }
    }]));
    snapshots.set(plugin, Object.freeze({ ...plugin, models: Object.freeze(handlers) }));
  }
  const permitted = new Set(snapshots.keys());
  const models = new Map<string, Set<unknown>>();
  for (const plugin of plugins.map(plugin => snapshots.get(plugin)!)) {
    for (const [type, handler] of Object.entries(plugin.models ?? {})) {
      if (!new Set<string>([ModelType.TEXT_SMALL, ModelType.TEXT_LARGE, ModelType.TEXT_EMBEDDING]).has(type)) boundary.refuse();
      const set = models.get(type) ?? new Set();
      set.add(handler); models.set(type, set);
    }
  }
  const observeServiceFailures = () => {
    const pending:unknown=Reflect.get(runtime,'servicePromises');
    if(pending instanceof Map)for(const promise of pending.values())if(promise instanceof Promise)void promise.catch(()=>{boundary.failLocal();});
  };
  const registerPlugin = runtime.registerPlugin.bind(runtime);
  const registerModel = runtime.registerModel.bind(runtime);
  const getModel = runtime.getModel.bind(runtime);
  const useModel = runtime.useModel.bind(runtime);
  let bootstrapRegistered = false;
  const assertInventory = () => {
    const installed: unknown = Reflect.get(runtime, 'models');
    if (!(installed instanceof Map)) return boundary.refuse();
    for (const [type, entries] of installed) {
      if (typeof type !== 'string' || !models.has(type) || !Array.isArray(entries)) return boundary.refuse();
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || !models.get(type)?.has((entry as {handler?:unknown}).handler)) return boundary.refuse();
      }
    }
    for (const type of models.keys()) if (!installed.has(type)) return boundary.refuse();
  };
  const initialize = runtime.initialize.bind(runtime);
  runtime.initialize = async options => {
    try { boundary.signal(); await initialize(options); assertInventory(); boundary.signal(); }
    catch { return boundary.refuse(); }
  };
  runtime.registerPlugin = async plugin => {
    boundary.signal();
    // Core creates its own equivalent bootstrap during initialize. The reviewed
    // bootstrap below already registered, so no second hook executes.
    if (plugin.name === 'bootstrap' && bootstrapRegistered && !permitted.has(plugin)) return;
    if (!permitted.has(plugin)) boundary.refuse();
    try { await registerPlugin(snapshots.get(plugin)!); boundary.signal(); }
    catch { return boundary.refuse(); }
    finally { observeServiceFailures(); }
  };
  runtime.registerModel = (type, handler, provider, priority) => {
    boundary.signal();
    if (!models.get(String(type))?.has(handler)) boundary.refuse();
    registerModel(type, handler, provider, priority);
  };
  runtime.getModel = type => {
    boundary.signal();
    const handler = getModel(type);
    if (!models.has(String(type)) || (handler && !models.get(String(type))?.has(handler))) boundary.refuse();
    return handler;
  };
  runtime.useModel = (async (type, params, provider) => {
    await boundary.current();
    if (!models.has(String(type))) boundary.refuse();
    return useModel(type, params, provider);
  }) as typeof runtime.useModel;
  Object.defineProperty(runtime, 'fetch', { value: () => boundary.refuse(), writable: false, configurable: false });
  await runtime.registerPlugin(bootstrap);
  bootstrapRegistered = true;
}

export const BRAINCHAIN_PROBE_CHAT_TEXT = 'Explain the BrainChain payment and cash-out limits, including parent funding, quote limits, refund holds and separate approval.';
export function brainchainProbeDirective(runId:string):string {return `brainchain-read-${runId}: inspect your BrainChain workers only. Do not install, sign or spend.`;}
