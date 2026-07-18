'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useQueryClient } from '@tanstack/react-query';
import * as THREE from 'three';
import {
  KELP_REALM_FOOTPRINT_WU,
  KELP_REALM_BEACON_GRAPH,
  KELP_REALM_BEACON_VISIT_RADIUS_WU,
  KELP_REALM_PLAYER_SPAWN,
  KELP_REALM_PLAYER_SPEED_WU_PER_SEC,
  KELP_REALM_WALL_AABBS,
  PEARL_OF_THE_DEPTHS_SLUG,
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
  markKelpRealmBeaconVisited,
  resetKelpRealmBeaconVisits,
} from '@/lib/three/kelp-realm-visit-state';

const PLAYER_RADIUS = 34;
const AVATAR_TARGET_HEIGHT = 270;
const CAM_BEHIND = 460;
const CAM_ABOVE = 245;
const CAM_LOOK_Y = 115;
const CAM_YAW_SPEED = 1.25;
const CAM_PITCH_SPEED = 180;
const CAM_PITCH_MIN = -70;
const CAM_PITCH_MAX = 210;
const HALF_REALM = KELP_REALM_FOOTPRINT_WU / 2;
const KELP_REALM_COSMETIC_SKU_ALLOWLIST = Object.freeze([PEARL_OF_THE_DEPTHS_SLUG]);

const keyboard = { w: false, a: false, s: false, d: false, left: false, right: false, up: false, down: false };
const touch = { x: 0, z: 0, yaw: 0, pitch: 0 };

export function setKelpRealmTouchVelocity(x: number, z: number): void {
  touch.x = x;
  touch.z = z;
}

export function setKelpRealmTouchCamera(yaw: number, pitch: number): void {
  touch.yaw = yaw;
  touch.pitch = pitch;
}

function resetInput(): void {
  keyboard.w = keyboard.a = keyboard.s = keyboard.d = false;
  keyboard.left = keyboard.right = keyboard.up = keyboard.down = false;
  touch.x = touch.z = touch.yaw = touch.pitch = 0;
}

function keyField(code: string): keyof typeof keyboard | null {
  if (code === 'KeyW') return 'w';
  if (code === 'KeyA') return 'a';
  if (code === 'KeyS') return 's';
  if (code === 'KeyD') return 'd';
  if (code === 'ArrowLeft') return 'left';
  if (code === 'ArrowRight') return 'right';
  if (code === 'ArrowUp') return 'up';
  if (code === 'ArrowDown') return 'down';
  return null;
}

function InputLifecycle() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const field = keyField(event.code);
      if (!field) return;
      keyboard[field] = true;
      if (event.code.startsWith('Arrow')) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const field = keyField(event.code);
      if (field) keyboard[field] = false;
    };
    const onVisibility = () => { if (document.hidden) resetInput(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', resetInput);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', resetInput);
      document.removeEventListener('visibilitychange', onVisibility);
      resetInput();
    };
  }, []);
  return null;
}

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
const rightScratch = new THREE.Vector3();
const upScratch = new THREE.Vector3(0, 1, 0);
const cameraScratch = new THREE.Vector3();
const targetScratch = new THREE.Vector3();
const movementScratch = { x: KELP_REALM_PLAYER_SPAWN.x, z: KELP_REALM_PLAYER_SPAWN.z };
export const kelpRealmPlayerPositionRef = { x: KELP_REALM_PLAYER_SPAWN.x, z: KELP_REALM_PLAYER_SPAWN.z };

interface MotionProps {
  readonly children: ReactNode;
  readonly baseY?: number;
  readonly updateAnimation: (delta: number, elapsed: number, moving: boolean) => void;
}

