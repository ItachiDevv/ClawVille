'use client';

/**
 * ReefRaceStartGrid.tsx
 *
 * Start pads (InstancedMesh, 1 draw call) + countdown light gantry (4 draw calls)
 * + animated checkered finish flags (TSL MeshBasicNodeMaterial vertex wave).
 *
 * Iris Xe invariants:
 *   - InstancedMesh + MeshStandardMaterial (safe on WebGPU).
 *   - TSL positionNode wave on MeshBasicNodeMaterial (safe on WebGPU; no ShaderMaterial).
 *   - No ShaderMaterial anywhere.
 *   - Static meshes: matrixAutoUpdate=false.
 *   - Finish flags: mast-anchored planes with TSL vertex wave only on top half.
 *   - No Billboard (forbidden on Iris Xe) — flags on fixed masts.
 *
 * Draw calls: 1 (pads InstancedMesh) + 2 (gantry: bar + bulbs) + 2 (flags) = 5.
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { sin, time, positionLocal, vec3, uniform } from 'three/tsl';
import {
  GRID_PAD_COUNT,
  GRID_PAD_WIDTH,
  GRID_PAD_HEIGHT,
  GRID_PAD_DEPTH,
  GRID_PAD_STAGGER_X,
  GRID_PAD_SPACING_Z,
  GRID_PAD_Y,
  GANTRY_BULB_RADIUS,
  GANTRY_BULB_SEGS,
  GANTRY_BAR_WIDTH,
  GANTRY_BAR_HEIGHT,
  GANTRY_BAR_DEPTH,
  GANTRY_HEIGHT_ABOVE_TRACK,
  GANTRY_COLORS,
  FLAG_WIDTH,
  FLAG_HEIGHT,
  FLAG_WAVE_AMP,
  FLAG_WAVE_FREQ,
  FLAG_MAST_HEIGHT,
  TRACK_TUBE_RADIUS,
  TRACK_CURVE_POINTS,
  TRACK_CLOSED,
  START_GRID_T,
} from './reef-race-config';

// ─── Track curve ref ──────────────────────────────────────────────────────────
const TRACK_CURVE = new THREE.CatmullRomCurve3(TRACK_CURVE_POINTS, TRACK_CLOSED, 'catmullrom', 0.5);

// ─── Module-scope scratch ─────────────────────────────────────────────────────
const _m4   = new THREE.Matrix4();
const _pos  = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl  = new THREE.Vector3();
const _tan  = new THREE.Vector3();

// Get grid origin from curve
function getGridOrigin(): { pos: THREE.Vector3; tangent: THREE.Vector3 } {
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  TRACK_CURVE.getPointAt(START_GRID_T, p);
  TRACK_CURVE.getTangentAt(START_GRID_T, t);
  t.normalize();
  return { pos: p, tangent: t };
}

const GRID_ORIGIN = getGridOrigin();

// ─── Canvas texture for start pads ───────────────────────────────────────────
function makeCheckerTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const half = size / 2;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, half, half);
  ctx.fillRect(half, half, half, half);
  ctx.fillStyle = '#222222';
  ctx.fillRect(half, 0, half, half);
  ctx.fillRect(0, half, half, half);
  return new THREE.CanvasTexture(canvas);
}

// ─── TSL flag material factory ────────────────────────────────────────────────
// Uses MeshBasicNodeMaterial + positionLocal vertex wave on top portion.
// Safe on WebGPU (TSL, not ShaderMaterial).
function makeFlagMaterial(checkerTex: THREE.Texture): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  mat.map = checkerTex;
  mat.transparent = true;
  mat.opacity = 0.92;

  // Wave only the top vertices: wave amplitude modulated by normalized Y.
  // positionLocal.y ranges from 0 to FLAG_HEIGHT.
  const heightFactor = positionLocal.y.div(FLAG_HEIGHT); // 0 at base, 1 at top
  const waveX = sin(
    positionLocal.y.div(FLAG_HEIGHT).mul(Math.PI).add(time.mul(FLAG_WAVE_FREQ))
  ).mul(FLAG_WAVE_AMP).mul(heightFactor);

  mat.positionNode = vec3(
    positionLocal.x.add(waveX),
    positionLocal.y,
    positionLocal.z,
  );

  return mat;
}

// ─── Gantry lights component ──────────────────────────────────────────────────

export interface GantryState {
  phase: 'off' | 'red' | 'green';
}

function GantryLights({ state, gantryPos }: { state: GantryState; gantryPos: THREE.Vector3 }) {
  const bulbRefs = [
    useRef<THREE.Mesh>(null),
    useRef<THREE.Mesh>(null),
    useRef<THREE.Mesh>(null),
  ];

  const bulbMats = useMemo(
    () => [
      new THREE.MeshStandardMaterial({ color: GANTRY_COLORS.off, emissive: GANTRY_COLORS.off, emissiveIntensity: 0 }),
      new THREE.MeshStandardMaterial({ color: GANTRY_COLORS.off, emissive: GANTRY_COLORS.off, emissiveIntensity: 0 }),
      new THREE.MeshStandardMaterial({ color: GANTRY_COLORS.off, emissive: GANTRY_COLORS.off, emissiveIntensity: 0 }),
    ],
    [],
  );

  const bulbGeo = useMemo(
    () => new THREE.SphereGeometry(GANTRY_BULB_RADIUS, GANTRY_BULB_SEGS, GANTRY_BULB_SEGS),
    [],
  );
  const barGeo = useMemo(
    () => new THREE.BoxGeometry(GANTRY_BAR_WIDTH, GANTRY_BAR_HEIGHT, GANTRY_BAR_DEPTH),
    [],
  );
  const barMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#888888', roughness: 0.8 }),
    [],
  );

  // Update bulb colors based on phase.
  useEffect(() => {
    const color =
      state.phase === 'red'   ? GANTRY_COLORS.red   :
      state.phase === 'green' ? GANTRY_COLORS.green  :
      GANTRY_COLORS.off;
    const intensity = state.phase === 'off' ? 0 : 1.2;
    bulbMats.forEach((m) => {
      m.emissive.set(color);
      m.color.set(color);
      m.emissiveIntensity = intensity;
      m.needsUpdate = true;
    });
  }, [state.phase, bulbMats]);

  useEffect(() => {
    return () => {
      bulbGeo.dispose();
      barGeo.dispose();
      barMat.dispose();
      bulbMats.forEach((m) => m.dispose());
    };
  }, [bulbGeo, barGeo, barMat, bulbMats]);

  const barPos: [number, number, number] = [
    gantryPos.x,
    gantryPos.y,
    gantryPos.z,
  ];

  // 3 bulbs spread along the bar
  const bulbSpread = GANTRY_BAR_WIDTH / 4;
  const bulbPositions: [number, number, number][] = [
    [gantryPos.x - bulbSpread, gantryPos.y, gantryPos.z],
    [gantryPos.x,              gantryPos.y, gantryPos.z],
    [gantryPos.x + bulbSpread, gantryPos.y, gantryPos.z],
  ];

  return (
    <group>
      <mesh geometry={barGeo} material={barMat} position={barPos} matrixAutoUpdate={false} />
      {bulbPositions.map((bp, i) => (
        <mesh
          key={i}
          ref={bulbRefs[i]}
          geometry={bulbGeo}
          material={bulbMats[i]}
          position={bp}
          matrixAutoUpdate={false}
        />
      ))}
    </group>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface ReefRaceStartGridProps {
  /** Countdown phase for gantry lights (off until race starts). */
  gantryPhase?: 'off' | 'red' | 'green';
}

