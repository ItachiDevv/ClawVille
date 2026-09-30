import { randomUUID } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  FLOOR_ARENA_ADDONS,
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD,
  FLOOR_ARENA_HARD_RULES,
  FLOOR_ARENA_HOUSE_AGENTS,
  FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD,
  FLOOR_ARENA_PAPER_COSTS,
  FLOOR_ARENA_PARAM_BOUNDS,
  FLOOR_ARENA_TEMPLATES,
  FLOOR_ARENA_VERSION,
  applyFloorArenaParamChange,
  diffFloorArenaParams,
  floorArenaTemplateById,
  validateFloorArenaParams,
  type FloorArenaAddon,
  type FloorArenaParamDiff,
  type FloorArenaParams,
} from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  type ActivityAuthContext,
  type ActivityIdentity,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import { createRateLimiter, getClientIp, type RateLimiter } from '../middleware/rate-limit';
import { withKeyedMutex } from '../services/keyed-mutex';
import type { ClawPumpWalletBalance } from '../services/clawpump-writer';
import { ARENA_ADDON_MIN_INTERVAL_S, addonPaymentsEnabled, readArenaWalletBalance, utcDayStart } from '../services/floor-arena/addons';
import { readArenaContest, type ArenaContestView } from '../services/floor-arena/contest';
import {
  isArenaLeaderboardWindow,
  readArenaLeaderboard,
  type ArenaLeaderboardRow,
  type ArenaLeaderboardWindow,
} from '../services/floor-arena/leaderboard';
import { evaluateArenaSuggestion } from '../services/floor-arena/analysis';
import { ensureAddonSkill, provisionArenaAgent } from '../services/floor-arena/provisioning';
import {
  insertUserArenaAgent,
  readArenaAddonStats,
  readArenaAgent,
  readArenaAgentByOwner,
  readArenaAgentStats,
  readArenaDiscovery,
  readArenaEvents,
  readArenaHouseAgents,
  readArenaParamChanges,
  readArenaPositions,
  readArenaReport,
  readArenaTape,
  readAvatarName,
  readLatestArenaReport,
  ARENA_PUBLIC_USER_EVENT_TYPES,
  redactArenaEventForPublic,
  redactArenaParamChangeForPublic,
  redactArenaPositionForPublic,
  toPublicUserProfile,
  setArenaAgentAddons,
  setArenaAgentAutoApply,
  setArenaAgentSeat,
  setArenaAgentStatus,
  setArenaReportSuggestionState,
  toPublicAgent,
  updateArenaAgentParams,
  type ArenaAddonCallStat,
  type ArenaAgentAddon,
  type ArenaAgentRecord,
  type ArenaAgentStats,
  type ArenaDiscoveryRow,
  type ArenaEvent,
  type ArenaEventType,
  type ArenaParamChange,
  type ArenaPosition,
  type ArenaPublicAgent,
  type ArenaReport,
  type ArenaTapeItem,
  type InsertUserAgentInput,
  type ParamUpdateInput,
  type ParamUpdateResult,
} from '../services/floor-arena/queries';

/**
 * Trading Floor Arena API (docs/trading-floor-arena.md §5), mounted at
 * `/api/floor/arena` BEFORE the `/api/floor` router, so the public GETs never
 * run `sessionMiddleware` (it can append Set-Cookie, and these responses are
 * `Cache-Control: public`, the same load-bearing reason as trading-floor.ts).
 *
 * PARITY (E5): every `/me` route runs `requireAuthOrAgentSession`, so a human
 * (Lucia cookie) and a connected or hosted agent (`X-Clawville-Agent-Session`)
 * resolve to the SAME subject: the owning user and that user's active avatar.
 * The arena agent is keyed by the owning user, so a player and their agent
 * manage one and the same arena agent. Guests (and agents owned by a guest)
 * get 403 `guest_not_allowed`; an agent session that has not proved avatar
 * ownership gets 403 from `requireLedgerCapableIdentity`, because add-ons
 * spend real USDC from the agent's funded ClawPump wallet.
 *
 * Paper only (D11): `mode: 'live'` is refused with `live_not_available`.
 */

// ─── Response shapes (arena-web consumes these) ────────────────────────────

export interface ArenaAgentStatsByWindow {
  all: ArenaAgentStats;
  last24h: ArenaAgentStats;
  contest: ArenaAgentStats;
}

export interface ArenaHouseAgentView {
  id: string;
  name: string;
  templateId: string;
  status: ArenaPublicAgent['status'] | null;
  seated: boolean;
  paramsVersion: number | null;
  stats: ArenaAgentStatsByWindow;
}

export interface ArenaPublicAddon {
  id: string;
  vendor: string;
  name: string;
  priceUsd: number;
  minIntervalS: number;
  note: string;
}

export interface ArenaMyAddonStatus extends ArenaPublicAddon {
  enabled: boolean;
  dailyCapUsd: number;
  spentTodayUsd: number;
  lastCallAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
}

