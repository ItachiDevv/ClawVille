import { shouldAlertTradingLoop } from '../trading-rpc';
import { runArenaAddonsTick } from './addons';
import { runArenaAnalysisTick } from './analysis';
import { runChainCheckTick } from './chain-checks';
import { DISCOVERY_SOURCES, runDiscoveryExpiryTick, runDiscoveryPoll, runEnrichmentTick } from './discovery-hub';
import { ensureHouseAgents, entriesPaused, refreshHouseTemplates, runEntryTick, runExitTick, setEntriesPaused } from './engine';
import { pruneArenaEvents } from './events';
import { createPgLeaderLock, LeaderElector } from './leader';
import { clawpumpQuoteBreakerState, currentSolPriceUsd, dexscreenerCallsLastMinute } from './pricing';
import { runArenaProvisioningTick } from './provisioning';

/**
 * Trading Floor Arena engine wiring (docs/trading-floor-arena.md §6). `startFloorArena()` is called from
 * apps/api/src/index.ts; only the leader (advisory lock) runs the loops:
 *   discovery pollers (one per source, 30-60 s, jittered backoff on failure), enrichment 20 s, chain checks 20 s,
 *   entries 15 s, exits 10 s, analysis / add-ons / provisioning 60 s, discovery expiry 5 min, event prune 1 h.
 * Kill switch: FLOOR_ARENA_ENGINE_ENABLED='false'. Admin pause stops NEW entries only (exits keep running).
 */

const MAX_BACKOFF_MS = 10 * 60_000;
const STOP_WAIT_MS = 20_000;

export interface LoopStatus {
  name: string;
  intervalMs: number;
  runs: number;
  errors: number;
  consecutiveErrors: number;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  lastResult: unknown;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, '<url>').replace(/api-key=[^&\s]+/gi, 'api-key=<redacted>').slice(0, 240);
}

/** A self-scheduling loop: no overlap, jittered interval, exponential backoff after failures when asked. */
export class ArenaLoop {
  readonly status: LoopStatus;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private running = false;
  /** Bumped on every start: a tick still in flight from an earlier leadership term never reschedules. */
  private generation = 0;

  constructor(
    name: string,
    private readonly intervalMs: number,
    private readonly run: (now: Date) => Promise<unknown>,
    private readonly opts: { backoff?: boolean; jitter?: number; initialDelayMs?: number } = {},
  ) {
    this.status = {
      name, intervalMs, runs: 0, errors: 0, consecutiveErrors: 0, lastRunAt: null, lastOkAt: null,
      lastErrorAt: null, lastError: null, lastDurationMs: null, lastResult: null,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.schedule(this.opts.initialDelayMs ?? 0, this.generation);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) {
      await Promise.race([this.inFlight, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))]);
    }
  }

  nextDelayMs(): number {
    const jitter = this.opts.jitter ?? 0.1;
    const factor = 1 - jitter + Math.random() * 2 * jitter;
    if (this.opts.backoff && this.status.consecutiveErrors > 0) {
      const backoff = Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** Math.min(this.status.consecutiveErrors, 6));
      return Math.round(backoff * factor);
    }
    return Math.round(this.intervalMs * factor);
  }

  private schedule(delayMs: number, generation: number): void {
    if (!this.running || generation !== this.generation) return;
    this.timer = setTimeout(() => { void this.tick(generation); }, delayMs);
    this.timer.unref?.();
  }

  private async tick(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;
    const started = Date.now();
    const now = new Date(started);
    this.status.lastRunAt = now.toISOString();
    this.status.runs += 1;
    this.inFlight = (async () => {
      try {
        this.status.lastResult = await this.run(now) ?? null;
        this.status.lastOkAt = new Date().toISOString();
        this.status.consecutiveErrors = 0;
      } catch (error) {
        const message = safeMessage(error);
        this.status.errors += 1;
        this.status.consecutiveErrors += 1;
        this.status.lastError = message;
        this.status.lastErrorAt = new Date().toISOString();
        // Once per cause, then at most hourly: fails visible, never a log storm.
        if (shouldAlertTradingLoop(`floor-arena:${this.status.name}:${message.slice(0, 80)}`)) {
          console.warn(`[floor-arena] ${this.status.name} failed: ${message}`);
        }
      } finally {
        this.status.lastDurationMs = Date.now() - started;
      }
    })();
    await this.inFlight;
    this.inFlight = null;
    this.schedule(this.nextDelayMs(), generation);
  }
}

function buildLoops(): ArenaLoop[] {
  const pollers = DISCOVERY_SOURCES.map((source, i) => new ArenaLoop(
    `discovery:${source.id}`, source.intervalMs, (now) => runDiscoveryPoll(source, now),
    { backoff: true, jitter: 0.2, initialDelayMs: i * 1_500 },
  ));
  return [
    ...pollers,
    new ArenaLoop('enrichment', 20_000, runEnrichmentTick, { initialDelayMs: 10_000, jitter: 0.05 }),
    new ArenaLoop('chain-checks', 20_000, (now) => runChainCheckTick(now), { initialDelayMs: 15_000, jitter: 0.05 }),
    new ArenaLoop('entries', 15_000, (now) => runEntryTick(now), { initialDelayMs: 20_000, jitter: 0.05 }),
    new ArenaLoop('exits', 10_000, (now) => runExitTick(now), { initialDelayMs: 5_000, jitter: 0.05 }),
    new ArenaLoop('analysis', 60_000, runArenaAnalysisTick, { initialDelayMs: 30_000 }),
    new ArenaLoop('addons', 60_000, (now) => runArenaAddonsTick(now), { initialDelayMs: 40_000 }),
    new ArenaLoop('provisioning', 60_000, (now) => runArenaProvisioningTick(now), { initialDelayMs: 25_000 }),
    new ArenaLoop('discovery-expiry', 5 * 60_000, runDiscoveryExpiryTick, { initialDelayMs: 60_000 }),
    new ArenaLoop('event-prune', 60 * 60_000, pruneArenaEvents, { initialDelayMs: 120_000 }),
    // D27: house params follow template changes (also run once right after election, below).
    new ArenaLoop('house-templates', 60 * 60_000, refreshHouseTemplates, { initialDelayMs: 60 * 60_000 }),
  ];
}

