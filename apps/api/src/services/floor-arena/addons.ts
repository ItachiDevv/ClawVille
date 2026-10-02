import {
  FLOOR_ARENA_ADDONS,
  FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD,
  type FloorArenaAddon,
} from '@clawville/shared';
import {
  CLAWPUMP_WRITER_REMOVAL_RESERVE,
  CLAWPUMP_X402_MAX_CALL_USD,
  ClawPumpWriterError,
  clawPumpArenaWriter,
  clawPumpWriterBudget,
  isAllowedX402Url,
  type ClawPumpWalletBalance,
  type ClawPumpX402Result,
  type X402PayInput,
} from '../clawpump-writer';
import { entriesPaused } from './engine';
import { ARENA_X402_ADDS_PER_TICK, arenaX402RemovalsDeferred, ensureArenaX402ForPay, type ArenaX402Outcome } from './provisioning';
import {
  arenaAddonChargeRefSeen,
  confirmArenaAddonDispatch,
  finalizeArenaAddonCall,
  insertArenaEvent,
  insertArenaPrivateMints,
  readArenaAddonAgents,
  readArenaAddonStats,
  reserveArenaAddonCall,
  sanitizeArenaSymbol,
  type ArenaAddonCallStat,
  type ArenaAddonReserveCheck,
  type ArenaAddonToken,
  type ArenaAgentRecord,
  type ArenaEventType,
} from './queries';

/**
 * D9 paid x402 discovery add-ons. The player funds the agent's own ClawPump
 * wallet; the engine pays each vetted feed from THAT wallet through ClawPump's
 * x402 route with `maxAmountUsd` = the catalog price, never more.
 *
 * Limits, all enforced before a payment:
 *  - global kill switch FLOOR_ARENA_ADDON_PAYMENTS_ENABLED ('false' = off; default on;
 *    read at container start, so a change needs a restart),
 *  - the operator pause (POST /api/admin/floor-arena/engine/pause), immediate,
 *  - only ACTIVE, SEATED, provisioned agents (a standing agent opens no positions),
 *  - only vetted hosts (CLAWPUMP_X402_ALLOWED_HOSTS), whatever the catalog says,
 *  - per add-on poll interval >= max(catalog minIntervalS, 600 s) (D9 / D15),
 *    measured from the last ATTEMPT (ok or not), so a failing feed is not hammered;
 *    a pay that our own ClawPump call budget refused before the request is NOT an
 *    attempt (D1, 2026-10-01): it retries on the next pass,
 *  - the shared ClawPump call budget must hold the WHOLE pay sequence
 *    (ARENA_ADDON_PAY_CALLS) before the first call, and the last two calls before
 *    the reservation, above the removal reserve,
 *  - per add-on daily cap (the player's dailyCapUsd, 0..5) AND an agent-wide
 *    hard cap of $5 per UTC day across all add-ons,
 *  - wallet USDC balance >= price (read from ClawPump, cached 60 s).
 *
 * Every payment ATTEMPT gets a `floor_arena_addon_calls` row, written BEFORE the
 * payment as a 'reserved' row (catalog price) under a per-agent advisory lock
 * with the cap check and a re-read of the agent's settings in the same
 * transaction, then finalised. `price_usd` is the amount counted against the
 * cap: 0 for a duplicate:true whose settlement tx is already booked; else what
 * ClawPump reports it charged; else 0 ONLY for a verified no-charge (a refused
 * ClawPump request, a documented no-charge vendor status); else the catalog
 * price (success or a duplicate without an amount, any unverified failure, a
 * transport error).
 * Dedupe: consecutive SENT calls alternate `dedupeVary` (all-time count of rows whose
 * pay may have been sent; an unsent row does not advance it, O1).
 * Mints from an add-on stay private to that agent (`floor_arena_private_mints`).
 */

/** D15: the run-time poll floor; the interval is max(catalog minIntervalS, 600 s). */
export const ARENA_ADDON_MIN_INTERVAL_S = 600;
/**
 * D1 (X402_PAID_TEST_2026-10-01): normal-priority ClawPump calls one paid call can make:
 * the wallet summary (when the 60 s cache is stale), the x402 GET in `x402Ready`, the
 * writer's guard GET and the pay POST. An x402 ADD costs more; that path backs off on
 * its own and never reserves.
 */
export const ARENA_ADDON_PAY_CALLS = 4;
/** The calls left after the reservation: the writer's guard GET and the pay POST. */
export const ARENA_ADDON_DISPATCH_CALLS = 2;
/** The ledger error of a pay our own call budget refused BEFORE any pay request (writer code 'budget_exhausted'). */
export const ARENA_ADDON_BUDGET_REFUSED_ERROR = new ClawPumpWriterError('budget_exhausted').message;
const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_MINTS_PER_CALL = 100;
const MAX_PARSE_CHARS = 1_000_000;
const WALLET_CACHE_MS = 60_000;
const WALLET_FAILURE_BACKOFF_MS = 30_000;
const NOTICE_INTERVAL_MS = 60 * 60_000;
const EPSILON = 1e-9;