export interface ArenaMeResponse {
  agent: ArenaPublicAgent | null;
  paymentAddress: string | null;
  provision: { state: ArenaPublicAgent['provisionState']; error: string | null } | null;
  wallet: { address: string; usdc: number | null; sol: number | null; updatedAt: string | null } | null;
  addons: ArenaMyAddonStatus[];
  stats: ArenaAgentStatsByWindow | null;
  latestReport: ArenaReport | null;
}

// ─── Dependencies (tests inject fakes) ─────────────────────────────────────

export interface FloorArenaRouteDeps {
  now(): Date;
  newId(): string;
  readAgent(id: string): Promise<ArenaAgentRecord | null>;
  readAgentByOwner(userId: string): Promise<ArenaAgentRecord | null>;
  readHouseAgents(): Promise<ArenaAgentRecord[]>;
  readAvatarName(avatarId: string): Promise<string | null>;
  insertUserAgent(input: InsertUserAgentInput): Promise<ArenaAgentRecord | null>;
  updateParams(input: ParamUpdateInput): Promise<ParamUpdateResult>;
  setSeat(agentId: string, seated: boolean, seatIndex: number | null, summary: string): Promise<ArenaAgentRecord | null>;
  setStatus(agentId: string, status: 'active' | 'paused', summary: string): Promise<ArenaAgentRecord | null>;
  setAddons(agentId: string, addons: ArenaAgentAddon[], summary: string): Promise<ArenaAgentRecord | null>;
  setAutoApply(agentId: string, autoApply: boolean, summary: string): Promise<ArenaAgentRecord | null>;
  readReport(reportId: string): Promise<ArenaReport | null>;
  readLatestReport(agentId: string): Promise<ArenaReport | null>;
  setReportState(reportId: string, agentId: string, state: 'dismissed' | 'rejected' | 'applied'): Promise<boolean>;
  readPositions(agentId: string, status: 'open' | 'closed', limit: number): Promise<ArenaPosition[]>;
  readParamChanges(agentId: string, limit: number): Promise<ArenaParamChange[]>;
  readEvents(agentId: string, after: number | null, limit: number, types?: readonly ArenaEventType[] | null): Promise<ArenaEvent[]>;
  readDiscovery(limit: number, now: Date): Promise<ArenaDiscoveryRow[]>;
  readTape(limit: number): Promise<ArenaTapeItem[]>;
  readStats(agentIds: readonly string[], now: Date): Promise<Map<string, ArenaAgentStatsByWindow>>;
  readLeaderboard(window: ArenaLeaderboardWindow, now: Date): Promise<ArenaLeaderboardRow[]>;
  readContest(now: Date): Promise<ArenaContestView>;
  readAddonStats(agentId: string, dayStart: Date): Promise<ArenaAddonCallStat[]>;
  readWalletBalance(clawpumpAgentId: string): Promise<ClawPumpWalletBalance | null>;
  addonCatalog(): readonly FloorArenaAddon[];
  addonPaymentsEnabled(): boolean;
  /** Fire and forget: one provisioning attempt right after launch. */
  kickProvisioning(agentId: string): void;
  /** Fire and forget: re-sync the x402 skill after an add-on change. */
  syncAddonSkill(agentId: string): void;
}

export const defaultFloorArenaRouteDeps: FloorArenaRouteDeps = {
  now: () => new Date(),
  newId: () => randomUUID(),
  readAgent: readArenaAgent,
  readAgentByOwner: readArenaAgentByOwner,
  readHouseAgents: readArenaHouseAgents,
  readAvatarName,
  insertUserAgent: insertUserArenaAgent,
  updateParams: updateArenaAgentParams,
  setSeat: setArenaAgentSeat,
  setStatus: setArenaAgentStatus,
  setAddons: setArenaAgentAddons,
  setAutoApply: setArenaAgentAutoApply,
  readReport: readArenaReport,
  readLatestReport: readLatestArenaReport,
  setReportState: setArenaReportSuggestionState,
  readPositions: readArenaPositions,
  readParamChanges: readArenaParamChanges,
  readEvents: readArenaEvents,
  readDiscovery: readArenaDiscovery,
  readTape: readArenaTape,
  readStats: readArenaAgentStats,
  readLeaderboard: readArenaLeaderboard,
  readContest: readArenaContest,
  readAddonStats: readArenaAddonStats,
  readWalletBalance: (clawpumpAgentId) => readArenaWalletBalance(clawpumpAgentId),
  addonCatalog: () => FLOOR_ARENA_ADDONS,
  addonPaymentsEnabled: () => addonPaymentsEnabled(),
  kickProvisioning: (agentId) => {
    void provisionArenaAgent(agentId).catch((error: unknown) => {
      console.error('[floor-arena] launch provisioning failed:', error instanceof Error ? error.message : 'error');
    });
  },
  syncAddonSkill: (agentId) => {
    void ensureAddonSkill(agentId).catch((error: unknown) => {
      // The add-on tick retries the sync before its next payment.
      console.error('[floor-arena] x402 skill sync failed:', error instanceof Error ? error.message : 'error');
    });
  },
};

