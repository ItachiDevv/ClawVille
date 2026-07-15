/**
 * asset-preload-manifest.ts
 *
 * Single source of truth for every asset the world boot needs.
 * Call `preloadWorldAssets()` from game/page.tsx as early as possible —
 * ideally in a `useEffect` on the FIRST render pass, BEFORE mounting the
 * dynamic World3DCanvas chunk. This fires parallel fetch/decode requests
 * in the browser while Next.js is still downloading the canvas chunk,
 * reducing effective TTI-to-first-building by 800-1500 ms on warm cache.
 *
 * Why this exists:
 *   - World3DCanvas is a `dynamic()` import with ssr:false. The
 *     THREE.DefaultLoadingManager.onProgress hook is module-scope inside
 *     that chunk — it doesn't install until the chunk downloads AND
 *     executes. Until then, `window.__W3D_PROGRESS` stays 0 and the
 *     loading bar is frozen.
 *   - `useGLTF.preload()` and `preloadVRMBytes()` live inside mounted
 *     components in World3DCanvas. They fire even later — after chunk
 *     download, after React commit, after Suspense resolves.
 *   - By calling the preloads here, from the page level, the browser's
 *     HTTP/2 multiplexer can fetch GLBs + VRMs in parallel with the
 *     canvas chunk download, hiding the longest network legs.
 *
 * --- Asset inventory ---
 * (update this comment + the arrays below whenever an asset is added/removed)
 *
 * BUILDINGS (11 GLBs + 1 procedural treedome, arena-buildings.tsx BUILDING_MODELS):
 *   pineapple-house-opt1-ktx.glb?v=3, chum-bucket-v2-opt1-ktx.glb?v=4,
 *   krusty-krab-v2-opt1-ktx.glb?v=4, salty-spitoon-opt1-ktx.glb?v=3,
 *   boating-school-opt1-ktx.glb?v=3,
 *   patty-building-opt1-ktx.glb?v=3, building-lighthouse-opt1-ktx.glb?v=3,
 *   arcade/claw-arcade-exterior-opt1-ktx.glb?v=4, cove/cove-exterior-opt1-ktx.glb?v=4,
 *   patricks-rock-v2-opt1-ktx.glb?v=5, squidward-house-opt1-ktx.glb?v=5
 *   Sandy's Treedome is procedural in /game after 2026-05-25 perf pass; the
 *   old GLB contributed ~1.13M live tris after material merge.
 *
 * LOCATION NPC CHARACTERS (10 SpongeBob + 2 companions, arena-location-npcs.tsx):
 *   spongebob-ktx.glb, gary-ktx.glb, squidward-ktx.glb, flying-dutchman-ktx.glb,
 *   pearl-ktx.glb, mrs-puff-ktx.glb, lobster_plush-ktx.glb?v=2, mr-krabs-ktx.glb,
 *   plankton-ktx.glb, karen-ktx.glb, sandy-ktx.glb, patrick-ktx.glb
 *
 * WANDERING NPC GLBs (1 live species, arena-npcs.tsx SPECIES_MODEL):
 *   lobster-ktx.glb?v=2
 *
 * WANDERING NPC VRMs (6 distinct paths, arena-npcs.tsx preloadVRMBytes):
 *   milady-official-1..8.vrm (8 wanderers + Hermes/chibi),
 *   hermes-female.vrm, hermes-male.vrm, tekk.vrm
 *
 * PLAYER VRMs (8 Milady + 3 Hermes/Tekk + 2 Chibi, agent-model-registry.ts):
 *   milady-official-1..8.vrm, hermes-female.vrm, hermes-male.vrm, tekk.vrm,
 *   eliza-chibi.vrm?v=3, milady-chibi.vrm?v=3 (all preloaded in tier-2 —
 *   lazy chibi gating reverted 2026-05-22 because it hid chibi NPC species
 *   for non-chibi players when the wandering roster included them).
 *
 * TERRAIN DECORATIONS (12 models, arena-terrain.tsx DECO_MODEL_PATHS):
 *   coral-reef1-ktx.glb?v=2, coral-reef2-ktx.glb?v=2, coral-reef3-ktx.glb?v=2, kelp.glb,
 *   building-shell-ktx.glb?v=2, building-seashell-ktx.glb?v=2, building-anchor.glb,
 *   building-barrel.glb, building-chest.glb, building-lantern-ktx.glb?v=2,
 *   crayfish-ktx.glb?v=2, building-tower2.glb
 *
 * LOCOMOTION ANIMATIONS (3 GLBs, vrm-character-animator.ts):
 *   /avatars/animations/idle.glb
 *   /avatars/animations/walk.glb
 *   /avatars/animations/run.glb
 *
 * EMOTE BUNDLE (1 multi-clip GLB, v1):
 *   /avatars/animations/_emotes.glb?v=1
 *
 * GPU/Iris Xe constraints honoured here:
 *   - No InstancedMesh, no ShaderMaterial, no drei Text/Billboard
 *   - preloadVRMBytes() only fires fetch() — parse happens at VRMNpcMesh mount
 *   - useGLTF.preload() is called outside of a React component via the drei
 *     module-level API, which is legal (it populates the useSuspense cache).
 */