export default function ReefRaceStartGrid({ gantryPhase = 'off' }: ReefRaceStartGridProps) {
  const padsRef = useRef<THREE.InstancedMesh>(null);

  // Build pad instance matrices.
  const padGeo = useMemo(
    () => new THREE.BoxGeometry(GRID_PAD_WIDTH, GRID_PAD_HEIGHT, GRID_PAD_DEPTH),
    [],
  );

  const padMat = useMemo(() => {
    if (typeof document === 'undefined') {
      return new THREE.MeshStandardMaterial({ color: '#eeeeee' });
    }
    const tex = makeCheckerTexture();
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
  }, []);

  useEffect(() => {
    const mesh = padsRef.current;
    if (!mesh) return;

    const { pos: origin, tangent } = GRID_ORIGIN;
    const binorm = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);

    for (let i = 0; i < GRID_PAD_COUNT; i++) {
      const col   = i % 2;
      const row   = Math.floor(i / 2);
      const xOff  = (col === 0 ? -GRID_PAD_STAGGER_X / 2 : GRID_PAD_STAGGER_X / 2);
      const zOff  = row * GRID_PAD_SPACING_Z;

      _pos.copy(origin)
        .addScaledVector(binorm, xOff)
        .addScaledVector(tangent, -zOff); // behind start line
      _pos.y = GRID_PAD_Y;

      _scl.set(1, 1, 1);
      _m4.compose(_pos, q, _scl);
      mesh.setMatrixAt(i, _m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    return () => {
      padGeo.dispose();
      padMat.dispose();
    };
  }, [padGeo, padMat]);

  // Gantry position: above start line
  const gantryPos = useMemo(() => {
    const p = GRID_ORIGIN.pos.clone();
    p.y = GANTRY_HEIGHT_ABOVE_TRACK;
    return p;
  }, []);

  // Flag positions: left and right of finish gate
  const flagPositions = useMemo(() => {
    const { pos: origin } = GRID_ORIGIN;
    const binorm = new THREE.Vector3()
      .crossVectors(GRID_ORIGIN.tangent, new THREE.Vector3(0, 1, 0))
      .normalize();
    return [
      origin.clone().addScaledVector(binorm, -(TRACK_TUBE_RADIUS + 30)),
      origin.clone().addScaledVector(binorm,  (TRACK_TUBE_RADIUS + 30)),
    ];
  }, []);

  const flagGeo = useMemo(
    () => new THREE.PlaneGeometry(FLAG_WIDTH, FLAG_HEIGHT, 1, 6),
    [],
  );

  const flagMat = useMemo(() => {
    if (typeof document === 'undefined') {
      return new MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    }
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const half = 32;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, half, half); ctx.fillRect(half, half, half, half);
    ctx.fillStyle = '#000'; ctx.fillRect(half, 0, half, half); ctx.fillRect(0, half, half, half);
    return makeFlagMaterial(new THREE.CanvasTexture(canvas));
  }, []);

  const mastGeo = useMemo(
    () => new THREE.CylinderGeometry(2, 2, FLAG_MAST_HEIGHT, 4, 1),
    [],
  );
  const mastMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#aaaaaa', roughness: 0.7 }),
    [],
  );

  useEffect(() => {
    return () => {
      flagGeo.dispose();
      (flagMat as THREE.Material).dispose();
      mastGeo.dispose();
      mastMat.dispose();
    };
  }, [flagGeo, flagMat, mastGeo, mastMat]);

  return (
    <group>
      {/* Start pads — 1 draw call */}
      <instancedMesh
        ref={padsRef}
        args={[padGeo, padMat, GRID_PAD_COUNT]}
        receiveShadow
        castShadow
      />

      {/* Countdown light gantry — 2 draw calls (bar + bulbs as shared geo) */}
      <GantryLights state={{ phase: gantryPhase }} gantryPos={gantryPos} />

      {/* Finish line flags — 2 draw calls + 2 masts */}
      {flagPositions.map((fp, i) => (
        <group key={i} position={fp.toArray()}>
          {/* Mast */}
          <mesh
            geometry={mastGeo}
            material={mastMat}
            position={[0, FLAG_MAST_HEIGHT / 2, 0]}
            matrixAutoUpdate={false}
          />
          {/* Flag plane — top of mast, wave via TSL positionNode */}
          <mesh
            geometry={flagGeo}
            material={flagMat}
            position={[FLAG_WIDTH / 2, FLAG_MAST_HEIGHT + FLAG_HEIGHT / 2, 0]}
          />
        </group>
      ))}
    </group>
  );
}
