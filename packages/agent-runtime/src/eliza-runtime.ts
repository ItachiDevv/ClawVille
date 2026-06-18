/**
 * ElizaOS Runtime Wrapper for ClawVille
 * Adapted from eliza-kiz for location-based agents.
 */

import {
  AgentRuntime as ElizaAgentRuntime,
  ChannelType,
  createCharacter,
  type Character,
  type CharacterInput,
  type Plugin,
  type UUID,
  type Memory,
  type Content,
  type IAgentRuntime,
} from '@elizaos/core';
import { v5 as uuidv5 } from 'uuid';
import type { LocationTemplate } from '@clawville/agent-templates';
import { loadLocationTemplate } from './character-loader';
import { createOpenClawProviderPlugin, type OpenClawGatewayConfig } from './plugins/openclaw-provider';
import { createOpenAIEmbeddingPlugin } from './plugins/openai-embedding-provider';
import { createOpenAITextPlugin } from './plugins/openai-text-provider';
import { clawvillePlugin } from './plugins/clawville-plugin';
import type { Provider, ProviderResult } from './providers/types';
import type { Action, ActionResult, ClawvilleActionState } from './actions/types';

const ROOM_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

class InitMutex {
  private queue: (() => void)[] = [];
  private locked = false;
  private releaseDelay = 2000;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    setTimeout(() => {
      if (this.queue.length > 0) {
        const next = this.queue.shift()!;
        next();
      } else {
        this.locked = false;
      }
    }, this.releaseDelay);
  }
}

const initMutex = new InitMutex();

function generateRoomId(agentId: string, userId: string): UUID {
  return uuidv5(`${agentId}-${userId}`, ROOM_NAMESPACE) as UUID;
}

export interface ElizaRuntimeConfig {
  agentId: string;
  agentType: 'location-agent' | 'avatar-agent' | string;
  /**
   * Escape hatch for callers that want to supply a fully-built Character
   * directly (e.g. SimulationRuntime, CollaborationBroker internals).
   * When set, skips template loading and customization merging entirely.
   */
  character?: Character;
  customization?: {
    name?: string;
    personality?: string;
    bio?: string | string[];
    greeting?: string;
    rules?: string[];
    tone?: string;
    topics?: string[];
    adjectives?: string[];
    style?: string[] | { all: string[]; chat: string[]; post: string[] };
    lore?: string[];
    knowledge?: string[];
    messageExamples?: Array<{ user: string; content: string }[]>;
    system?: string;
  };
  agentConfig: Record<string, unknown>;
  openclawGateway?: OpenClawGatewayConfig;
  databaseUrl?: string;
  apiKeys?: {
    /** OpenAI API key — the sole backend for TEXT_SMALL/TEXT_LARGE generation and embeddings. */
    openai?: string;
  };
  onMessage?: (message: ElizaMessage) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}

export interface ElizaMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export type ElizaRuntimeState = 'idle' | 'initializing' | 'running' | 'paused' | 'stopped' | 'error';

