import { AgentRuntime, InMemoryDatabaseAdapter, ModelType, createCharacter, type Plugin } from '@elizaos/core';
import { randomUUID } from 'node:crypto';
import { ISOLATED_TASK_MAX_OUTPUT_BYTES, ISOLATED_TASK_SYSTEM, IsolatedTaskError, validateIsolatedTaskConfig } from './profile';
import type { IsolatedTaskBinding, IsolatedTaskProxyResponse, IsolatedTaskRuntimeConfig } from './types';

const PROVIDER_NAME = 'clawville-isolated-task-proxy';
export interface IsolatedTaskInventory {
  readonly runtimeId: string;
  readonly adapter: 'core-in-memory';
  readonly plugins: readonly string[];
  readonly modelTypes: readonly string[];
  readonly actions: number;
  readonly providers: number;
  readonly evaluators: number;
  readonly services: number;
  readonly routes: number;
}
export interface IsolatedTaskResult {
  readonly runtimeId: string;
  readonly binding: Readonly<IsolatedTaskBinding>;
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Capability restriction only. An OS sandbox must supply process isolation. */
export class IsolatedTaskRuntime {
  readonly runtimeId = randomUUID();
  private readonly approved: ReturnType<typeof validateIsolatedTaskConfig>;
  private runtime: AgentRuntime | null = null;
  private adapter: InMemoryDatabaseAdapter | null = null;
  private controller = new AbortController();
  private executed = false;
  private dispatched = false;
  private stopped = false;
  private inventory: IsolatedTaskInventory | null = null;
  private response: IsolatedTaskProxyResponse | null = null;

  constructor(config: IsolatedTaskRuntimeConfig) { this.approved = validateIsolatedTaskConfig(config); }

  getInventory(): IsolatedTaskInventory | null { return this.inventory; }

  private assertLive(): void {
    if (this.stopped || this.controller.signal.aborted) throw new IsolatedTaskError('stopped');
    if (Date.now() >= this.approved.binding.deadlineMs) throw new IsolatedTaskError('expired');
  }

  private assertInventory(runtime: AgentRuntime): void {
    const plugins = runtime.plugins.map((plugin) => plugin.name).sort();
    const models = [...runtime.models.entries()];
    if (!(runtime.adapter instanceof InMemoryDatabaseAdapter)
      || runtime.actions.length || runtime.providers.length || runtime.evaluators.length
      || runtime.services.size || runtime.routes.length || runtime.enableAutonomy
      || plugins.length !== 2 || !plugins.includes('bootstrap') || !plugins.includes(PROVIDER_NAME)
      || models.length !== 1 || models[0]?.[0] !== ModelType.TEXT_SMALL || models[0]?.[1].length !== 1
      || runtime.character.plugins?.length || runtime.character.advancedMemory || runtime.character.advancedPlanning
      || Object.keys(runtime.character.secrets ?? {}).length) throw new IsolatedTaskError('invalid_capabilities');
    this.inventory = Object.freeze({ runtimeId: this.runtimeId, adapter: 'core-in-memory',
      plugins: Object.freeze(plugins), modelTypes: Object.freeze(models.map(([name]) => name)),
      actions: runtime.actions.length, providers: runtime.providers.length, evaluators: runtime.evaluators.length,
      services: runtime.services.size, routes: runtime.routes.length });
  }

  private plugin(): Plugin {
    return {
      name: PROVIDER_NAME, description: 'One reserved task generation; no fallback or retry.',
      models: {
        [ModelType.TEXT_SMALL]: async (_runtime, params: { prompt: string; maxTokens?: number }) => {
          this.assertLive();
          if (!this.inventory || _runtime !== this.runtime) throw new IsolatedTaskError('invalid_capabilities');
          if (this.dispatched || params.prompt !== this.approved.prompt
            || params.maxTokens !== this.approved.binding.maxOutputTokens) throw new IsolatedTaskError('invalid_configuration');
          this.dispatched = true;
          let response: IsolatedTaskProxyResponse;
          try {
            response = await this.approved.proxy.generate(Object.freeze({ binding: this.approved.binding, prompt: this.approved.prompt }), this.controller.signal);
          } catch { throw new IsolatedTaskError('proxy_failed'); }
          this.assertLive();
          const binding = this.approved.binding;
          if (!response || response.callId !== binding.callId || response.model !== binding.model || response.promptHash !== binding.promptHash
            || typeof response.text !== 'string' || !response.text.trim()
            || Buffer.byteLength(response.text, 'utf8') > ISOLATED_TASK_MAX_OUTPUT_BYTES
            || !Number.isSafeInteger(response.inputTokens) || response.inputTokens < 0 || response.inputTokens > binding.maxInputTokens
            || !Number.isSafeInteger(response.outputTokens) || response.outputTokens < 1 || response.outputTokens > binding.maxOutputTokens) {
            throw new IsolatedTaskError('invalid_result');
          }
          this.response = { callId: response.callId, model: response.model, promptHash: response.promptHash,
            text: response.text, inputTokens: response.inputTokens, outputTokens: response.outputTokens };
          return response.text;
        },
      },
    };
  }

  /** Single-flight guard runs before initialization or any asynchronous operation. */
  async execute(): Promise<IsolatedTaskResult> {
    if (this.executed) throw new IsolatedTaskError('already_executed');
    this.executed = true;
    this.assertLive();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { this.controller.abort(); reject(new IsolatedTaskError('expired')); }, this.approved.binding.deadlineMs - Date.now());
    });
    try {
      const character = createCharacter({ id: this.runtimeId, name: 'Restricted task text worker', system: ISOLATED_TASK_SYSTEM,
        bio: [], knowledge: [], plugins: [], messageExamples: [], postExamples: [], topics: [], adjectives: [],
        advancedMemory: false, advancedPlanning: false, settings: {}, secrets: {}, style: { all: [], chat: [], post: [] } });
      this.adapter = new InMemoryDatabaseAdapter();
      const runtime = new AgentRuntime({ agentId: this.runtimeId, character, adapter: this.adapter, plugins: [this.plugin()],
        disableBasicCapabilities: true, enableExtendedCapabilities: false, enableAutonomy: false, actionPlanning: false,
        llmMode: 'DEFAULT', logLevel: 'error',
        fetch: (async () => { throw new IsolatedTaskError('invalid_capabilities'); }) as unknown as typeof fetch });
      this.runtime = runtime;
      await Promise.race([runtime.initialize({ skipMigrations: true }), timeout]);
      this.assertLive(); this.assertInventory(runtime);
      const text = await Promise.race([runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: this.approved.prompt, maxTokens: this.approved.binding.maxOutputTokens, stopSequences: [], stream: false,
      }), timeout]);
      this.assertLive();
      const response = this.response;
      if (!response || text !== response.text) throw new IsolatedTaskError('invalid_result');
      return Object.freeze({ runtimeId: this.runtimeId, binding: this.approved.binding,
        text: response.text, inputTokens: response.inputTokens, outputTokens: response.outputTokens });
    } catch (error) {
      if (error instanceof IsolatedTaskError) throw error;
      throw new IsolatedTaskError('proxy_failed');
    } finally {
      if (timer) clearTimeout(timer);
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true; this.controller.abort();
    const runtime = this.runtime; const adapter = this.adapter;
    this.runtime = null; this.adapter = null; this.response = null;
    try { if (runtime) await runtime.stop(); }
    finally { if (adapter) await adapter.close(); }
  }
}
