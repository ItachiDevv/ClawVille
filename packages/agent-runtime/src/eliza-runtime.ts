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
import { createUltrathinkProviderPlugin, type UltrathinkConfig } from './plugins/ultrathink-provider';
import { createGeminiEmbeddingPlugin } from './plugins/gemini-embedding-provider';
import { createGeminiTextPlugin } from './plugins/gemini-text-provider';
import { AGENT_THINKING_DEFAULTS } from '@clawville/shared';

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
  agentType: 'location-agent' | 'pet-agent' | string;
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
  thinkingConfig?: Partial<UltrathinkConfig>;
  databaseUrl?: string;
  apiKeys?: {
    anthropic?: string;
    /** Gemini API key for TEXT_EMBEDDING (replaces openai). */
    gemini?: string;
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
      name: msg.user === 'assistant' ? name : 'User',
      content: {
        text: typeof msg.content === 'string' ? msg.content : msg.content.text || '',
      },
    }))
  );

  // v2: @elizaos/plugin-bootstrap is built into @elizaos/core — do NOT add it here.
  // Embeddings are provided by our custom gemini-embedding-provider (prepended
  // in loadPlugins), so plugin-openai is no longer needed.
  const plugins: string[] = [
    '@elizaos/plugin-anthropic',
    '@elizaos/plugin-sql',
  ];

  const input: CharacterInput & { name: string } = {
    name,
    username: name.toLowerCase().replace(/\s+/g, '-'),
    system,
    // v2 Character uses bio: string[] — split multi-line strings, or wrap single string
    bio: typeof bio === 'string' ? [bio] : bio,
    messageExamples: messageExamples as any,
    postExamples: [],
    topics: customization?.topics || template.topics || [],
    adjectives: template.adjectives || [],
    knowledge: template.knowledge || [],
    plugins,
    settings: {
      ...(template.settings || {}),
      model: 'claude-3-5-haiku-20241022',
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
      // OpenClaw bots reuse pet character builder with gateway-specific defaults
      this.character = this.buildPetCharacter(config);
    } else if (config.agentType === 'pet-agent') {
      // Pet agents use customization directly, no template
      this.character = this.buildPetCharacter(config);
    } else {
      // Location agents load from templates
      const locationId = (config.agentConfig?.locationId as string) || 'cron-hub';
      const template = loadLocationTemplate(locationId);
      this.character = convertToElizaCharacter(template, config);
    }
  }

  private buildPetCharacter(config: ElizaRuntimeConfig): Character {
    const { customization } = config;
    const name = customization?.name || 'Pet';
    const species = (config.agentConfig?.species as string) || 'creature';

    // Support both string and string[] bio from archetype data
    const bioRaw = customization?.bio;
    const bio = Array.isArray(bioRaw) ? bioRaw.join('\n') : (bioRaw || `A friendly ${species} companion.`);

    // Use pre-built system prompt from archetype, or construct a basic one
    let system = customization?.system ||
      `You are ${name}, a ${species} pet in the world of ClawVille. You are a virtual companion who loves to chat with your owner.`;
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

    // v2: @elizaos/plugin-bootstrap is built into @elizaos/core — do NOT add it here.
    // Embeddings are provided by the prepended gemini-embedding-provider in
    // loadPlugins, so plugin-openai is no longer needed.
    const plugins: string[] = [
      '@elizaos/plugin-anthropic',
      '@elizaos/plugin-sql',
      '@elizaos/plugin-solana',
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
      topics: customization?.topics || ['pets', 'games', 'adventures'],
      adjectives: customization?.adjectives || ['friendly', 'playful', 'curious'],
      knowledge: customization?.knowledge || [],
      plugins,
      settings: {
        model: 'claude-3-5-haiku-20241022',
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
      if (this.config.apiKeys?.anthropic && !process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = this.config.apiKeys.anthropic;
      }
      if (this.config.apiKeys?.gemini && !process.env.GEMINI_API_KEY) {
        process.env.GEMINI_API_KEY = this.config.apiKeys.gemini;
      }
      if (!process.env.PROVIDERS_TOTAL_TIMEOUT_MS) {
        process.env.PROVIDERS_TOTAL_TIMEOUT_MS = '60000';
      }

      await this.loadPlugins();

      // v2: API keys live on character.secrets (not runtime.settings)
      this.character.secrets = {
        ...(this.character.secrets || {}),
        ANTHROPIC_API_KEY: this.config.apiKeys?.anthropic || process.env.ANTHROPIC_API_KEY || '',
        GEMINI_API_KEY: this.config.apiKeys?.gemini || process.env.GEMINI_API_KEY || '',
      };

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
    // v2: plugin-bootstrap is built into @elizaos/core (auto-registered during runtime.initialize())
    // plugin-openai is NOT listed here — embeddings come from the prepended
    // gemini-embedding-provider below, and text generation comes from plugin-anthropic.
    const pluginMap: Record<string, string> = {
      '@elizaos/plugin-anthropic': 'anthropicPlugin',
      '@elizaos/plugin-sql': 'sqlPlugin',
      '@elizaos/plugin-solana': 'solanaPlugin',
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

    // Prepend Gemini embedding provider (priority 100 — replaces plugin-openai's TEXT_EMBEDDING)
    const geminiEmbeddingPlugin = createGeminiEmbeddingPlugin({
      apiKey: this.config.apiKeys?.gemini,
    });
    this.loadedPlugins.unshift(geminiEmbeddingPlugin as Plugin);
    console.log(`[ElizaRuntime] Loaded Gemini embedding provider (text-embedding-004)`);

    // Prepend Gemini text provider (priority 95 — global default for TEXT_SMALL/TEXT_LARGE)
    // Sits between OpenClaw gateway (100) and Ultrathink (90) in the priority chain.
    const geminiTextPlugin = createGeminiTextPlugin({
      apiKey: this.config.apiKeys?.gemini,
    });
    this.loadedPlugins.unshift(geminiTextPlugin as Plugin);
    console.log(`[ElizaRuntime] Loaded Gemini text provider (gemini-2.5-flash, priority 95)`);

    // Prepend Ultrathink provider (priority 90 — under OpenClaw 100, over default Anthropic)
    const thinkingDefaults = AGENT_THINKING_DEFAULTS[this.config.agentType] ?? AGENT_THINKING_DEFAULTS['pet-agent'];
    const ultrathinkPlugin = createUltrathinkProviderPlugin({
      effort: this.config.thinkingConfig?.effort ?? thinkingDefaults.effort,
      enableThinkTool: this.config.thinkingConfig?.enableThinkTool ?? thinkingDefaults.enableThinkTool,
      model: thinkingDefaults.model,
      apiKey: this.config.apiKeys?.anthropic,
    });
    this.loadedPlugins.unshift(ultrathinkPlugin as Plugin);
    console.log(`[ElizaRuntime] Loaded Ultrathink provider (effort: ${thinkingDefaults.effort}, thinkTool: ${thinkingDefaults.enableThinkTool})`);

    // Prepend OpenClaw provider plugin so it wins TEXT_GENERATION priority (priority 100 > 90)
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

  async processMessage(
    content: string,
    context: { userId?: string; roomId?: string; platform?: string; dynamicContext?: string } = {}
  ): Promise<ElizaMessage> {
    if (this.state !== 'running' || !this.runtime) {
      throw new Error(`Agent is not running (state: ${this.state})`);
    }

    try {
      const userKey = context.userId || 'anonymous';
      const roomId = generateRoomId(this.config.agentId, userKey);
      // Derive a deterministic UUID from the userId string (may not be a valid UUID)
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

      // Build prompt: dynamic context → conversation history → user message
      let promptParts: string[] = [];
      if (context.dynamicContext) {
        promptParts.push(`[Current state context]\n${context.dynamicContext}`);
      }
      if (historyContext) {
        promptParts.push(historyContext.trim());
      }
      promptParts.push(`User: ${content}\n\nRespond to the user's latest message.`);
      const promptWithHistory = promptParts.join('\n\n');

      // v2: GenerateTextOptions requires stopSequences (empty array is fine)
      const result = await this.runtime.generateText(promptWithHistory, {
        maxTokens: 1000,
        stopSequences: [],
      });

      // Store assistant response
      const assistantMemoryId = crypto.randomUUID() as UUID;
      await this.runtime.createMemory(
        {
          id: assistantMemoryId,
          agentId,
          entityId: agentId,
          roomId,
          content: { text: result.text, source: 'agent' } as Content,
          createdAt: Date.now(),
          metadata: { type: 'message', source: 'agent' },
        },
        'messages'
      );

      const responseMessage: ElizaMessage = {
        role: 'assistant',
        content: result.text,
        timestamp: new Date(),
        metadata: { agentId: this.config.agentId, memoryId: assistantMemoryId },
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
