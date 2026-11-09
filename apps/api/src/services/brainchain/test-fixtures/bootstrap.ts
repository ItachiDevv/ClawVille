import postgres from 'postgres';
import { readFile, readdir } from 'node:fs/promises';
import { getBrainchainFixtureSettings } from './database';

const directory = new URL('../../../../../../packages/database/migrations/', import.meta.url);
async function migration(sql: ReturnType<typeof postgres>, name: string) {
  await sql.unsafe(await readFile(new URL(name, directory), 'utf8'));
}

/** Fixture-only baseline. Application migration and full-schema gates remain separate. */
export async function bootstrapBrainchainFixture() {
  const { options } = await getBrainchainFixtureSettings();
  const sql = postgres({ ...options, max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY,is_guest boolean NOT NULL DEFAULT false,linked_wallet_pubkey varchar(64),linked_wallet_at timestamptz)`;
    await sql`CREATE TABLE IF NOT EXISTS avatars(id uuid PRIMARY KEY,user_id uuid,is_guest boolean NOT NULL DEFAULT false)`;
    await sql`ALTER TABLE avatars ADD COLUMN IF NOT EXISTS user_id uuid`;
    await sql`ALTER TABLE avatars ADD COLUMN IF NOT EXISTS is_guest boolean NOT NULL DEFAULT false`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_wallet_at timestamptz`;
    // Exact canonical sessions shape from packages/database/src/schema/users.ts.
    await sql`CREATE TABLE IF NOT EXISTS sessions(id varchar(255) PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at timestamp NOT NULL,created_via text)`;
    await sql`CREATE TABLE IF NOT EXISTS user_spend_policies(avatar_id uuid PRIMARY KEY,daily_cap_usd_cents integer,per_call_cap_usd_cents integer,allowed_vendors text[] NOT NULL,require_approval boolean NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`;
    await migration(sql, '0090_vendor_spend_ledger.sql');
    await sql`ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS signed_at timestamptz`;
    await sql`ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS reconcile_attempts integer NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS reconcile_next_at timestamptz`;
    const names = (await readdir(directory)).filter(name => /^01(?:0\d|1[0-7])_.*\.sql$/.test(name)).sort();
    if (names.length !== 18) throw Error('Review BrainChain fixture migration inventory');
    for (const name of names) {
      // 0106 widens these constraints. Replaying 0102 over retained result signatures would narrow them.
      if (name.startsWith('0102_') && (await sql`SELECT to_regclass('public.brainchain_signer_authorities') AS relation`)[0]?.relation) continue;
      await migration(sql, name);
    }
  } finally { await sql.end(); }
}

/** Older suites intentionally replay migrations; restore exact-consent wrappers before the next suite. */
export async function restoreBrainchainFixtureWrappers() {
  const { options } = await getBrainchainFixtureSettings();
  const sql = postgres({ ...options, max: 1, onnotice: () => {} });
  try {
    await migration(sql, '0112_brainchain_exact_result_recovery.sql');
    await migration(sql, '0115_brainchain_exact_capture.sql');
    await migration(sql, '0117_brainchain_configured_authority.sql');
    const [row] = await sql`SELECT pg_get_functiondef('brainchain_assert_recovery_submit(uuid,uuid,uuid,uuid,uuid,text,text,text,text)'::regprocedure) AS definition`;
    if (!row?.definition.includes('brainchain_exact_recovery_consent')) throw Error('Exact recovery wrapper restoration failed');
  } finally { await sql.end(); }
}
