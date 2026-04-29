/**
 * Apply dashboard_phases schema + initial seed to prod.
 * Run: bun packages/database/scripts/apply-dashboard-phases.ts
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

const sql = readFileSync(resolve(__dirname, '../drizzle/dashboard-phases.sql'), 'utf-8');
const client = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  console.log('[dashboard-phases] Applying schema + seed...');
  await client.unsafe(sql);
  const rows = await client`SELECT slug, status, sort_order FROM dashboard_phases ORDER BY sort_order`;
  console.log('[dashboard-phases] Seeded:');
  for (const r of rows) console.log(`  ${String(r.sort_order).padStart(2)}. ${r.slug.padEnd(20)} → ${r.status}`);
} catch (err) {
  console.error('[dashboard-phases] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
