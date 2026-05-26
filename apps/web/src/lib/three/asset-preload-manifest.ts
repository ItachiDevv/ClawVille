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
 *   pineapple-house-opt1.glb?v=2, chum-bucket-v2-opt1.glb?v=2,
 *   krusty-krab-v2-opt1.glb?v=2, salty-spitoon-opt1.glb?v=2,
 *   boating-school-opt1.glb?v=2,
 *   patty-building-opt1.glb?v=2, building-lighthouse-opt1.glb?v=2,
 *   arcade/claw-arcade-exterior-opt1.glb?v=2, cove/cove-exterior-opt1.glb?v=2,
 *   patricks-rock-v2-opt1.glb?v=3, squidward-house-opt1.glb?v=3
 *   Sandy's Treedome is procedural in /game after 2026-05-25 perf pass; the
 *   old GLB contributed ~1.13M live tris after material merge.
 *
 * LOCATION NPC CHARACTERS (10 SpongeBob + 2 companions, arena-location-npcs.tsx):
 *   spongebob.glb, gary.glb, squidward.glb, flying-dutchman.glb,
 *   pearl.glb, mrs-puff.glb, lobster_plush.glb, mr-krabs.glb,
 *   plankton.glb, karen.glb, sandy.glb, patrick.glb
 *
 * WANDERING NPC GLBs (1 live species, arena-npcs.tsx SPECIES_MODEL):
 *   lobster.glb
 *
 * WANDERING NPC VRMs (6 distinct paths, arena-npcs.tsx preloadVRMBytes):
 *   milady-official-2.vrm, milady-official-7.vrm, milady-official-8.vrm,
 *   hermes-female.vrm, hermes-male.vrm, tekk.vrm
 *
 * PLAYER VRMs (8 Milady + 3 Hermes/Tekk + 2 Chibi, agent-model-registry.ts):
 *   milady-official-1..8.vrm, hermes-female.vrm, hermes-male.vrm, tekk.vrm,
 *   eliza-chibi.vrm?v=2, milady-chibi.vrm?v=2 (all preloaded in tier-2 —
 *   lazy chibi gating reverted 2026-05-22 because it hid chibi NPC species
 *   for non-chibi players when the wandering roster included them).
 *
 * TERRAIN DECORATIONS (12 models, arena-terrain.tsx DECO_MODEL_PATHS):
 *   coral-reef1.glb, coral-reef2.glb, coral-reef3.glb, kelp.glb,
 *   building-shell.glb, building-seashell.glb, building-anchor.glb,
 *   building-barrel.glb, building-chest.glb, building-lantern.glb,
 *   crayfish.glb, building-tower2.glb
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

// ---------------------------------------------------------------------------
// Priority 1: Building GLBs — largest single group, most visible, critical path
// These are module-scope calls so they fire immediately when this module loads,
// but `preloadWorldAssets()` duplicates them inside the useEffect hook so they
// also fire when called explicitly before the dynamic chunk downloads.
// ---------------------------------------------------------------------------

/** Building GLBs from arena-buildings.tsx BUILDING_MODELS. Sandy's Treedome is procedural. */
export const BUILDING_GLBS: readonly string[] = [
  '/models/pineapple-house-opt1.glb?v=2',
  '/models/chum-bucket-v2-opt1.glb?v=2',
  '/models/krusty-krab-v2-opt1.glb?v=2',
  '/models/salty-spitoon-opt1.glb?v=2',
  '/models/boating-school-opt1.glb?v=2',
  '/models/patty-building-opt1.glb?v=2',
  '/models/building-lighthouse-opt1.glb?v=2',
  '/models/arcade/claw-arcade-exterior-opt1.glb?v=2',
  '/models/cove/cove-exterior-opt1.glb?v=2',
  '/models/patricks-rock-v2-opt1.glb?v=3',
  '/models/squidward-house-opt1.glb?v=3',
] as const;

// ---------------------------------------------------------------------------
// Priority 2: Wandering NPC GLBs — visible from the start in the open world
// ---------------------------------------------------------------------------