function KelpRealmAvatarMotion({ children, baseY = 0, updateAnimation }: MotionProps) {
  const groupRef = useRef<THREE.Group>(null);
  const posX = useRef(KELP_REALM_PLAYER_SPAWN.x);
  const posZ = useRef(KELP_REALM_PLAYER_SPAWN.z);
  const rotation = useRef(Math.PI);
  const cameraYaw = useRef(0);
  const cameraPitch = useRef(0);
  const { camera } = useThree();

  useFrame(({ clock }, delta) => {
    const safeDelta = Math.min(delta, 0.1);
    cameraYaw.current += (((keyboard.left ? 1 : 0) - (keyboard.right ? 1 : 0)) - touch.yaw) * CAM_YAW_SPEED * safeDelta;
    cameraPitch.current = Math.max(
      CAM_PITCH_MIN,
      Math.min(CAM_PITCH_MAX, cameraPitch.current + (((keyboard.up ? 1 : 0) - (keyboard.down ? 1 : 0)) + touch.pitch) * CAM_PITCH_SPEED * safeDelta),
    );

    camera.getWorldDirection(forwardScratch);
    forwardScratch.y = 0;
    if (forwardScratch.lengthSq() > 0.0001) forwardScratch.normalize();
    rightScratch.crossVectors(forwardScratch, upScratch).normalize();
    let inputForward = (keyboard.w ? 1 : 0) - (keyboard.s ? 1 : 0) + touch.z;
    let inputRight = (keyboard.d ? 1 : 0) - (keyboard.a ? 1 : 0) + touch.x;
    const inputLength = Math.sqrt(inputForward * inputForward + inputRight * inputRight);
    if (inputLength > 1) {
      inputForward /= inputLength;
      inputRight /= inputLength;
    }
    let velocityX = forwardScratch.x * inputForward + rightScratch.x * inputRight;
    let velocityZ = forwardScratch.z * inputForward + rightScratch.z * inputRight;
    const velocityLength = Math.sqrt(velocityX * velocityX + velocityZ * velocityZ);
    if (velocityLength > 1) {
      velocityX /= velocityLength;
      velocityZ /= velocityLength;
    }
    const moving = velocityLength > 0.001;
    if (moving) {
      clampKelpRealmMovement2D(
        posX.current,
        posZ.current,
        posX.current + velocityX * KELP_REALM_PLAYER_SPEED_WU_PER_SEC * safeDelta,
        posZ.current + velocityZ * KELP_REALM_PLAYER_SPEED_WU_PER_SEC * safeDelta,
        movementScratch,
      );
      posX.current = movementScratch.x;
      posZ.current = movementScratch.z;
      const targetRotation = Math.atan2(velocityX, velocityZ);
      let difference = targetRotation - rotation.current;
      while (difference > Math.PI) difference -= Math.PI * 2;
      while (difference < -Math.PI) difference += Math.PI * 2;
      rotation.current += difference * (1 - Math.exp(-10 * safeDelta));
    }

    const group = groupRef.current;
    kelpRealmPlayerPositionRef.x = posX.current;
    kelpRealmPlayerPositionRef.z = posZ.current;
    if (group) {
      group.position.set(posX.current, baseY, posZ.current);
      group.rotation.y = rotation.current;
    }

    const behindX = -Math.sin(cameraYaw.current) * CAM_BEHIND;
    const behindZ = Math.cos(cameraYaw.current) * CAM_BEHIND;
    cameraScratch.set(posX.current + behindX, CAM_ABOVE + cameraPitch.current, posZ.current + behindZ);
    camera.position.lerp(cameraScratch, 1 - Math.exp(-7 * safeDelta));
    targetScratch.set(posX.current, CAM_LOOK_Y, posZ.current);
    camera.lookAt(targetScratch);
    updateAnimation(safeDelta, clock.elapsedTime, moving);
  });

  return <group ref={groupRef}>{children}</group>;
}

