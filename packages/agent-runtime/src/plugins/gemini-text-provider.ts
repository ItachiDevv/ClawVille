/**
 * Gemini Text Generation Provider Plugin for ElizaOS v2
 *
 * Single backend for TEXT_SMALL / TEXT_LARGE in all non-OpenClaw runtimes.
 * Routes all text generation through Google's Gemini generateContent endpoint.
 * Priority 95 places it immediately below the OpenClaw gateway plugin (100),
 * so:
 *
 *   OpenClaw override (100) ─► wins when gateway configured
 *   Gemini text (95) ─────────► default for all other runtimes
 *
 * plugin-anthropic and ultrathink-provider have both been removed from the
 * chain — Gemini is the canonical backend.
 *
 * Env var: GEMINI_API_KEY (or pass via config.apiKey)
 *
 * No external SDK — uses fetch() directly (same pattern as the
 * sister gemini-embedding-provider.ts).
 */

import {
  ModelType,
  type Plugin,
  type IAgentRuntime,
  type GenerateTextParams,
} from '@elizaos/core';

const GEMINI_API_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';

// gemini-2.5-flash is the fast, cheap default. Switch to gemini-2.5-pro
// at the call site for quality-critical paths (e.g. collaboration specialists).
const DEFAULT_MODEL = 'gemini-2.5-flash';

export interface GeminiTextConfig {
  /** Fallback to process.env.GEMINI_API_KEY if omitted. */
  apiKey?: string;
  /** Gemini model id — defaults to gemini-2.5-flash. */
  model?: string;
  /** Default max output tokens if not supplied by caller. */
  defaultMaxTokens?: number;
  /** Default temperature if not supplied. */
  defaultTemperature?: number;
}

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  topP?: number;
  topK?: number;
}

interface GeminiRequest {
  contents: GeminiContent[];
  generationConfig?: GeminiGenerationConfig;
  systemInstruction?: { parts: GeminiPart[] };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
}

async function generate(
  prompt: string,
  params: Partial<GenerateTextParams>,
  config: GeminiTextConfig,
): Promise<string> {
  const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[GeminiText] Missing GEMINI_API_KEY');
  }

  const model = config.model ?? DEFAULT_MODEL;
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

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

  const body: GeminiRequest = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      // Gemini API rejects stopSequences: [] — only include when non-empty
      ...(stopSequences.length > 0 ? { stopSequences } : {}),
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(
      `[GeminiText] ${res.status} ${res.statusText}: ${errBody.slice(0, 500)}`,
    );
  }

  const data = (await res.json()) as GeminiResponse;

  if (data.promptFeedback?.blockReason) {
    throw new Error(
      `[GeminiText] Prompt blocked: ${data.promptFeedback.blockReason}`,
    );
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new Error('[GeminiText] No candidates in response');
  }

  const textParts =
    candidate.content?.parts?.map((p) => p.text).filter(Boolean) ?? [];
  const text = textParts.join('');

  if (!text) {
    throw new Error(
      `[GeminiText] Empty text in candidate (finishReason=${candidate.finishReason})`,
    );
  }

  return text;
}

/**
 * Creates an ElizaOS plugin that provides TEXT_SMALL + TEXT_LARGE via Gemini.
 *
 * Default priority is 95 — immediately below OpenClaw gateway (100) and the
 * canonical text-gen backend for every other runtime.
 */
export function createGeminiTextPlugin(config: GeminiTextConfig = {}): Plugin {
  const handler = async (
    _runtime: IAgentRuntime,
    params: GenerateTextParams,
  ): Promise<string> => {
    const prompt = (params as any)?.prompt ?? '';
    if (!prompt) {
      throw new Error('[GeminiText] Missing prompt');
    }
    return generate(prompt, params, config);
  };

  return {
    name: 'gemini-text-provider',
    description: `Gemini ${config.model ?? DEFAULT_MODEL} for TEXT_SMALL/TEXT_LARGE (global default)`,
    models: {
      [ModelType.TEXT_SMALL]: handler,
      [ModelType.TEXT_LARGE]: handler,
    },
    priority: 95,
  };
}

/** Preset for collaboration runtimes that benefit from higher-quality Gemini Pro */
export function createGeminiProTextPlugin(
  config: Omit<GeminiTextConfig, 'model'> = {},
): Plugin {
  return createGeminiTextPlugin({
    ...config,
    model: 'gemini-2.5-pro',
  });
}
