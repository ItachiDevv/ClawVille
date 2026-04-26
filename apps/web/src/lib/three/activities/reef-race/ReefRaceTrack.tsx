'use client';

/**
 * ReefRaceTrack.tsx
 *
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
 * Iris Xe invariants:
 *   - Flat ribbon BufferGeometry: O(SEGMENTS × 2) vertices, 1 draw call.
 *   - Guardrails: mergeGeometries → 2 draw calls (left rail, right rail).
 *   - Coral props: 3 InstancedMesh (coral-reef1/2/3.glb) → 3 draw calls.
 *   - matrixAutoUpdate=false on ALL static meshes after mount.
 *   - No ShaderMaterial anywhere — MeshStandardMaterial only.
 *   - No per-frame allocations — all setup in useMemo/useEffect.
 *
 * Draw calls: 1 (track ribbon) + 2 (guardrails merged) + 3 (coral) = 6 max.
 */

import { useRef, useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  TRACK_CURVE_POINTS,
  TRACK_TUBE_SEGMENTS,
  TRACK_TUBE_RADIUS,
  TRACK_CLOSED,
  GUARDRAIL_HEIGHT,
  GUARDRAIL_THICKNESS,
  CORAL_COUNT_PER_TYPE,
  CORAL_SCALE_MIN,
  CORAL_SCALE_MAX,
  CORAL_OFFSET_FROM_TRACK,
} from './reef-race-config';

// ─── Preloads ────────────────────────────────────────────────────────────────
useGLTF.preload('/models/coral-reef1.glb');
useGLTF.preload('/models/coral-reef2.glb');
useGLTF.preload('/models/coral-reef3.glb');
useGLTF.preload('/models/jellyfish.glb');

// ─── Module-scope scratch ─────────────────────────────────────────────────────
const _mat4 = new THREE.Matrix4();
const _pos  = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl  = new THREE.Vector3();
const _tangent  = new THREE.Vector3();
const _binormal = new THREE.Vector3();

/** Build the closed CatmullRomCurve3 once at module scope — no per-render cost. */
const TRACK_CURVE = new THREE.CatmullRomCurve3(TRACK_CURVE_POINTS, TRACK_CLOSED, 'catmullrom', 0.5);

/** World up — used in cross-product for guardrail/coral placement. */
const _worldUp = new THREE.Vector3(0, 1, 0);

/**
 * Sample track frame (tangent, binormal) at parameter t.
 * binormal = tangent × worldUp, giving the XZ-plane sideways direction.
 */
function sampleTrackFrame(t: number): { pos: THREE.Vector3; tangent: THREE.Vector3; binormal: THREE.Vector3 } {
  TRACK_CURVE.getPointAt(t, _pos);
  TRACK_CURVE.getTangentAt(t, _tangent);
  _tangent.normalize();
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
  curve: THREE.CatmullRomCurve3,
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
    curve.getPointAt(t, _pt);
    curve.getTangentAt(t, _tan).normalize();

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
  const { scene: srcScene } = useGLTF(glbPath);
  const meshRef = useRef<THREE.InstancedMesh>(null);

  // Extract first mesh geometry from GLB.
  const geo = useMemo(() => {
    let g: THREE.BufferGeometry | null = null;
    srcScene.traverse((o) => {
      if (!g && (o as THREE.Mesh).isMesh) {
        g = (o as THREE.Mesh).geometry.clone();
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReefRaceTrack() {
  const trackMeshRef = useRef<THREE.Mesh>(null);

  // Flat ribbon geometry: visible as a road surface from the chase camera above.
  // Uses TRACK_TUBE_SEGMENTS samples and TRACK_TUBE_RADIUS as the half-width.
  const ribbonGeo = useMemo(() => {
    return buildFlatRibbonGeo(TRACK_CURVE, TRACK_TUBE_SEGMENTS, TRACK_TUBE_RADIUS);
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
      <CoralInstances glbPath="/models/coral-reef1.glb" seed={1} side={1}  />
      <CoralInstances glbPath="/models/coral-reef2.glb" seed={2} side={-1} />
      <CoralInstances glbPath="/models/coral-reef3.glb" seed={3} side={1}  />
    </group>
  );
}
