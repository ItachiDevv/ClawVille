import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS, TRADE_MINTS } from '@clawville/shared';
import { ClawPumpClientError, clawPumpUrl, resolveClawPumpConfig, type ClawPumpClientOptions } from './clawpump-client';
import { isArenaClawPumpOwnedBy, isArenaUserClawPumpOwnedBy } from './floor-arena/queries';

/**
 * ClawPump WRITE client for the Trading Floor Arena (docs/trading-floor-arena.md D8, D9, section 6i).
 *
 * ClawPump moved its REST API to the v1 gateway `https://clawpump.tech/api/v1`
 * around 2026-10-22. Two hosts now carry the arena's calls:
 *
 * 1. The v1 gateway (Bearer `CLAWPUMP_API_KEY`, host allowlist in
 *    `resolveClawPumpConfig`). Contract: https://clawpump.tech/developers, read
 *    2026-11-18. Replies are camelCase (`walletAddress`, `skills`, `isPublic`).
 *      create -> POST /agents {name, persona, system_prompt, model?}   flat fields; no skills, no strategy
 *      read   -> GET  /agents/{id}                                      flat agent object + meta
 *      update -> POST /agents/{id} {is_public: false} | {accepting_bids: false}
 *                POST, not PATCH; snake_case fields, ONE field per body (each body was verified
 *                alone). VERIFIED by the lead 2026-11-19: `{"isPublic":false}` -> 400 "No allowed
 *                fields in request body"; `{"is_public":false}` -> 200 and `{"accepting_bids":false}`
 *                -> 200, the agent became private and closed to bids, skills unchanged (portal check).
 *                The dashboard's own save sends the same snake_case names (PATCH on the backend).
 * 2. ClawPump's internal backend ("Advanced: direct backend access" on
 *    /developers). The key is exchanged at `POST https://clawpump.tech/api/mcp/token`
 *    for `{access_token, api_url, expires_in: 3600}`; `api_url` was
 *    `https://clawpump-ai-agents.clawpump-fee-collect-cloudflare.workers.dev`
 *    (one exchange, 2026-11-19). Only that exact host is allowed
 *    (CLAWPUMP_BACKEND_ORIGIN), and only the short-lived token goes there: the
 *    `cpk_` key never leaves clawpump.tech. Route names come from the open
 *    source MCP server `@clawpump/agents` 0.1.28 `dist/server.js` (its backend client).
 *      listing  -> GET /agents/{id} -> {id, is_public, accepting_bids, ...} snake_case; v1 GET has no
 *                  accepting_bids, so this read is the privacy proof. VERIFIED (read-only GET) 2026-11-19.
 *      wallets  -> GET /wallets/summary -> {wallets: [{agent_id, wallet_address, sol_balance, usdc_balance, updated_at}]}
 *      wallet   -> GET /wallets/{id}/history?limit=N -> {address, solBalance, usdcBalance, transactions}
 *                  Both VERIFIED with read-only GETs 2026-11-19 (on an empty arena wallet, so no transaction row was seen).
 *      transfer -> POST /wallets/{id}/transfer {to, amount, token}             NOT VERIFIED on this host
 *      x402     -> POST /agents/{id}/x402/x402_service_details | _pay          NOT VERIFIED on this host
 *    The backend answers 404 to any method a route does not take, so a GET
 *    cannot prove a POST route exists, and a POST would move money. The POST
 *    routes therefore fail closed with `route_not_verified` BEFORE any request
 *    (CLAWPUMP_VERIFIED_BACKEND_POSTS is empty). Opening one is a reviewed code
 *    change after a founder-approved live test, never an env flip.
 *
 * Rules: strict timeouts, typed errors that carry only a code and an HTTP
 * status, NO logging at all (so the key, the token and the vendor body never
 * reach a log), and NO retry of a non-idempotent POST (create, update, pay,
 * transfer). The provisioning job retries a failed create later with a NEW
 * create; it never adopts an existing agent (Codex r18 #4).
 *
 * Skills (founder 2026-11-19): ClawVille no longer strips or adds skills. A
 * v1 create always carries ClawPump's base bundle (x402, perps, wallet, ...,
 * plus trading when no strategy is sent); the founder allowed them because the
 * arena is paper only and live mode answers live_not_available. Privacy is
 * enforced instead: every arena agent is made private and closed to
 * marketplace bids (provisioning and the
 * privacy repair pass in floor-arena/provisioning.ts).
 *
 * Live-trader guard (`assertArenaAgent`, checked fresh on every call): an
 * update or payment names the arena row it acts for, and the ClawPump id
 * must be that row's `clawpump_agent_id` (DB proof: a USER or HOUSE row for the
 * privacy update, a USER row only for a payment, a live wallet read or a
 * transfer); FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS are refused outright, even
 * when a row names one; and ClawPump's current name must carry this
 * environment's arena prefix plus that row's id suffix. A live trader
 * (Genesis, Runner, Dip Hunter, Clawville_World on the founder's staging
 * account) can therefore never be re-configured or spend through here, even
 * after a rename.
 * The guard's GET is the last read before a money write (Codex r19 #3, r22):
 * only a 'stopped' agent gets a payment or a transfer. The privacy update only
 * takes visibility away, so it is sent at any status.
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

/**
 * The LIVE trading ClawPump agents (Genesis, Runner, Dip Hunter): the arena
 * writer must never update, read the wallet of, pay from or transfer from one
 * of them, whatever their name and whatever an arena row says (the check runs
 * BEFORE the DB ownership proof). PERMANENT: built only from
 * FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS, never from the house seed (SPEC
 * house-clawpump-x402 TRAP A: the house seed now holds no ClawPump id).
 */
