/**
 * InferenceRouter — the single text-generation router for ClawVille.
 *
 * Replaces the lazy global `OPENAI_BASE_URL` env hack that pointed ALL text
 * inference at ONE URL (misnamed "OpenAI" but aimed at a local box, no failover,
 * could not keep teachers on OpenAI while the fleet ran local, and could not use
 * two local boxes). This class instead manages N NAMED endpoints — each with its
 * OWN url / model / auth — routes each CONSUMER CLASS (teacher, fleet,
 * hosted-user, default) to an ORDERED preference list of endpoints, and fails
 * over between them with a per-endpoint circuit breaker.
 *
 * Framework-agnostic on purpose: NO ElizaOS / Hono / Drizzle import. The ElizaOS
 * text plugin (`openai-text-provider`) and the apps/api NPC banter engine both
 * delegate here through the shared singleton (`getInferenceRouter`, in
 * `inference-config.ts`), so there is exactly ONE inference surface per box.
 *
 * Wire format is OpenAI chat/completions — the same shape Ollama's `/v1`
 * OpenAI-compatibility endpoint speaks — so `openai` and a local `qwen3` box are
 * driven by identical request code, differing only in url + model + auth.
 */

/** Consumer classes. Each maps (in config) to an ordered endpoint preference list. */
export type InferenceRoute = 'teacher' | 'fleet' | 'hosted-user' | 'default';

/** Which model preset of an endpoint to use for this call. */
export type InferenceSize = 'small' | 'large';

export interface InferenceEndpoint {
  /** Stable id referenced by the route table, e.g. 'openai' | 'local-primary'. */
  id: string;
  /** Base URL WITHOUT trailing slash; '/chat/completions' is appended. */
  baseUrl: string;
  /** Bearer token (OpenAI). Local Ollama needs none. Cloud endpoints fall back to
   *  `process.env.OPENAI_API_KEY` at request time if this is unset. */
  apiKey?: string;
  smallModel: string;
  largeModel: string;
  kind: 'cloud' | 'local';
  /** Per-request abort budget. A hung box must time out so failover can proceed. */
  timeoutMs: number;
  /** Strip `<think>…</think>` reasoning blocks from responses (qwen3 et al.).
   *  Defaults to true for `kind:'local'`, false for cloud. */
  stripThinkTags?: boolean;
  /**
   * Wire protocol.
   *   'openai' → POST `{baseUrl}/chat/completions` (OpenAI chat-completions).
   *   'ollama' → POST `{baseUrl−/v1}/api/chat` with `think:false`, which DISABLES
   *              qwen3's reasoning trace. This is load-bearing for the fleet: on a
   *              complex decide() prompt qwen3 spends its whole token budget inside
   *              `<think>` (verified >50s, well past the driver's 15s timeout → the
   *              decision comes back empty). With `think:false` the same box answers
   *              a valid `[ACTION:]` in ~2s.
   * Defaults to 'openai'. Local Ollama endpoints default to 'ollama' in config.
   */
  provider?: 'openai' | 'ollama';
  /**
   * Ollama `keep_alive` — how long the box keeps this model resident after a
   * request. Keeps both fleet boxes WARM between driver ticks so failover/
   * distribution is instant (no cold-load). String ('60m'), seconds, or -1
   * (never unload). Only sent on the ollama wire. Default from config ('60m').
   */
  keepAlive?: string | number;
}

export interface InferenceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateArgs {
  route: InferenceRoute;
  size: InferenceSize;
  messages: InferenceMessage[];
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  /** Per-call abort budget override (ms). Used by warmup() to allow a slow cold
   *  model-load without inheriting the tight per-request timeout. */
  timeoutMs?: number;
}

export interface GenerateResult {
  text: string;
  /** Which endpoint actually produced the text (after any failover). */
  endpointId: string;
}

export interface BreakerConfig {
  /** Consecutive failures that OPEN an endpoint's breaker. */
  failThreshold: number;
  /** How long a breaker stays open before allowing one half-open probe. */
  cooldownMs: number;
}

export type RouteTable = Record<InferenceRoute, string[]>;

export interface EndpointStats {
  id: string;
  kind: 'cloud' | 'local';
  requests: number;
  successes: number;
  failures: number;
  lastLatencyMs: number;
  breakerOpen: boolean;
  consecutiveFailures: number;
  /** Requests currently in flight (primary-preferred-overflow saturation signal). */
  inflight: number;
  lastError?: string;
}