function convertToElizaCharacter(
  template: LocationTemplate,
  config: ElizaRuntimeConfig
): Character {
  const { customization } = config;
  const name = customization?.name || template.name;

  const bio = customization?.bio || template.bio.join('\n');

  let system = `You are ${name}. ${template.description || ''}`;
  if (customization?.personality) {
    system += `\n\nPersonality: ${customization.personality}`;
  }
  if (customization?.greeting) {
    system += `\n\nWhen someone enters, greet them: "${customization.greeting}"`;
  }
  if (customization?.rules?.length) {
    system += `\n\nRules:\n${customization.rules.map((r) => `- ${r}`).join('\n')}`;
  }
  if (customization?.tone) {
    system += `\n\nTone: ${customization.tone}`;
  }

  // v2: legacy MessageExample[][] format is still accepted by createCharacter()
  const messageExamples = template.messageExamples?.map((conversation: any) =>
    conversation.map((msg: any) => ({
      name: msg.user.startsWith('{{') ? 'User' : msg.user,
      content: {
        text: typeof msg.content === 'string' ? msg.content : msg.content.text || '',
      },
    }))
  );

  // v2: @elizaos/plugin-bootstrap is built into @elizaos/core — do NOT add it here.
  // Embeddings are provided by our custom openai-embedding-provider (prepended
  // in loadPlugins), so plugin-openai is no longer needed. Text generation is
  // handled by the OpenAI text provider (priority 95). plugin-anthropic and
  // the ultrathink-provider have both been removed — OpenAI is the single
  // backend for all non-OpenClaw agents (both text-gen and embeddings).
  const plugins: string[] = [
    '@elizaos/plugin-sql',
  ];

  const input: CharacterInput & { name: string } = {
    name,
    username: name.toLowerCase().replace(/\s+/g, '-'),
    system,
    // v2 Character uses bio: string[] — split multi-line strings, or wrap single string
    // Merge knowledge into bio — ElizaOS v2 treats knowledge[] strings as file paths
    bio: [
      ...(typeof bio === 'string' ? [bio] : bio),
      ...(template.knowledge || []),
    ],
    messageExamples: messageExamples as any,
    postExamples: [],
    topics: customization?.topics || template.topics || [],
    adjectives: template.adjectives || [],
    knowledge: [],
    plugins,
    settings: {
      ...(template.settings || {}),
    } as any,
    style: {
      all: [...(template.style?.all || []), ...(Array.isArray(customization?.style) ? customization.style : [])],
      chat: template.style?.chat || [],
      post: template.style?.post || [],
    },
  };

  // createCharacter() converts loose CharacterInput to the strict protobuf Character
  return createCharacter(input);
}

export class ElizaRuntime {
  private config: ElizaRuntimeConfig;
  private runtime: ElizaAgentRuntime | null = null;
  private state: ElizaRuntimeState = 'idle';
  private character: Character;
  private loadedPlugins: Plugin[] = [];
  private lightweightMode = false;

  constructor(config: ElizaRuntimeConfig) {
    this.config = config;

    if (config.agentType === 'openclaw-bot') {
      // OpenClaw bots reuse avatar character builder with gateway-specific defaults
      this.character = this.buildAvatarCharacter(config);
    } else if (config.agentType === 'avatar-agent') {
      // Avatar agents use customization directly, no template
      this.character = this.buildAvatarCharacter(config);
    } else if (config.character) {
      // Caller provided a pre-built character (escape hatch for simulation
      // runtime, collaboration broker, etc.) — skip template loading entirely
      this.character = config.character;
    } else {
      // Location agents load from templates
      const locationId = (config.agentConfig?.locationId as string) || 'cron-automation';
      const template = loadLocationTemplate(locationId);
      this.character = convertToElizaCharacter(template, config);
    }
  }

