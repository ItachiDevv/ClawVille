'use client';

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  KELP_REALM_FOOTPRINT_WU,
  KELP_REALM_PLAYER_SPAWN,
  KELP_REALM_WALL_AABBS,
} from '@clawville/shared';
import { useGameStore } from '@/stores/game';

const PLAYER_RADIUS = 34;
const PLAYER_SPEED = 430;
const AVATAR_TARGET_HEIGHT = 270;
const CAM_BEHIND = 460;
const CAM_ABOVE = 245;
const CAM_LOOK_Y = 115;
const CAM_YAW_SPEED = 1.25;
const CAM_PITCH_SPEED = 180;
const CAM_PITCH_MIN = -70;
const CAM_PITCH_MAX = 210;
const HALF_REALM = KELP_REALM_FOOTPRINT_WU / 2;

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
        posX.current + velocityX * PLAYER_SPEED * safeDelta,
        posZ.current + velocityZ * PLAYER_SPEED * safeDelta,
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

function RealmAvatarProxy() {
  const avatarColor = useGameStore((state) => state.avatarColor);
  const resources = useMemo(() => {
    const geometry = new THREE.CapsuleGeometry(58, AVATAR_TARGET_HEIGHT - 116, 8, 12);
    geometry.translate(0, AVATAR_TARGET_HEIGHT / 2, 0);
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(avatarColor || '#3dd6b3'),
      roughness: 0.72,
      metalness: 0.04,
    });
    return { geometry, material };
  }, [avatarColor]);
  useEffect(() => () => {
    resources.geometry.dispose();
    resources.material.dispose();
  }, [resources]);
  const updateAnimation = useCallback(() => undefined, []);
  return (
    <KelpRealmAvatarMotion updateAnimation={updateAnimation}>
      <mesh geometry={resources.geometry} material={resources.material} matrixAutoUpdate={false} />
    </KelpRealmAvatarMotion>
  );
}

export default function KelpRealmPlayer() {
  return (
    <>
      <InputLifecycle />
      <RealmAvatarProxy />
    </>
  );
}
