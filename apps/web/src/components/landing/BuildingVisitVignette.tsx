'use client';

/**
 * BuildingVisitVignette.tsx
 *
 * Looping landing-page vignette: the player (Milady) stands in front of the
 * Pineapple House TALKING to SpongeBob, the building's resident teacher. Gary
 * waits beside SpongeBob. A two-beat chat exchange fades in/out — SpongeBob
 * greets, Milady answers — tying the tile to the real "visit a building, learn
 * from a MiladyAI teacher" game loop.
 *
 * Rewrite 2026-06-01 (round 3): was a walk-up loop with SpongeBob occluded
 * inside the building footprint and the GLB's baked boxy sand base showing.
 * Now: characters STAND and converse in front of the house; the GLB's
 * "Sand"/"Flowers"/"Path" decorative groups are stripped to match the in-game
 * render (arena-buildings.tsx stripDecorativeMeshes); camera is a gentle
 * conversation 3/4 framing (no full orbit that turns backs to camera).
 *
 * CONSTRAINTS HONORED:
 *  - NO drei <Text> / <Billboard>         (Iris Xe hard crash)
 *  - NO InstancedMesh + ShaderMaterial    (silent WebGPU crash)
 *  - NO new Vector3/Quaternion in useFrame (GC thrash — module-scope scratch)
 *  - Lights ≤ 3: hemisphere + directional + 1 warm point (Iris Xe budget)
 *  - frustumCulled=false on all VRM / character nodes (bind-pose cull gotcha)
 *  - VRM facing: rotation.y = atan2(vx, vz) — verified ClawVille convention
 *  - DPR capped at [1, 1.25]
 *  - Geometry + mixer + VRM instance disposed on unmount
 *  - Chat bubbles = DOM overlay (absolutely positioned) — NOT drei Text
 *  - useVisibleFrameloop: canvas pauses when scrolled offscreen
 *  - import * as THREE from 'three' ONLY — never 'three/webgpu'
 */

