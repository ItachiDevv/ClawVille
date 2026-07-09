'use client';

/**
 * ReefRaceTrack.tsx
 *
 * Feature-flag dispatch:
 *   NEXT_PUBLIC_REEF_RACE_USE_SPLINE=true  → v2 spline river-bed (centripetal
 *     Catmull-Rom, variable width per CP, sandy riverbed color, bank walls).
 *   unset / false                          → v1 ellipse track (original code).
 *
 * ─── v1 (ellipse, preserved) ────────────────────────────────────────────────
 * Track surface (flat ribbon BufferGeometry following ellipse curve) +
 * merged guardrails + 3× InstancedMesh coral/jellyfish decorations.
 *
 * IMPORTANT: TubeGeometry was replaced with a flat ribbon because:
 *   - TubeGeometry is a HOLLOW TUBE — the camera above the track sees
 *     only the thin outer-top face edge, making the track nearly invisible.
 *   - The ribbon geometry is a flat road surface at y=0 with normals
 *     pointing +Y, visible from the chase camera above.
 *   - DoubleSide ensures the track is visible from any camera angle.
 *
 * Track ellipse coordinates match the server sim exactly:
 *   REEF_TRACK_A=1100, REEF_TRACK_B=700 → entity.x/y lands on the ribbon.
 *
 * ─── v2 (spline river-bed) ──────────────────────────────────────────────────
 * River bed + bank walls built from clientSpline singleton.
 * Samples centerlineAt/normalAt/widthAt at 64 uniform-t points.
 * Sandy color 0xc8a572, roughness 0.85, fog=false.
 * Bank walls: vertical quads at river edges, grass green 0x7cb342 (blends with ground plane).
 * Finish-line gate at t=1.0 (gold pillar pair + crossbar).
 *
 * Iris Xe invariants (both paths):
 *   - Flat ribbon BufferGeometry: O(SEGMENTS × 2) vertices, 1 draw call.
 *   - Guardrails: mergeGeometries → 2 draw calls (left rail, right rail).
 *   - No ShaderMaterial anywhere — MeshStandardMaterial only.
 *   - No per-frame allocations — all setup in useMemo/useEffect.
 *   - fog=false on ALL track/wall materials (racing line always visible).
 *   - makeGeometryWebGPUSafe on all custom BufferGeometry instances.
 *
 * Draw calls v2: 1 (riverbed) + 2 (bank walls merged) + 2 (finish gate) = 5.
 * Draw calls v1: 1 (track ribbon) + 2 (guardrails merged) + 3 (coral) = 6.
 */

