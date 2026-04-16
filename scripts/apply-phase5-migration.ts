/**
 * Phase 5 migration applier.
 *
 * drizzle-kit push asks an interactive question ("truncate users?")
 * when adding a UNIQUE constraint to a populated table. We always want
 * "No", so do the migration by hand — each statement is idempotent.
 *
 * Operations:
 *   1. users.email DROP NOT NULL
 *   2. users.password_hash DROP NOT NULL
 *   3. users.identity_fingerprint ADD COLUMN
 *   4. users_identity_fingerprint_unique UNIQUE
 *   5. users_has_auth_method CHECK constraint
 *   6. agent_session_tickets CREATE TABLE + INDEX
 *
 * Safe to run multiple times — every statement checks existence first.
 */

import pg from 'pg';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const STATEMENTS: { label: string; sql: string }[] = [
  { label: 'users.email DROP NOT NULL', sql: 'ALTER TABLE users ALTER COLUMN email DROP NOT NULL' },
  { label: 'users.password_hash DROP NOT NULL', sql: 'ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL' },
  {
    label: 'users.identity_fingerprint ADD COLUMN',
    sql: `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'users' AND column_name = 'identity_fingerprint'
        ) THEN
          ALTER TABLE users ADD COLUMN identity_fingerprint varchar(64);
        END IF;
      END $$
    `,
  },
  {
    label: 'users_identity_fingerprint_unique',
    sql: `
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_identity_fingerprint_unique') THEN
          ALTER TABLE users ADD CONSTRAINT users_identity_fingerprint_unique UNIQUE (identity_fingerprint);
        END IF;
      END $$
    `,
  },
  {
    label: 'users_has_auth_method CHECK',
    sql: `
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_has_auth_method') THEN
          ALTER TABLE users ADD CONSTRAINT users_has_auth_method CHECK (
            (email IS NOT NULL AND password_hash IS NOT NULL)
            OR identity_fingerprint IS NOT NULL
          );
        END IF;
      END $$
    `,
  },
  {
    label: 'agent_session_tickets CREATE TABLE',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_session_tickets (
        ticket text PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        avatar_id uuid REFERENCES avatars(id) ON DELETE CASCADE,
        issued_to_agent_session varchar(64),
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        consumed_at timestamptz,
        identity_type varchar(16) NOT NULL,
        identity_key text,
        CONSTRAINT ticket_ttl CHECK (expires_at > created_at)
      )
    `,
  },
  {
    label: 'agent_session_tickets_expires_idx',
    sql: `
      CREATE INDEX IF NOT EXISTS agent_session_tickets_expires_idx
        ON agent_session_tickets (expires_at)
        WHERE consumed_at IS NULL
    `,
  },
];

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // Run the column additions + UNIQUE first, THEN backfill synthetic
    // fingerprints for any rows that would otherwise fail the CHECK,
    // THEN add the CHECK. Reordering so the backfill happens after the
    // column is guaranteed present avoids the chicken-and-egg problem
    // where the first-ever run has no column to backfill into.
    //
    // Index 0..3 = email nullable, password_hash nullable, add column,
    //              UNIQUE constraint
    // Index 4    = the CHECK constraint (runs AFTER backfill)
    // Index 5..6 = agent_session_tickets table + index
    for (const { label, sql } of STATEMENTS.slice(0, 4)) {
      try {
        await client.query(sql);
        console.log(`  ok: ${label}`);
      } catch (err: unknown) {
        const msg = (err as Error).message;
        console.error(`  FAIL ${label}: ${msg}`);
        throw err;
      }
    }

    // Backfill synthetic identity_fingerprint for rows without any auth
    // method — these are legacy test/system rows (e.g.
    // `openclaw-system@clawville.internal` with no password). Using
    // `legacy:{uuid}` as the identity_key means the fingerprint can
    // never collide with a real agent-presented one.
    const backfill = await client.query(`
      UPDATE users
         SET identity_fingerprint = encode(digest('legacy:' || id::text, 'sha256'), 'hex')
       WHERE identity_fingerprint IS NULL
         AND NOT (email IS NOT NULL AND password_hash IS NOT NULL)
      RETURNING id
    `);
    console.log(`  ok: backfilled ${backfill.rows.length} legacy user(s) with synthetic identity_fingerprint`);

    for (const { label, sql } of STATEMENTS.slice(4)) {
      try {
        await client.query(sql);
        console.log(`  ok: ${label}`);
      } catch (err: unknown) {
        const code = (err as { code?: string } | null)?.code;
        const msg = (err as Error).message;
        if (code === '23514' && label.includes('users_has_auth_method')) {
          const bad = await client.query(
            `SELECT id, email, password_hash IS NOT NULL AS has_pw, identity_fingerprint FROM users
             WHERE NOT (
               (email IS NOT NULL AND password_hash IS NOT NULL)
               OR identity_fingerprint IS NOT NULL
             )`,
          );
          console.error(`  FAIL ${label}: ${msg}`);
          console.error('  violators:', bad.rows);
          throw err;
        }
        console.error(`  FAIL ${label}: ${msg}`);
        throw err;
      }
    }

    const checks = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'identity_fingerprint')::int AS users_col,
        (SELECT COUNT(*) FROM pg_constraint WHERE conname = 'users_has_auth_method')::int AS users_check,
        (SELECT COUNT(*) FROM pg_constraint WHERE conname = 'users_identity_fingerprint_unique')::int AS users_unique,
        (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'agent_session_tickets')::int AS tickets_table,
        (SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'agent_session_tickets_expires_idx')::int AS tickets_idx
    `);
    console.log('[phase5] verification:', checks.rows[0]);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[phase5] fatal:', err);
  process.exit(1);
});
