/**
 * Own-AI Provider Plugin for ElizaOS ("own AI" part A, 2026-11-09).
 *
 * A human can power their hosted agent with their OWN AI: an OpenAI, Anthropic
 * or OpenRouter key, or a UsePod token. This plugin serves TEXT_SMALL and
 * TEXT_LARGE for that one runtime at priority 98:
 *
 *   OpenClaw gateway (100) > own AI (98) > InferenceRouter text (95)
 *
 * The OpenClaw gateway and own AI never load together (`eliza-runtime.ts` keeps
 * the gateway and skips own AI). Embeddings stay on the platform provider.
 *
 * Every call:
 *   1. `mayCall(estimate)` (the daily-limit gate) RESERVES the call's worst-case
 *      cost (prompt chars/4 in, max_tokens out) and returns the reservation, or
 *      null when it does not fit under the limit. Null or a throw -> fallback.
 *   2. One POST to the provider (fixed host from the server-side provider spec,
 *      never user-supplied). `redirect: 'manual'` so a 3xx can never carry the
 *      key to another host. One AbortController timeout covers the whole call.
 *   3. Success -> `onUsage(usage, reservation)` (provider usage, else a chars/4
 *      estimate; it settles the reservation) -> text.
 *      Failure -> `onRelease(reservation)` + `onFallback(reason)` -> the ROUTER
 *      handler answers THIS call.
 *
 * SECRET RULES: the key (and the UsePod base URL, which CONTAINS the token)
 * never enter a log line, an error message or the plugin description. Provider
 * error bodies can echo a key, so they are read only to classify a 400 and are
 * never logged. Network errors are logged by `name` only (a fetch error message
 * can contain the request URL).
 */
import { ModelType, type Plugin, type IAgentRuntime, type GenerateTextParams } from '@elizaos/core';
import { isReasoningModel } from '../inference/inference-router';

export type OwnAiPluginFallbackReason =
  | 'daily_limit'
  | 'key_rejected'
  | 'balance_empty'
  | 'provider_error'
  | 'model_unavailable';

export interface OwnAiProviderConfig {
  protocol: 'openai-compat' | 'anthropic';
  /** Fixed provider host (server-side spec). NEVER user-supplied. May contain a UsePod token: never log it. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** max_tokens = max(params.maxTokens ?? 1000, maxTokensFloor). */
  maxTokensFloor: number;
  timeoutMs: number;
  /** Extra request headers (OpenRouter: HTTP-Referer + X-Title). */
  extraHeaders?: Record<string, string>;
  /**
   * Optional (additive to the contract): the model is a reasoning model. Such
   * models reject `temperature` and `stop`, so the plugin omits both. A model id
   * the router already knows as reasoning (gpt-5*, o*) is detected without it.
   */
  reasoning?: boolean;
  /**
   * Budget gate. Reserves the worst-case cost of this call and returns the
   * reservation, or null when it does not fit (-> onFallback('daily_limit') +
   * the router answers). Every non-null reservation is passed back exactly once:
   * to onUsage (the call spent tokens) or to onRelease (it did not).
   */
  mayCall: (estimate: OwnAiCallEstimate) => Promise<OwnAiReservation | null>;
  onUsage: (u: { model: string; inputTokens: number; outputTokens: number }, reservation: OwnAiReservation) => void;
  onRelease: (reservation: OwnAiReservation) => void;
  onFallback: (reason: OwnAiPluginFallbackReason) => void;
}

/** Worst-case token estimate of one call: prompt chars/4 in, max_tokens out. */
export interface OwnAiCallEstimate {
  inputTokens: number;
  outputTokens: number;
}

/** The budget one call holds (micro-USD on the usage row of UTC `day`), returned by mayCall. Opaque to the plugin. */
export interface OwnAiReservation {
  microUsd: number;
  day: string;
}

/** The router text handler (priority 95) that answers a call own AI cannot serve. */
export type OwnAiFallbackHandler = (runtime: IAgentRuntime, params: GenerateTextParams) => Promise<string>;

const DEFAULT_MAX_TOKENS = 1000;
const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/gi;
/** A 400 whose body says the MODEL is the problem (not found / unknown / unsupported). */
const MODEL_ERROR_RE =
  /model_not_found|(?:invalid|unknown|unsupported|unavailable)\s+model|model\b[^.\n]{0,60}\b(?:not\s+found|does\s+not\s+exist|not\s+(?:available|supported)|unavailable|is\s+invalid|invalid)/i;
