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
 *            The user's avatarColor is stored in the Zustand store but not
 *            rendered visually on VRM avatars.
 */

export type AgentCategory = 'openclaw' | 'hermes' | 'milady' | 'chibi' | 'other' | 'hatcher';

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
  /**
   * Key into character-anim-overrides.json. When set, VRMCharacterAnimator
   * uses this to look up character-specific Mixamo bakes (jump.glb, etc.).
   * Models sharing the same rig + proportions share an animatorId so one
   * Mixamo upload powers them all — every Milady VRM uses 'vrm-milady'.
   * GLB crustaceans omit this (no Mixamo path).
   */
  animatorId?: string;
  /**
   * Extra Y rotation (radians) applied once per VRM load in the picker
   * (SelectAgentCanvas.tsx PlatformModelVRM) to make the model face the camera.
   *
   * VRM 0.x (Milady / Hatcher placeholders): `vrm-loader.ts` calls
   * `VRMUtils.rotateVRM0(vrm)` which sets scene.rotation.y = pi, pointing the
   * model toward -Z (camera at +Z). No additional correction needed → omit
   * faceYaw (defaults 0 → no-op).
   *
   * VRM 1.x (Hermes / Tekk / chibi): `rotateVRM0` is a no-op (metaVersion !==
   * "0"). These rigs natively face +Z (back to camera). Adding Math.PI flips
   * them to face -Z toward the picker camera.
   */
  faceYaw?: number;
  /**
   * Reserved models: hidden from the /create-agent picker grid (filtered in
   * create-agent/page.tsx). Used for agent-only defaults that are assigned
   * server-side but never user-selectable — e.g. `phanes`, the default Hatcher
   * avatar. The 3D world still renders them normally; only the picker hides them.
   */
  pickerHidden?: boolean;
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
  //   In the game world (TARGET_NPC_HEIGHT=45wu): VRM player avatar uses the
  //   VRMCharacterAnimator and is positioned by vrm.scene directly;
  //   scale=13 gives ~20.8wu which is intentionally smaller than sea-creature
  //   NPCs (45wu) — Milady avatar is a human-sized humanoid in an ocean world.
  //   If the user wants parity with NPC height, scale≈28.
  //   Decision: scale=13 for picker fit. Game-world height ~20wu.
  //
  // Color tinting: NOT applied. MToon pipeline breaks under std material lerp.
  //   avatarColor is preserved in Zustand but not rendered on VRM meshes.
  //   See VRMCharacterAnimator for animator path.
  //
  // Facing: VRM 1.0 faces -Z natively; VRM 0.x has rotateVRM0() applied in
  //   vrm-loader.ts (adds π rotation to scene) → both face -Z after load.
  //   DIR_ROTATION for -Z forward: atan2(vx, -vy) — verified in player-avatar.tsx
  //   VRM fork. See gotcha: "Lobster faces +Z" — VRM is the OPPOSITE convention.
  milady_official_1: { path: '/avatars/milady-official-1.vrm', scale: 13, label: 'Milady Official 1', category: 'milady', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-1.png' },
  milady_official_2: { path: '/avatars/milady-official-2.vrm', scale: 13, label: 'Milady Official 2', category: 'milady', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-2.png' },
  milady_official_3: { path: '/avatars/milady-official-3.vrm', scale: 13, label: 'Milady Official 3', category: 'milady', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-3.png' },
  milady_official_4: { path: '/avatars/milady-official-4.vrm', scale: 13, label: 'Milady Official 4', category: 'milady', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-4.png' },
  milady_official_5: { path: '/avatars/milady-official-5.vrm', scale: 13, label: 'Milady Official 5', category: 'milady', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-5.png' },
  milady_official_6: { path: '/avatars/milady-official-6.vrm', scale: 13, label: 'Milady Official 6', category: 'milady', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-6.png' },
  milady_official_7: { path: '/avatars/milady-official-7.vrm', scale: 13, label: 'Milady Official 7', category: 'milady', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-7.png' },
  milady_official_8: { path: '/avatars/milady-official-8.vrm', scale: 13, label: 'Milady Official 8', category: 'milady', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-8.png' },

  // Hermes-hosted VRM avatars (added 2026-05-12, third entry added the same
  // day after the user pointed out the male/Tekk mix-up). Three distinct
  // characters — the file at /avatars/hermes-male.vrm is the "MaleHermes"
  // (Paul-style) export, NOT Tekk; Tekk has its own VRM at /avatars/tekk.vrm
  // and a separate turnaround folder /models/tekk-turnaround/*. Same scale
  // value as the Milady pool — the picker's bounding-box auto-fit
  // normalizes screen-space height regardless of native VRM units.
  // Animation clips: hermes-female/ → female rig, hermes-male/ → male rig,
  // tekk-male/ → Tekk rig.
  // faceYaw: Math.PI — VRM 1.x rigs face +Z natively (back to camera). rotateVRM0 is a
  // no-op for these. Adding pi flips them to face -Z toward the picker camera at +Z.
  // ?v=2 cache-bust 2026-06-13 — VRM file decimated to ~40k tris (perf round 2,
  // Track C). Stable URL content changed, so the ?v bump is REQUIRED to evict
  // Cloudflare's 7d edge cache (deploy token lacks cache_purge scope). The
  // PRELOAD url in asset-preload-manifest.ts MUST carry the identical ?v=2 or it
  // double-fetches + cache-misses.
  hermes_female: { path: '/avatars/hermes-female.vrm?v=2', scale: 13, label: 'Hermes',      category: 'hermes', avatar_type: 'vrm', animatorId: 'hermes-female', faceYaw: Math.PI, preview: '/models/hermes-turnaround/female-front.png' },
  hermes_male:   { path: '/avatars/hermes-male.vrm?v=2',   scale: 13, label: 'Hermes Male', category: 'hermes', avatar_type: 'vrm', animatorId: 'hermes-male',   faceYaw: Math.PI, preview: '/models/hermes-turnaround/male-front.png' },
  // ?v=2 bust 2026-05-22 — Cloudflare cached a 404 for this URL from the window before the PNG was committed; CF edge TTL is 7d and our deploy token lacks cache_purge scope, so the URL query is the only invalidator. See "Asset cache-bust" kill-the-build rule in CLAUDE.md. The VRM ?v=2 (2026-06-13) is the decimation bust (separate from the preview PNG bust).
  tekk:          { path: '/avatars/tekk.vrm?v=2',          scale: 13, label: 'Tekk',        category: 'hermes', avatar_type: 'vrm', animatorId: 'tekk',          faceYaw: Math.PI, preview: '/models/tekk-turnaround/with-wings-front.png?v=2' },

  // ── Chibi VRM avatars (added 2026-05-21) ──────────────────────────────────
  // Mini-Nori-style stylized humanoids — large head, short stubby limbs.
  // Both share animatorId='chibi' → /avatars/animations/chibi/ (one Mixamo
  // rig source, 8 bakes shared via the runtime retargeter). Same pattern as
  // the 8 Miladies sharing animatorId='vrm-milady'.
  //
  // Sized at SPECIES_TARGET_HEIGHT_WU.chibi = 135 (half of the 270 default)
  // per user direction "around half the height of the others".
  // ?v=2 cache-bust (2026-05-21): bump query whenever the chibi VRM file
  // content changes. Cloudflare's edge cache (1-week TTL) keys on the full
  // URL including query; bumping invalidates the edge cache without needing
  // the cache_purge token scope we don't have. Matches the existing pattern
  // used for the emote bundle (EMOTE_BUNDLE_VERSION in vrm-character-animator.ts).
  // faceYaw: Math.PI — chibi VRMs are Mixamo-rigged VRM 1.x (same as Hermes/Tekk).
  // ?v=2→?v=3 bump 2026-06-13 — VRM decimated to ~40k tris + 2048² PNG texture
  // downscaled to 1024² WebP (perf round 2, Track C+E). Stable URL content
  // changed → ?v bump REQUIRED (see chibi cache-bust note above). Preload url in
  // asset-preload-manifest.ts MUST match this ?v=3 exactly.
  eliza_chibi:   { path: '/avatars/eliza-chibi.vrm?v=3',   scale: 13, label: 'Eliza Chibi',  category: 'chibi',  avatar_type: 'vrm', animatorId: 'chibi', faceYaw: Math.PI, preview: '/models/eliza-chibi-turnaround/front.png' },
  milady_chibi:  { path: '/avatars/milady-chibi.vrm?v=3',  scale: 13, label: 'Milady Chibi', category: 'chibi',  avatar_type: 'vrm', animatorId: 'chibi', faceYaw: Math.PI, preview: '/models/milady-chibi-turnaround/front.png' },

  // ── Hatcher (placeholder — Phase 4 swap) ─────────────────────────────────
  // PLACEHOLDER (Phase 4 swap): these 8 keys point at existing Milady VRMs
  // as stand-in art until bespoke Hatcher VRMs are authored (see
  // hatcher-integration.md §5 Workstream 4). They render today via the
  // vrm-milady animator with zero new rendering code.
  //
  // Phase 4 repoints each `path` to `/avatars/hatcher-N.vrm` AND bumps a
  // `?v=1` query (first mutation of a stable URL → cache-bust required per
  // §6f rule 9 / 3dStructure.md §6f rule 9). The category name, scale,
  // animatorId, and MODEL_KEY_TO_LEGACY_SPECIES mapping stay unchanged.
  //
  // Color tinting: NOT applied (MToon pipeline — same rule as Milady/Hermes).
  // Facing: atan2(vx, vz) — same -Z convention as all Milady VRMs.
  hatcher_1: { path: '/avatars/milady-official-1.vrm', scale: 13, label: 'Hatcher 1', category: 'hatcher', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-1.png' }, // PLACEHOLDER (Phase 4 swap)
  hatcher_2: { path: '/avatars/milady-official-2.vrm', scale: 13, label: 'Hatcher 2', category: 'hatcher', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-2.png' }, // PLACEHOLDER (Phase 4 swap)
  hatcher_3: { path: '/avatars/milady-official-3.vrm', scale: 13, label: 'Hatcher 3', category: 'hatcher', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-3.png' }, // PLACEHOLDER (Phase 4 swap)
  hatcher_4: { path: '/avatars/milady-official-4.vrm', scale: 13, label: 'Hatcher 4', category: 'hatcher', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-4.png' }, // PLACEHOLDER (Phase 4 swap)
  hatcher_5: { path: '/avatars/milady-official-5.vrm', scale: 13, label: 'Hatcher 5', category: 'hatcher', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-5.png' }, // PLACEHOLDER (Phase 4 swap)
  hatcher_6: { path: '/avatars/milady-official-6.vrm', scale: 13, label: 'Hatcher 6', category: 'hatcher', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-6.png' }, // PLACEHOLDER (Phase 4 swap)
  hatcher_7: { path: '/avatars/milady-official-7.vrm', scale: 13, label: 'Hatcher 7', category: 'hatcher', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-7.png' }, // PLACEHOLDER (Phase 4 swap)
  hatcher_8: { path: '/avatars/milady-official-8.vrm', scale: 13, label: 'Hatcher 8', category: 'hatcher', avatar_type: 'vrm', animatorId: 'vrm-milady', preview: '/avatars/previews/milady-official-8.png' }, // PLACEHOLDER (Phase 4 swap)

  // ── Hatcher bespoke avatars (Meshy pipeline, 2026-06-18) — reserved (NOT in picker) ──
  // The 4 Greek-mythology Hatcher characters via OpenAI-images → Meshy-v6-mesh →
  // Meshy-rig → VRM (see packages/database/character-pipeline.md). 22/22 humanoid
  // bones, VRM 1.0, meshopt+WebP optimized to ~3 MB. pickerHidden → selectable
  // ONLY through Hatcher (species key); excluded from the create-agent picker
  // (category allowlist) AND the in-game appearance grid (pickerHidden filter) AND
  // rejected on human avatars.ts POST/PATCH. Phanes stays DEFAULT_HATCHER_MODEL_KEY.
  // animatorId by sex shares the existing retarget set for now — native Meshy-clip
  // animation is the deferred "wire-in" step (clips at /models/<slug>-mesh/meshy-openai/anim/).
  // ?v=2 cache-busts the prior VRMs at the same /avatars/ URLs.
  phanes:       { path: '/avatars/phanes.vrm?v=2',       scale: 13, label: 'Phanes',       category: 'hatcher', avatar_type: 'vrm', animatorId: 'hermes-male',   faceYaw: Math.PI, pickerHidden: true, preview: '/models/phanes-turnaround/openai/front.png?v=2' },
  cronus:       { path: '/avatars/cronus.vrm?v=2',       scale: 13, label: 'Cronus',       category: 'hatcher', avatar_type: 'vrm', animatorId: 'hermes-male',   faceYaw: Math.PI, pickerHidden: true, preview: '/models/cronus-turnaround/openai/front.png?v=2' },
  helen:        { path: '/avatars/helen.vrm?v=2',        scale: 13, label: 'Helen',        category: 'hatcher', avatar_type: 'vrm', animatorId: 'hermes-female', faceYaw: Math.PI, pickerHidden: true, preview: '/models/helen-turnaround/openai-v2/front.png?v=2' },
  clytemnestra: { path: '/avatars/clytemnestra.vrm?v=2', scale: 13, label: 'Clytemnestra', category: 'hatcher', avatar_type: 'vrm', animatorId: 'hermes-female', faceYaw: Math.PI, pickerHidden: true, preview: '/models/clytemnestra-turnaround/openai-v2/front.png?v=2' },

  // ── Adinero — wandering NPC clown comedian (Meshy pipeline 2026-06-19) ──
  // NPC-ONLY decorative wanderer (NOT a player/Hatcher avatar). Same OpenAI→Meshy-6
  // →rig→VRM pipeline as the Hatcher fleet (VRM 1.0, 22 humanoid bones, meshopt+WebP
  // ~3 MB). Lives ONLY as the `adinero` NPC species (npc-definitions.ts); pickerHidden
  // keeps it out of /create-agent. animatorId 'hermes-male' reuses the existing retarget
  // locomotion (walk/run/idle) — same as Cyrus (hermes_male wanderer). faceYaw Math.PI
  // (VRM1 faces +Z → flip to -Z toward camera). NOT in shared AGENT_MODELS — NPC species
  // are free strings, only the web render map needs the key.
  adinero:      { path: '/avatars/adinero.vrm?v=1',      scale: 13, label: 'Adinero',      category: 'other',   avatar_type: 'vrm', animatorId: 'hermes-male',   faceYaw: Math.PI, pickerHidden: true },

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

/**
 * Reverse-lookup the animatorId for a model by its VRM/GLB path.
 * Used by surfaces that hold only the path (ReefRacePlayer, dynamic loaders)
 * — anywhere with the full registry entry should prefer `reg.animatorId`.
 * Returns undefined for unregistered paths or entries without an animatorId.
 */
export function getAnimatorIdByPath(path: string): string | undefined {
  for (const entry of Object.values(MODEL_REGISTRY) as ModelRegistryEntry[]) {
    if (entry.path === path) return entry.animatorId;
  }
  return undefined;
}

// Category metadata for the picker UI tabs.
export const CATEGORY_META: Partial<Record<AgentCategory, { label: string; description: string }>> = {
  openclaw: { label: 'OpenClaw', description: 'Crustacean agents — external gateway or OpenClaw framework' },
  other:    { label: 'Other',    description: 'Sea-creature agents — any framework' },
  milady:   { label: 'Milady',   description: 'Milady VRM avatars — humanoid Milady AI characters' },
  hermes:   { label: 'Hermes',   description: 'Hermes VRM avatars — ClawVille-hosted Hermes runtimes' },
  chibi:    { label: 'Chibi',    description: 'Mini stylized humanoids — half-height chibi proportions' },
  // PLACEHOLDER (Phase 4 swap): description + label will update when bespoke Hatcher VRMs ship.
  hatcher:  { label: 'Hatcher',  description: 'Hatcher-hosted agents — placeholder Milady avatars until bespoke meshes (Phase 4)' },
};

// Ordered list of categories for tab rendering.
// milady restored 2026-04-21 with 8 VRM avatars; hermes added 2026-05-12; chibi added 2026-05-21.
// hatcher added 2026-06-01 (Phase 2 — placeholder Milady VRMs; Phase 4 swaps to bespoke Hatcher meshes).
export const CATEGORY_ORDER: AgentCategory[] = ['openclaw', 'other', 'milady', 'hermes', 'chibi', 'hatcher'];

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
  hermes:   'hermes_female',
  chibi:    'eliza_chibi',
  hatcher:  'hatcher_1', // PLACEHOLDER (Phase 4 swap)
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
  // Hermes VRMs map to 'fox' (humanoid → closest legacy fantasy fallback). The
  // 3D path uses the actual VRM; this is purely the PixiJS 2D fallback sprite.
  hermes_female:      'fox',
  hermes_male:        'fox',
  tekk:               'fox',
  // Chibi VRMs (added 2026-05-21) — same 'fox' fallback as other humanoids.
  eliza_chibi:        'fox',
  milady_chibi:       'fox',
  // Hatcher placeholder VRMs (added 2026-06-01) — humanoid → 'fox' fallback,
  // same as Milady/Hermes/Chibi. Phase 4 does not change this mapping; only
  // the MODEL_REGISTRY path entries are swapped to bespoke Hatcher VRMs.
  // PLACEHOLDER (Phase 4 swap)
  hatcher_1:          'fox',
  hatcher_2:          'fox',
  hatcher_3:          'fox',
  hatcher_4:          'fox',
  hatcher_5:          'fox',
  hatcher_6:          'fox',
  hatcher_7:          'fox',
  hatcher_8:          'fox',
  // Phanes (default Hatcher avatar) — humanoid → 'fox' 2D fallback like the rest.
  phanes:             'fox',
  // Bespoke Meshy Hatcher avatars (2026-06-18) — humanoid → 'fox' 2D fallback.
  cronus:             'fox',
  helen:              'fox',
  clytemnestra:       'fox',
  // Adinero (wandering NPC clown, 2026-06-19) — humanoid → 'fox' 2D fallback.
  adinero:            'fox',
};