export function addonPaymentsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.FLOOR_ARENA_ADDON_PAYMENTS_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > MAX_PARSE_CHARS) return value;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function splitPath(path: string): string[] {
  return path.split('.').map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/** Walks path segments from `roots`; a segment ending in `[]` fans out over an array. */
function walk(roots: unknown[], segments: readonly string[]): unknown[] {
  let current = roots.map(parseMaybeJson);
  for (const segment of segments) {
    const fanOut = segment.endsWith('[]');
    const key = fanOut ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const node of current) {
      let value: unknown = node;
      if (key.length > 0) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
        if (!Object.hasOwn(node, key)) continue;
        value = parseMaybeJson((node as Record<string, unknown>)[key]);
      }
      if (fanOut) {
        if (Array.isArray(value)) next.push(...value.slice(0, 1_000).map(parseMaybeJson));
      } else {
        next.push(value);
      }
    }
    current = next;
  }
  return current;
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    for (const candidate of Array.isArray(value) ? value : [value]) {
      if (typeof candidate === 'string') return candidate;
    }
  }
  return null;
}

/**
 * Vendor fields are untrusted data (lead rule): keep ONLY valid base58 32-44
 * char mints and a sanitised symbol of at most 16 chars. Paths such as
 * `data[].token_address` fan out on `[]`. A symbol is paired with its mint only
 * when both paths share the same parent (e.g. `data[].token_address` and
 * `data[].token_symbol`); otherwise the symbol is null. Deduplicated by mint
 * (Nansen dex-trades repeats a mint once per trade), at most 100 per call.
 */
export function extractTokensAtPath(root: unknown, mintPath: string, symbolPath: string | null = null): ArenaAddonToken[] {
  const mintSegments = splitPath(mintPath);
  if (mintSegments.length === 0) return [];
  const symbolSegments = symbolPath ? splitPath(symbolPath) : null;
  const paired = symbolSegments !== null
    && symbolSegments.length === mintSegments.length
    && symbolSegments.slice(0, -1).join('.') === mintSegments.slice(0, -1).join('.');
  const parents = walk([root], mintSegments.slice(0, -1));
  const out: ArenaAddonToken[] = [];
  const seen = new Set<string>();
  for (const parent of parents) {
    const symbol = paired ? sanitizeArenaSymbol(firstString(walk([parent], symbolSegments!.slice(-1)))) : null;
    for (const value of walk([parent], mintSegments.slice(-1))) {
      for (const candidate of Array.isArray(value) ? value : [value]) {
        if (typeof candidate !== 'string') continue;
        const mint = candidate.trim();
        if (!BASE58_MINT.test(mint) || seen.has(mint)) continue;
        seen.add(mint);
        out.push({ mint, symbol });
        if (out.length >= MAX_MINTS_PER_CALL) return out;
      }
    }
  }
  return out;
}

/** Mints only (tests and simple callers). */
export function extractMintsAtPath(root: unknown, mintPath: string): string[] {
  return extractTokensAtPath(root, mintPath).map((token) => token.mint);
}

/**
 * ClawPump's x402 pay payload carries the vendor's own body, unchanged, under
 * `data` (x402-vetter, observed on the MCP tool for Nansen, Syra, Otto, Heurist
 * and CoinGecko; not yet on one REST call). Try `data` first, then the payload
 * itself and the other usual wrapper keys, and take the first place where the
 * catalog path finds mints.
 */
export function extractAddonTokens(payload: unknown, mintPath: string, symbolPath: string | null = null): ArenaAddonToken[] {
  const root = parseMaybeJson(payload);
  const candidates: unknown[] = [];
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    const record = root as Record<string, unknown>;
    if (record.data !== undefined) candidates.push(parseMaybeJson(record.data));
    candidates.push(root);
    for (const key of ['response', 'result', 'body', 'content']) {
      const inner = parseMaybeJson(record[key]);
      if (inner === undefined) continue;
      candidates.push(inner);
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        for (const nested of ['data', 'body']) {
          const deeper = parseMaybeJson((inner as Record<string, unknown>)[nested]);
          if (deeper !== undefined) candidates.push(deeper);
        }
      }
    }
  } else {
    candidates.push(root);
  }
  for (const candidate of candidates) {
    const tokens = extractTokensAtPath(candidate, mintPath, symbolPath);
    if (tokens.length > 0) return tokens;
  }
  return [];
}

export function extractAddonMints(payload: unknown, mintPath: string): string[] {
  return extractAddonTokens(payload, mintPath).map((token) => token.mint);
}

