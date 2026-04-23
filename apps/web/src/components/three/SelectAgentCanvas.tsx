'use client';

/**
 * SelectAgentCanvas — 3D character preview for the Agent Setup screen.
 *
 * Renders a rotating platform with the selected agent's GLB model,
 * underwater atmosphere effects, and dramatic lighting.
 *
 * GPU constraints: no InstancedMesh, no drei Text/Billboard, no three/webgpu or TSL.
 * Uses plain WebGLRenderer (via R3F default) + plain Three.js materials only.
 * TSL NodeMaterials were removed 2026-04-23 to fix per-frame VRM shader crash.
 */

import React, { useRef, memo, Suspense, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
// UnderwaterAtmosphere and UnderwaterLightRays are TSL/three-webgpu-only components.
// They cannot coexist with a plain WebGLRenderer Canvas — importing them would pull
// three/webgpu into this module, creating a second THREE instance and causing
// NodeMaterial.vertexShader=undefined crash in WebGLPrograms.acquireProgram.
// Dropped from SelectAgentCanvas until a plain-three replacement is available.
import { discoverLobsterParts } from '@/lib/three/lobster-parts';
import { LobsterAnimator, resolveAnimState } from '@/lib/three/lobster-animations';
import { applyIdleAnimation, idToSeed } from '@/lib/three/procedural-animation';
import {
  createCharacterAnimator,
  applyColorTint,
  type CharacterAnimator,
} from '@/lib/three/character-animations';

import {
  MODEL_REGISTRY,
  type ModelKey,
  type ModelRegistryEntry,
  type PickerColorId,
} from '@/lib/three/agent-model-registry';
import { useVRM, preloadVRM } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator, preloadMixamoClips } from '@/lib/three/vrm-character-animator';

// Module-scope scene background color — avoids a new THREE.Color allocation on
// every render. R3F only reads the scene.background prop at Canvas creation time.
const SCENE_BG = new THREE.Color(0x030d1a);

// Color tint presets — exactly the 4 entries reachable via the picker UI.
// Import PickerColorId for strict key typing.
const COLOR_TINTS: Record<PickerColorId, number> = {
  green:  0x30ff70,
  red:    0xff3030,
  blue:   0x3070ff,
  yellow: 0xffd700,
};

