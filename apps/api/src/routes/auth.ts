import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { lucia } from '../lib/auth';
import { db, users, openclawBots, avatars } from '@clawville/database';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import { npcSimulation } from '../services/npc-simulation';
import { consumeTicket } from '../services/session-ticket-service';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import type { AppContext } from '../types';
import { z } from 'zod';
import { DEFAULT_AGENT_MODEL_KEY } from '@clawville/shared';

export const authRoutes = new Hono<AppContext>();

authRoutes.use('*', sessionMiddleware);

// Get current user
authRoutes.get('/me', requireAuth, async (c) => {
  const user = c.get('user');
  return c.json({ user });
});

// Phase 6 — authoritative server-side "is the user's agent connected?"
// probe for UI hydration. Zustand's `agentConnected` flag is client-only
// and defaults false on every page load; without this endpoint the UI
// would show "Connect Your Agent" for a user whose Hermes/Milady agent
// was already running, OR (worse, pre-sweeper) show "Connected" long
// after the Hermes agent exited because the modal's stale polling cache
// was the only source of truth.
//
// Resolution order:
//   1. Milady-harnessed avatars → always considered connected because
//      ClawVille hosts their Eliza runtime end-to-end. Session handle
//      surfaces as `avatar.platformAgentId`; there's no openclaw_bots row
//      to check because the agent IS the avatar.
//   2. Otherwise, look up the most-recent openclaw_bots row for the
//      user and check `session_expires_at`. Expired or missing → not
//      connected. The row isn't deleted on expiry; the agent can
//      reconnect with the signed-challenge flow and the handle resumes.
authRoutes.get('/me/agent-session', requireAuth, async (c) => {
  const user = c.get('user');

  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, user.id),
    columns: { id: true, harness: true, platformAgentId: true },
  });

  // External agent path takes precedence — if an openclaw_bots row exists,
  // its sliding 24h TTL is the authoritative liveness signal regardless of
  // the avatar's harness label. Previously a Milady-harness carve-out
  // short-circuited to `connected: true` without ever consulting the bot
  // row, so a Hermes/OpenClaw session paired weeks ago kept showing as
  // active in the UI long after its actual session_expires_at had lapsed.
  const bot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.userId, user.id),
    orderBy: (t, { desc }) => [desc(t.lastSeenAt)],
    columns: {
      agentId: true,
      lastSeenAt: true,
      sessionExpiresAt: true,
      identityType: true,
    },
  });

  if (bot) {
    const now = new Date();
    const expired =
      bot.sessionExpiresAt !== null && bot.sessionExpiresAt <= now;

    if (expired) {
      return c.json({
        connected: false,
        reason: 'expired',
        agentId: bot.agentId,
        lastSeenAt: bot.lastSeenAt.toISOString(),
        expiresAt: bot.sessionExpiresAt!.toISOString(),
      });
    }

    return c.json({
      connected: true,
      agentId: bot.agentId,
      harness: avatar?.harness ?? bot.identityType ?? null,
      expiresAt: bot.sessionExpiresAt?.toISOString() ?? null,
      lastSeenAt: bot.lastSeenAt.toISOString(),
    });
  }

  // No external bot — fall through to the Milady carve-out only when the
  // user truly has no external agent attached. ClawVille hosts the Milady
  // Eliza runtime server-side, so an avatar with harness='milady' and a
  // platform_agents row IS always alive in the sense that you can chat
  // with it; that's a different liveness shape than an external agent's
  // sliding TTL and we don't want to falsely mark it dead.
  if (avatar?.harness === 'milady' && avatar.platformAgentId) {
    return c.json({
      connected: true,
      agentId: avatar.platformAgentId,
      harness: 'milady',
      expiresAt: null,
      lastSeenAt: null,
    });
  }

  return c.json({ connected: false, reason: 'no_bot' });
});

// Logout
authRoutes.post('/logout', requireAuth, async (c) => {
  const session = c.get('session');
  await lucia.invalidateSession(session.id);
  const cookie = lucia.createBlankSessionCookie();
  c.header('Set-Cookie', cookie.serialize());
  return c.json({ success: true });
});

// Signup
const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

authRoutes.post('/signup', async (c) => {
  const body = await c.req.json();
  const result = signupSchema.safeParse(body);

  if (!result.success) {
    // Surface the specific validation issue so the user knows WHY they
    // were rejected (wrong email format? password too short?). Previously
    // the generic "Invalid input" left users staring at a form that
    // looked fine to them. Zod's first issue is enough context: we only
    // validate 3 fields and any single failure is user-actionable.
    const first = result.error.issues[0];
    const field = first.path.join('.') || 'input';
    throw new HTTPException(400, {
      message: `Invalid ${field}: ${first.message}`,
    });
  }

  const { email: rawEmail, password, name } = result.data;
  const email = rawEmail.toLowerCase();

  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (existingUser) {
    throw new HTTPException(400, { message: 'Email already registered' });
  }

  const passwordHash = await Bun.password.hash(password, {
    algorithm: 'bcrypt',
    cost: 10,
  });

  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    email,
    passwordHash,
    name: name || email.split('@')[0],
  });

  const session = await lucia.createSession(userId, {});
  const cookie = lucia.createSessionCookie(session.id);
  c.header('Set-Cookie', cookie.serialize());

  return c.json({ success: true });
});

