'use client';

/**
 * Seeded Reef Race obstacles + rip-current presentation.
 *
 * Draw ledger (hard Iris-Xe budget):
 *   1 kelp clumps · 1 urchin balls · 1 driftwood logs · 1 creature silhouettes
 *   · 1 combined creature shadow/spray telegraph · 1 rip-current streak bands.
 *
 * Every batch uses a built-in material. Geometry and render-loop scratch live at
 * module scope. All batches update Y against the wave mirror; only the one or two
 * creature crossings and telegraphs change XZ/visibility. Authority stays server-side.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type {
  ReefRaceCreatureMotion,
  ReefRaceObstacleLayout,
  ReefRaceRipSegment,
} from '@clawville/shared';
import { reefRaceCreatureMotionAt } from '@clawville/shared';
import { useActivityStore } from '@/stores/activity';
import { bankAngleAtT, bankedDatumYAtT } from './reef-race-elevation';
import { clientSpline } from './reef-race-spline-instance';
import { surfWaveHeightAt } from './reef-wave-height';

const MAX_KELP = 5;
const MAX_URCHINS = 4;
const MAX_DRIFTWOOD = 3;
const MAX_CREATURES = 2;
const MAX_RIP_SEGMENTS = 12;

const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _creatureMotion: ReefRaceCreatureMotion = {
  position: { x: 0, y: 0 },
  telegraph: false,
  crossing: false,
  crossingProgress: 0,
};

function mergedGeometry(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  return merged ?? new THREE.BufferGeometry();
}

function colorGeometry(
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
): THREE.BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const rgb = new Float32Array(count * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    rgb[o] = c.r;
    rgb[o + 1] = c.g;
    rgb[o + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  return geometry;
}

function buildKelpGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const x = [-24, -8, 11, 27];
  const height = [82, 112, 96, 72];
  const lean = [-0.14, 0.09, -0.07, 0.16];
  for (let i = 0; i < x.length; i++) {
    const strand = new THREE.ConeGeometry(12, height[i], 5, 2);
    strand.translate(x[i], height[i] * 0.5, 0);
    strand.rotateZ(lean[i]);
    parts.push(strand);
  }
  return mergedGeometry(parts);
}

function buildUrchinGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.IcosahedronGeometry(28, 1)];
  const directions = [
    [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
    [-0.58, -0.58, -0.58], [-0.58, -0.58, 0.58], [-0.58, 0.58, -0.58],
    [0.58, -0.58, -0.58], [0.58, 0.58, -0.58], [0.58, 0.58, 0.58],
  ] as const;
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  for (const d of directions) {
    dir.set(d[0], d[1], d[2]).normalize();
    q.setFromUnitVectors(up, dir);
    p.copy(dir).multiplyScalar(38);
    m.compose(p, q, s);
    // IcosahedronGeometry is non-indexed while ConeGeometry is indexed; all
    // merge inputs must agree or mergeGeometries returns null (invisible batch).
    const indexedSpike = new THREE.ConeGeometry(5, 28, 4, 1);
    const spike = indexedSpike.toNonIndexed();
    indexedSpike.dispose();
    spike.translate(0, 14, 0);
    spike.applyMatrix4(m);
    parts.push(spike);
  }
  return mergedGeometry(parts);
}

function buildCreatureGeometry(): THREE.BufferGeometry {
  const body = new THREE.SphereGeometry(1, 14, 8);
  body.scale(96, 34, 42);
  body.translate(0, 18, 0);
  const dorsal = new THREE.ConeGeometry(18, 46, 3, 1);
  dorsal.translate(-2, 54, 0);
  const tail = new THREE.ConeGeometry(34, 62, 4, 1);
  tail.rotateZ(Math.PI / 2);
  tail.translate(-116, 18, 0);
  return mergedGeometry([body, dorsal, tail]);
}

function buildTelegraphGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const shadow = colorGeometry(new THREE.CircleGeometry(1, 32), '#071b2b');
  shadow.rotateX(-Math.PI / 2);
  parts.push(shadow);
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const spray = colorGeometry(new THREE.ConeGeometry(0.09, 0.52, 3, 1), '#8bf6ff');
    spray.translate(Math.cos(angle) * 0.72, 0.24, Math.sin(angle) * 0.72);
    spray.rotateY(-angle);
    parts.push(spray);
  }
  return mergedGeometry(parts);
}

function buildRipStreakGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const offsets = [-0.82, -0.48, -0.12, 0.28, 0.61, 0.86];
  for (let i = 0; i < offsets.length; i++) {
    const strip = colorGeometry(
      new THREE.PlaneGeometry(i % 2 === 0 ? 0.11 : 0.065, 2),
      i % 2 === 0 ? '#66f4ff' : '#b9fbff',
    );
    strip.translate(offsets[i], 0, 0);
    parts.push(strip);
  }
  return mergedGeometry(parts);
}

const _kelpGeometry = buildKelpGeometry();
const _urchinGeometry = buildUrchinGeometry();
const _driftwoodGeometry = new THREE.CylinderGeometry(24, 30, 240, 10, 1);
// Server driftwood `rot` defines the long-axis as a Three.js +Z yaw.
_driftwoodGeometry.rotateX(Math.PI / 2);
const _creatureGeometry = buildCreatureGeometry();
const _telegraphGeometry = buildTelegraphGeometry();
const _ripGeometry = buildRipStreakGeometry();
// PlaneGeometry starts in XY. Bake it into XZ once so local +X is track-right
// and local +Z is down-track; runtime YXZ then owns only yaw + surface bank.
_ripGeometry.rotateX(-Math.PI / 2);

const _kelpMaterial = new THREE.MeshStandardMaterial({
  color: '#2a9a54', emissive: '#0f452c', emissiveIntensity: 0.28,
  roughness: 0.9, metalness: 0,
});
const _urchinMaterial = new THREE.MeshStandardMaterial({
  color: '#8f3daa', emissive: '#56196b', emissiveIntensity: 0.45,
  roughness: 0.72, metalness: 0.05,
});
const _driftwoodMaterial = new THREE.MeshStandardMaterial({
  color: '#7a4a2d', emissive: '#2b140b', emissiveIntensity: 0.16,
  roughness: 0.96, metalness: 0,
});
const _creatureMaterial = new THREE.MeshBasicMaterial({ color: '#071622' });
const _telegraphMaterial = new THREE.MeshBasicMaterial({
  vertexColors: true,
  transparent: true,
  opacity: 0.62,
  depthWrite: false,
  side: THREE.DoubleSide,
});
_telegraphMaterial.forceSinglePass = true;
const _ripMaterial = new THREE.MeshBasicMaterial({
  vertexColors: true,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
  side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
});
_ripMaterial.forceSinglePass = true;

type ResolvedFurniture = ReefRaceObstacleLayout & {
  x: number;
  z: number;
  t: number;
  baseY: number;
  bank: number;
};

interface ResolvedRipSegment {
  x: number;
  z: number;
  rot: number;
  halfLength: number;
  halfWidth: number;
  baseY: number;
  bank: number;
}

function resolveObstacle(obstacle: ReefRaceObstacleLayout): ResolvedFurniture {
  const x = obstacle.position.x;
  const z = obstacle.position.y;
  const t = clientSpline.closestPointOnSpline({ x, z }).t;
  return {
    ...obstacle,
    x,
    z,
    t,
    baseY: bankedDatumYAtT(x, z, t),
    bank: bankAngleAtT(t),
  };
}

function resolveRipSegment(rip: ReefRaceRipSegment): ResolvedRipSegment {
  const x = rip.position.x;
  const z = rip.position.y;
  const t = clientSpline.closestPointOnSpline({ x, z }).t;
  return {
    x,
    z,
    rot: rip.rot,
    halfLength: rip.halfLength,
    halfWidth: rip.halfWidth,
    baseY: bankedDatumYAtT(x, z, t),
    bank: bankAngleAtT(t),
  };
}

function clearInstances(mesh: THREE.InstancedMesh | null, count: number): void {
  if (!mesh) return;
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _zeroMatrix);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
}

export default function ReefRaceTrackFurniture() {
  const kelpRef = useRef<THREE.InstancedMesh>(null);
  const urchinRef = useRef<THREE.InstancedMesh>(null);
  const driftwoodRef = useRef<THREE.InstancedMesh>(null);
  const creatureRef = useRef<THREE.InstancedMesh>(null);
  const telegraphRef = useRef<THREE.InstancedMesh>(null);
  const ripRef = useRef<THREE.InstancedMesh>(null);

  const layout = useActivityStore((state) => state.room?.reefSplineZones);
  const serverClockOffsetMs = useActivityStore((state) => state.serverClockOffsetMs);
  const obstacles = useMemo(
    () => (layout?.obstacles ?? []).map(resolveObstacle),
    [layout],
  );
  const ripCurrents = useMemo(
    () => (layout?.ripCurrents ?? []).flatMap((rip) => rip.segments.map(resolveRipSegment)),
    [layout],
  );
  const clockOffsetRef = useRef(serverClockOffsetMs);
  clockOffsetRef.current = serverClockOffsetMs;

  useEffect(() => {
    clearInstances(kelpRef.current, MAX_KELP);
    clearInstances(urchinRef.current, MAX_URCHINS);
    clearInstances(driftwoodRef.current, MAX_DRIFTWOOD);
    clearInstances(creatureRef.current, MAX_CREATURES);
    clearInstances(telegraphRef.current, MAX_CREATURES);
    clearInstances(ripRef.current, MAX_RIP_SEGMENTS);
  }, [obstacles, ripCurrents]);

  useFrame(({ clock }) => {
    const kelp = kelpRef.current;
    const urchins = urchinRef.current;
    const logs = driftwoodRef.current;
    const creatures = creatureRef.current;
    const telegraphs = telegraphRef.current;
    const rips = ripRef.current;
    if (!kelp || !urchins || !logs || !creatures || !telegraphs || !rips) return;

    const elapsed = clock.elapsedTime;
    let kelpIndex = 0;
    let urchinIndex = 0;
    let logIndex = 0;
    for (let i = 0; i < obstacles.length; i++) {
      const obstacle = obstacles[i];
      if (obstacle.kind === 'creature') continue;
      const surfaceY = obstacle.baseY + surfWaveHeightAt(obstacle.x, obstacle.z, elapsed);
      if (obstacle.kind === 'kelp' && kelpIndex < MAX_KELP) {
        _position.set(obstacle.x, surfaceY - 4, obstacle.z);
        _euler.set(0, obstacle.rot, 0, 'YXZ');
        _quaternion.setFromEuler(_euler);
        _scale.setScalar(Math.max(0.7, obstacle.params.radius / 70));
        _matrix.compose(_position, _quaternion, _scale);
        kelp.setMatrixAt(kelpIndex++, _matrix);
      } else if (obstacle.kind === 'urchin' && urchinIndex < MAX_URCHINS) {
        _position.set(
          obstacle.x,
          surfaceY + Math.max(22, obstacle.params.radius * 0.55),
          obstacle.z,
        );
        _quaternion.identity();
        _scale.setScalar(Math.max(0.75, obstacle.params.radius / 48));
        _matrix.compose(_position, _quaternion, _scale);
        urchins.setMatrixAt(urchinIndex++, _matrix);
      } else if (obstacle.kind === 'driftwood' && logIndex < MAX_DRIFTWOOD) {
        _position.set(obstacle.x, surfaceY + 18, obstacle.z);
        // Driftwood geometry is local +Z and server rot already names its
        // cross-lane long axis. Positive bank lowers local +Z (track-right).
        _euler.set(obstacle.bank, obstacle.rot, 0, 'YXZ');
        _quaternion.setFromEuler(_euler);
        _scale.set(
          Math.max(0.7, obstacle.params.halfWidth / 28),
          Math.max(0.7, obstacle.params.halfWidth / 28),
          Math.max(0.55, obstacle.params.halfLength / 120),
        );
        _matrix.compose(_position, _quaternion, _scale);
        logs.setMatrixAt(logIndex++, _matrix);
      }
    }
    kelp.instanceMatrix.needsUpdate = kelpIndex > 0;
    urchins.instanceMatrix.needsUpdate = urchinIndex > 0;
    logs.instanceMatrix.needsUpdate = logIndex > 0;

    const ripCount = Math.min(ripCurrents.length, MAX_RIP_SEGMENTS);
    for (let i = 0; i < ripCount; i++) {
      const rip = ripCurrents[i];
      const surfaceY = rip.baseY + surfWaveHeightAt(rip.x, rip.z, elapsed);
      _position.set(rip.x, surfaceY + 3, rip.z);
      _euler.set(0, rip.rot, -rip.bank, 'YXZ');
      _quaternion.setFromEuler(_euler);
      _scale.set(rip.halfWidth, 1, rip.halfLength);
      _matrix.compose(_position, _quaternion, _scale);
      rips.setMatrixAt(i, _matrix);
    }
    rips.instanceMatrix.needsUpdate = ripCount > 0;

    let creatureIndex = 0;
    const localMinusServer = clockOffsetRef.current ?? 0;
    const serverNowMs = Date.now() - localMinusServer;
    for (let i = 0; i < obstacles.length; i++) {
      const obstacle = obstacles[i];
      if (obstacle.kind !== 'creature' || creatureIndex >= MAX_CREATURES) continue;

      const motion = reefRaceCreatureMotionAt(obstacle, serverNowMs, _creatureMotion);
      if (!motion.telegraph && !motion.crossing) {
        creatures.setMatrixAt(creatureIndex, _zeroMatrix);
        telegraphs.setMatrixAt(creatureIndex, _zeroMatrix);
        creatureIndex++;
        continue;
      }
      const normalX = -Math.cos(obstacle.rot);
      const normalZ = Math.sin(obstacle.rot);
      const x = motion.position.x;
      const z = motion.position.y;
      const lateral = (x - obstacle.x) * normalX + (z - obstacle.z) * normalZ;
      const waveY = surfWaveHeightAt(x, z, elapsed);
      const movingBaseY = obstacle.baseY + Math.tan(obstacle.bank) * lateral;
      const creatureY = movingBaseY + waveY + 20;

      _position.set(x, creatureY, z);
      const creatureYaw = obstacle.rot + (obstacle.params.direction === 1 ? Math.PI : 0);
      const creatureRoll = obstacle.params.direction === 1
        ? obstacle.bank
        : -obstacle.bank;
      _euler.set(0, creatureYaw, creatureRoll, 'YXZ');
      _quaternion.setFromEuler(_euler);
      _scale.setScalar(motion.crossing ? obstacle.params.radius / 82 : 0);
      _matrix.compose(_position, _quaternion, _scale);
      creatures.setMatrixAt(creatureIndex, _matrix);

      const patchScale = obstacle.params.radius * (motion.telegraph ? 0.88 : 1);
      _position.set(x, movingBaseY + waveY + 4, z);
      _euler.set(0, obstacle.rot, -obstacle.bank, 'YXZ');
      _quaternion.setFromEuler(_euler);
      _scale.set(patchScale, patchScale, patchScale);
      _matrix.compose(_position, _quaternion, _scale);
      telegraphs.setMatrixAt(creatureIndex, _matrix);
      creatureIndex++;
    }

    while (creatureIndex < MAX_CREATURES) {
      creatures.setMatrixAt(creatureIndex, _zeroMatrix);
      telegraphs.setMatrixAt(creatureIndex, _zeroMatrix);
      creatureIndex++;
    }
    creatures.instanceMatrix.needsUpdate = true;
    telegraphs.instanceMatrix.needsUpdate = true;
    _ripMaterial.opacity = 0.34 + 0.08 * Math.sin(elapsed * Math.PI * 2.2);
  });

  return (
    <>
      <instancedMesh name="reef-obstacles-kelp" ref={kelpRef} args={[_kelpGeometry, _kelpMaterial, MAX_KELP]} frustumCulled={false} />
      <instancedMesh name="reef-obstacles-urchin" ref={urchinRef} args={[_urchinGeometry, _urchinMaterial, MAX_URCHINS]} frustumCulled={false} />
      <instancedMesh name="reef-obstacles-driftwood" ref={driftwoodRef} args={[_driftwoodGeometry, _driftwoodMaterial, MAX_DRIFTWOOD]} frustumCulled={false} />
      <instancedMesh name="reef-obstacles-creature" ref={creatureRef} args={[_creatureGeometry, _creatureMaterial, MAX_CREATURES]} frustumCulled={false} />
      <instancedMesh name="reef-obstacles-creature-telegraph" ref={telegraphRef} args={[_telegraphGeometry, _telegraphMaterial, MAX_CREATURES]} frustumCulled={false} />
      <instancedMesh name="reef-rip-currents" ref={ripRef} args={[_ripGeometry, _ripMaterial, MAX_RIP_SEGMENTS]} frustumCulled={false} />
    </>
  );
}
