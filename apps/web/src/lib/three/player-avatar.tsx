'use client';

import { useRef, useMemo, useEffect, Suspense } from 'react';
import { useThree } from '@react-three/fiber';
import { preloadKTX2Bytes, useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';
import * as THREE from 'three';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
} from '@/lib/pixi/tilemap-data';
import {
  didCrossKelpForestPortal,
  findNearestCharacter,
  isCoveProximate,
  isKelpForestPortalProximate,
} from '@/lib/three/character-positions';
import { NORI_WORLD_X, NORI_WORLD_Z, NORI_TALK_RADIUS_SQ } from '@/lib/three/town-guide';
import { applyWalkAnimation, applyIdleAnimation } from '@/lib/three/procedural-animation';
import { LobsterAnimator } from '@/lib/three/lobster-animations';
import { discoverLobsterParts } from '@/lib/three/lobster-parts';
import {
  MODEL_REGISTRY,
  type ModelRegistryEntry,
} from '@/lib/three/agent-model-registry';
import {
  createCharacterAnimator,
  applyColorTint,
  type CharacterAnimator,
} from '@/lib/three/character-animations';
import { jumpState } from '@/lib/three/jump-state';
import { triggerCoveWalkIn } from './arena-buildings';
import {
  resetKelpForestWalkInLatch,
  triggerKelpForestWalkIn,
} from './kelp-forest-transition';
import { useVRMInstance, disposeVRMInstance, retainVRMInstance, applyFattenedFrustumCulling } from '@/lib/three/vrm-loader';
import {
  VRMCharacterAnimator,
  preloadMixamoClips,
  isEmoteAnimName,
  type AnimName,
} from '@/lib/three/vrm-character-animator';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { getTerrainHeightAt, isTerrainHeightfieldReady } from '@/lib/three/terrain-heightfield';
import { CosmeticLoader } from '@/lib/three/cosmetic-loader';
import { subscribeEmote } from '@/lib/three/emote-bus';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import {
  clampMovement2D,
  ENTITY_HALF_CHIBI,
} from '@/lib/three/collision/world-colliders';
import { DEFAULT_PLAYER_CAPABILITIES } from '@/lib/three/player/player-capability-mask';
import {
  usePlayerCapabilityController,
  type PlayerControllerFrameState,
} from '@/lib/three/player/player-capability-controller';
import {
  WORLD_GLB_POLICY,
  WORLD_VRM_POLICY,
  type PlayerInputPolicy,
  type PlayerMotionPolicy,
} from '@/lib/three/player/player-motion-policy';
import type { PlayerFrameIntent } from '@/lib/three/player/player-intent';

// ---------------------------------------------------------------------------
// GLB-based player avatar — lobster-ktx.glb model = 1-2 draw calls
// Original had 46 meshes built from primitives
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const SPEED = 550;
const BOB_SPEED = 5;
const BOB_AMPLITUDE = 0.3;
// AVATAR_SCALE=40 targets ~45 world-unit height for lobster-ktx.glb on the 5120-unit map.
// lobster-ktx.glb geometry has bbox max.y = 1.12 native units (verified 2026-04-17 via GLTF
// accessor bounds). AVATAR_SCALE=40 → 40 × 1.12 = 44.8 wu ≈ TARGET_NPC_HEIGHT=45.
// Bug history: AVATAR_SCALE was at 20 (from pass 2 of scale-down 2026-04-16), which was
// calibrated when the lobster GLB had native height ~2.4 units (20 × 2.4 = 48 wu).
// After the GLB was updated the native height became 1.12 units; 20 × 1.12 = 22.4 wu —
// making the player avatar appear ~2× smaller than wandering NPC lobsters (which use
// computeNpcScale → TARGET_NPC_HEIGHT=45 → scale≈40.2 → 45 wu visual height).
// Fix 2026-04-17: AVATAR_SCALE 20→40. ~1:17.8 ratio vs 800-wu building.
// SPEED bumped 320→550 (pass 1 +60% wasn't perceivable at world scale of 5120 wu;
// need ~3-4s to cross visible area ~2000 wu → 2000/550 ≈ 3.6s).
const AVATAR_SCALE = 40;

