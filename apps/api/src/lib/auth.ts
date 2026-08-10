import { Lucia } from 'lucia';
import { DrizzlePostgreSQLAdapter } from '@lucia-auth/adapter-drizzle';
import { db, sessions, users } from '@clawville/database';

const adapter = new DrizzlePostgreSQLAdapter(db, sessions, users);

/**
 * Cookie-domain split-brain fix (2026-05-22).
 *
 * Background: ClawVille has two co-equal backends both running Lucia
 * against the same `sessions` table — Hono at `api.clawville.world`
 * and Next.js at `clawville.world`. Until this commit neither set a
 * `domain` attribute, so each issued a HOST-ONLY cookie scoped to the
 * origin that minted it. Result: signup/login through the canonical
 * `apps/web/src/lib/api.ts` path (which hits api.clawville.world)
 * created a session cookie ONLY visible to api.*. Any Next.js route
 * under clawville.world that tried `validateSession()` saw no cookie
 * and 401'd, even though the user was fully authenticated on the
 * other half of the same site. Real incident: 2026-05-22, user
 * `RenameTester / 30a1dc7d-…` — authenticated UI rendered from
 * api.clawville.world while clawville.world/api/auth/me reported 401.
 *
 * Fix: in production set `domain: '.clawville.world'` (leading dot is
 * the modern equivalent of "this domain and all subdomains" — browsers
 * normalize a missing dot in practice but the dotted form is explicit
 * and well-supported). In dev keep host-only so localhost:3000 and
 * localhost:4000 stay isolated (they're treated as the same host by
 * browsers — port is NOT part of cookie scope, so any leak there is a
 * dev-only quirk we accept).
 *
 * Configurable via SESSION_COOKIE_DOMAIN env var for staging /
 * preview deploys with a different apex. Falls back to
 * `.clawville.world` in production, undefined elsewhere.
 *
 * Migration impact: cookies issued BEFORE this deploy remain
 * host-only and will keep working ONLY on the subdomain that minted
 * them. New cookies issued AFTER this deploy will cover both.
 * Practical UX: users authed via api.clawville.world (the canonical
 * signup/login flow) keep their session active on api.* until expiry;
 * the next login OR explicit re-login will unify the cookie across
 * both subdomains. Forcing a global re-login was considered but
 * rejected — Lucia session TTL is short enough (refresh on each
 * fresh-cookie request) that natural rotation completes in <24h.
 */
export function resolveSessionCookieDomain(): string | undefined {
  const explicit = process.env.SESSION_COOKIE_DOMAIN?.trim();
  if (explicit) return explicit;
  if (process.env.NODE_ENV === 'production') return '.clawville.world';
  return undefined;
}

export const lucia = new Lucia(adapter, {
  sessionCookie: {
    attributes: {
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      domain: resolveSessionCookieDomain(),
    },
  },
  getUserAttributes: (attributes) => {
    return {
      email: attributes.email,
      name: attributes.name,
      avatarUrl: attributes.avatar_url,
      // Username system (added 2026-05-19). Surfaced on the Lucia user
      // object so c.get('user').username is available wherever
      // sessionMiddleware/requireAuth runs — no extra DB hit needed in
      // the username-edit + check-name flows.
      username: attributes.username,
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
      username: string | null;
    };
  }
}