import { useRef, useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeGeometryWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { preloadKTX2Bytes, useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';
import {
  TRACK_TUBE_SEGMENTS,
  TRACK_TUBE_RADIUS,
  GUARDRAIL_HEIGHT,
  GUARDRAIL_THICKNESS,
  CORAL_COUNT_PER_TYPE,
  CORAL_SCALE_MIN,
  CORAL_SCALE_MAX,
  CORAL_OFFSET_FROM_TRACK,
  reefCenterlineAtClient,
  reefTangentAtClient,
} from './reef-race-config';
import { clientSpline } from './reef-race-spline-instance';

// ─── v2 feature flag ──────────────────────────────────────────────────────────
const USE_SPLINE_TRACK = process.env.NEXT_PUBLIC_REEF_RACE_USE_SPLINE === 'true';

// ─── Preloads ────────────────────────────────────────────────────────────────
preloadKTX2Bytes('/models/coral-reef1-ktx.glb');
preloadKTX2Bytes('/models/coral-reef2-ktx.glb');
preloadKTX2Bytes('/models/coral-reef3-ktx.glb');
preloadKTX2Bytes('/models/jellyfish-ktx.glb');

// ─── Module-scope scratch ─────────────────────────────────────────────────────
const _mat4 = new THREE.Matrix4();
const _pos  = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl  = new THREE.Vector3();
const _tangent  = new THREE.Vector3();
const _binormal = new THREE.Vector3();

/** World up — used in cross-product for guardrail/coral placement. */
const _worldUp = new THREE.Vector3(0, 1, 0);

/**
 * Sample track frame (tangent, binormal) at parameter t.
 * binormal = tangent × worldUp, giving the XZ-plane sideways direction.
 */
function sampleTrackFrame(t: number): { pos: THREE.Vector3; tangent: THREE.Vector3; binormal: THREE.Vector3 } {
  const p = reefCenterlineAtClient(t % 1);
  const tangent = reefTangentAtClient(t % 1);
  _pos.set(p.x, 0, p.y);
  _tangent.set(tangent.x, 0, tangent.y).normalize();
  _binormal.crossVectors(_tangent, _worldUp).normalize();
  return { pos: _pos.clone(), tangent: _tangent.clone(), binormal: _binormal.clone() };
}

// ─── Track material (module scope) ───────────────────────────────────────────
// DoubleSide: the flat ribbon is visible from both above AND below the XZ plane.
// This ensures the track is always visible regardless of camera angle.

// fog=false: track surface and guardrails are the racing reference — they MUST
// be visible at all distances regardless of fog settings. When FOG_FAR is
// calibrated for props/karts (depth cue), the track would otherwise fade into
// the fog color on the far side of the ellipse, producing a "black portal"
// effect as the player drives toward the previously-invisible portion.
const _trackMat = new THREE.MeshStandardMaterial({
  color: '#1a6b3c',
  roughness: 0.9,
  metalness: 0.0,
  side: THREE.DoubleSide,
  fog: false,
});

const _guardrailMat = new THREE.MeshStandardMaterial({
  color: '#e0e0e0',
  roughness: 0.7,
  metalness: 0.1,
  side: THREE.DoubleSide,
  fog: false,
});

// ─── Canvas texture for track surface ────────────────────────────────────────
// Checkerboard lane markings — created once at module load.
function makeTrackTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1a6b3c';
  ctx.fillRect(0, 0, size, size);
  // Lane dashes
  ctx.strokeStyle = '#ffffff44';
  ctx.lineWidth = 4;
  ctx.setLineDash([20, 40]);
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 20);
  return tex;
}