/** `duplicate: true` = ClawPump replayed a cached body for an identical call: old data; a new charge is not ruled out. */
export function isDuplicatePayload(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && (payload as Record<string, unknown>).duplicate === true;
}

/**
 * Vendor statuses the x402-vetter verified ON CHAIN as moving no USDC when
 * ClawPump returns them inside a failure body (`original_code`): 400, 402
 * (refused after signing) and 422 (report ops/house-traders/X402_FEEDS_2026-09-30.md).
 */
const NO_CHARGE_VENDOR_STATUSES: ReadonlySet<number> = new Set([400, 402, 422]);

/** A failure body whose vendor status is on the verified no-charge list. */
export function isDocumentedNoChargeFailure(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const raw = (payload as Record<string, unknown>).original_code;
  const status = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{3}$/.test(raw.trim()) ? Number(raw.trim()) : null;
  return status !== null && NO_CHARGE_VENDOR_STATUSES.has(status);
}

/** The amount ClawPump says it charged (`amount_charged_atomic`, USDC 6 decimals), or null. */
export function chargedUsdFromPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as Record<string, unknown>).amount_charged_atomic;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,15}$/.test(text)) return null;
  return Number(text) / 1e6;
}

/**
 * The query (GET) or body (POST) for one paid call. ClawPump answers an
 * identical x402 call made within a few minutes with its cached body and no
 * new data, so when the catalog sets `dedupeVary`, call number N uses
 * `values[N % values.length]` at `path` (a query key for GET, a dot path into
 * the body for POST). Successive calls therefore never repeat the last one.
 */
export function buildAddonRequest(
  item: FloorArenaAddon,
  callNumber: number,
): { query: Record<string, string> | null; body: Record<string, unknown> | null } {
  const query = item.query && Object.keys(item.query).length > 0 ? { ...item.query } : null;
  // The catalog is frozen: always send a copy.
  const body = item.method === 'POST' && item.body ? (structuredClone(item.body) as Record<string, unknown>) : null;
  const vary = item.dedupeVary;
  if (!vary) return { query, body };
  const value = vary.values[Math.abs(Math.trunc(callNumber)) % vary.values.length]!;
  if (item.method === 'GET') {
    return { query: { ...(query ?? {}), [vary.path]: String(value) }, body };
  }
  if (!body) return { query, body };
  const keys = vary.path.split('.').filter((key) => key.length > 0);
  let node: Record<string, unknown> = body;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  const last = keys.at(-1);
  if (last) node[last] = value;
  return { query, body };
}

/** A payment reference for the ledger: `settlement.transaction` when present, else a best-effort search. */
export function extractResponseRef(payload: unknown): string | null {
  const settlement = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).settlement : null;
  const tx = settlement && typeof settlement === 'object' ? (settlement as Record<string, unknown>).transaction : null;
  if (typeof tx === 'string' && /^[1-9A-HJ-NP-Za-km-z]{43,100}$/.test(tx.trim())) return tx.trim();
  const visit = (node: unknown, depth: number): string | null => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 2) return null;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string' && /sig|tx|transaction/i.test(key) && /^[1-9A-HJ-NP-Za-km-z]{43,100}$/.test(value.trim())) {
        return value.trim();
      }
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = visit(value, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(payload, 0);
}

/** True when ClawPump may have paid before the error reached us. */
export function mayHaveCharged(error: unknown): boolean {
  if (!(error instanceof ClawPumpWriterError)) return true;
  switch (error.code) {
    case 'timeout':
    case 'network_error':
    case 'response_too_large':
    case 'schema_invalid':
      return true;
    case 'http_error':
      return (error.status ?? 500) >= 500;
    // Our own call budget refused it BEFORE any request (Codex r21 / audit-money P3).
    case 'budget_exhausted':
      return false;
    default:
      return false;
  }
}

// ─── Wallet balance (shared with GET /me) ─────────────────────────────────

let walletCache: { loadedAt: number; byAgent: Map<string, ClawPumpWalletBalance> } | null = null;
let walletFailureAt = 0;
let walletInflight: Promise<void> | null = null;

/** The agent's ClawPump wallet balance from one account-wide summary, cached 60 s. */
export async function readArenaWalletBalance(
  clawpumpAgentId: string,
  nowMs: number = Date.now(),
  load: () => Promise<ClawPumpWalletBalance[]> = () => clawPumpArenaWriter.getWalletBalances(),
): Promise<ClawPumpWalletBalance | null> {
  const fresh = walletCache && nowMs - walletCache.loadedAt < WALLET_CACHE_MS;
  if (!fresh && nowMs - walletFailureAt >= WALLET_FAILURE_BACKOFF_MS) {
    walletInflight ??= (async () => {
      try {
        const list = await load();
        walletCache = { loadedAt: Date.now(), byAgent: new Map(list.map((row) => [row.agentId, row])) };
      } catch {
        walletFailureAt = Date.now();
      } finally {
        walletInflight = null;
      }
    })();
    await walletInflight;
  }
  // A stale summary is still better than none for a DISPLAY, but the add-on
  // tick treats anything older than 5 minutes as unknown (see walletUsdc below).
  return walletCache?.byAgent.get(clawpumpAgentId) ?? null;
}

