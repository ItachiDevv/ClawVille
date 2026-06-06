'use client';

/**
 * AgentChatVignette.tsx
 *
 * Looping ~16-second landing-page vignette: Milady and Hermes agents exchange a
 * 4-beat scripted chat demonstrating the Agent↔Agent brand axis.
 *
 * Composition:
 *   - Two VRM avatars facing each other at 3/4 angle toward the camera.
 *   - DOM chat-bubble overlay (NOT drei Text/Billboard — Iris Xe hard crash).
 *   - The speaking agent plays 'talk' emote; the listener plays 'idle'.
 *   - Seamless 4-beat loop (~3.5 s / beat).
 *
 * Iris Xe / WebGPU constraints honored:
 *   1. MAX 2 lights (hemisphere + 1 directional).
 *   2. NO drei <Text> or <Billboard>.
 *   3. NO InstancedMesh + ShaderMaterial.
 *   4. NO new THREE.Vector3() inside useFrame — module-scope scratch only.
 *   5. ALL geometries, materials, VRM instances disposed on unmount.
 *   6. frustumCulled=false on all VRM nodes (bind-pose cull gotcha).
 *   7. DPR capped at [1, 1.25].
 *   8. useVisibleFrameloop — Canvas pauses when scrolled offscreen.
 *   9. import * as THREE from 'three' only (never 'three/webgpu').
 */

import React, {
  Suspense,
  useRef,
  useMemo,
  useEffect,
  useState,
  memo,
  useCallback,
} from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useVisibleFrameloop } from '@/lib/use-visible-frameloop';
import {
  useVRMInstance,
  disposeVRMInstance,
  preloadVRMBytes,
} from '@/lib/three/vrm-loader';
import { retargetMixamoClip } from '@/lib/three/mixamo-retarget';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import type { VRM } from '@pixiv/three-vrm';

// ---------------------------------------------------------------------------
// Asset paths
// ---------------------------------------------------------------------------
const MILADY_PATH = '/avatars/milady-official-3.vrm';
const HERMES_PATH = '/avatars/hermes-female.vrm';
const MILADY_ID   = 'agentchat-milady';
const HERMES_ID   = 'agentchat-hermes';
const TALK_PATH   = '/avatars/animations/emotes/talk.glb';
const IDLE_PATH   = '/avatars/animations/idle.glb';

// ---------------------------------------------------------------------------
// Scene + timing constants
// ---------------------------------------------------------------------------

/** Target VRM height in the vignette world-unit space. Camera is ~6.6 wu away. */
const VRM_TARGET_H = 1.6; // world units

/** X-separation between the two characters (each offset from center). */
const CHAR_X_OFFSET = 0.82;

/** Seconds per beat — 4 beats × 3.5 s = 14 s total loop period. */
const BEAT_DURATION_S = 3.5;

const BEAT_COUNT = 4;

/** Crossfade duration in seconds. */
const CROSSFADE_S = 0.35;

// Facing angles — rotation.y = atan2(vx, vz), ClawVille convention.
// Milady (left, x=-1.1): faces right (+X) with a slight toward-camera (+Z) tilt
//   → direction (0.95, 0, 0.32) → atan2(0.95, 0.32) ≈ 1.25 rad
// Hermes (right, x=+1.1): faces left (-X) with a slight toward-camera (+Z) tilt
//   → direction (-0.95, 0, 0.32) → atan2(-0.95, 0.32) ≈ -1.25 rad
const MILADY_ROT_Y = Math.atan2(0.95, 0.32);
const HERMES_ROT_Y = Math.atan2(-0.95, 0.32);

// ---------------------------------------------------------------------------
// Chat beat script
// ---------------------------------------------------------------------------
interface Beat {
  speaker: 'MILADY' | 'HERMES';
  text: string;
}

const BEATS: Beat[] = [
  { speaker: 'HERMES', text: 'How do you keep memory between runs?' },
  { speaker: 'MILADY', text: 'RAG on ElizaOS — embeddings in, recall out.' },
  { speaker: 'MILADY', text: "Your tool loop's tight though — teach me?" },
  { speaker: 'HERMES', text: 'Plan, call, observe, repeat. Here\'s my SKILL.md.' },
];

// ---------------------------------------------------------------------------
// Camera lookAt override — R3F Canvas prop sets position+fov but always aims
// at world origin. We need a slight downward tilt (mid-torso focus at y≈0.82)
// so a 1.7wu avatar (feet y=0, head y≈1.7) sits in the lower-center with
// ~25% headroom above for the chat bubbles.
// ---------------------------------------------------------------------------

