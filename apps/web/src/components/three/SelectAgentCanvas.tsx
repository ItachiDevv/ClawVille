'use client';

/**
 * SelectAgentCanvas — 3D character preview for the Agent Setup screen.
 *
 * Renders a rotating platform with the selected agent's GLB model,
 * underwater atmosphere effects, and dramatic lighting.
 *
 * GPU constraints: no InstancedMesh, no drei Text/Billboard, TSL only.
 */

import React, { useRef, memo, Suspense, useEffect } from 'react';
import { Canvas, useFrame, extend } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import type { ThreeToJSXElements } from '@react-three/fiber';

// Register Three.js WebGPU elements
declare module '@react-three/fiber' {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}
// R3F v9's extend() expects Catalogue (Record<string, Constructor>) or a ConstructorRepresentation.
// We pass the WebGPU THREE module which contains mixed types — `any` is the pragmatic escape.
// A narrower cast (Record<string, unknown>) loses the constructor signature and fails typecheck.
extend(THREE as any);

import UnderwaterAtmosphere from '@/lib/three/underwater-atmosphere';
import UnderwaterLightRays from '@/lib/three/underwater-light-rays';
import { float, vec3, sin, time, uv, smoothstep, fract, positionLocal } from 'three/tsl';
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
// RuneCircle — flat disc on the pedestal top with TSL radial rune gradient
// 1 draw call. AdditiveBlending so it glows without obscuring the pedestal.
// ---------------------------------------------------------------------------
function RuneCircle() {
  const mat = React.useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    // uv() gives 0..1 in both axes. Convert to polar radius 0..1 from center.
    const u = uv().x.sub(float(0.5));
    const v = uv().y.sub(float(0.5));
    const radius = u.mul(u).add(v.mul(v)).sqrt(); // 0 at center, ~0.707 at corner

    // Two concentric rings: inner ring at r≈0.25, outer ring at r≈0.45
    const ring1 = smoothstep(float(0.20), float(0.25), radius)
      .sub(smoothstep(float(0.25), float(0.30), radius));
    const ring2 = smoothstep(float(0.40), float(0.45), radius)
      .sub(smoothstep(float(0.45), float(0.50), radius));

    // Rotating "rune" texture faked via angular sin waves
    const angle = u.atan2(v); // -PI..PI
    const runeWave = sin(angle.mul(float(8.0)).add(time.mul(float(0.8))))
      .mul(float(0.5)).add(float(0.5));

    const combined = ring1.add(ring2.mul(runeWave)).mul(float(1.0));

    const pulse = sin(time.mul(float(1.5))).mul(float(0.3)).add(float(0.7));
    m.colorNode = vec3(float(0.0), float(0.8), float(1.0)).mul(combined).mul(pulse);
    m.opacity = 0.75;
    return m;
  }, []);

  return (
    <mesh position={[0, 0.2, 0]} rotation={[-Math.PI / 2, 0, 0]} material={mat}>
      <planeGeometry args={[22, 22, 1, 1]} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// SpotlightConeSelect — fake spotlight shining DOWN from above the model.
// Open CylinderGeometry (radiusBottom=0, inverted) with TSL additive falloff.
// No actual SpotLight — the scene light budget is already at 3/3.
// 1 draw call.
// ---------------------------------------------------------------------------
function SpotlightConeSelect() {
  const mat = React.useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    });

    // uv().y goes 0→1 from narrow end (top) to wide end (bottom).
    // Fade from bright at bottom (near model) to transparent at top.
    const fade = smoothstep(float(0.0), float(0.5), uv().y);
    const pulse = sin(time.mul(float(0.9))).mul(float(0.15)).add(float(0.85));

    m.colorNode = vec3(float(0.2), float(0.7), float(1.0))
      .mul(float(0.35))
      .mul(fade)
      .mul(pulse);
    m.opacity = 0.5;
    return m;
  }, []);

  return (
    // Inverted cone: radiusTop = wide (at water-surface level), radiusBottom = 0 (tip points down at model)
    // Position so the tip is near y=15 (above the model), open end at y=80
    <mesh position={[0, 55, 0]} material={mat}>
      <cylinderGeometry args={[20, 0, 70, 24, 1, true]} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// EmberParticles — 80 upward-drifting ember points.
// Uses a PointsNodeMaterial with TSL positionNode animation.
// 1 draw call for all 80 particles.
// ---------------------------------------------------------------------------
const EMBER_COUNT = 80;

function EmberParticles() {
  // Build a small Float32Array of random seed offsets — done ONCE
  const { positions, seeds } = React.useMemo(() => {
    const pos  = new Float32Array(EMBER_COUNT * 3);
    const seed = new Float32Array(EMBER_COUNT);
    for (let i = 0; i < EMBER_COUNT; i++) {
      // Random start in cylinder: radius 0..8, height 0..30
      const r   = Math.random() * 8;
      const ang = Math.random() * Math.PI * 2;
      pos[i * 3 + 0] = Math.cos(ang) * r;
      pos[i * 3 + 1] = Math.random() * 30;
      pos[i * 3 + 2] = Math.sin(ang) * r;
      seed[i] = Math.random() * 100; // per-particle random offset
    }
    return { positions: pos, seeds: seed };
  }, []);

  const geo = React.useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aSeed',    new THREE.BufferAttribute(seeds,     1));
    return g;
  }, [positions, seeds]);

  const mat = React.useMemo(() => {
    const m = new THREE.PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    // Per-particle vertical drift via positionLocal.y phase
    const drift = fract(positionLocal.y.div(float(30.0)).add(time.mul(float(0.18))));
    const height = drift.mul(float(30.0));

    // Override Y position to loop upward
    const animPos = positionLocal.add(
      vec3(float(0.0), height.sub(positionLocal.y), float(0.0))
    );
    m.positionNode = animPos;

    // Glow: cyan→orange ember colors, fade out at top (drift near 1.0)
    const fadeOut = smoothstep(float(0.8), float(1.0), drift).oneMinus();
    const emberColor = vec3(float(1.0), float(0.45), float(0.1));
    m.colorNode   = emberColor.mul(fadeOut);
    m.opacityNode = fadeOut.mul(float(0.8));
    m.sizeNode    = float(3.5);

    return m;
  }, []);

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
// GLB Model on Platform
// ---------------------------------------------------------------------------

