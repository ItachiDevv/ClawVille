/**
 * Database canary watchdog.
 *
 * A shared-pool probe distinguishes a wedged postgres.js pool from a real
 * database outage by retrying through a fresh one-connection client. Repeated
 * pool wedges crash the API loudly so the container restarts with a fresh pool;
 * database outages alert but never crash-loop.
 */

import { db, sql as drizzleSql } from '@clawville/database';
import postgres from 'postgres';
import { alertError, type AlertErrorParams } from './alert-error';
import { getDriverLivenessSnapshot } from './agent-autonomy-driver';

const PROBE_DEADLINE_MS = 10_000;
const EXIT_GRACE_MS = 1_000;
const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 10_000;
const DEFAULT_EXIT_THRESHOLD = 8;
const DEFAULT_DRIVER_STALL_MS = 300_000;

const SOURCE = 'db-canary';
const POOL_WEDGED_MESSAGE = 'DB pool wedged — restarting api';
const DB_DOWN_MESSAGE = 'Database unavailable — fresh connection probe failed';
const DRIVER_STALLED_MESSAGE = 'Agent autonomy driver stalled';

export interface DbCanaryFreshClient {
  probe(): Promise<void>;
  end(options: { timeout: number }): Promise<void>;
}

export type DbCanaryOutcome = 'healthy' | 'pool-wedge' | 'db-down' | 'error';

export interface DbCanaryTickResult {
  outcome: DbCanaryOutcome;
  consecutivePoolWedges: number;
}

type IntervalHandle = ReturnType<typeof setInterval>;

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`operation exceeded ${timeoutMs}ms deadline`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function openFreshClient(url: string): DbCanaryFreshClient {
  const client = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
  });
  return {
    probe: async () => {
      await client`select 1`;
    },
    end: async (options) => {
      await client.end(options);
    },
  };
}

export const dbCanarySeams = {
  probeShared: async (): Promise<void> => {
    await db.execute(drizzleSql`select 1`);
  },
  openFreshClient,
  deadline: withDeadline,
  alert: alertError,
  driverLiveness: getDriverLivenessSnapshot,
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  exit: (code: number): void => process.exit(code),
  setInterval: (callback: () => void, ms: number): IntervalHandle =>
    setInterval(callback, ms),
  clearInterval: (handle: IntervalHandle): void => clearInterval(handle),
};

let sharedProbeInFlight: Promise<void> | null = null;
let consecutivePoolWedges = 0;
let interval: IntervalHandle | null = null;
let scheduledTickInFlight: Promise<DbCanaryTickResult> | null = null;
let exitScheduled = false;
let monitoringStartedAt: number | null = null;

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveDbCanaryIntervalMs(
  raw: string | undefined = process.env.DB_CANARY_INTERVAL_MS,
): number {
  return Math.max(MIN_INTERVAL_MS, resolvePositiveInt(raw, DEFAULT_INTERVAL_MS));
}

export function resolveDbCanaryExitThreshold(
  raw: string | undefined = process.env.DB_CANARY_EXIT_THRESHOLD,
): number {
  return Math.max(1, resolvePositiveInt(raw, DEFAULT_EXIT_THRESHOLD));
}

export function resolveDbCanaryExitEnabled(
  raw: string | undefined = process.env.DB_CANARY_EXIT,
): boolean {
  return raw?.trim().toLowerCase() !== 'false';
}

export function resolveDbCanaryDriverStallMs(
  raw: string | undefined = process.env.DB_CANARY_DRIVER_STALL_MS,
): number {
  return resolvePositiveInt(raw, DEFAULT_DRIVER_STALL_MS);
}

function getSharedProbe(): Promise<void> {
  if (sharedProbeInFlight) return sharedProbeInFlight;

  const probe = Promise.resolve().then(() => dbCanarySeams.probeShared());
  sharedProbeInFlight = probe;
  const clear = () => {
    if (sharedProbeInFlight === probe) sharedProbeInFlight = null;
  };
  // Attach both handlers immediately: a probe that rejects after losing its
  // deadline race is still observed, and a permanently hung probe stays reused.
  void probe.then(clear, clear);
  return probe;
}

async function sharedProbeSucceeded(): Promise<boolean> {
  try {
    await dbCanarySeams.deadline(getSharedProbe(), PROBE_DEADLINE_MS);
    return true;
  } catch {
    return false;
  }
}