// ─── Flat ribbon track geometry ───────────────────────────────────────────────
// Replaces TubeGeometry. Generates a flat road surface at y=0 by sampling
// the curve and extruding a strip perpendicular to the tangent in the XZ plane.
// Normals point +Y (up) — unambiguously visible from the chase camera above.
//
// With DoubleSide material this is visible from any camera angle and avoids
// the hollow-tube backface-culling problem that made TubeGeometry invisible.
function buildFlatRibbonGeo(
  segments: number,
  halfWidth: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals:   number[] = [];
  const uvs:       number[] = [];
  const indices:   number[] = [];

  const _pt  = new THREE.Vector3();
  const _tan = new THREE.Vector3();
  // Right direction = tangent × (0,1,0) in XZ plane
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = reefCenterlineAtClient(t % 1);
    const tangent = reefTangentAtClient(t % 1);
    _pt.set(p.x, 0, p.y);
    _tan.set(tangent.x, 0, tangent.y).normalize();

    // Right vector perpendicular to tangent in XZ plane
    _right.crossVectors(_tan, _up).normalize();

    const u = t;

    // Left edge vertex
    positions.push(
      _pt.x - _right.x * halfWidth,
      0,
      _pt.z - _right.z * halfWidth,
    );
    normals.push(0, 1, 0);
    uvs.push(0, u);

    // Right edge vertex
    positions.push(
      _pt.x + _right.x * halfWidth,
      0,
      _pt.z + _right.z * halfWidth,
    );
    normals.push(0, 1, 0);
    uvs.push(1, u);

    if (i < segments) {
      const base = i * 2;
      // Two triangles per quad strip segment
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

// ─── Coral InstancedMesh component ───────────────────────────────────────────

interface CoralInstProps {
  glbPath: string;
  seed: number;
  side: 1 | -1; // +1 = left of direction, -1 = right
}

function CoralInstances({ glbPath, seed, side }: CoralInstProps) {
  const { scene: srcScene } = useGLTFWithKTX2(glbPath);
  const meshRef = useRef<THREE.InstancedMesh>(null);

  // Extract first mesh geometry from GLB.
  const geo = useMemo(() => {
    let g: THREE.BufferGeometry | null = null;
    srcScene.traverse((o) => {
      if (!g && (o as THREE.Mesh).isMesh) {
        g = makeGeometryWebGPUSafe((o as THREE.Mesh).geometry.clone());
      }
    });
    return g ?? new THREE.BoxGeometry(20, 40, 20);
  }, [srcScene]);

  // Extract first mesh material from GLB.
  const mat = useMemo(() => {
    let m: THREE.Material | null = null;
    srcScene.traverse((o) => {
      if (!m && (o as THREE.Mesh).isMesh) {
        const src = (o as THREE.Mesh).material;
        m = Array.isArray(src) ? src[0].clone() : (src as THREE.Material).clone();
      }
    });
    return m ?? new THREE.MeshStandardMaterial({ color: '#ff7043' });
  }, [srcScene]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Deterministic pseudo-random based on seed.
    let rng = seed * 1664525 + 1013904223;
    const rand = () => {
      rng = (rng * 1664525 + 1013904223) & 0xffffffff;
      return ((rng >>> 0) / 0xffffffff);
    };

    for (let i = 0; i < CORAL_COUNT_PER_TYPE; i++) {
      const t = (i + rand() * 0.6) / CORAL_COUNT_PER_TYPE;
      const frame = sampleTrackFrame(t);
      const scale = CORAL_SCALE_MIN + rand() * (CORAL_SCALE_MAX - CORAL_SCALE_MIN);

      // Position: track center + binormal * (TRACK_TUBE_RADIUS + CORAL_OFFSET) * side
      _pos.copy(frame.pos)
        .addScaledVector(frame.binormal, (TRACK_TUBE_RADIUS + CORAL_OFFSET_FROM_TRACK) * side);
      _pos.y = 0; // ground level

      const rotY = rand() * Math.PI * 2;
      _quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
      _scl.set(scale, scale, scale);

      _mat4.compose(_pos, _quat, _scl);
      mesh.setMatrixAt(i, _mat4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, [seed, side]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geo, mat as THREE.MeshStandardMaterial, CORAL_COUNT_PER_TYPE]}
      frustumCulled={false}
      castShadow
      receiveShadow
    />
  );
}

// ─── Guardrails (merged geometry) ────────────────────────────────────────────

function Guardrails() {
  const groupRef = useRef<THREE.Group>(null);

  const guardGeo = useMemo(() => {
    const SAMPLES = 64;
    const leftGeos: THREE.BufferGeometry[]  = [];
    const rightGeos: THREE.BufferGeometry[] = [];

    for (let i = 0; i < SAMPLES; i++) {
      const t0 = i / SAMPLES;
      const t1 = (i + 1) / SAMPLES;
      const f0 = sampleTrackFrame(t0);
      const f1 = sampleTrackFrame(t1);

      const segLen = f0.pos.distanceTo(f1.pos);
      const midPos = f0.pos.clone().lerp(f1.pos, 0.5);
      const midTan = f0.tangent.clone().lerp(f1.tangent, 0.5).normalize();

      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), midTan);

      for (const [side, arr] of [
        [ 1, leftGeos ],
        [-1, rightGeos],
      ] as [number, THREE.BufferGeometry[]][]) {
        const geo = new THREE.BoxGeometry(GUARDRAIL_THICKNESS, GUARDRAIL_HEIGHT, segLen);

        // Build a temporary Matrix4 for this segment without creating a Mesh
        // (avoids TS type constraint on mesh.geometry reassignment).
        const biDir = f0.binormal.clone().lerp(f1.binormal, 0.5).normalize();
        const segPos = midPos.clone().addScaledVector(biDir, TRACK_TUBE_RADIUS * side);
        segPos.y = GUARDRAIL_HEIGHT / 2;

        const segMat = new THREE.Matrix4();
        segMat.compose(segPos, q, new THREE.Vector3(1, 1, 1));
        geo.applyMatrix4(segMat);
        arr.push(geo);
      }
    }

    const left  = mergeGeometries(leftGeos);
    const right = mergeGeometries(rightGeos);
    leftGeos.forEach((g)  => g.dispose());
    rightGeos.forEach((g) => g.dispose());
    return { left, right };
  }, []);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.matrixAutoUpdate = false;
        (o as THREE.Mesh).updateMatrix();
      }
    });
    return () => {
      guardGeo.left?.dispose();
      guardGeo.right?.dispose();
    };
  }, [guardGeo]);

  return (
    <group ref={groupRef}>
      <mesh geometry={guardGeo.left}  material={_guardrailMat} receiveShadow castShadow matrixAutoUpdate={false} />
      <mesh geometry={guardGeo.right} material={_guardrailMat} receiveShadow castShadow matrixAutoUpdate={false} />
    </group>
  );
}

