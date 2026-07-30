'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { z } from 'zod';
import {
  KELP_REALM_FOOTPRINT_WU,
  KELP_REALM_BEACON_GRAPH,
  KELP_REALM_BEACON_VISIT_RADIUS_WU,
  KELP_REALM_PLAYER_SPAWN,
  KELP_REALM_PLAYER_SPEED_WU_PER_SEC,
  KELP_REALM_SPORE_COUNT,
  KELP_REALM_WALL_AABBS,
  KELP_REALM_WALL_HEIGHT_WU,
  KELP_MAZE_COLLECTIBLE_SLUG,
} from '@clawville/shared';
import { useGameStore } from '@/stores/game';
import { MODEL_REGISTRY, type ModelRegistryEntry } from '@/lib/three/agent-model-registry';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import { VRMCharacterAnimator } from '@/lib/three/vrm-character-animator';
import { disposeVRMInstance, useVRMInstance } from '@/lib/three/vrm-loader';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';
import { CosmeticLoader } from '@/lib/three/cosmetic-loader';
import {
  describeKelpVisitFailure,
  markKelpRealmBeaconVisited,
  publishKelpRealmNotice,
  resetKelpRealmBeaconVisits,
  setKelpRealmBeaconTotalCount,
  setKelpRealmCenterProximity,
} from '@/lib/three/kelp-realm-visit-state';
import {
  useSceneFrame,
  useSlotCapabilities,
} from '@/components/three/world-stage/use-scene-frame';
import {
  usePlayerCapabilityController,
  type PlayerSpaceAdapter,
} from '@/lib/three/player/player-capability-controller';
import { KELP_POLICY } from '@/lib/three/player/player-motion-policy';
import type {
  KelpActivationContext,
  KelpActivationToken,
} from '@/lib/three/kelp-activation';

const PLAYER_RADIUS = 34;
const AVATAR_TARGET_HEIGHT = 270;
/**
 * Non-humanoid GLB avatars (lobster, crab-class bodies) are LOW and LONG:
 * normalizing them to AVATAR_TARGET_HEIGHT by height alone explodes their
 * horizontal extent to corridor-filling size (founder repro: the lobster
 * spanned nearly the whole walkway with the camera inside its shell). Cap
 * the visual footprint so the widest axis never exceeds this, and let the
 * SMALLER of the height-fit and footprint-fit scales win.
 */
const AVATAR_MAX_FOOTPRINT = 150;
const CAM_BEHIND = 560;
const CAM_ABOVE = 470;
const CAM_LOOK_Y = 170;
const CAM_LOOK_AHEAD = 150;
/** The camera never clamps closer to the player than this, no matter what. */
const CAM_MIN_DISTANCE = 220;
/** Sightline points above the kelp canopy (plus margin) can never be occluded. */
const CAM_OCCLUSION_CEILING_WU = KELP_REALM_WALL_HEIGHT_WU + 24;
const CAM_YAW_SPEED = 1.25;
const CAM_PITCH_SPEED = 180;
const CAM_PITCH_MIN = -35;
const CAM_PITCH_MAX = 160;
const CAM_WALL_CLEARANCE = 24;
const CAM_WALL_PADDING = 18;
const HALF_REALM = KELP_REALM_FOOTPRINT_WU / 2;
const KELP_REALM_COSMETIC_SKU_ALLOWLIST = Object.freeze([KELP_MAZE_COLLECTIBLE_SLUG]);

/** Axis-separated realm collision using the AABBs derived from the one layout. */
function collidesWithWall(x: number, z: number): boolean {
  for (let index = 0; index < KELP_REALM_WALL_AABBS.length; index++) {
    const wall = KELP_REALM_WALL_AABBS[index]!;
    if (
      x > wall.centerX - wall.halfX - PLAYER_RADIUS &&
      x < wall.centerX + wall.halfX + PLAYER_RADIUS &&
      z > wall.centerZ - wall.halfZ - PLAYER_RADIUS &&
      z < wall.centerZ + wall.halfZ + PLAYER_RADIUS
    ) return true;
  }
  return false;
}

