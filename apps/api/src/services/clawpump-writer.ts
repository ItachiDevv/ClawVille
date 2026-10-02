import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { FLOOR_ARENA_HOUSE_AGENTS, TRADE_MINTS } from '@clawville/shared';
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
 * P5 withdraw (shapes proved on chain, ops/house-traders/arena-review/WITHDRAW_PROBES_2026-10-01.md Run 2):
 *   wallet live   -> GET   /wallets/{id}/history?limit=N             (live balances; the summary is cached)
 *   transfer      -> POST  /wallets/{id}/transfer {to, amount, token}
 *
 * Rules: strict timeouts, typed errors that carry only a code and an HTTP
 * status, NO logging at all (so the key and the vendor body never reach a log),
 * and NO retry of a non-idempotent POST (create, pay, transfer). The provisioning job
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
  | 'agent_running' | 'agent_not_stopped' | 'x402_not_enabled' | 'budget_exhausted' | 'wallet_mismatch';

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
 * writer makes (create, PATCH, x402 pay and check, agent GET, wallet summary,
 * wallet history, transfer),
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
  await assertOwnedArenaAgent(agentId, ownership);
  const current = await readClawPumpArenaAgent(agentId, options);
  const name = current.name;
  if (!isArenaAgentName(name, options.env ?? process.env) || !name!.trim().endsWith(arenaAgentNameSuffix(ownership.arenaAgentId))) {
    throw new ClawPumpWriterError('not_arena_agent');
  }
  return current;
}

/** Steps 1 and 2 of assertArenaAgent: the static house deny set, then the DB proof. No network call. */
async function assertOwnedArenaAgent(agentId: string, ownership: ClawPumpWriterOwnership): Promise<void> {
  if (CLAWPUMP_HOUSE_AGENT_IDS.has(agentId)) throw new ClawPumpWriterError('not_arena_agent');
  const owned = await (ownership.isOwnedBy ?? isArenaClawPumpOwnedBy)(agentId, ownership.arenaAgentId);
  if (!owned) throw new ClawPumpWriterError('not_arena_agent');
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

// ---------------------------------------------------------------------------
// P5 arena wallet WITHDRAW. REAL MONEY. Contract:
// ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md §3 (invariants I1, I8, I9).
// Every refusal is thrown BEFORE the transfer POST, so a throw always means
// "nothing sent". After the POST starts, transferFromArenaWallet never throws:
// it returns an outcome. The POST is sent once and never retried. Only a reply
// that proves "nothing sent" is 'rejected'; every other reply is 'unknown'
// (the caller reconciles on chain and never sends again). Outcomes carry codes
// and a signature only: never the key, a body, or vendor `error` text.
// ---------------------------------------------------------------------------

/** After this time the transfer is 'unknown' (it may have been sent). */
export const CLAWPUMP_TRANSFER_TIMEOUT_MS = 45_000;
/** HTTP 200 ok:false codes that Run 2 proved are pre-checks (nothing sent). Any other code is 'unknown'. */
export const CLAWPUMP_TRANSFER_NO_SEND_VENDOR_CODES: ReadonlySet<string> = new Set(['insufficient_live_balance', 'insufficient_fee_balance']);
/** Auth and rate-limit refusals: ClawPump answers them before the transfer handler runs. */
const TRANSFER_NO_SEND_HTTP_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);
const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;
const MAX_TRANSFER_ATOMIC = 2n ** 63n - 1n;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_ROWS = 200;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const TX_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{43,100}$/;
/** `vendor_` (7 characters) plus this stays inside the stored code shape [a-z0-9_.:-]{1,64}. */
const VENDOR_CODE_RE = /^[a-z0-9_.:-]{1,57}$/;
/** `vendor_status_` (14 characters) plus this stays inside [a-z0-9_.:-]{1,64}. */
const VENDOR_STATUS_RE = /^[a-z0-9_.:-]{1,50}$/;
const UI_AMOUNT_RE = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/;

export interface ClawPumpArenaWalletLive {
  address: string;
  solLamports: bigint;
  usdcAtomic: bigint;
  /** Taken BEFORE the request: add-on calls at or after this time may be missing from the balances. */
  readAt: Date;
  transactions: Array<{ signature: string; status: string | null }>;
}

export type ArenaTransferAsset = 'USDC' | 'SOL';

export interface ArenaTransferInput {
  to: string;
  asset: ArenaTransferAsset;
  amountAtomic: bigint;
  /** The arena row's ClawPump wallet. The agent's wallet at the guard GET must be this address. */
  expectedSource: string;
}

export type ArenaTransferOutcome =
  | { kind: 'sent'; txSignature: string; recipientAccountCreated: boolean | null }
  | { kind: 'rejected'; code: string } // proved nothing sent
  | { kind: 'unknown'; code: string; txSignature: string | null } // may have sent
  | { kind: 'mismatch'; code: 'reply_mismatch'; txSignature: string | null }; // ok:true but from/to/mint/amount differ

