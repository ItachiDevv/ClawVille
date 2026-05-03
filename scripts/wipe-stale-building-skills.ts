import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, buildingSkills } from '@clawville/database';
import { notInArray } from 'drizzle-orm';
import { SHOP_BUILDINGS } from '@clawville/shared';

async function wipe() {
  const validIds = [...SHOP_BUILDINGS, 'clawville-play'];
  const stale = await db
    .delete(buildingSkills)
    .where(notInArray(buildingSkills.buildingId, validIds))
    .returning({ id: buildingSkills.buildingId });
  console.log(`Pruned ${stale.length} stale building_skills rows: ${stale.map((r) => r.id).join(', ')}`);
  console.log('Run `bun run scripts/generate-building-skills.ts` to regenerate skills with the new IDs.');
  process.exit(0);
}

wipe().catch((err) => {
  console.error(err);
  process.exit(1);
});
