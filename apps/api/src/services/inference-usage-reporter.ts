/**
 * Process-local inference usage heartbeat for the itachi-debug Telegram bot.
 * Router counters are cumulative; this service keeps only the last successfully
 * reported snapshot so each hourly message contains a non-overlapping delta.
 */

import {
  getInferenceRouter,
  type EndpointStats,
  type InferenceRoute,
  type InferenceUsageRow,
  type InferenceUsageSnapshot,
} from '@clawville/agent-runtime';
import { sendTelegramText } from './alert-error';

const FIRST_REPORT_DELAY_MS = 5 * 60 * 1000;
const REPORT_PERIOD_MS = 60 * 60 * 1000;
const BOX_STATUS_CHECK_PERIOD_MS = 60 * 1000;
const OFFLINE_DEBOUNCE_CHECKS = 2;
const ROUTE_ORDER: InferenceRoute[] = [
  'teacher',
  'fleet',
  'hosted-user',
  'default',
];
const OPENAI_PRICES_PER_MILLION: Record<
  string,
  { input: number; output: number }
> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
};

export type InferenceUsageReportGate = {
  enabled: boolean;
  reason: string;
};

type InferenceUsageReportEnv = {
  CLAWVILLE_ENV?: string;
  INFERENCE_USAGE_REPORT?: string;
};

/** Injectable, DB-free seams for the one-shot reporter tests. */
export const inferenceUsageReporterSeams = {
  snapshotProvider: (): InferenceUsageSnapshot =>
    getInferenceRouter().usageSnapshot(),
  statsProvider: (): EndpointStats[] => getInferenceRouter().stats(),
  sender: (text: string): Promise<void> => sendTelegramText(text),
};

let started = false;
let firstReportTimeout: ReturnType<typeof setTimeout> | null = null;
let reportInterval: ReturnType<typeof setInterval> | null = null;
let boxStatusInterval: ReturnType<typeof setInterval> | null = null;
let previousSnapshot: InferenceUsageSnapshot | null = null;
type EndpointStatusState = {
  offline: boolean;
  consecutiveOpenChecks: number;
};
const endpointStatusStates = new Map<string, EndpointStatusState>();

export function resolveInferenceUsageReportGate(
  env: InferenceUsageReportEnv = {
    CLAWVILLE_ENV: process.env.CLAWVILLE_ENV,
    INFERENCE_USAGE_REPORT: process.env.INFERENCE_USAGE_REPORT,
  },
): InferenceUsageReportGate {
  if (env.INFERENCE_USAGE_REPORT === 'on') {
    return { enabled: true, reason: 'INFERENCE_USAGE_REPORT=on override' };
  }
  if (env.INFERENCE_USAGE_REPORT === 'off') {
    return { enabled: false, reason: 'INFERENCE_USAGE_REPORT=off override' };
  }
  if (env.CLAWVILLE_ENV === 'production') {
    return { enabled: true, reason: 'CLAWVILLE_ENV=production default' };
  }
  return {
    enabled: false,
    reason: `CLAWVILLE_ENV=${env.CLAWVILLE_ENV || 'unknown'} default`,
  };
}

function rowKey(row: InferenceUsageRow): string {
  return `${row.route}|${row.endpointId}|${row.model}`;
}

function subtractSnapshots(
  current: InferenceUsageSnapshot,
  previous: InferenceUsageSnapshot | null,
): InferenceUsageSnapshot {
  const priorRows = new Map(
    (previous?.rows ?? []).map((row) => [rowKey(row), row]),
  );
  const rows = current.rows.map((row) => {
    const prior = priorRows.get(rowKey(row));
    return {
      ...row,
      calls: Math.max(0, row.calls - (prior?.calls ?? 0)),
      inTokens: Math.max(0, row.inTokens - (prior?.inTokens ?? 0)),
      outTokens: Math.max(0, row.outTokens - (prior?.outTokens ?? 0)),
    };
  });

  const blackouts: Record<string, number> = {};
  for (const [route, count] of Object.entries(current.blackouts)) {
    blackouts[route] = Math.max(0, count - (previous?.blackouts[route] ?? 0));
  }
  return { rows, blackouts };
}

