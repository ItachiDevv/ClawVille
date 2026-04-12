import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { lucia } from '../lib/auth';
import { db, users, openclawBots } from '@clawville/database';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import { npcSimulation } from '../services/npc-simulation';
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

authRoutes.post('/milady-session-exchange', async (c) => {
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