/**
 * Runs once after mount to override the camera lookAt.
 * position=[0, 1.05, 6.6] + lookAt(0, 0.82, 0):
 *   - Head (y≈1.7) sits ~0.65wu above lookAt → atan2(0.65, 6.6) ≈ 5.6° above center
 *   - fov=34 half-angle ≈ 17° → head at ~5.6° from center = top ~1/3 of frame
 *   - feet (y=0) at ≈0.82wu below lookAt → 7.1° below center, well within 17°
 * Result: full avatar visible with clear headroom for DOM bubbles at top.
 */
function CameraSetup() {
  const { camera } = useThree();
  useEffect(() => {
    camera.lookAt(0, 1.4, 0);
    camera.updateMatrixWorld(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

// ---------------------------------------------------------------------------
// Module-scope scratch — NEVER allocate inside useFrame
// ---------------------------------------------------------------------------
// (No Vector3 allocations needed in this component's useFrame paths)

// ---------------------------------------------------------------------------
// Preloads — fire-and-forget at module eval time (client-only via dynamic import)
// ---------------------------------------------------------------------------
preloadVRMBytes(MILADY_PATH);
preloadVRMBytes(HERMES_PATH);
useGLTF.preload(TALK_PATH);
useGLTF.preload(IDLE_PATH);

// (No module-scope geo/mat needed — floor uses inline JSX children to avoid
// the dual @types/three prop-type mismatch that appears when passing module-scope
// Three.js objects as geometry={}/material={} JSX props.)

// ---------------------------------------------------------------------------
// Internal: one avatar (Milady or Hermes)
// ---------------------------------------------------------------------------

interface AvatarInnerProps {
  vrmPath: string;
  instanceId: string;
  posX: number;
  rotY: number;
  /** Whether this avatar is the current speaker (plays 'talk' emote). */
  isSpeaker: boolean;
  /** Ref exposed to parent so it can flip speaker state without remounting. */
  speakerRef: React.MutableRefObject<boolean>;
}

const AvatarInner = memo(function AvatarInner({
  vrmPath,
  instanceId,
  posX,
  rotY,
  isSpeaker: initialSpeaker,
  speakerRef,
}: AvatarInnerProps) {
  const vrm: VRM = useVRMInstance(vrmPath, instanceId);
  const { scene: talkScene, animations: talkAnims } = useGLTF(TALK_PATH);
  const { scene: idleScene, animations: idleAnims } = useGLTF(IDLE_PATH);

  // Compute scale + foot-grounding offset once per VRM instance.
  // Cast bridges dual @types/three@0.170/0.182 mismatch (same pattern as
  // cove-interior.tsx, player-avatar.tsx, arena-npcs.tsx).
  const { scale, offsetY } = useMemo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => computeVRMAvatarFit(vrm as any, undefined, VRM_TARGET_H),
    [vrm],
  );

  // Apply scale and ground VRM so feet are at Y=0.
  useEffect(() => {
    vrm.scene.scale.setScalar(scale);
    vrm.scene.position.y = offsetY;
    vrm.scene.updateMatrixWorld(true);
    // Defensive frustum-cull disable (normaliseVRM already fattens spheres,
    // but belt-and-suspenders for a landing page where culling bugs would be
    // immediately visible to first-time visitors).
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
  }, [vrm, scale, offsetY]);

  // Build mixer + both retargeted clips once.
  const { mixer, talkAction, idleAction } = useMemo(() => {
    // Cast to `any` to bridge the dual @types/three@0.170/0.182 mismatch —
    // same pattern used in BuildingVisitVignette and cove-interior.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mx = new THREE.AnimationMixer(vrm.scene as any);

    let talkClip: THREE.AnimationClip | null = talkAnims[0] ?? null;
    if (talkClip) {
      try {
        talkClip = retargetMixamoClip(
          { scene: talkScene, animations: [talkAnims[0]!] },
          vrm,
          'talk',
        );
      } catch {
        // Fall back to raw clip — animation may be imperfect but won't crash.
        talkClip = talkAnims[0] ?? null;
      }
    }

    let idleClip: THREE.AnimationClip | null = idleAnims[0] ?? null;
    if (idleClip) {
      try {
        idleClip = retargetMixamoClip(
          { scene: idleScene, animations: [idleAnims[0]!] },
          vrm,
          'idle',
        );
      } catch {
        idleClip = idleAnims[0] ?? null;
      }
    }

    const tAct = talkClip ? mx.clipAction(talkClip) : null;
    const iAct = idleClip ? mx.clipAction(idleClip) : null;

    if (tAct) {
      tAct.setLoop(THREE.LoopRepeat, Infinity);
    }
    if (iAct) {
      iAct.setLoop(THREE.LoopRepeat, Infinity);
    }

    // Start with whichever state initialSpeaker dictates.
    // The speakerRef is the live source of truth during useFrame.
    if (tAct && iAct) {
      if (initialSpeaker) {
        iAct.play();
        iAct.crossFadeTo(tAct, 0, false);
        tAct.reset().play();
      } else {
        iAct.reset().play();
      }
    } else if (iAct) {
      iAct.reset().play();
    } else if (tAct) {
      tAct.reset().play();
    }

    return { mixer: mx, talkAction: tAct, idleAction: iAct };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vrm, talkScene, idleScene]);

  // Track the last speaker state so we only crossfade on transitions.
  const prevSpeakerRef = useRef(initialSpeaker);

  useFrame((_state, delta) => {
    const nowSpeaker = speakerRef.current;

    // Detect speaker flip → crossfade to the appropriate clip.
    if (nowSpeaker !== prevSpeakerRef.current) {
      prevSpeakerRef.current = nowSpeaker;
      if (talkAction && idleAction) {
        if (nowSpeaker) {
          // Become speaker: fade from idle → talk.
          // crossFadeTo requires the incoming action to be reset+playing first.
          talkAction.reset().fadeIn(CROSSFADE_S).play();
          idleAction.crossFadeTo(talkAction, CROSSFADE_S, false);
        } else {
          // Become listener: fade from talk → idle.
          idleAction.reset().fadeIn(CROSSFADE_S).play();
          talkAction.crossFadeTo(idleAction, CROSSFADE_S, false);
        }
      }
    }

    mixer.update(delta);
    vrm.update?.(delta);
  });

  // Dispose mixer + VRM instance on unmount.
  useEffect(() => {
    return () => {
      mixer.stopAllAction();
      disposeVRMInstance(vrmPath, instanceId);
    };
  }, [mixer, vrmPath, instanceId]);

  return (
    <group position={[posX, 0, 0]} rotation={[0, rotY, 0]}>
      <primitive object={vrm.scene} />
    </group>
  );
});

// ---------------------------------------------------------------------------
// Scene contents — lights, floor, avatars
// ---------------------------------------------------------------------------

interface SceneContentsProps {
  miladySpeakerRef: React.MutableRefObject<boolean>;
  hermesSpeakerRef: React.MutableRefObject<boolean>;
  beatIndexRef: React.MutableRefObject<number>;
}

function SceneContents({
  miladySpeakerRef,
  hermesSpeakerRef,
  beatIndexRef,
}: SceneContentsProps) {
  // Drive the beat timer from the R3F clock so it's in sync with the animation.
  // Update refs only (no React state) — DOM bubbles are controlled by a separate
  // React timer in the root component to avoid triggering 3D re-renders.
  useFrame((state) => {
    const elapsed = state.clock.getElapsedTime();
    const beatIndex = Math.floor(elapsed / BEAT_DURATION_S) % BEAT_COUNT;

    if (beatIndex !== beatIndexRef.current) {
      beatIndexRef.current = beatIndex;
      const beat = BEATS[beatIndex]!;
      miladySpeakerRef.current = beat.speaker === 'MILADY';
      hermesSpeakerRef.current = beat.speaker === 'HERMES';
    }
  });

  return (
    <>
      {/* Underwater teal hemisphere — sky/ground matches site palette */}
      <hemisphereLight args={['#3acfdb', '#0a4a5a', 0.9]} />
      {/* Single directional key light — warm enough to read avatars clearly */}
      <directionalLight
        position={[3, 6, 4]}
        intensity={1.25}
        color="#d0f4ff"
      />

      {/* Teal-sandy platform floor — inline children avoid dual @types/three prop mismatch */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <circleGeometry args={[4, 32]} />
        <meshStandardMaterial color="#2a7a8a" roughness={0.88} metalness={0.05} />
      </mesh>

      {/* Milady — left character */}
      <Suspense fallback={null}>
        <AvatarInner
          vrmPath={MILADY_PATH}
          instanceId={MILADY_ID}
          posX={-CHAR_X_OFFSET}
          rotY={MILADY_ROT_Y}
          isSpeaker={false}
          speakerRef={miladySpeakerRef}
        />
      </Suspense>

      {/* Hermes — right character */}
      <Suspense fallback={null}>
        <AvatarInner
          vrmPath={HERMES_PATH}
          instanceId={HERMES_ID}
          posX={CHAR_X_OFFSET}
          rotY={HERMES_ROT_Y}
          isSpeaker={true}
          speakerRef={hermesSpeakerRef}
        />
      </Suspense>
    </>
  );
}

// ---------------------------------------------------------------------------
// Chat bubble overlay — DOM only, absolutely positioned over the canvas
// ---------------------------------------------------------------------------

// Bubble styles match npc-speech-bubbles.tsx: dark navy bg, 1px cyan border,
// speaker name #7dd3fc uppercase bold, white text, CSS-triangle tail.

// Bubble panel for one speaker (position handled by parent layout).
function BubblePanel({
  beat,
  visible,
  side,
}: {
  beat: Beat | null;
  visible: boolean;
  side: 'left' | 'right';
}) {
  const isLeft = side === 'left';
  const tailLeft = isLeft ? '20%' : 'auto';
  const tailRight = isLeft ? 'auto' : '20%';

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        ...(isLeft ? { left: 8 } : { right: 8 }),
        width: 140,
        // Fade in/out using opacity + pointer-events
        opacity: visible && beat !== null ? 1 : 0,
        transition: 'opacity 0.3s ease',
        pointerEvents: 'none',
        zIndex: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: 'rgba(8, 20, 38, 0.88)',
          border: '1px solid rgba(100, 200, 255, 0.3)',
          borderRadius: 8,
          padding: '5px 9px',
          boxSizing: 'border-box',
          backdropFilter: 'blur(4px)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          userSelect: 'none',
          position: 'relative',
        }}
      >
        {/* Speaker label */}
        <div
          style={{
            color: '#7dd3fc',
            fontWeight: 700,
            fontSize: 10,
            marginBottom: 3,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {isLeft ? 'MILADY' : 'HERMES'}
        </div>
        {/* Message text */}
        <div
          style={{
            color: 'rgba(255,255,255,0.92)',
            fontSize: 11,
            lineHeight: 1.4,
            wordBreak: 'break-word',
          }}
        >
          {beat?.text ?? ''}
        </div>
        {/* CSS triangle tail pointing downward */}
        <div
          style={{
            position: 'absolute',
            bottom: -6,
            left: tailLeft,
            right: tailRight,
            width: 0,
            height: 0,
            borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent',
            borderTop: '6px solid rgba(8, 20, 38, 0.88)',
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export default function AgentChatVignette() {
  const { ref, frameloop } = useVisibleFrameloop();

  // beatIndex drives which bubble is shown. React state so DOM updates on change.
  const [beatIndex, setBeatIndex] = useState(0);

  // Mutable refs shared with the 3D scene — no React re-renders on flip.
  const beatIndexRef       = useRef(0);
  const miladySpeakerRef   = useRef(false);  // true when Milady is speaking
  const hermesSpeakerRef   = useRef(true);   // Hermes speaks first (beat 0)

  // Initialize refs to match beat 0 (HERMES speaking).
  useEffect(() => {
    const beat = BEATS[0]!;
    miladySpeakerRef.current = beat.speaker === 'MILADY';
    hermesSpeakerRef.current = beat.speaker === 'HERMES';
  }, []);

  // Sync DOM state from the beat timer. We poll beatIndexRef every ~100 ms
  // rather than using a setInterval of BEAT_DURATION_S to avoid timing drift
  // between the React timer and the R3F clock. 100ms polling is cheap.
  const syncBeat = useCallback(() => {
    const next = beatIndexRef.current;
    setBeatIndex((prev) => (prev !== next ? next : prev));
  }, []);

  useEffect(() => {
    const id = setInterval(syncBeat, 100);
    return () => clearInterval(id);
  }, [syncBeat]);

  const currentBeat = BEATS[beatIndex] ?? BEATS[0]!;
  const miladyBeat  = currentBeat.speaker === 'MILADY' ? currentBeat : null;
  const hermesBeat  = currentBeat.speaker === 'HERMES' ? currentBeat : null;

  return (
    <div
      ref={ref}
      style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
    >
      {/* 3D Canvas */}
      <Canvas
        style={{ width: '100%', height: '100%' }}
        dpr={[1, 1.25]}
        camera={{
          position: [0, 1.4, 6.5],
          fov: 32,
          near: 0.1,
          far: 30,
        }}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        frameloop={frameloop}
      >
        {/* Subtle fog to give depth, not to occlude avatars */}
        <fogExp2 args={['#0d3d4e', 0.018]} />

        {/* Override camera lookAt to mid-torso so full avatar + headroom fits */}
        <CameraSetup />

        <SceneContents
          miladySpeakerRef={miladySpeakerRef}
          hermesSpeakerRef={hermesSpeakerRef}
          beatIndexRef={beatIndexRef}
        />
      </Canvas>

      {/* DOM bubble overlay — Iris Xe safe (no drei Text/Billboard) */}
      <BubblePanel
        beat={miladyBeat}
        visible={currentBeat.speaker === 'MILADY'}
        side="left"
      />
      <BubblePanel
        beat={hermesBeat}
        visible={currentBeat.speaker === 'HERMES'}
        side="right"
      />
    </div>
  );
}