/**
 * Why `address` cannot receive a withdrawal, or null when it can. ON-CURVE
 * only (same rule as wallet-withdraw-executor `validateWithdrawStatic`): a PDA
 * has no secret key, so money sent there is lost.
 */
export function arenaDestinationProblem(address: string): null | 'not_base58' | 'not_32_bytes' | 'off_curve' {
  if (typeof address !== 'string' || !BASE58_RE.test(address)) return 'not_base58';
  // 32 bytes encode to 32..44 base58 characters, so a longer text is never decoded.
  if (address.length > 44) return 'not_32_bytes';
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(address);
  } catch {
    return 'not_base58';
  }
  if (bytes.length !== 32) return 'not_32_bytes';
  return PublicKey.isOnCurve(bytes) ? null : 'off_curve';
}

/** Exact decimal text of an atomic amount: 100000n, 6 -> "0.1". No exponent, no trailing zeros. */
export function formatAtomicAmount(atomic: bigint, decimals: number): string {
  if (typeof atomic !== 'bigint' || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new ClawPumpWriterError('invalid_input');
  }
  const sign = atomic < 0n ? '-' : '';
  const digits = (atomic < 0n ? -atomic : atomic).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/**
 * A vendor UI amount (number or decimal string) in atomic units, rounded DOWN.
 * A number is read from its shortest decimal text (String(0.29) = "0.29"), so
 * float error never changes the result; exponent text ("1e-7") is accepted.
 * Null when the value is not finite, below 0, or not a decimal. Never throws.
 */
export function parseUiAmountToAtomic(value: number | string, decimals: number): bigint | null {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) return null;
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
    const asNumber = Number(text);
    if (text === '' || text.length > 64 || !Number.isFinite(asNumber) || asNumber < 0) return null;
  } else {
    return null;
  }
  const match = UI_AMOUNT_RE.exec(text);
  if (!match) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (whole === '' && fraction === '') return null;
  const digits = `${whole}${fraction}`;
  // Count of digits that stay in front of the decimal point after the scale to atomic units.
  const kept = whole.length + Number(match[3] ?? 0) + decimals;
  if (kept <= 0) return 0n;
  if (kept >= digits.length) return BigInt(digits) * 10n ** BigInt(kept - digits.length);
  return BigInt(digits.slice(0, kept));
}

const walletBalanceWire = z.union([z.number(), z.string().max(64)]);
const walletHistoryWire = z.object({
  address: z.string().max(64),
  solBalance: walletBalanceWire,
  usdcBalance: walletBalanceWire,
  transactions: z.array(z.object({
    signature: z.string().min(1).max(128),
    status: z.string().max(64).nullish(),
  }).passthrough()).max(MAX_HISTORY_ROWS),
}).passthrough();

/**
 * GET /wallets/{id}/history: the LIVE balances of an arena agent's wallet
 * (Run 2 fact 3: /wallets/summary is cached, so it is never used here).
 * Order: agent id -> house id refused -> DB ownership (no network) -> one
 * normal-priority GET. A missing or unreadable balance throws schema_invalid.
 */
export async function readArenaWalletLive(
  agentId: string,
  ownership: ClawPumpWriterOwnership,
  options: ClawPumpWriterOptions & { limit?: number } = {},
): Promise<ClawPumpArenaWalletLive> {
  assertAgentId(agentId);
  const { limit = DEFAULT_HISTORY_LIMIT, ...rest } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_ROWS) throw new ClawPumpWriterError('invalid_input');
  await assertOwnedArenaAgent(agentId, ownership);
  const readAt = new Date();
  const parsed = walletHistoryWire.safeParse(
    await sendJson('GET', `/wallets/${agentId}/history?limit=${limit}`, undefined, { ...rest, priority: 'normal' }),
  );
  if (!parsed.success) throw new ClawPumpWriterError('schema_invalid');
  const addressProblem = arenaDestinationProblem(parsed.data.address);
  if (addressProblem === 'not_base58' || addressProblem === 'not_32_bytes') throw new ClawPumpWriterError('schema_invalid');
  const solLamports = parseUiAmountToAtomic(parsed.data.solBalance, SOL_DECIMALS);
  const usdcAtomic = parseUiAmountToAtomic(parsed.data.usdcBalance, USDC_DECIMALS);
  if (solLamports === null || usdcAtomic === null) throw new ClawPumpWriterError('schema_invalid');
  return {
    address: parsed.data.address,
    solLamports,
    usdcAtomic,
    readAt,
    transactions: parsed.data.transactions.map((tx) => ({ signature: tx.signature, status: tx.status ?? null })),
  };
}