function countLabel(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'call' : 'calls'}`;
}

function tokenSummary(inTokens: number, outTokens: number): string {
  return `in ${inTokens.toLocaleString('en-US')} · out ${outTokens.toLocaleString('en-US')}`;
}

function routeRank(route: string): number {
  const index = ROUTE_ORDER.indexOf(route as InferenceRoute);
  return index === -1 ? ROUTE_ORDER.length : index;
}

function formatReport(
  snapshot: InferenceUsageSnapshot,
  stats: EndpointStats[],
  firstReport: boolean,
): string {
  const environment = process.env.CLAWVILLE_ENV || 'unknown';
  const window = firstReport ? 'since boot' : 'last hour';
  const lines = [`📊 ClawVille inference — ${window} (${environment})`];
  const activeRows = snapshot.rows.filter((row) => row.calls > 0);
  const totalCalls = activeRows.reduce((sum, row) => sum + row.calls, 0);

  if (totalCalls === 0) {
    lines.push('', '0 inference calls this hour.');
  } else {
    const openAiRows = activeRows.filter((row) => row.endpointId === 'openai');
    if (openAiRows.length > 0) {
      const calls = openAiRows.reduce((sum, row) => sum + row.calls, 0);
      const inTokens = openAiRows.reduce((sum, row) => sum + row.inTokens, 0);
      const outTokens = openAiRows.reduce((sum, row) => sum + row.outTokens, 0);
      lines.push(
        '',
        `OpenAI (paid): ${countLabel(calls)} · ${tokenSummary(inTokens, outTokens)}`,
      );

      const grouped = new Map<string, InferenceUsageRow>();
      for (const row of openAiRows) {
        const key = `${row.route}|${row.model}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.calls += row.calls;
          existing.inTokens += row.inTokens;
          existing.outTokens += row.outTokens;
        } else {
          grouped.set(key, { ...row });
        }
      }
      const breakdown = [...grouped.values()].sort(
        (a, b) =>
          routeRank(a.route) - routeRank(b.route) ||
          a.model.localeCompare(b.model),
      );
      let estimatedCost = 0;
      let hasKnownCost = false;
      for (const row of breakdown) {
        lines.push(
          `  ${row.route} / ${row.model}: ${countLabel(row.calls)} · ${tokenSummary(row.inTokens, row.outTokens)}`,
        );
        const price = OPENAI_PRICES_PER_MILLION[row.model];
        if (price) {
          hasKnownCost = true;
          estimatedCost +=
            (row.inTokens * price.input + row.outTokens * price.output) /
            1_000_000;
        }
      }
      if (hasKnownCost) lines.push(`  est. $${estimatedCost.toFixed(6)}`);
    }

    const localRows = activeRows.filter((row) => row.endpointId !== 'openai');
    if (localRows.length > 0) {
      const byEndpoint = new Map<string, number>();
      for (const row of localRows) {
        byEndpoint.set(
          row.endpointId,
          (byEndpoint.get(row.endpointId) ?? 0) + row.calls,
        );
      }
      const localCalls = [...byEndpoint.values()].reduce(
        (sum, calls) => sum + calls,
        0,
      );
      lines.push('', `Local: ${countLabel(localCalls)}`);
      for (const [endpointId, calls] of [...byEndpoint].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        lines.push(`  ${endpointId}: ${countLabel(calls)}`);
      }
    }
  }

  const localStats = stats
    .filter((entry) => entry.kind === 'local')
    .sort((a, b) => a.id.localeCompare(b.id));
  lines.push('', 'Boxes:');
  if (localStats.length === 0) {
    lines.push('  ⚠️ no local inference boxes configured');
  } else {
    for (const entry of localStats) {
      lines.push(
        entry.breakerOpen
          ? `  ❌ ${entry.id} OFFLINE`
          : `  ✅ ${entry.id} online`,
      );
    }
  }

  const warnings: string[] = [];
  for (const [route, count] of Object.entries(snapshot.blackouts).sort(
    ([a], [b]) => routeRank(a) - routeRank(b) || a.localeCompare(b),
  )) {
    if (count > 0) {
      warnings.push(`⚠️ ${count} calls failed on ALL endpoints (${route})`);
    }
  }
  const openBreakers = [
    ...new Set(
      stats
        .filter((entry) => entry.kind !== 'local' && entry.breakerOpen)
        .map((entry) => entry.id),
    ),
  ].sort();
  for (const endpointId of openBreakers) {
    warnings.push(`⚠️ breaker open: ${endpointId}`);
  }
  if (warnings.length > 0) lines.push('', 'Warnings:', ...warnings);

  return lines.join('\n');
}

/** Run one report tick. Fail-soft; a failed tick leaves its delta pending. */
export async function runInferenceUsageReportOnce(): Promise<void> {
  if (!resolveInferenceUsageReportGate().enabled) return;

  try {
    const current = inferenceUsageReporterSeams.snapshotProvider();
    const stats = inferenceUsageReporterSeams.statsProvider();
    const delta = subtractSnapshots(current, previousSnapshot);
    const message = formatReport(delta, stats, previousSnapshot === null);
    await inferenceUsageReporterSeams.sender(message);
    previousSnapshot = current;
  } catch (err) {
    console.error('[InferenceUsageReporter] report failed:', err);
  }
}

function watchesEndpoint(entry: EndpointStats): boolean {
  return (
    entry.kind === 'local' || (entry.kind === 'cloud' && entry.id === 'openai')
  );
}

function offlineMessage(
  entry: EndpointStats,
  allLocalBoxesOffline: boolean,
  stats: EndpointStats[],
): string {
  if (entry.kind === 'cloud') {
    return '🔴 OpenAI endpoint failing (breaker open) — teacher/cloud inference degraded.';
  }
  // Route lists put every local box before openai, so as long as ANOTHER local
  // box is reachable, failover lands there (still free) — only when no local
  // survives does traffic actually spill to paid OpenAI.
  const survivors = stats
    .filter((e) => e.kind === 'local' && e.id !== entry.id && !e.breakerOpen)
    .map((e) => e.id);
  const message =
    survivors.length > 0
      ? `🔴 Local inference box OFFLINE: ${entry.id} — traffic is failing over to ${survivors.join(', ')} (still local, free).`
      : `🔴 Local inference box OFFLINE: ${entry.id} — traffic is failing over to OpenAI (paid).`;
  return allLocalBoxesOffline
    ? `${message}\n🚨 ALL local boxes offline — every fleet/hosted call is now on OpenAI.`
    : message;
}

