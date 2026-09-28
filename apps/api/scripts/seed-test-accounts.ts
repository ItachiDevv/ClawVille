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
 * The DB URL is read ONLY from `SEED_DATABASE_URL`. There is NO fallback to
 * DATABASE_URL / .env.local. The script creates its OWN `postgres()` client from
 * that URL and never touches the auto-connecting `@clawville/database`
 * `db` proxy (only the pure table DEFINITIONS are imported, which do not connect).
 * Before ANY write it reads the database's own marker: it proceeds only when
 * `clawville.env` is 'staging' (self-hosted staging, reached through the
 * `127.0.0.1:15432` SSH tunnel since 2026-09-25), or when there is no marker and
 * the URL names the legacy staging Supabase project exactly (pooler user
 * `postgres.<ref>` on a Supabase pooler host, or host `db.<ref>.supabase.co`).
 * Each fixture is written in one transaction whose first statement re-reads the
 * marker; a mismatch with that pre-check rolls the fixture back and stops.
 * The URL is a secret: never logged, echoed, or printed.
 *
 * RUN (staging only):
 *   SEED_DATABASE_URL="<staging url: tunnel or legacy session-pooler>" \
 *     bun run apps/api/scripts/seed-test-accounts.ts
 *
 * Idempotent: re-running reuses the same users/avatars (matched by email/name) and
 * just mints a FRESH session (so you always get a live cookie). Prints, per account:
 * email, password (for manual form login), the `auth_session` cookie, userId, avatarId.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
// Pure table DEFINITIONS only — importing these does NOT open a DB connection
// (the `db` proxy connects on first USE, which we never trigger; we use our own
// explicit client below).
import { users, avatars, sessions } from '@clawville/database';
import {
  DATABASE_ENV_MARKER_SQL,
  DatabaseEnvMarkerError,
  assertWriteTargetMarker,
  namesSupabaseProject,
  resolveDatabaseEnvMarker,
  type DatabaseEnvMarkerRow,
} from './db-env-marker';

// ── 0. HARD staging guard ────────────────────────────────────────────────────
const STAGING_REF = 'mtpixvtclsjqjguouxes'; // legacy staging Supabase project ref
const SEED_URL = process.env.SEED_DATABASE_URL;
if (!SEED_URL) {
  console.error('❌ SEED_DATABASE_URL is required (this script is STAGING-ONLY).');
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
  /** Human note on what this account is for (surfaced in the printout + docs). */
  note?: string;
}
const FIXTURES: Fixture[] = [
  ...Array.from({ length: COUNT }, (_, i): Fixture => {
    const n = i + 1;
    return {
      email: `landtest${n}@staging.clawville.test`,
      username: `landtest${n}`,
      name: `Land Test ${n}`,
      avatarName: `LandTest${n}`,
      note: 'general authed staging tests (land buy/claim, cove, quests)',
    };
  }),
  // ── the persistent TEST HERMES AGENT (bounty end-to-end test worker) ────────
  // The single ClawVille agent we drive through the bounty flow end-to-end.
  // RETIRED SCOPE (2026-08-20): this account existed for the Metaplex
  // verified-identity milestone, which rode the OOBE/SAP escrow rail — that
  // partner and its rails were removed on founder order, so the identity-mint
  // milestone is dead. The account is KEPT as the standing bounty test worker
  // for the surviving rail (custodial hold → PayAI payout). Its custodial
  // Solana wallet is provisioned separately, not by this account seed.
  {
    email: 'hermestest@staging.clawville.test',
    username: 'hermestest',
    name: 'Hermes Test Agent',
    avatarName: 'HermesTest',
    note: 'PERSISTENT test Hermes agent — standing bounty-worker for end-to-end bounty tests. See docs/staging-test-accounts.md.',
  },
];

