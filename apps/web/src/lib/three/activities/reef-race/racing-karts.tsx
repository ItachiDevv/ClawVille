'use client';

/**
 * racing-karts.tsx — Animated surfboard karts riding the reef-race v2 spline.
 *
 * ─── DESIGN DECISIONS ────────────────────────────────────────────────────────
 *
 * 1. GLB clone approach (no ShaderMaterial / drei shaderMaterial factory)
 *    This component animates 5 surfboard_1.glb clones along the centripetal
 *    Catmull-Rom spline. There is no custom GLSL needed for the karts
 *    themselves — they use the GLB's original material (MeshStandardMaterial)
 *    with only `.color` replaced per kart. If a kart-wake/trail ribbon is added
 *    in a future phase, use the drei `shaderMaterial()` factory + `extend()` to
 *    get typed JSX uniforms and avoid imperative `mat.uniforms.X.value =`
 *    boilerplate. That pattern is NOT used here because there is no shader.
 *
 * 2. Banking sign convention (XYZ rotation order analysis)
 *    Three.js Euler XYZ default applies rotations: X, then Y, then Z — each in
 *    world-axis space at that step (extrinsic). After `rotation.y = yaw` the
 *    kart faces the travel direction. `rotation.z = bankAngle` then tilts the
 *    kart around the WORLD Z axis. On a LEFT-turning curve (CCW travel in XZ):
 *      · tangent rotates CCW → cross = tan.x*tanNext.z - tan.z*tanNext.x > 0
 *      · we want the kart top to lean LEFT (toward the inside of the turn)
 *      · world-Z tilt with positive angle tilts the kart top toward -X in world
 *      · after the yaw that is "left of forward" only when facing +X
 *    The exact sign depends on which direction the kart is facing. Bank lean is
 *    a subtle visual effect; the magnitude is clamped to ±0.4 rad (~23°).
 *    If the lean looks wrong in-browser, negate BANK_GAIN. Marked with TODO.
 *
 * 3. Per-frame allocation budget
 *    `clientSpline.centerlineAt/tangentAt/normalAt` each return a new `Vec2`
 *    value object (2 numbers). That is 4 Vec2 allocations per kart per frame
 *    (c, tan, n, tanNext) × 5 karts = 20 tiny object allocations / frame.
 *    These are below the GC-pressure threshold for small value objects in V8.
 *    The Three.js Object3D transform writes (position.set, rotation.set) use
 *    the existing object — no allocations there.
 *
 * 4. Clone management
 *    Both clone-building and group-attachment run in one `useEffect` keyed on
 *    `srcScene`. Separate effects would race under React's scheduling: a second
 *    effect could run after the first's cleanup, leaving an empty group.
 *
 * ─── IRIS XE CONSTRAINTS ─────────────────────────────────────────────────────
 *   - NO ShaderMaterial (and hence no InstancedMesh+ShaderMaterial)
 *   - NO drei <Text> or <Billboard>
 *   - import from 'three' only — never 'three/webgpu'
 *   - All static geometry/material at module scope — zero per-frame GC
 *   - frustumCulled=false on every kart (bounding box from bind pose is wrong)
 *   - matrixAutoUpdate=false; updateMatrix() called explicitly once per frame
 *
 * ─── DRAW CALL DELTA ─────────────────────────────────────────────────────────
 *   Previous static spawn: 4 surfboard meshes ≈ 4 draw calls
 *   This component:        5 surfboard meshes ≈ 5 draw calls
 *   Net delta:             +1 draw call
 *   (surfboard_1.glb is a single-material mesh — each clone = 1 draw call)
 */

import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

import {
  KART_SCALE,
  KART_Y_ABOVE_TRACK,
} from './reef-race-config';
import { clientSpline } from './reef-race-spline-instance';
import { elevationAtT } from './reef-race-elevation';

// SURF ROAD (2026-06-23): the karts ride the FLOATING ribbon, so their Y is the
// render-only elevation profile reefTrackElevationAt(t) (via elevationAtT) — NOT
// a flat WATER_Y plane (the old -200 canyon water surface is gone). The demo
// karts now climb/dip with the ribbon exactly like the player/bots do.

