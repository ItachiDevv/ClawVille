import { z } from 'zod';
import { ClawPumpClientError, getClawPumpAgent, resolveClawPumpConfig, type ClawPumpClientOptions } from './clawpump-client';

/**
 * ClawPump WRITE client for the Trading Floor Arena (docs/trading-floor-arena.md D8, D9).
 *
 * Same allowlisted host and Bearer `CLAWPUMP_API_KEY` as the read-only client
 * (`resolveClawPumpConfig`). Paths and bodies are copied from the ClawPump MCP
 * package `@clawpump/agents` 0.1.27 `dist/server.js`:
 *   create_agent  -> POST  /agents                                   (api-client L170)
 *   update_agent  -> PATCH /agents/{id}                              (api-client L176)
 *   wallets       -> GET   /wallets/summary -> { wallets: [...] }    (api-client L334)
 *   x402_pay_check-> POST  /agents/{id}/x402/x402_service_details    (server.js L4339)
 *   x402_pay      -> POST  /agents/{id}/x402/x402_service_pay        (server.js L4357)
 *
 * Rules: strict timeouts, typed errors that carry only a code and an HTTP
 * status, NO logging at all (so the key and the vendor body never reach a log),
 * and NO retry of a non-idempotent POST (create, pay). The provisioning job
 * retries a failed create later, after it lists agents by exact name.
 *
 * House-agent guard: `updateClawPumpAgent` and `x402PayViaClawPump` refuse an
 * agent whose ClawPump name does not start with `CV Arena`. Only the arena
 * provisioning job creates such agents, so a house trader (Genesis, Runner, the
 * ClawVille account agents) can never be re-configured or spend through here.
 */

export const CLAWPUMP_ARENA_AGENT_NAME_PREFIX = 'CV Arena';
/** Skills an arena execution wallet may carry. No trading skill, ever (D8). */
export const CLAWPUMP_ARENA_ALLOWED_SKILLS: ReadonlySet<string> = new Set(['x402']);
/** A single x402 call may never authorise more than this, whatever the caller asks. */
export const CLAWPUMP_X402_MAX_CALL_USD = 5;
/**
 * The ONLY hosts an arena add-on may pay (lead rule, vetted 2026-09-30). A
 * catalog edit alone can never point a player's USDC at a new vendor: adding a
 * host is a reviewed change here.
 */
export const CLAWPUMP_X402_ALLOWED_HOSTS: ReadonlySet<string> = new Set(['api.nansen.ai']);
const X402_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_CHARS = 1_000_000;
/** GET /agents and GET /wallets/summary grow with every arena player (one ClawPump agent each). */
const MAX_LIST_RESPONSE_CHARS = 8_000_000;
const MAX_LIST_AGENTS = 5_000;
const ARENA_GUARD_TTL_MS = 60 * 60_000;

export type ClawPumpWriterErrorCode =
  | 'not_configured' | 'invalid_base_url' | 'invalid_agent_id' | 'invalid_input' | 'not_arena_agent'
  | 'unauthorized' | 'not_found' | 'payment_required' | 'rate_limited' | 'http_error'
  | 'timeout' | 'network_error' | 'response_too_large' | 'schema_invalid' | 'host_not_allowed';

export class ClawPumpWriterError extends Error {
  constructor(readonly code: ClawPumpWriterErrorCode, readonly status: number | null = null) {
    // Code and HTTP status only: never the key, a URL, or a vendor body.
    super(`clawpump_${code}${status === null ? '' : `_${status}`}`);
    this.name = 'ClawPumpWriterError';
  }
}

export interface ClawPumpWriterOptions extends ClawPumpClientOptions {}

export interface ClawPumpCreatedAgent {
  id: string;
  name: string | null;
  status: string | null;
  walletAddress: string | null;
  enabledSkills: string[] | null;
  isPublic: boolean | null;
  acceptingBids: boolean | null;
}

export interface ClawPumpWalletBalance {
  agentId: string;
  walletAddress: string | null;
  sol: number | null;
  usdc: number | null;
  updatedAt: string | null;
}

export interface ClawPumpX402Result {
  /** False when ClawPump answered 200 with a string `error` (the MCP treats that as a failure). */
  ok: boolean;
  /** Vendor error text, trimmed to 200 chars. Stored in our ledger, never logged. */
  error: string | null;
  /** The whole ClawPump payload, for callers that need a field we do not type. */
  payload: unknown;
}