interface EndpointState {
  consecutiveFailures: number;
  /** ms epoch the breaker stays open until; 0 = closed. */
  openUntil: number;
  /** true while a single half-open probe is in flight (blocks a probe stampede). */
  probeInFlight: boolean;
  /** Requests currently awaiting a response from this endpoint. Drives the
   * primary-preferred-overflow policy: a later local only takes work while an
   * earlier local's inflight ≥ primaryMaxInflight (or its breaker is open). */
  inflight: number;
  requests: number;
  successes: number;
  failures: number;
  lastLatencyMs: number;
  lastError?: string;
}

const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/gi;

interface OpenAIChatResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface OllamaChatResponse {
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Per-call token usage as reported by the provider (2026-07-13 OpenAI-usage
 * audit: paid OpenAI calls were INVISIBLE in our own logs — the burn had to
 * be reconstructed from side effects; every served request now logs tokens).
 * Fields are null when the provider omitted usage data.
 */
interface CallUsage {
  inTokens: number | null;
  outTokens: number | null;
}

interface CallResult {
  text: string;
  usage: CallUsage;
}

export class InferenceRouter {
  private readonly endpoints: Map<string, InferenceEndpoint>;
  private readonly routes: RouteTable;
  private readonly breaker: BreakerConfig;
  private readonly state = new Map<string, EndpointState>();
  // Saturation cap for the primary-preferred-overflow policy (see generate()).
  private readonly primaryMaxInflight: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: {
    endpoints: InferenceEndpoint[];
    routes: RouteTable;
    breaker?: Partial<BreakerConfig>;
    /** In-flight requests an earlier local absorbs before work overflows to the
     *  next local (primary-preferred-overflow). Default 3. */
    primaryMaxInflight?: number;
    /** Injectable for tests. */
    fetchImpl?: typeof fetch;
    /** Injectable clock for tests. */
    now?: () => number;
  }) {
    this.endpoints = new Map(opts.endpoints.map((e) => [e.id, e]));
    this.routes = opts.routes;
    this.breaker = {
      failThreshold: opts.breaker?.failThreshold ?? 3,
      cooldownMs: opts.breaker?.cooldownMs ?? 30_000,
    };
    this.primaryMaxInflight = Math.max(1, opts.primaryMaxInflight ?? 3);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    for (const e of opts.endpoints) {
      this.state.set(e.id, {
        consecutiveFailures: 0,
        openUntil: 0,
        probeInFlight: false,
        inflight: 0,
        requests: 0,
        successes: 0,
        failures: 0,
        lastLatencyMs: 0,
      });
    }
  }

  hasEndpoint(id: string): boolean {
    return this.endpoints.has(id);
  }

  /**
   * Pre-load every LOCAL model so the boxes are WARM before the first real
   * decision (avoids the cold-start timeout on boot/restart). Fire-and-forget +
   * fault-tolerant: a down box just fails silently (the breaker handles it later).
   * Bypasses the breaker/round-robin — it hits each local endpoint directly with a
   * tiny request that loads the model and sets keep_alive. Never throws.
   */
  async warmup(): Promise<void> {
    const locals = [...this.endpoints.values()].filter(
      (e) => e.kind === 'local' || (e.provider ?? 'openai') === 'ollama',
    );
    await Promise.allSettled(
      locals.map((ep) =>
        this.callEndpoint(ep, {
          route: 'fleet',
          size: 'small',
          messages: [{ role: 'user', content: 'warmup' }],
          maxTokens: 1,
          // Generous budget — a cold 27B load is ~48s, well past the 60s request
          // timeout under boot load; the warmup is off the decision path so it can
          // afford to wait for the load to complete + cache.
          timeoutMs: 180_000,
        }).catch(() => undefined),
      ),
    );
  }