/** GLB species used by the live arena-npcs.tsx wandering GLB roster */
export const WANDERING_NPC_GLBS: readonly string[] = [
  '/models/lobster.glb',
] as const;

// ---------------------------------------------------------------------------
// Priority 2: VRM bytes — wandering VRM NPCs + player avatar candidates
// preloadVRMBytes() fires a fetch() and caches the ArrayBuffer so first
// useVRMInstance() parse hits memory, not the network.
// ---------------------------------------------------------------------------

/** VRM paths used by the 5 wandering VRM NPCs (arena-npcs.tsx) */
export const WANDERING_VRM_PATHS: readonly string[] = [
  '/avatars/milady-official-2.vrm',
  '/avatars/milady-official-7.vrm',
  '/avatars/milady-official-8.vrm',
  '/avatars/hermes-female.vrm',
  '/avatars/hermes-male.vrm',
  '/avatars/tekk.vrm',
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
  '/avatars/hermes-female.vrm',
  '/avatars/hermes-male.vrm',
  '/avatars/tekk.vrm',
  '/avatars/eliza-chibi.vrm?v=2',
  '/avatars/milady-chibi.vrm?v=2',
] as const;

// ---------------------------------------------------------------------------
// Priority 3: Location (SpongeBob) character GLBs — sit at buildings, deferred
// ---------------------------------------------------------------------------

/** SpongeBob character GLBs from arena-location-npcs.tsx LOCATION_NPCS */
export const LOCATION_NPC_GLBS: readonly string[] = [
  '/models/characters/spongebob.glb',
  '/models/characters/gary.glb',       // companion at visual-creation
  '/models/characters/squidward.glb',
  '/models/characters/flying-dutchman.glb',
  '/models/characters/pearl.glb',
  '/models/characters/mrs-puff.glb',
  '/models/characters/mr-krabs.glb',
  '/models/characters/plankton.glb',
  '/models/characters/karen.glb',      // companion at code-development
  '/models/characters/sandy.glb',
  '/models/characters/patrick.glb',
  '/models/lobster_plush.glb',          // Larry (deployment-ops) — shared path w/ wandering
] as const;

// ---------------------------------------------------------------------------
// Priority 4: Terrain decoration GLBs — scattered props, deferred
// ---------------------------------------------------------------------------

/** 12 scatter decoration GLBs from arena-terrain.tsx DECO_MODEL_PATHS */
export const DECORATION_GLBS: readonly string[] = [
  '/models/coral-reef1.glb',
  '/models/coral-reef2.glb',
  '/models/coral-reef3.glb',
  '/models/kelp.glb',
  '/models/building-shell.glb',
  '/models/building-seashell.glb',
  '/models/building-anchor.glb',
  '/models/building-barrel.glb',
  '/models/building-chest.glb',
  '/models/building-lantern.glb',
  '/models/crayfish.glb',
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
  '/models/quest-bounty-pavilion.glb?v=2',
  '/models/bazaar-merchant-stand.glb',
  '/models/shisha-oasis.glb',
  '/models/auction-dome.glb',
  // town-directory-sign.tsx uses Three.js primitives only (no GLB) — nothing to preload here.
  // auction-podium.tsx preloads its own jellyfish.glb path.
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
    useGLTF.preload(url);
  }

  // Locomotion clips: 3 GLBs, critical for any VRM avatar render.
  // preloadMixamoClips() calls preloadLocomotionClips() internally.
  preloadMixamoClips();

  // Wandering NPC GLBs — 1 live crustacean species.
  for (const url of WANDERING_NPC_GLBS) {
    useGLTF.preload(url);
  }

  // Town-center prop GLBs — always-present world structures (pavilion, bazaar,
  // shisha-oasis, auction-dome). Added 2026-05-22 — were previously missing
  // from the manifest, which is why they streamed in only after canvas mount.
  for (const url of TOWN_PROP_GLBS) {
    useGLTF.preload(url);
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