/**
 * Sprint speed multiplier. Pressed SHIFT (desktop) or joystick deflection
 * past `RUN_JOYSTICK_THRESHOLD` (mobile) promotes the player from walk to
 * run — `effectiveSpeed = isRunning ? SPEED * RUN_SPEED_MULT : SPEED`.
 *
 * 1.5× matches the Mixamo "Running" clip's natural gait speed relative
 * to "Walking"; foot-skating is minimal at this ratio. Crustacean GLB
 * avatars (no run clip) get this same multiplier on BOTH position step
 * and the procedural-animation rate so their walk cycle visibly speeds
 * up to match the faster ground motion.
 */

/**
 * Joystick magnitude threshold for the mobile sprint trigger. Push the
 * stick beyond 70 % deflection and the player promotes to run; below
 * that, they walk. Sharp threshold (no hysteresis yet) — acceptable
 * because the joystick visual is far from the center at this point so
 * the snap is intentional.
 */

// Player-controlled VRM sizing is auto-fit via computeVRMAvatarFit() from
// vrm-avatar-sizing.ts — same target height as wandering NPCs so the player
// Hermes / Milady / future humanoid all stand at VRM_AVATAR_TARGET_HEIGHT_WU
// (~179 wu) regardless of native bbox unit convention. Previously a flat
// AVATAR_VRM_SCALE=112 hardcoded Milady's 1.6m bbox, which left Hermes (Mixamo
// cm units) at the wrong on-screen height. Do NOT use reg.scale (=13, picker-only).

const COLOR_TINTS: Record<string, number> = {
  blue: 0x42a5f5, red: 0xef5350, green: 0x66bb6a, yellow: 0xffee58,
  purple: 0xab47bc, orange: 0xffa726, pink: 0xf48fb1, white: 0xeeeeee,
  black: 0x424242, brown: 0x8d6e63,
};

// Lobster GLB faces +Z natively (rotation.y=0 → head toward +Z). EMPIRICALLY VERIFIED 2026-04-16 (late PM, clean side-view screenshot).
// Prior session concluded +X — that was WRONG (camera was orbited, misread as side-view).
// To face world direction (worldVx, worldVz): θ = atan2(worldVx, worldVz)  (no negations)
// DIR_ROTATION for cardinal directions (screen-relative pixel-space vx/vy):
//   down  vx=0,  vy=+1 → 0        (+Z = native forward = screen-down)
//   up    vx=0,  vy=-1 → PI       (-Z = screen-up)
//   right vx=+1, vy=0  → PI/2     (+X = screen-right)
//   left  vx=-1, vy=0  → -PI/2    (-X = screen-left)
//   idle: 0 (faces +Z = toward default camera at positive +Z high angle position)

// VRM avatars face -Z natively (VRM 1.0 spec; VRM 0.x normalised to -Z by rotateVRM0).
// For a -Z-forward model: to face direction (vx, vy) in screen space:
//   θ = atan2(vx, -vy)
// Cardinal direction rotations:
//   down  vx=0,  vy=+1 → atan2(0, -1) = PI
//   up    vx=0,  vy=-1 → atan2(0,  1) = 0
//   right vx=+1, vy=0  → atan2(1,  0) = PI/2
//   left  vx=-1, vy=0  → atan2(-1, 0) = -PI/2
// Preload
preloadKTX2Bytes('/models/lobster-ktx.glb?v=2');

// Scratch objects for computeLocalMinY — module-scope to avoid GC in useMemo.
const _avatarBbox = new THREE.Box3();
const _avatarMeshBbox = new THREE.Box3();

/** Measure local-space bbox min.y for non-SkinnedMesh geometry in a cloned GLB scene.
 *  Returns 0 if no geometry found.
 *  See arena-npcs.tsx computeLocalMinY for full rationale. */
function computeLocalMinY(scene: THREE.Object3D): number {
  scene.updateMatrixWorld(true);
  _avatarBbox.makeEmpty();

  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      _avatarMeshBbox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _avatarBbox.union(_avatarMeshBbox);
    }
  });

  if (_avatarBbox.isEmpty()) {
    _avatarBbox.setFromObject(scene);
  }

  return _avatarBbox.isEmpty() ? 0 : _avatarBbox.min.y;
}

