import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, buildingSkills } from '@clawville/database';

async function main() {
  const rows = await db.select().from(buildingSkills);
  console.log(`building_skills: ${rows.length} rows`);
  for (const r of rows) {
    console.log(`  ${r.buildingId.padEnd(24)} ${String(r.content.length).padStart(6)} chars  ${r.sourceArticleIds.length} sources`);
  }

  const showBody = process.argv[2];
  if (showBody) {
    const target = rows.find((r) => r.buildingId === showBody);
    if (target) {
      console.log('\n--- SKILL.md ---\n');
      console.log(target.content);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
