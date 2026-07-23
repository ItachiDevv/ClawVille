/**
 * Default-off recurring x402 reconciliation.
 *
 * The worker runs the shared bulk matcher and applies only verified capture or
 * complete-window, grace-elapsed no-money verdicts. Manual/indeterminate rows
 * remain for the operator CLI.
 */

import { db, sql } from '@clawville/database';
import { sendTelegramText } from './alert-error';
import {
  runBulkReconcileSweep,
  type BulkReconcileResult,
} from './x402-bulk-reconcile';

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_ROWS = 50;
const SURVIVOR_ALERT_MS = 24 * 60 * 60_000;

export interface X402AutoReconcileConfig {
  enabled: boolean;
  intervalMs: number;
  maxRows: number;
}

export interface X402AutoReconcilePassResult {
  enabled: boolean;
  skippedOverlap: boolean;
  skippedLock: boolean;
  sweep: BulkReconcileResult | null;
  alerted: boolean;
}

interface AdvisoryRunResult {
  acquired: boolean;
  sweep?: BulkReconcileResult;
}

export interface X402AutoReconcileDeps {
  runSweep?: typeof runBulkReconcileSweep;
  withAdvisoryLock?: (
    run: () => Promise<BulkReconcileResult>,
  ) => Promise<AdvisoryRunResult>;
  send?: typeof sendTelegramText;
  now?: () => Date;
  logError?: (message: string, error: unknown) => void;
}

function resolveInteger(
  raw: string | undefined,
  fallback: number,
  floor: number,
  ceiling: number,
): number {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= floor
    ? Math.min(parsed, ceiling)
    : fallback;
}

export function resolveX402AutoReconcileConfig(): X402AutoReconcileConfig {
  return {
    enabled: process.env.X402_AUTO_RECONCILE === 'true',
    intervalMs: resolveInteger(
      process.env.X402_AUTO_RECONCILE_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
      MIN_INTERVAL_MS,
      24 * 60 * 60_000,
    ),
    maxRows: resolveInteger(
      process.env.X402_AUTO_RECONCILE_MAX_ROWS,
      DEFAULT_MAX_ROWS,
      1,
      500,
    ),
  };
}

function advisoryBoolean(raw: unknown): boolean {
  const container = raw as {
    rows?: Array<{ acquired?: unknown }>;
    0?: { acquired?: unknown };
  } | Array<{ acquired?: unknown }> | null;
  const first = Array.isArray(container)
    ? container[0]
    : container?.rows?.[0] ?? container?.[0];
  return first?.acquired === true || first?.acquired === 't';
}

async function withDefaultAdvisoryLock(
  run: () => Promise<BulkReconcileResult>,
): Promise<AdvisoryRunResult> {
  return db.transaction(async (tx) => {
    const lockResult = await tx.execute(sql`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended('x402-auto-reconcile', 0)
      ) AS acquired
    `);
    if (!advisoryBoolean(lockResult)) return { acquired: false };
    return { acquired: true, sweep: await run() };
  });
}

let autoPassRunning = false;
let autoInterval: ReturnType<typeof setInterval> | null = null;
let autoGeneration = 0;
let lastManualFingerprint = '';

function manualAlertRows(result: BulkReconcileResult, nowMs: number): string[] {
  return result.verdicts
    .filter((verdict) => {
      if (verdict.bucket === 'manual') return true;
      if (verdict.bucket !== 'indeterminate') return false;
      const createdMs = new Date(verdict.row.createdAt).getTime();
      return Number.isFinite(createdMs) && nowMs - createdMs > SURVIVOR_ALERT_MS;
    })
    .map((verdict) => `${verdict.row.table}:${verdict.row.id}`)
    .sort();
}

async function maybeSendSummary(
  result: BulkReconcileResult,
  send: typeof sendTelegramText,
  now: Date,
): Promise<boolean> {
  const manualRows = manualAlertRows(result, now.getTime());
  const fingerprint = manualRows.join(',');
  const didSomething = result.summary.captured > 0 || result.summary.closedNoMoney > 0;
  const manualChanged = manualRows.length > 0 && fingerprint !== lastManualFingerprint;
  if (!didSomething && !manualChanged) {
    if (manualRows.length === 0) lastManualFingerprint = '';
    return false;
  }
  lastManualFingerprint = fingerprint;
  await send(
    `auto-reconcile: captured ${result.summary.captured} ` +
      `($${(result.summary.capturedUsdCents / 100).toFixed(2)}), ` +
      `closed ${result.summary.closedNoMoney} no-money, ` +
      `${manualRows.length} manual`,
  );
  return true;
}

export async function runX402AutoReconcilePass(
  injected: X402AutoReconcileDeps = {},
): Promise<X402AutoReconcilePassResult> {
  const config = resolveX402AutoReconcileConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      skippedOverlap: false,
      skippedLock: false,
      sweep: null,
      alerted: false,
    };
  }
  if (autoPassRunning) {
    return {
      enabled: true,
      skippedOverlap: true,
      skippedLock: false,
      sweep: null,
      alerted: false,
    };
  }
  autoPassRunning = true;
  const runSweep = injected.runSweep ?? runBulkReconcileSweep;
  const withAdvisoryLock = injected.withAdvisoryLock ?? withDefaultAdvisoryLock;
  const send = injected.send ?? sendTelegramText;
  const now = injected.now ?? (() => new Date());
  const logError = injected.logError ?? ((message: string, error: unknown) =>
    console.error(message, error));
  try {
    const locked = await withAdvisoryLock(() => runSweep({
      apply: true,
      consent: 'auto',
      limit: config.maxRows,
    }));
    if (!locked.acquired || !locked.sweep) {
      return {
        enabled: true,
        skippedOverlap: false,
        skippedLock: true,
        sweep: null,
        alerted: false,
      };
    }
    let alerted = false;
    try {
      alerted = await maybeSendSummary(locked.sweep, send, now());
    } catch (error) {
      // sendTelegramText is never-throw, but preserve that contract for injected
      // test/alternate senders too.
      logError('[x402-auto-reconcile] summary alert failed (non-fatal):', error);
    }
    return {
      enabled: true,
      skippedOverlap: false,
      skippedLock: false,
      sweep: locked.sweep,
      alerted,
    };
  } catch (error) {
    logError('[x402-auto-reconcile] pass failed (non-fatal):', error);
    return {
      enabled: true,
      skippedOverlap: false,
      skippedLock: false,
      sweep: null,
      alerted: false,
    };
  } finally {
    autoPassRunning = false;
  }
}

export function isX402AutoReconcileRunning(): boolean {
  return autoInterval !== null;
}

export function startX402AutoReconcile(): void {
  if (autoInterval) return;
  const config = resolveX402AutoReconcileConfig();
  if (!config.enabled) return;
  const generation = ++autoGeneration;
  const run = () => {
    void runX402AutoReconcilePass();
  };
  run();
  const interval = setInterval(() => {
    if (autoInterval !== interval || autoGeneration !== generation) return;
    run();
  }, config.intervalMs);
  interval.unref?.();
  autoInterval = interval;
  console.log(
    `[x402-auto-reconcile] worker started — every ` +
      `${Math.round(config.intervalMs / 60_000)}min, cap ${config.maxRows}`,
  );
}

export function stopX402AutoReconcile(): void {
  autoGeneration += 1;
  lastManualFingerprint = '';
  if (!autoInterval) return;
  clearInterval(autoInterval);
  autoInterval = null;
}

/** Test-only state reset without exporting mutable internals. */
export function resetX402AutoReconcileAlertDedupeForTests(): void {
  lastManualFingerprint = '';
}
