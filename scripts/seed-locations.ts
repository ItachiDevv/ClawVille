import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, mapLocations } from '@legacyapp/database';
import { MAP_LOCATIONS } from '@legacyapp/shared';

async function seed() {
  console.log('Seeding map locations...');

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