const PlatformModel = memo(function PlatformModel({
  modelKey,
  color,
}: {
  modelKey: string;
  color: string;
}) {
  // Cast to ModelKey for index safety; unknown keys fall back to lobster at runtime.
  const reg: ModelRegistryEntry = MODEL_REGISTRY[modelKey as ModelKey] ?? MODEL_REGISTRY.lobster;

  useEffect(() => {
    if (!MODEL_REGISTRY[modelKey as ModelKey]) {
      console.warn(`[SelectAgentCanvas] unknown modelKey "${modelKey}", falling back to lobster`);
    }
  }, [modelKey]);
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
// Scene Contents
// ---------------------------------------------------------------------------

const SceneContents = memo(function SceneContents({
  modelKey,
  color,
}: {
  modelKey: string;
  color: string;
}) {
  return (
    <>
      {/* Camera controls — pulled back to fit the full ~20-unit-tall model
          inside the 220px framed panel.
          Math: fov=45° vertical, model height=20wu, target 50-60% of panel
          → distance = 10/tan(11.25°) ≈ 50wu → use 45 for mild safety margin.
          Target Y=8 gives head-centric framing (model spans y≈1.5 to y≈21.5).
          OrbitControls drag-to-rotate is intentionally enabled. */}
      <OrbitControls
        makeDefault
        enablePan={false}
        enableZoom={true}
        minDistance={25}
        maxDistance={80}
        minPolarAngle={Math.PI * 0.28}
        maxPolarAngle={Math.PI * 0.55}
        target={[0, 8, 0]}
      />

      {/* Dramatic underwater lighting */}
      <directionalLight position={[10, 40, 20]} intensity={1.2} color={0xfff5e0} />
      <pointLight position={[0, -5, 10]} color={0x00aaff} intensity={0.8} distance={60} />
      <ambientLight color={0x05152b} intensity={0.4} />

      {/* Underwater fog — tuned for distance ~45 camera.
          Near=30 keeps the model (at distance ~45) crystal clear.
          Far=120 fades the atmosphere backdrop well beyond the camera. */}
      <fog attach="fog" args={[0x030d1a, 30, 120]} />

      {/* Atmosphere effects */}
      <UnderwaterAtmosphere />
      <UnderwaterLightRays />

      {/* Ember particles — 80 upward-drifting points (1 draw call, TSL GPU animation) */}
      <EmberParticles />

      {/* Fake spotlight cone from above (no SpotLight — light budget full) */}
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
  // Preload the 10 non-initial models in the background. The initial model
  // (the one picked for the first render) already gets loaded via useGLTF()
  // inside <PlatformModel>. This useEffect runs after the first commit, so
  // the first-render model still suspends on cold load — only tab-switches
  // to OTHER models benefit from this warm cache.
  // Moved from module level to avoid pulling 3.5 MB of GLBs into any
  // bundle that merely imports from this file.
  useEffect(() => {
    Object.values(MODEL_REGISTRY).forEach((m: ModelRegistryEntry) => useGLTF.preload(m.path));
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
