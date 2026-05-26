import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import pkg from 'pg';
const { Client } = pkg;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
console.log('[phase5.1] connected to', process.env.DATABASE_URL?.slice(0, 40), '...');

const statements: Array<[string, string]> = [
  // users — identity keypair columns
  ['users.identity_pubkey', `ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_pubkey varchar(44)`],
  ['users.identity_pubkey UNIQUE', `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_identity_pubkey_unique') THEN
        ALTER TABLE users ADD CONSTRAINT users_identity_pubkey_unique UNIQUE (identity_pubkey);
      END IF;
    END $$;
  `],
  ['users.identity_encrypted_sk', `ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_encrypted_sk text`],
  ['users.identity_iv', `ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_iv varchar(32)`],
  ['users.identity_tag', `ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_tag varchar(32)`],
  ['users.identity_dek_wrapped', `ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_dek_wrapped text`],
  ['users.identity_encryption_version', `ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_encryption_version integer NOT NULL DEFAULT 2`],

  // users — scape linking columns
  ['users.scape_principal_id', `ALTER TABLE users ADD COLUMN IF NOT EXISTS scape_principal_id varchar(128)`],
  ['users.scape_principal_id UNIQUE', `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_scape_principal_id_unique') THEN
        ALTER TABLE users ADD CONSTRAINT users_scape_principal_id_unique UNIQUE (scape_principal_id);
      END IF;
    END $$;
  `],
  ['users.scape_world_character_id', `ALTER TABLE users ADD COLUMN IF NOT EXISTS scape_world_character_id varchar(64)`],
  ['users.scape_world_character_id UNIQUE', `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_scape_world_character_id_unique') THEN
        ALTER TABLE users ADD CONSTRAINT users_scape_world_character_id_unique UNIQUE (scape_world_character_id);
      END IF;
    END $$;
  `],
  ['users.linked_scape_principal_id', `ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_scape_principal_id varchar(128)`],
  ['users.linked_scape_principal_id UNIQUE', `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_linked_scape_principal_id_unique') THEN
        ALTER TABLE users ADD CONSTRAINT users_linked_scape_principal_id_unique UNIQUE (linked_scape_principal_id);
      END IF;
    END $$;
  `],
  ['users.linked_scape_world_character_id', `ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_scape_world_character_id varchar(64)`],
  ['users.linked_scape_world_character_id UNIQUE', `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_linked_scape_world_character_id_unique') THEN
        ALTER TABLE users ADD CONSTRAINT users_linked_scape_world_character_id_unique UNIQUE (linked_scape_world_character_id);
      END IF;
    END $$;
  `],
  ['users.linked_scape_display_name', `ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_scape_display_name varchar(64)`],
  ['users.linked_scape_at', `ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_scape_at timestamptz`],

  // wallets — envelope encryption columns
  ['wallets.dek_wrapped', `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS dek_wrapped text`],
  ['wallets.encryption_version', `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS encryption_version integer NOT NULL DEFAULT 1`],

  // pending_account_links table
  ['pending_account_links CREATE', `
    CREATE TABLE IF NOT EXISTS pending_account_links (
      code varchar(32) PRIMARY KEY,
      clawville_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      remote_world varchar(64) NOT NULL,
      issued_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz
    );
  `],
  ['pending_account_links active idx', `
    CREATE INDEX IF NOT EXISTS pending_account_links_active_idx
      ON pending_account_links (expires_at)
      WHERE consumed_at IS NULL;
  `],
];

for (const [name, sql] of statements) {
  try {
    await client.query(sql);
    console.log('  ok:', name);
  } catch (err: any) {
    console.error('  FAIL:', name, '—', err.message);
    throw err;
  }
}

// Verify
const verify = await client.query(`
  SELECT
    (SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name='identity_pubkey') AS users_identity_pubkey,
    (SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name='linked_scape_display_name') AS users_linked,
    (SELECT count(*) FROM information_schema.columns WHERE table_name='wallets' AND column_name='dek_wrapped') AS wallets_dek_wrapped,
    (SELECT count(*) FROM information_schema.tables WHERE table_name='pending_account_links') AS pending_links_table
`);
console.log('[phase5.1] verification:', verify.rows[0]);

await client.end();