// ─── v2 materials (module scope) ─────────────────────────────────────────────
// All fog=false — track surface is the navigation reference, must never fade.
// MeshStandardMaterial only — no ShaderMaterial (silent WebGPU crash on Iris Xe).

/** Sandy river-bed surface. */
const _v2RiverMat = new THREE.MeshStandardMaterial({
  color: 0xc8a572,
  roughness: 0.85,
  metalness: 0.0,
  side: THREE.DoubleSide,
  fog: false,
});

/**
 * Bank walls — recolored to grass green so they blend with the new GroundPlane
 * and SandRibbon in river-scene.tsx. The old dark-brown 0x6b5544 rendered as
 * an ugly dark stripe visible from the cinematic camera view.
 */
const _v2BankMat = new THREE.MeshStandardMaterial({
  color: 0x7cb342,  // grass green — matches GroundPlane in river-scene.tsx
  roughness: 0.9,
  metalness: 0.0,
  side: THREE.DoubleSide,
  fog: false,
});

/** Finish-line gate pillars (gold). */
const _v2FinishMat = new THREE.MeshStandardMaterial({
  color: 0xffd600,
  roughness: 0.3,
  metalness: 0.6,
  fog: false,
  emissive: new THREE.Color(0xffd600),
  emissiveIntensity: 0.3,
});

// ─── v2 geometry builders ─────────────────────────────────────────────────────

const V2_RIBBON_SAMPLES = 64;
const V2_RIVER_BED_Y = -2; // Local to TRACK_SURFACE_Y group; world Y renders at -202.
const V2_BANK_HEIGHT = 80; // wu — river wall height
const V2_BANK_THICKNESS = 10; // wu

/**
 * Build the v2 river-bed ribbon from the centripetal Catmull-Rom spline.
 *
 * The spline's normalAt(t) returns 90° CCW of the tangent (= LEFT of travel).
 *   Left edge  = center + normal * halfWidth
 *   Right edge = center - normal * halfWidth
 * Width varies per-sample via clientSpline.widthAt(t) — the river naturally
 * narrows through chicanes (kelp/shipwreck/coral) and widens at lagoon/finish.
 */