// PERF FIX (2026-06-15, prod-trace-confirmed ~57% JS CPU):
// The old raycast (intersectObject(cachedMesh, false)) still ran O(28,800
// triangles) per call. Replaced by O(1) bilinear heightfield lookup.
// The heightfield is built once in createSandGeometry() in arena-terrain.tsx
// from the actual displaced vertex positions — same data the raycast hit.

/** O(1) terrain height lookup — bilinear interpolation into pre-built heightfield.
 *  Falls back to -2 (flat floor) if the heightfield is not yet initialised. */
function getTerrainY(x: number, z: number, _scene: THREE.Scene): number {
  if (!isTerrainHeightfieldReady()) return -2;
  return getTerrainHeightAt(x, z);
}

interface WorldControllerRefs {
  readonly walkableY: { current: number };
  readonly portalPrevX: { current: number };
  readonly portalPrevZ: { current: number };
  readonly portalInitialized: { current: boolean };
}

function useWorldPlayerController({
  motion,
  input,
  refs,
  onAfterMove,
}: {
  motion: PlayerMotionPolicy;
  input: PlayerInputPolicy;
  refs: WorldControllerRefs;
  onAfterMove: (
    frame: PlayerControllerFrameState,
    rawDelta: number,
    elapsed: number,
  ) => void;
}): void {
  const space = useMemo(() => ({
    speedPerSec: SPEED,
    readPosition(out: { x: number; z: number }) {
      out.x = avatarPositionRef.x - HALF_W;
      out.z = avatarPositionRef.y - HALF_H;
    },
    clampMovement(
      prevX: number,
      prevZ: number,
      desiredX: number,
      desiredZ: number,
      out: { x: number; z: number; groundY: number },
    ) {
      const boundedX = Math.max(
        16 - HALF_W,
        Math.min(MAP_WIDTH - 16 - HALF_W, desiredX),
      );
      const boundedZ = Math.max(
        16 - HALF_H,
        Math.min(MAP_HEIGHT - 16 - HALF_H, desiredZ),
      );
      const clamped = clampMovement2D(
        prevX,
        prevZ,
        boundedX,
        boundedZ,
        ENTITY_HALF_CHIBI,
      );
      out.x = clamped.x;
      out.z = clamped.z;
      out.groundY = clamped.groundY;
      refs.walkableY.current = clamped.groundY;
    },
    commitPosition(result: { x: number; z: number }) {
      useGameStore.getState().setAvatarPosition(
        result.x + HALF_W,
        result.z + HALF_H,
      );
    },
  }), [refs.walkableY]);

  usePlayerCapabilityController({
    sceneId: 'world',
    capabilities: DEFAULT_PLAYER_CAPABILITIES,
    motion,
    input,
    space,
    isFrozen: () => useGameStore.getState().movementFrozen,
    isDriving: () => useGameStore.getState().controlMode === 'player',
    isEscapeEdgeEnabled: () =>
      useGameStore.getState().controlMode !== 'autonomous',
    isInteractEdgeEnabled: () =>
      useGameStore.getState().controlMode !== 'autonomous',
    onFrameStart: ({ x, z }) => {
      const store = useGameStore.getState();
      const ownsPortalMovement =
        store.controlMode === 'player' ||
        store.controlMode === 'autonomous';
      if (ownsPortalMovement && refs.portalInitialized.current) {
        refs.portalPrevX.current = x;
        refs.portalPrevZ.current = z;
      } else if (!ownsPortalMovement) {
        refs.portalInitialized.current = false;
      }
    },
    onEscapeWhileFrozen: () => {
      const store = useGameStore.getState();
      if (store.chatOpen) store.exitBuilding();
      else if (store.guideChatOpen) store.closeGuideChat();
    },
    onInteractEdge: () => {
      const store = useGameStore.getState();
      if (store.nearGuide && !store.guideChatOpen && !store.chatOpen) {
        store.openGuideChat();
        return { consumeFrame: true };
      }
      if (store.nearLocation) {
        if (store.nearLocation === 'cove') triggerCoveWalkIn();
        else if (store.nearLocation === 'kelp-forest-portal') {
          triggerKelpForestWalkIn();
        } else {
          store.enterBuilding(store.nearLocation);
        }
        return { consumeFrame: true };
      }
    },
    onNavigationOverride: (intent: PlayerFrameIntent) => {
      const store = useGameStore.getState();
      if (intent.move.moving && store.clickPath) {
        store.clearClickPath();
        return;
      }
      if (!intent.move.moving && store.clickPath && store.clickPath.length > 0) {
        const waypoint = store.clickPath[store.clickPathIndex];
        if (!waypoint) return;
        const dx = waypoint.x - avatarPositionRef.x;
        const dz = waypoint.y - avatarPositionRef.y;
        const distance = Math.hypot(dx, dz);
        if (distance < 6) {
          if (store.clickPathIndex >= store.clickPath.length - 1) {
            const target = store.clickPathTarget;
            store.clearClickPath();
            if (target === 'cove') {
              triggerCoveWalkIn();
              return { consumeFrame: true };
            }
            if (target === 'kelp-forest-portal') {
              triggerKelpForestWalkIn();
              return { consumeFrame: true };
            }
            if (target && store.nearLocation === target) {
              store.enterBuilding(target);
              return { consumeFrame: true };
            }
          } else {
            store.advanceClickPath();
          }
          return;
        }
        return {
          moveOverride: {
            worldVx: dx / distance,
            worldVz: dz / distance,
          },
        };
      }
    },
    onDirection: (direction) => {
      useGameStore.getState().setMovementDirection(direction);
    },
    onAfterMove: (frame, rawDelta, elapsed) => {
      const store = useGameStore.getState();
      const ownsPortalMovement =
        store.controlMode === 'player' ||
        store.controlMode === 'autonomous';
      if (ownsPortalMovement) {
        if (!refs.portalInitialized.current) {
          refs.portalPrevX.current = frame.x;
          refs.portalPrevZ.current = frame.z;
          refs.portalInitialized.current = true;
        } else {
          if (
            didCrossKelpForestPortal(
              refs.portalPrevX.current,
              refs.portalPrevZ.current,
              frame.x,
              frame.z,
            )
          ) {
            triggerKelpForestWalkIn();
          }
          refs.portalPrevX.current = frame.x;
          refs.portalPrevZ.current = frame.z;
        }
      }

      const nearest = findNearestCharacter(frame.x, frame.z);
      const nearId: string | null = nearest
        ? nearest.buildingId
        : isCoveProximate(frame.x, frame.z)
          ? 'cove'
          : isKelpForestPortalProximate(frame.x, frame.z)
            ? 'kelp-forest-portal'
            : null;
      const nearName = nearest ? nearest.characterName : null;
      if (nearId !== store.nearLocation) store.setNearLocation(nearId);
      if (nearName !== store.nearCharacter) store.setNearCharacter(nearName);
      const guideX = frame.x - NORI_WORLD_X;
      const guideZ = frame.z - NORI_WORLD_Z;
      const noriNear =
        guideX * guideX + guideZ * guideZ < NORI_TALK_RADIUS_SQ;
      if (noriNear !== store.nearGuide) store.setNearGuide(noriNear);

      onAfterMove(frame, rawDelta, elapsed);
    },
  });
}

