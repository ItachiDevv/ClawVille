/**
 * Stateless guest-presence binding carried from /join to later HTTP requests
 * and the browser WebSocket handshake. The cookie is not authentication: it
 * selects the same demo-tier guest presence key the server already registered.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { resolveSessionCookieDomain } from '../lib/auth';

export const WORLD_GUEST_COOKIE_NAME = 'cv_world_guest';

/** Signed-payload replay bound. The cookie itself is deliberately session-scoped. */
export const WORLD_GUEST_BINDING_MAX_AGE_MS = 24 * 60 * 60_000;

const MAX_BINDING_LENGTH = 1024;
const masterSecret = process.env.FINGERPRINT_SECRET || 'test-only-world-guest-binding-salt';
const bindingHmacKey = createHash('sha256')
  .update(masterSecret + 'world-guest-binding-v1:')
  .digest();
const guestPresenceSalt = masterSecret + 'world-guest-presence-v1:';

const presenceKeySchema = z.string().min(1).max(128);
const guestBindingClaimsSchema = z.object({
  sub: presenceKeySchema,
  exp: z.number().finite(),
});

function macOf(payloadB64: string): Buffer {
  return createHmac('sha256', bindingHmacKey).update(payloadB64).digest();
}

/**
 * The guest session key changes from `g:<fpHash>` to a domain-separated,
 * one-way `g:<deriveGuestPresenceKey(fpHash)>`. In-flight old guest rows are
 * self-healing: the next /join re-keys them and stale GC removes the old row
 * within STALE_PLAYER_MS. No persisted state is touched.
 */
export function deriveGuestPresenceKey(fpHash: string): string {
  const value = z.string().min(1).max(512).parse(fpHash);
  return createHash('sha256').update(value + guestPresenceSalt).digest('hex').slice(0, 32);
}

/** Format: `<base64url(JSON payload)>.<base64url(HMAC)>`. */
export function signGuestBinding(
  presenceKey: string,
  now: number = Date.now(),
): string {
  const subject = presenceKeySchema.parse(presenceKey);
  const timestamp = z.number().finite().parse(now);
  const payloadB64 = Buffer.from(
    JSON.stringify({ sub: subject, exp: timestamp + WORLD_GUEST_BINDING_MAX_AGE_MS }),
    'utf8',
  ).toString('base64url');
  return `${payloadB64}.${macOf(payloadB64).toString('base64url')}`;
}

/** Fail closed on every malformed, forged, expired, or over-length value. */
export function verifyGuestBinding(
  cookieValue: string | undefined,
  now: number = Date.now(),
): string | null {
  if (!cookieValue || cookieValue.length > MAX_BINDING_LENGTH) return null;
  if (!Number.isFinite(now)) return null;

  const dot = cookieValue.indexOf('.');
  if (dot <= 0 || dot !== cookieValue.lastIndexOf('.') || dot === cookieValue.length - 1) {
    return null;
  }

  const payloadB64 = cookieValue.slice(0, dot);
  const macB64 = cookieValue.slice(dot + 1);
  const expectedMac = macOf(payloadB64);
  let providedMac: Buffer;
  try {
    providedMac = Buffer.from(macB64, 'base64url');
  } catch {
    return null;
  }
  if (providedMac.length !== expectedMac.length) return null;
  if (!timingSafeEqual(providedMac, expectedMac)) return null;

  try {
    const parsed = guestBindingClaimsSchema.safeParse(
      JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')),
    );
    if (!parsed.success || parsed.data.exp <= now) return null;
    return parsed.data.sub;
  } catch {
    return null;
  }
}

/**
 * Mirrors Lucia's production cookie scope. No maxAge and no expires: this is a
 * session cookie; the signed payload carries the separate server replay bound.
 */
export function guestBindingCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'None' | 'Lax';
  path: '/';
  domain?: string;
} {
  const production = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? 'None' : 'Lax',
    path: '/',
    domain: resolveSessionCookieDomain(),
  };
}
