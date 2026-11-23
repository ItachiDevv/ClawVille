/**
 * Own AI for hosted agents (MCP hub step 4 part A, 2026-11-09, migration 0099).
 * A human picks the AI that powers their hosted agent: ClawVille AI (default),
 * their own key (OpenAI, Anthropic, OpenRouter) or a UsePod token. Also a model,
 * a speed (seconds between decisions) and a daily dollar limit. The spend is an
 * ESTIMATE from the token counts and the price table below.
 * Contract: brain `plans/mcp-hub-step4-own-ai-board.md`.
 */

export const OWN_AI_SOURCES = ['clawville', 'own_key', 'usepod'] as const;
export type OwnAiSource = (typeof OWN_AI_SOURCES)[number];

export const OWN_AI_PROVIDERS = ['openai', 'anthropic', 'openrouter', 'usepod'] as const;
export type OwnAiProvider = (typeof OWN_AI_PROVIDERS)[number];

export interface OwnAiProviderSpec {
  id: OwnAiProvider;
  label: string;
  protocol: 'openai-compat' | 'anthropic';
  /** Fixed host. NEVER user-supplied (SSRF + key theft). usepod: `https://api.usepod.ai/proxy/${token}/v1`. */
  baseUrl: (secret: string) => string;
  keyPattern: RegExp;
  modelsPath: string;
}

/** A UsePod api_token (UUID). Also the only shape allowed in the UsePod URL path. */
export const OWN_AI_USEPOD_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OWN_AI_PROVIDER_SPECS: Record<OwnAiProvider, OwnAiProviderSpec> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-compat',
    baseUrl: () => 'https://api.openai.com/v1',
    keyPattern: /^sk-[A-Za-z0-9_-]{20,200}$/,
    modelsPath: '/models',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: () => 'https://api.anthropic.com',
    keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,200}$/,
    modelsPath: '/v1/models',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compat',
    baseUrl: () => 'https://openrouter.ai/api/v1',
    keyPattern: /^sk-or-[A-Za-z0-9_-]{20,200}$/,
    modelsPath: '/models',
  },
  usepod: {
    id: 'usepod',
    label: 'UsePod',
    protocol: 'openai-compat',
    baseUrl: (token: string) => {
      // The token is a path segment: refuse anything but a UUID (no path injection).
      if (!OWN_AI_USEPOD_TOKEN_PATTERN.test(token)) throw new Error('invalid_key');
      return `https://api.usepod.ai/proxy/${token.toLowerCase()}/v1`;
    },
    keyPattern: OWN_AI_USEPOD_TOKEN_PATTERN,
    modelsPath: '/models',
  },
};

/** Seconds between decisions. 25 = today's ClawVille speed. Floor 10 (founder 11-08). */
export const OWN_AI_SPEEDS_SECONDS = [25, 20, 15, 10] as const;
export type OwnAiSpeedSeconds = (typeof OWN_AI_SPEEDS_SECONDS)[number];
export const OWN_AI_DEFAULT_SPEED_SECONDS = 25;

/** Daily limit in US cents. Required for own_key/usepod (no limit = cannot save). */
export const OWN_AI_DAILY_LIMIT_MIN_CENTS = 10; // $0.10
export const OWN_AI_DAILY_LIMIT_MAX_CENTS = 50_000; // $500

/** Model ids we store and send: letters, digits and `._:/-`, at most 128 characters. */
export const OWN_AI_MODEL_ID_MAX_CHARS = 128;
export const OWN_AI_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Price per million tokens in USD, used for the ESTIMATED spend. */
export interface OwnAiModelPrice {
  inputPerM: number;
  outputPerM: number;
}

