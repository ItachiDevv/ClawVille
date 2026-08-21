'use client';

/**
 * TownGuide — town-center anchor NPC, Mixamo-rigged with a timer-driven pose cycle.
 *
 * Asset pipeline:
 *   - Character: /models/guide-rigged.glb (Sketchfab anime girl → Blender edits → Mixamo auto-rig
 *     → animation FBXs imported as actions → pushed to NLA tracks → exported as single glb
 *     with all animations baked in as named clips)
 *
 * Animation system:
 *   - AnimationMixer on the cloned skeleton root.
 *   - Every cycle clip plays LoopRepeat from init with weight=0. One action's weight is
 *     raised to 1 as the "current" pose. A time-based timer crossfades current → next every
 *     SLOT_DURATION_SEC. Because every action is always ticking, 1-frame POSE clips render
 *     their single keyframe at any sample time and multi-frame clips (bellydancing, samba)
 *     animate naturally. No LoopOnce 'finished' events involved — that was the 8281162
 *     regression path that produced T-pose interpolation during crossfade.
 *   - Procedural breathing: useFrame drives mixamorigSpine2 scale.y = 1 + sin(t*1.8)*0.008.
 *     Additive over the mixer — mixer doesn't touch scale, only rotation/position tracks.
 *   - Wave on click: suspend the cycle, crossfade current cycle action → wave (LoopOnce),
 *     on wave 'finished' crossfade back into the cycle at the next slot.
 *
 * Available clips:
 *   - pose-hand-on-hips   ← in cycle (1-frame POSE)
 *   - pose-catwalk-idle   ← in cycle (1-frame POSE)
 *   - pose-dance          ← in cycle (1-frame POSE)
 *   - pose-laying         ← EXCLUDED (looks broken at standing height)
 *   - pose-standing-2     ← in cycle (1-frame POSE)
 *   - pose-standing-3     ← in cycle (1-frame POSE)
 *   - pose-standing-4     ← in cycle (1-frame POSE)
 *   - praying (58 frames) ← in cycle
 *   - bellydancing (762 frames) ← in cycle
 *   - samba (595 frames)        ← in cycle
 *   - wave (45 frames)    ← greeting ONLY, never in cycle
 *
 * GPU constraints (Iris Xe invariants):
 *   - NO drei Text/Billboard — hard crash
 *   - NO InstancedMesh + ShaderMaterial — silent WebGPU crash
 *   - applyFattenedFrustumCulling() on every mesh after SkeletonUtils.clone (Win G, 2026-05-22)
 *   - No per-frame allocations — mixer/action refs at component scope
 */

import { useRef, useMemo, useEffect, memo } from 'react';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useGameStore } from '@/stores/game';
import { applyFattenedFrustumCulling } from '@/lib/three/vrm-loader';
import { bootStreamPriority } from '@/lib/three/use-boot-stream-release';
import { BootStreamedContent } from '@/lib/three/boot-streamed-content';
import {
  BOOT_STREAM_TIER_GUIDE,
  onBootBuildingsFetch,
} from '@/lib/three/decorative-release';
import { preloadKTX2Bytes } from '@/lib/three/use-gltf-ktx2';

// Rung-4 slice D (§3 preload demotion [R2-F6]): the module-scope
// `useGLTF.preload('/models/guide-rigged.glb')` is REMOVED — it started a
// fetch AND parse on the boot critical path regardless of component gating.
// BGR guide amendment (founder 2026-08-20 — "Nori in the first loading
// batch"): her BYTES warm on the stage-A byte-fetch lane behind the loading
// overlay (network only — parse/warm still waits for her staggered
// stage-B mount, FIRST in line via BOOT_STREAM_TIER_GUIDE).
if (typeof window !== 'undefined') {
  // Priority -1: Nori's bytes are admitted FIRST in the stage-A batch
  // ("really the first thing that loads") — the buildings follow at 0.
  onBootBuildingsFetch(() => {
    void preloadKTX2Bytes('/models/guide-rigged.glb');
  }, -1);
}