// Login
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.json();
  const result = loginSchema.safeParse(body);

  if (!result.success) {
    throw new HTTPException(400, { message: 'Invalid input' });
  }

  const { email: rawEmail, password } = result.data;
  const email = rawEmail.toLowerCase();

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (!user || !user.passwordHash) {
    throw new HTTPException(401, { message: 'Invalid email or password' });
  }

  const validPassword = await Bun.password.verify(password, user.passwordHash);
  if (!validPassword) {
    throw new HTTPException(401, { message: 'Invalid email or password' });
  }

  const session = await lucia.createSession(user.id, {});
  const cookie = lucia.createSessionCookie(session.id);
  c.header('Set-Cookie', cookie.serialize());

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Milady session exchange — converts a ClawVille agent sessionId into a
// Lucia auth session so the embedded viewer can skip the login overlay.
//
// Flow:
//   1. Milady plugin connects via POST /api/agent/connect → gets sessionId
//   2. Plugin injects sessionId into the viewer's localStorage
//   3. ClawVille frontend calls this endpoint with that sessionId
//   4. We validate it, find/create a user, mint a Lucia cookie
//   5. Frontend is now authenticated as a "milady guest" user
//
// The guest user row uses email = `milady-<agentId>@clawville.guest`
// and a random password hash (never used — Milady guests don't log in
// via email/password). If the same Milady agent reconnects later, we
// find the existing user row and reuse it.
// ---------------------------------------------------------------------------