/** Public list prices (USD per 1M tokens), keyed by the bare model id. ESTIMATES. */
export const OWN_AI_MODEL_PRICES: Record<string, OwnAiModelPrice> = {
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10 },
  'gpt-4.1': { inputPerM: 2, outputPerM: 8 },
  'gpt-4.1-mini': { inputPerM: 0.4, outputPerM: 1.6 },
  'gpt-5': { inputPerM: 1.25, outputPerM: 10 },
  'gpt-5.1': { inputPerM: 1.25, outputPerM: 10 },
  'gpt-5-mini': { inputPerM: 0.25, outputPerM: 2 },
  'o4-mini': { inputPerM: 1.1, outputPerM: 4.4 },
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
  'claude-sonnet-4-5': { inputPerM: 3, outputPerM: 15 },
  'claude-opus-4-5': { inputPerM: 5, outputPerM: 25 },
  'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10 },
  'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
  'deepseek-v3.1': { inputPerM: 0.27, outputPerM: 1.1 },
  // OpenRouter id of the same model (`deepseek/deepseek-chat-v3.1`, recommended below).
  'deepseek-chat-v3.1': { inputPerM: 0.27, outputPerM: 1.1 },
  'deepseek-chat': { inputPerM: 0.27, outputPerM: 1.1 },
  'deepseek-r1': { inputPerM: 0.55, outputPerM: 2.19 },
  'kimi-k2-thinking': { inputPerM: 0.6, outputPerM: 2.5 },
  'qwen3-coder': { inputPerM: 0.3, outputPerM: 1.2 },
  'gpt-oss-120b': { inputPerM: 0.05, outputPerM: 0.25 },
  'gpt-oss-20b': { inputPerM: 0.03, outputPerM: 0.15 },
  'llama-4-maverick': { inputPerM: 0.2, outputPerM: 0.6 },
  'glm-4.6': { inputPerM: 0.6, outputPerM: 2.2 },
  'qwen3-32b': { inputPerM: 0.1, outputPerM: 0.3 },
};

/** Conservative price for a model that is not in the table. */
export const OWN_AI_UNKNOWN_MODEL_PRICE: OwnAiModelPrice = { inputPerM: 15, outputPerM: 75 };

/** Shown first in the picker. `reasoning` models get a larger max_tokens and timeout. */
export interface OwnAiRecommendedModel {
  provider: OwnAiProvider;
  model: string;
  label: string;
  reasoning?: boolean;
}

