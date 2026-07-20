/**
 * Emote cosmetics: 9 legacy Mixamo clips + 12 Meshy fun-pack clips.
 *
 * Each SKU is category='emote', scope='all' (avatar emotes can fire
 * anywhere the avatar is rendered). The variant's assetMeta.animationKey
 * is the lookup key into ANIM_PATHS in vrm-character-animator.ts —
 * VRMCharacterAnimator.playOneShot(animationKey) plays the clip on the
 * player's VRM.
 *
 * Source metadata is recorded per SKU. Meshy assetUrl values point at the
 * stripped multi-clip bundle; the ~300 MB donor GLBs never ship from public.
 *
 * Run: bun packages/database/scripts/seed-emote-cosmetics.ts
 *
 * Idempotent — re-runs UPSERT by slug.
 */

import postgres from 'postgres';
import { resolve } from 'path';
import { config } from 'dotenv';
import {
  KELP_MAZE_COLLECTIBLE_SLUG,
  REWARD_ONLY_COSMETIC_CURRENCY,
} from '@clawville/shared';

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
  attribution?: string;
  attributionUrl?: string;
  license?: string;
}

const MESHY_BUNDLE_PATH = '/avatars/animations/_emotes2.glb?v=1';
const MESHY_ATTRIBUTION = 'Meshy AI animation library';
const MESHY_ATTRIBUTION_URL = 'https://www.meshy.ai';
const MESHY_LICENSE = 'Meshy-Terms';

