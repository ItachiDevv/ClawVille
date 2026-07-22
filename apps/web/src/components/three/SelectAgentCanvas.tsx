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
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';
import { preloadKTX2Bytes, useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';

import { DEFAULT_AGENT_MODEL_KEY } from '@clawville/shared';
import {
  MODEL_REGISTRY,
  type ModelKey,
  type ModelRegistryEntry,
  type PickerColorId,
} from '@/lib/three/agent-model-registry';
import { useVRMInstance, disposeVRMInstance, retainVRMInstance, preloadVRMBytes } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator, preloadMixamoClips } from '@/lib/three/vrm-character-animator';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';

// Module-scope scene background color — avoids a new THREE.Color allocation on
// every render. R3F only reads the scene.background prop at Canvas creation time.
const SCENE_BG = new THREE.Color(0x030d1a);

// Reused scratch vector for per-frame foot-grounding sampling in PlatformModelVRM.
// Module scope so useFrame never allocates a Vector3 (Iris Xe GC rule).
const _groundTmp = new THREE.Vector3();

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
    // Inverted cone: radiusTop = wide (water-surface), radiusBottom = 0 (tip
    // points down). With cylinder height=70 and position y=65, the tip sits
    // at y=30 — comfortably above the auto-fit avatar's head (top reaches
    // ~y=23.5 = 1.5 feet offset + TARGET_HEIGHT_WU 22). Bumped 2026-05-12
    // from the original y=55 because the bbox auto-fit shortened the
    // avatars enough that the previous tip at y=20 cut THROUGH the avatar's
    // torso, producing a blue beam piercing the character's chest.
    <mesh position={[0, 65, 0]} material={mat}>
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
    // Spawn embers in an ANNULUS around the avatar, not a disc through it.
    // Inner radius 9 keeps every particle clear of the VRM silhouette (which
    // at scale ~15 + a generous girdle margin sits inside r≈6). Outer 18
    // gives the embers room to drift visually without crowding the rune
    // circle (r=10) or escaping the spotlight cone. Previously r=0..8
    // sprayed directly through the avatar's torso/legs and on WebGPU the
    // untextured PointsMaterial renders as opaque orange squares — they
    // looked like floating cubes glued to the character.
    for (let i = 0; i < EMBER_COUNT; i++) {
      const r   = 9 + Math.random() * 9;
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

const PICKER_START_YAW: Record<ModelRegistryEntry['avatar_type'], number> = {
  vrm: Math.PI,
  glb: 0,
};

type ModelAttachedHandler = (
  modelKey: string,
  instance: THREE.Object3D,
  startYaw: number,
) => void;

function RotatingPlatform({ modelKey, color }: { modelKey: string; color: string }) {
  const groupRef = useRef<THREE.Group>(null!);
  const displayedModelRef = useRef<THREE.Object3D | null>(null);
  const displayedModelKeyRef = useRef<string | null>(null);

  const handleModelAttached = React.useCallback<ModelAttachedHandler>((attachedKey, instance, startYaw) => {
    if (displayedModelKeyRef.current === attachedKey && displayedModelRef.current === instance) return;
    displayedModelKeyRef.current = attachedKey;
    displayedModelRef.current = instance;
    if (groupRef.current) groupRef.current.rotation.y = startYaw;
  }, []);

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
      <PlatformModel modelKey={modelKey} color={color} onModelAttached={handleModelAttached} />
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
  onModelAttached,
}: {
  modelKey: string;
  onModelAttached: ModelAttachedHandler;
}) {
  const reg: ModelRegistryEntry = MODEL_REGISTRY[modelKey as ModelKey] ?? MODEL_REGISTRY.milady_official_1;
  // Picker shows one VRM at a time — instanceId 'picker' is stable for the
  // single picker preview. Switching modelKey unmounts the previous instance
  // (different reg.path → different cacheKey → previous useEffect cleanup
  // runs disposeVRMInstance for the old path).
  const vrm = useVRMInstance(reg.path, 'picker');

  React.useEffect(() => {
    retainVRMInstance(reg.path, 'picker'); // cancel deferred dispose on StrictMode re-setup
    return () => disposeVRMInstance(reg.path, 'picker');
  }, [reg.path]);

  React.useEffect(() => {
    if (vrm) onModelAttached(modelKey, vrm.scene, PICKER_START_YAW[reg.avatar_type]);
  }, [vrm, modelKey, onModelAttached, reg.avatar_type]);

  const vrmAnimatorRef = React.useRef<VRMCharacterAnimator | null>(null);
  const groupRef = React.useRef<THREE.Group>(null!);
  // Monotonic foot-grounding lift (world units) and settle-window start time.
  const liftRef = React.useRef(0);
  const groundStartRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!vrm) return;
    // Reset grounding state for the newly loaded VRM (this component re-renders
    // rather than remounts when modelKey changes, so the refs must be cleared).
    liftRef.current = 0;
    groundStartRef.current = null;
    // animatorId from the registry so the picker preview plays the same
    // per-character Mixamo bakes the live game does.
    const animator = new VRMCharacterAnimator(vrm, reg.animatorId);
    vrmAnimatorRef.current = animator;
    animator.init().catch((err) => {
      console.warn('[SelectAgentCanvas VRM] animator init failed:', err);
    });
    return () => {
      vrmAnimatorRef.current = null;
      animator.dispose();
    };
  }, [vrm]);

  // PICKER_TARGET_HEIGHT_WU = 22: at camera distance 45 + FOV 45 the vertical
  // frustum at the avatar plane is ~37wu; 22wu feet-on-disc leaves ~6-7wu of
  // headroom AND footroom even on the tallest portrait viewport.
  //
  // computeVRMAvatarFit resets vrm.scene.scale to 1 before measuring bbox (no
  // contamination from prior state), then returns { scale, offsetY } where
  // offsetY = -box.min.y * scale so the BIND-pose feet land at PLATFORM_TOP_Y.
  // Memoised on [vrm, reg.animatorId]: fires once per VRM load, never per frame.
  const PICKER_TARGET_HEIGHT_WU = 22;
  const PLATFORM_TOP_Y = 0;
  // Target world Y for the lowest foot bone after grounding. Milady's clip keeps
  // its feet at ~+0.06 and reads as grounded, so a small positive target lands
  // every rig cleanly on the disc surface.
  const FOOT_GROUND_TARGET = 0.05;
  // Window over which the monotonic foot-grounding samples the walk cycle's
  // lowest planted foot. Converges within the first frame; the window only
  // captures a deeper dip later in the cycle if one exists.
  const GROUND_SETTLE_SECONDS = 1.5;

  const { scale: computedScale, offsetY } = React.useMemo(
    () => computeVRMAvatarFit(vrm, reg.animatorId, PICKER_TARGET_HEIGHT_WU),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vrm, reg.animatorId],
  );

  // Facing normalization: vrm-loader's rotateVRM0 leaves VRM 0.x rigs (Milady)
  // at scene.rotation.y = pi and VRM 1.x rigs (Hermes/Tekk/chibi) at 0. Counter
  // that baked rotation here so every VRM has the same net yaw before the outer
  // turntable applies PICKER_START_YAW.vrm. Fresh picker screenshots measured
  // 2026-07-21 show normalized net yaw 0 presents the avatar's BACK to the +Z
  // camera, while outer yaw pi presents its FRONT. Keeping normalization
  // declarative (no scene mutation) prevents StrictMode accumulation.
  const facingY = vrm ? -vrm.scene.rotation.y : 0;

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1);
    // idle=false so the walk anim plays: gives a livelier preview on the pedestal
    vrmAnimatorRef.current?.update(dt, false);

    if (!vrm || !groupRef.current) return;

    // Foot-grounding. computeVRMAvatarFit grounds the BIND-pose bbox, but
    // Box3.setFromObject cannot see GPU skinning, so a clip whose stance sits
    // lower than bind (the Hermes walk bake sinks the planted foot ~1.2wu;
    // Milady's clip does not) leaves the rendered feet below the disc. Sample
    // the lowest foot/toe bone (which DOES follow the pose) over a short settle
    // window and monotonically lift the group so that foot rests at
    // FOOT_GROUND_TARGET. Lift-only and monotonic: Milady (already grounded) is
    // untouched and there is no per-frame chase/jitter. _groundTmp is reused so
    // no Vector3 is allocated per frame.
    if (groundStartRef.current === null) groundStartRef.current = state.clock.elapsedTime;
    if (state.clock.elapsedTime - groundStartRef.current < GROUND_SETTLE_SECONDS) {
      let lowestFootY = Infinity;
      vrm.scene.traverse((o) => {
        if ((o as unknown as THREE.Bone).isBone && /(foot|toe)/i.test(o.name)) {
          o.getWorldPosition(_groundTmp);
          if (_groundTmp.y < lowestFootY) lowestFootY = _groundTmp.y;
        }
      });
      if (isFinite(lowestFootY)) {
        // lowestFootY already includes the current lift, so the additional lift
        // needed is (target - measured) and the new total is that plus current.
        const newLift = FOOT_GROUND_TARGET - lowestFootY + liftRef.current;
        if (newLift > liftRef.current) liftRef.current = newLift;
      }
    }
    // Authoritative every frame so a re-render setting the position prop cannot
    // wipe the grounding lift.
    groupRef.current.position.y = PLATFORM_TOP_Y + offsetY + liftRef.current;
  });

  return (
    <group
      ref={groupRef}
      position={[0, PLATFORM_TOP_Y + offsetY, 0]}
      rotation={[0, facingY, 0]}
      scale={[computedScale, computedScale, computedScale]}
    >
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
  onModelAttached,
}: {
  modelKey: string;
  color: string;
  onModelAttached: ModelAttachedHandler;
}) {
  // Cast to ModelKey for index safety; unknown keys fall back to lobster at runtime.
  const reg: ModelRegistryEntry = MODEL_REGISTRY[modelKey as ModelKey] ?? MODEL_REGISTRY[DEFAULT_AGENT_MODEL_KEY];

  const { scene } = useGLTFWithKTX2(reg.path);
  const groupRef     = useRef<THREE.Group>(null!);
  const animGroupRef = useRef<THREE.Group>(null!);

  useEffect(() => {
    onModelAttached(modelKey, scene, PICKER_START_YAW[reg.avatar_type]);
  }, [scene, modelKey, onModelAttached, reg.avatar_type]);

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
          // Do NOT dispose tinted materials — applyColorTint() now uses a
          // module-scope shared cache keyed on (baseMat.uuid|tintHex|lerpFactor|
          // emissiveIntensity). The cached instances are intentionally long-lived
          // so subsequent components with the same (species, tint) combo can reuse
          // the same GPU pipeline without re-upload. Disposing here would corrupt
          // the cache and break all other users of the shared material.
          //
          // NEVER dispose geometry: scene.clone(true) shares BufferGeometry with
          // the useGLTF cache (Mesh.copy: this.geometry = source.geometry). If
          // we disposed it, the cache would hand out a disposed buffer on the
          // next load of this modelKey. Leave geometry cleanup to useGLTF's
          // internal lifecycle or an explicit page-level useEffect(clear, [])
          // if full cleanup is ever needed.
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
  onModelAttached,
}: {
  modelKey: string;
  color: string;
  onModelAttached: ModelAttachedHandler;
}) {
  const reg: ModelRegistryEntry = MODEL_REGISTRY[modelKey as ModelKey] ?? MODEL_REGISTRY[DEFAULT_AGENT_MODEL_KEY];

  useEffect(() => {
    if (!MODEL_REGISTRY[modelKey as ModelKey]) {
      console.warn(`[SelectAgentCanvas] unknown modelKey "${modelKey}", falling back to lobster`);
    }
  }, [modelKey]);

  if (reg.avatar_type === 'vrm') {
    return (
      <Suspense fallback={null}>
        <PlatformModelVRM modelKey={modelKey} onModelAttached={onModelAttached} />
      </Suspense>
    );
  }

  return (
    <PlatformModelGLB
      modelKey={modelKey}
      color={color}
      onModelAttached={onModelAttached}
    />
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
  const reg = MODEL_REGISTRY[modelKey as ModelKey] ?? MODEL_REGISTRY[DEFAULT_AGENT_MODEL_KEY];
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
      {/* minDistance=40 for VRM prevents OrbitControls zoom-in from cropping
          the avatar's head on portrait viewports. At dist=40, FOV=45°,
          vertical coverage ≈ 33wu which cleanly fits the 1.6×-scaled avatar
          (~20.8wu tall + feet at 1.5wu) with room to spare. target y=11 lands
          between the character's waist (y≈11) and chest (y≈15), centering the
          silhouette so the head + feet are both visible on any aspect ratio. */}
      <OrbitControls
        makeDefault
        enablePan={false}
        enableZoom={true}
        minDistance={isVRM ? 40 : 25}
        maxDistance={isVRM ? 85 : 80}
        minPolarAngle={Math.PI * (isVRM ? 0.32 : 0.28)}
        maxPolarAngle={Math.PI * (isVRM ? 0.52 : 0.55)}
        target={isVRM ? [0, 11, 0] : [0, 8, 0]}
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
          instance NodeMaterial.vertexShader crash.
          EmberParticles removed 2026-05-12 — PointsMaterial without a sprite
          texture renders as opaque orange squares ("orange cubes") that
          dominate the frame and obscure the avatar. Will re-add as soft
          textured sprites in a follow-up if needed. */}
      <SpotlightConeSelect />

      {/* Rotating platform with model */}
      <Suspense fallback={null}>
        <RotatingPlatform modelKey={modelKey} color={color} />
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
  modelKey = DEFAULT_AGENT_MODEL_KEY,
  color = 'green',  // matches PICKER_COLORS default
  onCanvasReady,
}: SelectAgentCanvasProps) {
  // Preload all models in the background after first commit.
  // GLB models use useGLTF.preload; VRM models warm the byte cache via
  // preloadVRMBytes (per-instance parse happens at mount time).
  // Also preload Mixamo animation clips for VRM animators.
  useEffect(() => {
    preloadMixamoClips();
    Object.values(MODEL_REGISTRY).forEach((m: ModelRegistryEntry) => {
      if (m.avatar_type === 'vrm') {
        preloadVRMBytes(m.path);
      } else {
        if (m.path.includes('-ktx.glb')) preloadKTX2Bytes(m.path);
        else useGLTF.preload(m.path);
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
        camera={{ position: [0, 13, 45], fov: 45 }}
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
        <KTX2LoaderSetup />
        <SceneContents modelKey={modelKey} color={color} />
      </Canvas>
    </div>
  );
}