interface ArenaRuntime {
  elector: LeaderElector;
  loops: ArenaLoop[];
  startedAt: string;
  electedAt: string | null;
  houseAgents: { at: string; inserted: number; templatesReset: number } | { at: string; error: string } | null;
  pausedBy: string | null;
  pausedAt: string | null;
}

let runtime: ArenaRuntime | null = null;
let disabledReason: string | null = null;

export function floorArenaEngineEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FLOOR_ARENA_ENGINE_ENABLED?.trim().toLowerCase() !== 'false';
}

/** Starts leader election; the loops run only while this process holds the lock. Idempotent. */
export function startFloorArena(): void {
  if (runtime) return;
  if (!floorArenaEngineEnabled()) {
    disabledReason = 'FLOOR_ARENA_ENGINE_ENABLED=false';
    console.log('[floor-arena] engine disabled by FLOOR_ARENA_ENGINE_ENABLED=false');
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    disabledReason = 'DATABASE_URL not set';
    console.warn('[floor-arena] engine not started: DATABASE_URL is not set');
    return;
  }
  disabledReason = null;
  const loops = buildLoops();
  const state: ArenaRuntime = {
    loops, startedAt: new Date().toISOString(), electedAt: null, houseAgents: null, pausedBy: null, pausedAt: null,
    elector: new LeaderElector({
      lock: createPgLeaderLock(url),
      onElected: async () => {
        state.electedAt = new Date().toISOString();
        try {
          const inserted = await ensureHouseAgents();
          const templatesReset = await refreshHouseTemplates();
          state.houseAgents = { at: new Date().toISOString(), inserted, templatesReset };
        } catch (error) {
          // The loops still start: existing house rows keep trading; the next election retries the insert.
          state.houseAgents = { at: new Date().toISOString(), error: safeMessage(error) };
          console.warn('[floor-arena] house agent upsert failed:', safeMessage(error));
        }
        for (const loop of loops) loop.start();
      },
      onDemoted: async () => {
        state.electedAt = null;
        await Promise.all(loops.map((loop) => loop.stop()));
      },
    }),
  };
  runtime = state;
  state.elector.start();
}

export async function stopFloorArena(): Promise<void> {
  const current = runtime;
  runtime = null;
  if (!current) return;
  await current.elector.stop();
}

export function pauseFloorArenaEngine(by: string): void {
  setEntriesPaused(true);
  if (runtime) {
    runtime.pausedBy = by.slice(0, 120);
    runtime.pausedAt = new Date().toISOString();
  }
}

export function resumeFloorArenaEngine(_by: string): void {
  setEntriesPaused(false);
  if (runtime) {
    runtime.pausedBy = null;
    runtime.pausedAt = null;
  }
}

export interface FloorArenaEngineState {
  enabled: boolean;
  disabledReason: string | null;
  running: boolean;
  leader: boolean;
  startedAt: string | null;
  electedAt: string | null;
  /** Pause = no new entries on this process (in memory; resets on restart). Exits keep running. */
  entriesPaused: boolean;
  pausedBy: string | null;
  pausedAt: string | null;
  houseAgents: ArenaRuntime['houseAgents'];
  loops: LoopStatus[];
  dexscreenerCallsLastMinute: number;
  clawpumpQuoteBreaker: { open: boolean; failures: number; openUntil: string | null };
  solPriceUsd: number | null;
}

export function getFloorArenaEngineState(now: Date = new Date()): FloorArenaEngineState {
  const breaker = clawpumpQuoteBreakerState(now.getTime());
  return {
    enabled: floorArenaEngineEnabled(),
    disabledReason,
    running: runtime !== null,
    leader: runtime?.elector.isLeader ?? false,
    startedAt: runtime?.startedAt ?? null,
    electedAt: runtime?.electedAt ?? null,
    entriesPaused: entriesPaused(),
    pausedBy: runtime?.pausedBy ?? null,
    pausedAt: runtime?.pausedAt ?? null,
    houseAgents: runtime?.houseAgents ?? null,
    loops: runtime?.loops.map((loop) => ({ ...loop.status })) ?? [],
    dexscreenerCallsLastMinute: dexscreenerCallsLastMinute(now.getTime()),
    clawpumpQuoteBreaker: { open: breaker.open, failures: breaker.failures, openUntil: breaker.openUntil ? new Date(breaker.openUntil).toISOString() : null },
    solPriceUsd: currentSolPriceUsd(now.getTime()),
  };
}

/** Alias used by the admin route. */
export const readFloorArenaEngineState = getFloorArenaEngineState;