interface CheckedTransfer {
  to: string;
  asset: ArenaTransferAsset;
  amountAtomic: bigint;
  expectedSource: string;
  decimals: number;
}

/** A copy of the checked input, so a later change to the caller's object cannot reach the POST. */
function checkTransferInput(input: ArenaTransferInput): CheckedTransfer {
  const { to, asset, amountAtomic, expectedSource } = (input ?? {}) as Partial<ArenaTransferInput>;
  if (asset !== 'USDC' && asset !== 'SOL') throw new ClawPumpWriterError('invalid_input');
  if (typeof amountAtomic !== 'bigint' || amountAtomic <= 0n || amountAtomic > MAX_TRANSFER_ATOMIC) {
    throw new ClawPumpWriterError('invalid_input');
  }
  if (typeof to !== 'string' || arenaDestinationProblem(to) !== null) throw new ClawPumpWriterError('invalid_input');
  const sourceProblem = typeof expectedSource === 'string' ? arenaDestinationProblem(expectedSource) : 'not_base58';
  if (sourceProblem === 'not_base58' || sourceProblem === 'not_32_bytes') throw new ClawPumpWriterError('invalid_input');
  if (to === expectedSource) throw new ClawPumpWriterError('invalid_input');
  return { to, asset, amountAtomic, expectedSource: expectedSource as string, decimals: asset === 'USDC' ? USDC_DECIMALS : SOL_DECIMALS };
}

type TransferPostReply =
  | { kind: 'reply'; status: number; bodyRead: boolean; payload: unknown }
  | { kind: 'no_reply'; code: 'timeout' | 'network_error' };

function transportCode(error: unknown): 'timeout' | 'network_error' {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error';
}

/**
 * The transfer POST. Same config, host check and call budget as sendJson. It
 * throws only not_configured, invalid_base_url or budget_exhausted, all BEFORE
 * fetch. After fetch starts it never throws and never retries: it returns the
 * HTTP status and the JSON body (read up to 1 MB) for ANY status, or the
 * transport failure.
 */