function recoveryMessage(entry: EndpointStats): string {
  return entry.kind === 'cloud'
    ? '🟢 OpenAI endpoint recovered.'
    : `🟢 Local inference box back online: ${entry.id}.`;
}

function wouldConfirmAllLocalBoxesOffline(
  stats: EndpointStats[],
  transitioningEndpointId: string,
): boolean {
  const localStats = stats.filter((entry) => entry.kind === 'local');
  return (
    localStats.length > 0 &&
    localStats.every(
      (entry) =>
        entry.breakerOpen &&
        (entry.id === transitioningEndpointId ||
          endpointStatusStates.get(entry.id)?.offline === true),
    )
  );
}

/** Evaluate router health once and alert on debounced endpoint transitions. */
export async function runBoxStatusCheckOnce(): Promise<void> {
  if (!resolveInferenceUsageReportGate().enabled) return;

  try {
    const stats = inferenceUsageReporterSeams.statsProvider();
    const watchedStats = stats.filter(watchesEndpoint);
    const watchedIds = new Set(watchedStats.map((entry) => entry.id));
    for (const endpointId of endpointStatusStates.keys()) {
      if (!watchedIds.has(endpointId)) endpointStatusStates.delete(endpointId);
    }

    for (const entry of watchedStats) {
      const state = endpointStatusStates.get(entry.id);
      if (!state) {
        endpointStatusStates.set(entry.id, {
          offline: false,
          consecutiveOpenChecks: entry.breakerOpen ? 1 : 0,
        });
        continue;
      }

      if (!entry.breakerOpen) {
        if (!state.offline) {
          state.consecutiveOpenChecks = 0;
          continue;
        }
        try {
          await inferenceUsageReporterSeams.sender(recoveryMessage(entry));
          endpointStatusStates.set(entry.id, {
            offline: false,
            consecutiveOpenChecks: 0,
          });
        } catch (err) {
          console.error(
            `[InferenceUsageReporter] recovery alert failed (${entry.id}):`,
            err,
          );
        }
        continue;
      }

      if (state.offline) continue;
      const consecutiveOpenChecks = state.consecutiveOpenChecks + 1;
      if (consecutiveOpenChecks < OFFLINE_DEBOUNCE_CHECKS) {
        state.consecutiveOpenChecks = consecutiveOpenChecks;
        continue;
      }

      const allLocalBoxesOffline =
        entry.kind === 'local' &&
        wouldConfirmAllLocalBoxesOffline(stats, entry.id);
      try {
        await inferenceUsageReporterSeams.sender(
          offlineMessage(entry, allLocalBoxesOffline, stats),
        );
        endpointStatusStates.set(entry.id, {
          offline: true,
          consecutiveOpenChecks,
        });
      } catch (err) {
        console.error(
          `[InferenceUsageReporter] offline alert failed (${entry.id}):`,
          err,
        );
      }
    }
  } catch (err) {
    console.error('[InferenceUsageReporter] box status check failed:', err);
  }
}

/** Start ~5 minutes after boot, then report once per hour. Idempotent. */
export function startInferenceUsageReporter(): void {
  if (started) return;
  started = true;

  const gate = resolveInferenceUsageReportGate();
  console.log(
    `[InferenceUsageReporter] ${gate.enabled ? 'enabled' : 'disabled'} (${gate.reason})`,
  );
  if (!gate.enabled) return;

  firstReportTimeout = setTimeout(() => {
    firstReportTimeout = null;
    void runInferenceUsageReportOnce();
    reportInterval = setInterval(() => {
      void runInferenceUsageReportOnce();
    }, REPORT_PERIOD_MS);
    (reportInterval as unknown as { unref?: () => void }).unref?.();
  }, FIRST_REPORT_DELAY_MS);
  (firstReportTimeout as unknown as { unref?: () => void }).unref?.();

  boxStatusInterval = setInterval(() => {
    void runBoxStatusCheckOnce();
  }, BOX_STATUS_CHECK_PERIOD_MS);
  (boxStatusInterval as unknown as { unref?: () => void }).unref?.();
}

/** Stop pending/recurring timers and reset the report window. Idempotent. */
export function stopInferenceUsageReporter(): void {
  started = false;
  previousSnapshot = null;
  endpointStatusStates.clear();
  if (firstReportTimeout) {
    clearTimeout(firstReportTimeout);
    firstReportTimeout = null;
  }
  if (reportInterval) {
    clearInterval(reportInterval);
    reportInterval = null;
  }
  if (boxStatusInterval) {
    clearInterval(boxStatusInterval);
    boxStatusInterval = null;
  }
}