function buildSplineRibbonGeo(samples: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[]   = [];
  const uvs: number[]       = [];
  const indices: number[]   = [];

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const c = clientSpline.centerlineAt(t);
    const n = clientSpline.normalAt(t); // 90° CCW = left of travel
    const hw = clientSpline.widthAt(t);

    // Left edge (normal points left)
    positions.push(c.x + n.x * hw, 0, c.z + n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(0, t);

    // Right edge
    positions.push(c.x - n.x * hw, 0, c.z - n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(1, t);

    if (i < samples) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return makeGeometryWebGPUSafe(geo);
}

/**
 * Build merged bank-wall geometry for left and right edges.
 * Each segment is a vertical quad (two triangles) connecting adjacent samples.
 */
function buildSplineBankGeos(samples: number): { left: THREE.BufferGeometry; right: THREE.BufferGeometry } {
  const leftGeos: THREE.BufferGeometry[]  = [];
  const rightGeos: THREE.BufferGeometry[] = [];

  for (let i = 0; i < samples; i++) {
    const t0 = i / samples;
    const t1 = (i + 1) / samples;

    const c0 = clientSpline.centerlineAt(t0);
    const n0 = clientSpline.normalAt(t0);
    const hw0 = clientSpline.widthAt(t0);

    const c1 = clientSpline.centerlineAt(t1);
    const n1 = clientSpline.normalAt(t1);
    const hw1 = clientSpline.widthAt(t1);

    // Left bank segment
    {
      const lx0 = c0.x + n0.x * hw0;
      const lz0 = c0.z + n0.z * hw0;
      const lx1 = c1.x + n1.x * hw1;
      const lz1 = c1.z + n1.z * hw1;

      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array([
        // bottom-left, top-left, bottom-right, top-right
        lx0, 0,              lz0,
        lx0, V2_BANK_HEIGHT, lz0,
        lx1, 0,              lz1,
        lx1, V2_BANK_HEIGHT, lz1,
      ]);
      const nrm = new Float32Array([
        // outward normals (left side, pointing left = +normal direction)
        n0.x, 0, n0.z,
        n0.x, 0, n0.z,
        n1.x, 0, n1.z,
        n1.x, 0, n1.z,
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal',   new THREE.BufferAttribute(nrm, 3));
      geo.setIndex([0, 1, 2, 1, 3, 2]);
      leftGeos.push(geo);
    }

    // Right bank segment
    {
      const rx0 = c0.x - n0.x * hw0;
      const rz0 = c0.z - n0.z * hw0;
      const rx1 = c1.x - n1.x * hw1;
      const rz1 = c1.z - n1.z * hw1;

      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array([
        rx0, 0,              rz0,
        rx0, V2_BANK_HEIGHT, rz0,
        rx1, 0,              rz1,
        rx1, V2_BANK_HEIGHT, rz1,
      ]);
      const nrm = new Float32Array([
        // inward normals (right side, pointing right = -normal direction)
        -n0.x, 0, -n0.z,
        -n0.x, 0, -n0.z,
        -n1.x, 0, -n1.z,
        -n1.x, 0, -n1.z,
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal',   new THREE.BufferAttribute(nrm, 3));
      geo.setIndex([0, 2, 1, 1, 2, 3]);
      rightGeos.push(geo);
    }
  }

  const left  = makeGeometryWebGPUSafe(mergeGeometries(leftGeos)!);
  const right = makeGeometryWebGPUSafe(mergeGeometries(rightGeos)!);
  leftGeos.forEach(g => g.dispose());
  rightGeos.forEach(g => g.dispose());
  return { left, right };
}

/**
 * Build finish-line gate geometry at t=1.0 (which equals t=0 on the spline —
 * the start/finish line at z=18 000 wu).
 *
 * Two pillars (CylinderGeometry) + one crossbar (BoxGeometry).
 */
function buildFinishGateGeo(): THREE.BufferGeometry {
  const c = clientSpline.centerlineAt(1.0);
  const n = clientSpline.normalAt(1.0);
  const hw = clientSpline.widthAt(1.0);
  const pillarR = 15;
  const pillarH = 200;
  const barH = 15;

  const lx = c.x + n.x * hw;
  const lz = c.z + n.z * hw;
  const rx = c.x - n.x * hw;
  const rz = c.z - n.z * hw;

  const leftPillar  = new THREE.CylinderGeometry(pillarR, pillarR, pillarH, 8);
  const rightPillar = new THREE.CylinderGeometry(pillarR, pillarR, pillarH, 8);
  const bar         = new THREE.BoxGeometry(hw * 2 + pillarR * 2, barH, pillarR);

  // Translate each sub-geometry into world position before merging
  const lMat = new THREE.Matrix4().makeTranslation(lx, pillarH / 2, lz);
  const rMat = new THREE.Matrix4().makeTranslation(rx, pillarH / 2, rz);
  const bMat = new THREE.Matrix4().makeTranslation(c.x, pillarH + barH / 2, c.z);

  leftPillar.applyMatrix4(lMat);
  rightPillar.applyMatrix4(rMat);
  bar.applyMatrix4(bMat);

  const merged = makeGeometryWebGPUSafe(mergeGeometries([leftPillar, rightPillar, bar])!);
  leftPillar.dispose();
  rightPillar.dispose();
  bar.dispose();
  return merged;
}

// ─── v2 River-bed component ───────────────────────────────────────────────────

function SplineTrack() {
  const riverMeshRef  = useRef<THREE.Mesh>(null);
  const bankGroupRef  = useRef<THREE.Group>(null);
  const finishMeshRef = useRef<THREE.Mesh>(null);

  const riverGeo  = useMemo(() => buildSplineRibbonGeo(V2_RIBBON_SAMPLES), []);
  const bankGeos  = useMemo(() => buildSplineBankGeos(V2_RIBBON_SAMPLES), []);
  const finishGeo = useMemo(() => buildFinishGateGeo(), []);

  useEffect(() => {
    const meshes = [riverMeshRef.current, finishMeshRef.current];
    meshes.forEach(m => {
      if (m) {
        m.matrixAutoUpdate = false;
        m.updateMatrix();
      }
    });
    const g = bankGroupRef.current;
    if (g) {
      g.traverse(o => {
        if ((o as THREE.Mesh).isMesh) {
          o.matrixAutoUpdate = false;
          (o as THREE.Mesh).updateMatrix();
        }
      });
    }
    return () => {
      riverGeo.dispose();
      bankGeos.left.dispose();
      bankGeos.right.dispose();
      finishGeo.dispose();
    };
  }, [riverGeo, bankGeos, finishGeo]);

  return (
    <group>
      {/* River bed — sandy flat ribbon, normals +Y, DoubleSide */}
      <mesh ref={riverMeshRef} geometry={riverGeo} material={_v2RiverMat} position-y={V2_RIVER_BED_Y} receiveShadow matrixAutoUpdate={false} />

      {/* Bank walls — vertical quads merged left + right */}
      <group ref={bankGroupRef} visible={false}>
        <mesh geometry={bankGeos.left}  material={_v2BankMat} castShadow receiveShadow matrixAutoUpdate={false} />
        <mesh geometry={bankGeos.right} material={_v2BankMat} castShadow receiveShadow matrixAutoUpdate={false} />
      </group>

      {/* Finish-line gate — gold pillars + crossbar */}
      <mesh ref={finishMeshRef} geometry={finishGeo} material={_v2FinishMat} castShadow matrixAutoUpdate={false} />
    </group>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

function EllipseTrack() {
  const trackMeshRef = useRef<THREE.Mesh>(null);

  // Flat ribbon geometry: visible as a road surface from the chase camera above.
  // Uses TRACK_TUBE_SEGMENTS samples and TRACK_TUBE_RADIUS as the half-width.
  const ribbonGeo = useMemo(() => {
    return buildFlatRibbonGeo(TRACK_TUBE_SEGMENTS, TRACK_TUBE_RADIUS);
  }, []);

  const trackTexture = useMemo(() => {
    if (typeof document === 'undefined') return null;
    return makeTrackTexture();
  }, []);

  const trackMaterial = useMemo(() => {
    const m = _trackMat.clone();
    if (trackTexture) m.map = trackTexture;
    return m;
  }, [trackTexture]);

  useEffect(() => {
    const mesh = trackMeshRef.current;
    if (!mesh) return;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return () => {
      ribbonGeo.dispose();
      trackMaterial.dispose();
      trackTexture?.dispose();
    };
  }, [ribbonGeo, trackMaterial, trackTexture]);

  return (
    <group>
      {/* Track surface (flat ribbon) — 1 draw call, normals +Y, DoubleSide */}
      <mesh ref={trackMeshRef} geometry={ribbonGeo} material={trackMaterial} receiveShadow />

      {/* Guardrails — 2 draw calls (merged left + right) */}
      <Guardrails />

      {/* Coral decorations — 3 InstancedMesh draw calls */}
      <CoralInstances glbPath="/models/coral-reef1-ktx.glb" seed={1} side={1}  />
      <CoralInstances glbPath="/models/coral-reef2-ktx.glb" seed={2} side={-1} />
      <CoralInstances glbPath="/models/coral-reef3-ktx.glb" seed={3} side={1}  />
    </group>
  );
}

/**
 * ReefRaceTrack — env-flag dispatcher.
 *
 * NEXT_PUBLIC_REEF_RACE_USE_SPLINE=true  → SplineTrack (v2 spline river-bed)
 * unset / false                          → EllipseTrack (v1, preserved)
 */
export default function ReefRaceTrack() {
  return USE_SPLINE_TRACK ? <SplineTrack /> : <EllipseTrack />;
}