export const CLAWPUMP_LIVE_TRADER_AGENT_IDS: ReadonlySet<string> = new Set(FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS);
/** Old name of CLAWPUMP_LIVE_TRADER_AGENT_IDS (same set), kept for existing callers. */
export const CLAWPUMP_HOUSE_AGENT_IDS: ReadonlySet<string> = CLAWPUMP_LIVE_TRADER_AGENT_IDS;
/** True for a live trading ClawPump agent id (the permanent deny set). */
export function isLiveTraderClawPumpId(agentId: string | null | undefined): boolean {
  return typeof agentId === 'string' && CLAWPUMP_LIVE_TRADER_AGENT_IDS.has(agentId.trim().toLowerCase());
}
/** A single x402 call may never authorise more than this, whatever the caller asks. */
export const CLAWPUMP_X402_MAX_CALL_USD = 5;
/**
 * The ONLY hosts an arena add-on may pay (lead rule, vetted 2026-09-30). A
 * catalog edit alone can never point a player's USDC at a new vendor: adding a
 * host is a reviewed change here.
 */
export const CLAWPUMP_X402_ALLOWED_HOSTS: ReadonlySet<string> = new Set(['api.nansen.ai']);

/**
 * ClawPump's internal backend: the ONLY host the exchanged token may go to.
 * `POST /api/mcp/token` named it as `api_url` on 2026-11-19. Any other
 * `api_url` (another host, a port, a path) fails closed with
 * `backend_not_allowed`, and the token is never used.
 */
export const CLAWPUMP_BACKEND_ORIGIN = 'https://clawpump-ai-agents.clawpump-fee-collect-cloudflare.workers.dev';
/** The key exchange path (outside /api/v1, on the v1 gateway host). */
export const CLAWPUMP_TOKEN_PATH = '/api/mcp/token';
export type ClawPumpBackendPost = 'transfer' | 'x402';
/**
 * Backend POST routes whose request and reply were VERIFIED on the current
 * backend host. EMPTY (2026-11-19): neither the transfer route nor the x402
 * routes were verified after the 10-22 move (a POST moves money; a GET cannot
 * prove the route). Every such call throws `route_not_verified` before any request.
 */
export const CLAWPUMP_VERIFIED_BACKEND_POSTS: ReadonlySet<ClawPumpBackendPost> = new Set<ClawPumpBackendPost>();
const X402_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_CHARS = 1_000_000;
/** GET /wallets/summary grows with every arena player (one ClawPump agent each). */
const MAX_LIST_RESPONSE_CHARS = 8_000_000;
const MAX_LIST_AGENTS = 5_000;
/** The exchanged token is renewed this long before ClawPump's `expires_in` ends (at most half its life). */
const BACKEND_TOKEN_MARGIN_MS = 5 * 60_000;

export type ClawPumpWriterErrorCode =
  | 'not_configured' | 'invalid_base_url' | 'invalid_agent_id' | 'invalid_input' | 'not_arena_agent'
  | 'unauthorized' | 'not_found' | 'payment_required' | 'rate_limited' | 'http_error'
  | 'timeout' | 'network_error' | 'response_too_large' | 'schema_invalid' | 'host_not_allowed'
  | 'agent_running' | 'agent_not_stopped' | 'x402_not_enabled' | 'budget_exhausted' | 'wallet_mismatch'
  | 'backend_not_allowed' | 'route_not_verified';