// ─── Validation ────────────────────────────────────────────────────────────

const AGENT_ID = /^(house:[a-z0-9-]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const NAME = /^[\p{L}\p{N} _.'-]+$/u;
const NAME_MAX = 32;
const SEAT_MAX_INDEX = 5;

const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const TAPE_MAX = 24;
const TAPE_DEFAULT = 12;

const addonEntrySchema = z.object({
  id: z.string().trim().min(1).max(64),
  enabled: z.boolean().optional(),
  dailyCapUsd: z.number().finite().min(0).max(FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD).optional(),
}).strict();

export const launchBodySchema = z.object({
  templateId: z.string().trim().min(1).max(40),
  params: z.unknown(),
  mode: z.string().trim().min(1).max(16),
  addons: z.array(addonEntrySchema).max(10).optional(),
  name: z.string().trim().min(1).max(NAME_MAX).regex(NAME).optional(),
}).strict();

export const paramsBodySchema = z.object({
  params: z.unknown(),
  reason: z.string().trim().min(1).max(280).optional(),
}).strict();

export const seatBodySchema = z.object({
  seated: z.boolean(),
  seatIndex: z.number().int().min(0).max(SEAT_MAX_INDEX).optional(),
}).strict();

export const statusBodySchema = z.object({ status: z.enum(['active', 'paused']) }).strict();
export const addonsBodySchema = z.object({ addons: z.array(addonEntrySchema).max(10) }).strict();
export const suggestionBodySchema = z.object({ action: z.enum(['apply', 'dismiss']) }).strict();
export const settingsBodySchema = z.object({ autoApplySuggestions: z.boolean() }).strict();

type AddonCheck = { ok: true; addons: ArenaAgentAddon[] } | { ok: false; code: string; error: string };

/** Known catalog ids only, no duplicates, caps 0..max, enabled caps summing to at most the agent max. */
export function normaliseAddons(
  entries: ReadonlyArray<z.infer<typeof addonEntrySchema>>,
  catalog: readonly FloorArenaAddon[],
): AddonCheck {
  const known = new Set(catalog.map((addon) => addon.id));
  const seen = new Set<string>();
  const addons: ArenaAgentAddon[] = [];
  for (const entry of entries) {
    if (!known.has(entry.id)) return { ok: false, code: 'unknown_addon', error: `Unknown add-on: ${entry.id}` };
    if (seen.has(entry.id)) return { ok: false, code: 'duplicate_addon', error: `Add-on listed twice: ${entry.id}` };
    seen.add(entry.id);
    addons.push({
      id: entry.id,
      enabled: entry.enabled ?? true,
      dailyCapUsd: entry.dailyCapUsd ?? FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD,
    });
  }
  const enabledCap = addons.filter((addon) => addon.enabled).reduce((sum, addon) => sum + addon.dailyCapUsd, 0);
  if (enabledCap > FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD + 1e-9) {
    return {
      ok: false,
      code: 'addon_cap_exceeded',
      error: `The daily caps of enabled add-ons add up to more than $${FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD}.`,
    };
  }
  return { ok: true, addons };
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'off';
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

/** "Changed 2 settings: filters.mcap_max 250000 -> 300000; exits.max_hold_s 900 -> 1200" (<= 280 chars later). */
export function describeChanges(changes: readonly FloorArenaParamDiff[], prefix = 'Changed'): string {
  const parts = changes.map((change) => `${change.path} ${formatValue(change.from)} -> ${formatValue(change.to)}`);
  return `${prefix} ${changes.length} setting${changes.length === 1 ? '' : 's'}: ${parts.join('; ')}`;
}

/**
 * A user agent's public event. A param_change summary is REBUILT from the diff
 * (never the stored text), so no player-typed or model-written reason can reach
 * the public stream through the summary either.
 */
function publicUserEvent(event: ArenaEvent): ArenaEvent {
  const redacted = redactArenaEventForPublic(event);
  if (redacted.type !== 'param_change') return redacted;
  const changes = (redacted.data as { changes?: unknown } | null)?.changes;
  const diff = Array.isArray(changes)
    ? changes.filter((change): change is FloorArenaParamDiff =>
      !!change && typeof change === 'object' && typeof (change as { path?: unknown }).path === 'string')
    : [];
  return { ...redacted, summary: diff.length > 0 ? describeChanges(diff) : 'Changed settings' };
}

function publicAddon(addon: FloorArenaAddon): ArenaPublicAddon {
  return {
    id: addon.id,
    vendor: addon.vendor,
    name: addon.name,
    priceUsd: addon.priceUsd,
    minIntervalS: Math.max(addon.minIntervalS, ARENA_ADDON_MIN_INTERVAL_S),
    note: addon.note,
  };
}

function emptyStats(): ArenaAgentStatsByWindow {
  const zero: ArenaAgentStats = { realisedUsd: 0, trades: 0, wins: 0, losses: 0, deaths: 0, openPositions: 0, lastTradeAt: null };
  return { all: { ...zero }, last24h: { ...zero }, contest: { ...zero } };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function invalidBody(c: Context) {
  return c.json({ error: 'Invalid request body.', code: 'invalid_body' }, 400);
}

// ─── Small TTL cache for public GETs ───────────────────────────────────────

function createTtlCache<T>(ttlMs: number, maxEntries = 500) {
  const entries = new Map<string, { expiresAt: number; value: T }>();
  return {
    async get(key: string, nowMs: number, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > nowMs) return hit.value;
      const value = await load();
      if (entries.size >= maxEntries) entries.clear();
      entries.set(key, { expiresAt: nowMs + ttlMs, value });
      return value;
    },
    clear() {
      entries.clear();
    },
  };
}

// ─── Router factory ────────────────────────────────────────────────────────

/** The authed chain on every `/me` route (E5): session -> human OR agent identity -> non-guest -> ledger-capable. */
export const FLOOR_ARENA_AUTH_CHAIN: readonly MiddlewareHandler[] = [
  sessionMiddleware as unknown as MiddlewareHandler,
  requireAuthOrAgentSession as unknown as MiddlewareHandler,
  requireNonGuestIdentity as unknown as MiddlewareHandler,
  requireLedgerCapableIdentity as unknown as MiddlewareHandler,
];

export interface FloorArenaRouteOptions {
  /** The authed middleware chain. Default: session -> identity -> non-guest -> ledger-capable. */
  auth?: MiddlewareHandler[];
  /** Fresh limiters per router instance (tests). */
  limiters?: Partial<Record<'public' | 'write' | 'launch', () => RateLimiter>>;
}

export function createFloorArenaRoutes(
  deps: FloorArenaRouteDeps = defaultFloorArenaRouteDeps,
  options: FloorArenaRouteOptions = {},
) {
  const routes = new Hono<ActivityAuthContext>();
  const makePublic = options.limiters?.public ?? (() => createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 }));
  const makeWrite = options.limiters?.write ?? (() => createRateLimiter({ maxPerWindow: 30, windowMs: 60_000 }));
  const makeLaunch = options.limiters?.launch ?? (() => createRateLimiter({ maxPerWindow: 5, windowMs: 60_000 }));
  const publicLimiters = new Map<string, RateLimiter>();
  const publicLimiter = (route: string): RateLimiter => {
    let limiter = publicLimiters.get(route);
    if (!limiter) {
      limiter = makePublic();
      publicLimiters.set(route, limiter);
    }
    return limiter;
  };
  const writeLimiter = makeWrite();
  const launchLimiter = makeLaunch();

  const templatesCache = createTtlCache<unknown>(15_000, 4);
  const leaderboardCache = createTtlCache<unknown>(10_000, 8);
  const agentCache = createTtlCache<unknown>(5_000);
  const eventsCache = createTtlCache<unknown>(3_000);
  const discoveryCache = createTtlCache<unknown>(10_000, 16);
  const contestCache = createTtlCache<unknown>(10_000, 2);
  const tapeCache = createTtlCache<unknown>(5_000, 24);

  function limited(c: Context, route: string) {
    if (publicLimiter(route).check(getClientIp(c.req.raw.headers))) return null;
    return c.json({ error: 'Too many requests.', code: 'rate_limited' }, 429);
  }

  function publicJson(c: Context, body: unknown, maxAge = 5) {
    // Set only on success, so an edge never caches an error body.
    c.header('Cache-Control', `public, max-age=${maxAge}`);
    return c.json(body);
  }

  // ── Public GETs (NO session middleware; see the file header) ─────────────

  routes.get('/templates', async (c) => {
    const blocked = limited(c, 'templates');
    if (blocked) return blocked;
    const now = deps.now();
    const body = await templatesCache.get('templates', now.getTime(), async () => {
      const rows = new Map((await deps.readHouseAgents()).map((agent) => [agent.id, agent]));
      const stats = await deps.readStats(FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.id), now);
      const houseAgents: ArenaHouseAgentView[] = FLOOR_ARENA_HOUSE_AGENTS.map((house) => {
        const row = rows.get(house.id);
        return {
          id: house.id,
          name: house.name,
          templateId: house.templateId,
          status: row?.status ?? null,
          seated: true,
          paramsVersion: row?.paramsVersion ?? null,
          stats: stats.get(house.id) ?? emptyStats(),
        };
      });
      return {
        version: FLOOR_ARENA_VERSION,
        templates: FLOOR_ARENA_TEMPLATES,
        hardRules: FLOOR_ARENA_HARD_RULES,
        bounds: FLOOR_ARENA_PARAM_BOUNDS,
        paperCosts: FLOOR_ARENA_PAPER_COSTS,
        addonDailyCap: { defaultUsd: FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD, maxUsd: FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD },
        houseAgents,
        generatedAt: now.toISOString(),
      };
    });
    return publicJson(c, body, 15);
  });

  routes.get('/leaderboard', async (c) => {
    const blocked = limited(c, 'leaderboard');
    if (blocked) return blocked;
    const window = c.req.query('window') ?? 'contest';
    if (!isArenaLeaderboardWindow(window)) {
      return c.json({ error: 'window must be contest, 24h or all.', code: 'invalid_window' }, 400);
    }
    const now = deps.now();
    const body = await leaderboardCache.get(window, now.getTime(), async () => ({
      window,
      contest: { id: FLOOR_ARENA_CONTEST.id, startsAt: FLOOR_ARENA_CONTEST.startsAt, endsAt: FLOOR_ARENA_CONTEST.endsAt },
      rows: await deps.readLeaderboard(window, now),
      generatedAt: now.toISOString(),
    }));
    return publicJson(c, body);
  });

  routes.get('/agents/:id', async (c) => {
    const blocked = limited(c, 'agent');
    if (blocked) return blocked;
    const id = c.req.param('id') ?? '';
    if (!AGENT_ID.test(id)) return c.json({ error: 'Arena agent not found.', code: 'agent_not_found' }, 404);
    const now = deps.now();
    const body = await agentCache.get(id, now.getTime(), async () => {
      const agent = await deps.readAgent(id);
      if (!agent) return null;
      const house = agent.kind === 'house';
      const [stats, openPositions, closedPositions, latestReport, paramChanges] = await Promise.all([
        deps.readStats([agent.id], now),
        deps.readPositions(agent.id, 'open', 5),
        deps.readPositions(agent.id, 'closed', 50),
        house ? deps.readLatestReport(agent.id) : Promise.resolve(null),
        deps.readParamChanges(agent.id, 20),
      ]);
      // Codex r2 #1/#2: another player's agent shows strategy, state and
      // results only. Add-on settings, payment address, provisioning state and
      // reports stay with the owner (/me); an add-on source reads 'addon'.
      return {
        agent: house ? toPublicAgent(agent) : toPublicUserProfile(agent),
        stats: stats.get(agent.id) ?? emptyStats(),
        openPositions: house ? openPositions : openPositions.map(redactArenaPositionForPublic),
        closedPositions: house ? closedPositions : closedPositions.map(redactArenaPositionForPublic),
        latestReport,
        paramChanges: house ? paramChanges : paramChanges.map(redactArenaParamChangeForPublic),
        generatedAt: now.toISOString(),
      };
    });
    if (!body) return c.json({ error: 'Arena agent not found.', code: 'agent_not_found' }, 404);
    return publicJson(c, body);
  });

  routes.get('/agents/:id/events', async (c) => {
    const blocked = limited(c, 'events');
    if (blocked) return blocked;
    const id = c.req.param('id') ?? '';
    if (!AGENT_ID.test(id)) return c.json({ error: 'Arena agent not found.', code: 'agent_not_found' }, 404);
    const query = eventsQuerySchema.safeParse({ after: c.req.query('after'), limit: c.req.query('limit') });
    if (!query.success) return c.json({ error: 'after must be an event id; limit 1..100.', code: 'invalid_query' }, 400);
    const after = query.data.after ?? null;
    const limit = query.data.limit ?? 50;
    const now = deps.now();
    const body = await eventsCache.get(`${id}|${after ?? ''}|${limit}`, now.getTime(), async () => {
      const agent = await deps.readAgent(id);
      if (!agent) return null;
      // Codex r2 #2: a user agent's public stream is trades, param changes and
      // status only (no scan/pass/skip/addon/report, which can name private
      // add-on mints), with add-on sources redacted. The owner reads every
      // type through GET /me/events.
      const events = agent.kind === 'house'
        ? await deps.readEvents(id, after, limit)
        : (await deps.readEvents(id, after, limit, ARENA_PUBLIC_USER_EVENT_TYPES)).map(publicUserEvent);
      return {
        agentId: id,
        events,
        lastId: events.length > 0 ? events[events.length - 1]!.id : after,
        generatedAt: now.toISOString(),
      };
    });
    if (!body) return c.json({ error: 'Arena agent not found.', code: 'agent_not_found' }, 404);
    return publicJson(c, body, 2);
  });

  routes.get('/discovery', async (c) => {
    const blocked = limited(c, 'discovery');
    if (blocked) return blocked;
    const parsed = z.coerce.number().int().min(1).max(100).optional().safeParse(c.req.query('limit'));
    if (!parsed.success) return c.json({ error: 'limit must be 1..100.', code: 'invalid_query' }, 400);
    const limit = parsed.data ?? 50;
    const now = deps.now();
    const body = await discoveryCache.get(String(limit), now.getTime(), async () => ({
      mints: await deps.readDiscovery(limit, now),
      generatedAt: now.toISOString(),
    }));
    return publicJson(c, body, 10);
  });

  // The TV trade tape: newest entry and exit fills across ALL arena agents.
  // Item ids are `<type>:<event id>`, stable across polls (the 3D chips key on them).
  routes.get('/tape', async (c) => {
    const blocked = limited(c, 'tape');
    if (blocked) return blocked;
    const parsed = z.coerce.number().int().min(1).max(TAPE_MAX).optional().safeParse(c.req.query('limit'));
    if (!parsed.success) return c.json({ error: `limit must be 1..${TAPE_MAX}.`, code: 'invalid_query' }, 400);
    const limit = parsed.data ?? TAPE_DEFAULT;
    const now = deps.now();
    const body = await tapeCache.get(String(limit), now.getTime(), async () => ({
      items: await deps.readTape(limit),
      generatedAt: now.toISOString(),
    }));
    return publicJson(c, body);
  });

  routes.get('/contest', async (c) => {
    const blocked = limited(c, 'contest');
    if (blocked) return blocked;
    const now = deps.now();
    const body = await contestCache.get('contest', now.getTime(), () => deps.readContest(now));
    return publicJson(c, body, 10);
  });

  routes.get('/addons', (c) => {
    const blocked = limited(c, 'addons');
    if (blocked) return blocked;
    return publicJson(c, {
      addons: deps.addonCatalog().map(publicAddon),
      paymentsEnabled: deps.addonPaymentsEnabled(),
      dailyCap: { defaultUsd: FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD, maxUsd: FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD },
      minIntervalS: ARENA_ADDON_MIN_INTERVAL_S,
    }, 60);
  });

  // ── Authed /me routes ────────────────────────────────────────────────────

  const auth: readonly MiddlewareHandler[] = options.auth ?? FLOOR_ARENA_AUTH_CHAIN;
  // ONE registration covers `/me` and every `/me/...` path. Hono's `/me/*`
  // matches `/me` itself and never a public sibling such as `/meh`, so this is
  // not the `router.use('/')` prefix trap noStorePrivate warns about: no public
  // route lives under `/me`. Registered AFTER the public GETs on purpose.
  routes.use('/me/*', ...auth, noStorePrivate);

  function identityOf(c: Context<ActivityAuthContext>): ActivityIdentity {
    return c.get('identity');
  }

  function writeBlocked(c: Context<ActivityAuthContext>, limiter: RateLimiter = writeLimiter) {
    if (limiter.check(`user:${identityOf(c).userId}`)) return null;
    return c.json({ error: 'Too many arena changes. Wait a minute.', code: 'rate_limited' }, 429);
  }

  async function myAgent(c: Context<ActivityAuthContext>): Promise<ArenaAgentRecord | null> {
    return deps.readAgentByOwner(identityOf(c).userId);
  }

  function noAgent(c: Context) {
    return c.json({ error: 'You have no arena agent yet. Launch one first.', code: 'no_agent' }, 404);
  }

  function forgetPublic() {
    // The owner just changed it: do not serve them a 5 s old profile.
    agentCache.clear();
    eventsCache.clear();
  }

  async function meBody(agent: ArenaAgentRecord | null, now: Date): Promise<ArenaMeResponse> {
    if (!agent) {
      return { agent: null, paymentAddress: null, provision: null, wallet: null, addons: [], stats: null, latestReport: null };
    }
    const catalog = new Map(deps.addonCatalog().map((addon) => [addon.id, addon]));
    const [stats, addonStats, latestReport, balance] = await Promise.all([
      deps.readStats([agent.id], now),
      deps.readAddonStats(agent.id, utcDayStart(now)),
      deps.readLatestReport(agent.id),
      agent.provisionState === 'ready' && agent.clawpumpAgentId
        ? deps.readWalletBalance(agent.clawpumpAgentId).catch(() => null)
        : Promise.resolve(null),
    ]);
    const statsById = new Map(addonStats.map((row) => [row.addonId, row]));
    const addons: ArenaMyAddonStatus[] = [];
    for (const entry of agent.addons) {
      const item = catalog.get(entry.id);
      if (!item) continue;
      const stat = statsById.get(entry.id);
      addons.push({
        ...publicAddon(item),
        enabled: entry.enabled,
        dailyCapUsd: entry.dailyCapUsd,
        spentTodayUsd: stat?.spentTodayUsd ?? 0,
        lastCallAt: stat?.lastAt ? stat.lastAt.toISOString() : null,
        lastOk: stat?.lastOk ?? null,
        lastError: stat?.lastError ?? null,
      });
    }
    const publicAgent = toPublicAgent(agent);
    return {
      agent: publicAgent,
      paymentAddress: publicAgent.paymentAddress,
      provision: { state: agent.provisionState, error: agent.provisionError },
      wallet: publicAgent.paymentAddress
        ? {
            address: publicAgent.paymentAddress,
            usdc: balance?.usdc ?? null,
            sol: balance?.sol ?? null,
            updatedAt: balance?.updatedAt ?? null,
          }
        : null,
      addons,
      stats: stats.get(agent.id) ?? emptyStats(),
      latestReport,
    };
  }

  routes.get('/me', async (c) => {
    return c.json(await meBody(await myAgent(c), deps.now()));
  });

  // The owner's FULL decision stream (every type, nothing redacted): scans,
  // passes, skips, add-on calls, provisioning, reports. Same cursor contract as
  // the public /agents/:id/events. Never cached (noStorePrivate on /me/*).
  routes.get('/me/events', async (c) => {
    const query = eventsQuerySchema.safeParse({ after: c.req.query('after'), limit: c.req.query('limit') });
    if (!query.success) return c.json({ error: 'after must be an event id; limit 1..100.', code: 'invalid_query' }, 400);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const after = query.data.after ?? null;
    const events = await deps.readEvents(agent.id, after, query.data.limit ?? 50);
    return c.json({
      agentId: agent.id,
      events,
      lastId: events.length > 0 ? events[events.length - 1]!.id : after,
      generatedAt: deps.now().toISOString(),
    });
  });

  routes.post('/me/launch', async (c) => {
    const blocked = writeBlocked(c, launchLimiter);
    if (blocked) return blocked;
    const parsed = launchBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const body = parsed.data;
    if (body.mode === 'live') {
      return c.json({ error: 'Live trading is not available yet. Launch in paper mode.', code: 'live_not_available' }, 400);
    }
    if (body.mode !== 'paper') return invalidBody(c);
    const template = floorArenaTemplateById(body.templateId);
    if (!template) return c.json({ error: 'Unknown template.', code: 'unknown_template' }, 400);
    const params = validateFloorArenaParams(body.params);
    if (!params.ok) return c.json({ error: 'The strategy settings are not valid.', code: 'invalid_params', errors: params.errors }, 400);
    const addons = normaliseAddons(body.addons ?? [], deps.addonCatalog());
    if (!addons.ok) return c.json({ error: addons.error, code: addons.code }, 400);

    const identity = identityOf(c);
    const now = deps.now();
    const result = await withKeyedMutex(`floor-arena-launch:${identity.userId}`, async () => {
      const existing = await deps.readAgentByOwner(identity.userId);
      if (existing) return { conflict: existing } as const;
      const avatarName = (await deps.readAvatarName(identity.avatarId)) ?? 'Arena Agent';
      const fallback = avatarName.replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, NAME_MAX) || 'Arena Agent';
      const inserted = await deps.insertUserAgent({
        id: deps.newId(),
        ownerUserId: identity.userId,
        avatarId: identity.avatarId,
        name: body.name ?? fallback,
        templateId: template.id,
        params: params.params,
        addons: addons.addons,
        // Codex r3 #6: enrol only while the contest is open (strictly before endsAt).
        contestId: now.getTime() < new Date(FLOOR_ARENA_CONTEST.endsAt).getTime() ? FLOOR_ARENA_CONTEST.id : null,
      });
      return inserted ? ({ agent: inserted } as const) : ({ conflict: null } as const);
    });
    if ('conflict' in result) {
      return c.json({
        error: 'This account already has an arena agent.',
        code: 'already_have_agent',
        agentId: result.conflict?.id ?? null,
      }, 409);
    }
    deps.kickProvisioning(result.agent.id);
    // The profile cache may hold a 404 for this id from a poll before launch.
    forgetPublic();
    return c.json({ agent: toPublicAgent(result.agent), paymentAddress: null }, 201);
  });

  async function applyParams(
    c: Context<ActivityAuthContext>,
    agent: ArenaAgentRecord,
    next: FloorArenaParams,
    source: 'user' | 'suggestion',
    reason: string | null,
    report?: { id: string; state: 'applied' },
  ) {
    const changes = diffFloorArenaParams(agent.params, next);
    if (changes.length === 0) {
      if (report) await deps.setReportState(report.id, agent.id, 'applied');
      return c.json({ agent: toPublicAgent(agent), changes, paramsVersion: agent.paramsVersion });
    }
    const written = await deps.updateParams({
      agentId: agent.id,
      expectedVersion: agent.paramsVersion,
      params: next,
      changes,
      source,
      reason,
      summary: describeChanges(changes, source === 'suggestion' ? 'Applied the analysis suggestion, changed' : 'Changed'),
      ...(report ? { report } : {}),
    });
    if (!written.ok) {
      return written.reason === 'report_not_pending'
        ? c.json({ error: 'This suggestion is no longer pending.', code: 'suggestion_not_pending' }, 409)
        : c.json({ error: 'The settings changed at the same time. Reload and try again.', code: 'params_conflict' }, 409);
    }
    forgetPublic();
    const fresh = (await deps.readAgent(agent.id)) ?? agent;
    return c.json({ agent: toPublicAgent(fresh), changes, paramsVersion: written.paramsVersion });
  }

  routes.patch('/me/params', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = paramsBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const params = validateFloorArenaParams(parsed.data.params);
    if (!params.ok) return c.json({ error: 'The strategy settings are not valid.', code: 'invalid_params', errors: params.errors }, 400);
    return applyParams(c, agent, params.params, 'user', parsed.data.reason ?? null);
  });

  routes.post('/me/seat', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = seatBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const { seated } = parsed.data;
    const seatIndex = seated ? parsed.data.seatIndex ?? null : null;
    if (agent.seated === seated && agent.seatIndex === seatIndex) return c.json({ agent: toPublicAgent(agent) });
    const summary = seated
      ? seatIndex === null ? 'Sat down at a desk. New entries are on.' : `Sat down at desk ${seatIndex + 1}. New entries are on.`
      : 'Stood up. No new entries; open positions still exit on their rules.';
    const updated = await deps.setSeat(agent.id, seated, seatIndex, summary);
    if (!updated) return noAgent(c);
    forgetPublic();
    return c.json({ agent: toPublicAgent(updated) });
  });

  routes.post('/me/status', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = statusBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    if (agent.status === 'stopped') return c.json({ error: 'This arena agent is stopped.', code: 'agent_stopped' }, 409);
    if (agent.status === parsed.data.status) return c.json({ agent: toPublicAgent(agent) });
    const summary = parsed.data.status === 'paused'
      ? 'Paused. No new entries; open positions still exit on their rules.'
      : 'Resumed. New entries are on while seated.';
    const updated = await deps.setStatus(agent.id, parsed.data.status, summary);
    if (!updated) return noAgent(c);
    forgetPublic();
    return c.json({ agent: toPublicAgent(updated) });
  });

  routes.patch('/me/addons', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = addonsBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const addons = normaliseAddons(parsed.data.addons, deps.addonCatalog());
    if (!addons.ok) return c.json({ error: addons.error, code: addons.code }, 400);
    const on = addons.addons.filter((addon) => addon.enabled);
    const summary = on.length === 0
      ? 'Paid add-ons are off.'
      : `Paid add-ons on: ${on.map((addon) => `${addon.id} (cap $${addon.dailyCapUsd.toFixed(2)}/day)`).join(', ')}.`;
    const updated = await deps.setAddons(agent.id, addons.addons, summary);
    if (!updated) return noAgent(c);
    if (updated.provisionState === 'ready') deps.syncAddonSkill(updated.id);
    forgetPublic();
    return c.json(await meBody(updated, deps.now()));
  });

  routes.post('/me/suggestions/:reportId', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const reportId = c.req.param('reportId') ?? '';
    if (!z.string().uuid().safeParse(reportId).success) {
      return c.json({ error: 'Report not found.', code: 'report_not_found' }, 404);
    }
    const parsed = suggestionBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    const report = await deps.readReport(reportId);
    if (!report || report.agentId !== agent.id) return c.json({ error: 'Report not found.', code: 'report_not_found' }, 404);
    if (report.suggestionState !== 'pending' || !report.suggestion) {
      return c.json({ error: 'This suggestion is no longer pending.', code: 'suggestion_not_pending' }, 409);
    }
    if (parsed.data.action === 'dismiss') {
      const done = await deps.setReportState(report.id, agent.id, 'dismissed');
      if (!done) return c.json({ error: 'This suggestion is no longer pending.', code: 'suggestion_not_pending' }, 409);
      forgetPublic();
      return c.json({ report: { ...report, suggestionState: 'dismissed' }, agent: toPublicAgent(agent) });
    }
    const { path, from, to, reason } = report.suggestion;
    // Same check the analysis tick runs: known leaf, never position_usd, valid
    // params, exactly one leaf changes.
    const evaluation = evaluateArenaSuggestion({ current: agent.params, path, to });
    if (!evaluation.ok) {
      if (evaluation.reason === 'no_change') {
        // The owner already set this value: the suggestion is satisfied.
        await deps.setReportState(report.id, agent.id, 'applied');
        return c.json({ agent: toPublicAgent(agent), changes: [], paramsVersion: agent.paramsVersion });
      }
      await deps.setReportState(report.id, agent.id, 'rejected');
      return c.json({
        error: 'The suggestion is outside the allowed settings.',
        code: 'invalid_params',
        errors: evaluation.errors ?? [`${path}: ${evaluation.reason}`],
      }, 400);
    }
    // Stale: the owner changed this setting after the report. Applying the old
    // "from X to Y" would silently overwrite the newer edit, so refuse.
    if (diffFloorArenaParams(agent.params, applyFloorArenaParamChange(agent.params, path, from)).length > 0) {
      await deps.setReportState(report.id, agent.id, 'rejected');
      return c.json({
        error: 'This setting changed after the report. The suggestion no longer applies.',
        code: 'suggestion_stale',
      }, 409);
    }
    return applyParams(c, agent, evaluation.next, 'suggestion', reason || null, { id: report.id, state: 'applied' });
  });

  routes.patch('/me/settings', async (c) => {
    const blocked = writeBlocked(c);
    if (blocked) return blocked;
    const parsed = settingsBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const agent = await myAgent(c);
    if (!agent) return noAgent(c);
    if (agent.autoApplySuggestions === parsed.data.autoApplySuggestions) return c.json({ agent: toPublicAgent(agent) });
    const updated = await deps.setAutoApply(
      agent.id,
      parsed.data.autoApplySuggestions,
      parsed.data.autoApplySuggestions
        ? 'Auto-apply is on: each 30-minute suggestion is applied and logged.'
        : 'Auto-apply is off: suggestions wait for one click.',
    );
    if (!updated) return noAgent(c);
    forgetPublic();
    return c.json({ agent: toPublicAgent(updated) });
  });

  return routes;
}

export const floorArenaRoutes = createFloorArenaRoutes();