const REJECTED_PARAM_RE = /Unsupported (?:value|parameter):\s*'([a-z_]+)'/i;

type CallResult =
  | { ok: true; text: string; inputTokens: number; outputTokens: number }
  | { ok: false; reason: Exclude<OwnAiPluginFallbackReason, 'daily_limit'>; status: number | null; detail: string };

function estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Bare model id (strip an OpenRouter-style `vendor/` prefix) for the reasoning check. */
function bareModel(model: string): string {
  const parts = model.split('/');
  return parts[parts.length - 1] ?? model;
}

function isOpenAiHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function classifyStatus(status: number, body: string): Exclude<OwnAiPluginFallbackReason, 'daily_limit'> {
  if (status === 401 || status === 403) return 'key_rejected';
  if (status === 402) return 'balance_empty';
  if (status === 404) return 'model_unavailable';
  if (status === 400 && MODEL_ERROR_RE.test(body)) return 'model_unavailable';
  return 'provider_error';
}

/** OpenAI-compat message content: a string, or an array of text parts. Reasoning fields are ignored. */
function openAiContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
        && ((p as { type?: unknown }).type === undefined || (p as { type?: unknown }).type === 'text')
        ? (p as { text: string }).text
        : ''))
      .join('');
  }
  return '';
}

function finalText(raw: string): string {
  return raw.replace(THINK_TAG_RE, '').trim();
}

function promptOf(params: GenerateTextParams): string {
  return typeof params?.prompt === 'string' ? params.prompt : '';
}

/** max_tokens of one call = max(params.maxTokens ?? 1000, maxTokensFloor). */
function maxTokensFor(cfg: OwnAiProviderConfig, params: GenerateTextParams): number {
  const requested = numberOr(
    (params as { maxTokens?: unknown })?.maxTokens ?? (params as { maxOutputTokens?: unknown })?.maxOutputTokens,
    DEFAULT_MAX_TOKENS,
  );
  return Math.max(requested, numberOr(cfg.maxTokensFloor, 0));
}

