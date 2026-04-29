/**
 * Apply Phase 3 cosmetic engine schema directly to prod via DATABASE_URL.
 * Same out-of-band pattern as apply-phase1-migration.ts.
 *
 * Run: bun packages/database/scripts/apply-phase3-migration.ts
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

const sql = readFileSync(resolve(__dirname, '../drizzle/phase3-cosmetics.sql'), 'utf-8');

const client = postgres(url, { max: 1 });

try {
  console.log('[phase3-migration] Applying cosmetic engine schema...');
  await client.unsafe(sql);
  console.log('[phase3-migration] OK — cosmetic_skus + cosmetic_variants + avatar_skins');

  // Verify
  const tables = await client`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('cosmetic_skus', 'cosmetic_variants', 'avatar_skins')
    ORDER BY table_name
  `;
  console.log('[verify] tables:', tables.map((r) => r.table_name));

  const idxs = await client`
    SELECT indexname FROM pg_indexes
    WHERE indexname IN (
      'idx_cosmetic_skus_scope',
      'idx_cosmetic_skus_avail_until',
      'uniq_cosmetic_variant_sku_rig',
      'uniq_pet_skin_pet_sku',
      'idx_pet_skin_pet_equipped'
    )
    ORDER BY indexname
  `;
  console.log('[verify] indexes:', idxs.map((r) => r.indexname));
} catch (err) {
  console.error('[phase3-migration] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
