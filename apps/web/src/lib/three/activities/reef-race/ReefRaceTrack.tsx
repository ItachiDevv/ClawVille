'use client';

/**
 * ReefRaceTrack.tsx
 *
 * Track surface (TubeGeometry on CatmullRomCurve3) + merged guardrails +
 * 3× InstancedMesh coral/jellyfish decorations.
 *
 * Iris Xe invariants:
 *   - TubeGeometry: radialSegments=4 (quad strip, minimal triangles).
 *   - Guardrails: mergeGeometries → 2 draw calls (left rail, right rail).
 *   - Coral props: 3 InstancedMesh (coral-reef1/2/3.glb) → 3 draw calls.
 *   - matrixAutoUpdate=false on ALL static meshes after mount.
 *   - No ShaderMaterial anywhere — MeshStandardMaterial only.
 *   - No per-frame allocations — all setup in useMemo/useEffect.
 *
 * Draw calls: 2 (track + guardrails merged) + 3 (coral InstancedMesh) = 5 max.
 * The track tube itself is 1 draw call; guardrails merged → 1 draw call = 2 total.
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  TRACK_CURVE_POINTS,
  TRACK_TUBE_SEGMENTS,
  TRACK_TUBE_RADIUS,
  TRACK_RADIAL_SEGMENTS,
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
const _normal   = new THREE.Vector3();
const _binormal = new THREE.Vector3();

/** Build the closed CatmullRomCurve3 once at module scope — no per-render cost. */
const TRACK_CURVE = new THREE.CatmullRomCurve3(TRACK_CURVE_POINTS, TRACK_CLOSED, 'catmullrom', 0.5);

/**
 * Sample track frame (tangent, binormal, normal) at parameter t.
 * Returns a Matrix4 that orients a guardrail segment along the track.
 */
function sampleTrackFrame(t: number): { pos: THREE.Vector3; tangent: THREE.Vector3; binormal: THREE.Vector3 } {
  TRACK_CURVE.getPointAt(t, _pos);
  TRACK_CURVE.getTangentAt(t, _tangent);
  _tangent.normalize();
  _normal.set(0, 1, 0);
  _binormal.crossVectors(_tangent, _normal).normalize();
  return { pos: _pos.clone(), tangent: _tangent.clone(), binormal: _binormal.clone() };
}

// ─── Track material (module scope) ───────────────────────────────────────────

const _trackMat = new THREE.MeshStandardMaterial({
  color: '#1a6b3c',
  roughness: 0.9,
  metalness: 0.0,
});

const _guardrailMat = new THREE.MeshStandardMaterial({
  color: '#e0e0e0',
  roughness: 0.7,
  metalness: 0.1,
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

  const tubeGeo = useMemo(() => {
    return new THREE.TubeGeometry(
      TRACK_CURVE,
      TRACK_TUBE_SEGMENTS,
      TRACK_TUBE_RADIUS,
      TRACK_RADIAL_SEGMENTS,
      TRACK_CLOSED,
    );
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
      tubeGeo.dispose();
      trackMaterial.dispose();
      trackTexture?.dispose();
    };
  }, [tubeGeo, trackMaterial, trackTexture]);

  return (
    <group>
      {/* Track surface — 1 draw call */}
      <mesh ref={trackMeshRef} geometry={tubeGeo} material={trackMaterial} receiveShadow castShadow />

      {/* Guardrails — 2 draw calls (merged left + right) */}
      <Guardrails />

      {/* Coral decorations — 3 InstancedMesh draw calls */}
      <CoralInstances glbPath="/models/coral-reef1.glb" seed={1} side={1}  />
      <CoralInstances glbPath="/models/coral-reef2.glb" seed={2} side={-1} />
      <CoralInstances glbPath="/models/coral-reef3.glb" seed={3} side={1}  />
    </group>
  );
}
