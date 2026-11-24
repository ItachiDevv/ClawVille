/**
 * PayAI credit monitor: warns BEFORE the facilitator credit balance runs out.
 *
 * Why (founder 2026-11-24): during the 2026-10-10..10-25 outage nobody knew the
 * PayAI credits were gone until settlements had already failed for days. PayAI
 * sends no low-balance email or webhook, but its merchant account API returns
 * the balance (https://docs.payai.network/x402/facilitators/agent-api-keys).
 *
 * Every hour this reads, with the same API key the facilitator client uses:
 *   GET https://merchant.payai.network/api/v1/account               -> credits.minorUnits
 *   GET https://merchant.payai.network/api/v1/account/usage?days=7  -> settlements
 *   GET https://merchant.payai.network/api/v1/account/transactions  -> cost per settle
 * One credit is $0.001. Read-only: it never pays, tops up, or touches a key.
 *
 * Levels: `empty` (balance <= 0, critical), `low` (balance below 1,000 credits
 * or under 14 days of runway at the 7-day settle rate, warning), `ok`. A worse
 * level pages at once; the same level pages again every 24 h; three failed reads
 * in a row page once per 24 h so a broken monitor cannot hide an outage.
 * Only CLAWVILLE_ENV=production pages; other boxes log the same text.
 * Off switch: PAYAI_CREDIT_MONITOR=false.
 */

import { getOrGenerateJwt } from '@payai/facilitator';
import { alertError, type AlertErrorParams } from './alert-error';
import { isHostedPayAiFacilitatorUrl, loadX402Config } from './x402-config';

const MERCHANT_ORIGIN = 'https://merchant.payai.network';
const POLL_MS = 60 * 60 * 1_000;
const REALERT_MS = 24 * 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 15_000;
const MINOR_UNITS_PER_CREDIT = 1_000_000;
export const PAYAI_LOW_CREDITS = 1_000;
export const PAYAI_LOW_RUNWAY_DAYS = 14;
const READ_FAILURES_BEFORE_ALERT = 3;
const SOURCE = 'payai-credit-monitor';
const TOP_UP_URL = 'https://merchant.payai.network/top-up';

export type PayAiCreditLevel = 'ok' | 'low' | 'empty';

export interface PayAiCreditReading {
  balanceCredits: number;
  /** Credits used per day at the 7-day settle rate; null when unknown. */
  dailyBurnCredits: number | null;
  /** Days left at that rate; null when the burn is unknown or zero. */
  runwayDays: number | null;
}

export interface PayAiCreditMonitorDeps {
  fetchJson: (path: string) => Promise<unknown>;
  alert: (params: AlertErrorParams) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
}

interface MonitorState {
  lastLevel: PayAiCreditLevel;
  lastAlertMs: number | null;
  consecutiveReadFailures: number;
  lastReadFailureAlertMs: number | null;
}

let state: MonitorState = freshState();
let interval: ReturnType<typeof setInterval> | null = null;