const agentIdSchema = z.string().uuid();
const skillSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,64}$/);
const skillsSchema = z.array(skillSchema).max(10).refine(
  (skills) => skills.every((skill) => CLAWPUMP_ARENA_ALLOWED_SKILLS.has(skill)),
  'skill_not_allowed',
);

export const createAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(48),
  persona: z.string().trim().min(1).max(2_000),
  system_prompt: z.string().trim().min(1).max(4_000),
  enabled_skills: skillsSchema,
  is_public: z.boolean(),
  model: z.string().trim().min(1).max(120).optional(),
}).strict();
export type CreateClawPumpAgentInput = z.infer<typeof createAgentInputSchema>;

export const updateAgentPatchSchema = z.object({
  accepting_bids: z.boolean().optional(),
  is_public: z.boolean().optional(),
  enabled_skills: skillsSchema.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, 'empty_patch');
export type UpdateClawPumpAgentPatch = z.infer<typeof updateAgentPatchSchema>;

const httpsUrlSchema = z.string().url().max(2_000).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}, 'https_only');

export const x402PayInputSchema = z.object({
  url: httpsUrlSchema,
  method: z.enum(['GET', 'POST']),
  query: z.record(z.string(), z.string().max(500)).optional(),
  body: z.unknown().optional(),
  maxAmountUsd: z.number().positive().max(CLAWPUMP_X402_MAX_CALL_USD),
}).strict();
export type X402PayInput = z.infer<typeof x402PayInputSchema>;

export function isAllowedX402Url(value: string): boolean {
  try {
    return CLAWPUMP_X402_ALLOWED_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Vendor wire: type and bound only what we read, pass the rest through.
const agentWire = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(200).nullish(),
  status: z.string().max(40).nullish(),
  wallet_address: z.string().max(64).nullish(),
  enabled_skills: z.array(z.string().max(80)).max(100).nullish(),
  is_public: z.boolean().nullish(),
  accepting_bids: z.boolean().nullish(),
}).passthrough();
const wrappedAgentWire = z.object({ agent: agentWire }).passthrough();
const amountWire = z.union([z.number(), z.string().max(40)]).nullish();
const walletWire = z.object({
  agent_id: z.string().min(1).max(128),
  wallet_address: z.string().max(64).nullish(),
  sol_balance: amountWire,
  usdc_balance: amountWire,
  updated_at: z.string().max(64).nullish(),
}).passthrough();
const walletSummaryWire = z.object({ wallets: z.array(walletWire).max(MAX_LIST_AGENTS) }).passthrough();

function toWriterError(error: unknown): ClawPumpWriterError {
  if (error instanceof ClawPumpWriterError) return error;
  if (error instanceof ClawPumpClientError) return new ClawPumpWriterError(error.code, error.status);
  return new ClawPumpWriterError('network_error');
}

async function sendJson(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body: unknown,
  options: ClawPumpWriterOptions,
  timeoutOverrideMs?: number,
  maxChars: number = MAX_RESPONSE_CHARS,
): Promise<unknown> {
  let config: ReturnType<typeof resolveClawPumpConfig>;
  try {
    config = resolveClawPumpConfig(options.env ?? process.env);
  } catch (error) {
    throw toWriterError(error);
  }
  const url = new URL(path, config.origin);
  if (url.origin !== config.origin) throw new ClawPumpWriterError('invalid_base_url');
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutOverrideMs ?? config.timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    throw new ClawPumpWriterError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error');
  }
  if (response.status === 401 || response.status === 403) throw new ClawPumpWriterError('unauthorized', response.status);
  if (response.status === 404) throw new ClawPumpWriterError('not_found', 404);
  if (response.status === 402) throw new ClawPumpWriterError('payment_required', 402);
  if (response.status === 429) throw new ClawPumpWriterError('rate_limited', 429);
  if (!response.ok) throw new ClawPumpWriterError('http_error', response.status);
  if (Number(response.headers.get('content-length') ?? 0) > maxChars) {
    throw new ClawPumpWriterError('response_too_large', response.status);
  }
  let text: string;
  try { text = await response.text(); } catch { throw new ClawPumpWriterError('timeout', response.status); }
  if (text.length > maxChars) throw new ClawPumpWriterError('response_too_large', response.status);
  try { return JSON.parse(text); } catch { throw new ClawPumpWriterError('schema_invalid', response.status); }
}

