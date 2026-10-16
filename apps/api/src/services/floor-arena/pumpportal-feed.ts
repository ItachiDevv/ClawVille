import { db, sql } from '@clawville/database';
import {
  cleanVendorText, isTradableMint, mergeSightings, upsertSightings, VENDOR_NAME_MAX, VENDOR_SYMBOL_MAX, type Sighting,
} from './discovery-hub';

/**
 * PumpPortal discovery + per-mint trade-flow facts for the Trading Floor Arena (job arena-pipeline T4, 2026-10-15).
 *
 * ONE websocket to `wss://pumpportal.fun/api/data` (PumpPortal bans clients that open many), held only by the arena
 * leader: index.ts runs `runPumpPortalTick` as a leader loop every ~15 s, and a lease watchdog closes the socket when
 * no tick arrived for 45 s (demotion, or the engine stopped). Two leaders overlap only while a demoted process still
 * holds its socket, at most ~45 s; a process exit closes it at once.
 *
 *   - subscribeNewToken -> discovery source `pumpportal:new`; subscribeMigration -> `pumpportal:migration`, both
 *     through the hub's `upsertSightings` (batched per tick).
 *   - A bounded watch set (cap 300, oldest evicted first): new mints for 30 min, migrated mints and pump.fun mints
 *     with an open arena position for up to 2 h from when the watch began.
 *   - Trade flow (subscribeTokenTrade for the watch set) needs a PumpPortal API key funded with >= 0.02 SOL (live
 *     reply 2026-10-15). With no `PUMPPORTAL_API_KEY` the feed runs discovery + create-event facts only and every
 *     trade window stays null. The key goes only into the socket URL query; every logged or returned string is
 *     redacted. The key's wallet is never used for trading by ClawVille.
 *   - Flow facts are kept in memory and flushed to `floor_pumpportal_flow` (migration 0084) every tick; rows older
 *     than 24 h are pruned hourly. DATA ONLY: no filter threshold reads them; entries record them as
 *     `entry_features.pumpFlow` (engine.ts).
 *
 * PumpPortal messages carry no timestamp: event times are the receive time on this process.
 * Kill switch: FLOOR_ARENA_PUMPPORTAL_ENABLED='false' (default on).
 */

export const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data';
export const PUMPPORTAL_TICK_MS = 15_000;
export const NEW_MINT_WATCH_MS = 30 * 60_000;
export const LONG_WATCH_MS = 2 * 3_600_000;
export const WATCH_CAP = 300;
export const FLOW_RETAIN_MS = 15 * 60_000;
export const EARLY_BUYER_WINDOW_MS = 60_000;
/** A mint subscribed later than this after its create event has no first-60-s buyer facts. */
export const EARLY_SUBSCRIBE_SLACK_MS = 5_000;
export const MAX_TRADES_PER_MINT = 2_000;
/** New tokens arrive every few seconds: 90 s of silence on an open socket means it is dead. */
export const STALE_SOCKET_MS = 90_000;
export const LEADER_LEASE_MS = 45_000;
export const CONNECT_TIMEOUT_MS = 30_000;
export const FLOW_ROW_TTL_MS = 24 * 3_600_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const SUBSCRIBE_CHUNK = 100;
const MAX_PENDING_SIGHTINGS = 2_000;
const POSITION_REFRESH_EVERY_TICKS = 4;
const PRUNE_EVERY_TICKS = 240;
/** pump.fun and LetsBonk launches mint exactly 1e9 tokens. */
const LAUNCH_SUPPLY_TOKENS = 1_000_000_000;
const FIXED_SUPPLY_POOLS: ReadonlySet<string> = new Set(['pump', 'bonk']);
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const POOL_RE = /^[a-z0-9_-]{1,24}$/;
const TRADE_KEY_REFUSAL_RE = /only available when connecting with an API key/i;

// ---------------------------------------------------------------- env + redaction

export function pumpPortalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FLOOR_ARENA_PUMPPORTAL_ENABLED?.trim().toLowerCase() !== 'false';
}

export function pumpPortalApiKey(env: Record<string, string | undefined> = process.env): string | null {
  const key = env.PUMPPORTAL_API_KEY?.trim();
  return key ? key : null;
}

/** The socket URL. Never log it: log `redactPumpPortalText(...)` or `PUMPPORTAL_WS_URL`. */
export function pumpPortalUrl(apiKey: string | null): string {
  return apiKey ? `${PUMPPORTAL_WS_URL}?api-key=${encodeURIComponent(apiKey)}` : PUMPPORTAL_WS_URL;
}

