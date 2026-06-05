/**
 * OpenAI Text Generation Provider Plugin for ElizaOS v2
 *
 * Single backend for TEXT_SMALL / TEXT_LARGE in all non-OpenClaw runtimes.
 * Routes all text generation through OpenAI's chat/completions endpoint.
 * Priority 95 places it immediately below the OpenClaw gateway plugin (100),
 * so:
 *
 *   OpenClaw override (100) ─► wins when gateway configured
 *   OpenAI text (95) ─────────► default for all other runtimes
 *
 * This replaces the Gemini text provider for TEXT generation only —
 * Gemini's billing died (403 dunning), OpenAI is the new text backend.
 * EMBEDDINGS still go through gemini-embedding-provider (untouched).
 *
 * Unlike Gemini (one model id for both sizes), OpenAI splits TEXT_SMALL
 * and TEXT_LARGE across two models:
 *   TEXT_SMALL ─► smallModel (default gpt-4o-mini)
 *   TEXT_LARGE ─► largeModel (default gpt-4o)
 *
 * Env vars:
 *   OPENAI_API_KEY     (or pass via config.apiKey)
 *   OPENAI_SMALL_MODEL (or pass via config.smallModel — default gpt-4o-mini)
 *   OPENAI_LARGE_MODEL (or pass via config.largeModel — default gpt-4o)
 *
 * No external SDK — uses fetch() directly (same pattern as the
 * sister gemini-text-provider.ts).
 */

import {
  ModelType,
  type Plugin,
  type IAgentRuntime,
  type GenerateTextParams,
} from '@elizaos/core';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// gpt-4o-mini is the fast, cheap default for TEXT_SMALL.
// gpt-4o is the higher-quality default for TEXT_LARGE.
const DEFAULT_SMALL_MODEL = 'gpt-4o-mini';
const DEFAULT_LARGE_MODEL = 'gpt-4o';

export interface OpenAITextConfig {
  /** Fallback to process.env.OPENAI_API_KEY if omitted. */
  apiKey?: string;
  /**
   * Model for TEXT_SMALL — defaults to OPENAI_SMALL_MODEL env or gpt-4o-mini.
   * Overridden by `model` if that is set (forces a single model for both).
   */
  smallModel?: string;
  /**
   * Model for TEXT_LARGE — defaults to OPENAI_LARGE_MODEL env or gpt-4o.
   * Overridden by `model` if that is set (forces a single model for both).
   */
  largeModel?: string;
  /**
   * Force a single model id for BOTH TEXT_SMALL and TEXT_LARGE.
   * When set, takes precedence over smallModel/largeModel — used by
   * createOpenAIProTextPlugin to pin the large model everywhere.
   */
  model?: string;
  /** Default max output tokens if not supplied by caller. */
  defaultMaxTokens?: number;
  /** Default temperature if not supplied. */
  defaultTemperature?: number;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  // max_completion_tokens (not the deprecated max_tokens): the current param,
  // and the only one accepted by o-series reasoning models if OPENAI_*_MODEL is
  // ever pointed at one. Works on gpt-4o-mini/gpt-4o too.
  max_completion_tokens?: number;
  stop?: string[];
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    finish_reason?: string;
  }>;
}

async function generate(
  prompt: string,
  params: Partial<GenerateTextParams>,
  config: OpenAITextConfig,
  model: string,
): Promise<string> {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('[OpenAIText] Missing OPENAI_API_KEY');
  }

  const maxTokens =
    (params as any)?.maxTokens ??
    (params as any)?.maxOutputTokens ??
    config.defaultMaxTokens ??
    1000;

  const temperature =
    (params as any)?.temperature ?? config.defaultTemperature ?? 0.7;

  const stopSequences: string[] = Array.isArray((params as any)?.stopSequences)
    ? ((params as any).stopSequences as string[])
    : [];

  const body: OpenAIRequest = {
    model,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature,
    max_completion_tokens: maxTokens,
    // OpenAI rejects stop: [] in some SDK paths — only include when non-empty
    ...(stopSequences.length > 0 ? { stop: stopSequences } : {}),
  };

  const res = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(
      `[OpenAIText] ${res.status} ${res.statusText}: ${errBody.slice(0, 500)}`,
    );
  }

  const data = (await res.json()) as OpenAIResponse;

  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error('[OpenAIText] No choices in response');
  }

  const text = choice.message?.content ?? '';

  if (!text) {
    throw new Error(
      `[OpenAIText] Empty content in choice (finish_reason=${choice.finish_reason})`,
    );
  }

  return text;
}

/**
 * Creates an ElizaOS plugin that provides TEXT_SMALL + TEXT_LARGE via OpenAI.
 *
 * Default priority is 95 — immediately below OpenClaw gateway (100) and the
 * canonical text-gen backend for every other runtime.
 *
 * TEXT_SMALL routes to smallModel (default gpt-4o-mini), TEXT_LARGE routes to
 * largeModel (default gpt-4o). `config.model`, when set, forces a single model
 * for both handlers.
 */
export function createOpenAITextPlugin(config: OpenAITextConfig = {}): Plugin {
  const smallModel =
    config.model ??
    config.smallModel ??
    process.env.OPENAI_SMALL_MODEL ??
    DEFAULT_SMALL_MODEL;
  const largeModel =
    config.model ??
    config.largeModel ??
    process.env.OPENAI_LARGE_MODEL ??
    DEFAULT_LARGE_MODEL;

  const makeHandler =
    (model: string) =>
    async (
      _runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      const prompt = (params as any)?.prompt ?? '';
      if (!prompt) {
        throw new Error('[OpenAIText] Missing prompt');
      }
      return generate(prompt, params, config, model);
    };

  return {
    name: 'openai-text-provider',
    description: `OpenAI ${smallModel}/${largeModel} for TEXT_SMALL/TEXT_LARGE (global default)`,
    models: {
      [ModelType.TEXT_SMALL]: makeHandler(smallModel),
      [ModelType.TEXT_LARGE]: makeHandler(largeModel),
    },
    priority: 95,
  };
}

/** Preset for collaboration runtimes that benefit from the larger model on BOTH sizes */
export function createOpenAIProTextPlugin(
  config: Omit<OpenAITextConfig, 'model' | 'smallModel' | 'largeModel'> = {},
): Plugin {
  const largeModel =
    process.env.OPENAI_LARGE_MODEL ?? DEFAULT_LARGE_MODEL;
  return createOpenAITextPlugin({
    ...config,
    model: largeModel,
  });
}
