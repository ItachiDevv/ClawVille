'use client';

/**
 * R18d world presentation in exactly three built-in-material instanced draws:
 * puffer mines, the rolling wave strip, and shared bubble/swap target spheres.
 * Gameplay and timing remain server-owned; this layer only mirrors store state.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ReefPufferMineState } from '@clawville/shared';
import { useActivityStore } from '@/stores/activity';
import { bankAngleAtT, bankedDatumYAtT } from './reef-race-elevation';
import { clientSpline } from './reef-race-spline-instance';
import { surfWaveHeightAt } from './reef-wave-height';
import { getReefRaceRenderedPose } from './ReefRacePlayer';
import type { ReefRaceEntity } from './reef-race-types';

const MAX_MINES = 64;
const MAX_RACERS = 8;
const WAVE_SEGMENTS = 14;
const WAVE_LUT_SIZE = 512;

const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _color = new THREE.Color();

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
    const plane = colorGeometry(
      new THREE.PlaneGeometry(i % 3 === 0 ? .12 : .065, 2),
      i % 2 === 0 ? '#d8ffff' : '#66ecff',
    );
    plane.translate(offsets[i], 0, 0);
    parts.push(plane);
  }
  const geometry = merge(parts);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

const _pufferGeometry = buildPufferGeometry();
const _pufferMaterial = new THREE.MeshStandardMaterial({
  color: '#fb5f9d', emissive: '#7d153f', emissiveIntensity: .55,
  roughness: .66, metalness: .05,
});
const _targetGeometry = new THREE.SphereGeometry(1, 16, 10);
const _targetMaterial = new THREE.MeshBasicMaterial({
  color: '#ffffff', transparent: true, opacity: .28, depthWrite: false,
  side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
});
_targetMaterial.forceSinglePass = true;
const _waveGeometry = buildWaveGeometry();
const _waveMaterial = new THREE.MeshBasicMaterial({
  vertexColors: true, transparent: true, opacity: .5, depthWrite: false,
  side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
});
_waveMaterial.forceSinglePass = true;

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
  for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, _zero);
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
}

export default function ReefRaceHecticFX() {
  const mineRef = useRef<THREE.InstancedMesh>(null);
  const targetRef = useRef<THREE.InstancedMesh>(null);
  const waveRef = useRef<THREE.InstancedMesh>(null);
  const mineMap = useActivityStore((state) => state.reefMines);
  const entities = useActivityStore((state) => state.entities as Map<string, ReefRaceEntity>);
  const activeWave = useActivityStore((state) => state.activeWave);
  const swapEvent = useActivityStore((state) => state.lastCurrentSwapEvent);
  const serverClockOffsetMs = useActivityStore((state) => state.serverClockOffsetMs);
  const mines = useMemo(() => Array.from(mineMap.values()).map(resolveMine), [mineMap]);
  const entityList = useMemo(() => Array.from(entities.values()), [entities]);
  const clockOffsetRef = useRef(serverClockOffsetMs);
  clockOffsetRef.current = serverClockOffsetMs;

  useEffect(() => {
    initializeMesh(mineRef.current, MAX_MINES);
    initializeMesh(targetRef.current, MAX_RACERS);
    initializeMesh(waveRef.current, WAVE_SEGMENTS);
  }, []);

  useFrame(({ clock }) => {
    const mineMesh = mineRef.current;
    const targetMesh = targetRef.current;
    const waveMesh = waveRef.current;
    if (!mineMesh || !targetMesh || !waveMesh) return;
    const elapsed = clock.elapsedTime;
    const serverNowMs = Date.now() - (clockOffsetRef.current ?? 0);

    let mineCount = 0;
    for (let i = 0; i < mines.length && mineCount < MAX_MINES; i++) {
      const mine = mines[i];
      if (!mine.active || serverNowMs >= mine.expiresAtMs) continue;
      const armed = serverNowMs >= mine.armedAtMs;
      const bob = Math.sin(elapsed * 3.2 + i * .83) * 7;
      _position.set(mine.x, mine.baseY + surfWaveHeightAt(mine.x, mine.z, elapsed) + 35 + bob, mine.z);
      _quaternion.identity();
      _scale.setScalar(armed ? 1 + Math.sin(elapsed * 6 + i) * .08 : .74);
      _matrix.compose(_position, _quaternion, _scale);
      mineMesh.setMatrixAt(mineCount, _matrix);
      _color.set(armed ? '#ff3f76' : '#ffca67');
      mineMesh.setColorAt(mineCount, _color);
      mineCount++;
    }
    mineMesh.count = mineCount;
    mineMesh.instanceMatrix.needsUpdate = mineCount > 0;
    if (mineCount > 0 && mineMesh.instanceColor) mineMesh.instanceColor.needsUpdate = true;

    let targetCount = 0;
    for (let entityIndex = 0; entityIndex < entityList.length; entityIndex++) {
      if (targetCount >= MAX_RACERS) break;
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
      _position.set(pose.x, pose.y + (bubbled ? 54 : 42), pose.z);
      if (remora && !bubbled && !swapTelegraph) {
        _euler.set(0, pose.rot, 0, 'YXZ');
        _quaternion.setFromEuler(_euler);
      } else {
        _quaternion.identity();
      }
      const pulse = 1 + Math.sin(elapsed * (swapTelegraph ? 11 : 4.5) + targetCount) * .09;
      if (remora && !bubbled && !swapTelegraph) {
        _scale.set(72 * pulse, 48 * pulse, 155 * pulse);
      } else {
        _scale.setScalar((swapTelegraph ? 128 : 104) * pulse);
      }
      _matrix.compose(_position, _quaternion, _scale);
      targetMesh.setMatrixAt(targetCount, _matrix);
      _color.set(swapTelegraph ? '#ff3eec' : remora && !bubbled ? '#ff9f32' : '#59efff');
      targetMesh.setColorAt(targetCount, _color);
      targetCount++;
    }
    targetMesh.count = targetCount;
    targetMesh.instanceMatrix.needsUpdate = targetCount > 0;
    if (targetCount > 0 && targetMesh.instanceColor) targetMesh.instanceColor.needsUpdate = true;

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
        _position.set(x, y + surfWaveHeightAt(x, z, elapsed) + 6, z);
        _euler.set(0, rotation, -bank, 'YXZ');
        _quaternion.setFromEuler(_euler);
        _scale.set(width, 1, segmentHalfLength);
        _matrix.compose(_position, _quaternion, _scale);
        waveMesh.setMatrixAt(waveCount++, _matrix);
      }
      _waveMaterial.opacity = activeWave.phase === 'telegraph'
        ? .32 + Math.sin(elapsed * 8) * .12
        : .58 + Math.sin(elapsed * 5) * .08;
    }
    waveMesh.count = waveCount;
    waveMesh.instanceMatrix.needsUpdate = waveCount > 0;
  });

  return (
    <>
      <instancedMesh name="reef-puffer-mines" ref={mineRef} args={[_pufferGeometry, _pufferMaterial, MAX_MINES]} frustumCulled={false} />
      <instancedMesh name="reef-wave-sweep" ref={waveRef} args={[_waveGeometry, _waveMaterial, WAVE_SEGMENTS]} frustumCulled={false} />
      <instancedMesh name="reef-bubble-swap-targets" ref={targetRef} args={[_targetGeometry, _targetMaterial, MAX_RACERS]} frustumCulled={false} />
    </>
  );
}