  /**
   * Generate text for a consumer class. Walks the route's ordered endpoint list,
   * skipping endpoints whose breaker is open (except the LAST endpoint, which is
   * the designated last-resort and is ALWAYS attempted so a cooldown window can
   * never cause a total inference blackout). Returns on the first success;
   * throws the last error only if EVERY endpoint in the route failed.
   */
  async generateText(args: GenerateArgs): Promise<GenerateResult> {
    const configured = (this.routes[args.route] ?? this.routes.default ?? []).filter((id) =>
      this.endpoints.has(id),
    );
    // Defensive: if a route somehow resolved empty, fall back to any endpoint.
    let ids = configured.length > 0 ? configured : [...this.endpoints.keys()].slice(0, 1);
    if (ids.length === 0) {
      throw new Error('[InferenceRouter] no endpoints configured');
    }

    // PRIMARY-PREFERRED-OVERFLOW (2026-07-07 founder ruling; replaces the old
    // per-request round-robin): when a route has ≥2 LOCAL endpoints, the FIRST
    // local in the route list is THE primary — it is maxed out and kept hot —
    // and a later local takes work ONLY while an earlier one is saturated
    // (in-flight ≥ primaryMaxInflight) or its breaker is open. Route-list order
    // is the preference order: set INFERENCE_ROUTE_* so the big box (the
    // 7900 XTX / 27b) is listed first. When EVERY local is saturated we keep
    // the preference order so extra load queues on the primary rather than
    // stampeding the overflow box. Cloud/fallback endpoints keep their terminal
    // position (OpenAI stays last).
    const locals = ids.filter((id) => this.endpoints.get(id)!.kind === 'local');
    if (locals.length >= 2) {
      const rest = ids.filter((id) => this.endpoints.get(id)!.kind !== 'local');
      const nowSel = this.now();
      let startIdx = locals.findIndex((id) => {
        const st = this.state.get(id)!;
        return st.inflight < this.primaryMaxInflight && this.canAttempt(st, nowSel);
      });
      if (startIdx < 0) startIdx = 0;
      ids = [...locals.slice(startIdx), ...locals.slice(0, startIdx), ...rest];
    }

    let lastErr: Error | null = null;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const ep = this.endpoints.get(id)!;
      const st = this.state.get(id)!;
      const isLast = i === ids.length - 1;
      const now = this.now();

      // Breaker gate — earlier endpoints are skipped while open (outside the
      // half-open probe window, and only ONE probe at a time). The last-resort
      // endpoint bypasses the gate so inference never hard-fails during a cooldown.
      if (!isLast && !this.canAttempt(st, now)) continue;

      const isHalfOpenProbe = st.openUntil !== 0 && now >= st.openUntil;
      if (isHalfOpenProbe) st.probeInFlight = true;

      const start = this.now();
      st.inflight++;
      try {
        const { text, usage } = await this.callEndpoint(ep, args);
        this.recordSuccess(st, this.now() - start);
        // Ops receipt for EVERY served request — cloud included (2026-07-13
        // OpenAI-usage audit: cloud calls were previously silent, so paid
        // volume was invisible in our own logs). One compact greppable line
        // per call: `grep "\[InferenceRouter\] served"` = the full inference
        // ledger; sum in=/out= per by=openai for spend.
        const model = args.size === 'large' ? ep.largeModel : ep.smallModel;
        console.log(
          `[InferenceRouter] served route=${args.route} by=${id} model=${model} in=${usage.inTokens ?? '?'} out=${usage.outTokens ?? '?'} inflight=${st.inflight - 1} ${this.now() - start}ms`,
        );
        return { text, endpointId: id };
      } catch (err) {
        this.recordFailure(st, err, this.now() - start);
        lastErr = err instanceof Error ? err : new Error(String(err));
        // Per-attempt failure receipt (message truncated) — failover to the
        // next endpoint used to be silent unless ALL endpoints failed.
        console.warn(
          `[InferenceRouter] attempt failed route=${args.route} by=${id} ${this.now() - start}ms: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`,
        );
        // fall through to the next endpoint
      } finally {
        st.inflight--;
        st.probeInFlight = false;
      }
    }

