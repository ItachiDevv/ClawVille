import { Lucia } from 'lucia';
import { DrizzlePostgreSQLAdapter } from '@lucia-auth/adapter-drizzle';
import { db, sessions, users } from '@clawville/database';
import { cookies } from 'next/headers';
import { cache } from 'react';

const adapter = new DrizzlePostgreSQLAdapter(db as any, sessions as any, users as any);

/**
 * Cookie-domain split-brain fix (2026-05-22). Mirror image of the
 * comment + helper in `apps/api/src/lib/auth.ts`. Both backends MUST
 * stay in lockstep on this attribute — drift here re-opens the split-
 * brain by having one backend's `Set-Cookie` not overwrite the
 * other's. See `docs/auth-security-recovery.md` §2 for the full
 * incident retrospective.
 *
 * Note on `sameSite`: this file historically used `'lax'` while the
 * Hono side flipped to `'none'` in prod for cross-subdomain XHR. We
 * leave that asymmetry alone because Next.js writes the cookie on
 * same-origin POSTs from clawville.world only (the api.* path writes
 * via Hono). The shared `domain=.clawville.world` is what unifies
 * them; sameSite is per-issuer and can stay tuned to its caller's
 * traffic shape.
 */
function resolveSessionCookieDomain(): string | undefined {
  const explicit = process.env.SESSION_COOKIE_DOMAIN?.trim();
  if (explicit) return explicit;
  if (process.env.NODE_ENV === 'production') return '.clawville.world';
  return undefined;
}

export const lucia = new Lucia(adapter, {
  sessionCookie: {
    attributes: {
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      domain: resolveSessionCookieDomain(),
    },
  },
  getUserAttributes: (attributes) => {
    return {
      email: attributes.email,
      name: attributes.name,
      avatarUrl: attributes.avatar_url,
    };
  },
});

declare module 'lucia' {
  interface Register {
    Lucia: typeof lucia;
    DatabaseUserAttributes: {
      email: string | null;
      name: string | null;
      avatar_url: string | null;
    };
  }
}

export const getSession = cache(async () => {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(lucia.sessionCookieName)?.value ?? null;

  if (!sessionId) {
    return { user: null, session: null };
  }

  const result = await lucia.validateSession(sessionId);

  try {
    if (result.session && result.session.fresh) {
      const sessionCookie = lucia.createSessionCookie(result.session.id);
      cookieStore.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
    }
    if (!result.session) {
      const sessionCookie = lucia.createBlankSessionCookie();
      cookieStore.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
    }
  } catch {
    // Next.js throws when you attempt to set cookie in Server Components
  }

  return result;
});
