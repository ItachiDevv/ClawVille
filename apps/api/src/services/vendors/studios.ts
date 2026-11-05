/**
 * Studios by Claw Hunter (https://mystudios.fun) - image generation, MCP hub
 * step 2 phase 2. Public REST API, paid per call with x402 (mode B: the avatar
 * wallet pays under the human's spend rules).
 *
 * Facts checked 2026-11-05 against a live unpaid quote:
 *   - POST /api/v1/images/generations answers 402 with a `PAYMENT-REQUIRED`
 *     header (x402 v2). The Solana mainnet USDC entry for z-image-turbo is
 *     5000 base units ($0.005), payTo below, with Studios' own fee payer.
 *   - The reply is `{ data: [{ url } | { b64_json }], billing: {...} }`.
 *     x402 calls without an API key are not saved to the user's My Media.
 *
 * Vendor text is untrusted: callers return only the image and our own status.
 */

export const STUDIOS_API_BASE = 'https://mystudios.fun/api/v1';

/** Wallets that Studios names as `payTo`. A quote naming any other wallet is refused. */
export const STUDIOS_PAY_TO: readonly string[] = ['HuSiSpcUoUEF4hct1MRsGtNGz8EdBiTs7p2WtJGksLSa'];

/** Hard ceiling for one Studios image call, in USDC base units ($0.25). The user's caps apply first. */
export const STUDIOS_MAX_CALL_ATOMIC = 250_000n;

/** Image models we allow in v1: the cheapest first. */
export const STUDIOS_IMAGE_MODELS = ['z-image-turbo'] as const;
export type StudiosImageModel = (typeof STUDIOS_IMAGE_MODELS)[number];

export const STUDIOS_PROMPT_MAX = 1000;

export function buildStudiosImageRequest(input: { prompt: string; model?: StudiosImageModel }): { url: string; body: Record<string, unknown> } {
  return {
    url: `${STUDIOS_API_BASE}/images/generations`,
    body: { model: input.model ?? 'z-image-turbo', prompt: input.prompt, n: 1 },
  };
}

export interface StudiosImage {
  /** https URL from Studios (a signed link that expires), or null. */
  imageUrl: string | null;
  /** Base64 image data when the model returns data instead of a URL, or null. */
  imageBase64: string | null;
}

const MAX_BASE64_CHARS = 8 * 1024 * 1024;

/** Read only the first image from a Studios reply. Anything else is ignored. */
export function parseStudiosImage(json: unknown): StudiosImage | null {
  if (!json || typeof json !== 'object') return null;
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as { url?: unknown; b64_json?: unknown } | null;
  if (!first || typeof first !== 'object') return null;
  let imageUrl: string | null = null;
  if (typeof first.url === 'string') {
    try {
      const parsed = new URL(first.url);
      if (parsed.protocol === 'https:') imageUrl = parsed.toString();
    } catch {
      imageUrl = null;
    }
  }
  const imageBase64 = typeof first.b64_json === 'string'
    && first.b64_json.length <= MAX_BASE64_CHARS
    && /^[A-Za-z0-9+/=\s]+$/.test(first.b64_json)
    ? first.b64_json.replace(/\s+/g, '')
    : null;
  if (!imageUrl && !imageBase64) return null;
  return { imageUrl, imageBase64 };
}
