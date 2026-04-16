/**
 * agent-model-registry.ts
 *
 * Single source of truth for the agent model picker.
 * Imported by both SelectAgentCanvas (3D rendering) and create-agent/page.tsx
 * (React UI) so the page does not need to import the Canvas to read the
 * registry, keeping the 3D pipeline out of the synchronous bundle.
 *
 * GPU constraints: no InstancedMesh, no ShaderMaterial, no drei Text/Billboard.
 */

export type AgentCategory = 'openclaw' | 'hermes' | 'milady' | 'other';

export interface ModelRegistryEntry {
  path: string;
  scale: number;
  label: string;
  category: AgentCategory;
  /** Optional vertical offset to avoid floor-clip (world units). */
  yOffset?: number;
}

export const MODEL_REGISTRY = {
  // ── OpenClaw (crustaceans) ────────────────────────────────────────────────
  lobster:       { path: '/models/lobster.glb',                    scale: 14, label: 'Reef Lobster',    category: 'openclaw' },
  crayfish:      { path: '/models/crayfish.glb',                   scale: 14, label: 'Crayfish',        category: 'openclaw' },
  sweet_crab:    { path: '/models/sweet_crab_sketchfabweekly.glb', scale: 10, label: 'Sweet Crab',      category: 'openclaw' },
  lobster_plush: { path: '/models/lobster_plush.glb',              scale: 10, label: 'Lobster Plush',   category: 'openclaw' },
  hermitcrab:    { path: '/models/hermitcrab.glb',                 scale: 10, label: 'Hermit Crab',     category: 'openclaw' },

  // ── Hermes (anime — single representative) ────────────────────────────────
  chihiro:       { path: '/models/spirited_away_senchihiro.glb',   scale: 10, label: 'Chihiro',         category: 'hermes' },

  // ── Milady (anime — placeholder until Milady-branded GLBs ship) ───────────
  priestess:     { path: '/models/young_priestess.glb',            scale: 10, label: 'Young Priestess', category: 'milady' },
  chibi_goku:    { path: '/models/chibi_goku.glb',                 scale: 11, label: 'Chibi Goku',      category: 'milady' },

  // ── Other (sea creatures) ─────────────────────────────────────────────────
  jellyfish:     { path: '/models/jellyfish.glb',                  scale: 10, label: 'Jellyfish',       category: 'other', yOffset: 1.5 },
  octopus:       { path: '/models/octopus_toy.glb',                scale: 10, label: 'Octopus',         category: 'other' },
  seahorse:      { path: '/models/sea_horse.glb',                  scale: 8,  label: 'Sea Horse',       category: 'other' },
} as const satisfies Record<string, ModelRegistryEntry>;

export type ModelKey = keyof typeof MODEL_REGISTRY;

// Category metadata for the picker UI tabs.
export const CATEGORY_META: Record<AgentCategory, { label: string; description: string }> = {
  openclaw: { label: 'OpenClaw',  description: 'Crustacean agents — external gateway or OpenClaw framework' },
  hermes:   { label: 'Hermes',    description: 'Anime-style agents — Hermes framework' },
  milady:   { label: 'Milady',    description: 'Milady AI runtime — Eliza-powered, app store native' },
  other:    { label: 'Other',     description: 'Sea-creature agents — any framework' },
};

// Ordered list of categories for tab rendering.
export const CATEGORY_ORDER: AgentCategory[] = ['openclaw', 'hermes', 'milady', 'other'];

// Color presets — aligned with COLOR_TINTS hex values in SelectAgentCanvas so
// the button background matches the actual GLB tint applied.
export const PICKER_COLORS = [
  { id: 'green',  label: 'GREEN',  bg: '#30ff70' },
  { id: 'red',    label: 'RED',    bg: '#ff3030' },
  { id: 'blue',   label: 'BLUE',   bg: '#3070ff' },
  { id: 'yellow', label: 'YELLOW', bg: '#ffd700' },
] as const;

export type PickerColorId = typeof PICKER_COLORS[number]['id'];

// Default model per category — used when the user switches tabs.
// `as const satisfies` keeps the exact ModelKey literals in the type so
// typos like 'lobstar' fail at compile time, and downstream consumers can
// drop the `as ModelKey` cast.
export const CATEGORY_DEFAULT_MODEL = {
  openclaw: 'lobster',
  hermes:   'chihiro',
  milady:   'priestess',
  other:    'jellyfish',
} as const satisfies Record<AgentCategory, ModelKey>;

// Agent harness options — controls which export format Phase 3 uses.
export const HARNESS_OPTIONS = [
  { id: 'openclaw', label: 'OpenClaw',        description: 'External OpenAI-compatible gateway' },
  { id: 'hermes',   label: 'Hermes',          description: 'Hermes framework' },
  { id: 'milady',   label: 'Milady (Eliza)',  description: 'Milady AI runtime — recommended' },
  { id: 'custom',   label: 'Custom / Other',  description: 'Any other framework' },
] as const;

export type HarnessId = typeof HARNESS_OPTIONS[number]['id'];

// ---------------------------------------------------------------------------
// Legacy species mapping (Phase 1 API compatibility)
// ---------------------------------------------------------------------------
// The POST /api/pets endpoint (apps/api/src/routes/pets.ts:24) still uses the
// Phase 0 Zod enum for `species`: ['cat','dragon','fox','owl','wolf','bunny',
// 'phoenix','turtle']. Phase 1 ships a new modelKey (lobster, crayfish, etc.)
// but does NOT migrate the API or DB. To keep /create-agent working end-to-end
// without touching the API contract, we project each modelKey down to the
// closest legacy species value before writing to sessionStorage (the payload
// that personality/page.tsx forwards to POST /api/pets).
//
// The mapping is pragmatic, not visually perfect — the chosen legacy species
// is the Phase 0 fantasy animal whose existing 2D sprite is the least-bad
// visual fallback for PixiCanvas, the only surface that still renders by
// species. The 3D world will render the correct modelKey once Phase 2 adds
// the pets.modelKey column. Until then, sprite-mode users see the legacy
// animal; 3D-mode users see the correct model because the game store is
// separately seeded with the real modelKey from sessionStorage.
//
// Phase 2 removes this map and switches the API to accept modelKey directly.
export type LegacySpecies =
  | 'cat' | 'dragon' | 'fox' | 'owl' | 'wolf' | 'bunny' | 'phoenix' | 'turtle';

export const MODEL_KEY_TO_LEGACY_SPECIES: Record<ModelKey, LegacySpecies> = {
  lobster:       'cat',      // crustacean → "cat" is already aliased as "Reef Lobster" in pet-species.ts
  crayfish:      'cat',      // same family
  sweet_crab:    'dragon',   // armored/fierce → dragon
  lobster_plush: 'bunny',    // cute/plush → bunny
  hermitcrab:    'turtle',   // shell-bearing → turtle
  chihiro:       'fox',      // nimble/graceful → fox
  priestess:     'owl',      // wise/gentle → owl
  chibi_goku:    'wolf',     // strong/spirited → wolf
  jellyfish:     'phoenix',  // translucent/flowing → phoenix (residual bucket for sea creatures)
  octopus:       'phoenix',
  seahorse:      'phoenix',
};