async function callProvider(cfg: OwnAiProviderConfig, params: GenerateTextParams, maxTokens: number): Promise<CallResult> {
  const prompt = promptOf(params);
  const reasoning = cfg.reasoning === true || isReasoningModel(bareModel(cfg.model));
  const stop = Array.isArray(params?.stopSequences)
    ? params.stopSequences.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const temperature = typeof params?.temperature === 'number' ? params.temperature : undefined;
  const base = cfg.baseUrl.replace(/\/+$/, '');

  let url: string;
  const headers: Record<string, string> = { ...(cfg.extraHeaders ?? {}), 'Content-Type': 'application/json' };
  const body: Record<string, unknown> = { model: cfg.model, messages: [{ role: 'user', content: prompt }] };

  if (cfg.protocol === 'anthropic') {
    url = `${base}/v1/messages`;
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body.max_tokens = maxTokens;
    if (!reasoning) {
      if (temperature !== undefined) body.temperature = Math.min(Math.max(temperature, 0), 1);
      if (stop.length > 0) body.stop_sequences = stop;
    }
  } else {
    url = `${base}/chat/completions`;
    headers.Authorization = `Bearer ${cfg.apiKey}`;
    // OpenAI's own API wants max_completion_tokens (reasoning models reject
    // max_tokens); OpenRouter and UsePod take the classic max_tokens.
    if (isOpenAiHost(base)) body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
    if (!reasoning) {
      if (temperature !== undefined) body.temperature = temperature;
      if (stop.length > 0) body.stop = stop;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, numberOr(cfg.timeoutMs, 20_000)));
  try {
    let res: Response;
    let strippedParams = 0;
    // A model may reject `temperature` / `stop` with a 400: strip the named param
    // and retry (max 2), the same rule the router uses for OpenAI.
    while (true) {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (res.status >= 200 && res.status < 300) break;
      const errBody = await res.text().catch(() => '');
      if (res.status === 400 && strippedParams < 2) {
        let rejected: string | undefined;
        try {
          const parsed = JSON.parse(errBody) as { error?: { param?: unknown } };
          if (typeof parsed.error?.param === 'string') rejected = parsed.error.param;
        } catch {
          // fall through to the message pattern
        }
        rejected ??= REJECTED_PARAM_RE.exec(errBody)?.[1];
        const key = rejected === 'stop' && cfg.protocol === 'anthropic' ? 'stop_sequences' : rejected;
        if (
          key &&
          (key === 'temperature' || key === 'stop' || key === 'stop_sequences' || key === 'top_p') &&
          Object.prototype.hasOwnProperty.call(body, key)
        ) {
          delete body[key];
          strippedParams++;
          continue;
        }
      }
      return { ok: false, reason: classifyStatus(res.status, errBody), status: res.status, detail: 'http' };
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { ok: false, reason: 'provider_error', status: res.status, detail: 'bad_json' };
    }

    let raw = '';
    let inTok: unknown;
    let outTok: unknown;
    if (cfg.protocol === 'anthropic') {
      const d = data as { content?: Array<{ type?: string; text?: unknown }>; usage?: Record<string, unknown> };
      raw = Array.isArray(d?.content)
        ? d.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('')
        : '';
      inTok = d?.usage?.input_tokens;
      outTok = d?.usage?.output_tokens;
    } else {
      const d = data as { choices?: Array<{ message?: { content?: unknown } }>; usage?: Record<string, unknown> };
      raw = openAiContentText(d?.choices?.[0]?.message?.content);
      inTok = d?.usage?.prompt_tokens;
      outTok = d?.usage?.completion_tokens;
    }
    const text = finalText(raw);
    return {
      ok: true,
      text,
      inputTokens: numberOr(inTok, estimateTokens(prompt)),
      outputTokens: numberOr(outTok, estimateTokens(raw)),
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'unknown';
    return { ok: false, reason: 'provider_error', status: null, detail: name === 'AbortError' ? 'timeout' : `network:${name}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates the own-AI plugin (priority 98). `fallback` is the router's TEXT_SMALL
 * handler captured at construction in `eliza-runtime.ts` (NOT `useModel`, which
 * would re-enter this plugin). `fallbackLarge` (optional, additive) is the
 * router's TEXT_LARGE handler; absent -> `fallback` serves both sizes.
 * Never throws at construct.
 */
export function createOwnAiProviderPlugin(
  cfg: OwnAiProviderConfig,
  fallback: OwnAiFallbackHandler,
  fallbackLarge?: OwnAiFallbackHandler,
): Plugin {
  const signalFallback = (reason: OwnAiPluginFallbackReason): void => {
    try {
      cfg.onFallback(reason);
    } catch {
      // a callback failure must never break the call
    }
  };

  const makeHandler =
    (size: 'small' | 'large') =>
    async (runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> => {
      const fb = size === 'large' && fallbackLarge ? fallbackLarge : fallback;

      const maxTokens = maxTokensFor(cfg, params);
      let reservation: OwnAiReservation | null = null;
      let gateThrew = false;
      try {
        const r = await cfg.mayCall({ inputTokens: estimateTokens(promptOf(params)), outputTokens: maxTokens });
        reservation = r && typeof r === 'object' ? r : null;
      } catch {
        gateThrew = true;
      }
      if (!reservation) {
        signalFallback(gateThrew ? 'provider_error' : 'daily_limit');
        return fb(runtime, params);
      }

      let result: CallResult;
      try {
        result = await callProvider(cfg, params, maxTokens);
      } catch {
        // callProvider catches its own errors; this guards the reservation anyway.
        result = { ok: false, reason: 'provider_error', status: null, detail: 'unexpected' };
      }
      if (result.ok) {
        try {
          cfg.onUsage({ model: cfg.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens }, reservation);
        } catch {
          // metering failure must never break the call
        }
        if (result.text.length > 0) return result.text;
        // Tokens were spent but no final text (e.g. a reasoning model used the
        // whole budget on reasoning): the router answers this call.
        console.warn(`[OwnAI] empty reply (model=${cfg.model}); ClawVille AI answers this call`);
        signalFallback('provider_error');
        return fb(runtime, params);
      }

      console.warn(
        `[OwnAI] call failed reason=${result.reason} status=${result.status ?? 'none'} detail=${result.detail}; ClawVille AI answers this call`,
      );
      try {
        cfg.onRelease(reservation);
      } catch {
        // a release failure must never break the call
      }
      signalFallback(result.reason);
      return fb(runtime, params);
    };

  return {
    name: 'own-ai-provider',
    description: `Own AI text generation (${cfg.protocol}, priority 98)`,
    models: {
      [ModelType.TEXT_SMALL]: makeHandler('small'),
      [ModelType.TEXT_LARGE]: makeHandler('large'),
    },
    priority: 98,
  };
}
