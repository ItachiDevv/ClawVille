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

// Read per call, not at module load (same discipline as the CLAWVILLE_ENV gate
// below): env never changes on a deployed box, but in a shared-process test run
// whichever suite imports this module first would bake "not configured" for the
// whole process.
function telegramCreds(): { token?: string; chatId?: string } {
  return {
    token: process.env.ITACHI_DEBUG_BOT_TOKEN,
    chatId: process.env.ITACHI_DEBUG_CHAT_ID,
  };
}

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

/** Send raw plain text through the itachi-debug Telegram bot. Never throws. */
export async function sendTelegramText(text: string): Promise<void> {
  const { token, chatId } = telegramCreds();
  if (!token || !chatId) {
    console.warn('[alert-error] Telegram credentials not configured, skipping send', {
      text,
    });
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    });
    if (!res.ok) {
      console.warn(
        `[alert-error] Telegram send rejected (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
      console.log('[alert-error] Telegram rejected message fallback:', text);
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

  // DEPLOYED-BOX GATE (2026-08-17): only the staging/prod boxes may PAGE.
  // A local dev/test process inherits the real bot token from the shell profile
  // (~/.itachi-api-keys wins over .env.local), points at the staging DB, and
  // lacks the deployed-only secrets — e.g. a local api without
  // VANITY_ENCRYPTION_KEY paged ops hourly with "verify signer unusable" for a
  // wallet only the deployed box can decrypt. CLAWVILLE_ENV is the immutable
  // per-box deploy signal (same discriminator partner-signature trusts;
  // NODE_ENV is 'production' on both boxes AND locally-built bundles, so it
  // cannot discriminate). Non-deployed runs degrade to console.warn with the
  // full payload. ALERT_TELEGRAM_FORCE='true' is the deliberate local override
  // for testing the pipe itself.
  const clawvilleEnv = process.env.CLAWVILLE_ENV;
  const deployed = clawvilleEnv === 'staging' || clawvilleEnv === 'production';
  if (!deployed && process.env.ALERT_TELEGRAM_FORCE !== 'true') {
    console.warn(
      '[alert-error] non-deployed environment (CLAWVILLE_ENV unset) — alert logged, NOT paged',
      { severity, source, message, context: context ? redactBearerTokens(JSON.stringify(context)) : undefined },
    );
    return;
  }

  const { token, chatId } = telegramCreds();
  if (!token || !chatId) {
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

  await sendTelegramText(lines.join('\n'));
}
