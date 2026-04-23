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
  '0002_lively_thunderbolt_ross.sql'
);
const sql = readFileSync(migrationPath, 'utf-8');

const statements = sql
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

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
    } catch (err: any) {
      if (
        err.code === '42P07' ||
        err.code === '42710' ||
        err.code === '42701' ||
        err.message?.includes('already exists')
      ) {
        console.log('SKIP (already exists)');
      } else {
        console.log('FAIL');
        console.error('  ', err.message);
        throw err;
      }
    }
  }
  console.log('\nMigration applied successfully.');
} finally {
  await client.end();
}