// ---------------------------------------------------------------------------
// RuneCircle — flat disc on the pedestal top with a static glowing tint.
// Previously used TSL MeshBasicNodeMaterial for animated rune waves + pulse;
// replaced with plain MeshBasicMaterial to avoid the three/webgpu dual-instance
// crash (NodeMaterial.vertexShader=undefined → WebGLPrograms.acquireProgram .replace() TypeError).
// Rune-wave animation and pulse are sacrificed. Static glow is retained.
// 1 draw call. AdditiveBlending so it glows without obscuring the pedestal.
// ---------------------------------------------------------------------------
function RuneCircle() {
  const mat = React.useMemo(() => new THREE.MeshBasicMaterial({
    color: 0x00ccff,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }), []);

  useEffect(() => () => mat.dispose(), [mat]);

  return (
    <mesh position={[0, 0.2, 0]} rotation={[-Math.PI / 2, 0, 0]} material={mat}>
      <planeGeometry args={[22, 22, 1, 1]} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// SpotlightConeSelect — fake spotlight shining DOWN from above the model.
// Open CylinderGeometry (radiusBottom=0, inverted) with additive blending.
// No actual SpotLight — the scene light budget is already at 3/3.
// Previously used TSL MeshBasicNodeMaterial for fade+pulse animation;
// replaced with plain MeshBasicMaterial to fix the three/webgpu dual-instance
// crash. Pulsing falloff is sacrificed. Static cone glow is retained.
// 1 draw call.
// ---------------------------------------------------------------------------
function SpotlightConeSelect() {
  const mat = React.useMemo(() => new THREE.MeshBasicMaterial({
    color: 0x2db6ff,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  }), []);

  useEffect(() => () => mat.dispose(), [mat]);

  return (
    // Inverted cone: radiusTop = wide (at water-surface level), radiusBottom = 0 (tip points down at model)
    // Position so the tip is near y=15 (above the model), open end at y=80
    <mesh position={[0, 55, 0]} material={mat}>
      <cylinderGeometry args={[20, 0, 70, 24, 1, true]} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// EmberParticles — 80 static ember points.
// Previously used PointsNodeMaterial with TSL positionNode/colorNode/opacityNode
// for upward-drift animation; replaced with plain PointsMaterial to fix the
// three/webgpu dual-instance crash. Upward-drift animation is sacrificed.
// Static orange glow particles remain. 1 draw call for all 80 particles.
// ---------------------------------------------------------------------------
const EMBER_COUNT = 80;

function EmberParticles() {
  const geo = React.useMemo(() => {
    const pos = new Float32Array(EMBER_COUNT * 3);
    for (let i = 0; i < EMBER_COUNT; i++) {
      const r   = Math.random() * 8;
      const ang = Math.random() * Math.PI * 2;
      pos[i * 3 + 0] = Math.cos(ang) * r;
      pos[i * 3 + 1] = Math.random() * 30;
      pos[i * 3 + 2] = Math.sin(ang) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);

  const mat = React.useMemo(() => new THREE.PointsMaterial({
    color: 0xff7219,
    transparent: true,
    size: 3.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  }), []);

  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);

  return <points geometry={geo} material={mat} />;
}

// ---------------------------------------------------------------------------
// Rotating Platform
// ---------------------------------------------------------------------------

function RotatingPlatform({ children }: { children?: React.ReactNode }) {
  const groupRef = useRef<THREE.Group>(null!);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.3;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Main platform disc */}
      <mesh position={[0, -1, 0]} receiveShadow>
        <cylinderGeometry args={[12, 14, 1.5, 32]} />
        <meshStandardMaterial
          color={0x0d2a40}
          roughness={0.7}
          metalness={0.3}
          transparent
          opacity={0.8}
        />
      </mesh>

      {/* Rune circle — glowing TSL disc on pedestal top */}
      <RuneCircle />

      {/* Inner glow ring */}
      <mesh position={[0, -0.2, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[10, 0.15, 8, 48]} />
        <meshBasicMaterial color={0x00ccff} transparent opacity={0.3} />
      </mesh>

      {/* Outer glow ring */}
      <mesh position={[0, -0.2, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[13, 0.1, 8, 48]} />
        <meshBasicMaterial color={0x0088cc} transparent opacity={0.15} />
      </mesh>

      {/* Model sits on top of the platform */}
      {children}
    </group>
  );
}

// ---------------------------------------------------------------------------
// VRM Model on Platform
// Separate component so Suspense handles VRM load independently.
// VRM feet at Y=0 — no pivot offset / yOffset needed.
// Color tinting is NOT applied to VRM (MToon pipeline breaks under std lerp).
// ---------------------------------------------------------------------------

const PlatformModelVRM = memo(function PlatformModelVRM({
  modelKey,
}: {
  modelKey: string;
}) {
  const reg: ModelRegistryEntry = MODEL_REGISTRY[modelKey as ModelKey] ?? MODEL_REGISTRY.milady_official_1;
  const vrm = useVRM(reg.path);

  const vrmAnimatorRef = React.useRef<VRMCharacterAnimator | null>(null);

  React.useEffect(() => {
    if (!vrm) return;
    const animator = new VRMCharacterAnimator(vrm);
    vrmAnimatorRef.current = animator;
    animator.init().catch((err) => {
      console.warn('[SelectAgentCanvas VRM] animator init failed:', err);
    });
    return () => {
      vrmAnimatorRef.current = null;
      animator.dispose();
    };
  }, [vrm]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    // idle=false so the walk anim plays — gives a livelier preview on the pedestal
    vrmAnimatorRef.current?.update(dt, false);
  });

  return (
    // reg.scale * 2.1 (≈ 27.3) — matches the VRM_NPC_SCALE=28 sizing used by
    // wandering Milady NPCs in arena-npcs.tsx, so the picker preview renders at
    // roughly the same apparent height as the in-world avatar. Previously used
    // 1.35× which made Milady fill only ~60% of the shrine vs. OpenClaw GLBs
    // filling ~90% — user flagged 2026-04-23 as "half as small as other
    // avatars". The registry's per-row scale (13) is retained for the picker
    // authoring context; this multiplier is a picker-only visual adjustment.
    <group position={[0, 1.5, 0]} scale={[reg.scale * 2.1, reg.scale * 2.1, reg.scale * 2.1]}>
      <primitive object={vrm.scene} />
    </group>
  );
});

// ---------------------------------------------------------------------------
// GLB Model on Platform
// ---------------------------------------------------------------------------

const PlatformModelGLB = memo(function PlatformModelGLB({
  modelKey,
  color,
}: {
  modelKey: string;
  color: string;
}) {
  // Cast to ModelKey for index safety; unknown keys fall back to lobster at runtime.
  const reg: ModelRegistryEntry = MODEL_REGISTRY[modelKey as ModelKey] ?? MODEL_REGISTRY.lobster;

  const { scene } = useGLTF(reg.path);
  const groupRef     = useRef<THREE.Group>(null!);
  const animGroupRef = useRef<THREE.Group>(null!);

  // Determine if this model uses the new universal animator or the old lobster system.
  // lobster + crayfish keep the LobsterAnimator which has full body-part discovery.
  const useNewSystem = modelKey !== 'lobster' && modelKey !== 'crayfish';

  const { cloned, lobsterAnimator, charAnimator } = React.useMemo(() => {
    const c = scene.clone(true);
    const tint = new THREE.Color(COLOR_TINTS[color as PickerColorId] ?? 0x00ccdd);
    // Use shared applyColorTint from character-animations
    applyColorTint(c, tint, 0.6, 0.2);

    if (useNewSystem) {
      const anim = createCharacterAnimator(modelKey, c);
      return { cloned: c, lobsterAnimator: null as LobsterAnimator | null, charAnimator: anim };
    } else {
      const parts = discoverLobsterParts(c);
      const anim  = new LobsterAnimator(parts);
      return { cloned: c, lobsterAnimator: anim, charAnimator: null as CharacterAnimator | null };
    }
  }, [scene, modelKey, color]);

  // Dispose materials only when modelKey/color changes or on unmount.
  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if ((mesh as any).isMesh) {
          // Dispose materials only — applyColorTint() in character-animations.ts
          // clones the material per instance, so this clone owns its materials.
          // NEVER dispose geometry: scene.clone(true) shares BufferGeometry with
          // the useGLTF cache (Mesh.copy: this.geometry = source.geometry). If
          // we disposed it, the cache would hand out a disposed buffer on the
          // next load of this modelKey. Leave geometry cleanup to useGLTF's
          // internal lifecycle or an explicit page-level useEffect(clear, [])
          // if full cleanup is ever needed.
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material?.dispose();
        }
      });
    };
  }, [cloned]);

  const seed = React.useMemo(() => idToSeed(modelKey + color), [modelKey, color]);

  useFrame(({ clock }, delta) => {
    const dt      = Math.min(delta, 0.1);
    const elapsed = clock.elapsedTime;

    if (useNewSystem && charAnimator && animGroupRef.current) {
      // New universal system — handles group-level + per-mesh animation in one call
      charAnimator.update(animGroupRef.current, elapsed, dt, false /* idle */);
    } else if (lobsterAnimator && animGroupRef.current) {
      // Legacy lobster system
      const animState = resolveAnimState({
        isDead: false, inCombat: false, combatAction: null,
        direction: 'idle', inConversation: false,
      });
      lobsterAnimator.update(dt, elapsed, animState, 'idle');
      applyIdleAnimation({
        group: animGroupRef.current,
        isMoving: false, elapsed, delta: dt, direction: 'idle', seed,
      });
    }
  });

  // yOffset handles models that clip below the pedestal (e.g. jellyfish with
  // origin at bell base). Defaults to 0 when not specified in registry.
  const yOffset = reg.yOffset ?? 0;

  return (
    <group ref={groupRef} position={[0, 1.5 + yOffset, 0]} scale={[reg.scale, reg.scale, reg.scale]}>
      <group ref={animGroupRef}>
        <primitive object={cloned} />
      </group>
    </group>
  );
});

