/**
 * Inference config — builds the endpoint set + route table + the shared
 * `InferenceRouter` singleton from environment variables, with safe baked
 * defaults. Same code, per-box config: unset everything ⇒ pure OpenAI (identical
 * to the pre-router behavior).
 *
 * Env surface (all optional unless noted):
 *   OPENAI_API_KEY                        the `openai` endpoint bearer (required for cloud calls)
 *   OPENAI_SMALL_MODEL / OPENAI_LARGE_MODEL   openai endpoint models (default gpt-4o-mini / gpt-4o)
 *   INFERENCE_LOCAL_PRIMARY_URL           e.g. http://<host>:11434/v1  → adds 'local-primary'
 *   INFERENCE_LOCAL_PRIMARY_MODEL         default qwen3:14b (per-size override *_SMALL_MODEL/*_LARGE_MODEL)
 *   INFERENCE_LOCAL_PRIMARY_KEY           optional bearer (e.g. a Caddy auth proxy)
 *   INFERENCE_LOCAL_SECONDARY_URL/_MODEL/_KEY   → adds 'local-secondary' (default qwen3.6:27b)
 *   INFERENCE_ROUTE_TEACHER / _FLEET / _HOSTED_USER / _DEFAULT   CSV of endpoint ids (override defaults)
 *   INFERENCE_CLOUD_TIMEOUT_MS / INFERENCE_LOCAL_TIMEOUT_MS      per-request abort budget (default 60000)
 *   INFERENCE_FAIL_THRESHOLD / INFERENCE_COOLDOWN_MS            breaker tuning (default 3 / 30000)
 *   INFERENCE_PRIMARY_MAX_INFLIGHT   primary-preferred-overflow saturation cap (default 3):
 *       route-list order is the PREFERENCE order; the FIRST local in a route absorbs
 *       everything until it holds this many in-flight requests (or its breaker opens),
 *       and only then does work spill to the next local. Put the 7900 XTX box first.
 */

import {
  InferenceRouter,
  type InferenceEndpoint,
  type InferenceRoute,
  type RouteTable,
} from './inference-router';

type Env = Record<string, string | undefined>;

function trimUrl(u: string): string {
  return u.replace(/\/+$/, '');
}

