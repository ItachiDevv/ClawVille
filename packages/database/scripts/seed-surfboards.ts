/**
 * Q3 plan §4 (content track) — first cosmetic content drop.
 *
 * Seeds 4 surfboard SKUs from the Reef Race v2 session into cosmetic_skus
 * + cosmetic_variants. Each board:
 *   - scope: 'activity:reef-race' (only renders in Reef Race scene)
 *   - category: 'board'
 *   - rigType: 'reef-race-board' (variant attaches to player position
 *     in the activity scene, not bone-anchored)
 *   - license: CC-BY 4.0 (per ATTRIBUTIONS.md)
 *
 * Idempotent — re-runs UPSERT by slug.
 *
 * Run: bun packages/database/scripts/seed-surfboards.ts
 */

import postgres from 'postgres';
import { resolve } from 'path';
import { config } from 'dotenv';

config({ path: resolve(__dirname, '../../../.env.local') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const ATTRIBUTION = 'Surfboard mesh by Anna Denisova / Saritasa — CC BY 4.0';
const ATTRIBUTION_URL =
  'https://sketchfab.com/3d-models/game-ready-free-surfboards-e79d7347ea4e4d6fbb649200d4911592';
const LICENSE = 'CC-BY-4.0';

interface BoardSeed {
  slug: string;
  displayName: string;
  description: string;
  rarity: 'common' | 'rare' | 'epic';
  priceCt: number;
  glbPath: string;
}

const BOARDS: BoardSeed[] = [
  {
    slug: 'surfboard-classic-blue',
    displayName: 'Classic Blue Surfboard',
    description: 'A clean blue longboard. Stock starter board for the reef.',
    rarity: 'common',
    priceCt: 200,
    glbPath: '/models/reef-race/surfboards/surfboard_1.glb',
  },
  {
    slug: 'surfboard-sunset-orange',
    displayName: 'Sunset Orange Surfboard',
    description: 'Burnt-orange shortboard, paddles fast off the line.',
    rarity: 'common',
    priceCt: 200,
    glbPath: '/models/reef-race/surfboards/surfboard_2.glb',
  },
  {
    slug: 'surfboard-coral-pink',
    displayName: 'Coral Pink Surfboard',
    description: 'Coral-pink finish. Pairs with the reef.',
    rarity: 'rare',
    priceCt: 350,
    glbPath: '/models/reef-race/surfboards/surfboard_3.glb',
  },
  {
    slug: 'surfboard-deep-purple',
    displayName: 'Deep Purple Surfboard',
    description: 'Deep purple twin-fin. Built for hairpin lines.',
    rarity: 'rare',
    priceCt: 350,
    glbPath: '/models/reef-race/surfboards/surfboard_4.glb',
  },
];

const client = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  console.log('[seed-surfboards] Upserting 4 SKUs + 4 variants...');

  for (const b of BOARDS) {
    // 1. Upsert the SKU. Use ON CONFLICT (slug) so re-running doesn't
    //    duplicate but DOES refresh display fields.
    const [sku] = await client<[{ id: string }]>`
      INSERT INTO cosmetic_skus (
        slug, category, scope, display_name, description, rarity,
        price_ct, attribution, attribution_url, license_spdx
      ) VALUES (
        ${b.slug}, 'board', 'activity:reef-race', ${b.displayName},
        ${b.description}, ${b.rarity}, ${b.priceCt},
        ${ATTRIBUTION}, ${ATTRIBUTION_URL}, ${LICENSE}
      )
      ON CONFLICT (slug) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        rarity = EXCLUDED.rarity,
        price_ct = EXCLUDED.price_ct,
        attribution = EXCLUDED.attribution,
        attribution_url = EXCLUDED.attribution_url,
        license_spdx = EXCLUDED.license_spdx
      RETURNING id
    `;

    // 2. Upsert the variant. cosmetic_variants has unique (sku_id, rig_type)
    //    so we INSERT ... ON CONFLICT to refresh asset_url/asset_meta.
    await client`
      INSERT INTO cosmetic_variants (sku_id, rig_type, asset_url, asset_meta)
      VALUES (
        ${sku.id},
        'reef-race-board',
        ${b.glbPath},
        ${{ attachToPlayerPosition: true, yOffset: 0 }}::jsonb
      )
      ON CONFLICT (sku_id, rig_type) DO UPDATE SET
        asset_url = EXCLUDED.asset_url,
        asset_meta = EXCLUDED.asset_meta
    `;

    console.log(`  ✓ ${b.slug}  ${sku.id.slice(0, 8)}…`);
  }

  // Verify
  const skuRows = await client`
    SELECT slug, display_name, rarity, price_ct
    FROM cosmetic_skus
    WHERE category = 'board' AND scope = 'activity:reef-race'
    ORDER BY slug
  `;
  console.log(`\n[verify] cosmetic_skus rows (board scope reef-race): ${skuRows.length}`);
  for (const r of skuRows) {
    console.log(`  - ${r.slug.padEnd(28)} ${r.display_name.padEnd(28)} ${r.rarity.padEnd(8)} ${r.price_ct} CT`);
  }

  const variantRows = await client`
    SELECT v.rig_type, v.asset_url, s.slug
    FROM cosmetic_variants v
    JOIN cosmetic_skus s ON s.id = v.sku_id
    WHERE s.category = 'board'
    ORDER BY s.slug
  `;
  console.log(`\n[verify] cosmetic_variants rows: ${variantRows.length}`);
  for (const r of variantRows) {
    console.log(`  - ${r.slug.padEnd(28)} rigType=${r.rig_type.padEnd(20)} ${r.asset_url}`);
  }

  console.log('\n[seed-surfboards] Done. Visit /dash?tab=cosmetics to see them.');
  console.log('[note] thumbnail_url is NULL — dashboard renders the 🏄 category-icon fallback.');
  console.log('       Add real PNG thumbnails via a future render-to-PNG pass.');
} catch (err) {
  console.error('[seed-surfboards] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
