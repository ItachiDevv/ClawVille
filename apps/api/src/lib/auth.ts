import { Lucia } from 'lucia';
import { DrizzlePostgreSQLAdapter } from '@lucia-auth/adapter-drizzle';
import { db, sessions, users } from '@clawville/database';

const adapter = new DrizzlePostgreSQLAdapter(db, sessions, users);

export const lucia = new Lucia(adapter, {
  sessionCookie: {
    attributes: {
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
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