// ---------------------------------------------------------------------------
// PlatformModel — routes to VRM or GLB path based on registry avatar_type
// ---------------------------------------------------------------------------

const PlatformModel = memo(function PlatformModel({
  modelKey,
  color,
}: {
  modelKey: string;
  color: string;
}) {
  const reg: ModelRegistryEntry = MODEL_REGISTRY[modelKey as ModelKey] ?? MODEL_REGISTRY.lobster;

  useEffect(() => {
    if (!MODEL_REGISTRY[modelKey as ModelKey]) {
      console.warn(`[SelectAgentCanvas] unknown modelKey "${modelKey}", falling back to lobster`);
    }
  }, [modelKey]);

  if (reg.avatar_type === 'vrm') {
    return (
      <Suspense fallback={null}>
        <PlatformModelVRM modelKey={modelKey} />
      </Suspense>
    );
  }

  return <PlatformModelGLB modelKey={modelKey} color={color} />;
});

// ---------------------------------------------------------------------------
// Scene Contents
// ---------------------------------------------------------------------------

const SceneContents = memo(function SceneContents({
  modelKey,
  color,
}: {
  modelKey: string;
  color: string;
}) {
  const reg = MODEL_REGISTRY[modelKey as ModelKey] ?? MODEL_REGISTRY.lobster;
  const isVRM = reg.avatar_type === 'vrm';

  // Single unified atmosphere — underwater cyan, matching what the player
  // actually sees in-game. Both GLB sea creatures AND VRM Milady avatars
  // live in the same world; the picker should preview that world honestly.
  //
  // VRMs get boosted lighting on top of the base scene so the dark-haired
  // neo-chibi faces don't disappear into the cyan murk — without breaking
  // the theme. Camera framing also shifts for VRM so the taller humanoid
  // silhouette fits the shrine panel.
  return (
    <>
      {/* Camera — VRM target is higher (chest-level) + closer distance
          because VRMs render taller than sea creatures at their respective
          scales. GLB path keeps the prior sea-creature framing. */}
      <OrbitControls
        makeDefault
        enablePan={false}
        enableZoom={true}
        minDistance={isVRM ? 24 : 25}
        maxDistance={isVRM ? 75 : 80}
        minPolarAngle={Math.PI * (isVRM ? 0.32 : 0.28)}
        maxPolarAngle={Math.PI * (isVRM ? 0.52 : 0.55)}
        target={isVRM ? [0, 14, 0] : [0, 8, 0]}
      />

      {/* Shared underwater base lighting */}
      <directionalLight position={[10, 40, 20]} intensity={isVRM ? 1.6 : 1.2} color={0xfff5e0} />
      <pointLight position={[0, -5, 10]} color={0x00aaff} intensity={isVRM ? 1.0 : 0.8} distance={60} />
      <ambientLight color={0x05152b} intensity={isVRM ? 0.75 : 0.4} />

      {/* VRM-only extra lights — keep the underwater atmosphere, but add a
          cyan rim behind the avatar + a warm fill from below so the face
          reads cleanly. Brand-neutral (cyan / warm-white), not a pink shift. */}
      {isVRM && (
        <>
          <directionalLight position={[-14, 18, -10]} intensity={0.85} color={0x8fe4ff} />
          <pointLight position={[0, 6, 14]} color={0xffeee0} intensity={0.7} distance={40} />
        </>
      )}

      {/* Underwater fog — softer for VRM so the avatar doesn't get washed
          out at chest height. Near=30 still keeps the figure crystal clear. */}
      <fog attach="fog" args={[0x030d1a, isVRM ? 40 : 30, isVRM ? 140 : 120]} />

      {/* Atmosphere effects — UnderwaterAtmosphere and UnderwaterLightRays
          are TSL/three-webgpu components and cannot run in a plain WebGLRenderer
          Canvas. They are intentionally excluded here to avoid the dual-THREE-
          instance NodeMaterial.vertexShader crash. Static ember particles remain. */}
      <EmberParticles />
      <SpotlightConeSelect />

      {/* Rotating platform with model */}
      <Suspense fallback={null}>
        <RotatingPlatform>
          <PlatformModel modelKey={modelKey} color={color} />
        </RotatingPlatform>
      </Suspense>
    </>
  );
});

