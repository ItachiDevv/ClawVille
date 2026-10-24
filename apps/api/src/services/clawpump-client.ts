import { z } from 'zod';

/** Read-only ClawPump REST client. It has NO write or swap method, and it never logs. */
// ClawPump moved its REST API to clawpump.tech under /api/v1 (2026-10-23). The old Railway host
// returns 404 on every path. agents.clawpump.tech only redirects here, so it is NOT an allowed host.
export const CLAWPUMP_DEFAULT_API_BASE_URL = 'https://clawpump.tech/api/v1';
export const CLAWPUMP_ALLOWED_API_HOSTS: ReadonlySet<string> = new Set(['clawpump.tech']);
export const CLAWPUMP_API_BASE_PATH = '/api/v1';
export const CLAWPUMP_DEFAULT_TIMEOUT_MS = 15_000;
const CLAWPUMP_MIN_TIMEOUT_MS = 1_000;
const CLAWPUMP_MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_AGENTS = 200;

export type ClawPumpClientErrorCode =
  | 'not_configured' | 'invalid_base_url' | 'invalid_agent_id' | 'unauthorized' | 'not_found'
  | 'http_error' | 'timeout' | 'network_error' | 'response_too_large' | 'schema_invalid';

export class ClawPumpClientError extends Error {
  constructor(readonly code: ClawPumpClientErrorCode, readonly status: number | null = null) {
    // The message carries only the code and HTTP status: never the key, URL query, or body.
    super(`clawpump_${code}${status === null ? '' : `_${status}`}`);
    this.name = 'ClawPumpClientError';
  }
}

export class ClawPumpAgentMismatchError extends ClawPumpClientError {
  constructor() {
    super('schema_invalid');
  }
}

export interface ClawPumpAgent {
  id: string;
  userId: string | null;
  name: string | null;
  status: string | null;
  walletAddress: string | null;
}

export interface ClawPumpAgentReader {
  listAgents(): Promise<ClawPumpAgent[]>;
  getAgent(agentId: string): Promise<ClawPumpAgent>;
}

export interface ClawPumpClientOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

// Vendor wire: type and bound only the fields ClawVille reads; pass the rest through.
const agentWire = z.object({
  id: z.string().min(1).max(128),
  user_id: z.string().min(1).max(128).nullish(),
  name: z.string().max(200).nullish(),
  status: z.string().max(40).nullish(),
  wallet_address: z.string().max(64).nullish(),
}).passthrough();
const listWire = z.union([
  z.array(agentWire).max(MAX_AGENTS),
  z.object({ agents: z.array(agentWire).max(MAX_AGENTS) }).passthrough(),
]);
const wrappedAgentWire = z.object({ agent: agentWire }).passthrough();
const agentIdSchema = z.string().uuid();

export function resolveClawPumpConfig(env: Record<string, string | undefined> = process.env): {
  origin: string; basePath: string; apiKey: string; timeoutMs: number;
} {
  const apiKey = env.CLAWPUMP_API_KEY?.trim();
  if (!apiKey) throw new ClawPumpClientError('not_configured');
  let url: URL;
  try {
    url = new URL(env.CLAWPUMP_API_BASE_URL?.trim() || CLAWPUMP_DEFAULT_API_BASE_URL);
  } catch {
    throw new ClawPumpClientError('invalid_base_url');
  }
  // One trailing slash is allowed; the path must then be exactly the API base path.
  const basePath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || basePath !== CLAWPUMP_API_BASE_PATH
    || !CLAWPUMP_ALLOWED_API_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ClawPumpClientError('invalid_base_url');
  }
  const raw = Number(env.CLAWPUMP_HTTP_TIMEOUT_MS ?? CLAWPUMP_DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(raw)
    ? Math.min(CLAWPUMP_MAX_TIMEOUT_MS, Math.max(CLAWPUMP_MIN_TIMEOUT_MS, Math.floor(raw)))
    : CLAWPUMP_DEFAULT_TIMEOUT_MS;
  return { origin: url.origin, basePath, apiKey, timeoutMs };
}

/**
 * The one ClawPump URL builder. `path` is relative to the API base path and starts with exactly
 * one '/' (a query string is kept). A path that could leave the base path throws invalid_base_url.
 * Never `new URL('/x', origin)`: an absolute path drops the /api/v1 prefix.
 */
export function clawPumpUrl(config: { origin: string; basePath: string }, path: string): URL {
  const pathOnly = path.split(/[?#]/, 1)[0] ?? '';
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')
    || pathOnly.split('/').some((segment) => /^(\.|%2e){2}$/i.test(segment))) {
    throw new ClawPumpClientError('invalid_base_url');
  }
  let url: URL;
  try {
    url = new URL(config.origin + config.basePath + path);
  } catch {
    throw new ClawPumpClientError('invalid_base_url');
  }
  if (url.origin !== config.origin || !url.pathname.startsWith(`${config.basePath}/`)) {
    throw new ClawPumpClientError('invalid_base_url');
  }
  return url;
}

async function getJson(path: string, options: ClawPumpClientOptions): Promise<unknown> {
  const config = resolveClawPumpConfig(options.env ?? process.env);
  const url = clawPumpUrl(config, path);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    throw new ClawPumpClientError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error');
  }
  if (response.status === 401 || response.status === 403) throw new ClawPumpClientError('unauthorized', response.status);
  if (response.status === 404) throw new ClawPumpClientError('not_found', 404);
  if (!response.ok) throw new ClawPumpClientError('http_error', response.status);
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_CHARS) {
    throw new ClawPumpClientError('response_too_large', response.status);
  }
  let text: string;
  try { text = await response.text(); } catch { throw new ClawPumpClientError('timeout', response.status); }
  if (text.length > MAX_RESPONSE_CHARS) throw new ClawPumpClientError('response_too_large', response.status);
  try { return JSON.parse(text); } catch { throw new ClawPumpClientError('schema_invalid', response.status); }
}

function toAgent(wire: z.infer<typeof agentWire>): ClawPumpAgent {
  return {
    id: wire.id,
    userId: wire.user_id ?? null,
    name: wire.name ?? null,
    status: wire.status ?? null,
    walletAddress: wire.wallet_address?.trim() || null,
  };
}

/** Lists ONLY the agents of the account that owns CLAWPUMP_API_KEY. */
export async function listClawPumpAgents(options: ClawPumpClientOptions = {}): Promise<ClawPumpAgent[]> {
  const parsed = listWire.safeParse(await getJson('/agents', options));
  if (!parsed.success) throw new ClawPumpClientError('schema_invalid');
  return (Array.isArray(parsed.data) ? parsed.data : parsed.data.agents).map(toAgent);
}

export async function getClawPumpAgent(agentId: string, options: ClawPumpClientOptions = {}): Promise<ClawPumpAgent> {
  if (!agentIdSchema.safeParse(agentId).success) throw new ClawPumpClientError('invalid_agent_id');
  const body = await getJson(`/agents/${agentId}`, options);
  const direct = agentWire.safeParse(body);
  const wrapped = direct.success ? null : wrappedAgentWire.safeParse(body);
  const wire = direct.success ? direct.data : wrapped?.success ? wrapped.data.agent : null;
  if (!wire) throw new ClawPumpClientError('schema_invalid');
  if (wire.id !== agentId) throw new ClawPumpAgentMismatchError();
  return toAgent(wire);
}

export const clawPumpClient: ClawPumpAgentReader = {
  listAgents: () => listClawPumpAgents(),
  getAgent: (agentId) => getClawPumpAgent(agentId),
};
