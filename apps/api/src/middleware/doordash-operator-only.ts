import { randomBytes } from 'crypto';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../types';
import { doordashOperatorUserId } from '../services/doordash-operator';

export interface DoordashOperatorContext extends AppContext {
  Variables: AppContext['Variables'] & { doordashOperatorId: string };
}

const nonces = new Map<string, { userId: string; expiresAt: number }>();
const NONCE_TTL_MS = 60_000;

function allowedOrigins(): Set<string> {
  const values = [process.env.CORS_ORIGIN, process.env.WEB_URL, process.env.NEXT_PUBLIC_WEB_URL]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (process.env.NODE_ENV === 'test') values.push('http://localhost');
  return new Set(values);
}

export function issueDoordashOperatorNonce(userId: string): { nonce: string; expiresAt: string } {
  const now = Date.now();
  for (const [nonce, value] of nonces) {
    if (value.expiresAt <= now) nonces.delete(nonce);
  }
  const nonce = randomBytes(32).toString('base64url');
  const expiresAt = now + NONCE_TTL_MS;
  nonces.set(nonce, { userId, expiresAt });
  return { nonce, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeDoordashOperatorNonce(nonce: string, userId: string): boolean {
  const value = nonces.get(nonce);
  nonces.delete(nonce);
  return Boolean(value && value.userId === userId && value.expiresAt > Date.now());
}

/** Lucia-only: the shared dashboard password and agent credentials cannot pass. */
export const doordashOperatorOnly = createMiddleware<DoordashOperatorContext>(async (c, next) => {
  const user = c.get('user');
  const session = c.get('session');
  if (!user || !session) throw new HTTPException(401, { message: 'Authentication required' });
  if (user.id !== doordashOperatorUserId()) {
    throw new HTTPException(403, { message: 'doordash_operator_only' });
  }

  const origin = c.req.header('origin')?.replace(/\/+$/, '');
  if (!origin || !allowedOrigins().has(origin)) {
    throw new HTTPException(403, { message: 'Origin is not allowed' });
  }

  // Every future non-GET operator route needs both JSON and a single-use nonce.
  if (c.req.method !== 'GET') {
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      throw new HTTPException(415, { message: 'JSON content type required' });
    }
    const nonce = c.req.header('x-doordash-confirmation-nonce') ?? '';
    if (!consumeDoordashOperatorNonce(nonce, user.id)) {
      throw new HTTPException(409, { message: 'A fresh confirmation nonce is required' });
    }
  }

  c.set('doordashOperatorId', user.id);
  await next();
});