import { useGLTF } from '@react-three/drei';
import { preloadVRMBytes } from '@/lib/three/vrm-loader';
import { preloadMixamoClips } from '@/lib/three/vrm-character-animator';
import { preloadKTX2Bytes } from '@/lib/three/use-gltf-ktx2';

// ---------------------------------------------------------------------------
// Priority 1: Building GLBs — largest single group, most visible, critical path
// These are module-scope calls so they fire immediately when this module loads,
// but `preloadWorldAssets()` duplicates them inside the useEffect hook so they
// also fire when called explicitly before the dynamic chunk downloads.
// ---------------------------------------------------------------------------

/** Building GLBs from arena-buildings.tsx BUILDING_MODELS. Sandy's Treedome is procedural. */
export const BUILDING_GLBS: readonly string[] = [
  '/models/pineapple-house-opt1-ktx.glb?v=3',
  '/models/chum-bucket-v2-opt1-ktx.glb?v=4',
  '/models/krusty-krab-v2-opt1-ktx.glb?v=4',
  '/models/salty-spitoon-opt1-ktx.glb?v=3',
  '/models/boating-school-opt1-ktx.glb?v=3',
  '/models/patty-building-opt1-ktx.glb?v=3',
  '/models/building-lighthouse-opt1-ktx.glb?v=3',
  '/models/arcade/claw-arcade-exterior-opt1-ktx.glb?v=4',
  '/models/cove/cove-exterior-opt1-ktx.glb?v=4',
  '/models/patricks-rock-v2-opt1-ktx.glb?v=5',
  '/models/squidward-house-opt1-ktx.glb?v=5',
] as const;

// ---------------------------------------------------------------------------
// Priority 2: Wandering NPC GLBs — visible from the start in the open world
// ---------------------------------------------------------------------------

/** GLB species used by the live arena-npcs.tsx wandering GLB roster */
export const WANDERING_NPC_GLBS: readonly string[] = [
  '/models/lobster-ktx.glb?v=2',
] as const;

// ---------------------------------------------------------------------------
// Priority 2: VRM bytes — wandering VRM NPCs + player avatar candidates
// preloadVRMBytes() fires a fetch() and caches the ArrayBuffer so first
// useVRMInstance() parse hits memory, not the network.
// ---------------------------------------------------------------------------

/** VRM paths used by the 13 wandering VRM NPCs (arena-npcs.tsx).
 *  2026-05-27: restored full 8-Milady cast; was 3 Miladys + 3 Hermes. */
