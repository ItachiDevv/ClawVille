/**
 * Durable special-event completion reconciler.
 *
 * TournamentManager notifies the parent event immediately after a tournament
 * commits completion. That callback is deliberately fail-soft so a transient
 * parent-write failure never rolls back poker prizes. This worker is the durable
 * retry path: at boot and on a bounded interval it finds completed linked poker
 * tournaments whose parent is still live, then replays the exact-id idempotent
 * transition.
 *
 * Only LIVE parents are candidates. Draft, signup-open, cancelled, and already
 * completed events are never revived or rewritten by this recovery process.
 */

import { db as realDb } from '@clawville/database';
import { sql } from 'drizzle-orm';
import { specialEventManager as realSpecialEventManager } from './special-event-manager';

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 50;

/** Awaitable execute-only seam; Drizzle's real PgRaw is thenable, not Promise. */
interface WorkerDb {
  execute(query: ReturnType<typeof sql>): PromiseLike<unknown> | unknown;
}
type SettlementManager = Pick<typeof realSpecialEventManager, 'settleEventForTournament'>;

export interface SpecialEventSettlementWorkerDeps {
  db?: WorkerDb;
  manager?: SettlementManager;
  pollMs?: number;
  batchSize?: number;
  logError?: (message: string, error: unknown) => void;
}

export interface SpecialEventSettlementPassResult {
  scanned: number;
  reconciled: number;
  failed: number;
  skippedOverlap: boolean;
}

/**
 * One instance owns one overlap guard + timer. The injectable seams keep worker
 * behavior deterministic in unit tests without mutating process globals.
 */
export class SpecialEventSettlementWorker {
  private readonly db: WorkerDb;
  private readonly manager: SettlementManager;
  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly logError: (message: string, error: unknown) => void;
  private interval: ReturnType<typeof setInterval> | null = null;
  private passRunning = false;

  constructor(deps: SpecialEventSettlementWorkerDeps = {}) {
    this.db = deps.db ?? realDb;
    this.manager = deps.manager ?? realSpecialEventManager;
    this.pollMs = Math.max(1_000, Math.floor(deps.pollMs ?? DEFAULT_POLL_MS));
    this.batchSize = Math.max(1, Math.min(500, Math.floor(deps.batchSize ?? DEFAULT_BATCH_SIZE)));
    this.logError = deps.logError ?? ((message, error) => console.error(message, error));
  }

  isStarted(): boolean {
    return this.interval !== null;
  }

  /**
   * Run one oldest-first bounded pass. Each row is isolated so one bad event
   * cannot starve later candidates; failures remain live and retry next pass.
   */
  async runOnce(): Promise<SpecialEventSettlementPassResult> {
    if (this.passRunning) {
      return { scanned: 0, reconciled: 0, failed: 0, skippedOverlap: true };
    }

    this.passRunning = true;
    try {
      let candidates: Array<{ tournament_id: string }>;
      try {
        const rows = await this.db.execute(
          sql`SELECT t.id AS tournament_id
              FROM poker_tournaments t
              JOIN special_events e ON e.id = t.special_event_id
              WHERE t.status = 'completed'
                AND e.status = 'live'
              ORDER BY COALESCE(t.settled_at, t.created_at) ASC, t.id ASC
              LIMIT ${this.batchSize}`,
        );
        candidates = Array.from(rows as Iterable<{ tournament_id: string }>);
      } catch (error) {
        this.logError('[SpecialEventSettlementWorker] candidate scan failed (non-fatal):', error);
        return { scanned: 0, reconciled: 0, failed: 1, skippedOverlap: false };
      }

      let reconciled = 0;
      let failed = 0;
      for (const candidate of candidates) {
        try {
          await this.manager.settleEventForTournament(candidate.tournament_id);
          reconciled++;
        } catch (error) {
          failed++;
          this.logError(
            `[SpecialEventSettlementWorker] tournament ${candidate.tournament_id} failed (non-fatal):`,
            error,
          );
        }
      }

      return {
        scanned: candidates.length,
        reconciled,
        failed,
        skippedOverlap: false,
      };
    } finally {
      this.passRunning = false;
    }
  }

  /** Start once, immediately reconcile boot-time misses, then poll periodically. */
  async start(): Promise<void> {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.runOnce();
    }, this.pollMs);
    this.interval.unref?.();
    await this.runOnce();
  }

  /** Graceful-shutdown stop. The current bounded pass may finish; no new pass starts. */
  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }
}

export const specialEventSettlementWorker = new SpecialEventSettlementWorker();

export async function startSpecialEventSettlementWorker(): Promise<void> {
  await specialEventSettlementWorker.start();
}

export function stopSpecialEventSettlementWorker(): void {
  specialEventSettlementWorker.stop();
}