export class ClawPumpWriterError extends Error {
  constructor(readonly code: ClawPumpWriterErrorCode, readonly status: number | null = null) {
    // Code and HTTP status only: never the key, a token, a URL, or a vendor body.
    super(`clawpump_${code}${status === null ? '' : `_${status}`}`);
    this.name = 'ClawPumpWriterError';
  }
}

/** 'removal' calls may use the reserved end of the shared call budget (the privacy repair). */
export type ClawPumpCallPriority = 'removal' | 'normal';

export interface ClawPumpWriterOptions extends ClawPumpClientOptions {
  /** Budget priority for this call (default 'normal'). */
  priority?: ClawPumpCallPriority;
  /**
   * TEST SEAM ONLY: backend POST routes to treat as verified, so the unit tests
   * can still exercise the request and reply handling. No production caller
   * passes it (the exported writer surfaces never do).
   */
  _testVerifiedBackendPosts?: ReadonlySet<ClawPumpBackendPost>;
}

export interface ClawPumpCreatedAgent {
  id: string;
  name: string | null;
  status: string | null;
  walletAddress: string | null;
  /** v1 public skill slugs (`trading`, `x402`, ...); null when the reply has no list. */
  skills: string[] | null;
  /** null when the reply has no `isPublic`: never read as "private". */
  isPublic: boolean | null;
}

/** The marketplace visibility of an agent, from the backend read. null = the field is missing: never read as "off". */
export interface ClawPumpAgentListing {
  id: string;
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

/** v1 POST /agents body (flat). No `skills` and no `strategy`: ClawPump's default bundle stays (founder 2026-11-19). */
export const createAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(48),
  persona: z.string().trim().min(1).max(2_000),
  system_prompt: z.string().trim().min(1).max(4_000),
  model: z.string().trim().min(1).max(120).optional(),
}).strict();
export type CreateClawPumpAgentInput = z.infer<typeof createAgentInputSchema>;

/**
 * v1 POST /agents/{id} body: EXACTLY one of `{is_public: false}` or
 * `{accepting_bids: false}` (each body verified live alone, 2026-11-19). The
 * writer can only take visibility away: never make an agent public, never
 * change skills, persona or model.
 */
export const updateAgentPatchSchema = z.union([
  z.object({ is_public: z.literal(false) }).strict(),
  z.object({ accepting_bids: z.literal(false) }).strict(),
]);
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
// v1 agent replies are camelCase (GET /api/v1/agents reply keys, 2026-11-18).
const agentWire = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(200).nullish(),
  status: z.string().max(40).nullish(),
  walletAddress: z.string().max(64).nullish(),
  skills: z.array(z.string().max(80)).max(100).nullish(),
  isPublic: z.boolean().nullish(),
}).passthrough();
const wrappedAgentWire = z.object({ agent: agentWire }).passthrough();
// Backend GET /agents/{id} is snake_case (read 2026-11-19).
const listingWire = z.object({
  id: z.string().min(1).max(128),
  is_public: z.boolean().nullish(),
  accepting_bids: z.boolean().nullish(),
}).passthrough();
const amountWire = z.union([z.number(), z.string().max(40)]).nullish();
// Backend /wallets/summary rows are snake_case (read 2026-11-19).
const walletWire = z.object({
  agent_id: z.string().min(1).max(128),
  wallet_address: z.string().max(64).nullish(),
  sol_balance: amountWire,
  usdc_balance: amountWire,
  updated_at: z.string().max(64).nullish(),
}).passthrough();
const walletSummaryWire = z.object({ wallets: z.array(walletWire).max(MAX_LIST_AGENTS) }).passthrough();
const backendTokenWire = z.object({
  access_token: z.string().min(20).max(8_192),
  api_url: z.string().max(500),
  expires_in: z.number().positive().max(86_400),
}).passthrough();

function toWriterError(error: unknown): ClawPumpWriterError {
  if (error instanceof ClawPumpWriterError) return error;
  if (error instanceof ClawPumpClientError) return new ClawPumpWriterError(error.code, error.status);
  return new ClawPumpWriterError('network_error');
}

