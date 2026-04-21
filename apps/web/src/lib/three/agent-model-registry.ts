/**
 * agent-model-registry.ts
 *
 * Single source of truth for the agent model picker.
 * Imported by both SelectAgentCanvas (3D rendering) and create-agent/page.tsx
 * (React UI) so the page does not need to import the Canvas to read the
 * registry, keeping the 3D pipeline out of the synchronous bundle.
 *
 * GPU constraints: no InstancedMesh, no ShaderMaterial, no drei Text/Billboard.
 *
 * avatar_type field (added 2026-04-21):
 *   'glb' — standard Three.js GLB loaded via useGLTF / scene.clone(true)
 *   'vrm' — VRM loaded via useVRM / VRMUtils.deepDispose; rendered via
 *            VRMCharacterAnimator (Mixamo retarget). Color tinting is NOT
 *            applied to VRM entries — MToon materials use a toon shading
 *            pipeline that breaks under standard MeshStandardMaterial lerp.
 *            The user's petColor is stored in the Zustand store but not
 *            rendered visually on VRM avatars.
 */

export type AgentCategory = 'openclaw' | 'hermes' | 'milady' | 'other';

export interface ModelRegistryEntry {
  path: string;
  scale: number;
  label: string;
  category: AgentCategory;
  /** Format of the avatar asset. Defaults to 'glb' for backwards compatibility. */
  avatar_type: 'glb' | 'vrm';
  /** Optional vertical offset to avoid floor-clip (world units). */
  yOffset?: number;
  /** Optional thumbnail path for the picker UI (VRM models use dedicated previews). */
  preview?: string;
}

export const MODEL_REGISTRY = {
  // ── OpenClaw (crustaceans) ────────────────────────────────────────────────
  // All scales normalized to 10 so models fit cleanly in the picker's clear
  // zone above the config modal. Lobster was previously `scale: 14` which
  // pushed its mid-section behind the modal card.
  lobster:       { path: '/models/lobster.glb',                    scale: 10, label: 'Reef Lobster',    category: 'openclaw', avatar_type: 'glb' },
  sweet_crab:    { path: '/models/sweet_crab_sketchfabweekly.glb', scale: 10, label: 'Sweet Crab',      category: 'openclaw', avatar_type: 'glb' },
  lobster_plush: { path: '/models/lobster_plush.glb',              scale: 10, label: 'Lobster Plush',   category: 'openclaw', avatar_type: 'glb' },
  hermitcrab:    { path: '/models/hermitcrab.glb',                 scale: 10, label: 'Hermit Crab',     category: 'openclaw', avatar_type: 'glb' },

  // ── Other (sea creatures) ─────────────────────────────────────────────────
  jellyfish:     { path: '/models/jellyfish.glb',                  scale: 10, label: 'Jellyfish',       category: 'other',    avatar_type: 'glb', yOffset: 1.5 },
  octopus:       { path: '/models/octopus_toy.glb',                scale: 10, label: 'Octopus',         category: 'other',    avatar_type: 'glb' },
  seahorse:      { path: '/models/sea_horse.glb',                  scale: 8,  label: 'Sea Horse',       category: 'other',    avatar_type: 'glb' },

  // ── Milady (VRM humanoid avatars) ─────────────────────────────────────────
  // VRM spec: human-scale models with feet at origin (Y=0 at ground plane).
  // No computeLocalMinY / pivotOffsetY needed — VRM spec mandates feet at origin.
  //
  // Scale calibration (2026-04-21):
  //   VRM models are typically exported at ~1.55–1.70 m native height.
  //   Target visual height in picker: ~20 world units (same apparent size as
  //   sea creatures at scale=10 — fills the picker frame without clipping).
  //   target_wu = 20, native_height ≈ 1.6m → scale = 20/1.6 ≈ 12.5
  //   Using scale=13 gives ~20.8 wu, which sits comfortably in the 25–80wu
  //   camera range of SelectAgentCanvas (minDistance=25, camera at z=45).
  //   In the game world (TARGET_NPC_HEIGHT=45wu): VRM player pet uses the
  //   VRMCharacterAnimator and is positioned by vrm.scene directly;
  //   scale=13 gives ~20.8wu which is intentionally smaller than sea-creature
  //   NPCs (45wu) — Milady avatar is a human-sized humanoid in an ocean world.
  //   If the user wants parity with NPC height, scale≈28.
  //   Decision: scale=13 for picker fit. Game-world height ~20wu.
  //
  // Color tinting: NOT applied. MToon pipeline breaks under std material lerp.
  //   petColor is preserved in Zustand but not rendered on VRM meshes.
  //   See VRMCharacterAnimator for animator path.
  //
  // Facing: VRM 1.0 faces -Z natively; VRM 0.x has rotateVRM0() applied in
  //   vrm-loader.ts (adds π rotation to scene) → both face -Z after load.
  //   DIR_ROTATION for -Z forward: atan2(vx, -vy) — verified in player-pet.tsx
  //   VRM fork. See gotcha: "Lobster faces +Z" — VRM is the OPPOSITE convention.
  milady_official_1: { path: '/avatars/milady-official-1.vrm', scale: 13, label: 'Milady Official 1', category: 'milady', avatar_type: 'vrm', preview: '/avatars/previews/milady-official-1.png' },
  milady_official_2: { path: '/avatars/milady-official-2.vrm', scale: 13, label: 'Milady Official 2', category: 'milady', avatar_type: 'vrm', preview: '/avatars/previews/milady-official-2.png' },
  milady_official_3: { path: '/avatars/milady-official-3.vrm', scale: 13, label: 'Milady Official 3', category: 'milady', avatar_type: 'vrm', preview: '/avatars/previews/milady-official-3.png' },
  milady_official_4: { path: '/avatars/milady-official-4.vrm', scale: 13, label: 'Milady Official 4', category: 'milady', avatar_type: 'vrm', preview: '/avatars/previews/milady-official-4.png' },
  milady_official_5: { path: '/avatars/milady-official-5.vrm', scale: 13, label: 'Milady Official 5', category: 'milady', avatar_type: 'vrm', preview: '/avatars/previews/milady-official-5.png' },
  milady_official_6: { path: '/avatars/milady-official-6.vrm', scale: 13, label: 'Milady Official 6', category: 'milady', avatar_type: 'vrm', preview: '/avatars/previews/milady-official-6.png' },
  milady_official_7: { path: '/avatars/milady-official-7.vrm', scale: 13, label: 'Milady Official 7', category: 'milady', avatar_type: 'vrm', preview: '/avatars/previews/milady-official-7.png' },
  milady_official_8: { path: '/avatars/milady-official-8.vrm', scale: 13, label: 'Milady Official 8', category: 'milady', avatar_type: 'vrm', preview: '/avatars/previews/milady-official-8.png' },

  // NOTE: `crayfish` removed from the picker 2026-04-16 — the mesh renders
  // noticeably larger than lobster at the same scale (different pivot) and
  // consistently clipped the modal card. The GLB still ships under
  // /public/models/ and `arena-npcs.tsx` retains its entry for any legacy
  // DB rows; new agents simply cannot choose it.
  //
  // NOTE: Anime GLBs (chihiro / priestess / chibi_goku) removed from picker
  // 2026-04-16 (poor render quality) and DELETED from disk 2026-04-21 (replaced
  // by 8 Milady VRM avatars in the 'milady' category). arena-npcs.tsx entries
  // also removed. character-animations.ts MODEL_KEY_TO_TYPE entries removed.
} as const satisfies Record<string, ModelRegistryEntry>;

