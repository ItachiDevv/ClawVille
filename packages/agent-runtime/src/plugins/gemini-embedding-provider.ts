/**
 * Gemini Embedding Provider Plugin for ElizaOS v2
 *
 * Replaces @elizaos/plugin-openai for TEXT_EMBEDDING. Calls Google's
 * Gemini text-embedding-004 endpoint directly over fetch — no extra
 * dependency needed. Priority is set high so it wins over any other
 * embedding provider if multiple are loaded.
 *
 * Env var: GEMINI_API_KEY (or pass via config.apiKey)
 */
import {
  ModelType,
  type Plugin,
  type IAgentRuntime,
} from '@elizaos/core';

const GEMINI_API_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';

// 768-dim, stable. gemini-embedding-001 offers 1536/3072 but text-embedding-004
// is the cheaper, faster default for most use cases.
const DEFAULT_MODEL = 'text-embedding-004';

// Output dimension for text-embedding-004. ElizaOS probes the model with null
// input at boot to discover the embedding dimension (see AgentRuntime
// initialization — calls `useModel(TEXT_EMBEDDING, null)` and asserts the
// returned vector has non-zero length). Returning a zero vector of the right
// dimension lets the probe succeed without burning a real Gemini API call.
const DEFAULT_MODEL_DIMS = 768;

export interface GeminiEmbeddingConfig {
  /** Fallback to process.env.GEMINI_API_KEY if omitted. */
  apiKey?: string;
  /** Gemini embedding model id — defaults to text-embedding-004 (768 dims). */
  model?: string;
}

async function embed(
  text: string,
  config: GeminiEmbeddingConfig,
): Promise<number[]> {
  const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[GeminiEmbedding] Missing GEMINI_API_KEY');
  }

  const model = config.model ?? DEFAULT_MODEL;
  const url = `${GEMINI_API_BASE}/${model}:embedContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text }] },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `[GeminiEmbedding] ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
    );
  }

  const data = (await res.json()) as {
    embedding?: { values?: number[] };
  };
  const values = data.embedding?.values;
  if (!values || !Array.isArray(values)) {
    throw new Error(
      '[GeminiEmbedding] Invalid response: missing embedding.values',
    );
  }
  return values;
}

/**
 * Creates an ElizaOS plugin that provides TEXT_EMBEDDING via Gemini.
 */
export function createGeminiEmbeddingPlugin(
  config: GeminiEmbeddingConfig = {},
): Plugin {
  const handler = async (
    _runtime: IAgentRuntime,
    params: any,
  ): Promise<number[]> => {
    // v2 can pass string or { text: string } or { input: string }
    const text =
      typeof params === 'string'
        ? params
        : params?.text ?? params?.input ?? '';
    if (!text) {
      // ElizaOS dimension probe (calls with `null` at runtime init).
      // Return a zero vector of the right dimension — passes the
      // `embedding.length > 0` validation and lets the runtime set up
      // its embedding column without a wasted API call.
      return new Array(DEFAULT_MODEL_DIMS).fill(0);
    }
    return embed(text, config);
  };

  return {
    name: 'gemini-embedding-provider',
    description: `Gemini ${config.model ?? DEFAULT_MODEL} for TEXT_EMBEDDING`,
    models: {
      [ModelType.TEXT_EMBEDDING]: handler,
    },
    // Beat any other embedding provider (plugin-openai = 0 default).
    priority: 100,
  };
}
