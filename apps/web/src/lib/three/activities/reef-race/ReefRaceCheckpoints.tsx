'use client';

/**
 * ReefRaceCheckpoints.tsx
 *
 * 12 visual checkpoint gates merged into 2 draw calls by material:
 *   - Green material: checkpoints 1–11
 *   - Gold material: finish line (checkpoint 0)
 *
 * Each gate = 2 CylinderGeometry pillars + 1 BoxGeometry bar.
 * All geometry merged via mergeGeometries → 2 static draw calls.
 * matrixAutoUpdate=false after mount.
 *
 * Iris Xe invariants:
 *   - MeshStandardMaterial only (never ShaderMaterial).
 *   - Static geometry, matrixAutoUpdate=false.
 *   - No per-frame JS.
 *
 * Draw calls: 2 (green + gold merged meshes).
 */

import { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CHECKPOINT_T_VALUES,
  FINISH_LINE_INDEX,
  PILLAR_RADIUS_TOP,
  PILLAR_RADIUS_BOTTOM,
  PILLAR_HEIGHT,
  PILLAR_RADIAL_SEGS,
  GATE_BAR_WIDTH,
  GATE_BAR_HEIGHT,
  GATE_BAR_DEPTH,
  CHECKPOINT_EMISSIVE,
  FINISH_EMISSIVE,
  TRACK_CURVE_POINTS,
  TRACK_TUBE_RADIUS,
  TRACK_CLOSED,
} from './reef-race-config';

// ─── Module-scope scratch ─────────────────────────────────────────────────────
const _m4      = new THREE.Matrix4();
const _pos     = new THREE.Vector3();
const _quat    = new THREE.Quaternion();
const _scl     = new THREE.Vector3(1, 1, 1);
const _tangent = new THREE.Vector3();
const _binorm  = new THREE.Vector3();
const _up      = new THREE.Vector3(0, 1, 0);

const TRACK_CURVE = new THREE.CatmullRomCurve3(TRACK_CURVE_POINTS, TRACK_CLOSED, 'catmullrom', 0.5);

/** Build pillar + bar geometries for one gate at track t-value. */
function buildGateGeos(t: number): THREE.BufferGeometry[] {
  TRACK_CURVE.getPointAt(t, _pos);
  TRACK_CURVE.getTangentAt(t, _tangent).normalize();
  _binorm.crossVectors(_tangent, _up).normalize();

  // Gate orientation: align bar along binormal.
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), _up);

  const pillarGeoL = new THREE.CylinderGeometry(
    PILLAR_RADIUS_TOP, PILLAR_RADIUS_BOTTOM,
    PILLAR_HEIGHT, PILLAR_RADIAL_SEGS, 1,
  );
  const pillarGeoR = new THREE.CylinderGeometry(
    PILLAR_RADIUS_TOP, PILLAR_RADIUS_BOTTOM,
    PILLAR_HEIGHT, PILLAR_RADIAL_SEGS, 1,
  );
  const barGeo = new THREE.BoxGeometry(GATE_BAR_WIDTH, GATE_BAR_HEIGHT, GATE_BAR_DEPTH);

  // Left pillar
  const leftPos = _pos.clone().addScaledVector(_binorm, -TRACK_TUBE_RADIUS);
  leftPos.y = PILLAR_HEIGHT / 2;
  _m4.compose(leftPos, q, _scl);
  pillarGeoL.applyMatrix4(_m4);

  // Right pillar
  const rightPos = _pos.clone().addScaledVector(_binorm, TRACK_TUBE_RADIUS);
  rightPos.y = PILLAR_HEIGHT / 2;
  _m4.compose(rightPos, q, _scl);
  pillarGeoR.applyMatrix4(_m4);

  // Bar at top
  const barPos = _pos.clone();
  barPos.y = PILLAR_HEIGHT;
  // Rotate bar to align with gate width (along binormal)
  const barQ = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(1, 0, 0),
    _binorm.clone(),
  );
  _m4.compose(barPos, barQ, _scl);
  barGeo.applyMatrix4(_m4);

  return [pillarGeoL, pillarGeoR, barGeo];
}

// ─── Module-scope materials ───────────────────────────────────────────────────

const _greenMat = new THREE.MeshStandardMaterial({
  color: '#00c853',
  emissive: CHECKPOINT_EMISSIVE,
  emissiveIntensity: 0.4,
  roughness: 0.6,
  metalness: 0.3,
});

const _goldMat = new THREE.MeshStandardMaterial({
  color: '#ffd600',
  emissive: FINISH_EMISSIVE,
  emissiveIntensity: 0.6,
  roughness: 0.4,
  metalness: 0.5,
});

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReefRaceCheckpoints() {
  const greenRef = useRef<THREE.Mesh>(null);
  const goldRef  = useRef<THREE.Mesh>(null);

  const { greenGeo, goldGeo } = useMemo(() => {
    const greenGeos: THREE.BufferGeometry[] = [];
    const goldGeos:  THREE.BufferGeometry[] = [];

    for (let i = 0; i < CHECKPOINT_T_VALUES.length; i++) {
      const t = CHECKPOINT_T_VALUES[i];
      const geos = buildGateGeos(t);
      if (i === FINISH_LINE_INDEX) {
        goldGeos.push(...geos);
      } else {
        greenGeos.push(...geos);
      }
    }

    const greenGeo = greenGeos.length > 0 ? mergeGeometries(greenGeos) : new THREE.BufferGeometry();
    const goldGeo  = goldGeos.length  > 0 ? mergeGeometries(goldGeos)  : new THREE.BufferGeometry();

    greenGeos.forEach((g) => g.dispose());
    goldGeos.forEach((g)  => g.dispose());

    return { greenGeo, goldGeo };
  }, []);

  useEffect(() => {
    const gm = greenRef.current;
    const go = goldRef.current;
    if (gm) { gm.matrixAutoUpdate = false; gm.updateMatrix(); }
    if (go) { go.matrixAutoUpdate = false; go.updateMatrix(); }
    return () => {
      greenGeo.dispose();
      goldGeo.dispose();
    };
  }, [greenGeo, goldGeo]);

  return (
    <group>
      {/* Checkpoint gates — green material — 1 draw call */}
      <mesh ref={greenRef} geometry={greenGeo} material={_greenMat} castShadow receiveShadow />
      {/* Finish line gate — gold material — 1 draw call */}
      <mesh ref={goldRef}  geometry={goldGeo}  material={_goldMat}  castShadow receiveShadow />
    </group>
  );
}