export function clampKelpRealmMovement2D(
  currentX: number,
  currentZ: number,
  desiredX: number,
  desiredZ: number,
  out: { x: number; z: number },
): void {
  const min = -HALF_REALM + PLAYER_RADIUS;
  const max = HALF_REALM - PLAYER_RADIUS;
  const nextX = Math.max(min, Math.min(max, desiredX));
  const nextZ = Math.max(min, Math.min(max, desiredZ));
  out.x = collidesWithWall(nextX, currentZ) ? currentX : nextX;
  out.z = collidesWithWall(out.x, nextZ) ? currentZ : nextZ;
}

const forwardScratch = new THREE.Vector3();
const cameraScratch = new THREE.Vector3();
const targetScratch = new THREE.Vector3();
const movementScratch = { x: KELP_REALM_PLAYER_SPAWN.x, z: KELP_REALM_PLAYER_SPAWN.z };
export const kelpRealmPlayerPositionRef = { x: KELP_REALM_PLAYER_SPAWN.x, z: KELP_REALM_PLAYER_SPAWN.z };

function firstCameraWallHitT(
  originX: number,
  originZ: number,
  targetX: number,
  targetZ: number,
  originY: number,
  targetY: number,
): number {
  const deltaX = targetX - originX;
  const deltaZ = targetZ - originZ;
  const deltaY = targetY - originY;
  let firstHit = 1;

  for (let index = 0; index < KELP_REALM_WALL_AABBS.length; index++) {
    const wall = KELP_REALM_WALL_AABBS[index]!;
    const minX = wall.centerX - wall.halfX - CAM_WALL_CLEARANCE;
    const maxX = wall.centerX + wall.halfX + CAM_WALL_CLEARANCE;
    const minZ = wall.centerZ - wall.halfZ - CAM_WALL_CLEARANCE;
    const maxZ = wall.centerZ + wall.halfZ + CAM_WALL_CLEARANCE;
    let nearT = 0;
    let farT = firstHit;

    if (Math.abs(deltaX) < 0.000001) {
      if (originX <= minX || originX >= maxX) continue;
    } else {
      let axisNear = (minX - originX) / deltaX;
      let axisFar = (maxX - originX) / deltaX;
      if (axisNear > axisFar) {
        const swap = axisNear;
        axisNear = axisFar;
        axisFar = swap;
      }
      nearT = Math.max(nearT, axisNear);
      farT = Math.min(farT, axisFar);
      if (nearT > farT) continue;
    }

    if (Math.abs(deltaZ) < 0.000001) {
      if (originZ <= minZ || originZ >= maxZ) continue;
    } else {
      let axisNear = (minZ - originZ) / deltaZ;
      let axisFar = (maxZ - originZ) / deltaZ;
      if (axisNear > axisFar) {
        const swap = axisNear;
        axisNear = axisFar;
        axisFar = swap;
      }
      nearT = Math.max(nearT, axisNear);
      farT = Math.min(farT, axisFar);
      if (nearT > farT) continue;
    }

    // Height-aware: the wall slab test is 2D, but kelp walls are only
    // KELP_REALM_WALL_HEIGHT_WU tall. If the sightline crosses this wall at a
    // height above the canopy, the camera sees clean over it — clamping there
    // is what made the chase camera yank inward in every corridor.
    if (originY + deltaY * nearT >= CAM_OCCLUSION_CEILING_WU) continue;
    if (farT >= 0 && nearT >= 0 && nearT < firstHit) firstHit = nearT;
  }

  return firstHit;
}

function cameraVisibleSegmentSafeT(
  originX: number,
  originZ: number,
  target: THREE.Vector3,
): number {
  const hitT = firstCameraWallHitT(originX, originZ, target.x, target.z, CAM_LOOK_Y, target.y);
  const deltaX = target.x - originX;
  const deltaZ = target.z - originZ;
  const segmentLength = Math.max(1, Math.sqrt(deltaX * deltaX + deltaZ * deltaZ));
  if (hitT >= 1) return 1;
  const safeT = Math.max(0, hitT - CAM_WALL_PADDING / segmentLength);
  // Distance floor: a fully clamped camera parked on the player's head is
  // worse than briefly seeing through a blade. Never collapse below this.
  return Math.max(safeT, Math.min(1, CAM_MIN_DISTANCE / segmentLength));
}