async function walletUsdc(clawpumpAgentId: string): Promise<number | null> {
  const balance = await readArenaWalletBalance(clawpumpAgentId);
  if (!balance || !walletCache || Date.now() - walletCache.loadedAt > 5 * 60_000) return null;
  return balance.usdc;
}

// ─── Tick ──────────────────────────────────────────────────────────────────

/** The interval and cap verdict for one call (pure; runs twice: a cheap pre-check, then under the lock). */
export type ArenaAddonCallCheck = ArenaAddonReserveCheck;

export function checkAddonCall(input: {
  stats: readonly ArenaAddonCallStat[];
  addonId: string;
  priceUsd: number;
  addonCapUsd: number;
  intervalMs: number;
  nowMs: number;
}): ArenaAddonCallCheck {
  const stat = input.stats.find((row) => row.addonId === input.addonId);
  const cap = Math.min(Math.max(input.addonCapUsd, 0), FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD);
  const spent = stat?.spentTodayUsd ?? 0;
  // D1: the newest row a budget refusal (nothing sent) does not start the interval. That row was itself reserved
  // only after the interval since the newest COUNTED attempt had passed, so skipping the check here equals
  // measuring from that attempt. An in-flight reservation (error still null) keeps blocking.
  const countedAt = stat?.lastAt && stat.lastError !== ARENA_ADDON_BUDGET_REFUSED_ERROR ? stat.lastAt : null;
  if (countedAt && input.nowMs - countedAt.getTime() < input.intervalMs) {
    return { ok: false, reason: 'interval', spentUsd: spent, capUsd: cap };
  }
  if (spent + input.priceUsd > cap + EPSILON) return { ok: false, reason: 'addon_cap', spentUsd: spent, capUsd: cap };
  // Agent-wide: every add-on with spend today (disabled ones included), reservations included.
  const agentSpent = input.stats.reduce((sum, row) => sum + row.spentTodayUsd, 0);
  if (agentSpent + input.priceUsd > FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD + EPSILON) {
    return { ok: false, reason: 'agent_cap', spentUsd: agentSpent, capUsd: FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD };
  }
  return { ok: true };
}

export interface ArenaAddonDeps {
  catalog: () => readonly FloorArenaAddon[];
  paymentsEnabled: () => boolean;
  /** Money audit M2: the operator pause (POST /api/admin/floor-arena/engine/pause) also stops payments. */
  paused: () => boolean;
  /** Money audit N3: each agent (and each reservation) reads the real clock, never the tick start. */
  clock: () => Date;
  listAgents: () => Promise<ArenaAgentRecord[]>;
  readStats: (agentId: string, dayStart: Date) => Promise<ArenaAddonCallStat[]>;
  /** Cap check + 'reserved' ledger row in ONE transaction under the per-agent advisory lock. */
  reserveCall: typeof reserveArenaAddonCall;
  /** Moves the reservation to 'done' with the charged amount. */
  finalizeCall: typeof finalizeArenaAddonCall;
  insertPrivateMints: typeof insertArenaPrivateMints;
  insertEvent: (agentId: string, event: { type: ArenaEventType; summary: string; data?: unknown }) => Promise<void>;
  walletUsdc: (clawpumpAgentId: string) => Promise<number | null>;
  /**
   * Codex r19 (single writer, audit-money S5): the leader's x402 reconcile for
   * this arena agent (x402 lock, current row, fresh GET, add if wanted), then
   * true only when x402 is on a stopped agent that wants it. No cache.
   */
  x402Ready: (agentId: string, allowAdd: boolean) => Promise<ArenaX402Outcome>;
  /**
   * Codex r20 (3) / D1: true when the shared ClawPump call budget holds `calls` more normal-priority calls above
   * the removal reserve (removals keep their claim).
   */
  budgetOk: (calls: number) => boolean;
  /** audit-money F: true while the leader still owes an x402 removal it could not attempt; adds wait. */
  removalsDeferred: () => boolean;
  /** Codex r17 #1/#2: the last check before the pay (same lock as seat/status/add-on writes); releases the reservation on failure. */
  confirmDispatch: typeof confirmArenaAddonDispatch;
  /** Codex r17 #5: was this provider charge (settlement tx) already booked for the agent? */
  chargeRefSeen: (agentId: string, ref: string) => Promise<boolean>;
  /** `arenaAgentId` binds the payment to the arena row that owns the ClawPump agent (writer proof). */
  pay: (clawpumpAgentId: string, input: X402PayInput, arenaAgentId: string) => Promise<ClawPumpX402Result>;
}

