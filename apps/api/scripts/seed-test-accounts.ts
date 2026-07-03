/**
 * seed-test-accounts.ts — persistent STAGING test accounts for self-serve authed testing.
 * ============================================================================
 *
 * WHY
 * ---
 * Authed flows (land buy/claim, cove settlement, quests, etc.) can't be driven by
 * a guest. Until now, verifying them needed either the founder to log in manually
 * or the ephemeral mock-Hatcher harness. This seeds a few PERMANENT, clearly-labeled
 * test accounts (user + avatar + a long-lived session) so any session can drive an
 * authed request with a session cookie, and the founder can also log in normally.
 *
 * STAGING-ONLY — HARD GUARDED (the prod-write incident, 2026-06-16)
 * ----------------------------------------------------------------
 * The DB URL is read ONLY from `SEED_DATABASE_URL` and is asserted to be the
 * staging Supabase ref before ANY connection. There is NO fallback to
 * DATABASE_URL / .env.local. The script creates its OWN `postgres()` client from
 * that asserted URL and never touches the auto-connecting `@clawville/database`
 * `db` proxy (only the pure table DEFINITIONS are imported, which do not connect).
 * The URL is a secret: never logged, echoed, or printed.
 *
 * RUN (staging only):
 *   SEED_DATABASE_URL="<staging session-pooler url>" \
 *     bun run apps/api/scripts/seed-test-accounts.ts
 *
 * Idempotent: re-running reuses the same users/avatars (matched by email/name) and
 * just mints a FRESH session (so you always get a live cookie). Prints, per account:
 * email, password (for manual form login), the `auth_session` cookie, userId, avatarId.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
// Pure table DEFINITIONS only — importing these does NOT open a DB connection
// (the `db` proxy connects on first USE, which we never trigger; we use our own
// explicit client below).
import { users, avatars, sessions } from '@clawville/database';

// ── 0. HARD staging guard ────────────────────────────────────────────────────
const STAGING_REF = 'mtpixvtclsjqjguouxes'; // staging Supabase project ref
const SEED_URL = process.env.SEED_DATABASE_URL;
if (!SEED_URL) {
  console.error('❌ SEED_DATABASE_URL is required (this script is STAGING-ONLY).');
  process.exit(1);
}
if (!SEED_URL.includes(STAGING_REF)) {
  console.error(
    `❌ REFUSING: SEED_DATABASE_URL is not the staging DB (must contain "${STAGING_REF}"). ` +
      'This script must NEVER run against prod.',
  );
  process.exit(1);
}

// ── account fixtures ─────────────────────────────────────────────────────────
const PASSWORD = 'LandTest!2026'; // shared known password for manual form-login
// 3rd account added 2026-07-03: restart-survival-proof.ts needs a VIRGIN user
// (identityPubkey still NULL) so first-connect returns the identity secretKey
// needed to sign the /reconnect challenge. landtest1/2 burned theirs in the
// 2026-07-02 connected-agent e2e runs. Idempotent: existing accounts untouched.
const COUNT = 3;
const SESSION_TTL_DAYS = 90;

interface Fixture {
  email: string;
  username: string;
  name: string;
  avatarName: string;
}
const FIXTURES: Fixture[] = Array.from({ length: COUNT }, (_, i) => {
  const n = i + 1;
  return {
    email: `landtest${n}@staging.clawville.test`,
    username: `landtest${n}`,
    name: `Land Test ${n}`,
    avatarName: `LandTest${n}`,
  };
});

async function main() {
  const client = postgres(SEED_URL!, { max: 1 });
  const db = drizzle(client);
  const passwordHash = await Bun.password.hash(PASSWORD, { algorithm: 'bcrypt', cost: 10 });
  const out: Array<Record<string, string>> = [];

  try {
    for (const fx of FIXTURES) {
      // 1. upsert user (match by email)
      const existingUser = await db.select().from(users).where(eq(users.email, fx.email)).limit(1);
      let userId: string;
      if (existingUser[0]) {
        userId = existingUser[0].id;
        await db.update(users)
          .set({ passwordHash, emailVerified: true, name: fx.name, username: fx.username })
          .where(eq(users.id, userId));
      } else {
        const inserted = await db.insert(users).values({
          email: fx.email,
          passwordHash,
          emailVerified: true,
          name: fx.name,
          username: fx.username,
        }).returning({ id: users.id });
        userId = inserted[0].id;
      }

      // 2. upsert avatar (one per user — match by userId). Generous CT for buy-tests.
      const existingAvatar = await db.select().from(avatars).where(eq(avatars.userId, userId)).limit(1);
      let avatarId: string;
      if (existingAvatar[0]) {
        avatarId = existingAvatar[0].id;
        // F1: mirror clawTokens into softBalance so avatars_vclaw_balance_sum holds
        // (100_000 = 100_000+0+0). This UPDATE would otherwise leave the tags stale
        // and violate the CHECK. Test CT is SOFT (non-cashable).
        await db
          .update(avatars)
          .set({ clawTokens: 100_000, softBalance: 100_000, boughtBalance: 0, earnedBalance: 0 })
          .where(eq(avatars.id, avatarId));
      } else {
        const insertedAv = await db.insert(avatars).values({
          userId,
          name: fx.avatarName,
          species: 'fox',
          color: 'blue',
          gender: 'male',
          archetype: 'explorer',
          personality: { habitat: 'staging', hobby: 'testing', greeting: 'gm' },
          stats: { strength: 5, defence: 5, movement: 5 },
          clawTokens: 100_000,
          // F1: mirror into softBalance so avatars_vclaw_balance_sum holds. SOFT.
          softBalance: 100_000,
        }).returning({ id: avatars.id });
        avatarId = insertedAv[0].id;
      }

      // 3. fresh long-lived session (delete any prior test sessions for this user first)
      await db.delete(sessions).where(eq(sessions.userId, userId));
      const sessionId =
        crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
      const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
      await db.insert(sessions).values({ id: sessionId, userId, expiresAt });

      out.push({
        email: fx.email,
        password: PASSWORD,
        cookie: `auth_session=${sessionId}`,
        userId,
        avatarId,
        avatarName: fx.avatarName,
        clawTokens: '100000',
      });
    }
  } finally {
    await client.end();
  }

  console.log('\n✅ Seeded', out.length, 'STAGING test accounts (idempotent re-run = fresh sessions):\n');
  for (const a of out) {
    console.log(`  ── ${a.avatarName} ───────────────────────────────`);
    console.log(`     email   : ${a.email}`);
    console.log(`     password: ${a.password}   (manual form login)`);
    console.log(`     cookie  : ${a.cookie}   (drive authed API: -H "Cookie: <this>")`);
    console.log(`     userId  : ${a.userId}`);
    console.log(`     avatarId: ${a.avatarId}   CT: ${a.clawTokens}`);
    console.log('');
  }
  console.log('Session cookie is Lucia\'s default `auth_session`. The session lives',
    SESSION_TTL_DAYS, 'days — re-run to refresh.\n');
}

main().catch((err) => {
  console.error('seed-test-accounts failed:', err);
  process.exit(1);
});
