import postgres from 'postgres';

/**
 * Leader election for the arena engine (docs/trading-floor-arena.md D1). Two API containers run side by side
 * during a deploy flip; only the one holding a SESSION advisory lock runs the loops.
 *
 * The lock lives on a dedicated one-connection postgres.js client (the db-canary pattern) with no idle
 * timeout and no max lifetime, so the pool never recycles the session that holds it. Every 30 s the leader
 * asks pg_locks whether ITS backend still holds the lock: after a dropped connection postgres.js reconnects
 * silently on a new backend, the check reads false, and the leader steps down before it re-competes.
 * The self-hosted `clawville-db` is reached directly (no transaction pooler), so session locks are sound.
 */

/** Two-int key: classid = 'FARE' (0x46415245), objid = 1. Visible in pg_locks with objsubid = 2. */
export const FLOOR_ARENA_LOCK_CLASS = 0x46415245;
export const FLOOR_ARENA_LOCK_OBJECT = 1;
export const LEADER_CHECK_INTERVAL_MS = 30_000;

export interface LeaderLock {
  tryAcquire(): Promise<boolean>;
  stillHeld(): Promise<boolean>;
  release(): Promise<void>;
  close(): Promise<void>;
}

export function createPgLeaderLock(url: string): LeaderLock {
  const client = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    max_lifetime: null,
    keep_alive: 30,
  });
  return {
    async tryAcquire() {
      const rows = await client`SELECT pg_try_advisory_lock(${FLOOR_ARENA_LOCK_CLASS}::int4, ${FLOOR_ARENA_LOCK_OBJECT}::int4) AS acquired`;
      return rows[0]?.acquired === true;
    },
    async stillHeld() {
      const rows = await client`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
            AND classid = ${FLOOR_ARENA_LOCK_CLASS}::oid AND objid = ${FLOOR_ARENA_LOCK_OBJECT}::oid AND objsubid = 2
        ) AS held`;
      return rows[0]?.held === true;
    },
    async release() {
      await client`SELECT pg_advisory_unlock(${FLOOR_ARENA_LOCK_CLASS}::int4, ${FLOOR_ARENA_LOCK_OBJECT}::int4)`;
    },
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

export interface LeaderElectorOptions {
  lock: LeaderLock;
  onElected: () => Promise<void> | void;
  onDemoted: () => Promise<void> | void;
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string) => void;
}

export class LeaderElector {
  private leader = false;
  private stopped = true;
  private timer: unknown = null;
  private checking: Promise<void> | null = null;
  private readonly intervalMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: LeaderElectorOptions) {
    this.intervalMs = opts.intervalMs ?? LEADER_CHECK_INTERVAL_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.log = opts.log ?? ((message) => console.log(`[floor-arena] ${message}`));
  }

  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  /** One election round; rounds never overlap. Exposed for tests. */
  checkNow(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = this.round().finally(() => { this.checking = null; });
    return this.checking;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.checking) await this.checking.catch(() => undefined);
    if (this.leader) {
      this.leader = false;
      await this.safe(() => this.opts.onDemoted(), 'demote on stop failed');
      await this.safe(() => this.opts.lock.release(), 'lock release failed');
      this.log('leader lock released');
    }
    await this.safe(() => this.opts.lock.close(), 'lock connection close failed');
  }

  private async tick(): Promise<void> {
    await this.checkNow();
    if (this.stopped) return;
    this.timer = this.setTimer(() => { void this.tick(); }, this.intervalMs);
  }

  private async round(): Promise<void> {
    if (this.stopped) return;
    if (this.leader) {
      const held = await this.opts.lock.stillHeld().catch(() => false);
      if (held) return;
      this.leader = false;
      this.log('leader lock lost; stopping loops');
      await this.safe(() => this.opts.onDemoted(), 'demote failed');
    }
    if (this.stopped) return;
    const acquired = await this.opts.lock.tryAcquire().catch(() => false);
    if (!acquired || this.stopped) {
      if (acquired) await this.safe(() => this.opts.lock.release(), 'lock release failed');
      return;
    }
    this.leader = true;
    this.log('leader lock acquired; starting loops');
    await this.safe(() => this.opts.onElected(), 'elected hook failed');
  }

  private async safe(fn: () => Promise<void> | void, message: string): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.log(`${message}: ${error instanceof Error ? error.message.slice(0, 200) : 'error'}`);
    }
  }
}