import { Suspense, useRef, useMemo, useEffect, memo, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useVisibleFrameloop } from '@/lib/use-visible-frameloop';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';
import { preloadKTX2Bytes, useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';
import {
  useVRMInstance,
  disposeVRMInstance,
  retainVRMInstance,
  preloadVRMBytes,
} from '@/lib/three/vrm-loader';
import { retargetMixamoClip } from '@/lib/three/mixamo-retarget';
import { applyStationaryIdleAnimation } from '@/lib/three/procedural-animation';
import type { VRM } from '@pixiv/three-vrm';

// ---------------------------------------------------------------------------
// Asset paths
// ---------------------------------------------------------------------------
const VRM_PATH   = '/avatars/milady-official-3.vrm';
const VRM_ID     = 'building-visit-vignette';
const IDLE_PATH  = '/avatars/animations/idle.glb'; // Milady stands + breathes (no walk)
const BLDG_PATH  = '/models/pineapple-house-opt1-ktx.glb?v=3';
const SB_PATH    = '/models/characters/spongebob-nonorm-ktx.glb';
const GARY_PATH  = '/models/characters/gary-ktx.glb';

// ---------------------------------------------------------------------------
// Scene constants
// ---------------------------------------------------------------------------
const LOOP_S = 10;    // seconds per full loop (2 chat beats)
const BLDG_H = 3.2;   // world-unit target height for building (auto-fit)

// Character heights (world units). Milady is auto-fit to her native VRM height;
// SpongeBob/Gary are GLB props sized relative to her.
const SB_TARGET_H   = 1.25; // SpongeBob — a bit shorter than Milady (~1.5wu native)
const GARY_TARGET_H = 0.5;  // Gary — small snail at SpongeBob's feet

// Conversation layout — both characters STAND in FRONT (+Z) of the house,
// facing each other with a slight toward-camera (+Z) tilt so the camera sees
// both 3/4-front (same trick as AgentChatVignette).
const SB_X = -0.75, SB_Z = 2.3;     // SpongeBob: screen-left
const MILADY_X = 0.95, MILADY_Z = 2.3; // Milady (player): screen-right
const GARY_X = -1.35, GARY_Z = 2.55;   // Gary beside SpongeBob

// Facing: rotation.y = atan2(vx, vz). SpongeBob faces toward Milady (+X) with a
// +Z tilt; Milady faces toward SpongeBob (−X) with a +Z tilt.
const SB_ROT_Y     = Math.atan2(1, 0.45);   //  ≈ +1.15 — faces Milady + camera
const MILADY_ROT_Y = Math.atan2(-1, 0.45);  //  ≈ −1.15 — faces SpongeBob + camera
const GARY_ROT_Y   = Math.atan2(0.4, 1);    // mostly toward camera

// Camera — gentle conversation 3/4 framing (NOT a full orbit). Looks down the
// +Z axis at the two characters with the pineapple house behind them.
const CAM_POS:  [number, number, number] = [0.6, 2.65, 7.5];
const CAM_LOOK: [number, number, number] = [0.1, 1.35, 2.1];
const CAM_FOV = 40;
const CAM_SWAY_X = 0.28; // subtle lateral drift amplitude (wu)
const CAM_SWAY_Z = 0.18; // subtle dolly drift amplitude (wu)

// ---------------------------------------------------------------------------
// Two-beat chat script (SpongeBob greets, Milady answers).
// Each beat occupies half the loop with fade margins.
// ---------------------------------------------------------------------------
interface BubbleBeat {
  speaker: 'SPONGEBOB' | 'MILADY';
  side: 'left' | 'right';
  text: string;
  // visibility window within 0..1 loop progress
  inStart: number; inFull: number; outFull: number; outEnd: number;
}
const BEATS: BubbleBeat[] = [
  {
    speaker: 'SPONGEBOB', side: 'left',
    text: 'Welcome! Today: AI image & video pipelines.',
    inStart: 0.06, inFull: 0.13, outFull: 0.42, outEnd: 0.48,
  },
  {
    speaker: 'MILADY', side: 'right',
    text: "Perfect — let's build something.",
    inStart: 0.56, inFull: 0.63, outFull: 0.92, outEnd: 0.98,
  },
];

// ---------------------------------------------------------------------------
// Module-scope scratch — NEVER allocate inside useFrame
// ---------------------------------------------------------------------------
const _box    = new THREE.Box3();
const _size   = new THREE.Vector3();
const _center = new THREE.Vector3();
const _camTarget = new THREE.Vector3(...CAM_LOOK);

// ---------------------------------------------------------------------------
// Decorative-mesh strip — matches arena-buildings.tsx stripDecorativeMeshes.
// The pineapple-house GLB ships a "Sand" group (the boxy sand base) plus
// "Flowers"/"Path" decorations. The in-game render strips these; the vignette
// must too, or the boxy sand bottom shows under the pineapple.
// A mesh is removed if it (or any ancestor) is named Sand/Flowers/Path.
// ---------------------------------------------------------------------------
const _STRIP_NAME_RE = /^(sand|flowers|path)\b/i;

function stripDecorativeGroups(root: THREE.Object3D): void {
  const toRemove: THREE.Object3D[] = [];
  root.traverse((o) => {
    let p: THREE.Object3D | null = o;
    while (p) {
      if (p.name && _STRIP_NAME_RE.test(p.name)) {
        toRemove.push(o);
        break;
      }
      p = p.parent;
    }
  });
  toRemove.forEach((o) => o.removeFromParent());
}

// ---------------------------------------------------------------------------
// Undulating sand seabed — vertex-colored PlaneGeometry (module-scope singleton)
// ---------------------------------------------------------------------------
const _SAND_BRIGHT = new THREE.Color(0xd4b896);
const _SAND_MID    = new THREE.Color(0xc8a882);
const _SAND_DARK   = new THREE.Color(0xbfa06a);
const _SAND_DEEP   = new THREE.Color(0xa8884a);

function _floorHash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

let _sandFloorGeo: THREE.BufferGeometry | null = null;

function getSandFloorGeo(): THREE.BufferGeometry {
  if (_sandFloorGeo) return _sandFloorGeo;
  const W = 40, SEGS = 40;
  const geo = new THREE.PlaneGeometry(W, W, SEGS, SEGS);
  const pos = geo.attributes.position;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const tmp = new THREE.Color();
  const AMP1 = 0.18, AMP2 = 0.10, AMP3 = 0.05;

  for (let i = 0; i < count; i++) {
    const gx = pos.getX(i);
    const gy = pos.getY(i);
    const h1 = Math.sin(gx * 0.55 + 1.3) * Math.cos(gy * 0.70 + 0.9) * AMP1;
    const h2 = Math.sin(gx * 1.20 + 3.1) * Math.sin(gy * 1.50 + 2.4) * AMP2;
    const h3 = Math.cos(gx * 2.40 + 0.5) * Math.cos(gy * 2.80 + 1.2) * AMP3;
    const jitter = (_floorHash(gx * 7.3, gy * 13.7) - 0.5) * 0.04;
    const totalZ = h1 + h2 + h3 + jitter;
    pos.setZ(i, totalZ);

    const t = Math.max(0, Math.min(1, (totalZ + 0.35) / 0.70));
    if (t < 0.25)      tmp.lerpColors(_SAND_DEEP, _SAND_DARK, t / 0.25);
    else if (t < 0.55) tmp.lerpColors(_SAND_DARK, _SAND_MID, (t - 0.25) / 0.30);
    else if (t < 0.80) tmp.lerpColors(_SAND_MID, _SAND_BRIGHT, (t - 0.55) / 0.25);
    else               tmp.copy(_SAND_BRIGHT);

    colors[i * 3]     = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  _sandFloorGeo = geo;
  return geo;
}

function SandSeabed() {
  const geo = getSandFloorGeo();
  const mat = useMemo(
    () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
    [],
  );
  useEffect(() => () => { mat.dispose(); }, [mat]);
  return (
    <mesh
      geometry={geo}
      material={mat}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, 0]}
      frustumCulled={false}
    />
  );
}

