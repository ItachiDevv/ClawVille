import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, mapLocations } from '@clawville/database';
import { notInArray } from 'drizzle-orm';
import { MAP_LOCATIONS } from '@clawville/shared';

async function seed() {
  console.log('Seeding map locations...');

  // Demo-mode rename pass (2026-05-03): drop any rows whose IDs are NOT in
  // the canonical MAP_LOCATIONS. Catches old kebab-case IDs (cron-hub,
  // canvas-studio, voice-tower, etc.) left behind from prior shape so the
  // SHOP_BUILDINGS check + 3D arena lookup match exactly.
  const validIds = MAP_LOCATIONS.map((l) => l.id);
  const stale = await db
    .delete(mapLocations)
    .where(notInArray(mapLocations.id, validIds))
    .returning({ id: mapLocations.id });
  if (stale.length > 0) {
    console.log(`  Pruned stale rows: ${stale.map((r) => r.id).join(', ')}`);
  }

  for (const location of MAP_LOCATIONS) {
    await db
      .insert(mapLocations)
      .values(location)
      .onConflictDoUpdate({
        target: mapLocations.id,
        set: {
          name: location.name,
          description: location.description,
          icon: location.icon,
          positionX: location.positionX,
          positionY: location.positionY,
          width: location.width,
          height: location.height,
        },
      });
    console.log(`  Seeded: ${location.name}`);
  }

  console.log(`Done! Seeded ${MAP_LOCATIONS.length} locations.`);
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