/**
 * Codex r20 (3) / audit-money B: a per-process token bucket over EVERY call this
 * writer makes (create, update, agent GET, wallet summary, wallet history, the
 * backend key exchange, and the x402 and transfer POSTs once verified),
 * checked BEFORE the request, so the arena can never flood the ClawPump key
 * the house traders share. 60 calls a minute, burst 10 (code constants, no env
 * var). The last REMOVAL_RESERVE tokens are for removal-priority calls only
 * (the privacy repair, which only takes visibility away), so it always gets
 * the first claim: half of the burst (5 of 10) is theirs alone; normal calls
 * (provisioning, add-on checks, wallet reads) stop above that floor. Empty ->
 * 'budget_exhausted' (our own code, distinct from ClawPump's HTTP 429
 * 'rate_limited') before any request, so nothing can have been charged; the
 * next tick retries. Scope: every ClawPump call the ARENA makes through this
 * writer. The house traders' own calls and the paper-fill quotes (other
 * subsystems, other clients) are out of scope.
 * Quota: ClawPump's /developers page lists 10,000,000 calls a month for the
 * Enterprise tier (about 230 a minute on average) and says call limits are
 * "recorded but not enforced", with no per-second limit and no documented
 * burst ceiling. 60 a minute leaves most of that for the house traders.
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

// ─── Backend session (key exchange) ─────────────────────────────────────────

interface BackendSession { token: string; expiresAtMs: number; forKey: string }
let backendSession: BackendSession | null = null;
let backendSessionInflight: Promise<BackendSession> | null = null;

/** Test seam: forget the cached backend token. */
export function _resetClawPumpBackendSessionForTest(): void {
  backendSession = null;
  backendSessionInflight = null;
}

/** True only for exactly CLAWPUMP_BACKEND_ORIGIN: https, that host, no port, no credentials, no path, query or hash. */
export function isAllowedBackendApiUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash
    && url.pathname === '/' && url.origin === CLAWPUMP_BACKEND_ORIGIN;
}

/** Maps a non-2xx status to the writer's error (shared by every call). */
function statusError(status: number): ClawPumpWriterError {
  if (status === 401 || status === 403) return new ClawPumpWriterError('unauthorized', status);
  if (status === 404) return new ClawPumpWriterError('not_found', 404);
  if (status === 402) return new ClawPumpWriterError('payment_required', 402);
  if (status === 429) return new ClawPumpWriterError('rate_limited', 429);
  return new ClawPumpWriterError('http_error', status);
}

function transportError(error: unknown): ClawPumpWriterError {
  const name = (error as { name?: string } | null)?.name;
  return new ClawPumpWriterError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error');
}

/**
 * ONE `POST /api/mcp/token` with the `cpk_` key, to clawpump.tech only (the
 * origin `resolveClawPumpConfig` allows). The reply's `api_url` must be
 * CLAWPUMP_BACKEND_ORIGIN exactly. Counted in the call budget (the caller's
 * priority). Not retried: a failure throws and the next call tries again.
 */
async function exchangeBackendToken(
  config: ReturnType<typeof resolveClawPumpConfig>,
  options: ClawPumpWriterOptions,
): Promise<BackendSession> {
  if (!takeWriterToken(options.priority ?? 'normal')) throw new ClawPumpWriterError('budget_exhausted');
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(new URL(config.origin + CLAWPUMP_TOKEN_PATH), {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw transportError(error);
  }
  if (!response.ok) throw statusError(response.status);
  let text: string;
  try { text = await response.text(); } catch { throw new ClawPumpWriterError('timeout', response.status); }
  if (text.length > MAX_RESPONSE_CHARS) throw new ClawPumpWriterError('response_too_large', response.status);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new ClawPumpWriterError('schema_invalid', response.status); }
  const parsed = backendTokenWire.safeParse(body);
  if (!parsed.success) throw new ClawPumpWriterError('schema_invalid', response.status);
  if (!isAllowedBackendApiUrl(parsed.data.api_url)) throw new ClawPumpWriterError('backend_not_allowed');
  const lifetimeMs = parsed.data.expires_in * 1_000;
  return {
    token: parsed.data.access_token,
    expiresAtMs: Date.now() + lifetimeMs - Math.min(BACKEND_TOKEN_MARGIN_MS, lifetimeMs / 2),
    forKey: config.apiKey,
  };
}

/** The cached backend token, or ONE exchange shared by every caller waiting for it (single flight). */
async function readBackendToken(
  config: ReturnType<typeof resolveClawPumpConfig>,
  options: ClawPumpWriterOptions,
): Promise<string> {
  const cached = backendSession;
  if (cached && cached.forKey === config.apiKey && cached.expiresAtMs > Date.now()) return cached.token;
  backendSessionInflight ??= exchangeBackendToken(config, options)
    .then((session) => {
      backendSession = session;
      return session;
    })
    .finally(() => {
      backendSessionInflight = null;
    });
  return (await backendSessionInflight).token;
}