// ---------------------------------------------------------------------------
// Preloads — fire-and-forget at module eval time (client-only via dynamic import)
// ---------------------------------------------------------------------------
preloadVRMBytes(VRM_PATH);
preloadKTX2Bytes(BLDG_PATH);
useGLTF.preload(IDLE_PATH);
preloadKTX2Bytes(SB_PATH);
preloadKTX2Bytes(GARY_PATH);

// ---------------------------------------------------------------------------
// computeNormalizedScaleSimple — scale + pivotOffsetY for a cloned GLB.
// Excludes SkinnedMesh from bbox (same approach as arena-location-npcs.tsx).
// ---------------------------------------------------------------------------
const _fitBox  = new THREE.Box3();
const _fitSize = new THREE.Vector3();
const _fitMeshBox = new THREE.Box3();

function computeNormalizedScaleSimple(
  scene: THREE.Object3D,
  targetH: number,
): { scale: number; pivotOffsetY: number } {
  scene.updateMatrixWorld(true);
  _fitBox.makeEmpty();
  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      _fitMeshBox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _fitBox.union(_fitMeshBox);
    }
  });
  if (_fitBox.isEmpty()) _fitBox.setFromObject(scene);
  if (_fitBox.isEmpty()) return { scale: 1, pivotOffsetY: 0 };

  const localMinY = _fitBox.min.y;
  _fitBox.getSize(_fitSize);
  const h = _fitBox.max.y > 0.001 ? _fitBox.max.y : (_fitSize.y > 0 ? _fitSize.y : 1);
  const scale = targetH / h;
  return { scale, pivotOffsetY: localMinY * scale };
}