// ---------------------------------------------------------------------------
// VRM player avatar — uses useVRM + VRMCharacterAnimator
// Separated into its own inner component so Suspense handles VRM load
// independently from the GLB path.
// VRM feet are at Y=0 per spec — no pivot offset needed.
// ---------------------------------------------------------------------------

function PlayerAvatarVRMInner({ reg }: { reg: ModelRegistryEntry }) {
  const groupRef = useRef<THREE.Group>(null);
  const kelpPortalPrevXRef = useRef(0);
  const kelpPortalPrevZRef = useRef(0);
  const kelpPortalPrevInitializedRef = useRef(false);
  /**
   * Pitch (X-axis rotation, radians) for the avatar — drives the
   * "swimming upward" tilt while ascending. Lerped each frame toward
   * a per-phase target in useFrame. Order on group.rotation is set to
   * 'YXZ' so this pitch is applied AFTER facing (rotRef → .y) in the
   * avatar's local frame, i.e. tilting "back" always means leaning
   * head-toward-up regardless of which way they're facing.
   */
  const pitchRef = useRef(0);
  const terrainYRef = useRef(-2);
  // walkableYRef: current walkable-surface Y from collision system.
  // Updated each frame from clamped.groundY. When -2, falls back to terrain.
  // Allows stair/ramp zones (e.g. shisha-oasis) to lift the avatar's Y
  // without blocking XZ movement. Lerped via terrainYRef blend coefficient.
  const walkableYRef = useRef(-2);
  const { scene: threeScene } = useThree();

  // Load a fresh VRM instance for the player. Stable instanceId 'player-avatar'
  // since only one player avatar ever exists at a time. Per-instance loading
  // means the player's VRM is fully disjoint from any wandering NPC sharing
  // the same path — no scene reparenting wars (Codex Critical #1).
  const vrm = useVRMInstance(reg.path, 'player-avatar');

  // Auto-fit scale + foot-grounding offset. Recomputed when the VRM swaps
  // (model picker change → new path → new instance → useMemo re-runs).
  // Cm-authored Mixamo VRMs land at the same on-screen height as m-authored
  // Milady VRMs because we measure the native bbox per-VRM.
  const { scale: vrmRenderScale, offsetY: vrmFootOffsetY } = useMemo(
    () => computeVRMAvatarFit(vrm, reg.animatorId),
    [vrm, reg.animatorId],
  );

  // Dispose this player-avatar's instance when the avatar path changes or unmounts.
  useEffect(() => {
    retainVRMInstance(reg.path, 'player-avatar'); // cancel deferred dispose on StrictMode re-setup
    return () => disposeVRMInstance(reg.path, 'player-avatar');
  }, [reg.path]);

  // VRM animator — created once per VRM instance
  const vrmAnimatorRef = useRef<VRMCharacterAnimator | null>(null);
  /**
   * Most recently applied `surfaceClip` for this avatar. The useFrame
   * below computes the desired clip every frame (idle / jump / swim /
   * fly) from jumpState.phase + airborne; we only call
   * animator.setSurfaceClip when the desired value CHANGES so the lazy
   * GLB load + crossfade only fire on state transitions, not 60 ×/s.
   * Defaults to 'idle' — the surfaceClip the animator initialises to.
   */
  const lastSurfaceClipRef = useRef<AnimName>('idle');

  /**
   * Tracks whether we were in 'charging' last frame — used to detect the
   * rising edge of charging so chargeMode is set exactly once per charge press
   * (at the frame charging begins, when isRunning reflects the real speed class).
   */

  useEffect(() => {
    if (!vrm) return;
    // animatorId routes per-character Mixamo overrides. Sourced from the
    // model registry so all Milady VRMs share 'vrm-milady', Hermes/Tekk
    // use their own slugs, and GLB entries (no Mixamo path) pass undefined.
    const animator = new VRMCharacterAnimator(vrm, reg.animatorId);
    vrmAnimatorRef.current = animator;
    animator.init().catch((err) => {
      console.warn('[PlayerAvatar VRM] animator init failed:', err);
    });

    // Subscribe to the emote bus so the cosmetic-drawer / hotbar's
    // `fireEmote('flip')` calls drive the player's avatar.
    const unsub = subscribeEmote((animationKey) => {
      if (!isEmoteAnimName(animationKey)) {
        console.warn(`[PlayerAvatar VRM] unknown emote animation key: ${animationKey}`);
        return;
      }
      void animator.playOneShot(animationKey as AnimName);
    });

    return () => {
      unsub();
      vrmAnimatorRef.current = null;
      animator.dispose();
    };
  }, [vrm]);

  useWorldPlayerController({
    motion: WORLD_VRM_POLICY.motion,
    input: WORLD_VRM_POLICY.input,
    refs: {
      walkableY: walkableYRef,
      portalPrevX: kelpPortalPrevXRef,
      portalPrevZ: kelpPortalPrevZRef,
      portalInitialized: kelpPortalPrevInitializedRef,
    },
    onAfterMove: (frame, rawDelta, elapsed) => {
      const group = groupRef.current;
      if (!group) return;
      group.position.x = frame.x;
      group.position.z = frame.z;

      const frameNumber = Math.floor(elapsed * 60);
      if (frameNumber % 3 === 0) {
        const terrainY = getTerrainY(frame.x, frame.z, threeScene);
        terrainYRef.current += (terrainY - terrainYRef.current) * 0.6;
      }
      const bob = frame.renderAirborne
        ? 0
        : frame.moving
          ? 0
          : Math.sin(elapsed * 2) * 0.08;
      const effectiveFloorY = Math.max(
        terrainYRef.current,
        walkableYRef.current,
      );
      group.position.y = effectiveFloorY + bob + frame.jumpHeight;

      const ascending =
        jumpState.phase === 'launch' || jumpState.phase === 'quick';
      const pitchTarget = ascending ? -Math.PI / 3 : 0;
      pitchRef.current += (pitchTarget - pitchRef.current) * 0.15;
      group.rotation.order = 'YXZ';
      group.rotation.y = frame.facing;
      group.rotation.x = pitchRef.current;

      const animator = vrmAnimatorRef.current;
      if (!animator) return;
      const phaseCharging = jumpState.phase === 'charging';
      const isSquatCharge =
        phaseCharging && jumpState.chargeMode === 'squat';
      const isRunCharge =
        phaseCharging && jumpState.chargeMode === 'run';
      const swimClip = reg.animatorId === 'tekk' ? 'flying' : 'swimming';
      const desiredClip = isRunCharge
        ? 'idle'
        : frame.renderAirborne
          ? swimClip
          : 'idle';
      if (desiredClip !== lastSurfaceClipRef.current) {
        animator.setSurfaceClip(desiredClip);
        lastSurfaceClipRef.current = desiredClip;
      }
      const lockIdle = isSquatCharge || frame.renderAirborne;
      animator.update(
        Math.min(rawDelta, 0.1),
        lockIdle ? false : frame.moving,
        lockIdle ? false : frame.running,
      );
    },
  });

  return (
    <group ref={groupRef}>
      {/* Auto-fit scale + foot-ground offset: Milady (1.6m, feet at Y=0)
          → scale ~112, offsetY ~0. Hermes/Tekk (Mixamo cm, hips at Y=0)
          → scale ~0.93, offsetY ~+87. Matches arena-npcs VRMNpcMesh. */}
      <primitive
        object={vrm.scene}
        scale={[vrmRenderScale, vrmRenderScale, vrmRenderScale]}
        position={[0, vrmFootOffsetY, 0]}
      />
      {/*
        Equipped cosmetics (hats / glasses / aura / particles) for the player VRM.
        rigType='universal' — the loader prefers 'universal' variants, then falls
        back to an exact rig match. This works for all humanoid VRMs (Milady,
        Hermes, Tekk, Phanes, chibi) without needing per-rig variant rows in the DB.
        vrm + vrmRenderScale enable computeCosmeticHeadFit for proportion-aware,
        axis-sign-safe hat/glasses placement (Phase B). avatarId='self' because the
        API resolves the caller avatar from the session cookie — prop is
        forward-compat for future per-NPC cosmetic rendering.
      */}
      <CosmeticLoader
        avatarId="self"
        rigType="universal"
        context="world"
        parentObject={vrm.scene}
        vrm={vrm}
        vrmRenderScale={vrmRenderScale}
      />
    </group>
  );
}