  private buildAvatarCharacter(config: ElizaRuntimeConfig): Character {
    const { customization } = config;
    const name = customization?.name || 'Avatar';
    const species = (config.agentConfig?.species as string) || 'creature';

    // Support both string and string[] bio from archetype data
    const bioRaw = customization?.bio;
    const bio = Array.isArray(bioRaw) ? bioRaw.join('\n') : (bioRaw || `A friendly ${species} companion.`);

    // Use pre-built system prompt from archetype, or construct a basic one
    let system = customization?.system ||
      `You are ${name}, a ${species} avatar in the world of ClawVille. You are a virtual companion who loves to chat with your owner.`;
    if (!customization?.system) {
      if (customization?.personality) {
        system += `\n\nPersonality: ${customization.personality}`;
      }
      if (customization?.greeting) {
        system += `\n\nWhen greeting your owner, say something like: "${customization.greeting}"`;
      }
      if (customization?.rules?.length) {
        system += `\n\nRules to follow:\n${customization.rules.map((r) => `- ${r}`).join('\n')}`;
      }
      if (customization?.tone) {
        system += `\n\nCommunication tone: ${customization.tone}`;
      }
    }

    // Convert messageExamples from {user, content}[] to ElizaOS format
    const messageExamples = customization?.messageExamples?.map((conversation: any) =>
      conversation.map((msg: any) => ({
        name: msg.user === 'assistant' ? name : 'User',
        content: {
          text: msg.content,
        },
      }))
    );

    // v2: plugin-bootstrap is built into core. plugin-openai is replaced by
    // the OpenAI embedding provider (embeddings). plugin-solana is a legacy dep
    // that was never installed — omit to stop the silent import-error spam.
    // plugin-anthropic has been removed; the OpenAI text provider (priority 95)
    // is the default text-generation backend, and the OpenAI embedding provider
    // handles embeddings — OpenAI is the single backend for both.
    const plugins: string[] = [
      '@elizaos/plugin-sql',
    ];

    // Support structured style object from archetype data
    const styleRaw = customization?.style;
    const style = styleRaw && !Array.isArray(styleRaw)
      ? { all: styleRaw.all, chat: styleRaw.chat, post: styleRaw.post }
      : {
          all: (Array.isArray(styleRaw) ? styleRaw : null) || ['Be friendly and engaging', 'Use playful language'],
          chat: [] as string[],
          post: [] as string[],
        };

    const input: CharacterInput & { name: string } = {
      name,
      username: name.toLowerCase().replace(/\s+/g, '-'),
      system,
      // v2 Character uses bio: string[]
      bio: typeof bio === 'string' ? [bio] : bio,
      messageExamples: (messageExamples || []) as any,
      postExamples: [],
      topics: customization?.topics || ['avatars', 'games', 'adventures'],
      adjectives: customization?.adjectives || ['friendly', 'playful', 'curious'],
      knowledge: customization?.knowledge || [],
      plugins,
      settings: {
        // Inert: text-model selection is by plugin PRIORITY (OpenClaw 100 > openai-text 95),
        // NOT this field. Kept accurate after the Anthropic + Gemini scrubs.
        model: 'gpt-4o-mini',
      } as any,
      style,
    };

    // createCharacter() converts loose CharacterInput to the strict protobuf Character
    return createCharacter(input);
  }

  async start(): Promise<void> {
    if (this.state === 'running') return;
    this.state = 'initializing';

    await initMutex.acquire();
    console.log(`[ElizaRuntime] Agent ${this.config.agentId} acquired init mutex`);

    try {
      if (this.config.apiKeys?.openai && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = this.config.apiKeys.openai;
      }
      if (!process.env.PROVIDERS_TOTAL_TIMEOUT_MS) {
        process.env.PROVIDERS_TOTAL_TIMEOUT_MS = '60000';
      }

      await this.loadPlugins();

      // The OpenAI text + embedding plugins read their API key from their own
      // config or process.env directly — not character.secrets — so we don't
      // need to stamp anything onto the character. Anthropic is fully removed.

      // v2: Caller owns DB adapter lifecycle. createDatabaseAdapter() handles
      // pool singletons internally (shared across all agents via global symbol),
      // so we must NOT call adapter.close() on per-agent stop().
      const sqlMod: any = await import('@elizaos/plugin-sql');
      const createDatabaseAdapter = sqlMod.createDatabaseAdapter || sqlMod.default?.createDatabaseAdapter;
      if (typeof createDatabaseAdapter !== 'function') {
        throw new Error('[ElizaRuntime] @elizaos/plugin-sql did not export createDatabaseAdapter');
      }
      const adapter = createDatabaseAdapter(
        { postgresUrl: this.config.databaseUrl || process.env.DATABASE_URL || '' },
        this.config.agentId as UUID
      );

      this.runtime = new ElizaAgentRuntime({
        agentId: this.config.agentId as UUID,
        character: this.character,
        plugins: this.loadedPlugins,
        adapter,
        // v2: For game agents, single-action-per-response is the recommended path
        // per source comment — "performance optimization useful for game situations
        // where state updates with every action"
        actionPlanning: false,
      } as any);

      await this.runtime.initialize();
      this.state = 'running';
      console.log(`[ElizaRuntime] Agent ${this.config.agentId} started`);
    } catch (error) {
      this.state = 'error';
      console.error(`[ElizaRuntime] Failed to start agent:`, error);
      this.config.onError?.(error as Error);
      throw error;
    } finally {
      initMutex.release();
    }
  }