// ---------------------------------------------------------------------------
// Building — pineapple house with the boxy "Sand" base + decorations stripped.
// ---------------------------------------------------------------------------
const BuildingMesh = memo(function BuildingMesh() {
  const { scene: src } = useGLTFWithKTX2(BLDG_PATH);

  const { group, scale, px, py, pz } = useMemo(() => {
    const g = src.clone(true);

    // Strip the baked boxy sand base + flower/path decorations BEFORE measuring,
    // so the bbox (and thus scale/centering) is driven by the pineapple body only.
    stripDecorativeGroups(g);

    _box.makeEmpty();
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m as unknown as THREE.SkinnedMesh).isSkinnedMesh) {
        _box.expandByObject(o);
      }
    });
    _box.getSize(_size);
    _box.getCenter(_center);

    const h  = _size.y > 0.001 ? _size.y : 1;
    const sc = BLDG_H / h;

    const posX = -_center.x * sc;
    const posY = -(_box.min.y < Infinity ? _box.min.y : 0) * sc;
    const posZ = -_center.z * sc;

    g.traverse((o) => { o.frustumCulled = false; });
    return { group: g, scale: sc, px: posX, py: posY, pz: posZ };
  }, [src]);

  useEffect(() => {
    return () => {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
          else (m.material as THREE.Material)?.dispose();
        }
      });
    };
  }, [group]);

  return <primitive object={group} scale={scale} position={[px, py, pz]} />;
});

// ---------------------------------------------------------------------------
// SpongeBob teacher — stands facing the player, gentle idle.
// ---------------------------------------------------------------------------
const SpongeBobTeacher = memo(function SpongeBobTeacher() {
  const { scene: src, animations } = useGLTFWithKTX2(SB_PATH);
  const animGroupRef = useRef<THREE.Group>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);

  const { cloned, scale, pivotY } = useMemo(() => {
    const c = src.clone(true);
    c.traverse((o) => { o.frustumCulled = false; });
    const { scale: s, pivotOffsetY } = computeNormalizedScaleSimple(c, SB_TARGET_H);
    return { cloned: c, scale: s, pivotY: pivotOffsetY };
  }, [src]);

  useEffect(() => {
    if (!animations || animations.length === 0) return;
    const mixer = new THREE.AnimationMixer(cloned);
    mixerRef.current = mixer;
    const idleClip = animations.find((c) => /idle|breathing/i.test(c.name)) ?? animations[0];
    const action = mixer.clipAction(idleClip, cloned);
    action.reset().setLoop(THREE.LoopRepeat, Infinity).play();
    return () => { mixer.stopAllAction(); mixer.uncacheRoot(cloned); mixerRef.current = null; };
  }, [cloned, animations]);

  useEffect(() => {
    return () => {
      cloned.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          if (Array.isArray(m.material)) m.material.forEach((mat: THREE.Material) => mat.dispose());
          else (m.material as THREE.Material)?.dispose();
        }
      });
    };
  }, [cloned]);

  useFrame(({ clock }, delta) => {
    if (!animGroupRef.current) return;
    if (mixerRef.current) mixerRef.current.update(delta);
    applyStationaryIdleAnimation({
      group: animGroupRef.current,
      isMoving: false,
      elapsed: clock.elapsedTime,
      delta: Math.min(delta, 0.1),
      direction: 'idle',
      seed: 3.7,
    });
  });

  return (
    <group position={[SB_X, -pivotY, SB_Z]} rotation={[0, SB_ROT_Y, 0]}>
      <group scale={[scale, scale, scale]}>
        <group ref={animGroupRef}>
          <primitive object={cloned} />
        </group>
      </group>
    </group>
  );
});

