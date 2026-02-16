/**
 * ElizaOS Runtime Wrapper for ElizaPets
 * Adapted from eliza-kiz for location-based agents.
 */

import {
  AgentRuntime as ElizaAgentRuntime,
  ChannelType,
  type Character,
  type Plugin,
  type UUID,
  type Memory,
  type Content,
  type IAgentRuntime,
} from '@elizaos/core';
import { v5 as uuidv5 } from 'uuid';
import type { LocationTemplate } from '@elizapets/agent-templates';
import { loadLocationTemplate } from './character-loader';

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
  databaseUrl?: string;
  apiKeys?: {
    anthropic?: string;
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

  const messageExamples = template.messageExamples?.map((conversation) =>
    conversation.map((msg) => ({
      name: msg.user === 'assistant' ? name : 'User',
      content: {
        text: typeof msg.content === 'string' ? msg.content : msg.content.text || '',
      },
    }))
  );

  const plugins: string[] = [
    '@elizaos/plugin-anthropic',
    '@elizaos/plugin-openai',
    '@elizaos/plugin-bootstrap',
    '@elizaos/plugin-sql',
  ];

  return {
    id: undefined,
    name,
    username: name.toLowerCase().replace(/\s+/g, '-'),
    system,
    bio,
    messageExamples,
    postExamples: [],
    topics: customization?.topics || template.topics || [],
    adjectives: template.adjectives || [],
    knowledge: template.knowledge || [],
    plugins,
    settings: {
      ...(template.settings || {}),
      model: 'claude-3-5-haiku-20241022',
    },
    style: {
      all: [...(template.style?.all || []), ...(Array.isArray(customization?.style) ? customization.style : [])],
      chat: template.style?.chat || [],
      post: template.style?.post || [],
    },
  };
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

    if (config.agentType === 'pet-agent') {
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
      `You are ${name}, a ${species} pet in the world of ElizaPets. You are a virtual companion who loves to chat with your owner.`;
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
    const messageExamples = customization?.messageExamples?.map((conversation) =>
      conversation.map((msg) => ({
        name: msg.user === 'assistant' ? name : 'User',
        content: {
          text: msg.content,
        },
      }))
    );

    const plugins: string[] = [
      '@elizaos/plugin-anthropic',
      '@elizaos/plugin-openai',
      '@elizaos/plugin-bootstrap',
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

    return {
      id: undefined,
      name,
      username: name.toLowerCase().replace(/\s+/g, '-'),
      system,
      bio,
      messageExamples: messageExamples || [],
      postExamples: [],
      topics: customization?.topics || ['pets', 'games', 'adventures'],
      adjectives: customization?.adjectives || ['friendly', 'playful', 'curious'],
      knowledge: customization?.knowledge || [],
      plugins,
      settings: {
        model: 'claude-3-5-haiku-20241022',
      },
      style,
    };
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
      if (this.config.apiKeys?.openai && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = this.config.apiKeys.openai;
      }
      if (!process.env.PROVIDERS_TOTAL_TIMEOUT_MS) {
        process.env.PROVIDERS_TOTAL_TIMEOUT_MS = '60000';
      }

      await this.loadPlugins();

      this.runtime = new ElizaAgentRuntime({
        agentId: this.config.agentId as UUID,
        character: this.character,
        plugins: this.loadedPlugins,
        settings: {
          ANTHROPIC_API_KEY: this.config.apiKeys?.anthropic || process.env.ANTHROPIC_API_KEY || '',
          OPENAI_API_KEY: this.config.apiKeys?.openai || process.env.OPENAI_API_KEY || '',
          POSTGRES_URL: this.config.databaseUrl || process.env.DATABASE_URL || '',
        },
      });

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
    const pluginMap: Record<string, string> = {
      '@elizaos/plugin-anthropic': 'anthropicPlugin',
      '@elizaos/plugin-openai': 'openaiPlugin',
      '@elizaos/plugin-bootstrap': 'bootstrapPlugin',
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
      const memories = await this.runtime.getMemories({ roomId, count: limit, tableName: 'messages' });
      return memories.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
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
      const roomId = generateRoomId(this.config.agentId, context.userId || 'anonymous');
      const entityId = (context.userId || crypto.randomUUID()) as UUID;
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

      const result = await this.runtime.generateText(promptWithHistory, {
        maxTokens: 1000,
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