  private async loadPlugins(): Promise<void> {
    this.loadedPlugins = [];
    // v2: plugin-bootstrap is built into @elizaos/core.
    // plugin-openai replaced by openai-embedding-provider below (embeddings).
    // plugin-solana is a legacy dep that was never installed — removed.
    // plugin-anthropic + ultrathink-provider removed. Both text generation AND
    // embeddings go through OpenAI — the sole non-OpenClaw backend.
    // Text generation priority chain: OpenClaw(100) > OpenAI(95).
    const pluginMap: Record<string, string> = {
      '@elizaos/plugin-sql': 'sqlPlugin',
    };

    for (const pluginName of this.character.plugins || []) {
      if (!(pluginName in pluginMap)) continue;
      try {
        const mod: any = await import(pluginName);
        const exportName = pluginMap[pluginName];
        const plugin = mod.default || mod[exportName] || mod;
        if (plugin) {
          this.loadedPlugins.push(plugin as Plugin);
          console.log(`[ElizaRuntime] Loaded plugin: ${pluginName}`);
        }
      } catch (error) {
        console.error(`[ElizaRuntime] Failed to load plugin ${pluginName}:`, error);
      }
    }

    // Prepend OpenAI embedding provider (priority 100 — replaces plugin-openai's TEXT_EMBEDDING)
    // Emits 1536-dim vectors (text-embedding-3-small); the openai key is already
    // in config.apiKeys from the text swap. Must match embed-text.ts's 1536 dim.
    const openaiEmbeddingPlugin = createOpenAIEmbeddingPlugin({
      apiKey: this.config.apiKeys?.openai,
    });
    this.loadedPlugins.unshift(openaiEmbeddingPlugin as Plugin);
    console.log(`[ElizaRuntime] Loaded OpenAI embedding provider (text-embedding-3-small, 1536-dim)`);

    // Prepend OpenAI text provider (priority 95 — global default for TEXT_SMALL/TEXT_LARGE)
    // Sits immediately below OpenClaw gateway (100) in the priority chain.
    // Embeddings (above) also go through OpenAI — it is the sole non-OpenClaw backend.
    const openaiTextPlugin = createOpenAITextPlugin({
      apiKey: this.config.apiKeys?.openai,
    });
    this.loadedPlugins.unshift(openaiTextPlugin as Plugin);
    console.log(`[ElizaRuntime] Loaded OpenAI text provider (gpt-4o-mini/gpt-4o, priority 95)`);

    // Prepend OpenClaw provider plugin so it wins TEXT_GENERATION priority (priority 100 > 95)
    if (this.config.openclawGateway) {
      const openclawPlugin = createOpenClawProviderPlugin(this.config.openclawGateway);
      this.loadedPlugins.unshift(openclawPlugin as Plugin);
      console.log(`[ElizaRuntime] Loaded OpenClaw provider plugin (gateway: ${this.config.openclawGateway.gatewayUrl})`);
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    if (this.runtime) await this.runtime.stop();
    this.state = 'stopped';
  }

  async pause(): Promise<void> {
    if (this.state !== 'running') return;
    this.state = 'paused';
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') return;
    this.state = 'running';
  }

  getState(): ElizaRuntimeState {
    return this.state;
  }

  /** Access the underlying ElizaOS AgentRuntime for direct API calls
   *  (e.g., createMemory for Phase 2 knowledge embedding). */
  getElizaRuntime(): IAgentRuntime | null {
    return this.runtime;
  }

  private async ensureWorld(): Promise<UUID> {
    if (!this.runtime) throw new Error('Runtime not initialized');
    const worldId = this.config.agentId as UUID;
    try {
      await this.runtime.ensureWorldExists({
        id: worldId,
        name: `agent-${this.config.agentId}`,
        agentId: worldId,
      });
    } catch (error) {
      console.log(`[ElizaRuntime] World setup note:`, (error as Error).message);
    }
    return worldId;
  }

  private async ensureRoom(roomId: UUID, userId: string, worldId: UUID): Promise<void> {
    if (!this.runtime) return;
    try {
      const existingRoom = await this.runtime.getRoom(roomId);
      if (!existingRoom) {
        await this.runtime.createRoom({
          id: roomId,
          name: `chat-${userId}`,
          source: 'api',
          type: ChannelType.API,
          channelId: roomId,
          worldId,
        });
      }
    } catch (error) {
      const errMsg = (error as Error).message || '';
      if (!errMsg.includes('duplicate') && !errMsg.includes('already exists') && !errMsg.includes('unique constraint')) {
        throw error;
      }
    }
  }

  private async ensureEntity(entityId: UUID, agentId: UUID): Promise<void> {
    if (!this.runtime) return;
    try {
      const existing = await this.runtime.getEntityById(entityId);
      if (!existing) {
        await this.runtime.createEntity({
          id: entityId,
          agentId,
          names: ['user'],
          metadata: { source: 'api' },
        });
      }
    } catch (error) {
      const errMsg = (error as Error).message || '';
      if (!errMsg.includes('duplicate') && !errMsg.includes('already exists') && !errMsg.includes('unique constraint')) {
        throw error;
      }
    }
  }

  private async getConversationHistory(roomId: UUID, limit = 20): Promise<Memory[]> {
    if (!this.runtime) return [];
    try {
      // v2: `count` is deprecated in favor of `limit` on getMemories params
      const memories = await this.runtime.getMemories({ roomId, limit, tableName: 'messages' } as any);
      return memories.sort((a, b) => {
        const aTime = typeof a.createdAt === 'number' ? a.createdAt : Date.parse(String(a.createdAt || 0));
        const bTime = typeof b.createdAt === 'number' ? b.createdAt : Date.parse(String(b.createdAt || 0));
        return aTime - bTime;
      });
    } catch {
      return [];
    }
  }

  private buildConversationContext(memories: Memory[], agentId: UUID): string {
    if (memories.length === 0) return '';
    const agentName = this.character.name || 'Assistant';
    const lines: string[] = [];
    for (const memory of memories) {
      const text = memory.content?.text;
      if (!text) continue;
      const role = memory.entityId === agentId ? agentName : 'User';
      lines.push(`${role}: ${text}`);
    }
    if (lines.length === 0) return '';
    return `\n\nPrevious conversation:\n${lines.join('\n')}\n\n`;
  }

  // ---------------------------------------------------------------------------
  // Provider + Action integration
  // ---------------------------------------------------------------------------

  /**
   * Run all registered Providers to build context for the prompt.
   * Each provider contributes a text slice; they're concatenated in
   * position order (lower position = earlier in the prompt).
   */
  private async runProviders(state: Record<string, any>, userMessage?: string): Promise<string> {
    const providers = clawvillePlugin.providers as Provider[];
    const results: { position: number; text: string }[] = [];

    // Inject userMessage into state so KnowledgeProvider can embed it
    // for vector similarity search (Phase 2 RAG)
    if (userMessage) {
      state.userMessage = userMessage;
    }

    const message = userMessage ? { content: { text: userMessage } } : null;

    for (const provider of providers) {
      try {
        const result: ProviderResult = await provider.get(this.runtime, message, state);
        if (result.text && result.text.trim().length > 0) {
          results.push({ position: provider.position ?? 999, text: result.text });
        }
      } catch (err) {
        console.warn(`[ElizaRuntime] Provider ${provider.name} failed:`, err);
      }
    }

    results.sort((a, b) => a.position - b.position);
    return results.map((r) => r.text).join('\n');
  }

  /**
   * Build a description block of available actions for the system prompt
   * so the LLM knows what it can invoke.
   */
  private buildActionDescriptions(state: Record<string, any>): string {
    const actions = clawvillePlugin.actions as Action[];
    if (actions.length === 0) return '';

    const lines = actions.map((a) => {
      const params = a.parameters?.map((p) => `${p.name}: ${p.description}`).join(', ') ?? 'none';
      return `- ${a.name}: ${a.description} (params: ${params})`;
    });

    return [
      '[Available Actions]',
      'You can execute game actions by including [ACTION: ACTION_NAME(param=value)] in your response.',
      'Only use an action when the user clearly requests it. Most messages just need a normal conversational reply.',
      ...lines,
    ].join('\n');
  }

  /**
   * Parse ALL action invocations from the LLM response matching the pattern:
   *   [ACTION: ACTION_NAME(param1=value1, param2=value2)]
   * Returns an array of parsed invocations (empty if none found).
   * Handles: multiple actions, params with `=` in values, missing params,
   * and malformed tags (skipped with a warning).
   */
  private parseActionInvocations(text: string): Array<{ actionName: string; params: Record<string, string> }> {
    const results: Array<{ actionName: string; params: Record<string, string> }> = [];
    const regex = /\[ACTION:\s*(\w+)\(([^)]*)\)\]/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const actionName = match[1];
      const paramStr = match[2].trim();
      const params: Record<string, string> = {};

      if (paramStr.length > 0) {
        for (const part of paramStr.split(',')) {
          const eqIndex = part.indexOf('=');
          if (eqIndex > 0) {
            const key = part.slice(0, eqIndex).trim();
            const value = part.slice(eqIndex + 1).trim();
            if (key.length > 0) {
              params[key] = value;
            }
          } else {
            // Malformed param (no `=`): treat the whole part as a flag
            const flag = part.trim();
            if (flag.length > 0) {
              console.warn(`[ElizaRuntime] Malformed action param "${flag}" in ${actionName} — treating as flag`);
              params[flag] = 'true';
            }
          }
        }
      }

      results.push({ actionName, params });
    }