type ClawPumpHost = 'v1' | 'backend';

interface ResolvedCall { url: URL; bearer: string; timeoutMs: number }

/**
 * Config, URL and Bearer for one call, every check BEFORE the request: the key
 * and the v1 base (`resolveClawPumpConfig`), the path, the backend token (an
 * exchange when none is cached), then the call budget. The `cpk_` key goes
 * only to the v1 gateway; the backend gets only the exchanged token.
 */
async function resolveCall(host: ClawPumpHost, path: string, options: ClawPumpWriterOptions): Promise<ResolvedCall> {
  let config: ReturnType<typeof resolveClawPumpConfig>;
  let url: URL;
  try {
    config = resolveClawPumpConfig(options.env ?? process.env);
    url = host === 'v1'
      ? clawPumpUrl(config, path)
      : clawPumpUrl({ origin: CLAWPUMP_BACKEND_ORIGIN, basePath: '' }, path);
  } catch (error) {
    throw toWriterError(error);
  }
  const bearer = host === 'v1' ? config.apiKey : await readBackendToken(config, options);
  if (!takeWriterToken(options.priority ?? 'normal')) throw new ClawPumpWriterError('budget_exhausted');
  return { url, bearer, timeoutMs: config.timeoutMs };
}

/** A 401 or 403 from the backend ends the cached token, so the next call exchanges a new one. */
function noteBackendStatus(host: ClawPumpHost, status: number): void {
  if (host === 'backend' && (status === 401 || status === 403)) backendSession = null;
}