/** Removes the `api-key=` query value and the raw key (when known) from any text that may be logged or stored. */
export function redactPumpPortalText(text: string, apiKey: string | null = null): string {
  let out = text.replace(/api-key=[^&\s"'<>]+/gi, 'api-key=<redacted>');
  if (apiKey) {
    out = out.split(apiKey).join('<redacted>');
    const encoded = encodeURIComponent(apiKey);
    if (encoded !== apiKey) out = out.split(encoded).join('<redacted>');
  }
  return out;
}

// ---------------------------------------------------------------- message parsing (pure)

export type PumpEvent =
  | {
    kind: 'create'; mint: string; creator: string | null; pool: string | null; name: string | null; symbol: string | null;
    solAmount: number | null; initialBuy: number | null; newTokenBalance: number | null; vSol: number | null; marketCapSol: number | null;
  }
  | { kind: 'migrate'; mint: string; pool: string | null }
  | {
    kind: 'trade'; mint: string; side: 'buy' | 'sell'; trader: string | null; solAmount: number | null; tokenAmount: number | null;
    newTokenBalance: number | null; vSol: number | null; marketCapSol: number | null; pool: string | null;
  }
  | { kind: 'message'; text: string };

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function address(value: unknown): string | null {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? value : null;
}

function pool(value: unknown): string | null {
  return typeof value === 'string' && POOL_RE.test(value) ? value : null;
}

/**
 * One PumpPortal frame -> an event, or null (unknown shape, quote mint, bad mint). Observed 2026-10-15:
 *   create: signature, mint, traderPublicKey, txType, initialBuy, solAmount, bondingCurveKey, vTokensInBondingCurve,
 *     vSolInBondingCurve, marketCapSol, name, symbol, uri, is_mayhem_mode, pool ('pump'); LetsBonk ('bonk') has
 *     solInPool, tokensInPool, newTokenBalance and no bondingCurveKey / vSolInBondingCurve.
 *   migrate: signature, mint, txType, pool ('pump-amm').
 *   message: {message} (subscribe acks, and the trade-subscription refusal without a funded key).
 *   buy / sell (documented trade shape, needs a key): signature, mint, traderPublicKey, txType, tokenAmount,
 *     solAmount, newTokenBalance, bondingCurveKey, vTokensInBondingCurve, vSolInBondingCurve, marketCapSol, pool.
 */
export function parsePumpMessage(raw: unknown): PumpEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.message === 'string' && m.txType === undefined) return { kind: 'message', text: m.message.slice(0, 300) };
  const txType = m.txType;
  if (txType !== 'create' && txType !== 'migrate' && txType !== 'buy' && txType !== 'sell') return null;
  if (!isTradableMint(m.mint)) return null;
  const mint = m.mint;
  if (txType === 'migrate') return { kind: 'migrate', mint, pool: pool(m.pool) };
  if (txType === 'create') {
    return {
      kind: 'create', mint, creator: address(m.traderPublicKey), pool: pool(m.pool),
      name: cleanVendorText(m.name, VENDOR_NAME_MAX), symbol: cleanVendorText(m.symbol, VENDOR_SYMBOL_MAX),
      solAmount: num(m.solAmount), initialBuy: num(m.initialBuy), newTokenBalance: num(m.newTokenBalance),
      vSol: num(m.vSolInBondingCurve), marketCapSol: num(m.marketCapSol),
    };
  }
  return {
    kind: 'trade', mint, side: txType, trader: address(m.traderPublicKey), solAmount: num(m.solAmount),
    tokenAmount: num(m.tokenAmount), newTokenBalance: num(m.newTokenBalance), vSol: num(m.vSolInBondingCurve),
    marketCapSol: num(m.marketCapSol), pool: pool(m.pool),
  };
}

// ---------------------------------------------------------------- flow aggregation (pure)

export interface FlowTrade { atMs: number; side: 'buy' | 'sell'; trader: string | null; sol: number }