async function main() {
  const client = postgres(SEED_URL!, { max: 1 });
  // The self-hosted staging URL names no project, so the database's own marker decides. It is
  // read from the catalog, so a URL option or role setting cannot fake it (db-env-marker.ts).
  let env: string | null;
  try {
    const [row] = await client.unsafe<DatabaseEnvMarkerRow[]>(DATABASE_ENV_MARKER_SQL);
    env = resolveDatabaseEnvMarker(row);
  } catch (error) {
    await client.end();
    if (!(error instanceof DatabaseEnvMarkerError)) throw error;
    console.error(`❌ REFUSING: ${error.message}. This script must NEVER run against prod.`);
    process.exit(1);
  }
  // Legacy fallback: the exact staging Supabase identity (pooler user or direct host), not the
  // ref anywhere in the URL text (a password or query parameter would match that).
  if (env !== 'staging' && !(env === null && namesSupabaseProject(SEED_URL!, STAGING_REF))) {
    await client.end();
    console.error(
      `❌ REFUSING: SEED_DATABASE_URL is not the staging DB (needs clawville.env=staging, or no marker and "${STAGING_REF}"). ` +
        'This script must NEVER run against prod.',
    );
    process.exit(1);
  }
  const db = drizzle(client);
  const passwordHash = await Bun.password.hash(PASSWORD, { algorithm: 'bcrypt', cost: 10 });
  const out: Array<Record<string, string>> = [];

  const preCheck = env;
  try {
    for (const fx of FIXTURES) {
      // One transaction per fixture. Its FIRST statement re-reads the marker on the connection
      // that writes; a mismatch with the pre-check throws and rolls the fixture back.
      const { userId, avatarId, sessionId } = await db.transaction(async (tx) => {
        await assertWriteTargetMarker(async (query) => await tx.execute(sql.raw(query)), preCheck);

        // 1. upsert user (match by email)
        const existingUser = await tx.select().from(users).where(eq(users.email, fx.email)).limit(1);
        let userId: string;
        if (existingUser[0]) {
          userId = existingUser[0].id;
          await tx.update(users)
            .set({ passwordHash, emailVerified: true, name: fx.name, username: fx.username })
            .where(eq(users.id, userId));
        } else {
          const inserted = await tx.insert(users).values({
            email: fx.email,
            passwordHash,
            emailVerified: true,
            name: fx.name,
            username: fx.username,
          }).returning({ id: users.id });
          userId = inserted[0].id;
        }

        // 2. upsert avatar (one per user — match by userId). Generous CT for buy-tests.
        const existingAvatar = await tx.select().from(avatars).where(eq(avatars.userId, userId)).limit(1);
        let avatarId: string;
        if (existingAvatar[0]) {
          avatarId = existingAvatar[0].id;
          // F1: mirror clawTokens into softBalance so avatars_vclaw_balance_sum holds
          // (100_000 = 100_000+0+0). This UPDATE would otherwise leave the tags stale
          // and violate the CHECK. Test CT is SOFT (non-cashable).
          await tx
            .update(avatars)
            .set({ clawTokens: 100_000, softBalance: 100_000, boughtBalance: 0, earnedBalance: 0 })
            .where(eq(avatars.id, avatarId));
        } else {
          const insertedAv = await tx.insert(avatars).values({
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
        await tx.delete(sessions).where(eq(sessions.userId, userId));
        const sessionId =
          crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
        await tx.insert(sessions).values({ id: sessionId, userId, expiresAt });
        return { userId, avatarId, sessionId };
      });

      out.push({
        email: fx.email,
        password: PASSWORD,
        cookie: `auth_session=${sessionId}`,
        userId,
        avatarId,
        avatarName: fx.avatarName,
        clawTokens: '100000',
        note: fx.note ?? '',
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
    if (a.note) console.log(`     note    : ${a.note}`);
    console.log('');
  }
  console.log('Session cookie is Lucia\'s default `auth_session`. The session lives',
    SESSION_TTL_DAYS, 'days — re-run to refresh.\n');
}

main().catch((err) => {
  if (err instanceof DatabaseEnvMarkerError) {
    console.error(`❌ REFUSING: ${err.message}. Fixtures written before the change stay; the current one rolled back.`);
    process.exit(1);
  }
  console.error('seed-test-accounts failed:', err);
  process.exit(1);
});
