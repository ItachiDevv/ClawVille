import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { lucia } from '../lib/auth';
import { db, users, openclawBots } from '@clawville/database';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import { npcSimulation } from '../services/npc-simulation';
import { consumeTicket } from '../services/session-ticket-service';
import type { AppContext } from '../types';
import { z } from 'zod';

export const authRoutes = new Hono<AppContext>();

authRoutes.use('*', sessionMiddleware);

// Get current user
authRoutes.get('/me', requireAuth, async (c) => {
  const user = c.get('user');
  return c.json({ user });
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
    throw new HTTPException(400, { message: 'Invalid input' });
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