export type ModelKey = keyof typeof MODEL_REGISTRY;

// Category metadata for the picker UI tabs.
export const CATEGORY_META: Partial<Record<AgentCategory, { label: string; description: string }>> = {
  openclaw: { label: 'OpenClaw', description: 'Crustacean agents — external gateway or OpenClaw framework' },
  other:    { label: 'Other',    description: 'Sea-creature agents — any framework' },
  milady:   { label: 'Milady',   description: 'Milady VRM avatars — humanoid Milady AI characters' },
};

// Ordered list of categories for tab rendering.
// milady restored 2026-04-21 with 8 VRM avatars.
export const CATEGORY_ORDER: AgentCategory[] = ['openclaw', 'other', 'milady'];

// Color presets — aligned with COLOR_TINTS hex values in SelectAgentCanvas so
// the button background matches the actual GLB tint applied.
// Note: colors are not applied to 'vrm' avatar_type entries (MToon-safe rule).
export const PICKER_COLORS = [
  { id: 'green',  label: 'GREEN',  bg: '#30ff70' },
  { id: 'red',    label: 'RED',    bg: '#ff3030' },
  { id: 'blue',   label: 'BLUE',   bg: '#3070ff' },
  { id: 'yellow', label: 'YELLOW', bg: '#ffd700' },
] as const;

export type PickerColorId = typeof PICKER_COLORS[number]['id'];

// Default model per category — used when the user switches tabs.
export const CATEGORY_DEFAULT_MODEL: Partial<Record<AgentCategory, ModelKey>> = {
  openclaw: 'lobster',
  other:    'jellyfish',
  milady:   'milady_official_1',
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
  lobster:            'cat',
  sweet_crab:         'dragon',
  lobster_plush:      'bunny',
  hermitcrab:         'turtle',
  jellyfish:          'phoenix',
  octopus:            'phoenix',
  seahorse:           'phoenix',
  // Milady VRM avatars map to 'fox' — closest fantasy-animal aesthetic to the
  // anime/chibi humanoid style. PixiJS 2D mode will show a fox sprite as a
  // fallback until the Phase 2 modelKey migration lands.
  milady_official_1:  'fox',
  milady_official_2:  'fox',
  milady_official_3:  'fox',
  milady_official_4:  'fox',
  milady_official_5:  'fox',
  milady_official_6:  'fox',
  milady_official_7:  'fox',
  milady_official_8:  'fox',
};
