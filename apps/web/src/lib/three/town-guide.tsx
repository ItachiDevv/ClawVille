'use client';

/**
 * TownGuide — town-center anchor NPC, Mixamo-rigged with 11-clip animation system.
 *
 * Asset pipeline:
 *   - Character: /models/guide-rigged.glb (Sketchfab anime girl → Blender edits → Mixamo auto-rig
 *     → 11 animation FBXs imported as actions → pushed to NLA tracks → exported as single glb
 *     with all animations baked in as named clips)
 *
 * Animation system:
 *   - AnimationMixer on the cloned skeleton root.
 *   - Cycling idle: Nori continuously cycles through CYCLE_CLIPS (8 non-wave clips).
 *     Each clip plays LoopOnce; long clips (bellydancing/samba) are capped at LONG_CLIP_MAX_SEC
 *     via timeScale acceleration. On 'finished', the mixer advances to the next cycle slot.
 *   - Procedural breathing: useFrame drives mixamorig:Spine2 scale.y = 1 + sin(t*1.8)*0.008.
 *     Additive over the mixer — mixer doesn't touch scale, only rotation/position tracks.
 *   - Wave on click: crossfade current cycling action → wave (LoopOnce, clampWhenFinished=false).
 *     On 'finished' (wave complete) → crossfade to next cycling clip and resume cycle.
 *
 * Available clips (all accessible by name via clips.find):
 *   - pose-hand-on-hips   ← included in cycle
 *   - pose-catwalk-idle   ← included in cycle
 *   - pose-dance          ← included in cycle
 *   - pose-laying         ← EXCLUDED (looks broken standing)
 *   - pose-standing-2     ← included in cycle
 *   - pose-standing-3     ← included in cycle
 *   - pose-standing-4     ← included in cycle
 *   - praying (58 frames) ← included in cycle
 *   - wave (45 frames)    ← greeting ONLY, never in cycle
 *   - bellydancing (762 frames) ← included in cycle, capped at LONG_CLIP_MAX_SEC
 *   - samba (595 frames)        ← included in cycle, capped at LONG_CLIP_MAX_SEC
 *
 * GPU constraints (Iris Xe invariants):
 *   - NO drei Text/Billboard — hard crash
 *   - NO InstancedMesh + ShaderMaterial — silent WebGPU crash
 *   - frustumCulled=false on every mesh after SkeletonUtils.clone
 *   - No per-frame allocations — mixer/action refs at component scope
 *
 * Clip cycle design decisions:
 *   - pose-laying excluded: a lying-down pose at standing height renders as a
 *     horizontal-floating character, which looks broken without floor context.
 *   - bellydancing (762fr) and samba (595fr) are capped at LONG_CLIP_MAX_SEC=10s
 *     by running timeScale = clip.duration / LONG_CLIP_MAX_SEC so the mixer
 *     considers them "done" after 10s and fires the 'finished' event naturally.
 *     No timers or manual interrupts needed — same LoopOnce/finished pattern.
 *   - Cycle starts at index 0 (pose-hand-on-hips) so the initial look is familiar.
 */

import { useRef, useMemo, useEffect, memo, Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useGameStore } from '@/stores/game';

useGLTF.preload('/models/guide-rigged.glb');

const GROUND_Y    = -2;
const GUIDE_Z     = 240;
const GUIDE_SCALE = 200;

// Clip names — defined at module scope (no per-render allocation).
const CLIP_WAVE = 'wave';

// Ordered playlist that Nori cycles through continuously.
// pose-laying is deliberately excluded (see module comment).
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

// Long clips (bellydancing=762fr, samba=595fr) are capped at this many seconds
// by boosting timeScale so the clip "plays out" faster and fires 'finished'.
const LONG_CLIP_MAX_SEC = 10;

// Clips that need timeScale boost — keyed by name for O(1) lookup.
const LONG_CLIP_NAMES: ReadonlySet<string> = new Set(['bellydancing', 'samba']);