// ─── Race parameters ─────────────────────────────────────────────────────────

/** Starting t-values — spread karts across the spline so they don't stack. */
const KART_T_INIT: readonly number[] = [0.0, 0.18, 0.36, 0.54, 0.72];

/** Speed multipliers per kart — slight variance creates natural spread/grouping. */
const KART_SPEED_MULT: readonly number[] = [0.95, 1.0, 1.05, 0.97, 1.02];

/**
 * Lateral offset from centerline per kart (wu).
 * normalAt points LEFT of travel direction.
 * Positive = left of center, negative = right of center.
 */
const KART_LATERAL: readonly number[] = [-150, -75, 0, 75, 150];

/** Distinct cartoon colors per kart. */
const KART_COLORS: readonly string[] = [
  '#4ec5e8', // cyan-blue
  '#ffd700', // gold
  '#ff5e3a', // coral-red
  '#7cb342', // leaf-green
  '#a96cfd', // purple
];

/**
 * Base race speed in wu/s.
 * totalArcLength ≈ 19 000–30 000 wu; at 700 wu/s one lap ≈ 27–43 s.
 * Demo pace — leisurely enough to see motion without being a blur.
 */
const BASE_SPEED_WU_PER_S = 700.0;

/** Bob amplitude in wu (gentle floating). */
const BOB_AMP = 4.0;

/** Bob frequency in rad/s. */
const BOB_FREQ = 1.5;

/** Phase offset between karts' bobs so they don't peak simultaneously. */
const BOB_PHASE_STEP = 0.7;

/** t-step for finite-difference curvature estimation. */
const CURVE_DELTA = 0.005;

/** Banking lean clamp magnitude (±0.4 rad ≈ ±23°). */
const BANK_CLAMP = 0.4;

/**
 * Banking gain: cross-product magnitude → radians.
 * TODO: if lean looks wrong in-browser, negate this constant.
 */
const BANK_GAIN = 60.0;

// ─── Module-scope tint colors (built once) ───────────────────────────────────
const _kartColors = KART_COLORS.map((hex) => new THREE.Color(hex));

// ─── Preload surfboard GLB ────────────────────────────────────────────────────
useGLTF.preload('/models/reef-race/surfboards/surfboard_1.glb');

// ─── Color tinting helper ─────────────────────────────────────────────────────
/**
 * Tint a kart by replacing `.color` on each material — but CLONE the material first.
 * `scene.clone(true)` SHARES material instances across all 5 kart clones, so tinting
 * in place would make the LAST kart's colour win on every kart (all 5 identical). The
 * clone preserves maps, roughness, metalness, etc. while giving each kart its own colour.
 */
