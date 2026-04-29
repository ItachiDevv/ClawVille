/**
 * Admin-only middleware for /api/dashboard/* and other internal surfaces.
 *
 * Two acceptance paths (caller passes if EITHER is satisfied):
 *
 *   1. ADMIN_USER_IDS allowlist — a comma-separated list of user UUIDs.
 *      Runs AFTER sessionMiddleware so `c.get('user')` is populated.
 *      Distinguishes individual admins; preferred for traceability.
 *
 *   2. Shared-password cookie (added 2026-04-29) — `cv_dash` cookie holding
 *      `HMAC-SHA256(FINGERPRINT_SECRET, "dash-access")`. The cookie is set
 *      by `POST /api/dash-auth/login` after a successful comparison against
 *      `DASH_SHARED_PASSWORD`. Lets the team review the dashboard with a
 *      single shared credential — useful for pasting access into Discord
 *      / Slack threads without provisioning each reviewer's user UUID.
 *
 * Returns 401 when the caller isn't logged in AND has no valid dash cookie,
 * 403 when they ARE logged in but not on the allowlist (and no cookie).
 * Distinct codes make deploy-time debugging easier (401 = cookie issue,
 * 403 = env var issue).
 *
 * Parsing happens at module load. Changing ADMIN_USER_IDS or
 * DASH_SHARED_PASSWORD requires a redeploy to take effect; rotating the
 * password also invalidates the existing `cv_dash` cookies because the
 * expected value depends on FINGERPRINT_SECRET only — to fully revoke
 * shared-password access mid-cycle, rotate FINGERPRINT_SECRET (note: this
 * also resets all leaderboard fp_hash buckets — coordinate first).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { getCookie } from 'hono/cookie';
import type { AppContext } from '../types';

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Pre-computed expected cookie value. The dash cookie is checked against
 * this constant. HMAC-SHA256 keyed by FINGERPRINT_SECRET ensures the value
 * is non-forgeable without the server secret. The "dash-access" message
 * is a fixed identifier; we don't need a per-session token because the
 * shared-password model has no individuation by design.
 */
const DASH_COOKIE_EXPECTED: Buffer | null = (() => {
  const secret = process.env.FINGERPRINT_SECRET;
  if (!secret) return null;
  return createHmac('sha256', secret).update('dash-access').digest();
})();

export const DASH_COOKIE_NAME = 'cv_dash';

export function expectedDashCookie(): string | null {
  return DASH_COOKIE_EXPECTED?.toString('hex') ?? null;
}

function hasValidDashCookie(rawCookie: string | undefined): boolean {
  if (!rawCookie || !DASH_COOKIE_EXPECTED) return false;
  // Hex-decode the cookie and compare to expected via timingSafeEqual.
  // Reject malformed inputs (length mismatch / non-hex) without leaking
  // timing info via a constant-length sink.
  let provided: Buffer;
  try {
    provided = Buffer.from(rawCookie, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== DASH_COOKIE_EXPECTED.length) return false;
  return timingSafeEqual(provided, DASH_COOKIE_EXPECTED);
}

export const adminOnly = createMiddleware<AppContext>(async (c, next) => {
  // Path 2: shared-password cookie — checked first so the dashboard works
  // even for callers without a Lucia session at all.
  if (hasValidDashCookie(getCookie(c, DASH_COOKIE_NAME))) {
    await next();
    return;
  }

  // Path 1: ADMIN_USER_IDS allowlist (requires Lucia session).
  const user = c.get('user');

  if (!user) {
    throw new HTTPException(401, { message: 'Authentication required' });
  }

  if (!ADMIN_IDS.includes(user.id)) {
    throw new HTTPException(403, { message: 'Admin access required' });
  }

  await next();
});
