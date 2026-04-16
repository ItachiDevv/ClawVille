/**
 * Web-side model registry — augments @clawville/shared AGENT_MODELS with
 * GLB asset paths and per-model render scale.
 *
 * This is the single source of truth for asset paths + scale values used by:
 *   - player-avatar.tsx  (PlayerPetInner GLB resolution)
 *   - SelectAgentCanvas.tsx  (carousel preview)
 *
 * NOTE: This file may import Three.js types (it's client-only). It must NOT
 * be imported from any server-side module.
 */

import { AGENT_MODELS, type AgentCategory } from '@clawville/shared';

export type { AgentCategory };

export interface ModelRegistryEntry {
  path: string;
  scale: number;
  label: string;
  category: AgentCategory;
}

/**
 * Per-key GLB paths and render scales. Keys must match AGENT_MODELS[n].key.
 * Paths match files in apps/web/public/models/.
 */
const MODEL_ASSET_MAP: Record<string, { path: string; scale: number }> = {
  lobster:       { path: '/models/lobster.glb',                    scale: 14 },
  crayfish:      { path: '/models/crayfish.glb',                   scale: 14 },
  sweet_crab:    { path: '/models/sweet_crab_sketchfabweekly.glb', scale: 10 },
  lobster_plush: { path: '/models/lobster_plush.glb',              scale: 10 },
  hermitcrab:    { path: '/models/hermitcrab.glb',                 scale: 10 },
  chihiro:       { path: '/models/spirited_away_senchihiro.glb',   scale: 8  },
  chibi_goku:    { path: '/models/chibi_goku.glb',                 scale: 8  },
  priestess:     { path: '/models/young_priestess.glb',            scale: 8  },
  jellyfish:     { path: '/models/jellyfish.glb',                  scale: 10 },
  octopus:       { path: '/models/octopus_toy.glb',                scale: 10 },
  seahorse:      { path: '/models/sea_horse.glb',                  scale: 10 },
};

/**
 * MODEL_REGISTRY — merged from shared metadata + web asset map.
 * Keyed by model key (e.g. 'lobster', 'priestess').
 */
export const MODEL_REGISTRY: Record<string, ModelRegistryEntry> = Object.fromEntries(
  AGENT_MODELS.map((m) => {
    const asset = MODEL_ASSET_MAP[m.key];
    if (!asset) {
      // Fail loudly at module load time if a shared entry has no asset mapping.
      throw new Error(`[agent-model-registry] No asset mapping for model key "${m.key}". Add it to MODEL_ASSET_MAP.`);
    }
    return [
      m.key,
      {
        path: asset.path,
        scale: asset.scale,
        label: m.label,
        category: m.category,
      } satisfies ModelRegistryEntry,
    ];
  })
);