export const WANDERING_VRM_PATHS: readonly string[] = [
  '/avatars/milady-official-1.vrm',
  '/avatars/milady-official-2.vrm',
  '/avatars/milady-official-3.vrm',
  '/avatars/milady-official-4.vrm',
  '/avatars/milady-official-5.vrm',
  '/avatars/milady-official-6.vrm',
  '/avatars/milady-official-7.vrm',
  '/avatars/milady-official-8.vrm',
  // ?v=2 (hermes/tekk) + ?v=3 (chibis) — perf round 2 decimation bust 2026-06-13.
  // MUST match agent-model-registry.ts MODEL_REGISTRY paths EXACTLY: a preload
  // url that differs from the registry url by even the ?v double-fetches + misses
  // the cache. hermes/tekk = ?v=2 (geom decimate); chibis = ?v=2→?v=3 (geom + tex).
  '/avatars/hermes-female.vrm?v=2',
  '/avatars/hermes-male.vrm?v=2',
  '/avatars/tekk.vrm?v=2',
  '/avatars/eliza-chibi.vrm?v=3',
  '/avatars/milady-chibi.vrm?v=3',
] as const;

/** All selectable player VRM paths (agent-model-registry.ts MODEL_REGISTRY).
 *  Chibi VRMs are preloaded alongside the others — the lazy-chibi gating was
 *  removed 2026-05-22 per user direction (it was a bad fix that hid chibi NPCs
 *  for non-chibi players when wandering NPC rosters included chibi species). */
export const PLAYER_VRM_PATHS: readonly string[] = [
  '/avatars/milady-official-1.vrm',
  '/avatars/milady-official-2.vrm',
  '/avatars/milady-official-3.vrm',
  '/avatars/milady-official-4.vrm',
  '/avatars/milady-official-5.vrm',
  '/avatars/milady-official-6.vrm',
  '/avatars/milady-official-7.vrm',
  '/avatars/milady-official-8.vrm',
  // ?v=2 (hermes/tekk) + ?v=3 (chibis) — perf round 2 decimation bust 2026-06-13.
  // Identical ?v scheme as WANDERING_VRM_PATHS above; MUST match the registry.
  '/avatars/hermes-female.vrm?v=2',
  '/avatars/hermes-male.vrm?v=2',
  '/avatars/tekk.vrm?v=2',
  '/avatars/eliza-chibi.vrm?v=3',
  '/avatars/milady-chibi.vrm?v=3',
] as const;

// ---------------------------------------------------------------------------
// Priority 3: Location (SpongeBob) character GLBs — sit at buildings, deferred
// ---------------------------------------------------------------------------

/** SpongeBob character GLBs from arena-location-npcs.tsx LOCATION_NPCS */
export const LOCATION_NPC_GLBS: readonly string[] = [
  '/models/characters/spongebob-ktx.glb',
  '/models/characters/gary-ktx.glb',       // companion at visual-creation
  '/models/characters/squidward-ktx.glb',
  '/models/characters/flying-dutchman-ktx.glb',
  '/models/characters/pearl-ktx.glb',
  '/models/characters/mrs-puff-ktx.glb',
  '/models/characters/mr-krabs-ktx.glb',
  '/models/characters/plankton-ktx.glb',
  '/models/characters/karen-ktx.glb',      // companion at code-development
  '/models/characters/sandy-ktx.glb',
  '/models/characters/patrick-ktx.glb',
  '/models/lobster_plush-ktx.glb?v=2',          // Larry (deployment-ops) — shared path w/ wandering
] as const;

// ---------------------------------------------------------------------------
// Priority 4: Terrain decoration GLBs — scattered props, deferred
// ---------------------------------------------------------------------------

/** 12 scatter decoration GLBs from arena-terrain.tsx DECO_MODEL_PATHS */
export const DECORATION_GLBS: readonly string[] = [
  '/models/coral-reef1-ktx.glb?v=2',
  '/models/coral-reef2-ktx.glb?v=2',
  '/models/coral-reef3-ktx.glb?v=2',
  '/models/kelp.glb',
  '/models/building-shell-ktx.glb?v=2',
  '/models/building-seashell-ktx.glb?v=2',
  '/models/building-anchor.glb',
  '/models/building-barrel.glb',
  '/models/building-chest.glb',
  '/models/building-lantern-ktx.glb?v=2',
  '/models/crayfish-ktx.glb?v=2',
  '/models/building-tower2.glb',
] as const;

