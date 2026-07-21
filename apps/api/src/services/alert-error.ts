/**
 * Immediate error/warning alerts via the itachi-debug Telegram bot.
 *
 * Three callers:
 *   1. event-logger.ts — on DOUBLE FAILURE (both events + event_write_failures writes failed)
 *   2. Hono onError middleware — any uncaught exception from a route handler
 *   3. Explicit business-logic failures (e.g. token ledger insert failed)
 *
 * Never throws. A broken alert channel must not break user flows.
 *
 * Rate-limited: same `source::message` combo collapses to one alert per 60s,
 * with suppressed-count appended when the next alert fires. Prevents a loud
 * bug from drowning the Telegram chat.
 */

import { redactBearerTokens } from './log-redact';

const TOKEN = process.env.ITACHI_DEBUG_BOT_TOKEN;
const CHAT_ID = process.env.ITACHI_DEBUG_CHAT_ID;

const WINDOW_MS = 60_000;
const rateLimiter = new Map<string, { firstAt: number; suppressed: number }>();

function shouldSend(key: string): { send: boolean; suppressedCount: number } {
  const now = Date.now();
  const existing = rateLimiter.get(key);

  if (!existing || now - existing.firstAt > WINDOW_MS) {
    rateLimiter.set(key, { firstAt: now, suppressed: 0 });
    return { send: true, suppressedCount: 0 };
  }

  existing.suppressed += 1;
  return { send: false, suppressedCount: existing.suppressed };
}

export interface AlertErrorParams {
  severity: 'critical' | 'warning';
  source: string;
  message: string;
  context?: Record<string, unknown>;
}

/** Send raw text through the itachi-debug Telegram bot. Never throws.
 * Defaults to PLAIN text: legacy-Markdown parse mode makes Telegram reject the
 * WHOLE message (400) on any unpaired `*`/`_`/backtick, which would silently
 * drop periodic reports. Only the alertError path opts into Markdown — its
 * message shape is fixed and pairs its markers. */
export async function sendTelegramText(
  text: string,
  opts?: { parseMode?: 'Markdown' },
): Promise<void> {
  if (!TOKEN || !CHAT_ID) {
    console.warn('[alert-error] Telegram credentials not configured, skipping send', {
      text,
    });
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
      }),
    });
    if (!res.ok) {
      console.warn(
        `[alert-error] Telegram send rejected (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn('[alert-error] Telegram send failed', err);
  }
}

export async function alertError(params: AlertErrorParams): Promise<void> {
  const { severity, source, context } = params;
  // Redact any agent bearer sessionId from the message at the TOP — covers ALL
  // three callers (event-logger double-failure, the Hono onError uncaught-error
  // path whose message is `Uncaught error on <method> <path>` and whose path can
  // be `/api/agent/oc-<bearer>/…`, and explicit business-logic failures). Without
  // this the raw, replayable real-CT bearer lands on Telegram + stdout/Coolify.
  const message = redactBearerTokens(params.message);

  if (!TOKEN || !CHAT_ID) {
    console.warn('[alert-error] Telegram credentials not configured, skipping alert', {
      source,
      message,
    });
    return;
  }

  const key = `${source}::${message}`;
  const { send, suppressedCount } = shouldSend(key);
  if (!send) return;

  const emoji = severity === 'critical' ? '🚨' : '⚠️';
  const lines = [
    `${emoji} *ClawVille API ${severity}*`,
    `Source: \`${source}\``,
    `Time: ${new Date().toISOString()}`,
    '',
    message,
  ];
  if (context) {
    lines.push('```');
    // Redact the STRING form of the context — its `error`/`stack` fields on the
    // onError path serialize the request URL (raw bearer) and any bearer embedded
    // in an error message. Redact after stringify so nested values are covered.
    lines.push(redactBearerTokens(JSON.stringify(context, null, 2)));
    lines.push('```');
  }
  if (suppressedCount > 0) {
    lines.push(`_(+${suppressedCount} more in last 60s)_`);
  }

  await sendTelegramText(lines.join('\n'), { parseMode: 'Markdown' });
}