// ---------------------------------------------------------------------------
// Exported Canvas
// ---------------------------------------------------------------------------

interface SelectAgentCanvasProps {
  modelKey?: string;
  color?: string;
  /** Fired once when R3F finishes creating the renderer — guaranteed to have a
   *  DOM element at this point. Use it to obtain the canvas for toDataURL()
   *  capture instead of relying on DOM timing via getElementById. */
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
}

export default function SelectAgentCanvas({
  modelKey = 'lobster',
  color = 'green',  // matches PICKER_COLORS default
  onCanvasReady,
}: SelectAgentCanvasProps) {
  // Preload all models in the background after first commit.
  // GLB models use useGLTF.preload; VRM models use preloadVRM (different loader).
  // Also preload Mixamo animation clips for VRM animators.
  useEffect(() => {
    preloadMixamoClips();
    Object.values(MODEL_REGISTRY).forEach((m: ModelRegistryEntry) => {
      if (m.avatar_type === 'vrm') {
        preloadVRM(m.path);
      } else {
        useGLTF.preload(m.path);
      }
    });
  }, []);

  return (
    // w-full h-full fills the parent framed panel (200px in create-agent/page.tsx).
    // R3F's ResizeObserver handles the sized container automatically.
    // No pointer-events-none — OrbitControls drag-to-rotate must stay active.
    <div id="select-agent-canvas" className="w-full h-full">
      <Canvas
        className="w-full h-full"
        camera={{ position: [0, 12, 45], fov: 45 }}
        // WebGL-only: preserveDrawingBuffer enables toDataURL thumbnail capture
        // in create-agent/page.tsx. If this Canvas ever switches to
        // WebGPURenderer, replace thumbnail capture with a RenderTarget +
        // readRenderTargetPixels + OffscreenCanvas encode path —
        // WebGPURenderer discards the back buffer by default and
        // preserveDrawingBuffer is a no-op.
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        scene={{ background: SCENE_BG }}
        onCreated={({ gl }) => {
          // Expose renderer info for debug verification on production.
          // Gated behind ?debug=1 query param — not available to anonymous users.
          if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')) {
            (window as any).__clawSelectRenderer = gl;
          }
          // Dev guard: toDataURL thumbnail silently fails under WebGPURenderer.
          if ((gl as any).isWebGPURenderer) {
            console.warn('[SelectAgentCanvas] running under WebGPURenderer — toDataURL thumbnail will fail. See file header for migration notes.');
          }
          // Fire the onCanvasReady callback so callers get a direct reference
          // to the canvas element without relying on DOM timing.
          if (onCanvasReady && gl.domElement) onCanvasReady(gl.domElement);
        }}
      >
        <SceneContents modelKey={modelKey} color={color} />
      </Canvas>
    </div>
  );
}