const miladyExchangeSchema = z.object({
  sessionId: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// In-memory rate limiter for milady-session-exchange
// Prevents brute-force attempts against the short session ID space.
// Max 5 attempts per minute per IP. Map auto-cleans on each request.
// ---------------------------------------------------------------------------
const miladyRateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkMiladyRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = miladyRateLimitMap.get(ip);

  // Lazy cleanup: remove expired entries on each call (bounded by request volume)
  if (miladyRateLimitMap.size > 10000) {
    for (const [key, val] of miladyRateLimitMap) {
      if (val.resetAt <= now) miladyRateLimitMap.delete(key);
    }
  }

  if (!entry || entry.resetAt <= now) {
    miladyRateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  entry.count++;
  if (entry.count > 5) return false;
  return true;
}

// ---------------------------------------------------------------------------
// GET /api/auth/enter?t=... — Phase 5 magic-link exchanger.
// ---------------------------------------------------------------------------
// Redeems a one-time agent-issued session ticket and swaps it for a
// real Lucia session cookie, then 302-redirects the browser to `/game`.
//
// The click-through is always from a human's browser (the agent passes
// the URL through chat), so setting `Set-Cookie` here is correct —
// the browser follows the redirect AND keeps the cookie.
//
// Spec §4.3 + §7:
//   - Atomic consume (UPDATE ... RETURNING * in session-ticket-service)
//   - Short TTL, enforced at DB level (`expires_at > now()`)
//   - One-time use
//   - `Referrer-Policy: no-referrer` set on both success and failure
//     redirects so the ticket never leaks through the Referer header
//     when /game or the error page makes its first outbound request.
// ---------------------------------------------------------------------------
function webOriginForRedirect(): string {
  if (process.env.WEB_ORIGIN) return process.env.WEB_ORIGIN.replace(/\/+$/, '');
  const corsOrigin = process.env.CORS_ORIGIN?.split(',')[0]?.trim();
  if (corsOrigin) return corsOrigin.replace(/\/+$/, '');
  return 'https://clawville.world';
}

authRoutes.get('/enter', async (c) => {
  const ticket = c.req.query('t');
  const webOrigin = webOriginForRedirect();

  // Always set Referrer-Policy before returning — on BOTH the happy
  // path (redirect to /game) and the error path (redirect to /).
  c.header('Referrer-Policy', 'no-referrer');

  if (!ticket) {
    return c.redirect(`${webOrigin}/?error=expired-link`, 302);
  }

  let consumed;
  try {
    consumed = await consumeTicket(ticket);
  } catch (err) {
    console.error('[AuthEnter] consume failed:', err);
    return c.redirect(`${webOrigin}/?error=expired-link`, 302);
  }

  if (!consumed) {
    // Invalid / expired / already-consumed — all three collapse to
    // the same UX. We deliberately don't distinguish them so an
    // attacker holding a stolen ticket can't probe for "was it
    // valid?" before bailing.
    return c.redirect(`${webOrigin}/?error=expired-link`, 302);
  }

  // Create the Lucia session — attributes match the form-login route
  // exactly (same cookie domain, same sameSite/secure settings via
  // `apps/api/src/lib/auth.ts`).
  try {
    const session = await lucia.createSession(consumed.userId, {});
    const cookie = lucia.createSessionCookie(session.id);
    c.header('Set-Cookie', cookie.serialize());
  } catch (err) {
    console.error('[AuthEnter] session create failed:', err);
    return c.redirect(`${webOrigin}/?error=expired-link`, 302);
  }

  return c.redirect(`${webOrigin}/game`, 302);
});

authRoutes.post('/milady-session-exchange', async (c) => {
  // Rate limit: 5 attempts per minute per IP
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || 'unknown';

  if (!checkMiladyRateLimit(ip)) {
    throw new HTTPException(429, {
      message: 'Too many session exchange attempts. Try again in a minute.',
    });
  }

  const body = await c.req.json();
  const parsed = miladyExchangeSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'sessionId is required' });
  }

  const { sessionId } = parsed.data;

  // Validate the session exists in the NPC simulation
  if (!npcSimulation.isValidAgentSession(sessionId)) {
    throw new HTTPException(404, { message: 'Agent session not found or expired' });
  }

  // Get the bot's config to find the resolved agentId
  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (!botConfig) {
    throw new HTTPException(404, { message: 'Bot configuration not found for session' });
  }

  // Look up the openclawBots row
  const bot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, botConfig.agentId),
  });

  if (!bot) {
    throw new HTTPException(404, { message: 'Agent not registered in ClawVille' });
  }

  // Find or create a guest user for this Milady agent
  const guestEmail = `milady-${botConfig.agentId}@clawville.guest`;
  let user = await db.query.users.findFirst({
    where: eq(users.email, guestEmail),
  });

  if (!user) {
    // Create a guest user — random password hash, never used for login
    const guestId = crypto.randomUUID();
    const randomHash = await Bun.password.hash(crypto.randomUUID(), {
      algorithm: 'bcrypt',
      cost: 4, // fast — this hash is never verified
    });

    await db.insert(users).values({
      id: guestId,
      email: guestEmail,
      passwordHash: randomHash,
      name: bot.name ?? botConfig.agentId,
    });

    user = await db.query.users.findFirst({
      where: eq(users.id, guestId),
    });
  }

  if (!user) {
    throw new HTTPException(500, { message: 'Failed to create guest user' });
  }

  // Create a Lucia session for this guest user
  const session = await lucia.createSession(user.id, {});
  const cookie = lucia.createSessionCookie(session.id);
  c.header('Set-Cookie', cookie.serialize());

  return c.json({
    success: true,
    userId: user.id,
    agentId: botConfig.agentId,
    botName: bot.name,
    botUuid: bot.id,
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/guest — guest avatar auto-create (2026-04-23).
//
// Lets an un-authenticated visitor play the Q2 activity games + chat with
// NPCs as a throwaway "Guest Avatar" — no email, no signup. Use case:
// "test-drive the game before deciding to make an account."
//
// Behaviour:
//   - Idempotent: if the caller already has a Lucia cookie, return their
//     existing user + avatar (handler does NOT create a second guest).
//   - Else: create a (users, avatars) pair with is_guest=true,
//     guest_expires_at = now() + 24h. Issues a Lucia session cookie.
//
// Brand carve-outs (mirroring the Q2 chunk #10 bot pattern — see
// services/activity/reward-pipeline.ts and routes/leaderboard.ts):
//   - Guest avatars do NOT appear on the agent leaderboard
//   - Guest avatars do NOT appear on per-activity leaderboards
//   - Guest match results still credit ClawTokens (in-game dopamine
//     works) but with leaderboardPoints = 0
//   - Guest events are excluded from the /dash teacher-chat metric
//
// Rate-limited to 5 mints/IP/min — same budget as the auto-provision
// branch in avatars.ts. Each mint creates a (users, avatars) pair so the cap
// matters even though guests cost less than a full identity+wallet mint.
// ---------------------------------------------------------------------------

const guestRateLimiter = createRateLimiter({
  maxPerWindow: 5,
  windowMs: 60_000,
});

const guestBodySchema = z.object({
  /** Optional — caller-suggested display name. Ignored if name collides. */
  requestedName: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9 ]+$/)
    .optional(),
});

