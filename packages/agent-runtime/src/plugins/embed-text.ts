/**
 * Standalone text embedding utility.
 *
 * Wraps the same OpenAI text-embedding-3-small endpoint used by
 * openai-embedding-provider.ts but callable directly without going
 * through an ElizaOS runtime. Used by:
 *
 * - items.ts POST /learn → embed knowledge entries before storing
 * - KnowledgeProvider → embed user message for similarity search
 *
 * DIMENSION INVARIANT: this MUST emit the SAME 1536-dim vectors as
 * openai-embedding-provider.ts. KnowledgeProvider embeds the user query
 * here and compares it against vectors the provider stored — a dimension
 * mismatch silently breaks similarity search. The model and dimension are
 * therefore HARD-PINNED in code as literals (text-embedding-3-small / 1536),
 * NOT env- or options-overridable. Changing the dimension routes embeddings
 * to a different pgvector column and requires a re-embed migration, so it is
 * a deliberate code edit, never a stray env value.
 *
 * The API key falls back to process.env.OPENAI_API_KEY if not passed — it is
 * the only overridable input.
 */

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
// HARD-PINNED — see DIMENSION INVARIANT above. Never read from env/options.
const MODEL = 'text-embedding-3-small';
const DIMS = 1536;

export interface EmbedTextOptions {
  apiKey?: string;
}

/**
 * Embed a single text string into a 1536-dimensional float vector.
 * Throws on API errors — callers should handle gracefully.
 */
export async function embedText(
  text: string,
  options: EmbedTextOptions = {},
): Promise<number[]> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('[embedText] Missing OPENAI_API_KEY');
  }

  const res = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      // Model + dimension are PINNED literals — never read from env/options —
      // so query vectors always match the stored dim_1536 vectors.
      model: MODEL,
      input: text,
      dimensions: DIMS,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `[embedText] ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const values = data.data?.[0]?.embedding;
  if (!values || !Array.isArray(values)) {
    throw new Error('[embedText] Invalid response: missing data[0].embedding');
  }
  return values;
}

/**
 * Embed multiple texts in parallel (batched). Returns vectors in the
 * same order as the input array. Failures on individual items throw
 * (use Promise.allSettled upstream if you need partial results).
 */
export async function embedTexts(
  texts: string[],
  options: EmbedTextOptions = {},
): Promise<number[][]> {
  return Promise.all(texts.map((t) => embedText(t, options)));
}