    return results;
  }

  /**
   * Execute a parsed action invocation against the registered actions.
   */
  private async executeAction(
    actionName: string,
    params: Record<string, string>,
    state: Record<string, any>,
  ): Promise<ActionResult | null> {
    const actions = clawvillePlugin.actions as Action[];
    const action = actions.find((a) => a.name === actionName);
    if (!action) {
      console.warn(`[ElizaRuntime] Unknown action: ${actionName}`);
      return null;
    }

    try {
      const message = { content: { text: '', parameters: params, data: { parameters: params } }, parameters: params, ...params };

      // Validate the action before executing — prevents LLM from triggering
      // actions that don't pass the keyword/context check
      try {
        const isValid = await action.validate(this.runtime, message, state);
        if (!isValid) {
          console.warn(`[ElizaRuntime] Action ${actionName} failed validation — skipping`);
          return null;
        }
      } catch {
        // validate() failure is non-blocking — proceed with handler
      }

      const options = { parameters: params };
      const result = await action.handler(this.runtime, message, state, options);
      console.log(`[ElizaRuntime] Action ${actionName} result: success=${result.success}`);
      return result;
    } catch (err) {
      console.error(`[ElizaRuntime] Action ${actionName} failed:`, err);
      return { success: false, text: `Action failed: ${(err as Error).message}` };
    }
  }

  // ---------------------------------------------------------------------------
  // processMessage — enhanced with Providers + Actions
  // ---------------------------------------------------------------------------

  async processMessage(
    content: string,
    context: {
      userId?: string;
      roomId?: string;
      platform?: string;
      /** @deprecated Use `state` + Providers instead. Still supported for backward compat. */
      dynamicContext?: string;
      /** State object for Providers and Actions (avatarData, worldSnapshot, services, etc.) */
      state?: Record<string, any>;
    } = {}
  ): Promise<ElizaMessage> {
    if (this.state !== 'running' || !this.runtime) {
      throw new Error(`Agent is not running (state: ${this.state})`);
    }

    try {
      const userKey = context.userId || 'anonymous';
      // Honor caller-supplied roomId ONLY when it's already a valid UUID. This
      // preserves backward compatibility with legacy call sites (avatar chat,
      // agent-gateway) that pass human-readable strings — those were always
      // ignored in favor of the internal (agentId, userId) derivation, and we
      // keep ignoring them here so existing memory rows remain reachable.
      // Phase 6 opts in by passing a proper UUID from `characterRoomId()`.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const roomId: UUID = context.roomId && UUID_RE.test(context.roomId)
        ? (context.roomId as UUID)
        : generateRoomId(this.config.agentId, userKey);
      const entityId = uuidv5(userKey, ROOM_NAMESPACE) as UUID;
      const agentId = this.config.agentId as UUID;

      const worldId = await this.ensureWorld();
      await this.ensureRoom(roomId, context.userId || 'anonymous', worldId);
      await this.ensureEntity(entityId, agentId);

      const history = await this.getConversationHistory(roomId, 20);
      const historyContext = this.buildConversationContext(history, agentId);

      // Store user message
      const userMemoryId = crypto.randomUUID() as UUID;
      await this.runtime.createMemory(
        {
          id: userMemoryId,
          agentId,
          entityId,
          roomId,
          content: { text: content, source: context.platform || 'api' } as Content,
          createdAt: Date.now(),
          metadata: { type: 'message', source: context.platform || 'api' },
        },
        'messages'
      );

      // --- Build prompt ---
      const promptParts: string[] = [];

      // 1. Provider-generated context (replaces manual dynamicContext)
      const providerState = context.state ?? {};
      const providerContext = await this.runProviders(providerState, content);
      if (providerContext.length > 0) {
        promptParts.push(`[Current state context]\n${providerContext}`);
      }

      // 2. Backward compat: if dynamicContext is still passed directly, append it
      if (context.dynamicContext) {
        promptParts.push(context.dynamicContext);
      }

      // 3. Available actions (only if state has services — i.e., actions are executable)
      if (providerState.services) {
        const actionDescriptions = this.buildActionDescriptions(providerState);
        if (actionDescriptions.length > 0) {
          promptParts.push(actionDescriptions);
        }
      }

      // 4. Conversation history
      if (historyContext) {
        promptParts.push(historyContext.trim());
      }

      // 5. User message
      promptParts.push(`User: ${content}\n\nRespond to the user's latest message.`);

      const promptWithHistory = promptParts.join('\n\n');

      // --- Generate LLM response ---
      const result = await this.runtime.generateText(promptWithHistory, {
        maxTokens: 1000,
        stopSequences: [],
      });

      let responseText = result.text;
      const actionsExecuted: Array<{ name: string; result: ActionResult }> = [];

      // --- Action dispatch ---
      // Parse ALL [ACTION: ...] tags from the LLM response and execute sequentially
      if (providerState.services) {
        const invocations = this.parseActionInvocations(responseText);

        for (const invocation of invocations) {
          const actionResult = await this.executeAction(
            invocation.actionName,
            invocation.params,
            providerState,
          );

          if (actionResult) {
            actionsExecuted.push({ name: invocation.actionName, result: actionResult });
          }
        }

        if (actionsExecuted.length > 0) {
          // Strip ALL action tags from the response text
          responseText = responseText.replace(/\[ACTION:\s*\w+\([^)]*\)\]/g, '').trim();

          // Append all action results
          const actionTexts = actionsExecuted
            .map((a) => a.result.text)
            .filter(Boolean);
          if (actionTexts.length > 0) {
            responseText = responseText
              ? `${responseText}\n\n${actionTexts.join('\n\n')}`
              : actionTexts.join('\n\n');
          }
        }
      }

      const actionExecuted = actionsExecuted.length > 0
        ? actionsExecuted[actionsExecuted.length - 1]
        : undefined;

      // Store assistant response
      const assistantMemoryId = crypto.randomUUID() as UUID;
      await this.runtime.createMemory(
        {
          id: assistantMemoryId,
          agentId,
          entityId: agentId,
          roomId,
          content: { text: responseText, source: 'agent' } as Content,
          createdAt: Date.now(),
          metadata: {
            type: 'message',
            source: 'agent',
            ...(actionExecuted ? { action: actionExecuted.name, actionSuccess: actionExecuted.result.success } : {}),
          },
        },
        'messages'
      );

      const responseMessage: ElizaMessage = {
        role: 'assistant',
        content: responseText,
        timestamp: new Date(),
        metadata: {
          agentId: this.config.agentId,
          memoryId: assistantMemoryId,
          ...(actionExecuted ? { action: actionExecuted.name, actionResult: actionExecuted.result } : {}),
        },
      };

      this.config.onMessage?.(responseMessage);
      return responseMessage;
    } catch (error) {
      console.error(`[ElizaRuntime] Error processing message:`, error);
      this.config.onError?.(error as Error);
      throw error;
    }
  }

  getCharacter(): Character {
    return this.character;
  }
}

export function createElizaRuntime(config: ElizaRuntimeConfig): ElizaRuntime {
  return new ElizaRuntime(config);
}