function toCreatedAgent(body: unknown): ClawPumpCreatedAgent {
  const direct = agentWire.safeParse(body);
  const wrapped = direct.success ? null : wrappedAgentWire.safeParse(body);
  const wire = direct.success ? direct.data : wrapped?.success ? wrapped.data.agent : null;
  if (!wire) throw new ClawPumpWriterError('schema_invalid');
  return {
    id: wire.id,
    name: wire.name ?? null,
    status: wire.status ?? null,
    walletAddress: wire.wallet_address?.trim() || null,
    enabledSkills: wire.enabled_skills ?? null,
    isPublic: wire.is_public ?? null,
    acceptingBids: wire.accepting_bids ?? null,
  };
}

function toAmount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function vendorError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'string' || error.trim().length === 0) return null;
  return error.trim().slice(0, 200);
}

function assertAgentId(agentId: string): void {
  if (!agentIdSchema.safeParse(agentId).success) throw new ClawPumpWriterError('invalid_agent_id');
}

// Positive cache of agent ids verified as arena agents. Names do not change
// under us (only this module updates these agents and it never sends a name),
// so an hour is safe and keeps the add-on tick from doubling its vendor calls.
const verifiedArenaAgents = new Map<string, number>();

export function isArenaAgentName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.trim().startsWith(CLAWPUMP_ARENA_AGENT_NAME_PREFIX);
}

async function assertArenaAgent(agentId: string, options: ClawPumpWriterOptions): Promise<void> {
  const verifiedAt = verifiedArenaAgents.get(agentId);
  if (verifiedAt !== undefined && Date.now() - verifiedAt < ARENA_GUARD_TTL_MS) return;
  let name: string | null;
  try {
    name = (await getClawPumpAgent(agentId, options)).name;
  } catch (error) {
    throw toWriterError(error);
  }
  if (!isArenaAgentName(name)) throw new ClawPumpWriterError('not_arena_agent');
  verifiedArenaAgents.set(agentId, Date.now());
}

/** Test seam: forget the arena-agent verification cache. */
export function _resetClawPumpWriterCacheForTest(): void {
  verifiedArenaAgents.clear();
}

/** POST /agents. NOT idempotent and never retried here; list by name before a retry. */
export async function createClawPumpAgent(
  input: CreateClawPumpAgentInput,
  options: ClawPumpWriterOptions = {},
): Promise<ClawPumpCreatedAgent> {
  const parsed = createAgentInputSchema.safeParse(input);
  if (!parsed.success) throw new ClawPumpWriterError('invalid_input');
  if (!isArenaAgentName(parsed.data.name)) throw new ClawPumpWriterError('not_arena_agent');
  // Same body the MCP builds: persona / system_prompt / model live under `config`.
  const config: Record<string, string> = {
    persona: parsed.data.persona,
    system_prompt: parsed.data.system_prompt,
  };
  if (parsed.data.model) config.model = parsed.data.model;
  const created = toCreatedAgent(await sendJson('POST', '/agents', {
    name: parsed.data.name,
    config,
    enabled_skills: parsed.data.enabled_skills,
    is_public: parsed.data.is_public,
  }, options));
  if (!agentIdSchema.safeParse(created.id).success) throw new ClawPumpWriterError('schema_invalid');
  verifiedArenaAgents.set(created.id, Date.now());
  return created;
}

/** PATCH /agents/{id} with only accepting_bids, is_public and enabled_skills. */
export async function updateClawPumpAgent(
  agentId: string,
  patch: UpdateClawPumpAgentPatch,
  options: ClawPumpWriterOptions = {},
): Promise<ClawPumpCreatedAgent> {
  assertAgentId(agentId);
  const parsed = updateAgentPatchSchema.safeParse(patch);
  if (!parsed.success) throw new ClawPumpWriterError('invalid_input');
  await assertArenaAgent(agentId, options);
  const updated = toCreatedAgent(await sendJson('PATCH', `/agents/${agentId}`, parsed.data, options));
  if (updated.id !== agentId) throw new ClawPumpWriterError('schema_invalid');
  return updated;
}

/** The agent's public wallet address (its payment address), via the read client. */
export async function getClawPumpWallet(agentId: string, options: ClawPumpWriterOptions = {}): Promise<string | null> {
  assertAgentId(agentId);
  try {
    return (await getClawPumpAgent(agentId, options)).walletAddress;
  } catch (error) {
    throw toWriterError(error);
  }
}

