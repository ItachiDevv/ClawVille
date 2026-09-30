import {
  FLOOR_ARENA_ADDONS,
  FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD,
  type FloorArenaAddon,
} from '@clawville/shared';
import {
  CLAWPUMP_X402_MAX_CALL_USD,
  ClawPumpWriterError,
  clawPumpArenaWriter,
  isAllowedX402Url,
  type ClawPumpWalletBalance,
  type ClawPumpX402Result,
  type X402PayInput,
} from '../clawpump-writer';
import { arenaSkillSynced, ensureAddonSkill } from './provisioning';
import {
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
 *  - global kill switch FLOOR_ARENA_ADDON_PAYMENTS_ENABLED ('false' = off; default on),
 *  - only vetted hosts (CLAWPUMP_X402_ALLOWED_HOSTS), whatever the catalog says,
 *  - per add-on poll interval >= max(catalog minIntervalS, 600 s) (D9 / D15),
 *    measured from the last ATTEMPT (ok or not), so a failing feed is not hammered,
 *  - per add-on daily cap (the player's dailyCapUsd, 0..5) AND an agent-wide
 *    hard cap of $5 per UTC day across all add-ons,
 *  - wallet USDC balance >= price (read from ClawPump, cached 60 s).
 *
 * Every payment ATTEMPT gets a `floor_arena_addon_calls` row, written BEFORE the
 * payment as a 'reserved' row (catalog price) under a per-agent advisory lock
 * with the cap check and a re-read of the agent's settings in the same
 * transaction, then finalised. `price_usd` is the amount counted against the
 * cap: what ClawPump reports it charged; else 0 ONLY for a verified no-charge
 * (duplicate:true, a refused ClawPump request, a documented no-charge vendor
 * status); else the catalog price (success without an amount, any unverified
 * failure, a transport error).
 * Dedupe: consecutive calls alternate `dedupeVary` (all-time call count).
 * Mints from an add-on stay private to that agent (`floor_arena_private_mints`).
 */

/** D15: the run-time poll floor; the interval is max(catalog minIntervalS, 600 s). */
export const ARENA_ADDON_MIN_INTERVAL_S = 600;
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

/** `duplicate: true` = ClawPump replayed a cached body for an identical call: no new charge, old data. */
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
  if (stat?.lastAt && input.nowMs - stat.lastAt.getTime() < input.intervalMs) {
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
  listAgents: () => Promise<ArenaAgentRecord[]>;
  readStats: (agentId: string, dayStart: Date) => Promise<ArenaAddonCallStat[]>;
  /** Cap check + 'reserved' ledger row in ONE transaction under the per-agent advisory lock. */
  reserveCall: typeof reserveArenaAddonCall;
  /** Moves the reservation to 'done' with the charged amount. */
  finalizeCall: typeof finalizeArenaAddonCall;
  insertPrivateMints: typeof insertArenaPrivateMints;
  insertEvent: (agentId: string, event: { type: ArenaEventType; summary: string; data?: unknown }) => Promise<void>;
  walletUsdc: (clawpumpAgentId: string) => Promise<number | null>;
  skillSynced: (agentId: string) => boolean | undefined;
  ensureSkill: (agentId: string) => Promise<boolean>;
  pay: (clawpumpAgentId: string, input: X402PayInput) => Promise<ClawPumpX402Result>;
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
  skillSynced: arenaSkillSynced,
  ensureSkill: (agentId) => ensureAddonSkill(agentId),
  pay: (clawpumpAgentId, input) => clawPumpArenaWriter.x402Pay(clawpumpAgentId, input),
};

const notices = new Map<string, number>();
let tickRunning = false;

/** Test seam. */
export function _resetArenaAddonsForTest(): void {
  notices.clear();
  walletCache = null;
  walletFailureAt = 0;
  walletInflight = null;
  tickRunning = false;
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
 */
export async function runArenaAddonAgent(
  deps: ArenaAddonDeps,
  agent: ArenaAgentRecord,
  catalog: ReadonlyMap<string, FloorArenaAddon>,
  now: Date,
): Promise<void> {
  const clawpumpAgentId = agent.clawpumpAgentId;
  if (!clawpumpAgentId) return;
  const enabled = agent.addons.filter((addon) => addon.enabled && catalog.has(addon.id));
  if (enabled.length === 0) return;
  const nowMs = now.getTime();
  const dayStart = utcDayStart(now);
  const dayMs = dayStart.getTime();
  const stats = await deps.readStats(agent.id, dayStart);

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

    if (deps.skillSynced(agent.id) !== true) {
      try {
        await deps.ensureSkill(agent.id);
      } catch (error) {
        await notice(deps, `${key}:skill`, nowMs, NOTICE_INTERVAL_MS, agent.id,
          `${item.name}: skipped, could not enable x402 on the execution wallet (${errorText(error)}).`,
          { addonId: addon.id, reason: 'skill_sync_failed', error: errorText(error) });
        continue;
      }
      if (deps.skillSynced(agent.id) !== true) continue;
    }

    // The authoritative check + reservation, under the per-agent advisory lock.
    const reservation = await deps.reserveCall({
      agentId: agent.id,
      addonId: addon.id,
      clawpumpAgentId,
      at: now,
      priceUsd: price,
      dayStart,
      // Codex r3 #10: the cap is the one on the agent row NOW, read under the lock.
      check: (locked, currentCapUsd) => checkAddonCall({ ...checkInput, addonCapUsd: currentCapUsd, stats: locked }),
    });
    if (!reservation.reserved) {
      // Another container reserved first (interval) or the cap filled meanwhile.
      await capNotice(deps, agent.id, item, reservation.check, nowMs, dayMs);
      continue;
    }
    // Dedupe rotation: the all-time call count BEFORE this reservation.
    const request = buildAddonRequest(item, reservation.callNumber);

    // What counts against the cap is what ClawPump CHARGED (lead rule):
    //  - ok: `amount_charged_atomic` when reported, else the catalog price;
    //  - duplicate:true: 0 (a cached replay, no new charge, old data: parse nothing);
    //  - a vendor failure in a 200 (400/402/422 upstream): the reported charge, else 0;
    //  - a transport error (timeout, 5xx, ...): the catalog price, because it may have paid.
    // The stored error is a CODE, never vendor text (vendor fields are untrusted).
    let result: ClawPumpX402Result | null = null;
    let error: string | null = null;
    let charged = 0;
    try {
      result = await deps.pay(clawpumpAgentId, {
        url: item.url,
        method: item.method,
        ...(request.query ? { query: request.query } : {}),
        ...(request.body ? { body: request.body } : {}),
        maxAmountUsd: price,
      });
      const reported = chargedUsdFromPayload(result.payload);
      if (!result.ok) {
        error = vendorErrorCode(result.payload);
        // Codex r3 #9: a failure releases the reservation ONLY when it is a
        // verified no-charge (an explicit charged amount, or a documented
        // no-charge vendor status). Otherwise the catalog price stays booked.
        charged = reported ?? (isDocumentedNoChargeFailure(result.payload) ? 0 : price);
      } else if (isDuplicatePayload(result.payload)) {
        charged = 0;
      } else {
        // A 200 without `amount_charged_atomic` keeps the catalog price.
        charged = reported ?? price;
      }
    } catch (thrown) {
      error = errorText(thrown);
      charged = mayHaveCharged(thrown) ? price : 0;
    }

    const ok = result?.ok === true;
    const duplicate = ok && isDuplicatePayload(result!.payload);
    const tokens = ok && !duplicate ? extractAddonTokens(result!.payload, item.mintPath, item.symbolPath) : [];
    let fresh = 0;
    try {
      fresh = tokens.length > 0 ? await deps.insertPrivateMints(agent.id, addon.id, tokens, now) : 0;
    } catch (insertError) {
      console.error('[floor-arena] add-on mint insert failed:', insertError instanceof Error ? insertError.message : 'error');
    }
    // If this update fails, the reservation stays 'reserved' at the catalog
    // price: still counted against the cap (the safe side).
    await deps.finalizeCall(reservation.id, {
      priceUsd: charged,
      ok,
      error,
      mints: tokens.length,
      responseRef: ok && !duplicate ? extractResponseRef(result!.payload) : null,
    });
    await deps.insertEvent(agent.id, {
      type: 'addon',
      summary: duplicate
        ? `${item.name}: ClawPump returned a cached duplicate. No charge, no new tokens.`
        : ok
          ? `${item.name}: paid ${usd(charged)}, ${tokens.length} tokens (${fresh} new, private to this agent).`
          : `${item.name}: call failed (${error}). ${charged > 0 ? `${usd(charged)} counted against the daily cap.` : 'Nothing was charged.'}`,
      data: {
        addonId: addon.id, ok, duplicate, priceUsd: price, chargedUsd: charged, mints: tokens.length, newMints: fresh, error,
      },
    });
  }
}

/** Called every 60 s by the arena engine. Never throws. */
export async function runArenaAddonsTick(
  now: Date = new Date(),
  deps: ArenaAddonDeps = defaultArenaAddonDeps,
): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    if (!deps.paymentsEnabled()) return;
    const catalog = new Map(deps.catalog().map((addon) => [addon.id, addon]));
    if (catalog.size === 0) return;
    for (const agent of await deps.listAgents()) {
      try {
        await runArenaAddonAgent(deps, agent, catalog, now);
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
