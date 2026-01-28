import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { lucia } from '../lib/auth';
import type { AppContext, AuthenticatedContext } from '../types';

export const sessionMiddleware = createMiddleware<AppContext>(async (c, next) => {
  const sessionId = lucia.readSessionCookie(c.req.header('Cookie') ?? '');

  if (!sessionId) {
    c.set('user', null);
    c.set('session', null);
    return next();
  }

  const { session, user } = await lucia.validateSession(sessionId);

  if (session && session.fresh) {
    const cookie = lucia.createSessionCookie(session.id);
    c.header('Set-Cookie', cookie.serialize(), { append: true });
  }

  if (!session) {
    const cookie = lucia.createBlankSessionCookie();
    c.header('Set-Cookie', cookie.serialize(), { append: true });
  }

  c.set('user', user);
  c.set('session', session);
  return next();
});

export const requireAuth = createMiddleware<AuthenticatedContext>(async (c, next) => {
  const sessionId = lucia.readSessionCookie(c.req.header('Cookie') ?? '');

  if (!sessionId) {
    throw new HTTPException(401, { message: 'Authentication required' });
  }

  const { session, user } = await lucia.validateSession(sessionId);

  if (!session || !user) {
    throw new HTTPException(401, { message: 'Invalid session' });
  }

  if (session.fresh) {
    const cookie = lucia.createSessionCookie(session.id);
    c.header('Set-Cookie', cookie.serialize(), { append: true });
  }

  c.set('user', user);
  c.set('session', session);
  return next();
});