async function freshProbeSucceeded(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) return false;

  let client: DbCanaryFreshClient;
  try {
    client = dbCanarySeams.openFreshClient(url);
  } catch {
    return false;
  }

  let succeeded = false;
  try {
    await dbCanarySeams.deadline(client.probe(), PROBE_DEADLINE_MS);
    succeeded = true;
  } catch {
    succeeded = false;
  } finally {
    try {
      await client.end({ timeout: 1 });
    } catch {
      // Cleanup failure does not change the already-observed probe result.
      console.warn('[DbCanary] fresh probe client cleanup failed');
    }
  }
  return succeeded;
}

function sendAlert(params: AlertErrorParams): void {
  void Promise.resolve()
    .then(() => dbCanarySeams.alert(params))
    .catch(() => {});
}

function checkDriverLiveness(now: number): void {
  try {
    const snapshot = dbCanarySeams.driverLiveness();
    if (snapshot.enrolledCount === 0) return;

    const baseline = snapshot.lastTickAt ?? monitoringStartedAt ?? now;
    if (now - baseline < resolveDbCanaryDriverStallMs()) return;

    sendAlert({
      severity: 'warning',
      source: SOURCE,
      message: DRIVER_STALLED_MESSAGE,
      context: {
        enrolledCount: snapshot.enrolledCount,
        lastTickAt: snapshot.lastTickAt,
      },
    });
  } catch {
    // The DB probe remains authoritative even if the optional liveness seam fails.
  }
}

async function handlePoolWedge(): Promise<void> {
  consecutivePoolWedges += 1;
  if (consecutivePoolWedges < resolveDbCanaryExitThreshold()) return;

  sendAlert({
    severity: 'critical',
    source: SOURCE,
    message: POOL_WEDGED_MESSAGE,
    context: { consecutivePoolWedges },
  });

  if (!resolveDbCanaryExitEnabled() || exitScheduled) return;
  exitScheduled = true;
  try {
    await dbCanarySeams.sleep(EXIT_GRACE_MS);
  } catch {
    // Exit remains the recovery path even if the grace timer seam fails.
  }
  try {
    dbCanarySeams.exit(1);
  } catch {
    // Tests inject a throwing exit; the canary tick itself must never reject.
  }
}

/** One fully-contained canary tick. This function never rejects. */
export async function runDbCanaryTick(): Promise<DbCanaryTickResult> {
  try {
    const now = dbCanarySeams.now();
    if (monitoringStartedAt === null) monitoringStartedAt = now;
    checkDriverLiveness(now);

    if (await sharedProbeSucceeded()) {
      consecutivePoolWedges = 0;
      exitScheduled = false;
      return { outcome: 'healthy', consecutivePoolWedges };
    }

    if (await freshProbeSucceeded()) {
      await handlePoolWedge();
      return { outcome: 'pool-wedge', consecutivePoolWedges };
    }

    // A real DB outage breaks the consecutive pool-wedge streak. Restarting the
    // API cannot heal it, so alert only and deliberately never exit.
    consecutivePoolWedges = 0;
    exitScheduled = false;
    sendAlert({
      severity: 'critical',
      source: SOURCE,
      message: DB_DOWN_MESSAGE,
    });
    return { outcome: 'db-down', consecutivePoolWedges };
  } catch {
    return { outcome: 'error', consecutivePoolWedges };
  }
}

function runScheduledTick(): void {
  if (scheduledTickInFlight) return;
  const tick = runDbCanaryTick();
  scheduledTickInFlight = tick;
  void tick.finally(() => {
    if (scheduledTickInFlight === tick) scheduledTickInFlight = null;
  });
}

export function startDbCanary(): void {
  if (interval) return;
  monitoringStartedAt = dbCanarySeams.now();
  const intervalMs = resolveDbCanaryIntervalMs();
  interval = dbCanarySeams.setInterval(runScheduledTick, intervalMs);
  console.log(`[DbCanary] started — probing every ${intervalMs}ms`);
}

export function stopDbCanary(): void {
  if (interval) {
    dbCanarySeams.clearInterval(interval);
    interval = null;
  }
  sharedProbeInFlight = null;
  consecutivePoolWedges = 0;
  exitScheduled = false;
  monitoringStartedAt = null;
}