async function sendJson(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  options: ClawPumpWriterOptions,
  host: ClawPumpHost = 'v1',
  timeoutOverrideMs?: number,
  maxChars: number = MAX_RESPONSE_CHARS,
): Promise<unknown> {
  const call = await resolveCall(host, path, options);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(call.url, {
      method,
      headers: {
        Authorization: `Bearer ${call.bearer}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutOverrideMs ?? call.timeoutMs),
    });
  } catch (error) {
    throw transportError(error);
  }
  noteBackendStatus(host, response.status);
  if (!response.ok) throw statusError(response.status);
  if (Number(response.headers.get('content-length') ?? 0) > maxChars) {
    throw new ClawPumpWriterError('response_too_large', response.status);
  }
  let text: string;
  try { text = await response.text(); } catch { throw new ClawPumpWriterError('timeout', response.status); }
  if (text.length > maxChars) throw new ClawPumpWriterError('response_too_large', response.status);
  try { return JSON.parse(text); } catch { throw new ClawPumpWriterError('schema_invalid', response.status); }
}

/** Throws `route_not_verified` (nothing sent) unless the backend POST route is verified. */
function assertBackendPostVerified(route: ClawPumpBackendPost, options: ClawPumpWriterOptions): void {
  const verified = options._testVerifiedBackendPosts ?? CLAWPUMP_VERIFIED_BACKEND_POSTS;
  if (!verified.has(route)) throw new ClawPumpWriterError('route_not_verified');
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
    walletAddress: wire.walletAddress?.trim() || null,
    skills: wire.skills ?? null,
    isPublic: wire.isPublic ?? null,
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

/**
 * Every writer call that names a ClawPump agent (read, x402 check, update, pay,
 * live wallet read, transfer) starts here, so a LIVE trader id is refused
 * before any request (Codex review of 3548d4f5, P1).
 */
function assertAgentId(agentId: string): void {
  if (!agentIdSchema.safeParse(agentId).success) throw new ClawPumpWriterError('invalid_agent_id');
  if (isLiveTraderClawPumpId(agentId)) throw new ClawPumpWriterError('not_arena_agent');
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
  /** Arena row this ClawPump agent must belong to (`floor_arena_agents.id`; kind 'user', or 'house' for the privacy update). */
  arenaAgentId: string;
  /** Ownership proof; default: the `floor_arena_agents` row read fresh (no cache). */
  isOwnedBy?: (clawpumpAgentId: string, arenaAgentId: string) => Promise<boolean>;
}

/**
 * Which arena rows may own the agent for this call. 'arena' (user or house):
 * the privacy update only. 'user': every call that can move money (x402 pay,
 * live wallet read for a withdraw, transfer); house rows have no owner and
 * no withdraw (SPEC house-clawpump-x402 T3).
 */
type ArenaOwnerScope = 'arena' | 'user';

/**
 * Codex r17 #4: every update and every payment is bound to ONE arena row,
 * checked fresh on each call (no cache that could survive a rename):
 *   1. never a live trader id (static, permanent deny set);
 *   2. the ClawPump id IS the clawpump_agent_id of that arena row (DB proof,
 *      USER rows only for money calls);
 *   3. ClawPump's current name is this environment's arena prefix AND ends with
 *      that row's id suffix (an extra layer against a renamed foreign agent).
 * Returns that fresh read: it is the LAST read before the write (Codex r19 #3).
 */
async function assertArenaAgent(
  agentId: string,
  ownership: ClawPumpWriterOwnership,
  options: ClawPumpWriterOptions,
  scope: ArenaOwnerScope,
): Promise<ClawPumpCreatedAgent> {
  await assertOwnedArenaAgent(agentId, ownership, scope);
  const current = await readClawPumpArenaAgent(agentId, options);
  const name = current.name;
  if (!isArenaAgentName(name, options.env ?? process.env) || !name!.trim().endsWith(arenaAgentNameSuffix(ownership.arenaAgentId))) {
    throw new ClawPumpWriterError('not_arena_agent');
  }
  return current;
}

/** Steps 1 and 2 of assertArenaAgent: the static live-trader deny set, then the DB proof. No network call. */
async function assertOwnedArenaAgent(agentId: string, ownership: ClawPumpWriterOwnership, scope: ArenaOwnerScope): Promise<void> {
  if (isLiveTraderClawPumpId(agentId)) throw new ClawPumpWriterError('not_arena_agent');
  const proof = ownership.isOwnedBy ?? (scope === 'arena' ? isArenaClawPumpOwnedBy : isArenaUserClawPumpOwnedBy);
  const owned = await proof(agentId, ownership.arenaAgentId);
  if (!owned) throw new ClawPumpWriterError('not_arena_agent');
}

/** True when the agent's skill list (v1 public slugs) holds `skill` (trimmed, any case). */
export function agentHasSkill(agent: { skills: string[] | null }, skill: string): boolean {
  return (agent.skills ?? []).some((have) => have.trim().toLowerCase() === skill);
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
 * v1 POST /agents with the flat documented fields. NOT idempotent and never
 * retried here. ClawPump creates agents PUBLIC with its default skill bundle;
 * the caller makes the agent private after it saved the id (provisioning).
 */
export async function createClawPumpAgent(
  input: CreateClawPumpAgentInput,
  options: ClawPumpWriterOptions = {},
): Promise<ClawPumpCreatedAgent> {
  const parsed = createAgentInputSchema.safeParse(input);
  if (!parsed.success) throw new ClawPumpWriterError('invalid_input');
  if (!isArenaAgentName(parsed.data.name, options.env ?? process.env)) throw new ClawPumpWriterError('not_arena_agent');
  const created = toCreatedAgent(await sendJson('POST', '/agents', {
    name: parsed.data.name,
    persona: parsed.data.persona,
    system_prompt: parsed.data.system_prompt,
    ...(parsed.data.model ? { model: parsed.data.model } : {}),
  }, options));
  if (!agentIdSchema.safeParse(created.id).success) throw new ClawPumpWriterError('schema_invalid');
  // A create can never hand back a live trader for an arena row to save.
  if (isLiveTraderClawPumpId(created.id)) throw new ClawPumpWriterError('not_arena_agent');
  return created;
}

/**
 * v1 POST /agents/{id} with `{is_public: false}` or `{accepting_bids: false}`
 * for the arena row that owns it, at any status (it only takes visibility
 * away). The reply body is not proof (its shape is not documented): the caller
 * confirms with readClawPumpArenaListing.
 */
export async function updateClawPumpAgent(
  agentId: string,
  patch: UpdateClawPumpAgentPatch,
  ownership: ClawPumpWriterOwnership,
  options: ClawPumpWriterOptions = {},
): Promise<void> {
  assertAgentId(agentId);
  const parsed = updateAgentPatchSchema.safeParse(patch);
  if (!parsed.success) throw new ClawPumpWriterError('invalid_input');
  await assertArenaAgent(agentId, ownership, options, 'arena');
  await sendJson('POST', `/agents/${agentId}`, parsed.data, options);
}

/**
 * Backend GET /wallets/summary: SOL + USDC (UI units) for every agent of the
 * account, EXCEPT the live traders: their rows are dropped here, so no caller
 * can ever read a live trader's wallet or balance through the arena writer.
 */
export async function getClawPumpWalletBalances(options: ClawPumpWriterOptions = {}): Promise<ClawPumpWalletBalance[]> {
  const parsed = walletSummaryWire.safeParse(
    await sendJson('GET', '/wallets/summary', undefined, options, 'backend', undefined, MAX_LIST_RESPONSE_CHARS),
  );
  if (!parsed.success) throw new ClawPumpWriterError('schema_invalid');
  return parsed.data.wallets.filter((wire) => !isLiveTraderClawPumpId(wire.agent_id)).map((wire) => ({
    agentId: wire.agent_id,
    walletAddress: wire.wallet_address?.trim() || null,
    sol: toAmount(wire.sol_balance),
    usdc: toAmount(wire.usdc_balance),
    updatedAt: wire.updated_at ?? null,
  }));
}

/**
 * Backend POST /agents/{id}/x402/x402_service_details. Free: reads the 402
 * challenge, pays nothing. NOT VERIFIED on the current backend: it fails
 * closed with `route_not_verified` after the static checks, before any request.
 */
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
  assertBackendPostVerified('x402', options);
  const payload = await sendJson('POST', `/agents/${agentId}/x402/x402_service_details`, { url, method }, options, 'backend');
  const error = vendorError(payload);
  return { ok: error === null, error, payload };
}

/**
 * Backend POST /agents/{id}/x402/x402_service_pay. Spends the agent's on-chain
 * USDC, hard-capped by ClawPump at `maxAmountAtomic` (USDC 6 decimals). NOT
 * retried: a timeout may still have paid, so the caller must book it as spent.
 * NOT VERIFIED on the current backend: it fails closed with
 * `route_not_verified` after the static checks, before any request.
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
  assertBackendPostVerified('x402', options);
  const current = await assertArenaAgent(agentId, ownership, options, 'user');
  // Pay only through an agent reported 'stopped' that holds x402 now (every
  // refusal happens before the POST, so nothing can have been charged).
  assertStopped(current.status);
  if (!agentHasSkill(current, 'x402')) throw new ClawPumpWriterError('x402_not_enabled');
  const payload = await sendJson('POST', `/agents/${agentId}/x402/x402_service_pay`, {
    url: parsed.data.url,
    method: parsed.data.method,
    ...(parsed.data.body === undefined ? {} : { body: parsed.data.body }),
    ...(parsed.data.query === undefined ? {} : { query: parsed.data.query }),
    maxAmountAtomic: Math.round(parsed.data.maxAmountUsd * 1e6),
  }, options, 'backend', X402_TIMEOUT_MS);
  const error = vendorError(payload);
  return { ok: error === null, error, payload };
}

/** The writer surface the arena jobs depend on, so tests inject a fake. */
export interface ClawPumpArenaWriter {
  /** v1 GET /agents/{id}: status, wallet, skills and `isPublic` (the privacy check). */
  readAgent(agentId: string, priority?: ClawPumpCallPriority): Promise<ClawPumpCreatedAgent>;
  createAgent(input: CreateClawPumpAgentInput): Promise<ClawPumpCreatedAgent>;
  /** Backend GET /agents/{id}: `is_public` and `accepting_bids` (the privacy proof). */
  readListing(agentId: string, priority?: ClawPumpCallPriority): Promise<ClawPumpAgentListing>;
  /** The privacy update. `arenaAgentId` = the user or house arena row that must own this ClawPump agent (Codex r17 #4). */
  updateAgent(agentId: string, patch: UpdateClawPumpAgentPatch, arenaAgentId: string, priority?: ClawPumpCallPriority): Promise<void>;
  getWalletBalances(): Promise<ClawPumpWalletBalance[]>;
  x402Pay(agentId: string, input: X402PayInput, arenaAgentId: string): Promise<ClawPumpX402Result>;
}

/** v1 GET /agents/{id}: the agent as ClawPump holds it now (camelCase: walletAddress, skills, isPublic). */
export async function readClawPumpArenaAgent(
  agentId: string,
  options: ClawPumpWriterOptions = {},
): Promise<ClawPumpCreatedAgent> {
  assertAgentId(agentId);
  const agent = toCreatedAgent(await sendJson('GET', `/agents/${agentId}`, undefined, options));
  if (agent.id !== agentId) throw new ClawPumpWriterError('schema_invalid');
  return agent;
}

/**
 * Backend GET /agents/{id}: `is_public` and `accepting_bids` as ClawPump
 * stores them (v1 replies carry no `accepting_bids`). Read only, no guard
 * beyond the live-trader id refusal.
 */
export async function readClawPumpArenaListing(
  agentId: string,
  options: ClawPumpWriterOptions = {},
): Promise<ClawPumpAgentListing> {
  assertAgentId(agentId);
  const parsed = listingWire.safeParse(await sendJson('GET', `/agents/${agentId}`, undefined, options, 'backend'));
  if (!parsed.success || parsed.data.id !== agentId) throw new ClawPumpWriterError('schema_invalid');
  return { id: agentId, isPublic: parsed.data.is_public ?? null, acceptingBids: parsed.data.accepting_bids ?? null };
}

export const clawPumpArenaWriter: ClawPumpArenaWriter = {
  readAgent: (agentId, priority) => readClawPumpArenaAgent(agentId, { priority }),
  readListing: (agentId, priority) => readClawPumpArenaListing(agentId, { priority }),
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
 * Backend GET /wallets/{id}/history: the LIVE balances of an arena agent's
 * wallet (Run 2 fact 3: /wallets/summary is cached, so it is never used here).
 * Order: agent id -> house id refused -> DB ownership (no network) -> the
 * backend token (cached, or one exchange) -> one normal-priority GET. A missing
 * or unreadable balance throws schema_invalid. Reply shape VERIFIED 2026-11-19
 * on an empty wallet (`transactions: []`); the transaction row shape is from
 * the 10-01 probes on the old host.
 */
export async function readArenaWalletLive(
  agentId: string,
  ownership: ClawPumpWriterOwnership,
  options: ClawPumpWriterOptions & { limit?: number } = {},
): Promise<ClawPumpArenaWalletLive> {
  assertAgentId(agentId);
  const { limit = DEFAULT_HISTORY_LIMIT, ...rest } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_ROWS) throw new ClawPumpWriterError('invalid_input');
  await assertOwnedArenaAgent(agentId, ownership, 'user');
  const readAt = new Date();
  const parsed = walletHistoryWire.safeParse(
    await sendJson('GET', `/wallets/${agentId}/history?limit=${limit}`, undefined, { ...rest, priority: 'normal' }, 'backend'),
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
  | { kind: 'reply'; status: number; payload: unknown }
  | { kind: 'no_reply'; code: 'timeout' | 'network_error' };

function transportCode(error: unknown): 'timeout' | 'network_error' {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error';
}

/**
 * The backend transfer POST. Same config, host check, backend token and call
 * budget as sendJson (resolveCall). Every throw (not_configured,
 * invalid_base_url, budget_exhausted, or an error of the key exchange) comes
 * BEFORE the transfer fetch. After fetch starts it never throws and never
 * retries: it returns the HTTP status and the JSON body (read up to 1 MB) for
 * ANY status, or the transport failure.
 */
async function sendTransferPost(path: string, body: unknown, options: ClawPumpWriterOptions): Promise<TransferPostReply> {
  const requestBody = JSON.stringify(body);
  const call = await resolveCall('backend', path, { ...options, priority: 'normal' });
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(call.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${call.bearer}`,
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
  noteBackendStatus('backend', response.status);
  try {
    const status = response.status;
    if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_CHARS) {
      return { kind: 'reply', status, payload: undefined };
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) return { kind: 'reply', status, payload: undefined };
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    return { kind: 'reply', status, payload };
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
    // Codex money review: no HTTP status proves "nothing sent" (401, 403 and 429 included).
    // Only the two HTTP 200 vendor pre-check codes below are proved.
    return { kind: 'unknown', code: `http_${status}`, txSignature };
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
 * Backend POST /wallets/{id}/transfer ONCE from the arena agent's wallet. Guard
 * order (every throw is BEFORE the POST, so a throw always means "nothing sent"):
 * agent id -> input -> route verified (NOT VERIFIED on the current backend, so
 * today every call throws `route_not_verified` here) -> assertArenaAgent (house
 * id, DB ownership, env prefix and row suffix; one GET) -> status 'stopped' ->
 * wallet = expectedSource -> backend token -> POST.
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
  assertBackendPostVerified('transfer', options);
  const callOptions: ClawPumpWriterOptions = { ...options, priority: 'normal' };
  const current = await assertArenaAgent(agentId, ownership, callOptions, 'user');
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