// ---------------------------------------------------------------------------
// Gary companion beside SpongeBob
// ---------------------------------------------------------------------------
const GaryCompanion = memo(function GaryCompanion() {
  const { scene: src } = useGLTFWithKTX2(GARY_PATH);
  const animGroupRef = useRef<THREE.Group>(null);

  const { cloned, scale, pivotY } = useMemo(() => {
    const c = src.clone(true);
    c.traverse((o) => { o.frustumCulled = false; });
    const { scale: s, pivotOffsetY } = computeNormalizedScaleSimple(c, GARY_TARGET_H);
    return { cloned: c, scale: s, pivotY: pivotOffsetY };
  }, [src]);

  useEffect(() => {
    return () => {
      cloned.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          if (Array.isArray(m.material)) m.material.forEach((mat: THREE.Material) => mat.dispose());
          else (m.material as THREE.Material)?.dispose();
        }
      });
    };
  }, [cloned]);

  useFrame(({ clock }, delta) => {
    if (!animGroupRef.current) return;
    applyStationaryIdleAnimation({
      group: animGroupRef.current,
      isMoving: false,
      elapsed: clock.elapsedTime,
      delta: Math.min(delta, 0.1),
      direction: 'idle',
      seed: 1.2,
    });
  });

  // gary.glb faces +X at rotation.y=0; combine the GARY_ROT_Y aim with the
  // −π/2 authoring offset so it ends up facing roughly toward the camera.
  return (
    <group position={[GARY_X, -pivotY, GARY_Z]} rotation={[0, GARY_ROT_Y - Math.PI / 2, 0]}>
      <group scale={[scale, scale, scale]}>
        <group ref={animGroupRef}>
          <primitive object={cloned} />
        </group>
      </group>
    </group>
  );
});

// ---------------------------------------------------------------------------
// Milady (player) — stands in front of SpongeBob, idle, facing him.
// ---------------------------------------------------------------------------
const MiladyTalker = memo(function MiladyTalker() {
  const vrm: VRM = useVRMInstance(VRM_PATH, VRM_ID);
  const { scene: idleScene, animations } = useGLTF(IDLE_PATH);

  const mixer = useMemo(() => {
    const mx = new THREE.AnimationMixer(vrm.scene);
    const src = animations[0];
    if (!src) return mx;
    let clip: THREE.AnimationClip = src;
    try {
      clip = retargetMixamoClip({ scene: idleScene, animations: [src] }, vrm, 'idle');
    } catch {
      /* raw clip fallback */
    }
    const action = mx.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    return mx;
  }, [vrm, idleScene, animations]);

  // frustumCulled=false on every VRM node (bind-pose cull gotcha).
  useEffect(() => {
    if (!vrm) return;
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
  }, [vrm]);

  useEffect(() => {
    retainVRMInstance(VRM_PATH, VRM_ID); // cancel deferred dispose on StrictMode re-setup
    return () => { mixer.stopAllAction(); disposeVRMInstance(VRM_PATH, VRM_ID); };
  }, [mixer]);

  useFrame((_state, delta) => {
    mixer.update(delta);
    vrm.update?.(delta);
  });

  return (
    <group position={[MILADY_X, 0, MILADY_Z]} rotation={[0, MILADY_ROT_Y, 0]}>
      <primitive object={vrm.scene} />
    </group>
  );
});

// ---------------------------------------------------------------------------
// Conversation camera — fixed 3/4 framing with a subtle sway (NO full orbit).
// ---------------------------------------------------------------------------
function ConversationCamera() {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(CAM_POS[0], CAM_POS[1], CAM_POS[2]);
    camera.lookAt(_camTarget);
  }, [camera]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    camera.position.x = CAM_POS[0] + Math.sin(t * 0.32) * CAM_SWAY_X;
    camera.position.z = CAM_POS[2] + Math.cos(t * 0.24) * CAM_SWAY_Z;
    camera.position.y = CAM_POS[1];
    camera.lookAt(_camTarget);
  });
  return null;
}

// ---------------------------------------------------------------------------
// Scene graph — 3 lights total (hemisphere + directional + warm point)
// ---------------------------------------------------------------------------
function VignetteScene() {
  return (
    <>
      <fogExp2 args={['#0a2d44', 0.030]} />

      {/* Light 1: warm hemisphere */}
      <hemisphereLight args={['#ffd98a', '#0a2d44', 0.95]} />
      {/* Light 2: key directional — warm sunbeam, lights both characters' fronts */}
      <directionalLight position={[2.5, 6, 6]} intensity={1.9} color="#ffe8c0" />
      {/* Light 3: warm fill near the characters so faces read */}
      <pointLight position={[0.2, 1.6, 3.2]} intensity={1.6} distance={6} decay={2} color="#ffdf9e" />

      {/* Undulating vertex-colored sand seabed */}
      <SandSeabed />

      {/* Pineapple House (sand base stripped) */}
      <Suspense fallback={null}><BuildingMesh /></Suspense>

      {/* SpongeBob teacher facing the player */}
      <Suspense fallback={null}><SpongeBobTeacher /></Suspense>

      {/* Gary beside SpongeBob */}
      <Suspense fallback={null}><GaryCompanion /></Suspense>

      {/* Milady (player) standing, talking to SpongeBob */}
      <Suspense fallback={null}><MiladyTalker /></Suspense>

      <ConversationCamera />
    </>
  );
}