export const OWN_AI_RECOMMENDED_MODELS: readonly OwnAiRecommendedModel[] = [
  { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { provider: 'anthropic', model: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { provider: 'openai', model: 'gpt-5.1', label: 'GPT-5.1', reasoning: true },
  { provider: 'openai', model: 'gpt-4.1', label: 'GPT-4.1' },
  { provider: 'openrouter', model: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', reasoning: true },
  { provider: 'openrouter', model: 'deepseek/deepseek-chat-v3.1', label: 'DeepSeek V3.1' },
  { provider: 'openrouter', model: 'moonshotai/kimi-k2-thinking', label: 'Kimi K2 Thinking', reasoning: true },
  { provider: 'usepod', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { provider: 'usepod', model: 'gpt-5.1', label: 'GPT-5.1', reasoning: true },
  { provider: 'usepod', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { provider: 'usepod', model: 'deepseek-v3.1', label: 'DeepSeek V3.1' },
  { provider: 'usepod', model: 'gpt-oss-120b', label: 'gpt-oss-120b' },
];

export const OWN_AI_REASONING_MAX_TOKENS = 2000;
/** max_tokens floor for a non-reasoning model (the decide call size). */
export const OWN_AI_DEFAULT_MAX_TOKENS = 200;
export const OWN_AI_CALL_TIMEOUT_MS = 20_000; // non-reasoning
export const OWN_AI_REASONING_TIMEOUT_MS = 45_000;

export type OwnAiFallbackReason = 'daily_limit' | 'key_rejected' | 'balance_empty' | 'provider_error' | 'model_unavailable';
export const OWN_AI_FALLBACK_REASONS: readonly OwnAiFallbackReason[] = [
  'daily_limit',
  'key_rejected',
  'balance_empty',
  'provider_error',
  'model_unavailable',
];

/** GET /api/agent-ai response body `{ ai: OwnAiStatus }`. */
export interface OwnAiStatus {
  source: OwnAiSource;
  provider: OwnAiProvider | null;
  model: string | null;
  speedSeconds: number;
  dailyLimitCents: number | null;
  keyLast4: string | null;
  usepodRegistered: boolean; // true when ClawVille registered the token
  today: { calls: number; inputTokens: number; outputTokens: number; estimatedCents: number };
  activeNow: 'own' | 'clawville'; // what the agent uses at this moment
  fallbackReason: OwnAiFallbackReason | null;
  fallbackAt: string | null;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (server meter and web estimate use the same math)
// ---------------------------------------------------------------------------

export function isOwnAiSource(v: unknown): v is OwnAiSource {
  return typeof v === 'string' && (OWN_AI_SOURCES as readonly string[]).includes(v);
}

export function isOwnAiProvider(v: unknown): v is OwnAiProvider {
  return typeof v === 'string' && (OWN_AI_PROVIDERS as readonly string[]).includes(v);
}

export function isOwnAiSpeedSeconds(v: unknown): v is OwnAiSpeedSeconds {
  return typeof v === 'number' && (OWN_AI_SPEEDS_SECONDS as readonly number[]).includes(v);
}

export function isOwnAiDailyLimitCents(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= OWN_AI_DAILY_LIMIT_MIN_CENTS &&
    v <= OWN_AI_DAILY_LIMIT_MAX_CENTS
  );
}

export function isOwnAiModelId(v: unknown): v is string {
  return typeof v === 'string' && v.length <= OWN_AI_MODEL_ID_MAX_CHARS && OWN_AI_MODEL_ID_PATTERN.test(v);
}

/** The bare model id: the first `vendor/` segment and an OpenRouter `:variant` suffix removed, lower case. */
export function bareOwnAiModelId(model: string): string {
  let bare = model.trim().toLowerCase();
  const slash = bare.indexOf('/');
  if (slash >= 0) bare = bare.slice(slash + 1);
  const colon = bare.indexOf(':');
  if (colon >= 0) bare = bare.slice(0, colon);
  return bare;
}

/** Price for a model id. A dated id (`claude-sonnet-4-5-20250929`) uses its undated row. Unknown -> conservative price. */
export function ownAiModelPrice(model: string): OwnAiModelPrice {
  const bare = bareOwnAiModelId(model);
  const exact = OWN_AI_MODEL_PRICES[bare];
  if (exact) return exact;
  const undated = OWN_AI_MODEL_PRICES[bare.replace(/-\d{8}$/, '')];
  return undated ?? OWN_AI_UNKNOWN_MODEL_PRICE;
}

function tokenCount(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 100_000_000);
}

/**
 * Estimated cost in integer micro-USD. Prices are USD per 1M tokens, so
 * tokens x price = micro-USD (no division). One rounding at the end.
 */
export function estimateOwnAiMicroUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = ownAiModelPrice(model);
  return Math.round(tokenCount(inputTokens) * price.inputPerM + tokenCount(outputTokens) * price.outputPerM);
}

/** A daily limit in cents as micro-USD (1 cent = 10,000 micro-USD). */
export function ownAiLimitMicroUsd(dailyLimitCents: number): number {
  return dailyLimitCents * 10_000;
}

/** True for a model that spends hidden reasoning tokens (needs more max_tokens and a longer timeout). */
export function isOwnAiReasoningModel(provider: OwnAiProvider, model: string): boolean {
  const rec = OWN_AI_RECOMMENDED_MODELS.find((m) => m.provider === provider && m.model === model);
  if (rec) return rec.reasoning === true;
  const bare = bareOwnAiModelId(model);
  return /^o\d(-|$)|^gpt-5|deepseek-r1|reasoner|thinking|^gemini-2\.5-pro/.test(bare);
}

/** Custodial UsePod deposits: hard bounds and daily SOL fee budget. */
export const OWN_AI_USEPOD_PROGRAM_ID = 'BBAdcqUkg68JXNiPQ1HR1wujfZuayyK3eQTQSYAh6FSW';
export const OWN_AI_USEPOD_DEPOSIT_MIN_CENTS = 10;
export const OWN_AI_USEPOD_DEPOSIT_MAX_CENTS = 5000;
export const USEPOD_DEPOSITS_PER_DAY = 5;
export const OWN_AI_USEPOD_MIN_SOL_LAMPORTS = 15000;
/**
 * ClawVille fee wallet (treasury_wallets purpose 'usepod-fee-payer', founder
 * 2026-11-11). It pays the Solana network fee of a UsePod deposit, so the
 * avatar wallet needs no SOL. ON only while that row exists (no env flag).
 * Global cap: sent sponsored deposits per UTC day, all avatars together.
 */
export const USEPOD_SPONSORED_DEPOSITS_PER_DAY = 200;
/** Sponsored deposits per avatar per UTC day; beyond it the avatar wallet pays (or the deposit is refused). */
export const USEPOD_SPONSORED_DEPOSITS_PER_AVATAR_PER_DAY = 2;
/** The fee wallet must stay rent exempt (890,880 lamports) after the fee, so it sponsors only above this. */
export const USEPOD_FEE_WALLET_MIN_LAMPORTS = 1_000_000;
/** Below this (0.01 SOL) the server logs a warning to refill the fee wallet. */
export const USEPOD_FEE_WALLET_LOW_LAMPORTS = 10_000_000;