function applyColorTint(root: THREE.Object3D, color: THREE.Color): void {
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((mat) => {
        if (!mat) return mat;
        const m = mat.clone();
        const tintable = m as THREE.Material & { color?: THREE.Color };
        if (tintable.color?.isColor) tintable.color.copy(color);
        return m;
      });
    } else if (mesh.material) {
      const m = mesh.material.clone();
      const tintable = m as THREE.Material & { color?: THREE.Color };
      if (tintable.color?.isColor) tintable.color.copy(color);
      mesh.material = m;
    }
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RacingKarts() {
  const { scene: srcScene } = useGLTF('/models/reef-race/surfboards/surfboard_1.glb');

  /** Mutable t-values per kart (no React state — mutated in useFrame). */
  const tRef = useRef<Float32Array>(
    new Float32Array(KART_T_INIT as unknown as number[]),
  );

  /** Parent group added to R3F scene. */
  const groupRef = useRef<THREE.Group>(null);

  /** Direct references to the 5 kart scene-graph roots. */
  const kartRefs = useRef<(THREE.Object3D | null)[]>([null, null, null, null, null]);

  // Build 5 colored clones and attach them to the group.
  // Runs once when the surfboard GLB is ready, and on hot-reload.
  useEffect(() => {
    const group = groupRef.current;
    if (!group || !srcScene) return;

    // Remove stale clones from previous mount
    while (group.children.length > 0) group.remove(group.children[0]);

    for (let i = 0; i < 5; i++) {
      // Clone entire scene graph — surfboard_1.glb has no skinning so
      // scene.clone(true) is safe (SkeletonUtils.clone not needed).
      const clone = srcScene.clone(true);

      // Disable frustum culling — bounding sphere comes from rest pose
      // and is wrong once the kart moves.
      clone.traverse((child) => {
        child.frustumCulled = false;
      });

      // Apply per-kart color tint
      applyColorTint(clone, _kartColors[i]);

      // Initial transform at starting t
      const t0 = KART_T_INIT[i];
      const c = clientSpline.centerlineAt(t0);
      const tan = clientSpline.tangentAt(t0);
      const n = clientSpline.normalAt(t0);
      const lat = KART_LATERAL[i];

      clone.scale.setScalar(KART_SCALE);
      clone.position.set(
        c.x + n.x * lat,
        elevationAtT(t0) + KART_Y_ABOVE_TRACK,
        c.z + n.z * lat,
      );
      clone.rotation.set(0, Math.atan2(tan.x, tan.z), 0);
      clone.matrixAutoUpdate = false;
      clone.updateMatrix();

      kartRefs.current[i] = clone;
      group.add(clone);
    }

    return () => {
      // Cleanup: remove clones. Geometry is shared with srcScene so don't dispose.
      while (group.children.length > 0) group.remove(group.children[0]);
      kartRefs.current.fill(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcScene]);

  // ─── Per-frame animation ────────────────────────────────────────────────────
  useFrame((state, dt) => {
    const karts = kartRefs.current;
    const tArr = tRef.current;
    const elapsed = state.clock.elapsedTime;
    const totalArc = clientSpline.totalArcLength;

    // Guard: clones not yet built (before srcScene resolves)
    if (!karts[0]) return;

    // wu/s → t/s for base speed
    const tPerSecBase = BASE_SPEED_WU_PER_S / totalArc;

    for (let i = 0; i < 5; i++) {
      const kart = karts[i];
      if (!kart) continue;

      // ── Advance t ──────────────────────────────────────────────────────────
      let tc = tArr[i] + tPerSecBase * KART_SPEED_MULT[i] * dt;
      if (tc >= 1.0) tc -= 1.0;
      tArr[i] = tc;

      // ── Sample spline ──────────────────────────────────────────────────────
      // Vec2 { x, z } — centripetal Catmull-Rom, O(log LUT)
      const c   = clientSpline.centerlineAt(tc);
      const tan = clientSpline.tangentAt(tc);
      const n   = clientSpline.normalAt(tc);

      // ── World position ────────────────────────────────────────────────────
      const lat = KART_LATERAL[i];
      const wx  = c.x + n.x * lat;
      const wz  = c.z + n.z * lat;
      const wy  = elevationAtT(tc) + KART_Y_ABOVE_TRACK
                + Math.sin(elapsed * BOB_FREQ + i * BOB_PHASE_STEP) * BOB_AMP;

      // ── Banking lean via curvature finite difference ───────────────────────
      const tNext    = (tc + CURVE_DELTA) % 1.0;
      const tanNext  = clientSpline.tangentAt(tNext);
      // Z-component of (tan × tanNext) in XZ plane:
      //   positive = CCW turn = left curve
      const cross    = tan.x * tanNext.z - tan.z * tanNext.x;
      const bankAngle = Math.max(-BANK_CLAMP, Math.min(BANK_CLAMP, cross * BANK_GAIN));

      // ── Yaw (face direction of travel) ───────────────────────────────────
      // surfboard_1.glb faces: unknown from GLB alone; matching the pattern used
      // by river-scene.tsx static karts (atan2(tan.x, tan.z) for +Z-forward models).
      const yaw = Math.atan2(tan.x, tan.z);

      // ── Apply transform & push to GPU ────────────────────────────────────
      kart.position.set(wx, wy, wz);
      // Euler XYZ order: X applied first in world, then Y, then Z.
      // rotation.y = yaw aligns forward; rotation.z = bankAngle leans sideways.
      kart.rotation.set(0, yaw, bankAngle);
      kart.updateMatrix();
    }
  });

  return <group ref={groupRef} />;
}
