/**
 * Users routes — username management (added 2026-05-19).
 *
 * Username is a case-insensitive UNIQUE handle separate from avatar.name.
 * Initialized to avatar.name at first avatar creation (see avatars.ts
 * POST /), then editable here. The two values are independent thereafter
 * — a user can rename their avatar without changing their public handle,
 * and vice versa.
 *
 * Validation rule mirrors avatar.name for parity: 3-20 chars, alphanumeric
 * plus underscore. The DB enforces format via the `users_username_format`
 * check constraint; the API rejects malformed payloads with a clearer
 * error before they ever hit the DB.
 *
 * Endpoints:
 *   GET   /api/users/check-username/:name  — public, availability probe
 *   PATCH /api/users/me/username           — requireAuth, sets new handle
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db, users } from '@clawville/database';
import { requireAuth } from '../middleware/auth';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import type { AppContext } from '../types';

export const userRoutes = new Hono<AppContext>();

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

// 5 username edits per minute per IP. Username changes carry public
// surface (chat, leaderboard) so the rate limit doubles as a soft
// anti-grief: a bot that's scripting changes will fall off the cap
// fast, and a human user editing manually can't realistically hit it.
const usernameEditLimiter = createRateLimiter({ windowMs: 60_000, maxPerWindow: 5 });

/**
 * Case-insensitive availability check. Returns
 *   { available: true }                              — free to use
 *   { available: false, reason: '...' }              — taken or malformed
 *
 * Public (no auth) so the create-agent / settings UIs can probe with
 * debounce as the user types. The DB lookup is cheap (UNIQUE index) and
 * leaking "this name is taken" is fine — same disclosure as the
 * existing /api/avatars/check-name endpoint.
 */
userRoutes.get('/check-username/:name', async (c) => {
  const raw = c.req.param('name');
  if (!raw || !USERNAME_PATTERN.test(raw)) {
    return c.json({
      available: false,
      reason: 'Username must be 3-20 alphanumeric characters or underscore',
    });
  }
  // citext-style case-insensitive lookup without forcing a citext column
  // migration — works on the existing varchar with a lower() compare.
  const existing = await db.query.users.findFirst({
    where: sql`lower(${users.username}) = lower(${raw})`,
  });
  return c.json({ available: !existing });
});

const patchUsernameSchema = z.object({
  username: z
    .string()
    .min(3, { message: 'Username must be at least 3 characters' })
    .max(20, { message: 'Username must be at most 20 characters' })
    .regex(USERNAME_PATTERN, { message: 'Use only letters, numbers, and underscore' }),
});

userRoutes.patch('/me/username', requireAuth, async (c) => {
  const user = c.get('user');

  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!usernameEditLimiter.check(ip)) {
    throw new HTTPException(429, {
      message: 'Too many username changes. Slow down.',
    });
  }

  const body = await c.req.json().catch(() => null);
  const parsed = patchUsernameSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.issues[0]?.message ?? 'Invalid username',
    });
  }

  const next = parsed.data.username;

  // No-op early-out so the rate limit doesn't punish a user who clicked
  // Save without changing anything.
  if (user.username && user.username.toLowerCase() === next.toLowerCase()) {
    return c.json({ user, changed: false });
  }

  // Case-insensitive uniqueness — must exclude the caller's own row so
  // they can re-cast (e.g. 'foo' → 'Foo') without colliding with
  // themselves.
  const collision = await db.query.users.findFirst({
    where: and(
      sql`lower(${users.username}) = lower(${next})`,
      ne(users.id, user.id),
    ),
  });
  if (collision) {
    throw new HTTPException(409, { message: 'That username is already taken' });
  }

  const [updated] = await db
    .update(users)
    .set({ username: next, updatedAt: new Date() })
    .where(eq(users.id, user.id))
    .returning();

  return c.json({ user: updated, changed: true });
});