interface MotionProps {
  readonly activation: KelpActivationContext;
  readonly children: ReactNode;
  readonly baseY?: number;
  readonly updateAnimation: (delta: number, elapsed: number, moving: boolean) => void;
}

function KelpRealmAvatarMotion({
  activation,
  children,
  baseY = 0,
  updateAnimation,
}: MotionProps) {
  const groupRef = useRef<THREE.Group>(null);
  const posX = useRef(KELP_REALM_PLAYER_SPAWN.x);
  const posZ = useRef(KELP_REALM_PLAYER_SPAWN.z);
  const cameraYaw = useRef(0);
  const cameraPitch = useRef(0);
  const cameraClampT = useRef(1);
  const snapCameraRef = useRef(true);
  const { camera } = useThree();
  const capabilities = useSlotCapabilities();
  const space = useMemo<PlayerSpaceAdapter>(
    () => ({
      speedPerSec: KELP_REALM_PLAYER_SPEED_WU_PER_SEC,
      readPosition: (out) => {
        out.x = posX.current;
        out.z = posZ.current;
      },
      clampMovement: (
        currentX,
        currentZ,
        desiredX,
        desiredZ,
        out,
      ) => {
        clampKelpRealmMovement2D(
          currentX,
          currentZ,
          desiredX,
          desiredZ,
          movementScratch,
        );
        out.x = movementScratch.x;
        out.z = movementScratch.z;
        out.groundY = 0;
      },
      commitPosition: (result) => {
        posX.current = result.x;
        posZ.current = result.z;
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const token = activation.token;
    posX.current = KELP_REALM_PLAYER_SPAWN.x;
    posZ.current = KELP_REALM_PLAYER_SPAWN.z;
    cameraYaw.current = 0;
    cameraPitch.current = 0;
    cameraClampT.current = 1;
    snapCameraRef.current = true;
    kelpRealmPlayerPositionRef.x = KELP_REALM_PLAYER_SPAWN.x;
    kelpRealmPlayerPositionRef.z = KELP_REALM_PLAYER_SPAWN.z;
    const group = groupRef.current;
    if (group) {
      group.position.set(
        KELP_REALM_PLAYER_SPAWN.x,
        baseY,
        KELP_REALM_PLAYER_SPAWN.z,
      );
      group.rotation.y = KELP_POLICY.motion.initialFacing;
    }
    activation.reportResetComplete(token, 'motion');
  }, [activation.reportResetComplete, activation.token, baseY]);

  usePlayerCapabilityController({
    sceneId: 'kelp',
    capabilities,
    motion: KELP_POLICY.motion,
    input: KELP_POLICY.input,
    space,
    isDriving: () => activation.owned,
    onAfterMove: (state, _rawDelta, elapsed) => {
      const safeDelta = state.integrationDelta;
      cameraYaw.current +=
        state.intent.cameraYawInput * CAM_YAW_SPEED * safeDelta;
    cameraPitch.current = Math.max(
      CAM_PITCH_MIN,
        Math.min(
          CAM_PITCH_MAX,
          cameraPitch.current +
            state.intent.cameraPitchInput * CAM_PITCH_SPEED * safeDelta,
        ),
    );

    camera.getWorldDirection(forwardScratch);
    forwardScratch.y = 0;
    if (forwardScratch.lengthSq() > 0.0001) forwardScratch.normalize();

    const group = groupRef.current;
      kelpRealmPlayerPositionRef.x = state.x;
      kelpRealmPlayerPositionRef.z = state.z;
    if (group) {
        group.position.set(state.x, baseY, state.z);
        group.rotation.y = state.facing;
    }

    const behindX = -Math.sin(cameraYaw.current) * CAM_BEHIND;
    const behindZ = Math.cos(cameraYaw.current) * CAM_BEHIND;
      cameraScratch.set(
        state.x + behindX,
        CAM_ABOVE + cameraPitch.current,
        state.z + behindZ,
      );
      const desiredClampT = cameraVisibleSegmentSafeT(
        state.x,
        state.z,
        cameraScratch,
      );
    const clampRate = desiredClampT < cameraClampT.current ? 8 : 3;
      if (snapCameraRef.current) {
        cameraClampT.current = desiredClampT;
      } else {
        cameraClampT.current +=
          (desiredClampT - cameraClampT.current) *
          (1 - Math.exp(-clampRate * safeDelta));
      }
      cameraScratch.x = state.x + behindX * cameraClampT.current;
      cameraScratch.z = state.z + behindZ * cameraClampT.current;
      if (snapCameraRef.current) {
        camera.position.copy(cameraScratch);
        snapCameraRef.current = false;
      } else {
        camera.position.lerp(
          cameraScratch,
          1 - Math.exp(-7 * safeDelta),
        );
      }
    targetScratch.set(
        state.x + forwardScratch.x * CAM_LOOK_AHEAD,
      CAM_LOOK_Y,
        state.z + forwardScratch.z * CAM_LOOK_AHEAD,
    );
    camera.lookAt(targetScratch);
      updateAnimation(safeDelta, elapsed, state.moving);
    },
  });

  return <group ref={groupRef}>{children}</group>;
}

function KelpRealmVRMPlayerInner({
  activation,
  reg,
}: {
  readonly activation: KelpActivationContext;
  readonly reg: ModelRegistryEntry;
}) {
  const vrm = useVRMInstance(reg.path, 'kelp-realm-player');
  const { scale: vrmRenderScale, offsetY: vrmFootOffsetY } = useMemo(
    () => computeVRMAvatarFit(vrm, reg.animatorId, AVATAR_TARGET_HEIGHT),
    [vrm, reg.animatorId],
  );
  const animatorRef = useRef<VRMCharacterAnimator | null>(null);

  useEffect(() => () => disposeVRMInstance(reg.path, 'kelp-realm-player'), [reg.path]);

  useEffect(() => {
    const animator = new VRMCharacterAnimator(vrm, reg.animatorId);
    animatorRef.current = animator;
    animator.init().catch((error) => {
      console.warn('[KelpRealm VRM] animator init failed:', error);
    });
    return () => {
      animatorRef.current = null;
      animator.dispose();
    };
  }, [vrm, reg.animatorId]);

  const updateAnimation = useCallback((delta: number, _elapsed: number, moving: boolean) => {
    animatorRef.current?.update(delta, moving, false);
  }, []);

  return (
    <KelpRealmAvatarMotion
      activation={activation}
      updateAnimation={updateAnimation}
    >
      <primitive
        object={vrm.scene}
        scale={[vrmRenderScale, vrmRenderScale, vrmRenderScale]}
        position={[0, vrmFootOffsetY, 0]}
      />
      <CosmeticLoader
        avatarId="self"
        rigType="universal"
        context="world"
        parentObject={vrm.scene}
        vrm={vrm}
        vrmRenderScale={vrmRenderScale}
        allowedSkuSlugs={KELP_REALM_COSMETIC_SKU_ALLOWLIST}
      />
    </KelpRealmAvatarMotion>
  );
}

const glbBoundsScratch = new THREE.Box3();

function KelpRealmGLBPlayerInner({
  activation,
  reg,
}: {
  readonly activation: KelpActivationContext;
  readonly reg: ModelRegistryEntry;
}) {
  const { scene } = useGLTFWithKTX2(reg.path);
  const { cloned, scale, offsetY } = useMemo(() => {
    const next = scene.clone(true);
    makeObject3DWebGPUSafe(next);
    next.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((material) => material.clone())
        : mesh.material.clone();
    });
    next.updateMatrixWorld(true);
    glbBoundsScratch.setFromObject(next);
    const nativeHeight = Math.max(0.001, glbBoundsScratch.max.y - glbBoundsScratch.min.y);
    const nativeFootprint = Math.max(
      0.001,
      glbBoundsScratch.max.x - glbBoundsScratch.min.x,
      glbBoundsScratch.max.z - glbBoundsScratch.min.z,
    );
    const renderScale = Math.min(
      AVATAR_TARGET_HEIGHT / nativeHeight,
      AVATAR_MAX_FOOTPRINT / nativeFootprint,
    );
    return {
      cloned: next,
      scale: renderScale,
      offsetY: -glbBoundsScratch.min.y * renderScale,
    };
  }, [scene]);

  useEffect(() => () => {
    cloned.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((material) => material.dispose());
      } else {
        mesh.material.dispose();
      }
    });
  }, [cloned]);

  const updateAnimation = useCallback(() => undefined, []);
  return (
    <KelpRealmAvatarMotion
      activation={activation}
      updateAnimation={updateAnimation}
    >
      <primitive object={cloned} scale={scale} position={[0, offsetY, 0]} />
      <CosmeticLoader
        avatarId="self"
        rigType="universal"
        context="world"
        parentObject={cloned}
        vrmRenderScale={scale}
        allowedSkuSlugs={KELP_REALM_COSMETIC_SKU_ALLOWLIST}
      />
    </KelpRealmAvatarMotion>
  );
}

