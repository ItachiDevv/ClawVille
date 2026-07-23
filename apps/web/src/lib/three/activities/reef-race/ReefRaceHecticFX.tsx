'use client';

/**
 * R18e grand item presentation.
 *
 * Authority/timing stay server-owned. This component mirrors authoritative
 * client store edges into six bounded built-in-material InstancedMesh draws:
 * the three R18d batches (mine, wave, target shells) plus three count-driven
 * event pools (blobs, water rings, streaks). New pools stay count=0 while
 * dormant, so the R18e dormant draw delta is zero and the active peak delta is
 * exactly three.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ReefPufferMineState } from '@clawville/shared';
import {
  useActivityStore,
  type ReefPresentationVfxEvent,
} from '@/stores/activity';
import { bankAngleAtT, bankedDatumYAtT } from './reef-race-elevation';
import { clientSpline } from './reef-race-spline-instance';
import { surfWaveHeightAt } from './reef-wave-height';
import { getReefRaceRenderedPose } from './ReefRacePlayer';
import type { ReefRaceEntity } from './reef-race-types';

const MAX_MINES = 64;
const PUFFER_FLASH_CAPACITY = 12;
const MAX_RACERS = 8;
const TARGET_CAPACITY = MAX_RACERS * 4;
const WAVE_SEGMENTS = 14;
const WAVE_LUT_SIZE = 512;
const BLOB_CAPACITY = 320;
const RING_CAPACITY = 64;
const STREAK_CAPACITY = 160;
const EVENT_REPLAY_MAX_AGE_MS = 1_800;

const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _end = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _midpoint = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _color = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _impactOrigin = new THREE.Vector3();
const _secondaryOrigin = new THREE.Vector3();
let _impactSurfaceBaseY = 0;

interface BlobSlot {
  active: boolean;
  startMs: number;
  durationMs: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  baseScale: number;
  growth: number;
  color: number;
}

interface RingSlot {
  active: boolean;
  startMs: number;
  durationMs: number;
  x: number;
  baseY: number;
  z: number;
  yaw: number;
  bank: number;
  startRadius: number;
  endRadius: number;
  rise: number;
  color: number;
}

interface StreakSlot {
  active: boolean;
  startMs: number;
  durationMs: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  width: number;
  length: number;
  growth: number;
  color: number;
}

interface PufferFlashSlot {
  active: boolean;
  startMs: number;
  durationMs: number;
  x: number;
  baseY: number;
  z: number;
  color: number;
}

interface PresentationPools {
  blobs: BlobSlot[];
  rings: RingSlot[];
  streaks: StreakSlot[];
  pufferFlashes: PufferFlashSlot[];
  blobCursor: number;
  ringCursor: number;
  streakCursor: number;
  pufferCursor: number;
  lastSeq: number;
}

function createBlobSlot(): BlobSlot {
  return {
    active: false,
    startMs: 0,
    durationMs: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    gravity: 0,
    baseScale: 0,
    growth: 0,
    color: 0,
  };
}

function createRingSlot(): RingSlot {
  return {
    active: false,
    startMs: 0,
    durationMs: 0,
    x: 0,
    baseY: 0,
    z: 0,
    yaw: 0,
    bank: 0,
    startRadius: 0,
    endRadius: 0,
    rise: 0,
    color: 0,
  };
}

function createStreakSlot(): StreakSlot {
  return {
    active: false,
    startMs: 0,
    durationMs: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    gravity: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    width: 0,
    length: 0,
    growth: 0,
    color: 0,
  };
}

function createPufferFlashSlot(): PufferFlashSlot {
  return {
    active: false,
    startMs: 0,
    durationMs: 0,
    x: 0,
    baseY: 0,
    z: 0,
    color: 0,
  };
}

function createPresentationPools(): PresentationPools {
  const blobs: BlobSlot[] = [];
  const rings: RingSlot[] = [];
  const streaks: StreakSlot[] = [];
  const pufferFlashes: PufferFlashSlot[] = [];
  for (let i = 0; i < BLOB_CAPACITY; i++) blobs.push(createBlobSlot());
  for (let i = 0; i < RING_CAPACITY; i++) rings.push(createRingSlot());
  for (let i = 0; i < STREAK_CAPACITY; i++) streaks.push(createStreakSlot());
  for (let i = 0; i < PUFFER_FLASH_CAPACITY; i++) pufferFlashes.push(createPufferFlashSlot());
  return {
    blobs,
    rings,
    streaks,
    pufferFlashes,
    blobCursor: 0,
    ringCursor: 0,
    streakCursor: 0,
    pufferCursor: 0,
    lastSeq: 0,
  };
}

function hash01(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

function easeOutCubic(value: number): number {
  const inverse = 1 - value;
  return 1 - inverse * inverse * inverse;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts, false) ?? new THREE.BufferGeometry();
  for (const part of parts) part.dispose();
  return geometry;
}

function buildPufferGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.IcosahedronGeometry(30, 1)];
  const directions = [
    [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
    [-.58, -.58, -.58], [-.58, -.58, .58], [-.58, .58, -.58],
    [.58, -.58, -.58], [.58, .58, -.58], [.58, .58, .58],
  ] as const;
  const up = new THREE.Vector3(0, 1, 0);
  const direction = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  for (const value of directions) {
    direction.set(value[0], value[1], value[2]).normalize();
    q.setFromUnitVectors(up, direction);
    p.copy(direction).multiplyScalar(39);
    m.compose(p, q, s);
    const indexed = new THREE.ConeGeometry(5.5, 30, 4, 1);
    const spike = indexed.toNonIndexed();
    indexed.dispose();
    spike.translate(0, 15, 0);
    spike.applyMatrix4(m);
    parts.push(spike);
  }
  return merge(parts);
}

function colorGeometry(
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
): THREE.BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const values = new Float32Array(count * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < count; i++) {
    const offset = i * 3;
    values[offset] = c.r;
    values[offset + 1] = c.g;
    values[offset + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
  return geometry;
}

function buildWaveGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const offsets = [-.92, -.63, -.34, -.08, .18, .43, .7, .91];
  for (let i = 0; i < offsets.length; i++) {
    const finger = colorGeometry(
      new THREE.PlaneGeometry(i % 3 === 0 ? .12 : .065, 2),
      i % 2 === 0 ? '#efffff' : '#72f4ff',
    );
    finger.translate(offsets[i], 0, 0);
    finger.rotateX(-Math.PI / 2);
    parts.push(finger);
  }
  // Same draw as the horizontal foam: a tall, transverse active-edge fin.
  const wall = colorGeometry(new THREE.PlaneGeometry(2, 122), '#dfffff');
  wall.translate(0, 61, 0);
  parts.push(wall);
  const crest = colorGeometry(new THREE.PlaneGeometry(2, 24), '#ffffff');
  crest.translate(0, 124, 0);
  parts.push(crest);
  return merge(parts);
}

const _pufferGeometry = buildPufferGeometry();
const _pufferMaterial = new THREE.MeshStandardMaterial({
  color: '#fb5f9d',
  emissive: '#9b174f',
  emissiveIntensity: .78,
  roughness: .58,
  metalness: .05,
});
const _targetGeometry = new THREE.SphereGeometry(1, 16, 10);
const _targetMaterial = new THREE.MeshBasicMaterial({
  color: '#ffffff',
  transparent: true,
  opacity: .34,
  depthWrite: false,
  side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
});
_targetMaterial.forceSinglePass = true;
const _waveGeometry = buildWaveGeometry();
const _waveMaterial = new THREE.MeshBasicMaterial({
  vertexColors: true,
  transparent: true,
  opacity: .58,
  depthWrite: false,
  side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
});
_waveMaterial.forceSinglePass = true;
const _blobGeometry = new THREE.IcosahedronGeometry(1, 1);
const _blobMaterial = new THREE.MeshBasicMaterial({
  color: '#ffffff',
  transparent: true,
  opacity: .72,
  depthWrite: false,
  blending: THREE.NormalBlending,
});
const _ringGeometry = new THREE.TorusGeometry(1, .075, 5, 28);
_ringGeometry.rotateX(Math.PI / 2);
const _ringMaterial = new THREE.MeshBasicMaterial({
  color: '#ffffff',
  transparent: true,
  opacity: .74,
  depthWrite: false,
  blending: THREE.NormalBlending,
});
const _streakGeometry = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
const _streakMaterial = new THREE.MeshBasicMaterial({
  color: '#ffffff',
  transparent: true,
  opacity: .78,
  depthWrite: false,
  side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
});
_streakMaterial.forceSinglePass = true;

const _waveX = new Float32Array(WAVE_LUT_SIZE);
const _waveZ = new Float32Array(WAVE_LUT_SIZE);
const _waveY = new Float32Array(WAVE_LUT_SIZE);
const _waveRot = new Float32Array(WAVE_LUT_SIZE);
const _waveBank = new Float32Array(WAVE_LUT_SIZE);
const _waveWidth = new Float32Array(WAVE_LUT_SIZE);
for (let i = 0; i < WAVE_LUT_SIZE; i++) {
  const progress = i / WAVE_LUT_SIZE;
  const t = clientSpline.tFromArclength(progress * clientSpline.totalArcLength);
  const point = clientSpline.centerlineAt(t);
  _waveX[i] = point.x;
  _waveZ[i] = point.z;
  _waveY[i] = bankedDatumYAtT(point.x, point.z, t);
  _waveBank[i] = bankAngleAtT(t);
  _waveWidth[i] = clientSpline.widthAt(t) * .92;
}
for (let i = 0; i < WAVE_LUT_SIZE; i++) {
  const previous = (i + WAVE_LUT_SIZE - 1) % WAVE_LUT_SIZE;
  const next = (i + 1) % WAVE_LUT_SIZE;
  _waveRot[i] = Math.atan2(_waveX[next] - _waveX[previous], _waveZ[next] - _waveZ[previous]);
}

interface ResolvedMine extends ReefPufferMineState {
  x: number;
  z: number;
  baseY: number;
}

function resolveMine(mine: ReefPufferMineState): ResolvedMine {
  const x = mine.position.x;
  const z = mine.position.y;
  const t = clientSpline.closestPointOnSpline({ x, z }).t;
  return { ...mine, x, z, baseY: bankedDatumYAtT(x, z, t) };
}

function initializeMesh(mesh: THREE.InstancedMesh | null, capacity: number): void {
  if (!mesh) return;
  _color.setHex(0xffffff);
  for (let i = 0; i < capacity; i++) {
    mesh.setMatrixAt(i, _zero);
    mesh.setColorAt(i, _color);
  }
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor.needsUpdate = true;
  }
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
}

function claimBlob(pools: PresentationPools): BlobSlot {
  const slot = pools.blobs[pools.blobCursor];
  pools.blobCursor = (pools.blobCursor + 1) % BLOB_CAPACITY;
  slot.active = true;
  return slot;
}

function claimRing(pools: PresentationPools): RingSlot {
  const slot = pools.rings[pools.ringCursor];
  pools.ringCursor = (pools.ringCursor + 1) % RING_CAPACITY;
  slot.active = true;
  return slot;
}

function claimStreak(pools: PresentationPools): StreakSlot {
  const slot = pools.streaks[pools.streakCursor];
  pools.streakCursor = (pools.streakCursor + 1) % STREAK_CAPACITY;
  slot.active = true;
  return slot;
}

function resolveImpactOrigin(
  event: ReefPresentationVfxEvent,
  preferRenderedVictim = true,
): number {
  const victimPose = preferRenderedVictim && event.victimAvatarId
    ? getReefRaceRenderedPose(event.victimAvatarId)
    : null;
  const x = victimPose?.x ?? event.position.x;
  const z = victimPose?.z ?? event.position.y;
  const t = clientSpline.closestPointOnSpline({ x, z }).t;
  _impactSurfaceBaseY = bankedDatumYAtT(x, z, t);
  _impactOrigin.set(x, victimPose?.y ?? _impactSurfaceBaseY, z);
  return bankAngleAtT(t);
}

function spawnBlob(
  pools: PresentationPools,
  startMs: number,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  gravity: number,
  baseScale: number,
  growth: number,
  durationMs: number,
  color: number,
): void {
  const slot = claimBlob(pools);
  slot.startMs = startMs;
  slot.durationMs = durationMs;
  slot.x = x;
  slot.y = y;
  slot.z = z;
  slot.vx = vx;
  slot.vy = vy;
  slot.vz = vz;
  slot.gravity = gravity;
  slot.baseScale = baseScale;
  slot.growth = growth;
  slot.color = color;
}

function spawnRing(
  pools: PresentationPools,
  startMs: number,
  x: number,
  baseY: number,
  z: number,
  bank: number,
  startRadius: number,
  endRadius: number,
  rise: number,
  durationMs: number,
  color: number,
): void {
  const slot = claimRing(pools);
  slot.startMs = startMs;
  slot.durationMs = durationMs;
  slot.x = x;
  slot.baseY = baseY;
  slot.z = z;
  const trackT = clientSpline.closestPointOnSpline({ x, z }).t;
  const tangent = clientSpline.tangentAt(trackT);
  slot.yaw = Math.atan2(tangent.x, tangent.z);
  slot.bank = bank;
  slot.startRadius = startRadius;
  slot.endRadius = endRadius;
  slot.rise = rise;
  slot.color = color;
}

function spawnStreakBetween(
  pools: PresentationPools,
  startMs: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  width: number,
  durationMs: number,
  color: number,
): void {
  _position.set(x0, y0, z0);
  _end.set(x1, y1, z1);
  _direction.subVectors(_end, _position);
  const length = Math.max(.001, _direction.length());
  _direction.multiplyScalar(1 / length);
  _quaternion.setFromUnitVectors(_up, _direction);
  _midpoint.addVectors(_position, _end).multiplyScalar(.5);
  const slot = claimStreak(pools);
  slot.startMs = startMs;
  slot.durationMs = durationMs;
  slot.x = _midpoint.x;
  slot.y = _midpoint.y;
  slot.z = _midpoint.z;
  slot.vx = 0;
  slot.vy = 0;
  slot.vz = 0;
  slot.gravity = 0;
  slot.qx = _quaternion.x;
  slot.qy = _quaternion.y;
  slot.qz = _quaternion.z;
  slot.qw = _quaternion.w;
  slot.width = width;
  slot.length = length;
  slot.growth = 0;
  slot.color = color;
}

function spawnBallisticStreak(
  pools: PresentationPools,
  startMs: number,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  width: number,
  length: number,
  gravity: number,
  durationMs: number,
  color: number,
): void {
  _direction.set(vx, Math.max(80, vy), vz).normalize();
  _quaternion.setFromUnitVectors(_up, _direction);
  const slot = claimStreak(pools);
  slot.startMs = startMs;
  slot.durationMs = durationMs;
  slot.x = x;
  slot.y = y;
  slot.z = z;
  slot.vx = vx;
  slot.vy = vy;
  slot.vz = vz;
  slot.gravity = gravity;
  slot.qx = _quaternion.x;
  slot.qy = _quaternion.y;
  slot.qz = _quaternion.z;
  slot.qw = _quaternion.w;
  slot.width = width;
  slot.length = length;
  slot.growth = .45;
  slot.color = color;
}

function spawnInkExplosion(
  pools: PresentationPools,
  event: ReefPresentationVfxEvent,
): void {
  const bank = resolveImpactOrigin(event);
  const startMs = event.at;
  const seed = event.seq * 71;
  for (let i = 0; i < 18; i++) {
    const angle = hash01(seed + i * 3) * Math.PI * 2;
    const radius = 18 + hash01(seed + i * 3 + 1) * 105;
    const speed = 18 + hash01(seed + i * 3 + 2) * 95;
    spawnBlob(
      pools,
      startMs,
      _impactOrigin.x + Math.cos(angle) * radius,
      _impactOrigin.y + 45 + hash01(seed + i * 7) * 120,
      _impactOrigin.z + Math.sin(angle) * radius,
      Math.cos(angle) * speed,
      20 + hash01(seed + i * 11) * 95,
      Math.sin(angle) * speed,
      35,
      34 + hash01(seed + i * 13) * 42,
      1.35 + hash01(seed + i * 17) * 1.2,
      1_480,
      i % 4 === 0 ? 0x4e116d : i % 3 === 0 ? 0x190024 : 0x07000c,
    );
  }
  for (let i = 0; i < 30; i++) {
    const angle = hash01(seed + 100 + i * 5) * Math.PI * 2;
    const speed = 260 + hash01(seed + 101 + i * 5) * 390;
    spawnBlob(
      pools,
      startMs,
      _impactOrigin.x,
      _impactOrigin.y + 72,
      _impactOrigin.z,
      Math.cos(angle) * speed,
      210 + hash01(seed + 102 + i * 5) * 360,
      Math.sin(angle) * speed,
      520,
      10 + hash01(seed + 103 + i * 5) * 18,
      .28,
      1_260,
      i % 5 === 0 ? 0x6d238d : 0x110019,
    );
  }
  spawnRing(pools, startMs, _impactOrigin.x, _impactSurfaceBaseY, _impactOrigin.z, bank, 48, 430, 8, 1_320, 0x120019);
  spawnRing(pools, startMs + 90, _impactOrigin.x, _impactSurfaceBaseY, _impactOrigin.z, bank, 85, 570, 12, 1_390, 0x54136f);
  spawnRing(pools, startMs + 170, _impactOrigin.x, _impactSurfaceBaseY, _impactOrigin.z, bank, 120, 690, 18, 1_310, 0x09000e);
}

function spawnPufferDetonation(
  pools: PresentationPools,
  event: ReefPresentationVfxEvent,
): void {
  const bank = resolveImpactOrigin(event, false);
  const startMs = event.at;
  const flash = pools.pufferFlashes[pools.pufferCursor];
  pools.pufferCursor = (pools.pufferCursor + 1) % PUFFER_FLASH_CAPACITY;
  flash.active = true;
  flash.startMs = startMs;
  flash.durationMs = 620;
  flash.x = _impactOrigin.x;
  flash.baseY = _impactSurfaceBaseY;
  flash.z = _impactOrigin.z;
  flash.color = event.blocked ? 0x7df9ff : 0xffec9d;
  spawnRing(pools, startMs, _impactOrigin.x, _impactSurfaceBaseY, _impactOrigin.z, bank, 42, 510, 16, 1_020, event.blocked ? 0x76f7ff : 0xff3f76);
  spawnRing(pools, startMs + 80, _impactOrigin.x, _impactSurfaceBaseY, _impactOrigin.z, bank, 76, 650, 28, 1_080, 0xffdc88);
  for (let i = 0; i < 16; i++) {
    const angle = i / 16 * Math.PI * 2;
    const speed = 120 + (i % 4) * 32;
    spawnBallisticStreak(
      pools,
      startMs,
      _impactOrigin.x + Math.cos(angle) * 38,
      _impactOrigin.y + 28,
      _impactOrigin.z + Math.sin(angle) * 38,
      Math.cos(angle) * speed,
      330 + (i % 5) * 46,
      Math.sin(angle) * speed,
      7 + i % 3,
      86 + (i % 4) * 18,
      570,
      1_060,
      i % 2 === 0 ? 0xff5f9d : 0xffe7a1,
    );
  }
  for (let i = 0; i < 8; i++) {
    const angle = i / 8 * Math.PI * 2;
    spawnBlob(
      pools,
      startMs,
      _impactOrigin.x + Math.cos(angle) * 46,
      _impactOrigin.y + 58,
      _impactOrigin.z + Math.sin(angle) * 46,
      Math.cos(angle) * 135,
      165 + i * 18,
      Math.sin(angle) * 135,
      320,
      26 + (i % 3) * 9,
      1.1,
      900,
      i % 2 === 0 ? 0xff3f76 : 0xffd078,
    );
  }
}

function spawnTideSurge(
  pools: PresentationPools,
  event: ReefPresentationVfxEvent,
): void {
  const bank = resolveImpactOrigin(event);
  const startMs = event.at;
  spawnRing(pools, startMs, _impactOrigin.x, _impactSurfaceBaseY, _impactOrigin.z, bank, 70, 560, 28, 1_100, 0x4ddcff);
  spawnRing(pools, startMs + 110, _impactOrigin.x, _impactSurfaceBaseY, _impactOrigin.z, bank, 110, 720, 44, 1_180, 0xe8ffff);
  for (let i = 0; i < 13; i++) {
    const lateral = (i - 6) * 46;
    spawnBallisticStreak(
      pools,
      startMs,
      _impactOrigin.x + lateral,
      _impactOrigin.y + 12,
      _impactOrigin.z,
      lateral * .45,
      380 + Math.abs(i - 6) * 22,
      -70 + (i % 3) * 70,
      10 + i % 3,
      150 + (i % 4) * 32,
      480,
      1_120,
      i % 3 === 0 ? 0xffffff : 0x45dcff,
    );
  }
  for (let i = 0; i < 10; i++) {
    const angle = i / 10 * Math.PI * 2;
    spawnBlob(
      pools,
      startMs,
      _impactOrigin.x + Math.cos(angle) * 70,
      _impactOrigin.y + 46,
      _impactOrigin.z + Math.sin(angle) * 70,
      Math.cos(angle) * 180,
      130 + i * 15,
      Math.sin(angle) * 180,
      340,
      24 + (i % 4) * 8,
      .8,
      1_050,
      i % 2 === 0 ? 0xcfffff : 0x33bfe9,
    );
  }
}

function spawnWhirlpool(
  pools: PresentationPools,
  event: ReefPresentationVfxEvent,
): void {
  const bank = resolveImpactOrigin(event);
  const startMs = event.at;
  spawnRing(pools, startMs, _impactOrigin.x, _impactSurfaceBaseY, _impactOrigin.z, bank, 240, 74, -6, 1_360, 0x2658ff);
  spawnRing(pools, startMs + 100, _impactOrigin.x, _impactSurfaceBaseY, _impactOrigin.z, bank, 360, 96, -14, 1_380, 0x7d39dc);
  spawnRing(pools, startMs + 190, _impactOrigin.x, _impactSurfaceBaseY, _impactOrigin.z, bank, 480, 118, -22, 1_340, 0xff45a8);
  for (let i = 0; i < 18; i++) {
    const angle0 = i / 18 * Math.PI * 2;
    const angle1 = angle0 + .48;
    const radius0 = 150 + (i % 4) * 48;
    const radius1 = radius0 * .72;
    spawnStreakBetween(
      pools,
      startMs,
      _impactOrigin.x + Math.cos(angle0) * radius0,
      _impactOrigin.y + 22 + (i % 3) * 12,
      _impactOrigin.z + Math.sin(angle0) * radius0,
      _impactOrigin.x + Math.cos(angle1) * radius1,
      _impactOrigin.y + 34 + (i % 3) * 12,
      _impactOrigin.z + Math.sin(angle1) * radius1,
      8 + i % 3,
      1_260,
      i % 3 === 0 ? 0xff4ca8 : 0x396dff,
    );
  }
  for (let i = 0; i < 12; i++) {
    const angle = i / 12 * Math.PI * 2;
    spawnBlob(
      pools,
      startMs,
      _impactOrigin.x + Math.cos(angle) * 190,
      _impactOrigin.y + 32 + (i % 4) * 18,
      _impactOrigin.z + Math.sin(angle) * 190,
      -Math.cos(angle) * 150 - Math.sin(angle) * 80,
      34 + (i % 3) * 24,
      -Math.sin(angle) * 150 + Math.cos(angle) * 80,
      45,
      22 + (i % 4) * 8,
      .7,
      1_320,
      i % 3 === 0 ? 0xff49ad : 0x263b99,
    );
  }
}

function spawnBubbleStrike(
  pools: PresentationPools,
  event: ReefPresentationVfxEvent,
): void {
  const bank = resolveImpactOrigin(event);
  const attackerPose = event.attackerAvatarId
    ? getReefRaceRenderedPose(event.attackerAvatarId)
    : null;
  _secondaryOrigin.set(
    attackerPose?.x ?? _impactOrigin.x - 420,
    (attackerPose?.y ?? _impactOrigin.y) + 82,
    attackerPose?.z ?? _impactOrigin.z - 260,
  );
  const targetY = _impactOrigin.y + 86;
  const startMs = event.at;
  for (let strand = 0; strand < 3; strand++) {
    const offset = (strand - 1) * 15;
    for (let i = 0; i < 7; i++) {
      const a0 = i / 7;
      const a1 = (i + 1) / 7;
      const x0 = _secondaryOrigin.x + (_impactOrigin.x - _secondaryOrigin.x) * a0 + offset;
      const y0 = _secondaryOrigin.y + (targetY - _secondaryOrigin.y) * a0 + Math.sin(a0 * Math.PI) * 58;
      const z0 = _secondaryOrigin.z + (_impactOrigin.z - _secondaryOrigin.z) * a0 - offset;
      const x1 = _secondaryOrigin.x + (_impactOrigin.x - _secondaryOrigin.x) * a1 + offset;
      const y1 = _secondaryOrigin.y + (targetY - _secondaryOrigin.y) * a1 + Math.sin(a1 * Math.PI) * 58;
      const z1 = _secondaryOrigin.z + (_impactOrigin.z - _secondaryOrigin.z) * a1 - offset;
      spawnStreakBetween(pools, startMs, x0, y0, z0, x1, y1, z1, strand === 1 ? 12 : 7, 680, strand === 1 ? 0xffffff : 0x46eaff);
    }
  }
  spawnRing(pools, startMs, _impactOrigin.x, _impactSurfaceBaseY, _impactOrigin.z, bank, 55, 330, 30, 900, 0x6ff7ff);
  for (let i = 0; i < 9; i++) {
    const angle = i / 9 * Math.PI * 2;
    spawnBlob(
      pools,
      startMs,
      _impactOrigin.x + Math.cos(angle) * 84,
      _impactOrigin.y + 70 + (i % 3) * 35,
      _impactOrigin.z + Math.sin(angle) * 84,
      Math.cos(angle) * 95,
      80 + i * 13,
      Math.sin(angle) * 95,
      120,
      16 + (i % 3) * 8,
      .65,
      920,
      i % 3 === 0 ? 0xffffff : 0x5af1ff,
    );
  }
}

function spawnGenericHit(
  pools: PresentationPools,
  event: ReefPresentationVfxEvent,
): void {
  const bank = resolveImpactOrigin(event);
  const startMs = event.at;
  spawnRing(pools, startMs, _impactOrigin.x, _impactSurfaceBaseY, _impactOrigin.z, bank, 44, 260, 18, 720, 0xfff1a8);
  for (let i = 0; i < 6; i++) {
    const angle = i / 6 * Math.PI * 2;
    spawnBlob(
      pools,
      startMs,
      _impactOrigin.x,
      _impactOrigin.y + 60,
      _impactOrigin.z,
      Math.cos(angle) * 160,
      140 + i * 24,
      Math.sin(angle) * 160,
      360,
      18 + (i % 3) * 8,
      .65,
      760,
      i % 2 === 0 ? 0xffffff : 0xffd86b,
    );
  }
}

function spawnSwapArc(
  pools: PresentationPools,
  event: ReefPresentationVfxEvent,
): void {
  const attacker = event.attackerAvatarId
    ? getReefRaceRenderedPose(event.attackerAvatarId)
    : null;
  const victim = event.victimAvatarId
    ? getReefRaceRenderedPose(event.victimAvatarId)
    : null;
  if (!attacker || !victim) return;
  const startMs = event.at;
  const apex = 250 + Math.min(180, Math.hypot(victim.x - attacker.x, victim.z - attacker.z) * .12);
  for (let i = 0; i < 12; i++) {
    const a0 = i / 12;
    const a1 = (i + 1) / 12;
    const x0 = attacker.x + (victim.x - attacker.x) * a0;
    const z0 = attacker.z + (victim.z - attacker.z) * a0;
    const y0 = attacker.y + (victim.y - attacker.y) * a0 + 4 * a0 * (1 - a0) * apex;
    const x1 = attacker.x + (victim.x - attacker.x) * a1;
    const z1 = attacker.z + (victim.z - attacker.z) * a1;
    const y1 = attacker.y + (victim.y - attacker.y) * a1 + 4 * a1 * (1 - a1) * apex;
    spawnStreakBetween(pools, startMs, x0, y0 + 54, z0, x1, y1 + 54, z1, i % 3 === 0 ? 15 : 10, 1_180, i % 2 === 0 ? 0xff4fec : 0xffffff);
  }
  const attackerT = clientSpline.closestPointOnSpline({ x: attacker.x, z: attacker.z }).t;
  const victimT = clientSpline.closestPointOnSpline({ x: victim.x, z: victim.z }).t;
  spawnRing(pools, startMs, attacker.x, bankedDatumYAtT(attacker.x, attacker.z, attackerT), attacker.z, bankAngleAtT(attackerT), 45, 290, 24, 1_100, 0xff3be7);
  spawnRing(pools, startMs, victim.x, bankedDatumYAtT(victim.x, victim.z, victimT), victim.z, bankAngleAtT(victimT), 45, 290, 24, 1_100, 0xff3be7);
}

function spawnPresentationEvent(
  pools: PresentationPools,
  event: ReefPresentationVfxEvent,
): void {
  if (event.type === 'puffer-detonation') {
    spawnPufferDetonation(pools, event);
    return;
  }
  if (event.type === 'current-swap') {
    if (event.swapPhase === 'resolved') spawnSwapArc(pools, event);
    return;
  }
  switch (event.itemKind) {
    case 'rr-ink-slick':
      spawnInkExplosion(pools, event);
      break;
    case 'rr-puffer-mine':
      // Exact mine-position puffer event supplies the spectacle.
      break;
    case 'rr-tide-wave':
      spawnTideSurge(pools, event);
      break;
    case 'rr-whirlpool':
      spawnWhirlpool(pools, event);
      break;
    case 'rr-bubble-beam':
      spawnBubbleStrike(pools, event);
      break;
    default:
      spawnGenericHit(pools, event);
      break;
  }
}

export default function ReefRaceHecticFX() {
  const mineRef = useRef<THREE.InstancedMesh>(null);
  const targetRef = useRef<THREE.InstancedMesh>(null);
  const waveRef = useRef<THREE.InstancedMesh>(null);
  const blobRef = useRef<THREE.InstancedMesh>(null);
  const ringRef = useRef<THREE.InstancedMesh>(null);
  const streakRef = useRef<THREE.InstancedMesh>(null);
  const mineMap = useActivityStore((state) => state.reefMines);
  const entities = useActivityStore((state) => state.entities as Map<string, ReefRaceEntity>);
  const activeWave = useActivityStore((state) => state.activeWave);
  const swapEvent = useActivityStore((state) => state.lastCurrentSwapEvent);
  const presentationEvents = useActivityStore((state) => state.reefPresentationVfxEvents);
  const serverClockOffsetMs = useActivityStore((state) => state.serverClockOffsetMs);
  const mines = useMemo(() => Array.from(mineMap.values()).map(resolveMine), [mineMap]);
  const entityList = useMemo(() => Array.from(entities.values()), [entities]);
  const pools = useMemo(createPresentationPools, []);
  const clockOffsetRef = useRef(serverClockOffsetMs);
  clockOffsetRef.current = serverClockOffsetMs;

  useEffect(() => {
    initializeMesh(mineRef.current, MAX_MINES + PUFFER_FLASH_CAPACITY);
    initializeMesh(targetRef.current, TARGET_CAPACITY);
    initializeMesh(waveRef.current, WAVE_SEGMENTS);
    initializeMesh(blobRef.current, BLOB_CAPACITY);
    initializeMesh(ringRef.current, RING_CAPACITY);
    initializeMesh(streakRef.current, STREAK_CAPACITY);
  }, []);

  useEffect(() => {
    const nowMs = Date.now();
    let newestSeq = pools.lastSeq;
    for (let i = 0; i < presentationEvents.length; i++) {
      const event = presentationEvents[i];
      if (event.seq <= pools.lastSeq) continue;
      if (event.seq > newestSeq) newestSeq = event.seq;
      if (nowMs - event.at > EVENT_REPLAY_MAX_AGE_MS) continue;
      spawnPresentationEvent(pools, event);
    }
    pools.lastSeq = newestSeq;
  }, [pools, presentationEvents]);

  useEffect(() => () => {
    for (let i = 0; i < pools.blobs.length; i++) pools.blobs[i].active = false;
    for (let i = 0; i < pools.rings.length; i++) pools.rings[i].active = false;
    for (let i = 0; i < pools.streaks.length; i++) pools.streaks[i].active = false;
    for (let i = 0; i < pools.pufferFlashes.length; i++) pools.pufferFlashes[i].active = false;
  }, [pools]);

  useFrame(({ clock }) => {
    const mineMesh = mineRef.current;
    const targetMesh = targetRef.current;
    const waveMesh = waveRef.current;
    const blobMesh = blobRef.current;
    const ringMesh = ringRef.current;
    const streakMesh = streakRef.current;
    if (!mineMesh || !targetMesh || !waveMesh || !blobMesh || !ringMesh || !streakMesh) return;
    const elapsed = clock.elapsedTime;
    const nowMs = Date.now();
    const serverNowMs = nowMs - (clockOffsetRef.current ?? 0);

    let mineCount = 0;
    let armedMineVisible = false;
    for (let i = 0; i < mines.length && mineCount < MAX_MINES; i++) {
      const mine = mines[i];
      if (!mine.active || serverNowMs >= mine.expiresAtMs) continue;
      const armed = serverNowMs >= mine.armedAtMs;
      armedMineVisible ||= armed;
      const bob = Math.sin(elapsed * 3.2 + i * .83) * 7;
      _position.set(mine.x, mine.baseY + surfWaveHeightAt(mine.x, mine.z, elapsed) + 35 + bob, mine.z);
      _quaternion.identity();
      _scale.setScalar(armed ? 1 + Math.sin(elapsed * 8.5 + i) * .16 : .74 + Math.sin(elapsed * 4 + i) * .05);
      _matrix.compose(_position, _quaternion, _scale);
      mineMesh.setMatrixAt(mineCount, _matrix);
      _color.setHex(armed ? 0xff2f6f : 0xffd46e);
      mineMesh.setColorAt(mineCount, _color);
      mineCount++;
    }
    for (let i = 0; i < PUFFER_FLASH_CAPACITY && mineCount < MAX_MINES + PUFFER_FLASH_CAPACITY; i++) {
      const flash = pools.pufferFlashes[i];
      if (!flash.active) continue;
      const age = (nowMs - flash.startMs) / flash.durationMs;
      if (age < 0) continue;
      if (age >= 1) {
        flash.active = false;
        continue;
      }
      const envelope = age < .24 ? .7 + age / .24 * 2.1 : 2.8 * (1 - age);
      _position.set(
        flash.x,
        flash.baseY + surfWaveHeightAt(flash.x, flash.z, elapsed) + 54 + age * 48,
        flash.z,
      );
      _quaternion.identity();
      _scale.setScalar(envelope);
      _matrix.compose(_position, _quaternion, _scale);
      mineMesh.setMatrixAt(mineCount, _matrix);
      _color.setHex(flash.color);
      mineMesh.setColorAt(mineCount, _color);
      mineCount++;
    }
    _pufferMaterial.emissiveIntensity = armedMineVisible
      ? 1.05 + Math.sin(elapsed * 9) * .38
      : .78;
    mineMesh.count = mineCount;
    mineMesh.instanceMatrix.needsUpdate = mineCount > 0;
    if (mineCount > 0 && mineMesh.instanceColor) mineMesh.instanceColor.needsUpdate = true;

    let targetCount = 0;
    for (let entityIndex = 0; entityIndex < entityList.length; entityIndex++) {
      if (targetCount >= TARGET_CAPACITY) break;
      const entity = entityList[entityIndex];
      const avatarId = entity.avatarId;
      const bubbled = (entity.bubbledUntilMs ?? 0) > serverNowMs;
      const remora = (entity.remoraUntilMs ?? 0) > serverNowMs;
      const swapTelegraph = swapEvent?.phase === 'telegraph'
        && swapEvent.victimAvatarId === avatarId
        && swapEvent.resolvesAtMs > serverNowMs;
      if (!bubbled && !swapTelegraph && !remora) continue;
      const pose = getReefRaceRenderedPose(avatarId);
      if (!pose) continue;
      if (bubbled && targetCount + 1 < TARGET_CAPACITY) {
        const pulse = 1 + Math.sin(elapsed * 5.4 + entityIndex) * .075;
        _position.set(pose.x, pose.y + 62, pose.z);
        _quaternion.identity();
        _scale.setScalar(178 * pulse);
        _matrix.compose(_position, _quaternion, _scale);
        targetMesh.setMatrixAt(targetCount, _matrix);
        _color.setHex(0x62efff);
        targetMesh.setColorAt(targetCount++, _color);
        _scale.setScalar(143 * (1.04 - pulse * .04));
        _matrix.compose(_position, _quaternion, _scale);
        targetMesh.setMatrixAt(targetCount, _matrix);
        _color.setHex(0xd9ffff);
        targetMesh.setColorAt(targetCount++, _color);
      }
      if (swapTelegraph && targetCount < TARGET_CAPACITY) {
        const pulse = 1 + Math.sin(elapsed * 12 + entityIndex) * .13;
        _position.set(pose.x, pose.y + 48, pose.z);
        _quaternion.identity();
        _scale.setScalar(154 * pulse);
        _matrix.compose(_position, _quaternion, _scale);
        targetMesh.setMatrixAt(targetCount, _matrix);
        _color.setHex(0xff3eec);
        targetMesh.setColorAt(targetCount++, _color);
      }
      if (remora && targetCount < TARGET_CAPACITY) {
        const pulse = 1 + Math.sin(elapsed * 8 + entityIndex) * .08;
        _position.set(pose.x, pose.y + 42, pose.z);
        _euler.set(0, pose.rot, 0, 'YXZ');
        _quaternion.setFromEuler(_euler);
        _scale.set(78 * pulse, 52 * pulse, 168 * pulse);
        _matrix.compose(_position, _quaternion, _scale);
        targetMesh.setMatrixAt(targetCount, _matrix);
        _color.setHex(0xff9f32);
        targetMesh.setColorAt(targetCount++, _color);
      }
    }
    targetMesh.count = targetCount;
    targetMesh.instanceMatrix.needsUpdate = targetCount > 0;
    if (targetCount > 0 && targetMesh.instanceColor) targetMesh.instanceColor.needsUpdate = true;

    // Reserve capacity for deadline-driven effects before rendering transient
    // event slots. A same-tick AoE burst may fill every cursor slot, but it
    // must never erase the Bubble prison or Remora trail that communicates an
    // authority lock for its full deadline.
    let persistentBlobReserve = 0;
    let persistentRingReserve = 0;
    let persistentStreakReserve = 0;
    for (let entityIndex = 0; entityIndex < entityList.length; entityIndex++) {
      const entity = entityList[entityIndex];
      if ((entity.bubbledUntilMs ?? 0) > serverNowMs) {
        persistentBlobReserve += 5;
        persistentRingReserve += 2;
      }
      if ((entity.remoraUntilMs ?? 0) > serverNowMs) {
        persistentBlobReserve += 4;
        persistentStreakReserve += 8;
      }
    }

    let blobCount = 0;
    const transientBlobLimit = Math.max(0, BLOB_CAPACITY - persistentBlobReserve);
    for (let i = 0; i < BLOB_CAPACITY && blobCount < transientBlobLimit; i++) {
      const slot = pools.blobs[i];
      if (!slot.active) continue;
      const age = (nowMs - slot.startMs) / slot.durationMs;
      if (age < 0) continue;
      if (age >= 1) {
        slot.active = false;
        continue;
      }
      const seconds = (nowMs - slot.startMs) * .001;
      const eased = easeOutCubic(age);
      const fadeScale = Math.min(1, (1 - age) * 3.2);
      const size = slot.baseScale * (1 + slot.growth * eased) * fadeScale;
      _position.set(
        slot.x + slot.vx * seconds,
        slot.y + slot.vy * seconds - .5 * slot.gravity * seconds * seconds,
        slot.z + slot.vz * seconds,
      );
      _quaternion.identity();
      _scale.setScalar(Math.max(.01, size));
      _matrix.compose(_position, _quaternion, _scale);
      blobMesh.setMatrixAt(blobCount, _matrix);
      _color.setHex(slot.color);
      blobMesh.setColorAt(blobCount++, _color);
    }
    // Persistent shimmer/wake instances consume their reserved tail.
    for (let entityIndex = 0; entityIndex < entityList.length && blobCount < BLOB_CAPACITY; entityIndex++) {
      const entity = entityList[entityIndex];
      const pose = getReefRaceRenderedPose(entity.avatarId);
      if (!pose) continue;
      const bubbled = (entity.bubbledUntilMs ?? 0) > serverNowMs;
      const remora = (entity.remoraUntilMs ?? 0) > serverNowMs;
      if (bubbled) {
        for (let i = 0; i < 5 && blobCount < BLOB_CAPACITY; i++) {
          const angle = elapsed * (1.2 + i * .11) + i * 1.257;
          const radius = 128 + (i % 2) * 28;
          _position.set(
            pose.x + Math.cos(angle) * radius,
            pose.y + 55 + Math.sin(angle * 1.7) * 96,
            pose.z + Math.sin(angle) * radius,
          );
          _quaternion.identity();
          _scale.setScalar(11 + (i % 3) * 5);
          _matrix.compose(_position, _quaternion, _scale);
          blobMesh.setMatrixAt(blobCount, _matrix);
          _color.setHex(i % 2 === 0 ? 0xffffff : 0x63efff);
          blobMesh.setColorAt(blobCount++, _color);
        }
      }
      if (remora) {
        const forwardX = Math.sin(pose.rot);
        const forwardZ = Math.cos(pose.rot);
        const sideX = forwardZ;
        const sideZ = -forwardX;
        for (let i = 0; i < 4 && blobCount < BLOB_CAPACITY; i++) {
          const distance = 90 + i * 58;
          const side = (i % 2 === 0 ? -1 : 1) * (28 + i * 7);
          _position.set(
            pose.x - forwardX * distance + sideX * side,
            pose.y + 18 + Math.sin(elapsed * 12 + i) * 18,
            pose.z - forwardZ * distance + sideZ * side,
          );
          _quaternion.identity();
          _scale.set(18 + i * 3, 10 + i * 2, 36 + i * 9);
          _matrix.compose(_position, _quaternion, _scale);
          blobMesh.setMatrixAt(blobCount, _matrix);
          _color.setHex(i % 2 === 0 ? 0xffe17a : 0xff8b2e);
          blobMesh.setColorAt(blobCount++, _color);
        }
      }
    }
    blobMesh.count = blobCount;
    blobMesh.instanceMatrix.needsUpdate = blobCount > 0;
    if (blobCount > 0 && blobMesh.instanceColor) blobMesh.instanceColor.needsUpdate = true;

    let ringCount = 0;
    const transientRingLimit = Math.max(0, RING_CAPACITY - persistentRingReserve);
    for (let i = 0; i < RING_CAPACITY && ringCount < transientRingLimit; i++) {
      const slot = pools.rings[i];
      if (!slot.active) continue;
      const age = (nowMs - slot.startMs) / slot.durationMs;
      if (age < 0) continue;
      if (age >= 1) {
        slot.active = false;
        continue;
      }
      const eased = easeOutCubic(age);
      const radius = slot.startRadius + (slot.endRadius - slot.startRadius) * eased;
      const fadeScale = Math.min(1, (1 - age) * 4);
      _position.set(
        slot.x,
        slot.baseY + surfWaveHeightAt(slot.x, slot.z, elapsed) + 9 + slot.rise * age,
        slot.z,
      );
      _euler.set(0, slot.yaw, -slot.bank, 'YXZ');
      _quaternion.setFromEuler(_euler);
      _scale.set(radius, Math.max(.08, fadeScale * 1.8), radius);
      _matrix.compose(_position, _quaternion, _scale);
      ringMesh.setMatrixAt(ringCount, _matrix);
      _color.setHex(slot.color);
      ringMesh.setColorAt(ringCount++, _color);
    }
    for (let entityIndex = 0; entityIndex < entityList.length && ringCount + 1 < RING_CAPACITY; entityIndex++) {
      const entity = entityList[entityIndex];
      if ((entity.bubbledUntilMs ?? 0) <= serverNowMs) continue;
      const pose = getReefRaceRenderedPose(entity.avatarId);
      if (!pose) continue;
      for (let i = 0; i < 2; i++) {
        _position.set(pose.x, pose.y + 58 + (i - .5) * 88, pose.z);
        _euler.set(elapsed * (i === 0 ? .8 : -.65), elapsed * .5, i === 0 ? .35 : -.42, 'YXZ');
        _quaternion.setFromEuler(_euler);
        const radius = 152 + Math.sin(elapsed * 5 + i) * 9;
        _scale.set(radius, 1.35, radius);
        _matrix.compose(_position, _quaternion, _scale);
        ringMesh.setMatrixAt(ringCount, _matrix);
        _color.setHex(i === 0 ? 0xdfffff : 0x4aeaff);
        ringMesh.setColorAt(ringCount++, _color);
      }
    }
    ringMesh.count = ringCount;
    ringMesh.instanceMatrix.needsUpdate = ringCount > 0;
    if (ringCount > 0 && ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;

    let streakCount = 0;
    const transientStreakLimit = Math.max(0, STREAK_CAPACITY - persistentStreakReserve);
    for (let i = 0; i < STREAK_CAPACITY && streakCount < transientStreakLimit; i++) {
      const slot = pools.streaks[i];
      if (!slot.active) continue;
      const age = (nowMs - slot.startMs) / slot.durationMs;
      if (age < 0) continue;
      if (age >= 1) {
        slot.active = false;
        continue;
      }
      const seconds = (nowMs - slot.startMs) * .001;
      const fadeScale = Math.min(1, (1 - age) * 3.5);
      _position.set(
        slot.x + slot.vx * seconds,
        slot.y + slot.vy * seconds - .5 * slot.gravity * seconds * seconds,
        slot.z + slot.vz * seconds,
      );
      _quaternion.set(slot.qx, slot.qy, slot.qz, slot.qw);
      _scale.set(
        Math.max(.01, slot.width * fadeScale),
        Math.max(.01, slot.length * (1 + slot.growth * age) * fadeScale),
        Math.max(.01, slot.width * fadeScale),
      );
      _matrix.compose(_position, _quaternion, _scale);
      streakMesh.setMatrixAt(streakCount, _matrix);
      _color.setHex(slot.color);
      streakMesh.setColorAt(streakCount++, _color);
    }
    for (let entityIndex = 0; entityIndex < entityList.length && streakCount < STREAK_CAPACITY; entityIndex++) {
      const entity = entityList[entityIndex];
      if ((entity.remoraUntilMs ?? 0) <= serverNowMs) continue;
      const pose = getReefRaceRenderedPose(entity.avatarId);
      if (!pose) continue;
      const forwardX = Math.sin(pose.rot);
      const forwardZ = Math.cos(pose.rot);
      _direction.set(-forwardX, .035, -forwardZ).normalize();
      _quaternion.setFromUnitVectors(_up, _direction);
      for (let i = 0; i < 8 && streakCount < STREAK_CAPACITY; i++) {
        const distance = 110 + i * 54;
        const pulse = 1 + Math.sin(elapsed * 13 - i * .8) * .18;
        _position.set(
          pose.x - forwardX * distance,
          pose.y + 34 + (i % 2) * 16,
          pose.z - forwardZ * distance,
        );
        _scale.set((13 - i * .65) * pulse, (190 + i * 28) * pulse, (13 - i * .65) * pulse);
        _matrix.compose(_position, _quaternion, _scale);
        streakMesh.setMatrixAt(streakCount, _matrix);
        _color.setHex(i % 3 === 0 ? 0xffffff : i % 2 === 0 ? 0xffd75e : 0xff7b24);
        streakMesh.setColorAt(streakCount++, _color);
      }
    }
    streakMesh.count = streakCount;
    streakMesh.instanceMatrix.needsUpdate = streakCount > 0;
    if (streakCount > 0 && streakMesh.instanceColor) streakMesh.instanceColor.needsUpdate = true;

    let waveCount = 0;
    if (activeWave && serverNowMs < activeWave.endsAtMs) {
      const activeElapsedMs = Math.max(0, serverNowMs - activeWave.startsAtMs);
      const headProgress = activeWave.phase === 'active'
        ? activeWave.startProgress
          + activeElapsedMs * .001 * activeWave.sweepSpeedWuPerSec / clientSpline.totalArcLength
        : activeWave.startProgress;
      const lengthProgress = activeWave.bandLengthWu / clientSpline.totalArcLength;
      const segmentHalfLength = activeWave.bandLengthWu / WAVE_SEGMENTS * .58;
      for (let i = 0; i < WAVE_SEGMENTS; i++) {
        let progress = headProgress - lengthProgress * i / Math.max(1, WAVE_SEGMENTS - 1);
        progress -= Math.floor(progress);
        const lutFloat = progress * WAVE_LUT_SIZE;
        const lutIndex = Math.floor(lutFloat) % WAVE_LUT_SIZE;
        const lutNext = (lutIndex + 1) % WAVE_LUT_SIZE;
        const lutAlpha = lutFloat - Math.floor(lutFloat);
        const x = _waveX[lutIndex] + (_waveX[lutNext] - _waveX[lutIndex]) * lutAlpha;
        const z = _waveZ[lutIndex] + (_waveZ[lutNext] - _waveZ[lutIndex]) * lutAlpha;
        const y = _waveY[lutIndex] + (_waveY[lutNext] - _waveY[lutIndex]) * lutAlpha;
        const bank = _waveBank[lutIndex] + (_waveBank[lutNext] - _waveBank[lutIndex]) * lutAlpha;
        let rotationDelta = _waveRot[lutNext] - _waveRot[lutIndex];
        if (rotationDelta > Math.PI) rotationDelta -= Math.PI * 2;
        else if (rotationDelta < -Math.PI) rotationDelta += Math.PI * 2;
        const rotation = _waveRot[lutIndex] + rotationDelta * lutAlpha;
        const width = _waveWidth[lutIndex] + (_waveWidth[lutNext] - _waveWidth[lutIndex]) * lutAlpha;
        const wallScale = activeWave.phase === 'telegraph'
          ? i === 0 ? .62 : .2
          : i === 0 ? 1.82 : i === 1 ? 1.05 : .3;
        _position.set(x, y + surfWaveHeightAt(x, z, elapsed) + 6, z);
        _euler.set(0, rotation, -bank, 'YXZ');
        _quaternion.setFromEuler(_euler);
        _scale.set(width, wallScale, segmentHalfLength);
        _matrix.compose(_position, _quaternion, _scale);
        waveMesh.setMatrixAt(waveCount++, _matrix);
      }
      _waveMaterial.opacity = activeWave.phase === 'telegraph'
        ? .4 + Math.sin(elapsed * 8) * .12
        : .76 + Math.sin(elapsed * 5) * .1;
    }
    waveMesh.count = waveCount;
    waveMesh.instanceMatrix.needsUpdate = waveCount > 0;
  });

  return (
    <>
      <instancedMesh
        name="reef-puffer-mines"
        ref={mineRef}
        args={[_pufferGeometry, _pufferMaterial, MAX_MINES + PUFFER_FLASH_CAPACITY]}
        frustumCulled={false}
      />
      <instancedMesh
        name="reef-wave-sweep"
        ref={waveRef}
        args={[_waveGeometry, _waveMaterial, WAVE_SEGMENTS]}
        frustumCulled={false}
      />
      <instancedMesh
        name="reef-bubble-swap-targets"
        ref={targetRef}
        args={[_targetGeometry, _targetMaterial, TARGET_CAPACITY]}
        frustumCulled={false}
      />
      <instancedMesh
        name="reef-item-event-blobs"
        ref={blobRef}
        args={[_blobGeometry, _blobMaterial, BLOB_CAPACITY]}
        frustumCulled={false}
      />
      <instancedMesh
        name="reef-item-event-rings"
        ref={ringRef}
        args={[_ringGeometry, _ringMaterial, RING_CAPACITY]}
        frustumCulled={false}
      />
      <instancedMesh
        name="reef-item-event-streaks"
        ref={streakRef}
        args={[_streakGeometry, _streakMaterial, STREAK_CAPACITY]}
        frustumCulled={false}
      />
    </>
  );
}
