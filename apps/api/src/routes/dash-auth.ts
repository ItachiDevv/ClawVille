/**
 * Shared-password fallback for /dash access.
 *
 * Two endpoints — both unauthenticated by design (they GRANT auth):
 *
 *   POST /api/dash-auth/login    — body { password }; sets `cv_dash`
 *                                   cookie on match
 *   POST /api/dash-auth/logout   — clears the cookie
 *
 * The shared password lives in the `DASH_SHARED_PASSWORD` env var. On a
 * timing-safe match, we set `cv_dash` to the precomputed HMAC value the
 * `adminOnly` middleware accepts (see middleware/admin-only.ts). The
 * cookie is HttpOnly + Secure + SameSite=Lax + 30-day max-age.
 *
 * Brute-force protection: per-IP rate limit (10 attempts / 5 minutes).
 * Slows offline cracking and dictionary attacks against weak passwords.
 * Operators who pick a strong shared password are fine; operators who
 * pick "claw" should still survive a casual probing.
 */

import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { timingSafeEqual } from 'crypto';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { DASH_COOKIE_NAME, expectedDashCookie } from '../middleware/admin-only';
import type { AppContext } from '../types';

export const dashAuthRoutes = new Hono<AppContext>();

const SHARED_PASSWORD = process.env.DASH_SHARED_PASSWORD ?? '';

const loginLimiter = createRateLimiter({
  maxPerWindow: 10,
  windowMs: 5 * 60_000,
});

dashAuthRoutes.post('/login', async (c) => {
  // Reject early if the operator hasn't configured a password — don't
  // let the route accept '' and silently set a cookie.
  if (!SHARED_PASSWORD) {
    return c.json(
      { ok: false, error: 'not_configured', message: 'Shared-password access is not configured for this deployment.' },
      503,
    );
  }

  const ip = getClientIp(c.req.raw.headers);
  if (!loginLimiter.check(ip)) {
    return c.json(
      { ok: false, error: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' },
      429,
    );
  }

  const body = await c.req.json<{ password?: unknown }>().catch(() => null);
  if (body === null) {
    return c.json({ ok: false, error: 'invalid_json' }, 400);
  }

  const submitted = typeof body?.password === 'string' ? body.password : '';

  // Timing-safe comparison so equal-length probing can't deduce the
  // password byte-by-byte. Different lengths = automatic mismatch.
  const ok = (() => {
    const a = Buffer.from(submitted);
    const b = Buffer.from(SHARED_PASSWORD);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  })();

  if (!ok) {
    return c.json({ ok: false, error: 'invalid_password' }, 401);
  }

  const cookieValue = expectedDashCookie();
  if (!cookieValue) {
    // FINGERPRINT_SECRET missing — the middleware can't validate cookies
    // either, so refuse to set one. Operator needs to fix env first.
    return c.json(
      { ok: false, error: 'server_misconfigured', message: 'FINGERPRINT_SECRET not set on this deployment.' },
      500,
    );
  }

  // Cross-subdomain cookie scope — the dashboard server component runs on
  // clawville.world and fetches api.clawville.world/__check; without an
  // explicit Domain, the cookie is bound to api.clawville.world only and
  // the frontend can't see it. Setting `Domain=.clawville.world` makes
  // browsers store + send the cookie for both subdomains.
  //
  // Dev (NODE_ENV !== 'production') uses no Domain attribute — defaults to
  // the response host (typically localhost), which is what local dev
  // expects. Avoids "domain mismatch" cookie rejection on localhost.
  const isProd = process.env.NODE_ENV === 'production';
  setCookie(c, DASH_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days
    ...(isProd ? { domain: '.clawville.world' } : {}),
  });

  return c.json({ ok: true });
});

dashAuthRoutes.post('/logout', async (c) => {
  // Delete must match the original Domain to actually clear the cookie.
  const isProd = process.env.NODE_ENV === 'production';
  deleteCookie(c, DASH_COOKIE_NAME, {
    path: '/',
    ...(isProd ? { domain: '.clawville.world' } : {}),
  });
  return c.json({ ok: true });
});