const GROUND_Y    = -2;
// 2026-05-21 — moved Nori south by 160 wu (240→400) to give the bigger
// town-directory sign more breathing room from her.
const GUIDE_Z     = 400;
const GUIDE_SCALE = 200;

// Exported so player-avatar / npc-controller can run the same proximity
// check building characters get against the CHARACTER_POSITIONS map.
// X is 0 (town center on X-axis); Z matches the placement above.
export const NORI_WORLD_X = 0;
export const NORI_WORLD_Z = GUIDE_Z;
// Squared talk-radius — 320 wu gives Nori a slightly larger pull-in
// circle than the 260 wu building characters use, since she stands in
// the open town center where proximity is the only chat affordance.
export const NORI_TALK_RADIUS_SQ = 320 * 320;

const CLIP_WAVE = 'wave';

// Ordered playlist. pose-laying excluded (looks broken at standing height —
// horizontal-floating character without floor context).
const CYCLE_CLIPS = [
  'pose-hand-on-hips',
  'pose-catwalk-idle',
  'pose-dance',
  'pose-standing-2',
  'pose-standing-3',
  'pose-standing-4',
  'praying',
  'bellydancing',
  'samba',
] as const;

// How long to hold each slot before crossfading to the next.
// Long clips (bellydancing 762fr @30fps ≈ 25s, samba 595fr @30fps ≈ 20s) are truncated
// to SLOT_DURATION_SEC so the cycle keeps moving — visitors see variety every few
// seconds rather than a 25-second dance solo.
const SLOT_DURATION_SEC = 5;
const CYCLE_FADE  = 0.5;   // crossfade between cycle slots (sec)
const WAVE_FADE   = 0.35;  // crossfade into/out of wave (sec)
const BREATH_FREQ = 1.8;
const BREATH_AMP  = 0.008;

