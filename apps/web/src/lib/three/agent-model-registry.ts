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

  // ── Other (sea creatures) ─────────────────────────────────────────────────
  jellyfish:     { path: '/models/jellyfish.glb',                  scale: 10, label: 'Jellyfish',       category: 'other', yOffset: 1.5 },
  octopus:       { path: '/models/octopus_toy.glb',                scale: 10, label: 'Octopus',         category: 'other' },
  seahorse:      { path: '/models/sea_horse.glb',                  scale: 8,  label: 'Sea Horse',       category: 'other' },

  // NOTE: Hermes/Milady anime GLBs (chihiro / priestess / chibi_goku) were
  // removed from the picker 2026-04-16 — those source meshes rendered poorly
  // (pivot-not-at-feet Y offset + SkinnedMesh scale explosion). The anime
  // GLB files still ship under /public/models/ and `arena-npcs.tsx` retains
  // lookup entries for any legacy DB rows; new agents simply cannot choose
  // them.
} as const satisfies Record<string, ModelRegistryEntry>;

export type ModelKey = keyof typeof MODEL_REGISTRY;

// Category metadata for the picker UI tabs.
// Only categories that appear in CATEGORY_ORDER need an entry here; hermes
// and milady were removed from the picker 2026-04-16 so they are typed as
// optional. The agent HARNESS radio still offers all 4 harness options
// (openclaw / hermes / milady / custom) — that's a separate control.
export const CATEGORY_META: Partial<Record<AgentCategory, { label: string; description: string }>> = {
  openclaw: { label: 'OpenClaw',  description: 'Crustacean agents — external gateway or OpenClaw framework' },
  other:    { label: 'Other',     description: 'Sea-creature agents — any framework' },
};

// Ordered list of categories for tab rendering. Reduced to 2 tabs
// (openclaw + other) 2026-04-16 — the anime GLBs in hermes/milady weren't
// picker-quality. See MODEL_REGISTRY note above.
export const CATEGORY_ORDER: AgentCategory[] = ['openclaw', 'other'];

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
// Typed as `Partial<Record<AgentCategory, ModelKey>>` because the picker
// no longer exposes hermes/milady tabs (those AgentCategory values still
// exist — the harness radio and DB CHECK constraint enforce them — but a
// tab-switch will never fire for them). The explicit annotation (not
// `as const satisfies`) lets consumers index by AgentCategory without a
// literal-narrowing error; the consumer's `?? 'lobster'` fallback handles
// the undefined case cleanly.
export const CATEGORY_DEFAULT_MODEL: Partial<Record<AgentCategory, ModelKey>> = {
  openclaw: 'lobster',
  other:    'jellyfish',
};

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
// The POST /api/avatars endpoint (apps/api/src/routes/avatars.ts:24) still uses the
// Phase 0 Zod enum for `species`: ['cat','dragon','fox','owl','wolf','bunny',
// 'phoenix','turtle']. Phase 1 ships a new modelKey (lobster, crayfish, etc.)
// but does NOT migrate the API or DB. To keep /create-agent working end-to-end
// without touching the API contract, we project each modelKey down to the
// closest legacy species value before writing to sessionStorage (the payload
// that personality/page.tsx forwards to POST /api/avatars).
//
// The mapping is pragmatic, not visually perfect — the chosen legacy species
// is the Phase 0 fantasy animal whose existing 2D sprite is the least-bad
// visual fallback for PixiCanvas, the only surface that still renders by
// species. The 3D world will render the correct modelKey once Phase 2 adds
// the avatars.modelKey column. Until then, sprite-mode users see the legacy
// animal; 3D-mode users see the correct model because the game store is
// separately seeded with the real modelKey from sessionStorage.
//
// Phase 2 removes this map and switches the API to accept modelKey directly.
export type LegacySpecies =
  | 'cat' | 'dragon' | 'fox' | 'owl' | 'wolf' | 'bunny' | 'phoenix' | 'turtle';

export const MODEL_KEY_TO_LEGACY_SPECIES: Record<ModelKey, LegacySpecies> = {
  lobster:       'cat',      // crustacean → "cat" is already aliased as "Reef Lobster" in avatar-species.ts
  crayfish:      'cat',      // same family
  sweet_crab:    'dragon',   // armored/fierce → dragon
  lobster_plush: 'bunny',    // cute/plush → bunny
  hermitcrab:    'turtle',   // shell-bearing → turtle
  jellyfish:     'phoenix',  // translucent/flowing → phoenix (residual bucket for sea creatures)
  octopus:       'phoenix',
  seahorse:      'phoenix',
};