export interface FlowState {
  mint: string;
  firstSeenMs: number;
  /** Receive time of the create event (null for a mint first seen by its migration or an open position). */
  tokenCreatedMs: number | null;
  pool: string | null;
  creator: string | null;
  creatorBuySol: number | null;
  creatorSellSol: number;
  creatorSold: boolean;
  /** Trades of the last 15 min, oldest first. */
  trades: FlowTrade[];
  /** First-60-s buyers -> their latest token balance (null = unknown). */
  early: Map<string, number | null>;
  lastMarketCapSol: number | null;
  lastVSol: number | null;
  /** When the current, gap-free trade subscription for this mint began (null = no trade flow). */
  tradeSince: number | null;
  lastEventMs: number;
  dirty: boolean;
}

export interface FlowWindow {
  /** Seconds of the window actually covered by the subscription (< the window length right after it began). */
  coveredS: number;
  buys: number;
  sells: number;
  buySol: number;
  sellSol: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  /** Largest single buyer's share of the window's buy SOL (0-1), null without buys. */
  topBuyerShare: number | null;
}

export interface PumpFlowFacts {
  mint: string;
  pool: string | null;
  creator: string | null;
  tokenCreatedAt: string | null;
  firstSeenAt: string;
  tradeFlow: boolean;
  w1m: FlowWindow | null;
  w5m: FlowWindow | null;
  w15m: FlowWindow | null;
  creatorBuySol: number | null;
  creatorSellSol: number | null;
  creatorSold: boolean | null;
  earlyBuyers: number | null;
  earlyHeldPct: number | null;
  lastMarketCapSol: number | null;
  lastVSol: number | null;
  updatedAt: string;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

export function newFlowState(mint: string, nowMs: number): FlowState {
  return {
    mint, firstSeenMs: nowMs, tokenCreatedMs: null, pool: null, creator: null, creatorBuySol: null, creatorSellSol: 0,
    creatorSold: false, trades: [], early: new Map(), lastMarketCapSol: null, lastVSol: null, tradeSince: null,
    lastEventMs: nowMs, dirty: true,
  };
}

export function applyCreate(s: FlowState, ev: Extract<PumpEvent, { kind: 'create' }>, nowMs: number): void {
  s.tokenCreatedMs ??= nowMs;
  s.pool = ev.pool ?? s.pool;
  s.creator ??= ev.creator;
  if (ev.solAmount !== null) s.creatorBuySol = (s.creatorBuySol ?? 0) + ev.solAmount;
  // The creator's dev buy is the first buy of the token: a first-60-s buyer holding what it bought.
  if (ev.creator) s.early.set(ev.creator, ev.newTokenBalance ?? ev.initialBuy ?? null);
  s.lastMarketCapSol = ev.marketCapSol ?? s.lastMarketCapSol;
  s.lastVSol = ev.vSol ?? s.lastVSol;
  s.lastEventMs = nowMs;
  s.dirty = true;
}

export function pruneTrades(s: FlowState, nowMs: number): void {
  const floor = nowMs - FLOW_RETAIN_MS;
  let drop = 0;
  while (drop < s.trades.length && s.trades[drop]!.atMs <= floor) drop += 1;
  if (s.trades.length - drop > MAX_TRADES_PER_MINT) drop = s.trades.length - MAX_TRADES_PER_MINT;
  if (drop > 0) s.trades.splice(0, drop);
}

export function applyTrade(s: FlowState, ev: Extract<PumpEvent, { kind: 'trade' }>, nowMs: number): void {
  const sol = ev.solAmount ?? 0;
  s.trades.push({ atMs: nowMs, side: ev.side, trader: ev.trader, sol });
  pruneTrades(s, nowMs);
  if (ev.trader && ev.trader === s.creator) {
    if (ev.side === 'buy') s.creatorBuySol = (s.creatorBuySol ?? 0) + sol;
    else {
      s.creatorSellSol += sol;
      s.creatorSold = true;
    }
  }
  if (ev.trader) {
    const early = s.tokenCreatedMs !== null && ev.side === 'buy' && nowMs - s.tokenCreatedMs <= EARLY_BUYER_WINDOW_MS;
    if (early || s.early.has(ev.trader)) s.early.set(ev.trader, ev.newTokenBalance);
  }
  s.pool = ev.pool ?? s.pool;
  s.lastMarketCapSol = ev.marketCapSol ?? s.lastMarketCapSol;
  s.lastVSol = ev.vSol ?? s.lastVSol;
  s.lastEventMs = nowMs;
  s.dirty = true;
}

/** Facts over (now - spanMs, now], only from trades seen since `tradeSince`; null without a trade subscription. */
export function windowFacts(trades: readonly FlowTrade[], nowMs: number, spanMs: number, tradeSince: number | null): FlowWindow | null {
  if (tradeSince === null) return null;
  const since = Math.max(nowMs - spanMs, tradeSince - 1);
  let buys = 0; let sells = 0; let buySol = 0; let sellSol = 0;
  const buyers = new Map<string, number>();
  const sellers = new Set<string>();
  for (const t of trades) {
    if (t.atMs <= since || t.atMs > nowMs) continue;
    if (t.side === 'buy') {
      buys += 1;
      buySol += t.sol;
      if (t.trader) buyers.set(t.trader, (buyers.get(t.trader) ?? 0) + t.sol);
    } else {
      sells += 1;
      sellSol += t.sol;
      if (t.trader) sellers.add(t.trader);
    }
  }
  const top = Math.max(0, ...buyers.values());
  return {
    coveredS: Math.round(Math.max(0, Math.min(spanMs, nowMs - tradeSince)) / 1000),
    buys, sells, buySol: round(buySol, 6), sellSol: round(sellSol, 6),
    uniqueBuyers: buyers.size, uniqueSellers: sellers.size,
    topBuyerShare: buySol > 0 ? round(top / buySol, 4) : null,
  };
}

/**
 * First-60-s buyers: known only when the trade subscription began within 5 s of the create event and never broke
 * since. Held share = their latest balances / the fixed 1e9 launch supply (pump, bonk); null when any balance is
 * unknown or the pool has no fixed supply.
 */
export function earlyFacts(s: FlowState): { earlyBuyers: number | null; earlyHeldPct: number | null } {
  if (s.tradeSince === null || s.tokenCreatedMs === null || s.tradeSince - s.tokenCreatedMs > EARLY_SUBSCRIBE_SLACK_MS) {
    return { earlyBuyers: null, earlyHeldPct: null };
  }
  const balances = [...s.early.values()];
  const known = balances.every((b): b is number => b !== null);
  const supplyKnown = s.pool !== null && FIXED_SUPPLY_POOLS.has(s.pool);
  return {
    earlyBuyers: s.early.size,
    earlyHeldPct: known && supplyKnown ? round((100 * balances.reduce((a, b) => a + (b ?? 0), 0)) / LAUNCH_SUPPLY_TOKENS, 4) : null,
  };
}

export function flowFacts(s: FlowState, nowMs: number): PumpFlowFacts {
  pruneTrades(s, nowMs);
  const tradeFlow = s.tradeSince !== null;
  return {
    mint: s.mint,
    pool: s.pool,
    creator: s.creator,
    tokenCreatedAt: s.tokenCreatedMs === null ? null : new Date(s.tokenCreatedMs).toISOString(),
    firstSeenAt: new Date(s.firstSeenMs).toISOString(),
    tradeFlow,
    w1m: windowFacts(s.trades, nowMs, 60_000, s.tradeSince),
    w5m: windowFacts(s.trades, nowMs, 5 * 60_000, s.tradeSince),
    w15m: windowFacts(s.trades, nowMs, FLOW_RETAIN_MS, s.tradeSince),
    creatorBuySol: s.creator === null || s.creatorBuySol === null ? null : round(s.creatorBuySol, 6),
    // A sell is visible only on the trade stream: without it "did not sell" is unknown, not false.
    creatorSellSol: s.creator !== null && tradeFlow ? round(s.creatorSellSol, 6) : null,
    creatorSold: s.creator !== null && tradeFlow ? s.creatorSold : (s.creatorSold ? true : null),
    ...earlyFacts(s),
    lastMarketCapSol: s.lastMarketCapSol === null ? null : round(s.lastMarketCapSol, 6),
    lastVSol: s.lastVSol === null ? null : round(s.lastVSol, 6),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/** The `floor_pumpportal_flow` row (snake_case keys for jsonb_to_recordset). */
export function toFlowRow(f: PumpFlowFacts): Record<string, unknown> {
  return {
    mint: f.mint, pool: f.pool, creator: f.creator, token_created_at: f.tokenCreatedAt, first_seen_at: f.firstSeenAt,
    trade_flow: f.tradeFlow, w1m: f.w1m, w5m: f.w5m, w15m: f.w15m, creator_buy_sol: f.creatorBuySol,
    creator_sell_sol: f.creatorSellSol, creator_sold: f.creatorSold, early_buyers: f.earlyBuyers,
    early_held_pct: f.earlyHeldPct, last_market_cap_sol: f.lastMarketCapSol, last_v_sol: f.lastVSol, updated_at: f.updatedAt,
  };
}

// ---------------------------------------------------------------- watch set (pure)

export type WatchReason = 'new' | 'migration' | 'position';
export interface WatchEntry { addedMs: number; untilMs: number; reason: WatchReason }

/**
 * Adds or extends a watch. An extension never goes past `addedMs + LONG_WATCH_MS` (2 h). Over the cap, the oldest
 * watch goes first, positions last. Returns whether the mint is newly watched and the evicted mints.
 */
export function watchMint(
  watch: Map<string, WatchEntry>, mint: string, reason: WatchReason, ttlMs: number, nowMs: number, cap = WATCH_CAP,
): { added: boolean; evicted: string[] } {
  const prior = watch.get(mint);
  if (prior) {
    prior.untilMs = Math.max(prior.untilMs, Math.min(prior.addedMs + LONG_WATCH_MS, nowMs + ttlMs));
    if (reason !== 'new') prior.reason = reason;
    return { added: false, evicted: [] };
  }
  watch.set(mint, { addedMs: nowMs, untilMs: nowMs + Math.min(ttlMs, LONG_WATCH_MS), reason });
  const evicted: string[] = [];
  while (watch.size > cap) {
    // Map order = insertion order = addedMs order.
    let victim: string | null = null;
    for (const [key, entry] of watch) {
      if (key === mint) continue;
      if (entry.reason !== 'position') { victim = key; break; }
      victim ??= key;
    }
    if (victim === null) break;
    watch.delete(victim);
    evicted.push(victim);
  }
  return { added: true, evicted };
}

export function expireWatches(watch: Map<string, WatchEntry>, nowMs: number): string[] {
  const expired: string[] = [];
  for (const [mint, entry] of watch) if (entry.untilMs <= nowMs) expired.push(mint);
  for (const mint of expired) watch.delete(mint);
  return expired;
}

export function reconnectDelayMs(attempts: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 10));
}

// ---------------------------------------------------------------- the feed

/** The subset of the WHATWG WebSocket the feed uses (Bun's global WebSocket satisfies it). */
export interface FeedSocket {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

type ArenaDatabase = Pick<typeof db, 'execute'>;

export interface PumpPortalFeedDeps {
  env?: Record<string, string | undefined>;
  createSocket?: (url: string) => FeedSocket;
  clock?: () => number;
  random?: () => number;
  database?: ArenaDatabase;
  upsert?: (sightings: Sighting[], now: Date) => Promise<unknown>;
  /** Open-position mints (default: floor_arena_positions status 'open'). */
  openPositionMints?: () => Promise<string[]>;
  /** The lease watchdog; tests pass false and call `checkLease` by hand. */
  watchdog?: boolean;
}

export interface PumpPortalStatus {
  enabled: boolean;
  connected: boolean;
  keyConfigured: boolean;
  tradeFlow: boolean;
  tradeRefused: boolean;
  watched: number;
  creates: number;
  migrations: number;
  trades: number;
  reconnects: number;
  parseErrors: number;
  lastNotice: string | null;
  sightingsFlushed: number;
  flowRowsFlushed: number;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result as Array<Record<string, unknown>> : ((result as { rows?: Array<Record<string, unknown>> })?.rows ?? []);
}

export class PumpPortalFeed {
  private socket: FeedSocket | null = null;
  private open = false;
  private generation = 0;
  private attempts = 0;
  private nextConnectAtMs = 0;
  private lastMessageAtMs = 0;
  private connectStartedMs = 0;
  private lastTickAtMs = 0;
  private tradeRefused = false;
  private ticks = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private pending: Sighting[] = [];
  readonly watch = new Map<string, WatchEntry>();
  readonly states = new Map<string, FlowState>();
  private readonly counters = { creates: 0, migrations: 0, trades: 0, reconnects: 0, parseErrors: 0 };
  private lastNotice: string | null = null;
  private readonly env: Record<string, string | undefined>;
  private readonly clock: () => number;
  private readonly random: () => number;

