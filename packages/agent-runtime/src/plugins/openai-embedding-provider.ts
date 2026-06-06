/**
 * OpenAI Embedding Provider Plugin for ElizaOS v2
 *
 * Provides TEXT_EMBEDDING via OpenAI's text-embedding-3-small endpoint
 * directly over fetch — no extra dependency needed. Replaced the Gemini
 * text-embedding-004 provider (768-dim) as part of the Gemini→OpenAI
 * migration: this emits a deterministic 1536-dim vector. Priority is set
 * high so it wins over any other embedding provider if multiple are loaded.
 *
 * DIMENSION INVARIANT: the model and dimension are HARD-PINNED in code at
 * text-embedding-3-small / 1536 (NOT env- or config-overridable). The request
 * body, the boot dimension-probe, and the standalone embedText() helper all
 * use the SAME literal constants, so stored vectors and query vectors can
 * never diverge. Changing the dimension is a deliberate code change that
 * requires a re-embed migration of every stored vector (it routes pgvector to
 * a different dim_* column), so it is intentionally NOT controllable by a
 * stray env value.
 *
 * Env vars:
 *   OPENAI_API_KEY (or pass via config.apiKey) — the only overridable input.
 *   The embedding model + dimension are pinned at 1536 in code (see above).
 */
import {
  ModelType,
  type Plugin,
  type IAgentRuntime,
} from '@elizaos/core';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

// HARD-PINNED model + dimension. text-embedding-3-small supports the
// `dimensions` parameter (Matryoshka truncation); we pin 1536 LITERALLY so
// stored + query vectors are always the same size and always land in the same
// pgvector dim_1536 column. NOT env- or config-overridable — changing the
// dimension routes embeddings to a different column and requires a re-embed
// migration, so it is a deliberate code edit, never a stray env value.
const MODEL = 'text-embedding-3-small';

// Output dimension. ElizaOS probes the model with null input at boot to
// discover the embedding dimension (see AgentRuntime initialization — calls
// `useModel(TEXT_EMBEDDING, null)` and asserts the returned vector has
// non-zero length). Returning a zero vector of this SAME literal dimension
// lets the probe succeed without burning a real OpenAI API call, and
// guarantees probe == real.
const DIMS = 1536;

export interface OpenAIEmbeddingConfig {
  /** Fallback to process.env.OPENAI_API_KEY if omitted. */
  apiKey?: string;
}

async function embed(
  text: string,
  config: OpenAIEmbeddingConfig,
): Promise<number[]> {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('[OpenAIEmbedding] Missing OPENAI_API_KEY');
  }

  const res = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      // Model + dimension are PINNED literals — never read from env/config —
      // so every embedding lands in the same pgvector dim_1536 column.
      model: MODEL,
      input: text,
      dimensions: DIMS,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `[OpenAIEmbedding] ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
    );
  }

  const data = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const values = data.data?.[0]?.embedding;
  if (!values || !Array.isArray(values)) {
    throw new Error(
      '[OpenAIEmbedding] Invalid response: missing data[0].embedding',
    );
  }
  return values;
}

/**
 * Creates an ElizaOS plugin that provides TEXT_EMBEDDING via OpenAI.
 */
export function createOpenAIEmbeddingPlugin(
  config: OpenAIEmbeddingConfig = {},
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
      // Return a zero vector of the SAME pinned dimension embed() emits for
      // real vectors — passes the `embedding.length > 0` validation and lets
      // the runtime set up its embedding column without a wasted API call.
      // Because DIMS is a literal const shared with the request body, the
      // probe and the live vectors can never diverge.
      return new Array(DIMS).fill(0);
    }
    return embed(text, config);
  };

  return {
    name: 'openai-embedding-provider',
    description: `OpenAI ${MODEL} (${DIMS}-dim, pinned — not env-overridable) for TEXT_EMBEDDING`,
    models: {
      [ModelType.TEXT_EMBEDDING]: handler,
    },
    // Beat any other embedding provider (plugin-openai = 0 default).
    priority: 100,
  };
}