export const defaultArenaAddonDeps: ArenaAddonDeps = {
  catalog: () => FLOOR_ARENA_ADDONS,
  paymentsEnabled: () => addonPaymentsEnabled(),
  listAgents: readArenaAddonAgents,
  readStats: readArenaAddonStats,
  reserveCall: reserveArenaAddonCall,
  finalizeCall: finalizeArenaAddonCall,
  insertPrivateMints: insertArenaPrivateMints,
  insertEvent: insertArenaEvent,
  walletUsdc,
  x402Ready: (agentId, allowAdd) => ensureArenaX402ForPay(agentId, undefined, allowAdd),
  // The writer refuses a normal call when tokens - 1 < reserve, so N calls in a row need tokens - N >= reserve.
  budgetOk: (calls) => clawPumpWriterBudget().tokens - calls >= CLAWPUMP_WRITER_REMOVAL_RESERVE,
  removalsDeferred: () => arenaX402RemovalsDeferred(),
  pay: (clawpumpAgentId, input, arenaAgentId) => clawPumpArenaWriter.x402Pay(clawpumpAgentId, input, arenaAgentId),
  confirmDispatch: confirmArenaAddonDispatch,
  chargeRefSeen: arenaAddonChargeRefSeen,
  paused: () => entriesPaused(),
  clock: () => new Date(),
};

const notices = new Map<string, number>();
let tickRunning = false;
/** Adds left in the current add-on tick (audit-money F). */
let addsLeft = ARENA_X402_ADDS_PER_TICK;

/** Test seam. */
export function _resetArenaAddonsForTest(): void {
  notices.clear();
  walletCache = null;
  walletFailureAt = 0;
  walletInflight = null;
  tickRunning = false;
  addsLeft = ARENA_X402_ADDS_PER_TICK;
}

/** A short code for a failed ClawPump x402 payload: `vendor_<code>`, never the vendor's text. */
export function vendorErrorCode(payload: unknown): string {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  for (const key of ['code', 'original_code']) {
    const value = record[key];
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (/^[A-Za-z0-9_.-]{1,40}$/.test(text)) return `vendor_${text}`;
  }
  return 'vendor_error';
}

function errorText(error: unknown): string {
  if (error instanceof ClawPumpWriterError) return error.message;
  return 'addon_call_error';
}

function usd(value: number): string {
  return `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

async function notice(
  deps: ArenaAddonDeps,
  key: string,
  nowMs: number,
  intervalMs: number,
  agentId: string,
  summary: string,
  data: unknown,
): Promise<void> {
  const last = notices.get(key);
  if (last !== undefined && nowMs - last < intervalMs) return;
  notices.set(key, nowMs);
  await deps.insertEvent(agentId, { type: 'addon', summary, data });
}

async function capNotice(
  deps: ArenaAddonDeps,
  agentId: string,
  item: FloorArenaAddon,
  check: Exclude<ArenaAddonCallCheck, { ok: true }>,
  nowMs: number,
  dayMs: number,
): Promise<void> {
  if (check.reason === 'interval' || check.reason === 'agent_changed') return;
  // P5 D34-i: refusals of the locked reservation against open withdrawals. They can repeat every
  // pass, so they are throttled like the other skip notices. 'underfunded' shares its key with the
  // pre-check underfunded notice: one underfunded line per interval, whichever check found it.
  if (check.reason === 'withdraw_pending' || check.reason === 'underfunded') {
    await notice(deps, `${agentId}:${item.id}:${check.reason}`, nowMs, NOTICE_INTERVAL_MS, agentId,
      check.reason === 'withdraw_pending'
        ? `${item.name}: skipped while a withdrawal of all USDC is open.`
        : `${item.name}: underfunded after open withdrawals.`,
      { addonId: item.id, reason: check.reason });
    return;
  }
  await notice(deps, `${agentId}:${item.id}:cap:${dayMs}`, nowMs, Number.POSITIVE_INFINITY, agentId,
    check.reason === 'agent_cap'
      ? `${item.name}: the agent's add-on cap is reached (${usd(check.spentUsd)} of ${usd(check.capUsd)} today). Next call after 00:00 UTC.`
      : `${item.name}: daily cap reached (${usd(check.spentUsd)} of ${usd(check.capUsd)} today). Next call after 00:00 UTC.`,
    { addonId: item.id, reason: check.reason, spentTodayUsd: check.spentUsd, dailyCapUsd: check.capUsd });
}

/**
 * One agent's add-on pass. Exported so tests can run two passes at once (two
 * containers). Codex r2 #3: the spend is RESERVED in Postgres before paying:
 * the cap check and a 'reserved' ledger row (price = catalog price) share one
 * transaction under a per-agent advisory lock, so two containers can never both
 * pay past the cap, and a crash after the reservation leaves it counted (the
 * safe side). After the call the row is finalised to what was charged.
 * Returns 'budget_deferred' when the shared ClawPump call budget stopped it (D1): the tick ends there.
 */