  constructor(private readonly deps: PumpPortalFeedDeps = {}) {
    this.env = deps.env ?? process.env;
    this.clock = deps.clock ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  private get apiKey(): string | null {
    return pumpPortalApiKey(this.env);
  }

  get connected(): boolean {
    return this.open;
  }

  /** Trade subscriptions are live on this connection. */
  get tradeActive(): boolean {
    return this.open && this.apiKey !== null && !this.tradeRefused;
  }

  status(enabled = pumpPortalEnabled(this.env), flushed = { sightings: 0, flows: 0 }): PumpPortalStatus {
    return {
      enabled, connected: this.open, keyConfigured: this.apiKey !== null, tradeFlow: this.tradeActive,
      tradeRefused: this.tradeRefused, watched: this.watch.size, ...this.counters, lastNotice: this.lastNotice,
      sightingsFlushed: flushed.sightings, flowRowsFlushed: flushed.flows,
    };
  }

  facts(mint: string, nowMs: number): PumpFlowFacts | null {
    const s = this.states.get(mint);
    return s ? flowFacts(s, nowMs) : null;
  }

  // ---- socket lifecycle

  private connect(nowMs: number): void {
    const generation = ++this.generation;
    let sock: FeedSocket;
    try {
      sock = (this.deps.createSocket ?? ((url: string) => new WebSocket(url) as unknown as FeedSocket))(pumpPortalUrl(this.apiKey));
    } catch (error) {
      this.noteNotice(error instanceof Error ? error.message : String(error));
      this.drop(generation, nowMs);
      return;
    }
    this.socket = sock;
    this.open = false;
    this.connectStartedMs = nowMs;
    sock.onopen = () => {
      if (generation !== this.generation) return;
      const at = this.clock();
      this.open = true;
      this.attempts = 0;
      this.lastMessageAtMs = at;
      this.tradeRefused = false;
      this.send({ method: 'subscribeNewToken' });
      this.send({ method: 'subscribeMigration' });
      this.subscribeTrades([...this.watch.keys()], at);
    };
    sock.onmessage = (ev) => {
      if (generation !== this.generation) return;
      const at = this.clock();
      this.lastMessageAtMs = at;
      this.handleFrame(ev.data, at);
    };
    sock.onclose = () => this.drop(generation, this.clock());
    sock.onerror = () => this.drop(generation, this.clock());
  }

  /** Socket gone (close, error, stale): forget it and schedule a reconnect with backoff + jitter. */
  private drop(generation: number, nowMs: number): void {
    if (generation !== this.generation) return;
    this.generation += 1;
    const sock = this.socket;
    this.socket = null;
    this.open = false;
    for (const s of this.states.values()) s.tradeSince = null;
    try { sock?.close(); } catch { /* already closed */ }
    this.attempts += 1;
    this.counters.reconnects += 1;
    const factor = 0.8 + this.random() * 0.4;
    this.nextConnectAtMs = nowMs + Math.round(reconnectDelayMs(this.attempts) * factor);
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || !this.open) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (error) {
      this.noteNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private subscribeTrades(mints: readonly string[], nowMs: number): void {
    if (!this.tradeActive || mints.length === 0) return;
    for (let i = 0; i < mints.length; i += SUBSCRIBE_CHUNK) {
      this.send({ method: 'subscribeTokenTrade', keys: mints.slice(i, i + SUBSCRIBE_CHUNK) });
    }
    for (const mint of mints) {
      const s = this.states.get(mint);
      if (s && s.tradeSince === null) s.tradeSince = nowMs;
    }
  }

  private unsubscribeTrades(mints: readonly string[]): void {
    if (!this.tradeActive || mints.length === 0) return;
    for (let i = 0; i < mints.length; i += SUBSCRIBE_CHUNK) {
      this.send({ method: 'unsubscribeTokenTrade', keys: mints.slice(i, i + SUBSCRIBE_CHUNK) });
    }
  }

  private noteNotice(text: string): void {
    this.lastNotice = redactPumpPortalText(text, this.apiKey).slice(0, 200);
  }

  /** Closes the socket and forgets every watch (a new leadership term starts fresh). */
  shutdown(): void {
    this.generation += 1;
    const sock = this.socket;
    this.socket = null;
    this.open = false;
    try { sock?.close(); } catch { /* already closed */ }
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    this.watch.clear();
    this.states.clear();
    this.pending = [];
    this.attempts = 0;
    this.nextConnectAtMs = 0;
  }

  /** Lease: no leader tick for 45 s -> this process is no longer the leader; close the one socket. */
  checkLease(nowMs: number = this.clock()): boolean {
    if ((this.socket || this.watch.size > 0) && nowMs - this.lastTickAtMs > LEADER_LEASE_MS) {
      this.shutdown();
      return false;
    }
    return true;
  }

  // ---- events

  handleFrame(data: unknown, nowMs: number): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      this.counters.parseErrors += 1;
      return;
    }
    const ev = parsePumpMessage(parsed);
    if (!ev) return;
    if (ev.kind === 'message') {
      if (TRADE_KEY_REFUSAL_RE.test(ev.text)) {
        this.tradeRefused = true;
        for (const s of this.states.values()) s.tradeSince = null;
      }
      this.noteNotice(ev.text);
      return;
    }
    if (ev.kind === 'create') {
      this.counters.creates += 1;
      this.queueSighting({ mint: ev.mint, source: 'pumpportal:new', symbol: ev.symbol, name: ev.name });
      const state = this.ensureWatched(ev.mint, 'new', NEW_MINT_WATCH_MS, nowMs);
      if (state) applyCreate(state, ev, nowMs);
      return;
    }
    if (ev.kind === 'migrate') {
      this.counters.migrations += 1;
      this.queueSighting({ mint: ev.mint, source: 'pumpportal:migration', symbol: null, name: null });
      const state = this.ensureWatched(ev.mint, 'migration', LONG_WATCH_MS, nowMs);
      if (state) {
        state.pool = ev.pool ?? state.pool;
        state.dirty = true;
      }
      return;
    }
    const state = this.states.get(ev.mint);
    if (!state) return;
    this.counters.trades += 1;
    applyTrade(state, ev, nowMs);
  }