function numEnv(v: string | undefined, dflt: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function parseCsv(v: string | undefined): string[] | null {
  if (!v) return null;
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

/**
 * Map a `platform_agents.type` (+ house flag) to its inference route.
 *   location-agent  → teacher     (the 10 building residents → OpenAI)
 *   system-agent    → teacher     (Nori + world-wide system NPCs → OpenAI)
 *   house fixture   → fleet       (our hosted autonomous agents → local boxes)
 *   avatar-agent    → hosted-user (user companion avatars → OpenAI now, flippable)
 *   openclaw-bot    → hosted-user (connected/hosted user agents, non-house → OpenAI now)
 *   anything else   → default     (OpenAI)
 *
 * Teacher isolation is STRUCTURAL, not by convention (H1): the type check runs
 * FIRST, so a `location-agent`/`system-agent` can NEVER resolve to `fleet` (→ a
 * local box) even if some future data bug flags a teacher `isHouse`. The house
 * flag only decides between the NON-teacher routes.
 */
export function resolveInferenceRoute(
  agentDbType: string | null | undefined,
  isHouse: boolean,
): InferenceRoute {
  // Teachers first — never fleet, regardless of the house flag.
  switch (agentDbType) {
    case 'location-agent':
    case 'system-agent':
      return 'teacher';
  }
  if (isHouse) return 'fleet';
  switch (agentDbType) {
    case 'avatar-agent':
    case 'openclaw-bot':
      return 'hosted-user';
    default:
      return 'default';
  }
}

function localProvider(v: string | undefined): 'openai' | 'ollama' {
  return v === 'openai' ? 'openai' : 'ollama';
}

// keep_alive: numeric (incl. -1 = never unload) passed as a number; a duration
// string ('60m') passed through; default '60m' keeps both boxes warm between ticks.
function keepAliveEnv(v: string | undefined): string | number {
  if (!v) return '60m';
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

export function buildEndpointsFromEnv(env: Env = process.env): InferenceEndpoint[] {
  const cloudTimeout = numEnv(env.INFERENCE_CLOUD_TIMEOUT_MS, 60_000);
  // Local default 60s. It MUST outlast a cold model-load (johns-pc restart re-warms
  // the 14b in ~8-10s; a .223.14 failover cold-loads the 27b in ~20-25s): Ollama
  // CANCELS an in-flight load when the client aborts, so a shorter timeout kills the
  // load before it finishes → the box never warms → the breaker re-opens forever
  // (observed with a 12s cutoff). 60s lets the load complete + cache, so the box
  // self-heals. A DOWN box still fails over fast (ECONNREFUSED, not a timeout), and
  // the autonomy driver's own 15s decide() timeout bounds user-facing latency.
  const localTimeout = numEnv(env.INFERENCE_LOCAL_TIMEOUT_MS, 60_000);

  const endpoints: InferenceEndpoint[] = [];

  // 'openai' — ALWAYS present, the reliable last-resort. Its apiKey is also
  // re-read from env at request time by the router, so a late-set key still works.
  endpoints.push({
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: env.OPENAI_API_KEY,
    smallModel: env.OPENAI_SMALL_MODEL ?? 'gpt-4o-mini',
    largeModel: env.OPENAI_LARGE_MODEL ?? 'gpt-4o',
    kind: 'cloud',
    timeoutMs: cloudTimeout,
  });

  if (env.INFERENCE_LOCAL_PRIMARY_URL) {
    const model = env.INFERENCE_LOCAL_PRIMARY_MODEL ?? 'qwen3:14b';
    endpoints.push({
      id: 'local-primary',
      baseUrl: trimUrl(env.INFERENCE_LOCAL_PRIMARY_URL),
      apiKey: env.INFERENCE_LOCAL_PRIMARY_KEY || undefined,
      smallModel: env.INFERENCE_LOCAL_PRIMARY_SMALL_MODEL ?? model,
      largeModel: env.INFERENCE_LOCAL_PRIMARY_LARGE_MODEL ?? model,
      kind: 'local',
      timeoutMs: localTimeout,
      stripThinkTags: true,
      provider: localProvider(env.INFERENCE_LOCAL_PRIMARY_PROVIDER),
      keepAlive: keepAliveEnv(env.INFERENCE_LOCAL_KEEP_ALIVE),
    });
  }

  if (env.INFERENCE_LOCAL_SECONDARY_URL) {
    const model = env.INFERENCE_LOCAL_SECONDARY_MODEL ?? 'qwen3.6:27b';
    endpoints.push({
      id: 'local-secondary',
      baseUrl: trimUrl(env.INFERENCE_LOCAL_SECONDARY_URL),
      apiKey: env.INFERENCE_LOCAL_SECONDARY_KEY || undefined,
      smallModel: env.INFERENCE_LOCAL_SECONDARY_SMALL_MODEL ?? model,
      largeModel: env.INFERENCE_LOCAL_SECONDARY_LARGE_MODEL ?? model,
      kind: 'local',
      timeoutMs: localTimeout,
      stripThinkTags: true,
      provider: localProvider(env.INFERENCE_LOCAL_SECONDARY_PROVIDER),
      keepAlive: keepAliveEnv(env.INFERENCE_LOCAL_KEEP_ALIVE),
    });
  }

  return endpoints;
}

export function buildRouteTableFromEnv(endpoints: InferenceEndpoint[], env: Env = process.env): RouteTable {
  const existingIds = new Set(endpoints.map((e) => e.id));
  const kindOf = new Map(endpoints.map((e) => [e.id, e.kind]));
  const localIds = ['local-primary', 'local-secondary'].filter((id) => existingIds.has(id));

  // Conservative code defaults — ONLY the fleet uses local (founder directive:
  // "residents stay on OpenAI; only the house agents test local"). Every other
  // route is OpenAI-only until deliberately flipped via INFERENCE_ROUTE_*.
  const defaults: RouteTable = {
    teacher: ['openai'],
    fleet: [...localIds, 'openai'],
    'hosted-user': ['openai'],
    default: ['openai'],
  };

  const overrides: Record<InferenceRoute, string[] | null> = {
    teacher: parseCsv(env.INFERENCE_ROUTE_TEACHER),
    fleet: parseCsv(env.INFERENCE_ROUTE_FLEET),
    'hosted-user': parseCsv(env.INFERENCE_ROUTE_HOSTED_USER),
    default: parseCsv(env.INFERENCE_ROUTE_DEFAULT),
  };

  const routeKeys: InferenceRoute[] = ['teacher', 'fleet', 'hosted-user', 'default'];
  const table = {} as RouteTable;
  for (const route of routeKeys) {
    const chosen = overrides[route] ?? defaults[route];
    let ids = chosen.filter((id) => existingIds.has(id));
    // L1 — teacher isolation is NOT env-overridable: strip any local endpoint from
    // the teacher route even if env tried to add one. The founder invariant
    // (residents/system NPCs stay on OpenAI) must be impossible to misconfigure.
    if (route === 'teacher') {
      const before = ids.length;
      ids = ids.filter((id) => kindOf.get(id) !== 'local');
      if (ids.length !== before) {
        console.warn(
          '[InferenceRouter] stripped local endpoint(s) from the teacher route — teachers stay on OpenAI (not env-overridable).',
        );
      }
    }
    if (ids.length === 0) {
      ids = existingIds.has('openai') ? ['openai'] : [...existingIds].slice(0, 1);
    }
    // Guarantee OpenAI is the ultimate fallback so inference never total-blackouts
    // when a local box is down. (openai always exists — its baseUrl is hardcoded.)
    if (existingIds.has('openai') && !ids.includes('openai')) ids = [...ids, 'openai'];
    // L3 — de-dupe so a repeated id (e.g. INFERENCE_ROUTE_*=openai,openai) is not
    // attempted twice.
    table[route] = [...new Set(ids)];
  }
  return table;
}

export function buildInferenceRouterFromEnv(env: Env = process.env): InferenceRouter {
  const endpoints = buildEndpointsFromEnv(env);
  const routes = buildRouteTableFromEnv(endpoints, env);
  return new InferenceRouter({
    endpoints,
    routes,
    breaker: {
      failThreshold: numEnv(env.INFERENCE_FAIL_THRESHOLD, 3),
      cooldownMs: numEnv(env.INFERENCE_COOLDOWN_MS, 30_000),
    },
    // Primary-preferred-overflow saturation cap: in-flight requests the FIRST
    // local in a route absorbs before work spills to the next local. Route-list
    // order is the preference order (put the 7900 XTX box first).
    primaryMaxInflight: numEnv(env.INFERENCE_PRIMARY_MAX_INFLIGHT, 3),
  });
}

/** One-line, secrets-free description for boot logging. */
export function describeInferenceConfig(env: Env = process.env): string {
  const endpoints = buildEndpointsFromEnv(env);
  const routes = buildRouteTableFromEnv(endpoints, env);
  const epDesc = endpoints
    .map((e) => `${e.id}(${e.kind}${e.kind === 'local' ? `:${e.smallModel}` : ''})`)
    .join(', ');
  const rtDesc = (['teacher', 'fleet', 'hosted-user', 'default'] as InferenceRoute[])
    .map((r) => `${r}→[${routes[r].join(',')}]`)
    .join('  ');
  return `[InferenceRouter] endpoints: ${epDesc} | routes: ${rtDesc}`;
}

// --- Lazily-built shared singleton (one breaker/meter per box) --------------
let singleton: InferenceRouter | null = null;

/**
 * The shared router. Built lazily on first use so a key or URL set after module
 * load (e.g. ElizaRuntime.start stamping OPENAI_API_KEY into env) is picked up.
 */
export function getInferenceRouter(): InferenceRouter {
  if (!singleton) singleton = buildInferenceRouterFromEnv();
  return singleton;
}

/** Test-only: drop the cached singleton so the next getInferenceRouter re-reads env. */
export function __resetInferenceRouter(): void {
  singleton = null;
}