// ---------------------------------------------------------------------------
// BubbleTimer — drives loopT from state.clock (same clock as the scene).
// ---------------------------------------------------------------------------
function BubbleTimer({ onTick }: { onTick: (t: number) => void }) {
  useFrame(({ clock }) => {
    onTick((clock.getElapsedTime() % LOOP_S) / LOOP_S);
  });
  return null;
}

// ---------------------------------------------------------------------------
// Bubble opacity from loop progress + a beat's fade window.
// ---------------------------------------------------------------------------
function beatOpacity(loopT: number, b: BubbleBeat): number {
  if (loopT < b.inStart || loopT >= b.outEnd) return 0;
  if (loopT < b.inFull) return (loopT - b.inStart) / (b.inFull - b.inStart);
  if (loopT < b.outFull) return 1;
  return 1 - (loopT - b.outFull) / (b.outEnd - b.outFull);
}

// ---------------------------------------------------------------------------
// Chat bubble panel — DOM overlay (NOT drei Text — Iris Xe hard constraint).
// SpongeBob is screen-left, Milady screen-right; bubbles anchor to their side,
// near the TOP corner so they never cover the characters' bodies/faces.
// ---------------------------------------------------------------------------
function BubblePanel({ beat, opacity }: { beat: BubbleBeat; opacity: number }) {
  if (opacity <= 0) return null;
  const isLeft = beat.side === 'left';
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: 8,
        ...(isLeft ? { left: 8 } : { right: 8 }),
        width: 150,
        opacity,
        transition: 'opacity 0.15s linear',
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: 'rgba(8, 20, 38, 0.9)',
          border: '1px solid rgba(100, 200, 255, 0.32)',
          borderRadius: 8,
          padding: '5px 9px',
          boxSizing: 'border-box',
          backdropFilter: 'blur(4px)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          userSelect: 'none',
          position: 'relative',
        }}
      >
        <div style={{ color: '#7dd3fc', fontWeight: 700, fontSize: 10, marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {beat.speaker}
        </div>
        <div style={{ color: 'rgba(255,255,255,0.92)', fontSize: 11, lineHeight: 1.4, wordBreak: 'break-word' }}>
          {beat.text}
        </div>
        <div
          style={{
            position: 'absolute',
            bottom: -6,
            ...(isLeft ? { left: '20%' } : { right: '20%' }),
            width: 0, height: 0,
            borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent',
            borderTop: '6px solid rgba(8, 20, 38, 0.9)',
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export — Canvas + DOM chat bubble overlay
// ---------------------------------------------------------------------------
export default function BuildingVisitVignette() {
  const { ref, frameloop } = useVisibleFrameloop();
  const [loopT, setLoopT] = useState(0);

  return (
    <div ref={ref} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <Canvas
        style={{ width: '100%', height: '100%' }}
        dpr={[1, 1.25]}
        camera={{ position: CAM_POS, fov: CAM_FOV, near: 0.1, far: 60 }}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        frameloop={frameloop}
      >
        <KTX2LoaderSetup />
        <VignetteScene />
        <BubbleTimer onTick={setLoopT} />
      </Canvas>

      {/* DOM chat bubbles — Iris Xe safe (no drei Text) */}
      {BEATS.map((b, i) => (
        <BubblePanel key={i} beat={b} opacity={beatOpacity(loopT, b)} />
      ))}
    </div>
  );
}