const TownGuideInner = memo(function TownGuideInner() {
  const { scene: gltfScene, animations } = useGLTF('/models/guide-rigged.glb');

  // Clone per-mount so each instance gets its own bone tree.
  // SkeletonUtils.clone rebinds SkinnedMesh.skeleton correctly — plain clone(true) shares bones.
  const cloned = useMemo(() => {
    const c = skeletonClone(gltfScene) as THREE.Group;
    // Fatten SkinnedMesh bounding spheres + re-enable frustumCulled (Win G fix,
    // 2026-05-22 perf wave 3). Bind-pose sphere is too tight for animated poses;
    // applyFattenedFrustumCulling fattens each SkinnedMesh sphere by 1.6× and
    // enables culling so off-screen guide renders are correctly skipped.
    applyFattenedFrustumCulling(c);
    return c;
  }, [gltfScene]);

  const mixer = useMemo(() => new THREE.AnimationMixer(cloned), [cloned]);

  const cycleActionsRef = useRef<THREE.AnimationAction[]>([]);
  const cycleIndexRef   = useRef<number>(0);
  const slotAdvanceAtRef = useRef<number>(0);  // clock time when next advance happens
  const waveActionRef   = useRef<THREE.AnimationAction | null>(null);
  const wavingRef       = useRef<boolean>(false);
  const spineBoneRef    = useRef<THREE.Bone | null>(null);

  useEffect(() => {
    // Build all cycle actions: LoopRepeat, weight=1 (default), enabled=false.
    //
    // three.js gotcha — fadeIn/fadeOut multiply the action's `weight` property
    // by an interpolant ramping 0→1 (or 1→0). If we set `weight = 0` up front
    // and then call `fadeIn()`, effective weight = 0 × (0→1) = 0 forever. The
    // previous revision of this code hit exactly that trap and produced a
    // deceptively-instrumented scene: all 9 actions "running" with mixer ticking
    // time normally, zero bone output. Keep `weight = 1` and use `enabled` as
    // the on/off switch for each slot.
    //
    // Non-active actions: enabled=false prevents `_update` from advancing time
    // AND from writing tracks. When a slot becomes current via `reset()`, reset
    // re-enables the action and zeros its time (so multi-frame clips like
    // bellydancing restart from frame 0). Fade in schedules effective weight
    // 0→1 via interpolant, which multiplies by weight=1 to give the full 0→1.
    const actions: THREE.AnimationAction[] = [];
    for (const name of CYCLE_CLIPS) {
      const clip = animations.find((c) => c.name === name);
      if (!clip) {
        console.error(`[TownGuide] Cycle clip "${name}" not found in GLB`);
        continue;
      }
      const action = mixer.clipAction(clip, cloned);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      action.timeScale = 1;
      action.enabled = false;   // gated off initially
      action.play();            // register with mixer; enabled=false keeps it silent
      actions.push(action);
    }
    // Slot 0 starts active.
    if (actions[0]) {
      actions[0].enabled = true;
    }
    cycleActionsRef.current = actions;
    cycleIndexRef.current   = 0;
    slotAdvanceAtRef.current = SLOT_DURATION_SEC;
    if (typeof window !== 'undefined') {
      (window as any).__NORI_DEBUG = {
        mixer,
        actions,
        cycleIndexRef,
        slotAdvanceAtRef,
        wavingRef,
      };
    }

    const waveClip = animations.find((c) => c.name === CLIP_WAVE);
    if (waveClip) {
      const waveAction = mixer.clipAction(waveClip, cloned);
      waveAction.setLoop(THREE.LoopOnce, 1);
      // clampWhenFinished=false: on completion resets to frame 0 rather than
      // holding the raised-hand pose. During the crossfade-out the first-frame
      // (neutral) pose fades out, producing a clean transition back to idle.
      waveAction.clampWhenFinished = false;
      waveAction.weight  = 0;
      waveAction.enabled = true;
      waveActionRef.current = waveAction;
    }

    // Scope bone search to MainArmature subtree — guards against orphan Armature
    // nodes that Blender may export alongside the primary rig.
    //
    // three.js GLTFLoader sanitizes node names, stripping colons. The GLB stores
    // `mixamorig:Spine2` but after load the bone is named `mixamorigSpine2`.
    // Check both forms to cover either sanitization state.
    const mainArm = cloned.getObjectByName('MainArmature');
    if (!mainArm) {
      console.error('[TownGuide] MainArmature root missing — Blender export regression');
    } else {
      mainArm.traverse((obj) => {
        if (
          (obj as THREE.Bone).isBone &&
          (obj.name === 'mixamorigSpine2' || obj.name === 'mixamorig:Spine2')
        ) {
          spineBoneRef.current = obj as THREE.Bone;
        }
      });
    }
    if (!spineBoneRef.current) {
      console.error('[TownGuide] spineBoneRef not resolved — breathing disabled');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixer, cloned, animations]);

  useEffect(() => {
    const onFinished = (e: { action: THREE.AnimationAction }) => {
      // Only the wave action emits 'finished' (cycle clips are LoopRepeat).
      if (e.action !== waveActionRef.current) return;
      wavingRef.current = false;
      resumeCycleFromWave();
    };
    mixer.addEventListener('finished', onFinished);
    return () => mixer.removeEventListener('finished', onFinished);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixer]);

  useEffect(() => {
    return () => {
      // Do NOT dispose geometry or materials — SkeletonUtils.clone reuses them
      // from the useGLTF cache by reference. Disposing corrupts the cache and
      // causes black meshes on remount (strict-mode double-invoke, route re-nav).
      mixer.stopAllAction();
      mixer.uncacheRoot(cloned);
    };
  }, [mixer, cloned]);

  function advanceCycle() {
    const actions = cycleActionsRef.current;
    if (actions.length < 2) return;
    const curIdx  = cycleIndexRef.current;
    const nextIdx = (curIdx + 1) % actions.length;
    const cur  = actions[curIdx];
    const next = actions[nextIdx];
    if (!cur || !next) return;
    // Both actions are already .play()-ing (LoopRepeat). Crossfade via fadeOut/fadeIn
    // — safer than crossFadeTo which expects both running AND doesn't start stopped
    // actions. Reset the incoming to keyframe 0 so multi-frame clips (bellydancing,
    // samba) start fresh each cycle instead of picking up where they left off.
    next.reset().fadeIn(CYCLE_FADE);
    cur.fadeOut(CYCLE_FADE);
    cycleIndexRef.current = nextIdx;
  }

  function resumeCycleFromWave() {
    const wave = waveActionRef.current;
    const actions = cycleActionsRef.current;
    if (!wave || actions.length === 0) return;
    const nextIdx = (cycleIndexRef.current + 1) % actions.length;
    const next = actions[nextIdx];
    if (!next) return;
    next.reset().fadeIn(WAVE_FADE);
    wave.fadeOut(WAVE_FADE);
    cycleIndexRef.current = nextIdx;
  }

  useSceneFrame(({ clock }, delta) => {
    mixer.update(delta);

    // Timer-driven cycle advance — only while NOT waving.
    if (!wavingRef.current && clock.elapsedTime >= slotAdvanceAtRef.current) {
      advanceCycle();
      slotAdvanceAtRef.current = clock.elapsedTime + SLOT_DURATION_SEC;
    }

    // Procedural breathing on top of mixer output.
    const spine = spineBoneRef.current;
    if (spine) {
      spine.scale.y = 1 + Math.sin(clock.elapsedTime * BREATH_FREQ) * BREATH_AMP;
    }
  });

  function handleClick(e: { stopPropagation: () => void }) {
    e.stopPropagation();

    // Idempotency guard — if either chat surface is already open, bail.
    // Prevents double-open + double-wave on rapid clicks and stops guide chat
    // from stacking on top of an active building chat.
    const store = useGameStore.getState();
    if (store.chatOpen || store.guideChatOpen) return;

    // Open the Town Guide chat panel. `openGuideChat` sets
    // `guideChatOpen=true` and `movementFrozen=true` atomically.
    store.openGuideChat();

    const wave = waveActionRef.current;
    const actions = cycleActionsRef.current;
    if (!wave || wavingRef.current) return;

    // Crossfade current cycle slot → wave.
    const cur = actions[cycleIndexRef.current] ?? null;

    wavingRef.current = true;
    wave.reset();
    wave.fadeIn(WAVE_FADE);
    wave.play();
    if (cur) cur.fadeOut(WAVE_FADE);
  }

  return (
    <group
      position={[0, GROUND_Y, GUIDE_Z]}
      userData={{ isOccluder: true }}
      onClick={handleClick}
      onPointerEnter={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerLeave={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'auto';
      }}
    >
      <group scale={[GUIDE_SCALE, GUIDE_SCALE, GUIDE_SCALE]}>
        <primitive object={cloned} />
      </group>
    </group>
  );
});

export default function TownGuide() {
  // Slice D (§4c topology surgery): the old internal `<Suspense>` here would
  // have made a DeferredWarmAttachment wrapper commit-and-warm an empty
  // fallback [F9]. BootStreamedContent owns boundary → Suspense → DWA;
  // TownGuideInner suspends directly beneath it. Cohort 'npc:town-guide'.
  // BGR guide amendment (founder 2026-08-20): Nori is REVEAL-REQUIRED — she
  // loads behind the SeaLoadingScreen on the boot-critical lane, FIRST in
  // the stagger order (guide tier beats every building), and the overlay
  // holds until she has presented (the canvas declares the requirement
  // beside its showNpcs gate so an NPC-less boot never waits on her).
  return (
    <BootStreamedContent
      cohortId="npc:town-guide"
      revealRequired
      priority={bootStreamPriority(BOOT_STREAM_TIER_GUIDE, NORI_WORLD_X, NORI_WORLD_Z)}
    >
      <TownGuideInner />
    </BootStreamedContent>
  );
}