const GUEST_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const GUEST_SPECIES = ['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle'] as const;
const GUEST_COLORS = ['green', 'red', 'blue', 'yellow'] as const;
const GUEST_GENDERS = ['male', 'female'] as const;
const GUEST_ARCHETYPE = 'brave-adventurer';

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Try INSERTing the avatar up to N times — on a 23505 unique-violation
 * (name collision) we re-roll the random suffix and retry. The 5-digit
 * suffix space is 100k entries; a collision needs >316 concurrent guests
 * with the same first roll, so a small retry budget is sufficient.
 */
async function insertGuestAvatar(
  ownerId: string,
  requestedName: string | undefined,
): Promise<{ id: string; name: string }> {
  const species = pickRandom(GUEST_SPECIES);
  const color = pickRandom(GUEST_COLORS);
  const gender = pickRandom(GUEST_GENDERS);

  // Sanitise + cap the requestedName at 14 chars so the suffix fits in
  // the 20-char `avatars.name` column.
  const baseRaw = requestedName?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 14);
  const base = baseRaw && baseRaw.length >= 3 ? baseRaw : 'Guest';

  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = Math.floor(1000 + Math.random() * 9000).toString();
    const candidate = `${base}${suffix}`;
    try {
      const [row] = await db
        .insert(avatars)
        .values({
          userId: ownerId,
          name: candidate,
          species,
          color,
          gender,
          archetype: GUEST_ARCHETYPE,
          personality: {
            habitat: 'Town Center',
            hobby: 'Visiting ClawVille',
            greeting: 'Hi! Just visiting.',
          },
          stats: { strength: 5, defence: 5, movement: 5 },
          // No characterConfig — guests don't run Eliza chat as their avatar.
          // characterConfig is hydrated later if/when they convert to a
          // real account. Leaving it null is safe — the avatar routes
          // tolerate a null characterConfig (chat is gated to non-guests
          // by other checks in the chat surfaces, not enforced here).
          clawTokens: 100,
          isActive: true,
          modelKey: DEFAULT_AGENT_MODEL_KEY,
          agentCategory: 'openclaw',
          harness: 'milady',
          isGuest: true,
        })
        .returning({ id: avatars.id, name: avatars.name });
      return row;
    } catch (err) {
      const code =
        (err as { code?: string; cause?: { code?: string } } | null)?.code ??
        (err as { cause?: { code?: string } } | null)?.cause?.code;
      if (code === '23505') continue;
      throw err;
    }
  }
  throw new HTTPException(503, {
    message: 'Could not generate a unique guest name — please retry',
  });
}

authRoutes.post('/guest', async (c) => {
  // Rate limit FIRST — public endpoint, no auth required.
  const ip = getClientIp(c.req.raw.headers);
  if (!guestRateLimiter.check(ip)) {
    throw new HTTPException(429, {
      message: 'Too many guest signups from this IP. Try again in 1 minute.',
    });
  }

  // Idempotent: if the caller already has a Lucia session, return their
  // current user + avatar rather than minting a second guest.
  const existingUser = c.get('user');
  if (existingUser) {
    const existingAvatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, existingUser.id), eq(avatars.isActive, true)),
    });
    return c.json({
      user: {
        id: existingUser.id,
        email: existingUser.email,
        name: existingUser.name,
        // Read isGuest off the raw row so we don't trust the user attribute mapping.
        isGuest: !!(await db.query.users.findFirst({
          where: eq(users.id, existingUser.id),
          columns: { isGuest: true },
        }))?.isGuest,
      },
      avatar: existingAvatar ?? null,
      reused: true,
    });
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = guestBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid request body' });
  }

  // Mint the guest user. Email + password_hash are populated with
  // unique placeholders so the `users_has_auth_method` CHECK passes
  // (same pattern as scripts/seed-bot-avatars.ts). The placeholder
  // password_hash is shaped like "$bot$disabled$..." so an admin can
  // tell at a glance the row was never meant to log in via email/pwd.
  const userId = crypto.randomUUID();
  const guestEmail = `guest+${userId}@guest.clawville`;
  const placeholderPasswordHash = `$guest$disabled$${userId}`;
  const expiresAt = new Date(Date.now() + GUEST_TTL_MS);

  await db.insert(users).values({
    id: userId,
    email: guestEmail,
    passwordHash: placeholderPasswordHash,
    name: 'Guest',
    isGuest: true,
    guestExpiresAt: expiresAt,
  });

  const avatar = await insertGuestAvatar(userId, parsed.data.requestedName);

  // Lucia session cookie — same attributes as signup/login (sameSite +
  // secure flags driven by NODE_ENV via lib/auth.ts).
  const session = await lucia.createSession(userId, {});
  const cookie = lucia.createSessionCookie(session.id);
  c.header('Set-Cookie', cookie.serialize());

  return c.json({
    user: {
      id: userId,
      email: guestEmail,
      name: 'Guest',
      isGuest: true,
      guestExpiresAt: expiresAt.toISOString(),
    },
    avatar: { id: avatar.id, name: avatar.name },
    reused: false,
  });
});