export async function runArenaAddonAgent(
  deps: ArenaAddonDeps,
  agent: ArenaAgentRecord,
  catalog: ReadonlyMap<string, FloorArenaAddon>,
  now: Date,
): Promise<'budget_deferred' | undefined> {
  const clawpumpAgentId = agent.clawpumpAgentId;
  if (!clawpumpAgentId) return undefined;
  const enabled = agent.addons.filter((addon) => addon.enabled && catalog.has(addon.id));
  if (enabled.length === 0) return undefined;
  const nowMs = now.getTime();
  const dayStart = utcDayStart(now);
  const dayMs = dayStart.getTime();
  const stats = await deps.readStats(agent.id, dayStart);
  // Read once per agent per tick, never kept across ticks (Codex r19).
  let x402: boolean | null = null;

  for (const addon of enabled) {
    const item = catalog.get(addon.id)!;
    const price = item.priceUsd;
    // A catalog price outside (0, per-call max] is a catalog bug: never pay it.
    if (!(price > 0) || price > CLAWPUMP_X402_MAX_CALL_USD) continue;
    const key = `${agent.id}:${addon.id}`;
    // Host allowlist (lead rule): a catalog edit alone never sends USDC to a new vendor.
    if (!isAllowedX402Url(item.url)) {
      await notice(deps, `${key}:host`, nowMs, NOTICE_INTERVAL_MS, agent.id,
        `${item.name}: skipped, its host is not on the vetted add-on list.`,
        { addonId: addon.id, reason: 'host_not_allowed' });
      continue;
    }
    const checkInput = {
      addonId: addon.id,
      priceUsd: price,
      addonCapUsd: addon.dailyCapUsd,
      intervalMs: Math.max(item.minIntervalS, ARENA_ADDON_MIN_INTERVAL_S) * 1000,
      nowMs,
    };
    // Cheap pre-check (no lock) so a capped or waiting add-on costs no ClawPump call.
    const pre = checkAddonCall({ ...checkInput, stats });
    if (!pre.ok) {
      await capNotice(deps, agent.id, item, pre, nowMs, dayMs);
      continue;
    }
    // D1: room for the WHOLE pay sequence before its first ClawPump call. The budget is shared,
    // so a miss ends the tick; nothing is reserved and the next pass retries.
    if (!deps.budgetOk(ARENA_ADDON_PAY_CALLS)) return 'budget_deferred';

    const balance = await deps.walletUsdc(clawpumpAgentId);
    if (balance === null) {
      await notice(deps, `${key}:balance`, nowMs, NOTICE_INTERVAL_MS, agent.id,
        `${item.name}: skipped, the wallet balance is unavailable right now.`,
        { addonId: addon.id, reason: 'balance_unknown' });
      continue;
    }
    if (balance + EPSILON < price) {
      await notice(deps, `${key}:underfunded`, nowMs, NOTICE_INTERVAL_MS, agent.id,
        `${item.name}: underfunded. The wallet holds ${usd(balance)} USDC; one call costs ${usd(price)}.`,
        { addonId: addon.id, reason: 'underfunded', balanceUsdc: balance, priceUsd: price });
      continue;
    }

    // Codex r19 (single writer, audit-money S5): this tick runs on the leader,
    // so it reconciles x402 itself right before paying (adds it when wanted).
    // Without x402 on a stopped agent nothing is reserved and nothing is paid;
    // confirmDispatch and the writer's last read check again before the POST.
    if (x402 === null) {
      try {
        // At most ARENA_X402_ADDS_PER_TICK adds a tick, and none while a removal is deferred.
        const outcome = await deps.x402Ready(agent.id, addsLeft > 0 && !deps.removalsDeferred());
        if (outcome === 'added') addsLeft -= 1;
        x402 = outcome === 'added' || outcome === 'on';
      } catch (error) {
        x402 = false;
        console.error('[floor-arena] add-on x402 check failed:', errorText(error));
      }
    }
    if (!x402) {
      await notice(deps, `${key}:skill`, nowMs, NOTICE_INTERVAL_MS, agent.id,
        `${item.name}: waiting for x402 on the execution wallet. The engine retries on its next pass.`,
        { addonId: addon.id, reason: 'x402_not_ready' });
      continue;
    }

    // Audit-money: a pause that lands while an earlier add-on of this agent was
    // paying stops this one before it even reserves.
    if (deps.paused()) return undefined;
    // D1: the guard GET and the pay POST must still fit (the calls above spent tokens and
    // other loops share the bucket). A miss here costs no reservation.
    if (!deps.budgetOk(ARENA_ADDON_DISPATCH_CALLS)) return 'budget_deferred';
    // The authoritative check + reservation, under the per-agent advisory lock,
    // at the REAL time (balance and skill calls above can take seconds).
    const reserveAt = deps.clock();
    const reservation = await deps.reserveCall({
      agentId: agent.id,
      addonId: addon.id,
      clawpumpAgentId,
      at: reserveAt,
      priceUsd: price,
      dayStart: utcDayStart(reserveAt),
      // P5 D34-i: the balance read above. Under the lock the reservation subtracts open withdrawals and
      // open reservations from it. Residual: this summary is cached up to 60 s, so a confirmed withdrawal
      // can still look unspent; that pay then fails at ClawPump and moves no USDC (the chain is the guard).
      walletUsdc: balance,
      // Codex r3 #10: the cap is the one on the agent row NOW, read under the lock.
      check: (locked, currentCapUsd) => checkAddonCall({
        ...checkInput, nowMs: reserveAt.getTime(), addonCapUsd: currentCapUsd, stats: locked,
      }),
    });
    if (!reservation.reserved) {
      // Another container reserved first (interval) or the cap filled meanwhile.
      await capNotice(deps, agent.id, item, reservation.check, nowMs, dayMs);
      continue;
    }
    // Dedupe rotation: the all-time SENT call count BEFORE this reservation (readArenaAddonStats, O1).
    const request = buildAddonRequest(item, reservation.callNumber);

    // Codex r17 #1/#2: the LAST gate before money moves. Same per-agent lock as
    // the owner's seat/status/add-on writes: a stand-up, pause, stop or add-on
    // change that committed after the reservation releases it here (price 0,
    // 'released_before_pay'), and nothing is paid. ACCEPTED residual window:
    // a change that commits after this check and before the request reaches
    // ClawPump; it can no longer stop this one call.
    const dispatch = await deps.confirmDispatch({
      reservationId: reservation.id,
      agentId: agent.id,
      addonId: addon.id,
      clawpumpAgentId,
      paused: deps.paused,
    });
    if (!dispatch.ok) {
      await notice(deps, `${key}:released:${dispatch.reason}`, nowMs, NOTICE_INTERVAL_MS, agent.id,
        `${item.name}: skipped before paying (${dispatch.reason === 'paused' ? 'the arena is paused' : 'the agent stood up, paused or changed its add-ons'}). Nothing was charged.`,
        { addonId: addon.id, reason: dispatch.reason });
      if (dispatch.reason === 'paused') return undefined;
      continue;
    }

    // What counts against the cap is what ClawPump CHARGED (lead rule):
    //  - ok: `amount_charged_atomic` when reported, else the catalog price;
    //  - duplicate:true: 0 only when its settlement tx is already booked, else
    //    the reported amount, else the catalog price (old data: parse nothing);
    //  - a vendor failure in a 200: the reported charge, else 0 only for a documented
    //    no-charge status (original_code 400/402/422), else the catalog price;
    //  - a thrown error: the catalog price when it may have paid (timeout, 5xx, ...),
    //    0 when ClawPump refused the request (mayHaveCharged).
    // The stored error is a CODE, never vendor text (vendor fields are untrusted).
    let result: ClawPumpX402Result | null = null;
    let error: string | null = null;
    let charged = 0;
    // D1: our own call budget refused the pay before its request (the guard GET or the POST
    // never left this process): $0, and not an attempt for the interval (checkAddonCall).
    let budgetRefused = false;
    try {
      result = await deps.pay(clawpumpAgentId, {
        url: item.url,
        method: item.method,
        ...(request.query ? { query: request.query } : {}),
        ...(request.body ? { body: request.body } : {}),
        maxAmountUsd: price,
      }, agent.id);
      const reported = chargedUsdFromPayload(result.payload);
      if (!result.ok) {
        error = vendorErrorCode(result.payload);
        // Codex r3 #9: a failure releases the reservation ONLY when it is a
        // verified no-charge (an explicit charged amount, or a documented
        // no-charge vendor status). Otherwise the catalog price stays booked.
        charged = reported ?? (isDocumentedNoChargeFailure(result.payload) ? 0 : price);
      } else if (isDuplicatePayload(result.payload)) {
        // A cached replay of the FIRST call: same body, same settlement tx
        // (X402_FEEDS_2026-09-30.md). Codex r17 #5: book its charge at most
        // once per provider charge id: 0 when that tx was already booked for
        // this agent (the only proof of no NEW charge). Codex r18: otherwise
        // the reported amount, and with no amount the reserved catalog price
        // (an unknown charge is never booked as 0). Over-counts against the
        // cap at worst: the safe side.
        const ref = extractResponseRef(result.payload);
        charged = ref !== null && (await deps.chargeRefSeen(agent.id, ref)) ? 0 : reported ?? price;
      } else {
        // A 200 without `amount_charged_atomic` keeps the catalog price.
        charged = reported ?? price;
      }
    } catch (thrown) {
      budgetRefused = thrown instanceof ClawPumpWriterError && thrown.code === 'budget_exhausted';
      error = budgetRefused ? ARENA_ADDON_BUDGET_REFUSED_ERROR : errorText(thrown);
      charged = mayHaveCharged(thrown) ? price : 0;
    }

    const ok = result?.ok === true;
    const duplicate = ok && isDuplicatePayload(result!.payload);
    const tokens = ok && !duplicate ? extractAddonTokens(result!.payload, item.mintPath, item.symbolPath) : [];
    let fresh = 0;
    try {
      // O3: rows in mint order (code units = COLLATE "C" for base58), the same order the
      // enrichment's snapshot write locks them in (discovery-hub storeSnapshots): no deadlock.
      const ordered = [...tokens].sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
      fresh = ordered.length > 0 ? await deps.insertPrivateMints(agent.id, addon.id, ordered, deps.clock()) : 0;
    } catch (insertError) {
      console.error('[floor-arena] add-on mint insert failed:', insertError instanceof Error ? insertError.message : 'error');
    }
    // If this update fails, the reservation stays 'reserved' at the catalog
    // price: still counted against the cap (the safe side). A duplicate keeps
    // its tx only when it booked a charge, so a later replay of the same tx
    // matches it and books 0 (Codex r17 #5).
    await deps.finalizeCall(reservation.id, {
      priceUsd: charged,
      ok,
      error,
      mints: tokens.length,
      responseRef: ok && (!duplicate || charged > 0) ? extractResponseRef(result!.payload) : null,
    });
    const data = {
      addonId: addon.id, ok, duplicate, priceUsd: price, chargedUsd: charged, mints: tokens.length, newMints: fresh, error,
    };
    if (budgetRefused) {
      // Money-lens MINOR 1: a long budget contention retries every tick, so its event goes through
      // the notice throttle (at most one per NOTICE_INTERVAL_MS per agent and add-on).
      await notice(deps, `${key}:budget`, nowMs, NOTICE_INTERVAL_MS, agent.id,
        `${item.name}: the engine's ClawPump call budget was full. Nothing was sent or charged; the next pass retries.`,
        data);
      return 'budget_deferred';
    }
    await deps.insertEvent(agent.id, {
      type: 'addon',
      summary: duplicate
        ? charged > 0
          ? `${item.name}: ClawPump returned a cached duplicate we cannot match to a booked charge. ${usd(charged)} counted against the daily cap, no new tokens.`
          : `${item.name}: ClawPump returned a cached duplicate. No charge, no new tokens.`
        : ok
          ? `${item.name}: paid ${usd(charged)}, ${tokens.length} tokens (${fresh} new, private to this agent).`
          : `${item.name}: call failed (${error}). ${charged > 0 ? `${usd(charged)} counted against the daily cap.` : 'Nothing was charged.'}`,
      data,
    });
  }
  return undefined;
}