function freshState(): MonitorState {
  return { lastLevel: 'ok', lastAlertMs: null, consecutiveReadFailures: 0, lastReadFailureAlertMs: null };
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

/** Pure parse of the three merchant responses. Throws when the balance is missing. */
export function parsePayAiCreditReading(
  account: unknown,
  usage: unknown,
  transactions: unknown,
): PayAiCreditReading {
  const credits = (account as { credits?: { minorUnits?: unknown; balance?: unknown } } | null)?.credits;
  const minor = finiteNumber(credits?.minorUnits);
  const balanceCredits = minor !== null ? minor / MINOR_UNITS_PER_CREDIT : finiteNumber(credits?.balance);
  if (balanceCredits === null) throw new Error('PayAI account response has no credit balance');

  const usageBody = usage as { settlements?: unknown; period?: { days?: unknown } } | null;
  const settlements = finiteNumber(usageBody?.settlements);
  const days = finiteNumber(usageBody?.period?.days);

  const rows = (transactions as { transactions?: unknown } | null)?.transactions;
  const costs = (Array.isArray(rows) ? rows : [])
    .filter((row): row is { type: unknown; amount: unknown } => typeof row === 'object' && row !== null)
    .filter((row) => row.type === 'usage')
    .map((row) => finiteNumber(row.amount))
    .filter((amount): amount is number => amount !== null && amount < 0)
    .map((amount) => -amount / MINOR_UNITS_PER_CREDIT);
  const creditsPerSettle = costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : null;

  const dailyBurnCredits = settlements !== null && days !== null && days > 0 && creditsPerSettle !== null
    ? (settlements / days) * creditsPerSettle
    : null;
  const runwayDays = dailyBurnCredits !== null && dailyBurnCredits > 0
    ? Math.max(0, balanceCredits) / dailyBurnCredits
    : null;
  return { balanceCredits, dailyBurnCredits, runwayDays };
}

export function classifyPayAiCredit(reading: PayAiCreditReading): PayAiCreditLevel {
  if (reading.balanceCredits <= 0) return 'empty';
  if (reading.balanceCredits < PAYAI_LOW_CREDITS) return 'low';
  if (reading.runwayDays !== null && reading.runwayDays < PAYAI_LOW_RUNWAY_DAYS) return 'low';
  return 'ok';
}

const LEVEL_RANK: Record<PayAiCreditLevel, number> = { ok: 0, low: 1, empty: 2 };

function creditContext(reading: PayAiCreditReading): Record<string, unknown> {
  return {
    balanceCredits: Math.round(reading.balanceCredits),
    balanceUsd: (reading.balanceCredits / 1_000).toFixed(2),
    dailyBurnCredits: reading.dailyBurnCredits === null ? null : Math.round(reading.dailyBurnCredits),
    runwayDays: reading.runwayDays === null ? null : Math.floor(reading.runwayDays),
    topUp: TOP_UP_URL,
  };
}

/** One monitor pass. Never throws. Exported for tests and for an ops one-off run. */
export async function runPayAiCreditCheck(deps: PayAiCreditMonitorDeps): Promise<PayAiCreditLevel | 'unreadable'> {
  let reading: PayAiCreditReading;
  try {
    // Only the balance is required; a failed usage or transaction read means
    // unknown runway, never a skipped empty-balance page.
    const [account, usage, transactions] = await Promise.allSettled([
      deps.fetchJson('/api/v1/account'),
      deps.fetchJson('/api/v1/account/usage?days=7'),
      deps.fetchJson('/api/v1/account/transactions?limit=50'),
    ]);
    if (account.status === 'rejected') throw account.reason;
    reading = parsePayAiCreditReading(
      account.value,
      usage.status === 'fulfilled' ? usage.value : null,
      transactions.status === 'fulfilled' ? transactions.value : null,
    );
  } catch (error) {
    state.consecutiveReadFailures += 1;
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`[${SOURCE}] credit read failed (${state.consecutiveReadFailures} in a row): ${message}`);
    const nowMs = deps.now();
    if (
      state.consecutiveReadFailures >= READ_FAILURES_BEFORE_ALERT
      && (state.lastReadFailureAlertMs === null || nowMs - state.lastReadFailureAlertMs >= REALERT_MS)
    ) {
      state.lastReadFailureAlertMs = nowMs;
      await safeAlert(deps, {
        severity: 'warning',
        source: SOURCE,
        message: 'Cannot read the PayAI credit balance; low-credit warnings are blind until this is fixed.',
        context: { consecutiveFailures: state.consecutiveReadFailures, error: message.slice(0, 200) },
      });
    }
    return 'unreadable';
  }

  // lastReadFailureAlertMs is kept, so a flaky read pages at most once per 24 h.
  state.consecutiveReadFailures = 0;
  const level = classifyPayAiCredit(reading);
  const context = creditContext(reading);
  deps.log(`[${SOURCE}] level=${level} ${JSON.stringify(context)}`);

  const nowMs = deps.now();
  const worse = LEVEL_RANK[level] > LEVEL_RANK[state.lastLevel];
  const due = state.lastAlertMs === null || nowMs - state.lastAlertMs >= REALERT_MS;
  state.lastLevel = level;
  if (level === 'ok') {
    state.lastAlertMs = null;
    return level;
  }
  if (!worse && !due) return level;
  state.lastAlertMs = nowMs;
  await safeAlert(deps, level === 'empty'
    ? {
        severity: 'critical',
        source: SOURCE,
        message: 'PayAI credits are EMPTY: agent payments and Tier-1 bounty payouts cannot settle. Top up now.',
        context,
      }
    : {
        severity: 'warning',
        source: SOURCE,
        message: `PayAI credits are low (under ${PAYAI_LOW_CREDITS} credits or ${PAYAI_LOW_RUNWAY_DAYS} days). Top up before settlements stop.`,
        context,
      });
  return level;
}

async function safeAlert(deps: PayAiCreditMonitorDeps, params: AlertErrorParams): Promise<void> {
  try {
    await deps.alert(params);
  } catch (error) {
    deps.log(`[${SOURCE}] alert failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** True when this box settles through hosted PayAI with an API key. */
export function isPayAiCreditMonitorEnabled(): boolean {
  if (process.env.PAYAI_CREDIT_MONITOR?.trim().toLowerCase() === 'false') return false;
  const config = loadX402Config();
  return config.payaiApiKeyId.length > 0
    && config.payaiApiKeySecret.length > 0
    && isHostedPayAiFacilitatorUrl(config.facilitatorUrl);
}

function defaultDeps(): PayAiCreditMonitorDeps {
  const pages = process.env.CLAWVILLE_ENV === 'production';
  return {
    fetchJson: async (path) => {
      const { payaiApiKeyId, payaiApiKeySecret } = loadX402Config();
      const token = await getOrGenerateJwt({ apiKeyId: payaiApiKeyId, apiKeySecret: payaiApiKeySecret });
      const response = await fetch(`${MERCHANT_ORIGIN}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`PayAI merchant API ${path.split('?')[0]} returned ${response.status}`);
      return response.json();
    },
    alert: pages
      ? alertError
      : async (params) => { console.warn(`[${SOURCE}] (not paged on this box) ${params.severity}: ${params.message}`); },
    now: Date.now,
    log: (message) => console.log(message),
  };
}

export function startPayAiCreditMonitor(): void {
  if (interval || !isPayAiCreditMonitorEnabled()) return;
  const deps = defaultDeps();
  const run = () => { void runPayAiCreditCheck(deps); };
  run();
  interval = setInterval(run, POLL_MS);
  interval.unref?.();
  console.log(`[${SOURCE}] started: every ${POLL_MS / 60_000} min`);
}

export function stopPayAiCreditMonitor(): void {
  if (interval) clearInterval(interval);
  interval = null;
  state = freshState();
}