/**
 * Town-center prop GLBs — always-present world structures the player sees on
 * spawn. These were missing from the preload manifest at audit time so they
 * streamed in only after the canvas mounted, contributing to the "loading
 * screen feels idle" effect. Added 2026-05-22 alongside the perf pass.
 * The pavilion gets a `?v=2` cache-bust because its texture-resize pass
 * (1024→512) mutated the file in place; without the query bump Cloudflare's
 * 7-day edge cache would keep serving the old 8.7 MB version.
 */
export const TOWN_PROP_GLBS: readonly string[] = [
  '/models/quest-bounty-pavilion-ktx.glb?v=4',
  '/models/bazaar-merchant-stand-ktx.glb?v=3', // ?v=3 — P1b non-color KTX2 coverage (2026-07-14)
  '/models/shisha-oasis-ktx.glb?v=2',
  // town-directory-sign.tsx uses Three.js primitives only (no GLB) — nothing to preload here.
  // Auction podium removed 2026-07-15 — superseded by quest-bounty-pavilion.
] as const;

// ---------------------------------------------------------------------------
// Priority 2: Locomotion animation GLBs — needed by every VRM avatar
// (also precached by sw.js v3, so second visit is free)
// ---------------------------------------------------------------------------

/** Locomotion clips needed by VRMCharacterAnimator at mount */
export const LOCOMOTION_ANIM_GLBS: readonly string[] = [
  '/avatars/animations/idle.glb',
  '/avatars/animations/walk.glb',
  '/avatars/animations/run.glb',
] as const;

/** Emote bundle (19 clips, ~2.2 MB) — fetch once, amortised across session */
export const EMOTE_BUNDLE = '/avatars/animations/_emotes.glb?v=1' as const;

// ---------------------------------------------------------------------------
// preloadWorldAssets()
//
// Call this from game/page.tsx in a useEffect on first render — BEFORE the
// dynamic World3DCanvas chunk mounts. The browser will fetch + decode assets
// in parallel with the chunk download, hiding the longest network legs.
//
// Ordering: critical-path assets first (buildings, locomotion, wandering NPCs),
// then deferred assets (characters, decorations, player VRMs).
// All calls are idempotent — useGLTF.preload() and preloadVRMBytes() are
// no-ops if the asset is already in cache.
//
// Tier 1 — fire immediately (parallel with canvas chunk download):
//   buildings + locomotion + wandering NPC GLBs + wandering VRM bytes
// Tier 2 — intentionally lazy:
//   selectable player VRM bytes are loaded by the active avatar or the avatar picker,
//   not by the open-world boot path
// Tier 3 — fire after first rAF (exact timing matches DeferredNpcPreloads):
//   location NPC GLBs + decoration GLBs (currently done by DeferredTerrainPreloads
//   + DeferredNpcPreloads, which fire their own rAF preloads from game/page.tsx —
//   those existing hooks already cover tier-3 correctly).
// ---------------------------------------------------------------------------

let _preloadCalled = false;

function preloadGlbUrl(url: string): void {
  if (url.includes('-ktx.glb')) preloadKTX2Bytes(url);
  else useGLTF.preload(url);
}

