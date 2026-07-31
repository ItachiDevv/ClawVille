import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';

process.env.FINGERPRINT_SECRET =
  process.env.FINGERPRINT_SECRET ?? 'world-guest-binding-test-secret-0000000000000000';

mock.module('../../lib/auth', () => ({
  resolveSessionCookieDomain: () =>
    process.env.NODE_ENV === 'production' ? '.clawville.world' : undefined,
}));

const {
  deriveGuestPresenceKey,
  guestBindingCookieOptions,
  signGuestBinding,
  verifyGuestBinding,
  WORLD_GUEST_BINDING_MAX_AGE_MS,
  WORLD_GUEST_COOKIE_NAME,
} = await import('../world-guest-binding');

const originalNodeEnv = process.env.NODE_ENV;
const t0 = 1_700_000_000_000;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe('world guest binding', () => {
  it('round-trips a signed presence key and expires fail-closed', () => {
    const token = signGuestBinding('presence-key', t0);
    expect(verifyGuestBinding(token, t0 + 1)).toBe('presence-key');
    expect(
      verifyGuestBinding(token, t0 + WORLD_GUEST_BINDING_MAX_AGE_MS),
    ).toBeNull();
  });

  it('fails closed on malformed, tampered, truncated, and over-length values', () => {
    const token = signGuestBinding('presence-key', t0);
    const [payload, mac] = token.split('.');
    expect(verifyGuestBinding(undefined, t0)).toBeNull();
    expect(verifyGuestBinding('', t0)).toBeNull();
    expect(verifyGuestBinding('x', t0)).toBeNull();
    expect(verifyGuestBinding(`${payload}x.${mac}`, t0)).toBeNull();
    expect(verifyGuestBinding(`${payload}.${mac!.slice(1)}`, t0)).toBeNull();
    expect(verifyGuestBinding('x'.repeat(1025), t0)).toBeNull();
  });

  it('binds exp inside the MAC-protected payload', () => {
    const token = signGuestBinding('presence-key', t0);
    const [payload, mac] = token.split('.');
    const claims = JSON.parse(
      Buffer.from(payload!, 'base64url').toString('utf8'),
    ) as { sub: string; exp: number };
    claims.exp += WORLD_GUEST_BINDING_MAX_AGE_MS;
    const editedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    expect(verifyGuestBinding(`${editedPayload}.${mac}`, t0)).toBeNull();
  });

  it('derives a deterministic, non-exposing guest key', () => {
    const fpA = 'a'.repeat(64);
    const fpB = 'b'.repeat(64);
    expect(deriveGuestPresenceKey(fpA)).toBe(deriveGuestPresenceKey(fpA));
    expect(deriveGuestPresenceKey(fpA)).not.toBe(deriveGuestPresenceKey(fpB));
    expect(deriveGuestPresenceKey(fpA)).not.toBe(fpA);
  });

  it('mirrors production and local Lucia cookie attributes', () => {
    process.env.NODE_ENV = 'production';
    const production = guestBindingCookieOptions();
    expect(production).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      path: '/',
      domain: '.clawville.world',
    });
    expect('maxAge' in production).toBe(false);
    expect('expires' in production).toBe(false);

    process.env.NODE_ENV = 'test';
    const local = guestBindingCookieOptions();
    expect(local).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
      path: '/',
    });
    expect(local.domain).toBeUndefined();
    expect('maxAge' in local).toBe(false);
    expect('expires' in local).toBe(false);
  });

  it('serializes as a session cookie with no Max-Age or Expires', async () => {
    process.env.NODE_ENV = 'test';
    const app = new Hono();
    app.get('/join', (c) => {
      setCookie(
        c,
        WORLD_GUEST_COOKIE_NAME,
        signGuestBinding('presence-key', t0),
        guestBindingCookieOptions(),
      );
      return c.json({ ok: true });
    });
    const response = await app.request('/join');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${WORLD_GUEST_COOKIE_NAME}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Max-Age');
    expect(cookie).not.toContain('Expires');
  });
});
