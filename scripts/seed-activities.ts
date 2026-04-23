/**
 * Q2 Activity Portals — seed the `activities` catalog.
 *
 * Mirrors the pattern of `scripts/seed-locations.ts`:
 *   - Loads .env.local explicitly (script runs outside Next.js, so the
 *     dotenv hook in `@clawville/database/src/index.ts` doesn't fire
 *     reliably for plain `bun run scripts/...`).
 *   - INSERT ... ON CONFLICT DO UPDATE so re-running the script never
 *     wipes the row, only refreshes editable fields. SAFE to run more
 *     than once.
 *
 * Reads the canonical registry from `@clawville/shared` so the client
 * registry and the server catalog never drift. `coming-soon` rows are
 * inserted with `enabled=false` and an empty `reward_config: {}`.
 *
 * MIGRATION + SEED ARE BOTH FOUNDER-REVIEW STEPS — do NOT auto-run this
 * from CI. See chunk #1 plan: schema review, then `bun run db:push`,
 * then this seed, in that order.
 *
 * Usage (after founder approves the schema):
 *   bun run scripts/seed-activities.ts
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, activities } from '@clawville/database';
import { ACTIVITY_REGISTRY } from '@clawville/shared';

async function seed() {
  console.log('Seeding activities catalog...');

  let liveCount = 0;
  let stubCount = 0;

  for (const def of ACTIVITY_REGISTRY) {
    const isLive = def.status === 'live';
    const rewardConfig = def.rewardConfig ?? {};

    await db
      .insert(activities)
      .values({
        id: def.id,
        buildingId: def.buildingId,
        slug: def.id,
        displayName: def.title,
        description: def.tagline,
        minPlayers: def.minPlayers,
        maxPlayers: def.maxPlayers,
        preferredPlayers: def.maxPlayers,
        rewardConfig,
        enabled: isLive,
      })
      .onConflictDoUpdate({
        target: activities.id,
        set: {
          buildingId: def.buildingId,
          slug: def.id,
          displayName: def.title,
          description: def.tagline,
          minPlayers: def.minPlayers,
          maxPlayers: def.maxPlayers,
          preferredPlayers: def.maxPlayers,
          rewardConfig,
          enabled: isLive,
          updatedAt: new Date(),
        },
      });

    if (isLive) liveCount++;
    else stubCount++;

    const tag = isLive ? 'LIVE     ' : 'coming...';
    console.log(`  ${tag} ${def.id.padEnd(22)} → ${def.buildingId}`);
  }

  console.log(
    `Done! Seeded ${ACTIVITY_REGISTRY.length} activities (${liveCount} live, ${stubCount} coming-soon).`,
  );
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