function PlayerAvatarGLBInner() {
  const groupRef = useRef<THREE.Group>(null);
  const animGroupRef = useRef<THREE.Group>(null);
  const kelpPortalPrevXRef = useRef(0);
  const kelpPortalPrevZRef = useRef(0);
  const kelpPortalPrevInitializedRef = useRef(false);
  const terrainYRef = useRef(-2); // -2 matches sand floor Y so avatar spawns flush with terrain
  // walkableYRef: tracks the walkable-surface Y returned by clampMovement2D.
  // When the GLB avatar enters a walkable collider zone (e.g. shisha-oasis stairs),
  // this ref rises to the stair topY and the avatar's Y follows.
  const walkableYRef = useRef(-2);
  const { scene: threeScene } = useThree();

  // Phase 2: resolve which GLB to load from the model registry.
  // avatarModelKey is set by game/page.tsx via setAvatarAppearance when the avatar
  // loads from the API. Falls back to 'lobster' if null / unknown key.
  const avatarModelKey = useGameStore((s) => s.avatarModelKey);
  const reg: ModelRegistryEntry =
    MODEL_REGISTRY[avatarModelKey as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY.lobster;

  const { scene } = useGLTFWithKTX2(reg.path);

  // Whether to use the legacy LobsterAnimator (skeletal bone discovery) or
  // the universal CharacterAnimator. Mirrors the same routing in arena-npcs.tsx
  // and SelectAgentCanvas.tsx.
  const useNewAnimSystem = avatarModelKey !== 'lobster' && avatarModelKey !== 'crayfish';

  const { cloned, lobsterAnimator, charAnimator, pivotOffsetY } = useMemo(() => {
    const c = scene.clone(true);
    makeObject3DWebGPUSafe(c);
    // Fatten SkinnedMesh bounding spheres + re-enable frustumCulled (Win G fix,
    // 2026-05-22 perf wave 3). SkinnedMesh bind-pose spheres are too tight for
    // animated avatars; applyFattenedFrustumCulling fattens each by 1.6× so the
    // animated pose stays inside the bound, then enables culling so the player
    // avatar is correctly skipped when off-screen. Idempotent via _fattenedBy tag.
    applyFattenedFrustumCulling(c);
    const avatarColor = useGameStore.getState().avatarColor;
    const tint = new THREE.Color(COLOR_TINTS[avatarColor] ?? 0xffffff);

    // Resolve final scale (same logic as the primitive scale prop below).
    // Needed to convert localMinY (at scale=1) into world-space correction.
    const finalScale = !useNewAnimSystem ? AVATAR_SCALE : reg.scale;

    // Compute per-GLB pivot offset so feet sit on terrain regardless of where
    // the model's pivot is placed. See arena-npcs.tsx for full rationale.
    const localMinY = computeLocalMinY(c);
    const pivotOffset = localMinY * finalScale;

    if (useNewAnimSystem) {
      // Universal path: shared applyColorTint (stronger tint, matches NPC behaviour)
      applyColorTint(c, tint, 0.6, 0.2);
      const anim = createCharacterAnimator(avatarModelKey, c);
      return { cloned: c, lobsterAnimator: null as LobsterAnimator | null, charAnimator: anim, pivotOffsetY: pivotOffset };
    } else {
      // Legacy lobster/crayfish path: shallow lerp + emissive
      c.traverse((child: THREE.Object3D) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          if (mesh.material) {
            const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
            mat.color.lerp(tint, 0.3);
            mat.emissive = tint;
            mat.emissiveIntensity = 0.1;
            mesh.material = mat;
          }
        }
      });
      const parts = discoverLobsterParts(c);
      const anim = new LobsterAnimator(parts);
      return { cloned: c, lobsterAnimator: anim, charAnimator: null as CharacterAnimator | null, pivotOffsetY: pivotOffset };
    }
  }, [scene, avatarModelKey, useNewAnimSystem, reg.scale]);

  // Dispose cloned materials on unmount (navigation away / hot-reload)
  useEffect(() => {
    return () => {
      cloned.traverse((obj: THREE.Object3D) => {
        const mesh = obj as THREE.Mesh;
        if ((mesh as any).isMesh) {
          // Do NOT dispose tinted materials — applyColorTint() now uses a
          // module-scope shared cache keyed on (baseMat.uuid|tintHex|lerpFactor|
          // emissiveIntensity). The cached instances are intentionally long-lived
          // so subsequent NPCs with the same (species, tint) combo can reuse
          // the same GPU pipeline without re-upload. Disposing here would corrupt
          // the cache and break every other NPC that shares the material.
          //
          // NEVER dispose geometry: scene.clone(true) shares BufferGeometry with
          // the useGLTF cache (Mesh.copy: this.geometry = source.geometry). If
          // we disposed it, the cache would hand out a disposed buffer to any
          // other consumer of this GLB (e.g. arena-npcs wandering NPCs that
          // load the same path).
        }
      });
    };
  }, [cloned]);

  useWorldPlayerController({
    motion: WORLD_GLB_POLICY.motion,
    input: WORLD_GLB_POLICY.input,
    refs: {
      walkableY: walkableYRef,
      portalPrevX: kelpPortalPrevXRef,
      portalPrevZ: kelpPortalPrevZRef,
      portalInitialized: kelpPortalPrevInitializedRef,
    },
    onAfterMove: (frame, rawDelta, elapsed) => {
      const group = groupRef.current;
      if (!group) return;
      group.position.x = frame.x;
      group.position.z = frame.z;

      const frameNumber = Math.floor(elapsed * 60);
      if (frameNumber % 3 === 0) {
        const terrainY = getTerrainY(frame.x, frame.z, threeScene);
        terrainYRef.current += (terrainY - terrainYRef.current) * 0.6;
      }
      const finalBob = frame.renderAirborne
        ? 0
        : frame.moving
          ? Math.abs(Math.sin(elapsed * BOB_SPEED)) * BOB_AMPLITUDE
          : Math.sin(elapsed * 2) * 0.15;
      const effectiveFloorY = Math.max(
        terrainYRef.current,
        walkableYRef.current,
      );
      group.position.y =
        effectiveFloorY +
        2 +
        (frame.renderAirborne ? 0 : finalBob) +
        frame.jumpHeight -
        pivotOffsetY;
      group.rotation.y = frame.facing;

      const dt = Math.min(rawDelta, 0.1);
      const animationDelta = dt * frame.intent.move.speedMultiplier;
      const animGroup = animGroupRef.current;
      const direction = useGameStore.getState().movementDirection;
      if (useNewAnimSystem && charAnimator && animGroup) {
        charAnimator.update(
          animGroup,
          elapsed,
          animationDelta,
          frame.moving,
        );
      } else if (lobsterAnimator && animGroup) {
        lobsterAnimator.update(
          animationDelta,
          elapsed,
          frame.moving ? 'walk' : 'idle',
          direction,
        );
        const animationState = {
          group: animGroup,
          isMoving: frame.moving,
          elapsed,
          delta: dt,
          direction,
          seed: 0,
        };
        if (frame.moving) applyWalkAnimation(animationState);
        else applyIdleAnimation(animationState);
      }
    },
  });

  return (
    <group ref={groupRef}>
      <group ref={animGroupRef}>
        {/* Phase 2: lobster/crayfish use AVATAR_SCALE (40) for the slightly-larger
            player-avatar appearance. All other models use their registry scale. */}
        <primitive
          object={cloned}
          scale={!useNewAnimSystem ? AVATAR_SCALE : reg.scale}
        />
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Route to the correct inner component based on avatar_type
// ---------------------------------------------------------------------------

function PlayerAvatarRouter() {
  const avatarModelKey = useGameStore((s) => s.avatarModelKey);
  const reg: ModelRegistryEntry =
    MODEL_REGISTRY[avatarModelKey as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY.lobster;

  if (reg.avatar_type === 'vrm') {
    return (
      <Suspense fallback={null}>
        <PlayerAvatarVRMInner reg={reg} />
      </Suspense>
    );
  }

  return <PlayerAvatarGLBInner />;
}

export default function PlayerAvatar() {
  const kelpPortalMountResetRef = useRef(false);

  // Locomotion clips are shared by every VRM avatar. The selected VRM itself is
  // loaded on demand by useVRMInstance; avatar-picker choices are warmed only
  // when the picker opens so /game does not fetch the full avatar catalog.
  useEffect(() => {
    // PlayerAvatar owns the stable 3D world-scene lifecycle. Reset here once,
    // not in the swappable VRM/GLB inners or the simultaneously mounted NPC
    // controller, so a model/control-mode change cannot clear the in-flight guard.
    if (!kelpPortalMountResetRef.current) {
      resetKelpForestWalkInLatch();
      kelpPortalMountResetRef.current = true;
    }
    preloadMixamoClips();
  }, []);

  return (
    <Suspense fallback={null}>
      <PlayerAvatarRouter />
    </Suspense>
  );
}
