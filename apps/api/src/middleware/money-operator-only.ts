import { randomBytes } from 'crypto';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../types';

export interface MoneyOperatorContext extends AppContext {
  Variables: AppContext['Variables'] & { moneyOperatorId: string };
}

const nonces = new Map<string, { userId: string; expiresAt: number }>();
const NONCE_TTL_MS = 60_000;
const NONCE_REQUIRED = new Set(['/fleet/provision', '/pair', '/arm', '/unhalt', '/kill', '/test-trade', '/clawpump/provision', '/clawpump/pair', '/clawpump/unpair']);

function adminIds(): Set<string> {
  return new Set((process.env.ADMIN_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
}

function allowedOrigins(): Set<string> {
  const values = [process.env.CORS_ORIGIN, process.env.WEB_URL, process.env.NEXT_PUBLIC_WEB_URL]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (process.env.NODE_ENV === 'test') values.push('http://localhost');
  return new Set(values);
}

export function issueMoneyOperatorNonce(userId: string): { nonce: string; expiresAt: string } {
  const nonce = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, { userId, expiresAt });
  return { nonce, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeMoneyOperatorNonce(nonce: string, userId: string): boolean {
  const value = nonces.get(nonce);
  nonces.delete(nonce);
  return Boolean(value && value.userId === userId && value.expiresAt >= Date.now());
}

export const moneyOperatorOnly = createMiddleware<MoneyOperatorContext>(async (c, next) => {
  const user = c.get('user');
  const session = c.get('session');
  if (!user || !session) throw new HTTPException(401, { message: 'Authentication required' });
  if (!adminIds().has(user.id)) throw new HTTPException(403, { message: 'Money operator access required' });

  const origin = c.req.header('origin')?.replace(/\/+$/, '');
  if (!origin || !allowedOrigins().has(origin)) throw new HTTPException(403, { message: 'Origin is not allowed' });

  if (c.req.method !== 'GET') {
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') throw new HTTPException(415, { message: 'JSON content type required' });
  }

  const path = new URL(c.req.url).pathname.replace(/^\/api\/admin\/trading/, '');
  if (c.req.method !== 'GET' && NONCE_REQUIRED.has(path)) {
    const nonce = c.req.header('x-money-confirmation-nonce') ?? '';
    if (!consumeMoneyOperatorNonce(nonce, user.id)) {
      throw new HTTPException(409, { message: 'A fresh confirmation nonce is required' });
    }
  }

  c.set('moneyOperatorId', user.id);
  await next();
});
