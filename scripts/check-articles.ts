import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, researchArticles } from '@clawville/database';

async function main() {
  const rows = await db.select().from(researchArticles);
  const byBuilding = new Map<string, { total: number; success: number; chars: number }>();

  for (const r of rows) {
    const b = byBuilding.get(r.locationId) ?? { total: 0, success: 0, chars: 0 };
    b.total += 1;
    if (r.scrapeStatus === 'success') {
      b.success += 1;
      b.chars += (r.content ?? '').length;
    }
    byBuilding.set(r.locationId, b);
  }

  console.log('building_id           total  success  total_chars');
  console.log('-'.repeat(55));
  for (const [id, s] of Array.from(byBuilding.entries()).sort()) {
    console.log(`${id.padEnd(22)} ${String(s.total).padStart(4)}     ${String(s.success).padStart(4)}   ${String(s.chars).padStart(8)}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