  private queueSighting(sighting: Sighting): void {
    if (this.pending.length >= MAX_PENDING_SIGHTINGS) this.pending.shift();
    this.pending.push(sighting);
  }

  private ensureWatched(mint: string, reason: WatchReason, ttlMs: number, nowMs: number): FlowState | null {
    const { added, evicted } = watchMint(this.watch, mint, reason, ttlMs, nowMs);
    this.forget(evicted);
    if (!this.watch.has(mint)) return null;
    let state = this.states.get(mint);
    if (!state) {
      state = newFlowState(mint, nowMs);
      this.states.set(mint, state);
    }
    if (added) this.subscribeTrades([mint], nowMs);
    return state;
  }

  private forget(mints: readonly string[]): void {
    if (mints.length === 0) return;
    this.unsubscribeTrades(mints);
    for (const mint of mints) this.states.delete(mint);
  }

  // ---- the leader tick

  async tick(now: Date): Promise<PumpPortalStatus> {
    const nowMs = now.getTime();
    this.lastTickAtMs = Math.max(nowMs, this.clock());
    if (!pumpPortalEnabled(this.env)) {
      this.shutdown();
      return this.status(false);
    }
    this.ticks += 1;
    if (this.deps.watchdog !== false && !this.watchdogTimer) {
      this.watchdogTimer = setInterval(() => { this.checkLease(); }, 10_000);
      this.watchdogTimer.unref?.();
    }
    if (!this.socket && nowMs >= this.nextConnectAtMs) this.connect(nowMs);
    else if (this.socket && this.open && nowMs - this.lastMessageAtMs > STALE_SOCKET_MS) {
      this.noteNotice('stale socket: no message for 90 s');
      this.drop(this.generation, nowMs);
    } else if (this.socket && !this.open && nowMs - this.connectStartedMs > CONNECT_TIMEOUT_MS) {
      this.noteNotice('connect timeout');
      this.drop(this.generation, nowMs);
    }
    this.forget(expireWatches(this.watch, nowMs));
    if (this.ticks % POSITION_REFRESH_EVERY_TICKS === 1) await this.refreshPositionWatches(nowMs);

    let sightings = 0;
    if (this.pending.length > 0) {
      const batch = this.pending;
      this.pending = [];
      const merged = mergeSightings(batch);
      await (this.deps.upsert ?? ((s: Sighting[], at: Date) => upsertSightings(mergeSightings(s), at)))(batch, now);
      sightings = merged.length;
    }
    const flows = await this.flushFlows(nowMs);
    if (this.ticks % PRUNE_EVERY_TICKS === 0) {
      await (this.deps.database ?? db).execute(sql`
        DELETE FROM floor_pumpportal_flow WHERE updated_at < ${new Date(nowMs - FLOW_ROW_TTL_MS).toISOString()}::timestamptz
      `);
    }
    return this.status(true, { sightings, flows });
  }