async function sendTransferPost(path: string, body: unknown, options: ClawPumpWriterOptions): Promise<TransferPostReply> {
  let config: ReturnType<typeof resolveClawPumpConfig>;
  try {
    config = resolveClawPumpConfig(options.env ?? process.env);
  } catch (error) {
    throw toWriterError(error);
  }
  const url = new URL(path, config.origin);
  if (url.origin !== config.origin) throw new ClawPumpWriterError('invalid_base_url');
  const requestBody = JSON.stringify(body);
  if (!takeWriterToken('normal')) throw new ClawPumpWriterError('budget_exhausted');
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: requestBody,
      redirect: 'error',
      signal: AbortSignal.timeout(CLAWPUMP_TRANSFER_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: 'no_reply', code: transportCode(error) };
  }
  try {
    const status = response.status;
    if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_CHARS) {
      return { kind: 'reply', status, bodyRead: false, payload: undefined };
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) return { kind: 'reply', status, bodyRead: false, payload: undefined };
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    return { kind: 'reply', status, bodyRead: true, payload };
  } catch (error) {
    return { kind: 'no_reply', code: transportCode(error) };
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Contract §3 reply classification. Pure, reads plain JSON values only, never throws. */
function classifyTransferReply(reply: TransferPostReply, transfer: CheckedTransfer): ArenaTransferOutcome {
  if (reply.kind === 'no_reply') return { kind: 'unknown', code: reply.code, txSignature: null };
  const payload = isPlainRecord(reply.payload) ? reply.payload : null;
  const txHash = payload?.txHash;
  // Any txHash value, even one that is not a valid signature, means the reply does not prove "nothing sent".
  const hasTxHash = txHash !== undefined && txHash !== null && txHash !== '';
  const txSignature = typeof txHash === 'string' && TX_SIGNATURE_RE.test(txHash) ? txHash : null;
  const { status } = reply;
  if (status < 200 || status > 299) {
    const code = `http_${status}`;
    // A body over 1 MB, or one that was not read, cannot prove "no txHash".
    if (TRANSFER_NO_SEND_HTTP_STATUSES.has(status) && reply.bodyRead && !hasTxHash) return { kind: 'rejected', code };
    return { kind: 'unknown', code, txSignature };
  }
  if (payload === null) return { kind: 'unknown', code: 'reply_unparsed', txSignature: null };
  if (payload.ok === false) {
    const vendorCode = typeof payload.code === 'string' ? payload.code : null;
    const code = vendorCode !== null && VENDOR_CODE_RE.test(vendorCode) ? `vendor_${vendorCode}` : 'vendor_error';
    if (status === 200 && !hasTxHash && vendorCode !== null && CLAWPUMP_TRANSFER_NO_SEND_VENDOR_CODES.has(vendorCode)) {
      return { kind: 'rejected', code };
    }
    return { kind: 'unknown', code, txSignature };
  }
  if (payload.ok !== true) return { kind: 'unknown', code: 'reply_unparsed', txSignature };
  if (txSignature === null) return { kind: 'unknown', code: 'no_tx_hash', txSignature: null };
  const assetField = transfer.asset === 'USDC' ? payload.mint : payload.token;
  if ([payload.from, payload.to, payload.amount, assetField].some((field) => field === undefined || field === null)) {
    // ok:true with a signature but without the fields to check: the chain decides (reconcile by signature).
    return { kind: 'unknown', code: 'reply_unparsed', txSignature };
  }
  const amount = typeof payload.amount === 'number' || typeof payload.amount === 'string'
    ? parseUiAmountToAtomic(payload.amount, transfer.decimals)
    : null;
  const assetMatches = transfer.asset === 'USDC'
    ? payload.mint === TRADE_MINTS.USDC
    : typeof payload.token === 'string' && payload.token.toUpperCase() === 'SOL';
  if (payload.from !== transfer.expectedSource || payload.to !== transfer.to || amount !== transfer.amountAtomic || !assetMatches) {
    return { kind: 'mismatch', code: 'reply_mismatch', txSignature };
  }
  if (payload.status !== 'sent') {
    // Lead decision 2026-10-02: the fields match, so the money may still move.
    // Reconcile confirms it on chain by the signature (exact deltas); no operator step.
    const vendorStatus = typeof payload.status === 'string' ? payload.status.toLowerCase() : '';
    const code = VENDOR_STATUS_RE.test(vendorStatus) ? `vendor_status_${vendorStatus}` : 'vendor_status_other';
    return { kind: 'unknown', code, txSignature };
  }
  return {
    kind: 'sent',
    txSignature,
    recipientAccountCreated: typeof payload.createdRecipientTokenAccount === 'boolean' ? payload.createdRecipientTokenAccount : null,
  };
}

/**
 * POST /wallets/{id}/transfer ONCE from the arena agent's wallet. Guard order
 * (every throw is BEFORE the POST, so a throw always means "nothing sent"):
 * agent id -> input -> assertArenaAgent (house id, DB ownership, env prefix and
 * row suffix; one GET) -> status 'stopped' -> wallet = expectedSource -> POST.
 * Both calls use a normal-priority token (the removal reserve stays free).
 * No whitelist call (D34-a). Not retried: a timeout or any unclear reply is
 * 'unknown', and the caller reconciles on chain.
 */
export async function transferFromArenaWallet(
  agentId: string,
  input: ArenaTransferInput,
  ownership: ClawPumpWriterOwnership,
  options: ClawPumpWriterOptions = {},
): Promise<ArenaTransferOutcome> {
  assertAgentId(agentId);
  const transfer = checkTransferInput(input);
  const callOptions: ClawPumpWriterOptions = { ...options, priority: 'normal' };
  const current = await assertArenaAgent(agentId, ownership, callOptions);
  assertStopped(current.status);
  if (current.walletAddress !== transfer.expectedSource) throw new ClawPumpWriterError('wallet_mismatch');
  const reply = await sendTransferPost(`/wallets/${agentId}/transfer`, {
    to: transfer.to,
    amount: formatAtomicAmount(transfer.amountAtomic, transfer.decimals),
    token: transfer.asset === 'USDC' ? TRADE_MINTS.USDC : 'SOL',
  }, callOptions);
  try {
    return classifyTransferReply(reply, transfer);
  } catch {
    // The classifier reads plain JSON values only. If it ever threw, a throw here
    // would tell the caller "nothing sent" after a POST: return 'unknown' instead.
    return { kind: 'unknown', code: 'reply_unparsed', txSignature: null };
  }
}

/** The withdraw surface the arena engine depends on, so tests inject a fake. Separate from ClawPumpArenaWriter. */
export interface ClawPumpArenaWithdrawWriter {
  /** `arenaAgentId` = the user arena row that must own this ClawPump agent. */
  readWalletLive(agentId: string, arenaAgentId: string): Promise<ClawPumpArenaWalletLive>;
  /** A throw = nothing sent. After the POST starts it returns an outcome and never throws. */
  transfer(agentId: string, input: ArenaTransferInput, arenaAgentId: string): Promise<ArenaTransferOutcome>;
}

export const clawPumpArenaWithdrawWriter: ClawPumpArenaWithdrawWriter = {
  readWalletLive: (agentId, arenaAgentId) => readArenaWalletLive(agentId, { arenaAgentId }),
  transfer: (agentId, input, arenaAgentId) => transferFromArenaWallet(agentId, input, { arenaAgentId }),
};
