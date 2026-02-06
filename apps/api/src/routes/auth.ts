import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { lucia } from '../lib/auth';
import { db, users } from '@elizapets/database';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
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