const BUDGET_DEFERRED_LOG = '[floor-arena] ClawPump call budget reached: add-on calls deferred to the next tick.';

/** Called every 60 s by the arena engine. Never throws. */
export async function runArenaAddonsTick(
  _tickStart: Date = new Date(),
  deps: ArenaAddonDeps = defaultArenaAddonDeps,
): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    if (!deps.paymentsEnabled()) return;
    // Money audit M2: the operator pause stops paid calls at once (the env
    // switch needs a container restart). In memory on this process, like the
    // entry pause; the add-on tick runs on the same leader as the entries.
    if (deps.paused()) return;
    const catalog = new Map(deps.catalog().map((addon) => [addon.id, addon]));
    if (catalog.size === 0) return;
    addsLeft = ARENA_X402_ADDS_PER_TICK;
    for (const agent of await deps.listAgents()) {
      if (deps.paused()) return;
      // Codex r20 (3) / D1: the shared ClawPump budget cannot hold a whole pay
      // sequence -> defer the rest of this tick (x402 removals keep their reserve).
      // One line per tick.
      if (!deps.budgetOk(ARENA_ADDON_PAY_CALLS)) {
        console.warn(BUDGET_DEFERRED_LOG);
        return;
      }
      try {
        if ((await runArenaAddonAgent(deps, agent, catalog, deps.clock())) === 'budget_deferred') {
          console.warn(BUDGET_DEFERRED_LOG);
          return;
        }
      } catch (error) {
        console.error('[floor-arena] add-on tick failed for one agent:', error instanceof Error ? error.message : 'error');
      }
    }
  } catch (error) {
    console.error('[floor-arena] add-on tick failed:', error instanceof Error ? error.message : 'error');
  } finally {
    tickRunning = false;
  }
}
