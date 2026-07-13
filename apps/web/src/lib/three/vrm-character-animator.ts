/**
 * vrm-character-animator.ts
 *
 * Drives VRM avatars with Mixamo-sourced animations retargeted to each VRM's
 * humanoid skeleton at runtime.
 *
 * Design:
 *   - 3 Mixamo GLBs (idle/walk/run) are loaded ONCE at module level and cached.
 *   - The cache stores the full GLTF ({ scene, animations }) — the retargeter
 *     needs animation.scene to query rest-pose world quaternions on source rig nodes.
 *   - For each VRM instance, retargetMixamoClip() applies the rest-pose-differential
 *     quaternion transform and emits tracks keyed to that VRM's normalized bone names.
 *   - Each VRM gets its own AnimationMixer (rooted at vrm.scene) + 3 retargeted clips.
 *   - idle ↔ walk crossfade via mixer.crossFadeTo() when isMoving changes.
 *
 * Mixer root — vrm.scene (NOT normalizedHumanBonesRoot):
 *   retargetMixamoClip emits tracks like "Normalized_J_Bip_C_Hips.quaternion".
 *   VRMHumanoidRig (containing those Normalized_* nodes) is a child of vrm.scene,
 *   so PropertyBinding can resolve them when the mixer is rooted at vrm.scene.
 *   The old workaround of rooting at normalizedHumanBonesRoot was only needed
 *   because the previous naive clone+rename retargeter produced stale T-pose
 *   data — the new rest-pose-differential transform makes that workaround
 *   unnecessary and incorrect.
 *
 * Performance:
 *   - Animation keyframe data (Float32Arrays) is shared between VRMs via the
 *     MixamoGltf cache — retargeting only allocates the transformed values slice.
 *   - No per-frame allocations — all scratch objects are class-scoped.
 *   - On Iris Xe budget ~0.3ms per VRM per frame for mixer.update + vrm.update.
 *
 * GPU constraints: no InstancedMesh, no ShaderMaterial, no drei Text/Billboard.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// See vrm-loader.ts — meshoptimizer's decoder object satisfies three's
// strict setMeshoptDecoder signature; three-stdlib's callable does not.
import { MeshoptDecoder } from 'meshoptimizer';
import type { VRM } from '@pixiv/three-vrm';
import { retargetMeshyClip, retargetMixamoClip, type MixamoGltf } from './mixamo-retarget';
import { VRM_METRICS_ENABLED } from './vrm-loader';

// ---------------------------------------------------------------------------
// Per-frame VRM cost instrumentation (PART A — steady-state metrics)
//
// All state is module-scope numeric accumulators. Zero objects or arrays are
// allocated per frame. When VRM_METRICS_ENABLED is false the entire cost is a
// single boolean branch (the `if (VRM_METRICS_ENABLED)` check); no
// performance.now() calls, no writes.
//
// window.__CV_VRM_FRAME_METRICS is created ONCE at module init (SSR-safe).
// The per-frame path accumulates into these numbers. read() and reset() are
// the only paths that allocate an object — both are called by the harness,
// never on the hot path.
// ---------------------------------------------------------------------------

// Numeric accumulators — module scope, plain numbers, zero allocations.
let _fmMixerTotalMs  = 0;   // total ms spent in updateMixerOnly bodies
let _fmSpringTotalMs = 0;   // total ms spent in updateSpringOnly bodies
let _fmFullTotalMs   = 0;   // total ms spent in update() (full/player path)
let _fmMixerCalls    = 0;   // number of updateMixerOnly calls
let _fmSpringCalls   = 0;   // number of updateSpringOnly calls
let _fmFullCalls     = 0;   // number of update() calls
let _fmEpoch         = 0;   // frame-epoch counter (incremented in updateMixerOnly)

// Expose on window once at module init so the harness can read/reset without
// any per-frame overhead. SSR-safe: skip when window is undefined.
if (VRM_METRICS_ENABLED && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__CV_VRM_FRAME_METRICS = {
    /** Return a snapshot of current accumulator state. Allocates once per call. */
    read(): {
      mixerAvgMs: number; springAvgMs: number; fullAvgMs: number;
      mixerCalls: number; springCalls: number; fullCalls: number;
      epoch: number;
    } {
      return {
        mixerAvgMs:  _fmMixerCalls  > 0 ? _fmMixerTotalMs  / _fmMixerCalls  : 0,
        springAvgMs: _fmSpringCalls > 0 ? _fmSpringTotalMs / _fmSpringCalls : 0,
        fullAvgMs:   _fmFullCalls   > 0 ? _fmFullTotalMs   / _fmFullCalls   : 0,
        mixerCalls:  _fmMixerCalls,
        springCalls: _fmSpringCalls,
        fullCalls:   _fmFullCalls,
        epoch:       _fmEpoch,
      };
    },
    /** Reset all accumulators to zero. */
    reset(): void {
      _fmMixerTotalMs  = 0;
      _fmSpringTotalMs = 0;
      _fmFullTotalMs   = 0;
      _fmMixerCalls    = 0;
      _fmSpringCalls   = 0;
      _fmFullCalls     = 0;
      _fmEpoch         = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Mixamo animation asset paths
// ---------------------------------------------------------------------------

// Phase 2 (2026-05-17): 19 emote GLBs (the 6 originals + 13 from the Milady
// fork) are baked into ONE multi-clip bundle by scripts/build-anim-bundles.mjs.
// Path syntax `bundle.glb#clipName` tells loadRawGltf to fetch the bundle
// once and pick the named clip from its `animations[]`. First emote trigger
// pays 2.2 MB once (vs 19 × ~80-300 KB lazy fetches over a session); every
// subsequent emote across that VRM's lifetime is cache-served at zero
// network cost. The bundle is 11% SMALLER than the sum of 19 single-clip
// GLBs after gltf-transform dedup() (skeleton accessors shared).
//
// Locomotion (idle/walk/run) stays as 3 separate GLBs — SW v3 precaches
// them, they're loaded eagerly via preloadLocomotionClips() at /game mount,
// and bundling them would force the 2.2 MB emote payload to load alongside
// (or split the locomotion across two fetches). The 3-file pattern is
// already optimal there.
//
// Surf clips (skateboarding/wipeout/cheering) and cross-character clips
// (swimming/flying/praying) stay separate too — they're prewarmed by the
// reef-race entry point and almost never touched outside that activity.
// Content-version suffix on the bundle URL is the cache-buster: bumping
// EMOTE_BUNDLE_VERSION any time scripts/build-anim-bundles.mjs regenerates
// the file forces Cloudflare's edge + the browser SW to fetch a fresh copy
// without touching the CF cache-purge API (the deploy token we have has
// zone:edit but not cache_purge scope). The page rule matches on path
// only; the `?v=N` query is opaque to it but Cloudflare keys the cache
// entry on the full URL incl. query string, giving us cheap manual purges.
const EMOTE_BUNDLE_VERSION = 1;
const EMOTE_BUNDLE = `/avatars/animations/_emotes.glb?v=${EMOTE_BUNDLE_VERSION}`;
const COVE_SIT_BUNDLE = '/avatars/animations/_cove_sit.glb';

const ANIM_PATHS = {
  // Locomotion — separate GLBs (precached by SW).
  idle:            '/avatars/animations/idle.glb',
  walk:            '/avatars/animations/walk.glb',
  run:             '/avatars/animations/run.glb',
  // Emotes — multi-clip bundle (one fetch on first emote of session).
  looking_around:  `${EMOTE_BUNDLE}#looking_around`,
  squat:           `${EMOTE_BUNDLE}#squat`,
  waving:          `${EMOTE_BUNDLE}#waving`,
  talk:            `${EMOTE_BUNDLE}#talk`,
  dance_happy:     `${EMOTE_BUNDLE}#dance_happy`,
  float:           `${EMOTE_BUNDLE}#float`,
  crawling:        `${EMOTE_BUNDLE}#crawling`,
  crying:          `${EMOTE_BUNDLE}#crying`,
  dance_breaking:  `${EMOTE_BUNDLE}#dance_breaking`,
  dance_hiphop:    `${EMOTE_BUNDLE}#dance_hiphop`,
  dance_popping:   `${EMOTE_BUNDLE}#dance_popping`,
  fall:            `${EMOTE_BUNDLE}#fall`,
  fishing:         `${EMOTE_BUNDLE}#fishing`,
  flip:            `${EMOTE_BUNDLE}#flip`,
  jump:            `${EMOTE_BUNDLE}#jump`,
  kiss:            `${EMOTE_BUNDLE}#kiss`,
  rude_gesture:    `${EMOTE_BUNDLE}#rude_gesture`,
  sorrow:          `${EMOTE_BUNDLE}#sorrow`,
  spell_cast:      `${EMOTE_BUNDLE}#spell_cast`,
  // Reef Race v2 surf clips — separate, prewarmed by ReefRacePlayer.
  surf_idle:       '/avatars/animations/skateboarding.glb',
  wipeout:         '/avatars/animations/wipeout.glb',
  victory:         '/avatars/animations/cheering.glb',
  // Cross-character bakes — separate (small + only-when-needed).
  swimming:        '/avatars/animations/hermes-female/swimming.glb',
  flying:          '/avatars/animations/tekk-male/flying.glb',
  praying:         '/avatars/animations/hermes-female/praying.glb',
  // Cove seated-bust flow — Meshy source rig, bundled at a new asset path.
  sit_stand_to_sit: `${COVE_SIT_BUNDLE}#sit_stand_to_sit`,
  sit_idle_m:       `${COVE_SIT_BUNDLE}#sit_idle_m`,
  sit_idle_f:       `${COVE_SIT_BUNDLE}#sit_idle_f`,
  sit_to_stand_m:   `${COVE_SIT_BUNDLE}#sit_to_stand_m`,
  sit_to_stand_f:   `${COVE_SIT_BUNDLE}#sit_to_stand_f`,
  // Chibi-introduced emote (2026-05-21). Source bake is chibi-proportioned;
  // retargeter handles proportion drift if a non-chibi VRM ever plays it.
  // Triggered as a one-shot via the emote bus (see EMOTE_ANIM_NAMES below).
  kip_up:          '/avatars/animations/chibi/kip_up.glb',
} as const;

export type AnimName = keyof typeof ANIM_PATHS;

/** Clips authored on Meshy's animation-library rig rather than Mixamo. */
const MESHY_ANIM_NAMES: ReadonlySet<AnimName> = new Set<AnimName>([
  'sit_stand_to_sit',
  'sit_idle_m',
  'sit_idle_f',
  'sit_to_stand_m',
  'sit_to_stand_f',
]);

/** Route each registered clip through the retargeter matching its source rig. */
function retargetAnimationClip(
  animation: MixamoGltf,
  vrm: VRM,
  name: AnimName,
): THREE.AnimationClip {
  return MESHY_ANIM_NAMES.has(name)
    ? retargetMeshyClip(animation, vrm, name)
    : retargetMixamoClip(animation, vrm, name);
}

// ---------------------------------------------------------------------------
// Per-character animation overrides
//
// Mixamo's stock animations (ANIM_PATHS above) are baked on a default Mixamo
// skeleton — bone lengths differ from any specific character. The retargeter
// compensates with a rest-pose-differential rotation, but when bone proportions
// diverge enough (Hermes-female, Hermes-male/Tekk), the resulting deformations
// look wrong (feet meshing together mid-stride, hands clipping through hips).
//
// Fix: per-character bakes downloaded from Mixamo with Skin:With Skin and
// retargeted to the character's actual bone lengths. Override table is now
// data, not code — lives in ./character-anim-overrides.json so the Mixamo
// CLI (scripts/mixamo/{fetch-animations,add-anim-everywhere}.ts) can update
// it programmatically without touching this file. JSON keys must match an
// AnimName; unknown keys are silently ignored (the strip-and-cast below).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
import characterAnimOverridesJson from './character-anim-overrides.json';

const CHARACTER_ANIM_OVERRIDES: Record<string, Partial<Record<AnimName, string>>> =
  Object.fromEntries(
    Object.entries(characterAnimOverridesJson as Record<string, unknown>)
      // Drop the JSON $comment field — it's documentation, not an animatorId.
      .filter(([k]) => !k.startsWith('$'))
      .map(([animatorId, slots]) => [
        animatorId,
        slots as Partial<Record<AnimName, string>>,
      ]),
  );

function resolveAnimPath(name: AnimName, characterId?: string): string {
  if (characterId && CHARACTER_ANIM_OVERRIDES[characterId]?.[name]) {
    return CHARACTER_ANIM_OVERRIDES[characterId][name]!;
  }
  return ANIM_PATHS[name];
}

/**
 * Subset of AnimName intended for one-shot emote triggering. Excludes
 * locomotion clips (idle/walk/run) — those are managed by the locomotion
 * crossfade. Intentionally listed by hand so seeding scripts and the
 * emote hotbar share an authoritative whitelist.
 */
export const EMOTE_ANIM_NAMES = [
  'flip',
  'dance_happy',
  'dance_breaking',
  'dance_hiphop',
  'dance_popping',
  'kiss',
  'fishing',
  'jump',
  'spell_cast',
  'waving',
  'looking_around',
  'squat',
  'talk',
  'crawling',
  'crying',
  'fall',
  'rude_gesture',
  'sorrow',
  'victory',
  'wipeout',
  'float',
  'praying',   // female-only emote: serenity/devotion (kneels, hands together)
  'kip_up',    // chibi-introduced 2026-05-21: prone-to-stand springback emote
] as const satisfies readonly AnimName[];
export type EmoteAnimName = (typeof EMOTE_ANIM_NAMES)[number];

export function isEmoteAnimName(name: string): name is EmoteAnimName {
  return (EMOTE_ANIM_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Module-level raw GLTF cache
//
// Each Mixamo animation GLB is loaded once. The cache stores the full GLTF
// ({ scene, animations }) — the retargeter needs animation.scene to query
// rest-pose world quaternions on the source Mixamo rig nodes.
// ---------------------------------------------------------------------------

type RawGltfEntry =
  | { status: 'pending';  promise: Promise<MixamoGltf> }
  | { status: 'resolved'; gltf:    MixamoGltf }
  | { status: 'rejected'; error:   unknown };

// Cache keyed by the FULL resolved path including the optional `#clipName`
// suffix, so per-character overrides don't collide with the generic clip
// of the same AnimName, and so two characters sharing the same override
// path still hit the same cached entry. The bundle GLB itself is cached
// separately in BUNDLE_CACHE so 19 clips from the same bundle share one
// download.
const RAW_CLIP_CACHE = new Map<string, RawGltfEntry>();

// Separate cache for raw bundle GLBs keyed by file path only (no `#clip`
// suffix). Letting multiple `#clip` entries in RAW_CLIP_CACHE share one
// underlying GLB fetch is the whole point of the bundle — without this
// the first 19 emote triggers would each spin up a separate fetch even
// though they all target the same file.
type BundleEntry =
  | { status: 'pending';  promise: Promise<MixamoGltf> }
  | { status: 'resolved'; gltf:    MixamoGltf }
  | { status: 'rejected'; error:   unknown };
const BUNDLE_CACHE = new Map<string, BundleEntry>();

/** Split `path.glb#clipName` into [path, clipName | null]. */
function splitBundlePath(fullPath: string): [string, string | null] {
  const hash = fullPath.indexOf('#');
  if (hash === -1) return [fullPath, null];
  return [fullPath.slice(0, hash), fullPath.slice(hash + 1)];
}

// Separate loader for anim GLBs — no VRMLoaderPlugin needed
let _animLoader: GLTFLoader | null = null;
function getAnimLoader(): GLTFLoader {
  if (_animLoader) return _animLoader;
  _animLoader = new GLTFLoader();
  // Mixamo-sourced anim GLBs may be meshopt-compressed (gltfpack -cc).
  // Same fix as vrm-loader.ts — without the decoder the whole /game
  // route bails at first loadBufferView call.
  _animLoader.setMeshoptDecoder(MeshoptDecoder);
  return _animLoader;
}

/**
 * Load a Mixamo animation GLB and return a MixamoGltf bundle for the
 * requested clip. Promise is cached at module level — each (file, clip)
 * pair resolves only once and each underlying GLB downloads only once
 * even when many `#clip` entries reference it.
 *
 * Two cache layers:
 *   - RAW_CLIP_CACHE  — keyed by `${path}#${clip}` (per-AnimName view)
 *   - BUNDLE_CACHE    — keyed by `${path}` (file fetch dedup)
 *
 * For single-clip GLBs (no `#`), the bundle cache holds the same MixamoGltf
 * that ends up in RAW_CLIP_CACHE and the two caches store the same object.
 * For multi-clip bundles (`#clipName`), each AnimName gets a MixamoGltf
 * whose `animations[]` contains the ONE matching clip (so the retargeter's
 * existing `animations[0]` pick keeps working). The shared `scene` is the
 * bundle's single base scene — all clips inherit it via Mixamo's shared
 * rest-pose invariant (see build-anim-bundles.mjs for the merge details).
 */
function loadRawGltf(name: AnimName, characterId?: string): Promise<MixamoGltf> {
  const fullPath = resolveAnimPath(name, characterId);

  const cached = RAW_CLIP_CACHE.get(fullPath);
  if (cached) {
    if (cached.status === 'resolved') return Promise.resolve(cached.gltf);
    if (cached.status === 'rejected') return Promise.reject(cached.error);
    return cached.promise;
  }

  const [filePath, clipName] = splitBundlePath(fullPath);

  // Fetch the underlying GLB once (per filePath), reused across all clips.
  const fetchBundle = (): Promise<MixamoGltf> => {
    const b = BUNDLE_CACHE.get(filePath);
    if (b) {
      if (b.status === 'resolved') return Promise.resolve(b.gltf);
      if (b.status === 'rejected') return Promise.reject(b.error);
      return b.promise;
    }
    const p = getAnimLoader()
      .loadAsync(filePath)
      .then((gltf) => {
        if (!gltf.animations.length) {
          throw new Error(`[vrm-animator] No animation clips in ${filePath}`);
        }
        const entry: MixamoGltf = {
          scene:      gltf.scene as THREE.Group,
          animations: gltf.animations,
        };
        entry.scene.updateMatrixWorld(true);
        BUNDLE_CACHE.set(filePath, { status: 'resolved', gltf: entry });
        return entry;
      })
      .catch((err) => {
        BUNDLE_CACHE.set(filePath, { status: 'rejected', error: err });
        throw err;
      });
    BUNDLE_CACHE.set(filePath, { status: 'pending', promise: p });
    return p;
  };

  const promise = fetchBundle()
    .then((bundle) => {
      let entry: MixamoGltf;
      if (clipName) {
        const clip = bundle.animations.find((a) => a.name === clipName);
        if (!clip) {
          throw new Error(
            `[vrm-animator] Bundle ${filePath} missing clip "${clipName}" ` +
            `(found: ${bundle.animations.map((a) => a.name).join(', ')})`,
          );
        }
        // The retargeter reads animations[0] and uses bundle.scene for
        // rest-pose lookups. Sharing the scene across clips is correct —
        // every Mixamo bake uses the same default rig with the same rest
        // pose, and the bundle build script preserved exactly one base
        // scene + N animations that all bind to it by node name.
        entry = { scene: bundle.scene, animations: [clip] };
      } else {
        entry = bundle;
      }
      RAW_CLIP_CACHE.set(fullPath, { status: 'resolved', gltf: entry });
      return entry;
    })
    .catch((err) => {
      RAW_CLIP_CACHE.set(fullPath, { status: 'rejected', error: err });
      throw err;
    });

  RAW_CLIP_CACHE.set(fullPath, { status: 'pending', promise });
  return promise;
}

/**
 * Locomotion clips that EVERY VRM needs immediately so NPCs/player don't sit
 * in T-pose while emote GLBs are still streaming in.
 */
const LOCOMOTION_CLIPS: AnimName[] = ['idle', 'walk', 'run'];

/**
 * Preload only the 3 locomotion clips (idle/walk/run). Use this for the
 * main /game canvas mount — every VRM in the scene plays one of these
 * within a frame of construction. The 19 emote/surf clips are deferred to
 * `preloadEmoteClips()` so we don't open 22 parallel HTTP fetches at page
 * load and saturate the connection pool (which on Iris Xe pushes the
 * first-animated-NPC delay from ~300ms to ~3s).
 *
 * Errors are swallowed — they will surface when
 * `VRMCharacterAnimator.init()` is called.
 */
export function preloadLocomotionClips(): void {
  for (const name of LOCOMOTION_CLIPS) {
    loadRawGltf(name).catch(() => undefined);
  }
}

/**
 * Warm a specific set of clip GLBs without retargeting. Useful when the
 * player has equipped a small set of emotes (≤4 on the hotbar) and we
 * want the network fetch to overlap with the first interactive frame
 * instead of starting after the click. Fetches deduplicate against
 * RAW_CLIP_CACHE so calling this repeatedly is free.
 */
export function preloadClips(names: readonly AnimName[], characterId?: string): void {
  for (const name of names) {
    loadRawGltf(name, characterId).catch(() => undefined);
  }
}

/**
 * Deferred preload of all emote / surf clips. Call this on idle (after
 * first paint) or just-in-time when the player opens the emote hotbar.
 * Uses `requestIdleCallback` when available so it doesn't compete with
 * the first-frame render budget; falls back to a 1.5s timeout otherwise
 * (Safari + older browsers).
 */
export function preloadEmoteClips(): void {
  const allNames = Object.keys(ANIM_PATHS) as AnimName[];
  const emoteNames = allNames.filter((n) => !LOCOMOTION_CLIPS.includes(n));

  const fire = () => {
    for (const name of emoteNames) {
      loadRawGltf(name).catch(() => undefined);
    }
  };

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    (window as any).requestIdleCallback(fire, { timeout: 5000 });
  } else if (typeof setTimeout !== 'undefined') {
    setTimeout(fire, 1500);
  } else {
    fire();
  }
}

/**
 * Mount-time preload. Eagerly fetches only the 3 locomotion GLBs.
 *
 * NOTE 2026-05-17: the emote tier is NO LONGER preloaded on idle. Even
 * `requestIdleCallback`-deferred, fanning out 19 emote GLB fetches at
 * page load cost ~20 round-trips × ~150ms each on Cloudflare's
 * Falkenstein POP — visible in DevTools as a queue of `injected.js`-
 * initiated fetches that stretched first-interactive by several seconds.
 *
 * Emotes now load on-demand inside `playOneShot()` (see ~line 720) on
 * first trigger per VRM instance, and the result is cached in
 * RAW_CLIP_CACHE so subsequent plays are free. Players who never spam
 * emotes never pay for them.
 *
 * Code that genuinely wants to warm the emote cache (e.g. just before
 * opening the emote hotbar) can still call `preloadEmoteClips()`
 * directly — it remains exported.
 */
export function preloadMixamoClips(): void {
  preloadLocomotionClips();
}

// ---------------------------------------------------------------------------
// VRMCharacterAnimator
// One instance per VRM avatar instance (created in useMemo alongside VRM clone).
// ---------------------------------------------------------------------------

const CROSSFADE_DURATION = 0.3; // seconds

/**
 * Clips whose root motion should be FULLY stripped so the character plays
 * the animation in place. Mixamo bakes:
 *   - walk / idle: ~5cm vertical hip bob (good — drives spring bones)
 *   - run: ~30cm vertical AND forward drift (bad — character "resets in place")
 *   - swim / fly: large upward/forward drift (very bad — character flies off
 *     screen then snaps back every loop)
 *
 * The retargeter already zeros X and Z (so walk doesn't moonwalk backwards),
 * but it keeps the Y track for the hip bob. For the clips below we drop the
 * Y track too so the character stays planted at the same height.
 */
const IN_PLACE_CLIPS: ReadonlySet<AnimName> = new Set([
  'run',
  'swimming',
  'flying',
  'praying',  // kneeling/standing prayer pose — strictly stationary
  // 'wipeout' added 2026-05-21 because chibi's "Knocked Out" replacement bakes
  // ~77cm of Mixamo Z (forward) motion that, after Blender's Y-up→glTF axis
  // swap, becomes vertical Y drift. Mixamo's web UI doesn't expose an In-Place
  // toggle for Knocked Out specifically; stripping position tracks at runtime
  // is the only fix. Tradeoff: legacy Hermes wipeout (Stumble Backwards) loses
  // its small intentional backward step — acceptable since wipeout is a
  // crash one-shot, not a locomotion-defining motion.
  'wipeout',
  // 'kip_up' added 2026-05-21. Knocked-Out-and-recover one-shot pair; user
  // wants character to spring up in place, not drift across the floor.
  'kip_up',
  // NOTE (2026-06-17): 'squat' was removed from this set.
  // The 2026-05-22 position-strip was a stop-gap that caused BUG 1 ("midair
  // squat"): stripping the hip-Y track kept the pelvis at standing height
  // while only applying knee-bend rotations → feet were pulled UPWARD toward
  // the fixed pelvis.
  //
  // The 2026-06-17 rework: headless harness confirmed the squat clip's hips
  // position Y is CONSTANT (raw track Y=104.226...104.226, 2 keyframes, zero
  // descent). All crouch motion is rotation-only. The pelvis is lowered
  // PROCEDURALLY in player-avatar.tsx / arena-npcs.tsx (squatCrouchRef ramp)
  // and feet are replanted via VRMCharacterAnimator.getFootWorldYMin() after
  // update(). Letting the position track survive is harmless (Y is constant
  // after retarget), but we leave 'squat' out of IN_PLACE_CLIPS so any future
  // re-baked squat clip WITH real root descent will work automatically.
]);

/**
 * Per-animatorId IN_PLACE override. Some character classes need position-
 * stripped variants of clips that are normally kept (idle, walk) because the
 * character's scale + foot-grounding math makes even a small hip-Y bob clip
 * the feet through the world floor.
 *
 * Chibi case (2026-05-21): chibi VRMs target 135 wu (half the 270 wu default),
 * so the auto-fit scale on a ~2m native bbox is ~67.5. Mixamo's idle has
 * ~3 cm of Y hip oscillation in the source FBX → 2 wu visible bob at render.
 * The retargeter keeps Y for spring-bone impulse, so on every "exhale" the
 * chibi's feet dip ~2 wu below world Y=0. Mixamo's web UI has NO In-Place
 * toggle for `Idle` (it's the canonical in-place pose) so we must strip
 * positions at runtime for this character class only — Hermes/Milady at full
 * scale still benefit from their idle hip bob.
 *
 * Hermes / Tekk locomotion case (2026-06-11): the per-character Mixamo bakes
 * for these three animatorIds were fetched BEFORE the In-Place flag was
 * forced on in fetch-animations.ts.  gltf-transform track inspection showed
 * non-cyclic hips Y drift in their run/walk overrides:
 *   hermes-male run:   first -0.022 → last 3.378  (net +3.40 / loop)
 *   hermes-female run: net +2.91 / loop
 *   tekk run:          net +2.34 / loop
 *   tekk walk:         net +1.60 / loop
 * The global IN_PLACE_CLIPS set already strips the global run clip, but
 * shouldStripPosition() only applies the global set when no per-character
 * entry exists — it does NOT union with PER_CHARACTER_IN_PLACE_CLIPS.
 * These four clips are loaded via resolveAnimPath → character-specific
 * override paths, NOT the global run.glb, so the global IN_PLACE entry
 * is NOT consulted for them.  Adding per-character entries here is the
 * minimal runtime fix — no asset mutation required.
 *
 * Key by animatorId (the second arg to `new VRMCharacterAnimator(vrm, animatorId)`).
 */
const PER_CHARACTER_IN_PLACE_CLIPS: Record<string, ReadonlySet<AnimName>> = {
  chibi:         new Set(['idle', 'walk']),
  // Per-character Mixamo bakes with non-cyclic hips Y drift (net > 1 wu/loop).
  // Global IN_PLACE_CLIPS covers the global run.glb but NOT these override paths.
  //
  // 'walk' is listed here for hermes-male DEFENSIVELY even though there is no
  // `hermes-male.walk` override wired in character-anim-overrides.json today
  // (so resolveAnimPath('walk','hermes-male') currently falls through to the
  // clean global walk.glb — net -0.845, mostly cyclic). The unused asset
  // public/avatars/animations/hermes-male/walk.glb DOES exist on disk and
  // decodes to +1.887 hips-Y drift per loop; if a future change wires it as
  // a `walk` override, the body would sink mid-stride exactly like the
  // hermes-male run case. Pre-arming the strip set here means that wiring is
  // safe by construction — no second regression hunt. (Hatcher review FIX-15
  // / 3D-5.) Phanes, the default Hatcher avatar, animates via animatorId
  // 'hermes-male', so it inherits this guard too.
  'hermes-male':   new Set(['run', 'walk']),
  'hermes-female': new Set(['run']),
  tekk:            new Set(['run', 'walk']),
  // Adinero — Meshy VRM 1.0 rig (armature scale 0.01, hips world-Y ≈ 0.82m).
  // Uses global clips (idle/walk/run) via fallback — no character-anim-overrides
  // entry. The retargeter computes hipsPositionScale = vrmHipsHeight /
  // motionHipsHeight. For global idle.glb motionHipsHeight ≈ 101.6 → scale ≈
  // 0.0081 → the scaled position track is nearly zero but NOT zero; combined
  // with the tiny hermes-male/idle.glb override (hipsHeight ≈ -0.028 →
  // scale ≈ 29.7) the hips translate to Y ≈ -0.83m driving the entire skeleton
  // underground. Fix: strip all position tracks so the FK rest-pose (feet at
  // Y=0 per VRM spec) governs foot placement. Rotation-only retarget via
  // rest-pose-differential is correct across Meshy rigs with Mixamo bone names.
  // Drift values measured 2026-06-20 via gltf-transform hips-Y analysis.
  adinero:         new Set(['idle', 'walk', 'run']),
};

function shouldStripPosition(name: AnimName, animatorId?: string): boolean {
  if (IN_PLACE_CLIPS.has(name)) return true;
  if (animatorId && PER_CHARACTER_IN_PLACE_CLIPS[animatorId]?.has(name)) return true;
  return false;
}

/**
 * Strip ALL position tracks from a retargeted clip so the character plays in
 * place. Walk/idle keep their hip-bob; everything in IN_PLACE_CLIPS or in the
 * per-character override gets a pure rotation-only clip.
 */
function stripPositionTracks(clip: THREE.AnimationClip): THREE.AnimationClip {
  clip.tracks = clip.tracks.filter((t) => !t.name.endsWith('.position'));
  return clip;
}

/**
 * Module-scope scratch Vector3 for foot-bone world-position reads.
 * Allocated once here; never inside useFrame. Zero per-frame GC pressure.
 */
const _squat_footScratch = new THREE.Vector3();

export class VRMCharacterAnimator {
  private vrm: VRM;
  private mixer: THREE.AnimationMixer;
  private actions: Partial<Record<AnimName, THREE.AnimationAction>> = {};
  private currentAction: THREE.AnimationAction | null = null;
  private ready = false;
  private wasMoving = false;
  /**
   * Tracks the resolved locomotion state ('idle' | 'walk' | 'run') across
   * frames so applyCrossfade fires exactly when it changes — not 60×/s.
   * Mirrors `wasMoving` but distinguishes walk vs run so SHIFT-down /
   * joystick-deflect-past-threshold transitions trigger a clip swap.
   */
  private wasMotion: 'idle' | 'walk' | 'run' = 'idle';
  /**
   * The resting locomotion target when isMoving=false.
   * Defaults to 'idle' — existing callers (player-avatar.tsx, arena-npcs.tsx)
   * never call setSurfaceClip() so they remain on 'idle'.
   * Reef Race overrides this to 'surf_idle' after init() resolves so that
   * wipeout/victory one-shots return to surf_idle instead of idle.
   */
  private surfaceClip: AnimName = 'idle';

  /**
   * True while a `playOneShot` emote is in-flight. While true, the
   * isMoving → idle/walk crossfade in update() / updateMixerOnly() is
   * suppressed so the emote can play to completion without being yanked
   * back to locomotion mid-animation. The 'finished' listener clears it
   * and crossfades to the correct locomotion target.
   */
  private oneShotActive = false;
  /** The handler attached for the active one-shot — referenced so we can
   * remove it if a second one-shot fires before the first finishes. */
  private oneShotFinishedHandler: ((e: { action: THREE.AnimationAction }) => void) | null = null;
  /** Monotonic latest-request-wins guard for concurrent lazy clip loads. */
  private oneShotRequestToken = 0;

  // Verse Engine skeleton.update batching (B2 2026-04-24).
  // Three.js WebGLRenderer calls skeleton.update() once per SkinnedMesh before
  // drawing it — but a VRM typically shares one skeleton across 3-4 SkinnedMeshes
  // (body, hair, face, outfit). That's 3× redundant calls per VRM per frame.
  // Pattern from VerseEngine/three-avatar avatar.ts:614:
  //   replace each mesh's skeleton.update with a no-op, cache the original,
  //   and invoke it once per unique skeleton per tick from our update methods.
  // Declared here; populated in constructor after VRM is available.
  //
  // Map<Skeleton, originalUpdateFn> — keyed by skeleton object so that dispose()
  // can restore each skeleton's update function without relying on traversal order
  // being stable. An Array would misalign if any scene graph mutation (reparenting,
  // node removal) happened between construction and disposal (Sakura review finding #1).
  // Reference: https://github.com/VerseEngine/three-avatar/blob/main/src/avatar.ts#L614
  private _skeletonUpdateFns: Map<THREE.Skeleton, () => void> = new Map();

  /**
   * Optional character ID used to look up per-character animation overrides
   * in CHARACTER_ANIM_OVERRIDES. When unset, the generic ANIM_PATHS are used
   * for every clip — current behavior for Milady/legacy avatars.
   */
  private characterId: string | undefined;


  /**
   * Set by dispose(). Guards the async init() path: if the owning component
   * unmounts while init's `await Promise.all(loadRawGltf…)` is still pending
   * (StrictMode double-mount, HMR teardown, fast route swap), dispose() nulls
   * `this.vrm` and `this.mixer` — without this flag, init resumes against null
   * refs and the entire retarget + locomotion-action wiring throws, leaving
   * `ready=false` permanently (avatar stuck T-posing, no walk/run/idle).
   * Reference: regression 2026-05-22 from commit 8064ef5b.
   */
  private disposed = false;

  constructor(vrm: VRM, characterId?: string) {
    this.vrm = vrm;
    this.characterId = characterId;
    // Mixer is rooted at vrm.scene so PropertyBinding can resolve
    // Normalized_* node names. VRMHumanoidRig (containing those nodes)
    // is a child of vrm.scene — scene.getObjectByName() finds them from here.
    // (Previous workaround rooted at normalizedHumanBonesRoot; removed because
    //  the retargeter now applies the correct rest-pose-differential transform.)
    this.mixer = new THREE.AnimationMixer(vrm.scene);

    // Wire skeleton batching: collect one update fn per unique skeleton,
    // replace each SkinnedMesh's skeleton.update with a no-op so the renderer
    // doesn't call it N times per frame (once per mesh that shares the skeleton).
    vrm.scene.traverse((obj) => {
      const sm = obj as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh || !sm.skeleton) return;
      if (this._skeletonUpdateFns.has(sm.skeleton)) {
        // Second+ mesh sharing this skeleton — no-op its update too so the
        // renderer skips it, but we already have the original fn cached.
        sm.skeleton.update = () => {};
        return;
      }
      // Assumption: skeleton.update has NOT been monkey-patched by another system.
      // If it has (e.g. a prior VRMCharacterAnimator that was not disposed), we will
      // cache the already-patched no-op and restore it on dispose — leaving the
      // skeleton permanently disabled. Low risk in ClawVille given our architecture
      // (one animator per VRM instance, always disposed before a new one is created),
      // but flag it in dev mode so double-patching is visible immediately.
      //
      // Dev-mode guard portability (Sakura review finding #1): `typeof process`
      // check short-circuits cleanly in environments where `process` isn't defined
      // (pure browser without a Node polyfill, Deno, etc.). Without it, consumers
      // outside Next.js's build-time substitution would either ReferenceError or
      // leak the warn when NODE_ENV is unset. Next.js still DCE-strips this
      // branch in client production bundles because the substitution happens
      // before the typeof check is evaluated.
      if (sm.skeleton.update !== THREE.Skeleton.prototype.update &&
          typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        console.warn(
          '[VRMCharacterAnimator] skeleton.update already patched — double-patch risk;' +
          ' ensure the previous animator was disposed before constructing a new one.'
        );
      }
      const originalUpdate = sm.skeleton.update.bind(sm.skeleton);
      this._skeletonUpdateFns.set(sm.skeleton, originalUpdate);
      sm.skeleton.update = () => {}; // renderer skips; we call manually below
    });
  }

  /**
   * Async initialisation — retargets the 3 locomotion clips (idle/walk/run) for
   * this VRM, plus the requested startClip if it is an emote (not already in the
   * locomotion set). The emote clips are loaded lazily on first request — only the
   * startClip is pre-loaded here so there is no cold-start T-pose delay.
   *
   * @param startClip  Which animation to play immediately after init.
   *   Defaults to 'idle'. Pass any AnimName to override (e.g. 'looking_around').
   *   Player-avatar.tsx callers pass no argument and continue to start on 'idle'.
   */
  async init(startClip: AnimName = 'idle'): Promise<void> {
    // Always load the 3 locomotion clips. Also pre-load the startClip if it is
    // an emote (not already in the locomotion set) so it is ready before first tick.
    const locomotion: AnimName[] = ['idle', 'walk', 'run'];
    const toLoad: AnimName[] = locomotion.includes(startClip)
      ? locomotion
      : [...locomotion, startClip];

    try {
      const rawGltfs = await Promise.all(toLoad.map((n) => loadRawGltf(n, this.characterId)));

      // Bail if dispose() ran while we were awaiting clip loads. this.vrm /
      // this.mixer are now null and the retarget + clipAction calls below would
      // throw, leaving ready=false (avatar permanently T-poses).
      if (this.disposed) return;

      for (let i = 0; i < toLoad.length; i++) {
        const name = toLoad[i]!;
        const gltf = rawGltfs[i]!;

        let retargeted: THREE.AnimationClip;
        try {
          retargeted = retargetAnimationClip(gltf, this.vrm, name);
          if (shouldStripPosition(name, this.characterId)) stripPositionTracks(retargeted);
        } catch (err) {
          console.warn(`[VRMCharacterAnimator] retarget failed for clip "${name}":`, err);
          continue;
        }

        const action = this.mixer.clipAction(retargeted);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
        this.actions[name] = action;
      }

      // Start on startClip; fall back to idle if it failed to retarget
      const startAction = this.actions[startClip] ?? this.actions.idle;
      if (startAction) {
        startAction.play();
        this.currentAction = startAction;
      }

      this.ready = true;

      // Debug instrumentation — preserved for CDP diagnostics
      if (typeof window !== 'undefined') {
        const w = window as any;
        w.__VRM_INIT_COUNT = (w.__VRM_INIT_COUNT || 0) + 1;
        w.__VRM_INIT_LOG   = w.__VRM_INIT_LOG || [];

        const leftArm = this.vrm.humanoid.getNormalizedBoneNode('leftUpperArm' as any);

        const mixerAny   = this.mixer as any;
        const bindings   = (mixerAny._bindings || []) as any[];
        const withNode   = bindings.filter((b: any) => b?.binding?.node != null).length;
        // mixerRoot is vrm.scene — name/type varies by VRM, use uuid as stable id
        const mixerRootName = (mixerAny._root?.name || mixerAny._root?.type || 'vrm.scene') as string;
        // hasNormalizedRig: still true — we just no longer use it as the mixer root
        const hasNormalizedRig = !!(this.vrm.humanoid as any)?.normalizedHumanBonesRoot;

        const idleAction = this.actions.idle;
        w.__VRM_INIT_LOG.push({
          n:             w.__VRM_INIT_COUNT,
          startClip,
          idleAction:    !!idleAction,
          idleClip:      idleAction ? idleAction.getClip().name : null,
          leftArmNode:   leftArm ? leftArm.name : null,
          mixerRoot:     mixerRootName,
          hasNormalizedRig,
          mixerRootIsScene: true,
          bindings:      bindings.length,
          boundToReal:   withNode,
          trackNames:    idleAction ? idleAction.getClip().tracks.slice(0, 3).map((t) => t.name) : [],
        });
        // Audit fix (S8) — bound this CDP debug log; it grew unbounded with VRM
        // init churn over a long session (a minor heap-growth/freeze vector).
        if (w.__VRM_INIT_LOG.length > 300) w.__VRM_INIT_LOG.shift();
      }
    } catch (err) {
      console.warn('[VRMCharacterAnimator] init failed:', err);
      if (typeof window !== 'undefined') {
        const w = window as any;
        w.__VRM_INIT_ERRORS = w.__VRM_INIT_ERRORS || [];
        w.__VRM_INIT_ERRORS.push(String(err));
        if (w.__VRM_INIT_ERRORS.length > 100) w.__VRM_INIT_ERRORS.shift();
      }
      // ready stays false — update() will be a no-op
    }
  }

  /**
   * Main update — call every frame inside useFrame.
   *
   * Order MATTERS:
   *   1. mixer.update()        — advances Normalized_* keyframe actions
   *   2. vrm.update()          — copies Normalized → raw bones, runs spring
   *                              physics. THIS is what gives raw bones (the
   *                              ones SkinnedMesh skeletons reference, AND
   *                              the ones cosmetic-loader parents children
   *                              to) their current-frame local poses.
   *   3. vrm.scene.updateMatrixWorld(true)
   *                            — recompute every bone's matrixWorld from
   *                              the new local transforms. Without this the
   *                              flush below reads STALE last-frame matrices.
   *   4. Flush batched skeleton.update() once per unique skeleton (Verse
   *      Engine pattern). With current matrixWorld, boneMatrices buffer is
   *      consistent with bone children rendered later in the frame.
   *
   * Bug history (2026-04-30): the order was previously
   *   mixer.update → flush → vrm.update
   * which left raw bones one frame behind on every walking step. Body
   * SkinnedMeshes drew with last-frame pose, but cosmetic hats / glasses
   * (children of `mixamorigHead`) followed the renderer's automatic
   * matrixWorld update so they sat at the new pose. Net effect: hat
   * appeared to "jump around" the head every step. Reordering aligns
   * body and accessories on the same frame.
   *
   * @param delta    Clamped frame delta (Math.min(rawDelta, 0.1))
   * @param isMoving true when the avatar is walking/running
   */
  update(delta: number, isMoving: boolean, isRunning = false): void {
    if (!this.ready) return;

    // While a one-shot emote is playing, suppress the locomotion crossfade
    // but keep `wasMoving` updated so we crossfade to the correct target
    // when the emote finishes. Otherwise: apply locomotion crossfade as normal.
    const motion: 'idle' | 'walk' | 'run' = !isMoving
      ? 'idle'
      : isRunning ? 'run' : 'walk';
    if (this.oneShotActive) {
      this.wasMoving = isMoving;
      this.wasMotion = motion;
    } else if (motion !== this.wasMotion) {
      this.applyCrossfade(motion);
      this.wasMoving = isMoving;
      this.wasMotion = motion;
    }

    // Instrumentation: single boolean check when disabled; performance.now()
    // pair only when VRM_METRICS_ENABLED. No objects allocated in either path.
    if (VRM_METRICS_ENABLED) {
      const t0 = performance.now();
      this.mixer.update(delta);
      this.vrm.update(delta);
      this.vrm.scene.updateMatrixWorld(true);
      for (const fn of this._skeletonUpdateFns.values()) fn();
      _fmFullTotalMs += performance.now() - t0;
      _fmFullCalls++;
    } else {
      this.mixer.update(delta);
      this.vrm.update(delta);
      this.vrm.scene.updateMatrixWorld(true);
      for (const fn of this._skeletonUpdateFns.values()) fn();
    }
  }

  /**
   * Override the resting locomotion target when isMoving=false.
   * Call after init() resolves with the desired persistent clip.
   * In Reef Race: call with 'surf_idle' so post-one-shot crossfades return
   * to the surfboard stance instead of the world-walk idle pose.
   * Defaults to 'idle' — existing callers (player-avatar.tsx, arena-npcs.tsx)
   * never call this so their behaviour is unchanged.
   */
  setSurfaceClip(name: AnimName): void {
    const prev = this.surfaceClip;
    this.surfaceClip = name;
    if (prev === name || !this.ready) return;

    // Lazy-load + retarget non-locomotion surface clips (swimming, flying,
    // etc.) the first time they're requested. init() only preloads
    // idle/walk/run, so without this branch the crossfade silently no-ops.
    if (!this.actions[name]) {
      void loadRawGltf(name, this.characterId)
        .then((gltf) => {
          if (this.disposed) return; // disposed mid-load — vrm/mixer nulled
          const retargeted = retargetAnimationClip(gltf, this.vrm, name);
          if (shouldStripPosition(name, this.characterId)) stripPositionTracks(retargeted);
          const action = this.mixer.clipAction(retargeted);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.clampWhenFinished = false;
          this.actions[name] = action;
          // Only crossfade if user is still asking for this surface clip
          // and not actively moving / mid-emote.
          if (this.surfaceClip === name && !this.oneShotActive && !this.wasMoving) {
            this.applyCrossfade('idle');
          }
        })
        .catch((err) => {
          console.warn(`[VRMCharacterAnimator] setSurfaceClip lazy-load failed for "${name}":`, err);
        });
      return;
    }

    if (!this.oneShotActive && !this.wasMoving) {
      this.applyCrossfade('idle');
    }
  }

  /**
   * Returns the minimum world-space Y among the four foot/toe bones after
   * the current frame's pose has been applied (call AFTER animator.update()
   * AND group.updateMatrixWorld(true) so the bones' world matrices reflect
   * the current group position).
   *
   * Used by the procedural squat-crouch to measure how far the rotation-only
   * squat pose lifts the feet, then replant them at effectiveFloorY.
   *
   * The squat clip's hips.position Y is CONSTANT (headless harness confirmed:
   * raw track Y=104.226...104.226, 2 keyframes, zero descent). All squat
   * motion is rotation-only, which lifts the feet ~2.3 wu above the floor.
   * Foot replanting is the secondary correction (after the primary procedural
   * group lowering); it clamps the net result so feet never sink below terrain.
   *
   * Uses the module-scope _squat_footScratch Vector3 — no per-frame allocation.
   *
   * @returns World-Y of the lowest foot/toe bone, or Infinity if no bones found.
   */
  getFootWorldYMin(): number {
    const humanoid = this.vrm.humanoid;
    if (!humanoid) return Infinity;
    let minY = Infinity;
    const bones = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'] as const;
    for (const boneName of bones) {
      // VRMHumanBoneName is the string union; cast is correct since all four
      // bone names are valid members of the union.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = humanoid.getNormalizedBoneNode(boneName as any);
      if (node) {
        node.getWorldPosition(_squat_footScratch);
        if (_squat_footScratch.y < minY) minY = _squat_footScratch.y;
      }
    }
    return minY;
  }

  /**
   * Manually flush the batched skeleton.update() calls this animator patched
   * to no-ops in its constructor (see the Verse Engine batching comment
   * above `_skeletonUpdateFns`). `update()` already calls this internally
   * once per frame, AFTER the mixer + vrm.update() write the current clip
   * pose — so it is normally sufficient on its own.
   *
   * Exposed publicly for a caller that applies an ADDITIONAL bone override
   * AFTER update() returns, in the SAME frame (e.g. cove-interior.tsx's
   * seated-bust leg pose — a static per-frame override layered on top of
   * the idle clip's upper-body life, applied every frame rather than a
   * one-time freeze-bake). Without a second flush, `SkinnedMesh.skeleton.
   * update` stays a no-op (patched in the constructor), so the override's
   * new bone.matrixWorld values never reach the boneMatrices uniform the
   * GPU actually skins from — the change would compute correctly but
   * render completely invisibly. Caller must call `vrm.humanoid.update()`
   * (propagate normalized→raw) and `vrm.scene.updateMatrixWorld(true)`
   * (recompute world matrices) BEFORE calling this. (2026-07-11, Slice 2.)
   */
  flushSkeletonUpdates(): void {
    for (const fn of this._skeletonUpdateFns.values()) fn();
  }

  /**
   * Transition to the action matching `isMoving`.
   *
   * three.js's `crossFadeTo` schedules weight changes but does NOT call `.play()`
   * on the incoming action — it assumes both actions are already running. At
   * init() only `idle.play()` is called; `walk` and `run` are constructed
   * stopped. Without an explicit `.play()` on the incoming action here, the
   * first idle→walk transition silently fails: the mixer ticks, weights fade,
   * but the walk action's `isRunning` stays false so its tracks never write
   * to the bone nodes. Symptom observed 2026-04-23: VRM NPCs that the server
   * marked as walking held identity quaternions on Normalized_mixamorigHips
   * forever — bones appeared frozen, NPC locomotion looked broken.
   *
   * Fix: `next.reset()` clears time/weight/timeScale/enabled/paused back to
   * defaults (also undoing any `warp` timeScale residual from prior crossfades),
   * then `next.fadeIn(duration)` schedules the weight ramp, then `next.play()`
   * actually starts the action ticking. The outgoing action gets a matching
   * `fadeOut` so both weights cross at 50%. `warp=true` on the old crossFadeTo
   * was dropped because the Mixamo clip durations (walk=1.03s, idle=12.04s)
   * produced a warp ratio of ~11.65× that persisted on the idle action after
   * every transition, accumulating drift across repeated idle↔walk toggles.
   */
  private applyCrossfade(motion: 'idle' | 'walk' | 'run'): void {
    const clipName: AnimName = motion === 'idle' ? this.surfaceClip : motion;
    // Run clip falls back to walk if the character doesn't have a baked
    // run override AND the generic run.glb hasn't been loaded yet — happens
    // briefly during init(). Walking is a strictly better visual than
    // T-posing or losing the locomotion entirely in that window.
    const next = this.actions[clipName] ?? (motion === 'run' ? this.actions.walk : undefined);
    if (!next || next === this.currentAction) return;
    next.reset().fadeIn(CROSSFADE_DURATION).play();
    // NOTE (2026-06-10, corrected later same day): a crossfade-internal
    // velocity timeScale briefly lived HERE and was removed — scaling at the
    // crossfade site pops. The CORRECT mechanism (original fix 9e3bc63a,
    // restored 2026-06-10) is the `walkTimeScale` param on updateMixerOnly():
    // callers pass a low-pass-smoothed speed ratio so the walk action alone
    // tracks rendered ground speed; idle/run/one-shots keep real time.
    if (this.currentAction) {
      this.currentAction.fadeOut(CROSSFADE_DURATION);
    }
    this.currentAction = next;
  }

  /**
   * PERF split: advance the AnimationMixer only (no spring-bone physics).
   * Use this at 60Hz to keep keyframe animations smooth.
   * Must be paired with updateSpringOnly() called at a lower rate.
   *
   * Also handles isMoving crossfade — crossfade state must be in sync with
   * the mixer, so we handle it here rather than in updateSpringOnly.
   *
   * @param delta    Clamped frame delta
   * @param isMoving true when walking/running
   * @param walkTimeScale speed-matched timeScale for the walk action only
   */
  updateMixerOnly(delta: number, isMoving: boolean, isRunning = false, walkTimeScale = 1): void {
    if (!this.ready) return;

    // Same one-shot guard as update() — see that method for rationale.
    const motion: 'idle' | 'walk' | 'run' = !isMoving
      ? 'idle'
      : isRunning ? 'run' : 'walk';
    const walkAction = this.actions.walk;
    if (walkAction) {
      walkAction.timeScale = walkTimeScale;
    }
    if (this.oneShotActive) {
      this.wasMoving = isMoving;
      this.wasMotion = motion;
    } else if (motion !== this.wasMotion) {
      this.applyCrossfade(motion);
      this.wasMoving = isMoving;
      this.wasMotion = motion;
    }

    // Instrumentation: single boolean check when disabled; performance.now()
    // pair only when VRM_METRICS_ENABLED. _fmEpoch is the frame-epoch counter
    // for correlating mixer and spring samples.
    if (VRM_METRICS_ENABLED) {
      const t0 = performance.now();
      this.mixer.update(delta);
      // 2026-05-18 — body-tracks-group fix (see full comment in the
      // non-instrumented path below).
      this.vrm.humanoid?.update();
      this.vrm.scene.updateMatrixWorld(true);
      for (const fn of this._skeletonUpdateFns.values()) fn();
      _fmMixerTotalMs += performance.now() - t0;
      _fmMixerCalls++;
      _fmEpoch++;
    } else {
      this.mixer.update(delta);

      // 2026-05-18 — body-tracks-group fix.
      //
      // Historically this method skipped vrm.update() + scene.updateMatrixWorld
      // + skeleton flush entirely; updateSpringOnly handled all of them at
      // 15 Hz. That was correct when the only source of bone movement was
      // animation pose (which the spring-bone throttle is what we're saving
      // cycles on). But it ALSO meant the SkinnedMesh's boneMatrices uniform
      // only refreshed every 4th frame — so when arena-npcs.tsx moves
      // group.position every frame via the entity-interpolation smoother,
      // the body drew at 15 Hz while the group moved at 60 Hz. Visible
      // stutter ("body chunks forward every 4 frames"), reported by the
      // user 2026-05-18 with the diagnostic clue that GLB crustaceans
      // (no animator override of skeleton.update) moved smoothly while
      // VRMs stuttered.
      //
      // Fix: split vrm.update into its CHEAP parts (humanoid norm→raw copy,
      // ~1µs per VRM) which run every frame, and the EXPENSIVE part
      // (spring-bone physics) which stays on the 15 Hz schedule in
      // updateSpringOnly. scene.updateMatrixWorld + skeleton.update also
      // run every frame here — both cheap (a few µs per VRM) and required
      // for the boneMatrices upload to reflect the new group.position.
      //
      // Tradeoff: spring bones lag one frame behind animation pose (since
      // skeleton flush in MixerOnly captures bones BEFORE the next
      // updateSpringOnly mutates them). Imperceptible on hair/skirt at
      // typical viewing distance.
      this.vrm.humanoid?.update();
      this.vrm.scene.updateMatrixWorld(true);
      for (const fn of this._skeletonUpdateFns.values()) fn();
    }
  }

  /**
   * PERF split: run ONLY the spring-bone physics (the one expensive part of
   * vrm.update()). humanoid/lookAt/expressions are NOT run here — humanoid runs
   * every frame in updateMixerOnly; lookAt/expressionManager are never ticked
   * for NPCs (only humanoid + spring run), so they hold their load-time pose.
   * (Docstring corrected 2026-06-03; the body has only called
   * springBoneManager.update() since the 2026-05-18 split.)
   * Call this at a lower rate (15Hz / every Nth frame) for idle NPCs to cut
   * the spring-bone physics cost without visible visual degradation.
   *
   * The spring-bone verlet integrator is time-step independent (uses delta internally),
   * so passing an accumulated delta (e.g. 2 × frame_dt) produces physically correct
   * output — spring displacement is proportional to elapsed time regardless of call rate.
   *
   * @param accumulatedDelta  Sum of all deltas since last spring update. On a 30Hz
   *   schedule this is approximately 2 × (1/60) ≈ 0.033s. Pass clamped to 0.1s max.
   */
  updateSpringOnly(accumulatedDelta: number): void {
    if (!this.ready) return;
    // 2026-05-18 — narrowed from full vrm.update() to just spring physics.
    // humanoid + scene.updateMatrixWorld + skeleton.update now run every
    // frame in updateMixerOnly (see that method's comment block for the
    // body-tracks-group stutter fix). Spring-bone physics is the only
    // expensive part of vrm.update(), so it stays on the 15 Hz schedule.
    //
    // Calling springBoneManager.update directly bypasses the wrapper but
    // matches the public API @pixiv/three-vrm exposes (3.5.x). If a
    // future VRM version moves the manager, fall back to vrm.update().
    // Instrumentation: single boolean check when disabled.
    if (VRM_METRICS_ENABLED) {
      const t0 = performance.now();
      this.vrm.springBoneManager?.update(accumulatedDelta);
      // 2026-06-03 PERF — see full comment in the non-instrumented path below.
      for (const fn of this._skeletonUpdateFns.values()) fn();
      _fmSpringTotalMs += performance.now() - t0;
      _fmSpringCalls++;
    } else {
      this.vrm.springBoneManager?.update(accumulatedDelta);

      // 2026-06-03 PERF — removed the redundant full-scene
      // `this.vrm.scene.updateMatrixWorld(true)` that previously ran here.
      //
      // WHY IT'S SAFE (verified against @pixiv/three-vrm 3.5.2 source —
      // @pixiv/three-vrm-springbone three-vrm-springbone.module.js):
      // VRMSpringBoneManager.update() flushes its OWN joints' world matrices.
      // For every sorted joint it calls bone.updateMatrix() +
      // bone.matrixWorld.multiplyMatrices(parentMatrixWorld, bone.matrix)
      // (VRMSpringBoneJoint.update), then traverses each joint's descendants
      // calling child.updateWorldMatrix() (VRMSpringBoneManager's
      // _relevantChildrenUpdated). So after this call EVERY bone whose
      // local transform the spring tick mutated already has a correct
      // matrixWorld — the only bones that changed since updateMixerOnly's
      // full recompute this frame.
      //
      // updateSpringOnly is ALWAYS called in a frame where updateMixerOnly
      // already ran (the sole call sites — arena-npcs.tsx VRMNpcMesh — gate
      // both on `!isFarNpc`, and spring runs on a `% springMod` SUBSET of
      // mixer frames). updateMixerOnly already did vrm.scene.updateMatrixWorld(
      // true) THIS frame for every non-spring bone, so re-running a full
      // subtree recompose here only duplicated the spring-joint flush the
      // manager already performed — pure waste across ~13 VRMs/frame.
      //
      // The skeleton flush below only READS bone.matrixWorld (Skeleton.update
      // builds boneMatrices = matrixWorld * boneInverse), so the
      // manager-written matrices upload correctly without a second recompute.
      for (const fn of this._skeletonUpdateFns.values()) fn();
    }
  }

  /**
   * Play a one-shot emote (LoopOnce). Lazy-loads + retargets the clip on
   * first request so the player only pays for emotes they trigger.
   *
   * Behavior:
   *   1. If clip not loaded yet → fetch + retarget (one-time per emote per
   *      VRM instance). Subsequent calls reuse the cached action.
   *   2. Crossfade from the current action into the emote (CROSSFADE_DURATION).
   *   3. Suppress locomotion crossfade for the duration of the emote.
   *   4. On 'finished' (Mixer event) crossfade into `nextLoopingClip` when
   *      provided, otherwise return to idle/walk based on the latest
   *      `isMoving` state we observed.
   *
   * Calling playOneShot while another one-shot is already running cancels
   * the previous one's finished handler and starts the new emote — a
   * "stomp" pattern that matches Fortnite-style emote spam.
   *
   * @param name Animation registry key (e.g. 'flip', 'dance_breaking').
   * @param nextLoopingClip Optional explicit looping clip to hold after the
   * one-shot finishes. Omit to preserve the locomotion/surface return path.
   * @param timeScale Playback speed for this one-shot. Defaults to 1.
   */
  async playOneShot(
    name: AnimName,
    nextLoopingClip?: AnimName,
    timeScale = 1,
  ): Promise<void> {
    if (!this.ready) return;
    if (!this.mixer) return; // disposed
    const requestToken = ++this.oneShotRequestToken;

    // A single AnimationAction cannot be faded in as a loop and faded out as
    // the outgoing one-shot in the same completion callback.
    if (nextLoopingClip === name) {
      console.warn(
        `[VRMCharacterAnimator] one-shot "${name}" cannot transition to itself`,
      );
      return;
    }

    // Lazy-load + retarget if first time.
    if (!this.actions[name]) {
      try {
        const gltf = await loadRawGltf(name, this.characterId);
        if (this.disposed || requestToken !== this.oneShotRequestToken) return;
        const retargeted = retargetAnimationClip(gltf, this.vrm, name);
        if (shouldStripPosition(name, this.characterId)) stripPositionTracks(retargeted);
        const action = this.mixer.clipAction(retargeted);
        this.actions[name] = action;
      } catch (err) {
        console.warn(`[VRMCharacterAnimator] one-shot retarget failed for "${name}":`, err);
        return;
      }
    }
    // Re-check post-await — we may have been disposed mid-load.
    if (this.disposed || requestToken !== this.oneShotRequestToken) return;

    // An explicit post-transition loop must be ready before the one-shot
    // starts; otherwise a cold network fetch could outlast the transition and
    // leave the avatar clamped on its final frame. Existing callers omit this
    // parameter and retain the original lazy-load/locomotion behavior.
    if (nextLoopingClip && !this.actions[nextLoopingClip]) {
      try {
        const gltf = await loadRawGltf(nextLoopingClip, this.characterId);
        if (this.disposed || requestToken !== this.oneShotRequestToken) return;
        const retargeted = retargetAnimationClip(gltf, this.vrm, nextLoopingClip);
        if (shouldStripPosition(nextLoopingClip, this.characterId)) stripPositionTracks(retargeted);
        const action = this.mixer.clipAction(retargeted);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
        this.actions[nextLoopingClip] = action;
      } catch (err) {
        console.warn(
          `[VRMCharacterAnimator] next-loop retarget failed for "${nextLoopingClip}":`,
          err,
        );
        return;
      }
    }
    // Re-check post-await — we may have been disposed mid-load.
    if (this.disposed || requestToken !== this.oneShotRequestToken) return;

    const oneShot = this.actions[name];
    if (!oneShot) return;

    oneShot.setLoop(THREE.LoopOnce, 1);
    oneShot.clampWhenFinished = true;

    // If a previous one-shot is mid-flight, drop its handler so it doesn't
    // fire after we've already moved on.
    if (this.oneShotFinishedHandler) {
      this.mixer.removeEventListener('finished', this.oneShotFinishedHandler as any);
      this.oneShotFinishedHandler = null;
    }

    const previous = this.currentAction;

    const onFinished = (e: { action: THREE.AnimationAction }) => {
      if (e.action !== oneShot) return;
      if (this.disposed) return; // disposed mid-emote — vrm/mixer nulled
      this.mixer.removeEventListener('finished', onFinished as any);
      this.oneShotFinishedHandler = null;
      this.oneShotActive = false;
      // An explicit transition target wins over locomotion. Without one,
      // crossfade back to whatever locomotion state we are in NOW — including
      // run when the player is sprinting through the emote. In surf context
      // (surfaceClip='surf_idle') this resolves to surf_idle; world context
      // (default surfaceClip='idle') returns to idle.
      const backName: AnimName =
        nextLoopingClip ?? (
        this.wasMotion === 'run' ? 'run'
        : this.wasMotion === 'walk' ? 'walk'
        : this.surfaceClip);
      const back =
        this.actions[backName] ??
        // Fallback: the run clip may not be retargeted on this VRM yet
        // (init only force-loads idle/walk/run, but the per-character
        // override may be in flight). Walk → idle/surfaceClip in order.
        (backName === 'run' ? this.actions.walk : undefined) ??
        this.actions[this.surfaceClip];
      if (back) {
        if (nextLoopingClip) {
          back.setLoop(THREE.LoopRepeat, Infinity);
          back.clampWhenFinished = false;
        }
        back.reset().fadeIn(CROSSFADE_DURATION).play();
        oneShot.fadeOut(CROSSFADE_DURATION);
        this.currentAction = back;
      }
    };
    this.oneShotFinishedHandler = onFinished;
    this.mixer.addEventListener('finished', onFinished as any);

    this.oneShotActive = true;
    oneShot.reset().setEffectiveTimeScale(timeScale).fadeIn(CROSSFADE_DURATION).play();
    if (previous && previous !== oneShot) {
      previous.fadeOut(CROSSFADE_DURATION);
    }
    this.currentAction = oneShot;
  }

  /**
   * Clean up — call on component unmount to release GPU resources.
   * The VRM scene itself is not disposed here — caller manages scene lifetime.
   */
  dispose(): void {
    // Idempotent guard — a caller that both awaits init().then(dispose()) AND
    // disposes again on unmount (e.g. cove-interior.tsx TableSeatedBustInner)
    // would otherwise null-deref `this.mixer` on the second call. Surfaced as
    // repeated "Cannot read properties of null (reading 'stopAllAction')"
    // pageerrors during the Slice 1 cove3d-holdem probe (2026-07-10).
    if (this.disposed) return;
    // Mark disposed FIRST so any in-flight init() awaiting clip loads bails
    // before touching the about-to-be-nulled vrm/mixer refs.
    this.disposed = true;
    // Also clear `ready` so update/updateMixerOnly/updateSpringOnly (all of
    // which short-circuit on `!this.ready`) become safe no-ops if a stale
    // useFrame closure on the parent component fires after dispose — defense
    // in depth against the same crash class init() was hitting.
    this.ready = false;
    if (this.oneShotFinishedHandler) {
      this.mixer.removeEventListener('finished', this.oneShotFinishedHandler as any);
      this.oneShotFinishedHandler = null;
    }
    this.oneShotActive = false;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.vrm.scene);

    // Restore skeleton.update on all skeletons that were patched in the constructor.
    // Uses the Map<Skeleton, originalFn> directly — no second scene traversal, no
    // index alignment, safe regardless of any scene graph mutations since construction.
    // (Sakura review finding #1)
    this._skeletonUpdateFns.forEach((fn, skel) => {
      skel.update = fn;
    });
    this._skeletonUpdateFns.clear();

    // Reset surfaceClip before null-casting refs so a dangling closure
    // referencing the animator post-dispose gets 'idle' (the safe no-op
    // locomotion target) rather than a stale AnimName that no longer has
    // an action in this.actions. Must precede the actions={} wipe.
    this.surfaceClip = 'idle';

    // Drop strong refs so a long-lived closure or ref holding the animator
    // doesn't keep the VRM scene, mixer, clips, or actions alive after disposal.
    // The instance is dead post-dispose — if anything touches it after this
    // point it will throw immediately (null dereference) rather than silently
    // leaking GPU/CPU resources. (Sakura review follow-up suggestion B)
    this.actions = {};
    this.currentAction = null;
    this.mixer = null as any;
    this.vrm = null as any;

    // VRMUtils.deepDispose on the VRM scene is the caller's responsibility
    // (matches the pattern used in player-avatar.tsx for GLB material disposal)
  }
}