interface BeaconVisitResponse {
  token: string;
  adjacent: readonly { id: string; kind: string; bearingDeg: number; distanceWu: number }[];
  spores: { found: number; total: number };
  spore?: true;
}

const beaconAdjacentResponseSchema = z.object({
  id: z.string().min(1).max(96),
  kind: z.enum(['entry', 'junction', 'dead-end', 'center']),
  bearingDeg: z.number().finite().min(0).lt(360),
  distanceWu: z.number().finite().positive(),
}).strict();

const beaconVisitResponseSchema = z.object({
  token: z.string().min(1).max(1024),
  adjacent: z.array(beaconAdjacentResponseSchema).max(4),
  spores: z.object({
    found: z.number().int().min(0).max(KELP_REALM_SPORE_COUNT),
    total: z.literal(KELP_REALM_SPORE_COUNT),
  }).strict(),
  spore: z.literal(true).optional(),
}).strict();

const beaconVisitErrorSchema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
  retryAfterMs: z.number().finite().int().nonnegative().optional(),
}).strict();

export function parseKelpRealmBeaconVisitResponse(
  payload: unknown,
): BeaconVisitResponse | null {
  const result = beaconVisitResponseSchema.safeParse(payload);
  return result.success ? result.data : null;
}

const KELP_API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const BEACON_RADIUS_SQ = KELP_REALM_BEACON_VISIT_RADIUS_WU * KELP_REALM_BEACON_VISIT_RADIUS_WU;