const CYCLE_FADE = 0.5;   // crossfade duration between cycling clips (sec)
const WAVE_FADE  = 0.35;  // crossfade duration for wave entry/exit (sec)
const BREATH_FREQ = 1.8;
const BREATH_AMP  = 0.008;

const TownGuideInner = memo(function TownGuideInner() {
  const { scene: gltfScene, animations } = useGLTF('/models/guide-rigged.glb');

  // Clone the character per-mount so each instance gets its own bone tree.
  // SkeletonUtils.clone rebinds SkinnedMesh.skeleton correctly — plain clone(true) shares bones.
  const cloned = useMemo(() => {
    const c = skeletonClone(gltfScene) as THREE.Group;
    // Bind-pose bounding sphere culls animated verts at close range — disable culling.
    // Narrowed to isMesh: SkinnedMesh.isMesh===true (extends Mesh in r182), so all
    // skinned meshes are covered. Bones, Groups, Object3Ds get no-op skipped.
    c.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) obj.frustumCulled = false;
    });
    return c;
  }, [gltfScene]);

  const mixer = useMemo(() => new THREE.AnimationMixer(cloned), [cloned]);

  // Pre-resolved cycling actions — filled once in useEffect.
  // Index mirrors CYCLE_CLIPS order; null slots mean clip not found in GLB.
  const cycleActionsRef = useRef<Array<THREE.AnimationAction | null>>(
    new Array(CYCLE_CLIPS.length).fill(null)
  );
  const waveActionRef   = useRef<THREE.AnimationAction | null>(null);
  const cycleIndexRef   = useRef<number>(0);
  const wavingRef       = useRef<boolean>(false);
  const spineBoneRef    = useRef<THREE.Bone | null>(null);

  // Helper: start the cycling action at index idx, crossfading from fromAction.
  // Defined outside useEffect so the 'finished' listener can reference it via closure.
  // Uses stable refs — no closure-capture of changing values.
  function playCycleSlot(idx: number, fromAction: THREE.AnimationAction | null) {
    const action = cycleActionsRef.current[idx];
    if (!action) {
      // Skip missing clips — advance to next.
      const next = (idx + 1) % CYCLE_CLIPS.length;
      cycleIndexRef.current = next;
      playCycleSlot(next, fromAction);
      return;
    }

    const clipName = CYCLE_CLIPS[idx];
    const clip = action.getClip();

    // Compute timeScale so long clips cap at LONG_CLIP_MAX_SEC.
    const ts = LONG_CLIP_NAMES.has(clipName)
      ? clip.duration / LONG_CLIP_MAX_SEC
      : 1;

    action.reset();
    action.enabled = true;
    action.timeScale = ts;
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = false;  // resets to frame 0 on finish → clean crossfade out
    action.weight = fromAction ? 0 : 1;
    action.play();

    if (fromAction) {
      fromAction.crossFadeTo(action, CYCLE_FADE, false);
    }
  }

  useEffect(() => {
    // Build cycle action list.
    for (let i = 0; i < CYCLE_CLIPS.length; i++) {
      const clip = animations.find((c) => c.name === CYCLE_CLIPS[i]);
      if (clip) {
        cycleActionsRef.current[i] = mixer.clipAction(clip, cloned);
      } else {
        console.warn(`[TownGuide] Clip not found: ${CYCLE_CLIPS[i]}`);
      }
    }

    // Build wave action.
    const waveClip = animations.find((c) => c.name === CLIP_WAVE);
    if (waveClip) {
      const waveAction = mixer.clipAction(waveClip, cloned);
      waveAction.setLoop(THREE.LoopOnce, 1);
      // clampWhenFinished=false: on completion resets to frame 0 rather than
      // holding the raised-hand pose. During the crossfade-out the first-frame
      // (neutral) pose fades out, producing a clean transition.
      waveAction.clampWhenFinished = false;
      waveAction.weight = 0;
      waveActionRef.current = waveAction;
    }

    // Scope bone search to MainArmature subtree — guards against orphan Armature
    // nodes that Blender may export alongside the primary rig.
    const mainArm = cloned.getObjectByName('MainArmature');
    if (!mainArm) {
      console.error('[TownGuide] MainArmature root missing — Blender export regression');
    } else {
      mainArm.traverse((obj) => {
        if ((obj as THREE.Bone).isBone && obj.name === 'mixamorig:Spine2') {
          spineBoneRef.current = obj as THREE.Bone;
        }
      });
    }
    if (!spineBoneRef.current) {
      console.error('[TownGuide] spineBoneRef not resolved — breathing disabled');
    }

    // Kick off the first cycling clip with no crossfade source.
    cycleIndexRef.current = 0;
    playCycleSlot(0, null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixer, cloned, animations]);

  useEffect(() => {
    const onFinished = (e: { action: THREE.AnimationAction }) => {
      const wave  = waveActionRef.current;
      const cycleActions = cycleActionsRef.current;

      if (e.action === wave) {
        // Wave completed — resume cycling from current index.
        wavingRef.current = false;
        const idx = cycleIndexRef.current;
        playCycleSlot(idx, wave);
        return;
      }

      // Check if finished action is a cycling clip.
      const finishedIdx = cycleActions.indexOf(e.action);
      if (finishedIdx !== -1) {
        // Not currently waving — advance cycle.
        if (!wavingRef.current) {
          const nextIdx = (finishedIdx + 1) % CYCLE_CLIPS.length;
          cycleIndexRef.current = nextIdx;
          playCycleSlot(nextIdx, e.action);
        }
        // If waving, do nothing — wave 'finished' handler above resumes cycle.
      }
    };

    mixer.addEventListener('finished', onFinished);
    return () => mixer.removeEventListener('finished', onFinished);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixer]);

  useEffect(() => {
    return () => {
      // Do NOT dispose geometry or materials here.
      // SkeletonUtils.clone reuses both geometry AND materials by reference
      // (Mesh.copy() assigns .geometry and .material by ref, not by copy).
      // Disposing either corrupts the useGLTF cache and causes black/errored
      // meshes on next mount (React strict-mode double-invoke or route re-nav).
      // The useGLTF cache owns these GPU resources and releases them when the
      // asset is evicted. Only release mixer state.
      mixer.stopAllAction();
      mixer.uncacheRoot(cloned);
    };
  }, [mixer, cloned]);

  useFrame(({ clock }, delta) => {
    mixer.update(delta);
    const spine = spineBoneRef.current;
    if (spine) {
      spine.scale.y = 1 + Math.sin(clock.elapsedTime * BREATH_FREQ) * BREATH_AMP;
    }
  });

  function handleClick(e: { stopPropagation: () => void }) {
    e.stopPropagation();

    // Idempotency guard — if either chat surface is already open, bail.
    // Prevents re-opening + double-wave when the user clicks Nori twice,
    // and stops guide chat from stacking on top of an active building chat.
    const store = useGameStore.getState();
    if (store.chatOpen || store.guideChatOpen) return;

    // Open the Town Guide chat panel. `openGuideChat` sets
    // `guideChatOpen=true` and `movementFrozen=true` atomically so the
    // player can't walk off mid-conversation.
    store.openGuideChat();

    // Interrupt current cycling clip and crossfade to wave (greeting).
    const wave = waveActionRef.current;
    if (!wave || wavingRef.current) return;

    // Find whichever cycling action is currently playing to crossfade from it.
    const cycleActions = cycleActionsRef.current;
    const currentIdx = cycleIndexRef.current;
    const currentCycleAction = cycleActions[currentIdx] ?? null;

    wavingRef.current = true;
    wave.reset();
    wave.enabled = true;
    wave.weight  = 0;
    wave.play();

    if (currentCycleAction) {
      currentCycleAction.crossFadeTo(wave, WAVE_FADE, false);
    } else {
      wave.weight = 1;
    }
  }

  return (
    <group
      position={[0, GROUND_Y, GUIDE_Z]}
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
  return (
    <Suspense fallback={null}>
      <TownGuideInner />
    </Suspense>
  );
}