const KELP_COLLECTIBLE_PLACEHOLDER = Object.freeze({
  slug: KELP_MAZE_COLLECTIBLE_SLUG,
  displayName: 'Unrevealed Depths Collectible',
  description: 'A reward from the heart of the Kelp Forest. Its true form has not been revealed yet.',
  rarity: 'epic',
  assetUrl: 'builtin:orbiting-orbs-aura',
  assetMeta: Object.freeze({
    renderer: 'orbiting-orbs',
    color: '#d9fff7',
    orbCount: 4,
    orbitRadiusWu: 58,
    orbRadiusWu: 6,
    orbitHeightWu: 112,
    orbitSpeed: 0.65,
  }),
});

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
  {
    slug: 'emote-sit-ground',
    displayName: 'Dockside Sit',
    description: 'Take five on the sea-town boardwalk.',
    rarity: 'common',
    priceCt: 200,
    animationKey: 'sit_ground',
    glbPath: `${MESHY_BUNDLE_PATH}#sit_ground`,
    attribution: MESHY_ATTRIBUTION,
    attributionUrl: MESHY_ATTRIBUTION_URL,
    license: MESHY_LICENSE,
  },
  {
    slug: 'emote-shrug',
    displayName: 'Shrug Tide',
    description: 'When the current has other plans.',
    rarity: 'common',
    priceCt: 200,
    animationKey: 'shrug',
    glbPath: `${MESHY_BUNDLE_PATH}#shrug`,
    attribution: MESHY_ATTRIBUTION,
    attributionUrl: MESHY_ATTRIBUTION_URL,
    license: MESHY_LICENSE,
  },
  {
    slug: 'emote-think',
    displayName: 'Deep Think',
    description: 'Ponder the mysteries below the reef.',
    rarity: 'common',
    priceCt: 200,
    animationKey: 'think',
    glbPath: `${MESHY_BUNDLE_PATH}#think`,
    attribution: MESHY_ATTRIBUTION,
    attributionUrl: MESHY_ATTRIBUTION_URL,
    license: MESHY_LICENSE,
  },
  {
    slug: 'emote-clap',
    displayName: 'Pearl Clap',
    description: 'Applause with a little extra sparkle.',
    rarity: 'common',
    priceCt: 200,
    animationKey: 'clap',
    glbPath: `${MESHY_BUNDLE_PATH}#clap`,
    attribution: MESHY_ATTRIBUTION,
    attributionUrl: MESHY_ATTRIBUTION_URL,
    license: MESHY_LICENSE,
  },
  {
    slug: 'emote-wave-one',
    displayName: 'Harbor Wave',
    description: 'A friendly hello across the harbor.',
    rarity: 'common',
    priceCt: 200,
    animationKey: 'wave_one',
    glbPath: `${MESHY_BUNDLE_PATH}#wave_one`,
    attribution: MESHY_ATTRIBUTION,
    attributionUrl: MESHY_ATTRIBUTION_URL,
    license: MESHY_LICENSE,
  },
  {
    slug: 'emote-stomp',
    displayName: 'Reef Stomp',
    description: 'Make the whole boardwalk feel it.',
    rarity: 'rare',
    priceCt: 400,
    animationKey: 'stomp',
    glbPath: `${MESHY_BUNDLE_PATH}#stomp`,
    attribution: MESHY_ATTRIBUTION,
    attributionUrl: MESHY_ATTRIBUTION_URL,
    license: MESHY_LICENSE,
  },
  {
    slug: 'emote-pushup',
    displayName: 'Deck Push-Ups',
    description: 'Drop and train like a tideguard.',
    rarity: 'rare',
    priceCt: 400,
    animationKey: 'pushup',
    glbPath: `${MESHY_BUNDLE_PATH}#pushup`,
    attribution: MESHY_ATTRIBUTION,
    attributionUrl: MESHY_ATTRIBUTION_URL,
    license: MESHY_LICENSE,
  },
  {
    slug: 'emote-kick-ball',
    displayName: 'Bubble Kick',
    description: 'Boot an imaginary pearl down the lane.',
    rarity: 'rare',
    priceCt: 400,
    animationKey: 'kick_ball',
    glbPath: `${MESHY_BUNDLE_PATH}#kick_ball`,
    attribution: MESHY_ATTRIBUTION,
    attributionUrl: MESHY_ATTRIBUTION_URL,
    license: MESHY_LICENSE,
  },
  {
    slug: 'emote-dance-funny',
    displayName: 'Goofy Guppy',
    description: 'A dance nobody can keep a straight face through.',
    rarity: 'rare',
    priceCt: 400,
    animationKey: 'dance_funny',
    glbPath: `${MESHY_BUNDLE_PATH}#dance_funny`,
    attribution: MESHY_ATTRIBUTION,
    attributionUrl: MESHY_ATTRIBUTION_URL,
    license: MESHY_LICENSE,
  },
  {
    slug: 'emote-backflip-2',
    displayName: 'Riptide Backflip',
    description: 'A full-send flip above the foam.',
    rarity: 'epic',
    priceCt: 600,
    animationKey: 'backflip_2',
    glbPath: `${MESHY_BUNDLE_PATH}#backflip_2`,
    attribution: MESHY_ATTRIBUTION,
    attributionUrl: MESHY_ATTRIBUTION_URL,
    license: MESHY_LICENSE,
  },
  {
    slug: 'emote-handstand',
    displayName: 'Coral Handstand',
    description: 'Hold steady while the tide turns.',
    rarity: 'epic',
    priceCt: 600,
    animationKey: 'handstand',
    glbPath: `${MESHY_BUNDLE_PATH}#handstand`,
    attribution: MESHY_ATTRIBUTION,
    attributionUrl: MESHY_ATTRIBUTION_URL,
    license: MESHY_LICENSE,
  },
  {
    slug: 'emote-breakdance',
    displayName: 'Breakwater Spin',
    description: 'Turn the plaza into your dance floor.',
    rarity: 'epic',
    priceCt: 600,
    animationKey: 'breakdance',
    glbPath: `${MESHY_BUNDLE_PATH}#breakdance`,
    attribution: MESHY_ATTRIBUTION,
    attributionUrl: MESHY_ATTRIBUTION_URL,
    license: MESHY_LICENSE,
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
        ${e.attribution ?? ATTRIBUTION},
        ${e.attributionUrl ?? ATTRIBUTION_URL},
        ${e.license ?? LICENSE}
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

  // Founder-controlled reveal row: seed it only when absent. Re-running this
  // script must never overwrite a later in-place DB UPDATE to its name,
  // category, asset URL, or renderer metadata.
  await client`
    INSERT INTO cosmetic_skus (
      slug, category, scope, display_name, description, rarity,
      price_ct, exclusive_currency, license_spdx, supply_cap,
      available_from, available_until
    ) VALUES (
      ${KELP_COLLECTIBLE_PLACEHOLDER.slug}, 'aura', 'all', ${KELP_COLLECTIBLE_PLACEHOLDER.displayName},
      ${KELP_COLLECTIBLE_PLACEHOLDER.description}, ${KELP_COLLECTIBLE_PLACEHOLDER.rarity}, 0,
      ${REWARD_ONLY_COSMETIC_CURRENCY}, 'OWN', NULL, NULL, NULL
    )
    ON CONFLICT (slug) DO NOTHING
  `;
  const [collectibleSku] = await client<[{ id: string }]>`
    SELECT id
    FROM cosmetic_skus
    WHERE slug = ${KELP_COLLECTIBLE_PLACEHOLDER.slug}
    LIMIT 1
  `;
  if (!collectibleSku) {
    throw new Error(`Stable Kelp collectible SKU missing after seed: ${KELP_COLLECTIBLE_PLACEHOLDER.slug}`);
  }
  await client`
    INSERT INTO cosmetic_variants (sku_id, rig_type, asset_url, asset_meta)
    VALUES (${collectibleSku.id}, 'universal', ${KELP_COLLECTIBLE_PLACEHOLDER.assetUrl}, ${KELP_COLLECTIBLE_PLACEHOLDER.assetMeta}::jsonb)
    ON CONFLICT (sku_id, rig_type) DO NOTHING
  `;
  console.log(`  ✓ ${KELP_COLLECTIBLE_PLACEHOLDER.slug} (unrevealed, reward-only, create-if-absent)`);

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