export function preloadWorldAssets(): void {
  // Guard: safe to call multiple times — only runs once per page load.
  if (_preloadCalled) return;
  _preloadCalled = true;

  // --- Tier 1 — critical path (buildings + locomotion + wandering NPCs) ---

  // Buildings: 12 GLBs. useGLTF.preload() populates the Suspense cache used
  // by GLBBuilding's useGLTF() calls. Meshopt extension is NOT passed here
  // (extendLoaderWithMeshopt requires the component-level loader context);
  // if a building GLB uses EXT_meshopt_compression the per-component hook
  // in arena-buildings.tsx will handle it. The preload still warms the
  // HTTP cache so the fetch is free by the time the component hook fires.
  for (const url of BUILDING_GLBS) {
    preloadGlbUrl(url);
  }

  // Locomotion clips: 3 GLBs, critical for any VRM avatar render.
  // preloadMixamoClips() calls preloadLocomotionClips() internally.
  preloadMixamoClips();

  // Wandering NPC GLBs — 1 live crustacean species.
  for (const url of WANDERING_NPC_GLBS) {
    preloadGlbUrl(url);
  }

  // Town-center prop GLBs — always-present world structures (pavilion, bazaar,
  // shisha-oasis). Added 2026-05-22 — were previously missing
  // from the manifest, which is why they streamed in only after canvas mount.
  for (const url of TOWN_PROP_GLBS) {
    preloadGlbUrl(url);
  }

  // Wandering VRM bytes — 6 paths used by the live wandering VRM NPC roster.
  for (const url of WANDERING_VRM_PATHS) {
    preloadVRMBytes(url);
  }

  // --- Tier 3 note ---
  // Location NPC GLBs and decoration GLBs are already covered by:
  //   DeferredNpcPreloads (rAF in game/page.tsx)
  //   DeferredTerrainPreloads (rAF in game/page.tsx)
  // Those hooks fire their own useGLTF.preload() calls after first paint.
  // No duplication needed here.
}

// ---------------------------------------------------------------------------
// Convenience: full list of ALL GLB URLs the world needs (for audit / SW cache manifest)
// ---------------------------------------------------------------------------
export const ALL_WORLD_GLBS: readonly string[] = [
  ...BUILDING_GLBS,
  ...WANDERING_NPC_GLBS,
  ...TOWN_PROP_GLBS,
  ...LOCATION_NPC_GLBS,
  ...DECORATION_GLBS,
  ...LOCOMOTION_ANIM_GLBS,
  EMOTE_BUNDLE,
] as const;

export const ALL_WORLD_VRMS: readonly string[] = [
  ...PLAYER_VRM_PATHS,
] as const;

// ---------------------------------------------------------------------------
// WORLD_PRELOAD_MANIFEST — flat string[] of every asset path the open-world
// scene needs, in priority order (critical-path first).
//
// Intended consumers:
//   - Service worker cache manifest (sw.js ASSET_PATH_PREFIXES supplement)
//   - `preloadWorldAssets()` above (uses the same ordering internally)
//   - `docs/perf-audit-2026-05-22.md` Section B asset inventory
//
// Wire-up snippet for game/page.tsx (do NOT edit source files from this manifest;
// add the following two pieces to game/page.tsx yourself):
//
//   // At top of file, with other imports:
//   import { preloadWorldAssets } from '@/lib/three/asset-preload-manifest';
//
//   // Inside GamePage() component, alongside the existing useEffect(() => { setMounted(true); }, []):
//   useEffect(() => {
//     preloadWorldAssets();
//   }, []); // eslint-disable-line react-hooks/exhaustive-deps
//
// Why a separate useEffect (not inlined into the mounted setter):
//   React 18 strict-mode double-invokes effects in development; preloadWorldAssets()
//   has a `_preloadCalled` idempotency guard so double-invocation is safe.
//   The separate effect also avoids coupling the preload to the mounted state
//   setter, which has its own re-render semantics.
// ---------------------------------------------------------------------------
export const WORLD_PRELOAD_MANIFEST: readonly string[] = [
  // Tier 1 — critical path (fired immediately by preloadWorldAssets)
  ...BUILDING_GLBS,
  ...TOWN_PROP_GLBS,
  ...LOCOMOTION_ANIM_GLBS,
  ...WANDERING_NPC_GLBS,
  ...WANDERING_VRM_PATHS,
  // Tier 2 — lazy player VRMs are intentionally omitted from boot preloads.
  // Tier 3 — deferred (after first paint, handled by DeferredTerrainPreloads / DeferredNpcPreloads)
  ...LOCATION_NPC_GLBS,
  ...DECORATION_GLBS,
  EMOTE_BUNDLE,
] as const;
