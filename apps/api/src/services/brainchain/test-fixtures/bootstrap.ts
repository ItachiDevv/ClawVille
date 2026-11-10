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
    // vendor_spend_ledger part of 0100_usepod_deposit.sql; its agent_ai_settings part has no fixture table.
    await sql`ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS signed_tx_b64 text`;
    await sql`ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS last_valid_block_height bigint`;
    await sql`ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS fee_lamports bigint`;
    await sql`ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS credit_status varchar(16)`;
    await sql`ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS deposit_terms jsonb`;
    await sql`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_spend_ledger_credit_status_check') THEN ALTER TABLE vendor_spend_ledger ADD CONSTRAINT vendor_spend_ledger_credit_status_check CHECK (credit_status IS NULL OR credit_status IN ('unknown', 'seen')); END IF; END $$`;
    const names = (await readdir(directory)).filter(name => /^01(?:0[1-9]|1\d)_brainchain_[a-z0-9_]+\.sql$/.test(name)).sort();
    if (names.length !== 19) throw Error('Review BrainChain fixture migration inventory');
    for (const name of names) {
      // 0107 widens these constraints. Replaying 0103 over retained result signatures would narrow them.
      if (name === '0103_brainchain_signer_records.sql' && (await sql`SELECT to_regclass('public.brainchain_signer_authorities') AS relation`)[0]?.relation) continue;
      await migration(sql, name);
    }
  } finally { await sql.end(); }
}

/** Older suites intentionally replay migrations; restore exact-consent wrappers before the next suite. */
export async function restoreBrainchainFixtureWrappers() {
  const { options } = await getBrainchainFixtureSettings();
  const sql = postgres({ ...options, max: 1, onnotice: () => {} });
  try {
    await migration(sql, '0113_brainchain_exact_result_recovery.sql');
    await migration(sql, '0116_brainchain_exact_capture.sql');
    await migration(sql, '0118_brainchain_configured_authority.sql');
    const [row] = await sql`SELECT pg_get_functiondef('brainchain_assert_recovery_submit(uuid,uuid,uuid,uuid,uuid,text,text,text,text)'::regprocedure) AS definition`;
    if (!row?.definition.includes('brainchain_exact_recovery_consent')) throw Error('Exact recovery wrapper restoration failed');
  } finally { await sql.end(); }
}
