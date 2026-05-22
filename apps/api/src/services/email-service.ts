/**
 * Resend SDK wrapper.
 *
 * Boot behaviour:
 *   - `RESEND_API_KEY` missing → console fallback (logs the email and
 *     returns success). Keeps local dev + CI green without burning
 *     Resend quota.
 *   - `RESEND_API_KEY` missing AND `NODE_ENV=production` → emits a
 *     loud `console.warn` so the operator sees the misconfiguration
 *     in container logs, but DOES NOT crash boot. The hard-require
 *     boot pattern (used by `FINGERPRINT_SECRET`) is reserved for
 *     security-load-bearing secrets where missing-secret means
 *     potential exploit. A missing email provider is recoverable
 *     UX degradation, not an exploit window.
 *
 * Send behaviour:
 *   - Returns `{ ok: true, id?: string }` on success, `{ ok: false,
 *     reason: string }` on failure. Callers should treat failures as
 *     log-only — never block a user flow on email send.
 *   - All sends use `FROM_EMAIL` (default
 *     `"ClawVille <noreply@clawville.world>"`).
 *
 * Lazy SDK import: the `resend` package is dynamically imported on
 * first send so the API can boot even when the dep isn't installed
 * (e.g. running unit tests that mock email out). Initialization is
 * cached in `getResendClient()`.
 */

import { alertError } from './alert-error';

const DEFAULT_FROM = 'ClawVille <noreply@clawville.world>';

interface ResendLikeClient {
  emails: {
    send: (args: {
      from: string;
      to: string | string[];
      subject: string;
      html?: string;
      text?: string;
    }) => Promise<{ data?: { id?: string } | null; error?: unknown | null }>;
  };
}

let cachedClientPromise: Promise<ResendLikeClient | null> | null = null;

function getApiKey(): string | null {
  const raw = process.env.RESEND_API_KEY?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function getFromAddress(): string {
  return process.env.FROM_EMAIL?.trim() || DEFAULT_FROM;
}

async function getResendClient(): Promise<ResendLikeClient | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  if (cachedClientPromise) return cachedClientPromise;
  cachedClientPromise = (async () => {
    try {
      // Dynamic import so tests / dev without `resend` installed still
      // boot. The package is in `dependencies` for prod. The runtime
      // `import('resend')` is type-erased via the `string` argument so
      // tsc doesn't fail on machines where the dep isn't installed
      // (Coolify build re-runs `bun install` so prod always has it).
      const moduleName = 'resend';
      const mod = (await import(moduleName)) as unknown as {
        Resend: new (key: string) => ResendLikeClient;
      };
      return new mod.Resend(apiKey);
    } catch (err) {
      console.warn(
        '[email-service] Failed to load `resend` package — falling back to console logging.',
        err,
      );
      return null;
    }
  })();
  return cachedClientPromise;
}

let warnedAboutMissingKey = false;
function warnIfProdMissingKey(): void {
  if (warnedAboutMissingKey) return;
  if (process.env.NODE_ENV === 'production' && !getApiKey()) {
    warnedAboutMissingKey = true;
    console.warn(
      '[email-service] RESEND_API_KEY is missing in production — outgoing emails will be console-logged only. Verification + reset links will NOT reach users until this is fixed.',
    );
  }
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Caller-facing tag used for log breadcrumbs + alert dedup keys —
   * e.g. `'password-reset'` or `'verify-email'`. Optional.
   */
  tag?: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  reason?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  warnIfProdMissingKey();

  if (!params.to || !params.subject) {
    return { ok: false, reason: 'missing_to_or_subject' };
  }

  const from = getFromAddress();
  const apiKey = getApiKey();

  if (!apiKey) {
    // Dev / unconfigured fallback — log enough that a developer can grab
    // the verification or reset link from the console without needing
    // Resend setup. NEVER prints the raw token on its own line, only the
    // full URL the way the production email would (defense against log
    // scraping making sure the audit trail looks identical between
    // environments).
    console.info('[email-service:console-fallback]', {
      tag: params.tag ?? 'unknown',
      from,
      to: params.to,
      subject: params.subject,
      text: params.text,
    });
    return { ok: true, id: 'console-fallback' };
  }

  const client = await getResendClient();
  if (!client) {
    return { ok: false, reason: 'sdk_unavailable' };
  }

  try {
    const result = await client.emails.send({
      from,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });
    if (result.error) {
      const reason = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      console.warn('[email-service] Resend returned error', { tag: params.tag, reason });
      // alertError de-dups via `${source}::${message}` — pass a stable
      // source so a burst of identical failures collapses to a single
      // Telegram ping.
      await alertError({
        severity: 'warning',
        source: `email-service:${params.tag ?? 'send'}`,
        message: reason,
      }).catch(() => {});
      return { ok: false, reason };
    }
    return { ok: true, id: result.data?.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn('[email-service] send threw', { tag: params.tag, reason });
    await alertError({
      severity: 'warning',
      source: `email-service:${params.tag ?? 'send'}`,
      message: reason,
    }).catch(() => {});
    return { ok: false, reason };
  }
}

/**
 * Heuristic guest detector — guest users get placeholder emails that
 * are unreachable, so we never queue mail for them.
 *
 *   - Form-signup guests:  `guest+<uuid>@guest.clawville` (auth.ts POST /guest)
 *   - Milady guests:        `milady-<agentId>@clawville.guest` (milady-session-exchange)
 *
 * Belt-and-braces: callers should ALSO check the row's `is_guest`
 * column — this string check is the second line of defence in case a
 * future migration drops the `is_guest` flag but leaves the email
 * pattern in place.
 */
export function isGuestEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const lower = email.toLowerCase();
  return (
    lower.endsWith('@clawville.guest') ||
    lower.endsWith('@guest.clawville') ||
    lower.startsWith('milady-') ||
    lower.startsWith('guest+')
  );
}
