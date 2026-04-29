/**
 * Apply Phase 1 anti-farm + tutorial-quest-claims schema directly to prod
 * via the existing DATABASE_URL. Bypasses drizzle-kit because the migrate
 * folder is out of sync with prod state (repo uses db:push everywhere else).
 *
 * Run: bun packages/database/scripts/apply-phase1-migration.ts
 */

import postgres from 'postgres';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config } from 'dotenv';

config({ path: resolve(__dirname, '../../../.env.local') });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = readFileSync(resolve(__dirname, '../drizzle/phase1-targeted.sql'), 'utf-8');

const client = postgres(url, { max: 1 });

try {
  console.log('[phase1-migration] Applying schema changes...');
  await client.unsafe(sql);
  console.log('[phase1-migration] OK — events.fp_hash + events.ip_prefix_hash + tutorial_quest_claims');

  // Verify the columns/table actually landed
  const eventsCols = await client`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'events' AND column_name IN ('fp_hash', 'ip_prefix_hash')
    ORDER BY column_name
  `;
  console.log('[verify] events columns:', eventsCols.map((r) => r.column_name));

  const tableExists = await client`
    SELECT 1 FROM information_schema.tables WHERE table_name = 'tutorial_quest_claims'
  `;
  console.log('[verify] tutorial_quest_claims table exists:', tableExists.length > 0);

  const idxExists = await client`
    SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_tutorial_quest_claim_user_quest'
  `;
  console.log('[verify] unique index exists:', idxExists.length > 0);
} catch (err) {
  console.error('[phase1-migration] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
