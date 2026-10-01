import { z } from 'zod';
import { FLOOR_ARENA_HOUSE_AGENTS } from '@clawville/shared';
import { ClawPumpClientError, resolveClawPumpConfig, type ClawPumpClientOptions } from './clawpump-client';
import { isArenaClawPumpOwnedBy } from './floor-arena/queries';

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
 * retries a failed create later with a NEW create; it never adopts an
 * existing agent (Codex r18 #4).
 *
 * House-agent guard (`assertArenaAgent`, checked fresh on every call): an
 * update or payment names the USER arena row it acts for, and the ClawPump id
 * must be that row's `clawpump_agent_id` (DB proof); FLOOR_ARENA_HOUSE_AGENTS
 * ids are refused outright; and ClawPump's current name must carry this
 * environment's arena prefix plus that row's id suffix. A house trader
 * (Genesis, Runner, Clawville_World on the founder's staging account) can
 * therefore never be re-configured or spend through here, even after a rename.
 * The guard's GET is the last read before the write (Codex r19 #3, r22): only
 * a 'stopped' agent gets a payment or a PATCH that can add capability or
 * change visibility; any other status (running, null, missing, unknown) gets
 * only a removal-only PATCH. A payment also needs x402 on the agent at that read.
 */

export const CLAWPUMP_ARENA_AGENT_NAME_PREFIX = 'CV Arena';

/**
 * The FULL name prefix of an arena agent in this environment (D16):
 * `CV Arena · ` on production, `CV Arena (staging) · ` everywhere else
 * (CLAWVILLE_ENV is the only env discriminator). The writer refuses any agent
 * without the prefix of ITS environment (money audit N1): the staging key is
 * the founder's account, which also holds Genesis, Runner and Clawville_World.
 */
export function arenaAgentNamePrefix(env: Record<string, string | undefined> = process.env): string {
  return env.CLAWVILLE_ENV === 'production' ? 'CV Arena · ' : 'CV Arena (staging) · ';
}

/** ClawPump agents the arena writer must never update or pay from, whatever their name. */
export const CLAWPUMP_HOUSE_AGENT_IDS: ReadonlySet<string> = new Set(
  FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.clawpumpAgentId).filter((id): id is string => typeof id === 'string'),
);
/** Skills an arena execution wallet may carry. No trading skill, ever (D8). */
export const CLAWPUMP_ARENA_ALLOWED_SKILLS: ReadonlySet<string> = new Set(['x402']);
/**
 * ClawPump's platform defaults. Live staging (verifier A, 2026-09-30) showed
 * they are STICKY: a PATCH of enabled_skills never removes them (['x402'] only
 * adds x402, [] only removes x402). They cannot be disabled, so they are never
 * in the deny list; the arena agent is stopped and driven only by our API.
 */
export const CLAWPUMP_STICKY_DEFAULT_SKILLS: ReadonlySet<string> = new Set([
  'action-plans', 'web-browsing', 'private-transfers', 'bitget-intel', 'self-learning', 'skill-management',
]);

/**
 * Skills an arena execution wallet must NEVER carry (lead order after live
 * staging, 2026-09-30): trading, launching, sniping, marketplace, paid tools
 * and wallet operations. Exact ClawPump slugs as the API returns them
 * (research-20260930-clawpump R6 per-agent lists) PLUS the MCP aliases
 * (`perps`, `laso`, `trading`) in case a response uses one. `x402` is denied
 * too unless the arena agent has an enabled add-on (the caller decides).
 * `private-transfers` is NOT here: it is a sticky platform default that cannot
 * be disabled (see CLAWPUMP_STICKY_DEFAULT_SKILLS).
 */
export const CLAWPUMP_ARENA_DENIED_SKILLS: ReadonlySet<string> = new Set([
  'defi-trading', 'trading',
  'perps-trading', 'perps',
  'token-launch', 'token-sniper',
  'marketplace',
  'pay-sh', 'paysh',
  'laso-finance', 'laso',
  'agenc-worker', 'agent-c', 'agenc',
  'wallet-ops',
  'x402',
]);
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
/** GET /wallets/summary grows with every arena player (one ClawPump agent each). */
const MAX_LIST_RESPONSE_CHARS = 8_000_000;
const MAX_LIST_AGENTS = 5_000;

export type ClawPumpWriterErrorCode =
  | 'not_configured' | 'invalid_base_url' | 'invalid_agent_id' | 'invalid_input' | 'not_arena_agent'
  | 'unauthorized' | 'not_found' | 'payment_required' | 'rate_limited' | 'http_error'
  | 'timeout' | 'network_error' | 'response_too_large' | 'schema_invalid' | 'host_not_allowed'
  | 'agent_running' | 'agent_not_stopped' | 'x402_not_enabled' | 'budget_exhausted';

export class ClawPumpWriterError extends Error {
  constructor(readonly code: ClawPumpWriterErrorCode, readonly status: number | null = null) {
    // Code and HTTP status only: never the key, a URL, or a vendor body.
    super(`clawpump_${code}${status === null ? '' : `_${status}`}`);
    this.name = 'ClawPumpWriterError';
  }
}

/** 'removal' calls may use the reserved end of the shared call budget (x402 removals only). */
export type ClawPumpCallPriority = 'removal' | 'normal';

export interface ClawPumpWriterOptions extends ClawPumpClientOptions {
  /** Budget priority for this call (default 'normal'). */
  priority?: ClawPumpCallPriority;
}

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
/** CREATE: nothing but `x402` (when an add-on is on). */
const skillsSchema = z.array(skillSchema).max(10).refine(
  (skills) => skills.every((skill) => CLAWPUMP_ARENA_ALLOWED_SKILLS.has(skill)),
  'skill_not_allowed',
);
/** PATCH: ClawPump's harmless defaults may stay; no denied skill except `x402`. */
const patchSkillsSchema = z.array(skillSchema).max(40).refine(
  (skills) => skills.every((skill) => skill === 'x402' || !CLAWPUMP_ARENA_DENIED_SKILLS.has(skill)),
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
  enabled_skills: patchSkillsSchema.optional(),
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

/**
 * Codex r20 (3) / audit-money B: a per-process token bucket over EVERY call this
 * writer makes (create, PATCH, x402 pay and check, agent GET, wallet summary),
 * checked BEFORE the request, so the arena can never flood the ClawPump key
 * the house traders share. 60 calls a minute, burst 10 (code constants, no env
 * var). The last REMOVAL_RESERVE tokens are for removal-priority calls only, so
 * x402 removals always get the first claim: half of the burst (5 of 10) is
 * theirs alone; normal calls (provisioning, adds, re-checks, payments) stop
 * above that floor. Empty -> 'budget_exhausted' (our own code, distinct from
 * ClawPump's HTTP 429 'rate_limited') before any request, so nothing can have
 * been charged; the next tick retries. Scope: every ClawPump call the ARENA
 * makes through this writer, the arena's agent GETs included. The house
 * traders' own calls and the paper-fill quotes (other subsystems, other
 * clients) are out of scope.
 * Quota: ClawPump's /developers page lists 10,000,000 calls a month for the
 * Enterprise tier (about 230 a minute on average) and says call limits are
 * "recorded but not enforced", with no per-second limit and no documented
 * burst ceiling (ops/house-traders/research-20260930-clawpump/R2-api.md
 * :92-94, R1-docs.md :252). 60 a minute leaves most of that for the house
 * traders. Load: a removal is 4 calls (GET, guard GET, PATCH, verifying GET),
 * so about 15 removals a minute when the budget is the limit.
 */
export const CLAWPUMP_WRITER_CALLS_PER_MINUTE = 60;
export const CLAWPUMP_WRITER_BURST = 10;
export const CLAWPUMP_WRITER_REMOVAL_RESERVE = 5;
let writerTokens = CLAWPUMP_WRITER_BURST;
let writerRefilledAt = Date.now();

function refillWriterTokens(nowMs: number): void {
  const refill = (Math.max(0, nowMs - writerRefilledAt) / 60_000) * CLAWPUMP_WRITER_CALLS_PER_MINUTE;
  writerTokens = Math.min(CLAWPUMP_WRITER_BURST, writerTokens + refill);
  writerRefilledAt = nowMs;
}

function takeWriterToken(priority: ClawPumpCallPriority, nowMs: number = Date.now()): boolean {
  refillWriterTokens(nowMs);
  const floor = priority === 'removal' ? 0 : CLAWPUMP_WRITER_REMOVAL_RESERVE;
  if (writerTokens - 1 < floor) return false;
  writerTokens -= 1;
  return true;
}

/** The shared budget now: `normalAllowed` = a normal-priority call would get a token. */
export function clawPumpWriterBudget(nowMs: number = Date.now()): { tokens: number; normalAllowed: boolean } {
  refillWriterTokens(nowMs);
  return { tokens: writerTokens, normalAllowed: writerTokens - 1 >= CLAWPUMP_WRITER_REMOVAL_RESERVE };
}

/** Test seam: a full bucket (or `tokens`). */
export function _resetClawPumpWriterRateForTest(tokens: number = CLAWPUMP_WRITER_BURST): void {
  writerTokens = tokens;
  writerRefilledAt = Date.now();
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
  if (!takeWriterToken(options.priority ?? 'normal')) throw new ClawPumpWriterError('budget_exhausted');
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

/** True only for an arena agent name of THIS environment (`arenaAgentNamePrefix`). */
export function isArenaAgentName(
  name: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return typeof name === 'string' && name.trim().startsWith(arenaAgentNamePrefix(env).trim());
}

/** Arena ClawPump names end with ` #<first 12 alnum chars of the arena agent id>` (Codex r2 #4). */
export function arenaAgentNameSuffix(arenaAgentId: string): string {
  return ` #${arenaAgentId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
}

export interface ClawPumpWriterOwnership {
  /** Arena row this ClawPump agent must belong to (`floor_arena_agents.id`, kind 'user'). */
  arenaAgentId: string;
  /** Ownership proof; default: the `floor_arena_agents` row read fresh (no cache). */
  isOwnedBy?: (clawpumpAgentId: string, arenaAgentId: string) => Promise<boolean>;
}

/**
 * Codex r17 #4: every update and every payment is bound to ONE arena row,
 * checked fresh on each call (no cache that could survive a rename):
 *   1. never a house trader id (static deny set);
 *   2. the ClawPump id IS the clawpump_agent_id of that USER arena row (DB proof);
 *   3. ClawPump's current name is this environment's arena prefix AND ends with
 *      that row's id suffix (an extra layer against a renamed foreign agent).
 * Returns that fresh read: it is the LAST read before the write (Codex r19 #3).
 */
async function assertArenaAgent(
  agentId: string,
  ownership: ClawPumpWriterOwnership,
  options: ClawPumpWriterOptions,
): Promise<ClawPumpCreatedAgent> {
  if (CLAWPUMP_HOUSE_AGENT_IDS.has(agentId)) throw new ClawPumpWriterError('not_arena_agent');
  const owned = await (ownership.isOwnedBy ?? isArenaClawPumpOwnedBy)(agentId, ownership.arenaAgentId);
  if (!owned) throw new ClawPumpWriterError('not_arena_agent');
  const current = await readClawPumpArenaAgent(agentId, options);
  const name = current.name;
  if (!isArenaAgentName(name, options.env ?? process.env) || !name!.trim().endsWith(arenaAgentNameSuffix(ownership.arenaAgentId))) {
    throw new ClawPumpWriterError('not_arena_agent');
  }
  return current;
}

function normalisedSkills(skills: readonly string[]): string[] {
  return skills.map((skill) => skill.trim().toLowerCase()).filter((skill) => skill.length > 0);
}

/**
 * Codex r22: the writer's last read must PROVE the agent is stopped. Only
 * 'stopped' (trimmed, any case) passes; 'running' refuses with agent_running
 * and null, missing or any other status with agent_not_stopped. Both refuse
 * before the request, so nothing can have been charged.
 */
function assertStopped(status: string | null): void {
  const normalised = (status ?? '').trim().toLowerCase();
  if (normalised === 'stopped') return;
  throw new ClawPumpWriterError(normalised === 'running' ? 'agent_running' : 'agent_not_stopped');
}

/**
 * Codex r19 #3: a PATCH that can only take capability away: `enabled_skills`
 * alone, no x402, and every skill in it already on the agent (`current`, the
 * writer's own last read). The only PATCH allowed on an agent that is not
 * 'stopped' (Codex r22).
 */
export function isRemovalOnlyPatch(patch: UpdateClawPumpAgentPatch, current: ClawPumpCreatedAgent): boolean {
  const keys = Object.keys(patch).filter((key) => patch[key as keyof UpdateClawPumpAgentPatch] !== undefined);
  if (keys.length !== 1 || keys[0] !== 'enabled_skills' || !patch.enabled_skills || current.enabledSkills === null) return false;
  const have = new Set(normalisedSkills(current.enabledSkills));
  const next = normalisedSkills(patch.enabled_skills);
  return !next.includes('x402') && next.every((skill) => have.has(skill));
}

/** POST /agents. NOT idempotent and never retried here. */
export async function createClawPumpAgent(
  input: CreateClawPumpAgentInput,
  options: ClawPumpWriterOptions = {},
): Promise<ClawPumpCreatedAgent> {
  const parsed = createAgentInputSchema.safeParse(input);
  if (!parsed.success) throw new ClawPumpWriterError('invalid_input');
  if (!isArenaAgentName(parsed.data.name, options.env ?? process.env)) throw new ClawPumpWriterError('not_arena_agent');
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
  return created;
}

/** PATCH /agents/{id} with only accepting_bids, is_public and enabled_skills, for the arena row that owns it. */
export async function updateClawPumpAgent(
  agentId: string,
  patch: UpdateClawPumpAgentPatch,
  ownership: ClawPumpWriterOwnership,
  options: ClawPumpWriterOptions = {},
): Promise<ClawPumpCreatedAgent> {
  assertAgentId(agentId);
  const parsed = updateAgentPatchSchema.safeParse(patch);
  if (!parsed.success) throw new ClawPumpWriterError('invalid_input');
  const current = await assertArenaAgent(agentId, ownership, options);
  // Codex r19 #3 / r22: the guarantee holds at the LAST read before the PATCH.
  // An agent that is not 'stopped' gets only a removal-only PATCH (a later
  // status change is a separate vendor race the caller's read-back catches).
  if (!isRemovalOnlyPatch(parsed.data, current)) assertStopped(current.status);
  const updated = toCreatedAgent(await sendJson('PATCH', `/agents/${agentId}`, parsed.data, options));
  if (updated.id !== agentId) throw new ClawPumpWriterError('schema_invalid');
  return updated;
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
  ownership: ClawPumpWriterOwnership,
  options: ClawPumpWriterOptions = {},
): Promise<ClawPumpX402Result> {
  assertAgentId(agentId);
  const parsed = x402PayInputSchema.safeParse(input);
  if (!parsed.success) throw new ClawPumpWriterError('invalid_input');
  if (!isAllowedX402Url(parsed.data.url)) throw new ClawPumpWriterError('host_not_allowed');
  const current = await assertArenaAgent(agentId, ownership, options);
  // Pay only through an agent reported 'stopped' that holds x402 now (every
  // refusal happens before the POST, so nothing can have been charged).
  assertStopped(current.status);
  if (!normalisedSkills(current.enabledSkills ?? []).includes('x402')) throw new ClawPumpWriterError('x402_not_enabled');
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
  /** GET /agents/{id} with its enabled skills (the post-provisioning check). */
  readAgent(agentId: string, priority?: ClawPumpCallPriority): Promise<ClawPumpCreatedAgent>;
  createAgent(input: CreateClawPumpAgentInput): Promise<ClawPumpCreatedAgent>;
  /** `arenaAgentId` = the user arena row that must own this ClawPump agent (Codex r17 #4). */
  updateAgent(agentId: string, patch: UpdateClawPumpAgentPatch, arenaAgentId: string, priority?: ClawPumpCallPriority): Promise<ClawPumpCreatedAgent>;
  getWalletBalances(): Promise<ClawPumpWalletBalance[]>;
  x402Pay(agentId: string, input: X402PayInput, arenaAgentId: string): Promise<ClawPumpX402Result>;
}

/** GET /agents/{id}: the agent as ClawPump holds it now, enabled skills included. */
export async function readClawPumpArenaAgent(
  agentId: string,
  options: ClawPumpWriterOptions = {},
): Promise<ClawPumpCreatedAgent> {
  assertAgentId(agentId);
  const agent = toCreatedAgent(await sendJson('GET', `/agents/${agentId}`, undefined, options));
  if (agent.id !== agentId) throw new ClawPumpWriterError('schema_invalid');
  return agent;
}

export const clawPumpArenaWriter: ClawPumpArenaWriter = {
  readAgent: (agentId, priority) => readClawPumpArenaAgent(agentId, { priority }),
  createAgent: (input) => createClawPumpAgent(input),
  updateAgent: (agentId, patch, arenaAgentId, priority) => updateClawPumpAgent(agentId, patch, { arenaAgentId }, { priority }),
  getWalletBalances: () => getClawPumpWalletBalances(),
  x402Pay: (agentId, input, arenaAgentId) => x402PayViaClawPump(agentId, input, { arenaAgentId }),
};
