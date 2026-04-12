/**
 * Standalone text embedding utility.
 *
 * Wraps the same Gemini text-embedding-004 endpoint used by
 * gemini-embedding-provider.ts but callable directly without going
 * through an ElizaOS runtime. Used by:
 *
 * - items.ts POST /learn → embed knowledge entries before storing
 * - KnowledgeProvider → embed user message for similarity search
 * - marketplace.ts POST /install → embed skill knowledge on install
 *
 * The API key falls back to process.env.GEMINI_API_KEY if not passed.
 */

const GEMINI_API_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'text-embedding-004';

export interface EmbedTextOptions {
  apiKey?: string;
  model?: string;
}

/**
 * Embed a single text string into a 768-dimensional float vector.
 * Throws on API errors — callers should handle gracefully.
 */
export async function embedText(
  text: string,
  options: EmbedTextOptions = {},
): Promise<number[]> {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[embedText] Missing GEMINI_API_KEY');
  }

  const model = options.model ?? DEFAULT_MODEL;
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
      `[embedText] ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as {
    embedding?: { values?: number[] };
  };
  const values = data.embedding?.values;
  if (!values || !Array.isArray(values)) {
    throw new Error('[embedText] Invalid response: missing embedding.values');
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
