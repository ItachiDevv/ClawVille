import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, quests } from '@elizapets/database';
import { QUEST_SEEDS } from '@elizapets/shared';

async function seedQuests() {
  console.log('=== Seeding Quest Board ===\n');

  let inserted = 0;
  let skipped = 0;

  for (const seed of QUEST_SEEDS) {
    try {
      await db
        .insert(quests)
        .values({
          title: seed.title,
          description: seed.description,
          tier: seed.tier,
          status: 'active',
          tokenReward: seed.tokenReward,
          titleReward: seed.titleReward ?? null,
          maxCompletions: seed.maxCompletions ?? null,
          currentCompletions: 0,
          requirements: seed.requirements,
          verificationMethod: seed.verificationMethod,
        })
        .onConflictDoNothing();

      console.log(`  + ${seed.tier.padEnd(12)} ${seed.title} (${seed.tokenReward} tokens)`);
      inserted++;
    } catch (err: any) {
      // Duplicate title or other constraint — skip
      console.log(`  ~ skipped: ${seed.title} (${err.message?.slice(0, 60)})`);
      skipped++;
    }
  }

  console.log(`\nDone! Inserted: ${inserted}, Skipped: ${skipped}`);
  process.exit(0);
}

seedQuests().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
