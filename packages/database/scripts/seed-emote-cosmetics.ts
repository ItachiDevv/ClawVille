/**
 * Phase 2 emote cosmetics — 9 Mixamo-sourced emote clips.
 *
 * Each SKU is category='emote', scope='all' (avatar emotes can fire
 * anywhere the avatar is rendered). The variant's assetMeta.animationKey
 * is the lookup key into ANIM_PATHS in vrm-character-animator.ts —
 * VRMCharacterAnimator.playOneShot(animationKey) plays the clip on the
 * player's VRM.
 *
 * License: Mixamo clips are CC0/free-with-account; assetUrl points at
 * /avatars/animations/emotes/<file>.glb already in apps/web/public.
 *
 * Run: bun packages/database/scripts/seed-emote-cosmetics.ts
 *
 * Idempotent — re-runs UPSERT by slug.
 */

import postgres from 'postgres';
import { resolve } from 'path';
import { config } from 'dotenv';

config({ path: resolve(__dirname, '../../../.env.local') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

interface EmoteSeed {
  slug: string;
  displayName: string;
  description: string;
  rarity: 'common' | 'rare' | 'epic';
  priceCt: number;
  /**
   * Animation key — must match an entry in EMOTE_ANIM_NAMES in
   * vrm-character-animator.ts. The hotbar reads this from assetMeta and
   * passes it to playOneShot().
   */
  animationKey: string;
  glbPath: string;
}

const EMOTES: EmoteSeed[] = [
  {
    slug: 'emote-flip',
    displayName: 'Backflip',
    description: 'Pop a clean backflip on demand. Showoff tier.',
    rarity: 'rare',
    priceCt: 600,
    animationKey: 'flip',
    glbPath: '/avatars/animations/emotes/flip.glb',
  },
  {
    slug: 'emote-dance-breaking',
    displayName: 'Breaking',
    description: 'Breakdance footwork combo. Origin: 70s Bronx.',
    rarity: 'epic',
    priceCt: 1200,
    animationKey: 'dance_breaking',
    glbPath: '/avatars/animations/emotes/dance-breaking.glb',
  },
  {
    slug: 'emote-dance-hiphop',
    displayName: 'Hip-Hop Dance',
    description: 'Smooth hip-hop loop. Bring the BPM.',
    rarity: 'rare',
    priceCt: 600,
    animationKey: 'dance_hiphop',
    glbPath: '/avatars/animations/emotes/dance-hiphop.glb',
  },
  {
    slug: 'emote-dance-popping',
    displayName: 'Popping',
    description: 'Robot-style popping moves. Crisp hits.',
    rarity: 'rare',
    priceCt: 600,
    animationKey: 'dance_popping',
    glbPath: '/avatars/animations/emotes/dance-popping.glb',
  },
  {
    slug: 'emote-victory',
    displayName: 'Victory',
    description: 'Cheering pose for the W.',
    rarity: 'common',
    priceCt: 300,
    animationKey: 'victory',
    glbPath: '/avatars/animations/cheering.glb',
  },
  {
    slug: 'emote-kiss',
    displayName: 'Blow Kiss',
    description: 'Send a flying smooch. Lovecore.',
    rarity: 'common',
    priceCt: 300,
    animationKey: 'kiss',
    glbPath: '/avatars/animations/emotes/kiss.glb',
  },
  {
    slug: 'emote-fishing',
    displayName: 'Cast a Line',
    description: 'Fishing-pole cast pantomime. /afk vibe.',
    rarity: 'common',
    priceCt: 300,
    animationKey: 'fishing',
    glbPath: '/avatars/animations/emotes/fishing.glb',
  },
  {
    slug: 'emote-jump',
    displayName: 'Big Jump',
    description: 'A theatrical leap. Hops on demand.',
    rarity: 'common',
    priceCt: 300,
    animationKey: 'jump',
    glbPath: '/avatars/animations/emotes/jump.glb',
  },
  {
    slug: 'emote-spell-cast',
    displayName: 'Spell Cast',
    description: 'Cast a glowing rune. Wizards approved.',
    rarity: 'epic',
    priceCt: 1200,
    animationKey: 'spell_cast',
    glbPath: '/avatars/animations/emotes/spell-cast.glb',
  },
];

const ATTRIBUTION = 'Mixamo (Adobe) — free animation library';
const ATTRIBUTION_URL = 'https://www.mixamo.com';
const LICENSE = 'Mixamo-Free';

const client = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  console.log(`[seed-emote-cosmetics] Upserting ${EMOTES.length} emote SKUs + variants…`);

  for (const e of EMOTES) {
    const [sku] = await client<[{ id: string }]>`
      INSERT INTO cosmetic_skus (
        slug, category, scope, display_name, description, rarity,
        price_ct, attribution, attribution_url, license_spdx
      ) VALUES (
        ${e.slug}, 'emote', 'all', ${e.displayName},
        ${e.description}, ${e.rarity}, ${e.priceCt},
        ${ATTRIBUTION}, ${ATTRIBUTION_URL}, ${LICENSE}
      )
      ON CONFLICT (slug) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        rarity = EXCLUDED.rarity,
        price_ct = EXCLUDED.price_ct,
        category = EXCLUDED.category,
        scope = EXCLUDED.scope,
        attribution = EXCLUDED.attribution,
        attribution_url = EXCLUDED.attribution_url,
        license_spdx = EXCLUDED.license_spdx
      RETURNING id
    `;

    const meta: Record<string, unknown> = {
      animationKey: e.animationKey,
    };

    // Variant rigType='milady-vrm' since emotes only target VRM rigs
    // today. Once GLB avatars get retargeting, add a second variant with
    // rigType='lobster' etc.
    await client`
      INSERT INTO cosmetic_variants (sku_id, rig_type, asset_url, asset_meta)
      VALUES (
        ${sku.id},
        'milady-vrm',
        ${e.glbPath},
        ${meta}::jsonb
      )
      ON CONFLICT (sku_id, rig_type) DO UPDATE SET
        asset_url = EXCLUDED.asset_url,
        asset_meta = EXCLUDED.asset_meta
    `;

    console.log(`  ✓ ${e.slug.padEnd(28)} (${e.rarity}, ${e.priceCt} CT, key=${e.animationKey})`);
  }

  const skuRows = await client`
    SELECT slug, rarity, price_ct
    FROM cosmetic_skus
    WHERE category = 'emote'
    ORDER BY price_ct, slug
  `;
  console.log(`\n[verify] Seeded ${skuRows.length} emote SKUs:`);
  for (const r of skuRows) {
    console.log(
      `  - ${(r.slug as string).padEnd(28)} ${(r.rarity as string).padEnd(7)} ${r.price_ct} CT`,
    );
  }

  console.log('\n[done] Emote shop ready. Players buy → equip → trigger via hotbar (keys 1-4).');
} catch (err) {
  console.error('[seed-emote-cosmetics] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