async function kelpPost(
  path: string,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${KELP_API_BASE}/api/kelp${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

function KelpRealmBeaconController({
  activation,
}: {
  readonly activation: KelpActivationContext;
}) {
  const chainRef = useRef<{ beaconId: string; token: string } | null>(null);
  const pendingRef = useRef(false);
  const lastInsideRef = useRef<string | null>(null);
  const retryAtRef = useRef(0);
  const visitAbortRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    const token = activation.token;
    visitAbortRef.current?.abort();
    chainRef.current = null;
    pendingRef.current = false;
    lastInsideRef.current = null;
    retryAtRef.current = 0;
    visitAbortRef.current = null;
    resetKelpRealmBeaconVisits();
    setKelpRealmBeaconTotalCount(KELP_REALM_BEACON_GRAPH.nodes.length);
    activation.reportResetComplete(token, 'beacon');
  }, [
    activation.reportResetComplete,
    activation.token,
  ]);

  useEffect(() => {
    if (!activation.owned) {
      visitAbortRef.current?.abort();
      visitAbortRef.current = null;
      pendingRef.current = false;
      lastInsideRef.current = null;
      retryAtRef.current = 0;
    }
  }, [activation.owned]);

  const visit = useCallback(async (beaconId: string) => {
    const token: KelpActivationToken = activation.token;
    const previous = chainRef.current;
    const controller = new AbortController();
    visitAbortRef.current = controller;
    try {
      const response = await kelpPost(
        `/beacon/${encodeURIComponent(beaconId)}/visit`,
        previous && beaconId !== 'entry' ? { prevToken: previous.token } : {},
        controller.signal,
      );
      if (
        !activation.isCurrent(token) ||
        controller.signal.aborted
      ) {
        return;
      }
      const payload = await response.json().catch(() => null) as unknown;
      if (
        !activation.isCurrent(token) ||
        controller.signal.aborted
      ) {
        return;
      }
      if (!response.ok) {
        const errorResult = beaconVisitErrorSchema.safeParse(payload);
        const errorPayload = errorResult.success ? errorResult.data : {};
        publishKelpRealmNotice(describeKelpVisitFailure(
          response.status,
          errorPayload.code,
          errorPayload.retryAfterMs,
        ));
        if (response.status === 429 && errorPayload.code === 'too_fast') {
          retryAtRef.current = performance.now() + Math.max(1, errorPayload.retryAfterMs ?? 250);
          lastInsideRef.current = null;
          return;
        }
        if (errorPayload.code === 'invalid_token' || errorPayload.code === 'expired_token') {
          chainRef.current = null;
          resetKelpRealmBeaconVisits();
          setKelpRealmBeaconTotalCount(KELP_REALM_BEACON_GRAPH.nodes.length);
        }
        // Do not spam an anonymous 401/error every frame while standing on the
        // same beacon. Stepping away and back is the explicit retry gesture.
        lastInsideRef.current = beaconId;
        return;
      }

      const parsedPayload = parseKelpRealmBeaconVisitResponse(payload);
      if (!parsedPayload) {
        publishKelpRealmNotice(describeKelpVisitFailure(response.status, 'invalid_response'));
        lastInsideRef.current = beaconId;
        return;
      }

      const next = { beaconId, token: parsedPayload.token };
      chainRef.current = next;
      markKelpRealmBeaconVisited(
        beaconId,
        parsedPayload.token,
        KELP_REALM_BEACON_GRAPH.nodes.length,
        parsedPayload.spores,
      );
    } catch (error) {
      if (
        !activation.isCurrent(token) ||
        controller.signal.aborted
      ) {
        return;
      }
      publishKelpRealmNotice(
        error instanceof Error
          ? `The beacon request could not reach the reef (${error.message}). Step away and try again.`
          : 'The beacon request could not reach the reef. Step away and try again.',
      );
      lastInsideRef.current = beaconId;
    } finally {
      if (!activation.isCurrent(token)) return;
      if (visitAbortRef.current === controller) visitAbortRef.current = null;
    }
  }, [activation]);

  useSceneFrame(() => {
    let insideId: string | null = null;
    let nearestSq = Number.POSITIVE_INFINITY;
    for (const node of KELP_REALM_BEACON_GRAPH.nodes) {
      const dx = kelpRealmPlayerPositionRef.x - node.x;
      const dz = kelpRealmPlayerPositionRef.z - node.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq <= BEACON_RADIUS_SQ && distanceSq < nearestSq) {
        nearestSq = distanceSq;
        insideId = node.id;
      }
    }
    setKelpRealmCenterProximity(insideId === 'center');
    if (!insideId) {
      lastInsideRef.current = null;
      return;
    }
    if (pendingRef.current || performance.now() < retryAtRef.current) return;
    if (lastInsideRef.current === insideId || chainRef.current?.beaconId === insideId) return;
    if (!chainRef.current && insideId !== 'entry') return;
    lastInsideRef.current = insideId;
    pendingRef.current = true;
    const token = activation.token;
    void visit(insideId).finally(() => {
      if (activation.isCurrent(token)) {
        pendingRef.current = false;
      }
    });
  });
  return null;
}

function KelpRealmAvatarRouter({
  activation,
}: {
  readonly activation: KelpActivationContext;
}) {
  const avatarModelKey = useGameStore((state) => state.avatarModelKey);
  const reg: ModelRegistryEntry =
    MODEL_REGISTRY[avatarModelKey as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY.lobster;

  return reg.avatar_type === 'vrm'
    ? <KelpRealmVRMPlayerInner activation={activation} reg={reg} />
    : <KelpRealmGLBPlayerInner activation={activation} reg={reg} />;
}

export default function KelpRealmPlayer({
  activation,
}: {
  readonly activation: KelpActivationContext;
}) {
  return (
    <>
      <KelpRealmBeaconController activation={activation} />
      <Suspense fallback={null}>
        <KelpRealmAvatarRouter activation={activation} />
      </Suspense>
    </>
  );
}