  /** pump.fun mints (vanity suffix `pump`) with an open arena position stay watched up to 2 h. */
  private async refreshPositionWatches(nowMs: number): Promise<void> {
    const mints = this.deps.openPositionMints
      ? await this.deps.openPositionMints()
      : rowsOf(await (this.deps.database ?? db).execute(sql`
          SELECT DISTINCT mint FROM floor_arena_positions WHERE status = 'open'
        `)).map((row) => String(row.mint));
    for (const mint of mints) {
      if (!isTradableMint(mint)) continue;
      if (this.watch.has(mint) || mint.endsWith('pump')) this.ensureWatched(mint, 'position', LONG_WATCH_MS, nowMs);
    }
  }

  /** Upserts the facts of every watched mint that changed or still has trades inside the 15-min window. */
  private async flushFlows(nowMs: number): Promise<number> {
    const rows: Array<Record<string, unknown>> = [];
    for (const s of this.states.values()) {
      if (!s.dirty && nowMs - s.lastEventMs > FLOW_RETAIN_MS + PUMPPORTAL_TICK_MS) continue;
      rows.push(toFlowRow(flowFacts(s, nowMs)));
      s.dirty = false;
    }
    if (rows.length === 0) return 0;
    rows.sort((a, b) => (String(a.mint) < String(b.mint) ? -1 : 1));
    await (this.deps.database ?? db).execute(sql`
      INSERT INTO floor_pumpportal_flow (mint, pool, creator, token_created_at, first_seen_at, trade_flow, w1m, w5m, w15m,
        creator_buy_sol, creator_sell_sol, creator_sold, early_buyers, early_held_pct, last_market_cap_sol, last_v_sol, updated_at)
      SELECT r.mint, r.pool, r.creator, r.token_created_at, r.first_seen_at, r.trade_flow, r.w1m, r.w5m, r.w15m,
        r.creator_buy_sol, r.creator_sell_sol, r.creator_sold, r.early_buyers, r.early_held_pct, r.last_market_cap_sol,
        r.last_v_sol, r.updated_at
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(mint text, pool text, creator text,
        token_created_at timestamptz, first_seen_at timestamptz, trade_flow boolean, w1m jsonb, w5m jsonb, w15m jsonb,
        creator_buy_sol double precision, creator_sell_sol double precision, creator_sold boolean, early_buyers integer,
        early_held_pct double precision, last_market_cap_sol double precision, last_v_sol double precision,
        updated_at timestamptz)
      ORDER BY r.mint COLLATE "C"
      ON CONFLICT (mint) DO UPDATE SET
        pool = COALESCE(EXCLUDED.pool, floor_pumpportal_flow.pool),
        creator = COALESCE(floor_pumpportal_flow.creator, EXCLUDED.creator),
        token_created_at = COALESCE(floor_pumpportal_flow.token_created_at, EXCLUDED.token_created_at),
        first_seen_at = LEAST(floor_pumpportal_flow.first_seen_at, EXCLUDED.first_seen_at),
        trade_flow = EXCLUDED.trade_flow, w1m = EXCLUDED.w1m, w5m = EXCLUDED.w5m, w15m = EXCLUDED.w15m,
        creator_buy_sol = EXCLUDED.creator_buy_sol, creator_sell_sol = EXCLUDED.creator_sell_sol,
        creator_sold = EXCLUDED.creator_sold, early_buyers = EXCLUDED.early_buyers,
        early_held_pct = EXCLUDED.early_held_pct, last_market_cap_sol = EXCLUDED.last_market_cap_sol,
        last_v_sol = EXCLUDED.last_v_sol, updated_at = EXCLUDED.updated_at
    `);
    return rows.length;
  }
}

// ---------------------------------------------------------------- process singleton

let feed: PumpPortalFeed | null = null;

/** The leader loop body (index.ts, every 15 s). */
export async function runPumpPortalTick(now: Date = new Date()): Promise<PumpPortalStatus> {
  feed ??= new PumpPortalFeed();
  return feed.tick(now);
}

/**
 * The in-memory flow facts of a watched mint, for `entry_features.pumpFlow` (DATA ONLY; null when the feed does not
 * watch the mint). Entries and the feed both run on the leader, so this is the same state the flush writes.
 */
export function pumpFlowForMint(mint: string, nowMs: number = Date.now()): PumpFlowFacts | null {
  return feed?.facts(mint, nowMs) ?? null;
}

export function resetPumpPortalFeedForTest(): void {
  feed?.shutdown();
  feed = null;
}