    throw lastErr ?? new Error(`[InferenceRouter] all endpoints failed for route "${args.route}"`);
  }

  /** Snapshot of per-endpoint health + counters (for /dash or boot logging). */
  stats(): EndpointStats[] {
    const now = this.now();
    const out: EndpointStats[] = [];
    for (const [id, ep] of this.endpoints) {
      const st = this.state.get(id)!;
      out.push({
        id,
        kind: ep.kind,
        requests: st.requests,
        successes: st.successes,
        failures: st.failures,
        lastLatencyMs: st.lastLatencyMs,
        breakerOpen: st.openUntil !== 0 && now < st.openUntil,
        consecutiveFailures: st.consecutiveFailures,
        inflight: st.inflight,
        lastError: st.lastError,
      });
    }
    return out;
  }

  private canAttempt(st: EndpointState, now: number): boolean {
    if (st.openUntil === 0) return true; // closed
    if (now >= st.openUntil) return !st.probeInFlight; // half-open: one probe only
    return false; // open
  }

  private async callEndpoint(ep: InferenceEndpoint, args: GenerateArgs): Promise<CallResult> {
    return (ep.provider ?? 'openai') === 'ollama'
      ? this.callOllamaNative(ep, args)
      : this.callOpenAICompat(ep, args);
  }

  private async callOpenAICompat(ep: InferenceEndpoint, args: GenerateArgs): Promise<CallResult> {
    const model = args.size === 'large' ? ep.largeModel : ep.smallModel;
    // Cloud endpoints re-read OPENAI_API_KEY at REQUEST time so a key set after the
    // router singleton was built (e.g. ElizaRuntime.start stamping it into env) is
    // still honored. Local endpoints usually need no auth.
    const apiKey = ep.apiKey ?? (ep.kind === 'cloud' ? process.env.OPENAI_API_KEY : undefined);
    if (ep.kind === 'cloud' && !apiKey) {
      throw new Error(`[InferenceRouter:${ep.id}] missing OPENAI_API_KEY`);
    }

    const body: Record<string, unknown> = {
      model,
      messages: args.messages,
      temperature: args.temperature ?? 0.7,
      // max_completion_tokens (not the deprecated max_tokens) — the current OpenAI
      // param, also accepted by Ollama's OpenAI-compat endpoint (proven on johns-pc).
      max_completion_tokens: args.maxTokens ?? 1000,
    };
    if (args.stopSequences && args.stopSequences.length > 0) body.stop = args.stopSequences;

    const res = await this.fetchImpl(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(args.timeoutMs ?? ep.timeoutMs),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(
        `[InferenceRouter:${ep.id}] ${res.status} ${res.statusText}: ${errBody.slice(0, 300)}`,
      );
    }

    const data = (await res.json()) as OpenAIChatResponse;
    const choice = data.choices?.[0];
    if (!choice) throw new Error(`[InferenceRouter:${ep.id}] no choices in response`);
    return {
      text: this.finalizeText(ep, choice.message?.content ?? '', `finish_reason=${choice.finish_reason}`),
      usage: {
        inTokens: data.usage?.prompt_tokens ?? null,
        outTokens: data.usage?.completion_tokens ?? null,
      },
    };
  }

  /**
   * Ollama-native wire: POST {baseUrl−/v1}/api/chat with `think:false`. The
   * think-disable is the whole reason this path exists (see the `provider` docs on
   * InferenceEndpoint): it turns a >50s empty qwen3 decide() into a ~2s valid one.
   */
  private async callOllamaNative(ep: InferenceEndpoint, args: GenerateArgs): Promise<CallResult> {
    const model = args.size === 'large' ? ep.largeModel : ep.smallModel;
    const base = ep.baseUrl.replace(/\/v1\/?$/, '');
    const options: Record<string, unknown> = {
      temperature: args.temperature ?? 0.7,
      num_predict: args.maxTokens ?? 1000,
    };
    if (args.stopSequences && args.stopSequences.length > 0) options.stop = args.stopSequences;

    const res = await this.fetchImpl(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: args.messages,
        stream: false,
        think: false,
        // Keep the model resident between driver ticks so the box stays WARM.
        keep_alive: ep.keepAlive ?? '60m',
        options,
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? ep.timeoutMs),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(
        `[InferenceRouter:${ep.id}] ${res.status} ${res.statusText}: ${errBody.slice(0, 300)}`,
      );
    }

    const data = (await res.json()) as OllamaChatResponse;
    return {
      text: this.finalizeText(ep, data.message?.content ?? '', `done_reason=${data.done_reason}`),
      usage: {
        inTokens: data.prompt_eval_count ?? null,
        outTokens: data.eval_count ?? null,
      },
    };
  }

  private finalizeText(ep: InferenceEndpoint, raw: string, ctx: string): string {
    let text = raw;
    // Belt-and-suspenders: with think:false there is nothing to strip, but a
    // stray `<think>` block (or an openai-compat local model) is still cleaned.
    const stripThink = ep.stripThinkTags ?? ep.kind === 'local';
    if (stripThink && text) text = text.replace(THINK_TAG_RE, '').trim();
    if (!text) throw new Error(`[InferenceRouter:${ep.id}] empty content (${ctx})`);
    return text;
  }

  private recordSuccess(st: EndpointState, latencyMs: number): void {
    st.consecutiveFailures = 0;
    st.openUntil = 0;
    st.requests += 1;
    st.successes += 1;
    st.lastLatencyMs = latencyMs;
    st.lastError = undefined;
  }

  private recordFailure(st: EndpointState, err: unknown, latencyMs: number): void {
    st.consecutiveFailures += 1;
    st.requests += 1;
    st.failures += 1;
    st.lastLatencyMs = latencyMs;
    st.lastError = err instanceof Error ? err.message : String(err);
    if (st.consecutiveFailures >= this.breaker.failThreshold) {
      // Compute the open deadline from a FRESH clock read — NOT the pre-await
      // loop-top `now`. On a hung box the call can outlast cooldownMs (e.g. a 60s
      // timeout with a 30s cooldown), so a stale timestamp would place openUntil
      // in the PAST and the breaker would immediately read as half-open, re-probing
      // the dead box every request and never actually skipping it.
      st.openUntil = this.now() + this.breaker.cooldownMs;
    }
  }
}
