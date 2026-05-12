/**
 * Apply wager lobby + escrow schema to prod / dev DB.
 *
 * Run from repo root:
 *   bun packages/database/scripts/apply-wager-migration.ts
 *
 * Idempotent — re-running is a no-op. Order:
 *   1. ALTER TYPE treasury_purpose ADD VALUE 'wager-settlement-authority'
 *   2. CREATE SEQUENCE wager_lobby_id_seq
 *   3. CREATE TABLE lobbies / lobby_players / lobby_events + indexes + checks
 *
 * IMPORTANT: postgres.js cannot run ALTER TYPE ... ADD VALUE inside a
 * transaction block. We split the file into statements and run them
 * sequentially as separate top-level statements via `client.unsafe()`,
 * which executes them one at a time without an implicit BEGIN/COMMIT.
 */

import postgres from 'postgres';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config } from 'dotenv';

config({ path: resolve(__dirname, '../../../.env.local') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sqlPath = resolve(__dirname, '../drizzle/wager-lobbies.sql');
const fullSql = readFileSync(sqlPath, 'utf-8');

const client = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  console.log('[wager] Applying wager schema from', sqlPath);
  await client.unsafe(fullSql);

  const seqRow = await client`
    SELECT last_value FROM "wager_lobby_id_seq"
  `;
  console.log(`[wager] wager_lobby_id_seq last_value = ${seqRow[0]?.last_value}`);

  const tableCounts = await client`
    SELECT
      (SELECT count(*) FROM "lobbies") AS lobbies,
      (SELECT count(*) FROM "lobby_players") AS lobby_players,
      (SELECT count(*) FROM "lobby_events") AS lobby_events
  `;
  console.log('[wager] row counts:', tableCounts[0]);

  const enumLabels = await client`
    SELECT e.enumlabel
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'treasury_purpose'
    ORDER BY e.enumsortorder
  `;
  console.log(
    '[wager] treasury_purpose enum values:',
    enumLabels.map((r) => r.enumlabel).join(', '),
  );

  console.log('[wager] ✓ migration applied');
} catch (err) {
  console.error('[wager] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