function KelpRealmVRMPlayerInner({ reg }: { readonly reg: ModelRegistryEntry }) {
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
    <KelpRealmAvatarMotion updateAnimation={updateAnimation}>
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

function KelpRealmGLBPlayerInner({ reg }: { readonly reg: ModelRegistryEntry }) {
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
    const renderScale = AVATAR_TARGET_HEIGHT / nativeHeight;
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
    <KelpRealmAvatarMotion updateAnimation={updateAnimation}>
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
}

const KELP_API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const BEACON_RADIUS_SQ = KELP_REALM_BEACON_VISIT_RADIUS_WU * KELP_REALM_BEACON_VISIT_RADIUS_WU;

async function kelpPost(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${KELP_API_BASE}/api/kelp${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function KelpRealmBeaconController() {
  const queryClient = useQueryClient();
  const [chain, setChain] = useState<{ beaconId: string; token: string } | null>(null);
  const [, setVisitedBeaconIds] = useState<readonly string[]>([]);
  const chainRef = useRef(chain);
  const pendingRef = useRef(false);
  const lastInsideRef = useRef<string | null>(null);
  const retryAtRef = useRef(0);
  const claimedRef = useRef(false);

  useEffect(() => {
    chainRef.current = chain;
  }, [chain]);
  useEffect(() => {
    resetKelpRealmBeaconVisits();
    return () => resetKelpRealmBeaconVisits();
  }, []);

  const visit = useCallback(async (beaconId: string) => {
    const previous = chainRef.current;
    const response = await kelpPost(
      `/beacon/${encodeURIComponent(beaconId)}/visit`,
      previous && beaconId !== 'entry' ? { prevToken: previous.token } : {},
    );
    const payload = await response.json().catch(() => ({})) as BeaconVisitResponse & {
      code?: string;
      retryAfterMs?: number;
    };
    if (!response.ok) {
      if (response.status === 429 && payload.code === 'too_fast') {
        retryAtRef.current = performance.now() + Math.max(1, payload.retryAfterMs ?? 250);
        lastInsideRef.current = null;
        return;
      }
      useGameStore.getState().addToast('⚠️', 'That beacon did not accept the route token.', 2800);
      lastInsideRef.current = null;
      return;
    }

    const next = { beaconId, token: payload.token };
    chainRef.current = next;
    setChain(next);
    setVisitedBeaconIds((current) => current.includes(beaconId) ? current : [...current, beaconId]);
    markKelpRealmBeaconVisited(beaconId);

    if (beaconId !== 'center' || claimedRef.current) return;
    claimedRef.current = true;
    const claimResponse = await kelpPost('/claim', { centerToken: payload.token });
    const claimPayload = await claimResponse.json().catch(() => ({})) as { code?: string };
    if (claimResponse.ok) {
      await queryClient.invalidateQueries({ queryKey: ['cosmetics', 'owned'] });
      useGameStore.getState().addToast('🫧', 'Pearl of the Depths earned', 5000);
    } else if (claimPayload.code === 'guest_not_allowed') {
      useGameStore.getState().addToast('🔒', 'Create a free account to claim the Pearl of the Depths', 5000);
    } else {
      useGameStore.getState().addToast('⚠️', 'The Pearl reward could not be claimed yet.', 4000);
      claimedRef.current = false;
    }
  }, [queryClient]);

  useFrame(() => {
    if (pendingRef.current || performance.now() < retryAtRef.current) return;
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
    if (!insideId) {
      lastInsideRef.current = null;
      return;
    }
    if (lastInsideRef.current === insideId || chainRef.current?.beaconId === insideId) return;
    if (!chainRef.current && insideId !== 'entry') return;
    lastInsideRef.current = insideId;
    pendingRef.current = true;
    void visit(insideId).finally(() => { pendingRef.current = false; });
  });
  return null;
}

function KelpRealmAvatarRouter() {
  const avatarModelKey = useGameStore((state) => state.avatarModelKey);
  const reg: ModelRegistryEntry =
    MODEL_REGISTRY[avatarModelKey as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY.lobster;

  return reg.avatar_type === 'vrm'
    ? <KelpRealmVRMPlayerInner reg={reg} />
    : <KelpRealmGLBPlayerInner reg={reg} />;
}

export default function KelpRealmPlayer() {
  return (
    <>
      <InputLifecycle />
      <KelpRealmBeaconController />
      <Suspense fallback={null}>
        <KelpRealmAvatarRouter />
      </Suspense>
    </>
  );
}
