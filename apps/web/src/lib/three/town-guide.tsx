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
 *   - Default idle: `pose-hand-on-hips` clip, LoopOnce, clampWhenFinished=true → holds at frame 0.
 *   - Procedural breathing: useFrame drives mixamorig:Spine2 scale.y = 1 + sin(t*1.8)*0.008.
 *     Additive over the mixer — mixer doesn't touch scale, only rotation/position tracks.
 *   - Wave on click: crossfade idle → wave (LoopOnce, clampWhenFinished=false), then
 *     crossfade back to idle when finished. Phase 2 TODO: also open Eliza chat.
 *
 * Available clips (all accessible by name via clips.find):
 *   - pose-hand-on-hips (default idle — frozen at frame 0)
 *   - pose-catwalk-idle, pose-dance, pose-laying
 *   - pose-standing-2, pose-standing-3, pose-standing-4
 *   - praying (58 frames)
 *   - wave (45 frames)
 *   - bellydancing (762 frames)
 *   - samba (595 frames)
 *
 * GPU constraints (Iris Xe invariants):
 *   - NO drei Text/Billboard — hard crash
 *   - NO InstancedMesh + ShaderMaterial — silent WebGPU crash
 *   - frustumCulled=false on every mesh after SkeletonUtils.clone
 *   - No per-frame allocations — mixer/action refs at component scope
 *
 * Phase 2 TODO: wire onClick → open guide Eliza chat (11th teacher character)
 */

import { useRef, useMemo, useEffect, memo, Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useGameStore } from '@/stores/game';

useGLTF.preload('/models/guide-rigged.glb');

const GROUND_Y   = -2;
const GUIDE_Z    = 240;
const GUIDE_SCALE = 100;

const CLIP_IDLE = 'pose-hand-on-hips';
const CLIP_WAVE = 'wave';

const BREATH_FREQ = 1.8;
const BREATH_AMP  = 0.008;
const WAVE_FADE   = 0.35;

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

  const idleActionRef = useRef<THREE.AnimationAction | null>(null);
  const waveActionRef = useRef<THREE.AnimationAction | null>(null);
  const wavingRef     = useRef(false);
  const spineBoneRef  = useRef<THREE.Bone | null>(null);

  useEffect(() => {
    const idleClip = animations.find((c) => c.name === CLIP_IDLE);
    const waveClip = animations.find((c) => c.name === CLIP_WAVE);

    if (idleClip) {
      const action = mixer.clipAction(idleClip, cloned);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.timeScale = 0;  // freeze — single-frame pose
      action.weight = 1.0;
      action.play();
      idleActionRef.current = action;
    }

    if (waveClip) {
      const action = mixer.clipAction(waveClip, cloned);
      action.setLoop(THREE.LoopOnce, 1);
      // wave.clampWhenFinished=false is intentional. When LoopOnce completes,
      // the action resets to frame 0 rather than freezing on the raised-hand
      // final frame. The 'finished' event handler then fires crossFadeTo back
      // to idle; during the 0.35s crossfade the wave action's `enabled` flag
      // remains true (crossFadeTo doesn't reset it), so its weight fades from
      // 1 → 0 while idle fades 0 → 1. The reset-to-frame-0 behavior means
      // the fade-out wave contribution is its first-frame pose (neutral),
      // not the raised-hand pose, producing a cleaner visual transition.
      action.clampWhenFinished = false;
      action.weight = 0;
      waveActionRef.current = action;
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
  }, [mixer, cloned, animations]);

  useEffect(() => {
    const onFinished = (e: { action: THREE.AnimationAction }) => {
      if (e.action === waveActionRef.current) {
        wavingRef.current = false;
        const idle = idleActionRef.current;
        const wave = waveActionRef.current;
        if (idle && wave) {
          // crossFadeTo does not reset enabled on the incoming action — must re-enable manually
          idle.enabled = true;
          idle.weight  = 1;
          wave.crossFadeTo(idle, WAVE_FADE, false);
        }
      }
    };
    mixer.addEventListener('finished', onFinished);
    return () => mixer.removeEventListener('finished', onFinished);
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

    // Wave animation follows — only plays on first open.
    const idle = idleActionRef.current;
    const wave = waveActionRef.current;
    if (!idle || !wave || wavingRef.current) return;

    wavingRef.current = true;
    wave.reset();
    wave.enabled = true;
    wave.weight  = 0;
    wave.play();
    idle.crossFadeTo(wave, WAVE_FADE, false);
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