/** GET /wallets/summary: SOL + USDC (UI units) for every agent of the account. */
export async function getClawPumpWalletBalances(options: ClawPumpWriterOptions = {}): Promise<ClawPumpWalletBalance[]> {
  const parsed = walletSummaryWire.safeParse(
    await sendJson('GET', '/wallets/summary', undefined, options, undefined, MAX_LIST_RESPONSE_CHARS),
  );
  if (!parsed.success) throw new ClawPumpWriterError('schema_invalid');
  return parsed.data.wallets.map((wire) => ({
    agentId: wire.agent_id,
    walletAddress: wire.wallet_address?.trim() || null,
    sol: toAmount(wire.sol_balance),
    usdc: toAmount(wire.usdc_balance),
    updatedAt: wire.updated_at ?? null,
  }));
}

/** POST /agents/{id}/x402/x402_service_details. Free: reads the 402 challenge, pays nothing. */
export async function x402PayCheck(
  agentId: string,
  url: string,
  method: 'GET' | 'POST',
  options: ClawPumpWriterOptions = {},
): Promise<ClawPumpX402Result> {
  assertAgentId(agentId);
  if (!httpsUrlSchema.safeParse(url).success || (method !== 'GET' && method !== 'POST')) {
    throw new ClawPumpWriterError('invalid_input');
  }
  if (!isAllowedX402Url(url)) throw new ClawPumpWriterError('host_not_allowed');
  const payload = await sendJson('POST', `/agents/${agentId}/x402/x402_service_details`, { url, method }, options);
  const error = vendorError(payload);
  return { ok: error === null, error, payload };
}

/**
 * POST /agents/{id}/x402/x402_service_pay. Spends the agent's on-chain USDC,
 * hard-capped by ClawPump at `maxAmountAtomic` (USDC 6 decimals). NOT retried:
 * a timeout may still have paid, so the caller must book it as spent.
 */
export async function x402PayViaClawPump(
  agentId: string,
  input: X402PayInput,
  options: ClawPumpWriterOptions = {},
): Promise<ClawPumpX402Result> {
  assertAgentId(agentId);
  const parsed = x402PayInputSchema.safeParse(input);
  if (!parsed.success) throw new ClawPumpWriterError('invalid_input');
  if (!isAllowedX402Url(parsed.data.url)) throw new ClawPumpWriterError('host_not_allowed');
  await assertArenaAgent(agentId, options);
  const payload = await sendJson('POST', `/agents/${agentId}/x402/x402_service_pay`, {
    url: parsed.data.url,
    method: parsed.data.method,
    ...(parsed.data.body === undefined ? {} : { body: parsed.data.body }),
    ...(parsed.data.query === undefined ? {} : { query: parsed.data.query }),
    maxAmountAtomic: Math.round(parsed.data.maxAmountUsd * 1e6),
  }, options, X402_TIMEOUT_MS);
  const error = vendorError(payload);
  return { ok: error === null, error, payload };
}

/** The writer surface the arena jobs depend on, so tests inject a fake. */
export interface ClawPumpArenaWriter {
  listAgentsByName(name: string): Promise<ClawPumpCreatedAgent[]>;
  createAgent(input: CreateClawPumpAgentInput): Promise<ClawPumpCreatedAgent>;
  updateAgent(agentId: string, patch: UpdateClawPumpAgentPatch): Promise<ClawPumpCreatedAgent>;
  getWalletBalances(): Promise<ClawPumpWalletBalance[]>;
  x402Pay(agentId: string, input: X402PayInput): Promise<ClawPumpX402Result>;
}

/** GET /agents filtered to an exact name (the provisioning idempotency check). */
export async function listClawPumpAgentsByName(
  name: string,
  options: ClawPumpWriterOptions = {},
): Promise<ClawPumpCreatedAgent[]> {
  const body = await sendJson('GET', '/agents', undefined, options, undefined, MAX_LIST_RESPONSE_CHARS);
  const list = z.union([
    z.array(agentWire).max(MAX_LIST_AGENTS),
    z.object({ agents: z.array(agentWire).max(MAX_LIST_AGENTS) }).passthrough(),
  ]).safeParse(body);
  if (!list.success) throw new ClawPumpWriterError('schema_invalid');
  const rows = Array.isArray(list.data) ? list.data : list.data.agents;
  return rows.filter((row) => (row.name ?? '').trim() === name.trim()).map((row) => toCreatedAgent(row));
}

export const clawPumpArenaWriter: ClawPumpArenaWriter = {
  listAgentsByName: (name) => listClawPumpAgentsByName(name),
  createAgent: (input) => createClawPumpAgent(input),
  updateAgent: (agentId, patch) => updateClawPumpAgent(agentId, patch),
  getWalletBalances: () => getClawPumpWalletBalances(),
  x402Pay: (agentId, input) => x402PayViaClawPump(agentId, input),
};
