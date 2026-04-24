/**
 * Apply 0004_guest_pet_columns.sql to the prod Supabase database.
 *
 * Additive only — adds:
 *   - users.is_guest, users.guest_expires_at
 *   - pets.is_guest
 *   - two partial indexes for the cleanup cron + leaderboard filter
 *
 * Idempotent — every statement uses IF NOT EXISTS, and the catch block
 * also tolerates the duplicate-object family of error codes if Postgres
 * decides to surface them anyway.
 *
 * Pattern lifted from apply-chunk7-migration.ts.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '..', '..', '.env.local') });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set (looked in .env.local)');
  process.exit(1);
}

const migrationPath = resolve(
  __dirname,
  '..',
  'drizzle',
  '0004_guest_pet_columns.sql',
);
const sql = readFileSync(migrationPath, 'utf-8');

// Split on the standard drizzle-kit breakpoint; keep statements that
// have at least one non-comment line. (We DO NOT skip statements just
// because they start with a comment — the SQL itself may have a
// header comment immediately followed by the DDL on the next line.)
const statements = sql
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter((s) => {
    if (s.length === 0) return false;
    const noComments = s
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim();
    return noComments.length > 0;
  });

console.log(`Applying ${statements.length} statements from ${migrationPath}`);

const client = postgres(DATABASE_URL, { prepare: false });

try {
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.split('\n')[0].slice(0, 80);
    process.stdout.write(`[${i + 1}/${statements.length}] ${preview}... `);
    try {
      await client.unsafe(stmt);
      console.log('OK');
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (
        e.code === '42P07' ||
        e.code === '42710' ||
        e.code === '42701' ||
        e.code === '42P16' ||
        e.message?.includes('already exists')
      ) {
        console.log('SKIP (already exists)');
      } else {
        console.log('FAIL');
        console.error('  ', e.message);
        throw err;
      }
    }
  }
  console.log('\nMigration applied successfully.');
} finally {
  await client.end();
}
