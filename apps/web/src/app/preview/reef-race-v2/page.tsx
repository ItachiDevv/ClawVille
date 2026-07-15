'use client';

/**
 * /preview/reef-race-v2 — visual verification route for the v2 spline track.
 *
 * DEV-ONLY: bypasses NEXT_PUBLIC_REEF_RACE_USE_SPLINE env flag so the human
 * can always inspect the v2 river-bed, surfboard scale, and proportions.
 *
 * What to check:
 *   1. Track scale relative to the surfboard board
 *   2. Surfboard size relative to the magenta 5wu reference cube
 *   3. Surfboard Y mounting (on the river bed, not floating/sinking)
 *   4. River corridor width (4-5 karts side by side?)
 *   5. Bank wall heights — too short, too tall, fine?
 *   6. 3 extra karts at t=0.25, 0.5, 0.75 — consistent bed Y across curve
 *   7. Lighting + materials OK on Iris Xe (hemisphere + directional only)
 *   8. Tri count shown in overlay
 *
 * Iris Xe invariants enforced:
 *   - No drei <Text> / <Billboard> — all labels are DOM HTML overlays
 *   - No InstancedMesh + ShaderMaterial
 *   - No per-frame allocations (module-scope scratch primitives only)
 *   - import from 'three' (NOT 'three/webgpu')
 *   - frustumCulled=false on every cloned SkinnedMesh scene
 *   - All geo/mat at module scope — zero repeated GC pressure
 *   - 1 hemisphere + 1 directional light with 1 shadow map (512×512)
 */

export const dynamic = 'force-dynamic';

import { Suspense, useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeGeometryWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { RiverScene } from '@/lib/three/activities/reef-race/river-scene';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';
import { preloadKTX2Bytes, useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';

// ─── Spline instance (always v2, bypasses env flag) ──────────────────────────
// Import the same singleton used by ReefRaceTrack so we share the pre-built
// arclength LUT. Module-load cost: ~1 ms (1 000-point Simpson integration).
import { clientSpline } from '@/lib/three/activities/reef-race/reef-race-spline-instance';

// ─── Kart / geometry constants ────────────────────────────────────────────────
import {
  KART_SCALE,
  KART_Y_ABOVE_TRACK,
  GLIDER_WIDTH,
  GLIDER_HEIGHT,
  GLIDER_LENGTH,
  RIDER_MOUNT_OFFSET_DEFAULT,
} from '@/lib/three/activities/reef-race/reef-race-config';

// ─── Production lighting / fog constants (inlined from ReefRaceScene values) ──
// Inlined rather than imported to avoid cross-module 'use client' import issues.
const FOG_COLOR            = '#a8d8ff'; // sky-blue atmospheric haze, matches SkyDome horizon
// Track is 18 000 wu long × ±500 wu wide. FOG tuned for open-vista feel:
// near=8000 keeps foreground crisp, far=30000 gives soft haze on distant banks.
// CAMERA_FAR stays at 35000 so the dome (radius=28000) renders correctly.
const FOG_NEAR             = 8000;
const FOG_FAR              = 30000;
const CAMERA_NEAR          = 1;
const CAMERA_FAR           = 35000;
const HEMI_SKY_COLOR       = '#a8d8ff'; // matches SkyDome horizon
const HEMI_GROUND_COLOR    = '#7cb342'; // grass green — matches GroundPlane + bank walls
const HEMI_INTENSITY       = 0.5;
const DIR_COLOR            = '#fffbe6';
const DIR_INTENSITY        = 1.2;
// Sun position scaled 10× so the shadow frustum encloses the whole 18 000-wu track.
const DIR_POSITION         = [3000, 8000, 2000] as const;
const DIR_SHADOW_MAP_SIZE  = 1024;
const DIR_SHADOW_NEAR      = 1;
const DIR_SHADOW_FAR       = 25000;
const DIR_SHADOW_CAM_BOUNDS = 12000;

// ─── Preload assets ───────────────────────────────────────────────────────────
useGLTF.preload('/models/reef-race/surfboards/surfboard_1.glb');
preloadKTX2Bytes('/models/lobster-ktx.glb?v=2');

// ─── Camera mode ─────────────────────────────────────────────────────────────
const CAMERA_MODES = ['free-orbit', 'top-down', 'cinematic', 'side-on'] as const;
type CameraMode = (typeof CAMERA_MODES)[number];

function isCameraMode(s: string | null): s is CameraMode {
  return CAMERA_MODES.includes(s as CameraMode);
}

// ─── Track geometry constants (mirroring ReefRaceTrack v2 values) ────────────
const V2_RIBBON_SAMPLES = 64;
const V2_BANK_HEIGHT    = 80;  // wu — must match ReefRaceTrack

// ─── Module-scope scratch (no per-frame allocations) ─────────────────────────
const _sc1 = new THREE.Vector3();
const _sc2 = new THREE.Vector3();

// ─── Module-scope materials (page-lifetime, never disposed) ──────────────────
// Mirrors the exact materials in ReefRaceTrack.tsx for an accurate preview.

/** Sandy river-bed surface. */
const _riverMat = new THREE.MeshStandardMaterial({
  color: 0xc8a572,
  roughness: 0.85,
  metalness: 0.0,
  side: THREE.DoubleSide,
  fog: false,
});

/**
 * Bank walls — recolored to grass green so they blend with the new ground plane
 * and sandy ribbon from RiverScene. The old dark-brown 0x6b5544 showed as an
 * ugly black stripe in the cinematic view (v1 leftover).
 */
const _bankMat = new THREE.MeshStandardMaterial({
  color: 0x7cb342,  // grass green — matches GroundPlane in river-scene.tsx
  roughness: 0.9,
  metalness: 0.0,
  side: THREE.DoubleSide,
  fog: false,
});

/** Finish-line gate (gold). */
const _finishMat = new THREE.MeshStandardMaterial({
  color: 0xffd600,
  roughness: 0.3,
  metalness: 0.6,
  fog: false,
  emissive: new THREE.Color(0xffd600),
  emissiveIntensity: 0.3,
});

/** Magenta reference cube (yardstick). */
const _refCubeMat = new THREE.MeshStandardMaterial({
  color: 0xff00ff,
  roughness: 0.5,
  metalness: 0.2,
  fog: false,
});

/** Faint grid on river bed. */
const _gridMat = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  wireframe: true,
  opacity: 0.12,
  transparent: true,
  fog: false,
});

// ─── Reference cube geometry (5wu × 5wu × 5wu) ───────────────────────────────
const _refCubeGeo = new THREE.BoxGeometry(5, 5, 5);

// ─── Geometry builders (mirrors ReefRaceTrack.tsx buildSpline* exactly) ──────

function buildSplineRibbonGeo(samples: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[]   = [];
  const uvs: number[]       = [];
  const indices: number[]   = [];

  for (let i = 0; i <= samples; i++) {
    const t  = i / samples;
    const c  = clientSpline.centerlineAt(t);
    const n  = clientSpline.normalAt(t);
    const hw = clientSpline.widthAt(t);

    // Left edge (normal = 90° CCW of tangent = left of travel)
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
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,       2));
  geo.setIndex(indices);
  return makeGeometryWebGPUSafe(geo);
}

function buildSplineBankGeos(
  samples: number,
): { left: THREE.BufferGeometry; right: THREE.BufferGeometry } {
  const leftGeos:  THREE.BufferGeometry[] = [];
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

    // Left bank
    {
      const lx0 = c0.x + n0.x * hw0;  const lz0 = c0.z + n0.z * hw0;
      const lx1 = c1.x + n1.x * hw1;  const lz1 = c1.z + n1.z * hw1;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        lx0, 0,              lz0,
        lx0, V2_BANK_HEIGHT, lz0,
        lx1, 0,              lz1,
        lx1, V2_BANK_HEIGHT, lz1,
      ]), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
        n0.x, 0, n0.z,  n0.x, 0, n0.z,
        n1.x, 0, n1.z,  n1.x, 0, n1.z,
      ]), 3));
      geo.setIndex([0, 1, 2, 1, 3, 2]);
      leftGeos.push(geo);
    }

    // Right bank
    {
      const rx0 = c0.x - n0.x * hw0;  const rz0 = c0.z - n0.z * hw0;
      const rx1 = c1.x - n1.x * hw1;  const rz1 = c1.z - n1.z * hw1;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        rx0, 0,              rz0,
        rx0, V2_BANK_HEIGHT, rz0,
        rx1, 0,              rz1,
        rx1, V2_BANK_HEIGHT, rz1,
      ]), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
        -n0.x, 0, -n0.z,  -n0.x, 0, -n0.z,
        -n1.x, 0, -n1.z,  -n1.x, 0, -n1.z,
      ]), 3));
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

function buildFinishGateGeo(): THREE.BufferGeometry {
  const c    = clientSpline.centerlineAt(1.0);
  const n    = clientSpline.normalAt(1.0);
  const hw   = clientSpline.widthAt(1.0);
  const pillarR = 15;
  const pillarH = 200;
  const barH    = 15;

  const lx = c.x + n.x * hw;  const lz = c.z + n.z * hw;
  const rx = c.x - n.x * hw;  const rz = c.z - n.z * hw;

  const lp  = new THREE.CylinderGeometry(pillarR, pillarR, pillarH, 8);
  const rp  = new THREE.CylinderGeometry(pillarR, pillarR, pillarH, 8);
  const bar = new THREE.BoxGeometry(hw * 2 + pillarR * 2, barH, pillarR);

  lp.applyMatrix4(new THREE.Matrix4().makeTranslation(lx, pillarH / 2, lz));
  rp.applyMatrix4(new THREE.Matrix4().makeTranslation(rx, pillarH / 2, rz));
  bar.applyMatrix4(new THREE.Matrix4().makeTranslation(c.x, pillarH + barH / 2, c.z));

  const merged = makeGeometryWebGPUSafe(mergeGeometries([lp, rp, bar])!);
  lp.dispose(); rp.dispose(); bar.dispose();
  return merged;
}

/** Build a faint 100wu × 100wu grid at the start-line position. */
function buildStartGrid100(): THREE.BufferGeometry {
  const c  = clientSpline.centerlineAt(0);
  const hw = 50; // 100wu total width, 100wu total length
  const geo = new THREE.PlaneGeometry(hw * 2, hw * 2, 10, 10);
  geo.rotateX(-Math.PI / 2);
  geo.translate(c.x, 0.5, c.z); // slight Y offset to prevent z-fighting with river bed
  return geo;
}

// ─── Measurement helpers ──────────────────────────────────────────────────────

/** Compute bounding box of scene in world space, ignoring SkinnedMesh nodes. */
function safeBBox(obj: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (o as unknown as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (!mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const local = mesh.geometry.boundingBox!.clone();
    local.applyMatrix4(mesh.matrixWorld);
    box.union(local);
  });
  return box;
}

/** Count triangles in an Object3D tree. */
function countTris(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const idx = mesh.geometry.index;
    tris += idx ? idx.count / 3 : (mesh.geometry.attributes.position?.count ?? 0) / 3;
  });
  return Math.round(tris);
}

// ─── Kart positions at 4 track t-values ──────────────────────────────────────
const KART_T_VALUES = [0, 0.25, 0.5, 0.75] as const;

// ─── Camera preset positions ──────────────────────────────────────────────────
// All computed at module scope from spline to avoid repeated calls.
const _startCenter = clientSpline.centerlineAt(0);

// All preset distances sized for an 18 000-wu-long, ±500-wu-wide spline.
// FOV is 50° → half-angle 25° → tan ≈ 0.466. To frame the whole track
// from above (~20 000 wu visible Z) we need altitude ≈ 21 500 wu.

/** Top-down: directly above track midpoint, frames the whole spline. */
const TOPDOWN_CAM    = new THREE.Vector3(_startCenter.x, 22000, _startCenter.z + 9000);
const TOPDOWN_TARGET = new THREE.Vector3(_startCenter.x, 0,     _startCenter.z + 9000);

/** Side-on: perpendicular to start tangent, elevated. */
const _startNormal = clientSpline.normalAt(0);
const SIDEON_CAM    = new THREE.Vector3(
  _startCenter.x + _startNormal.x * 6000,
  2400,
  _startCenter.z + _startNormal.z * 6000,
);
const SIDEON_TARGET = new THREE.Vector3(_startCenter.x, -50, _startCenter.z + 4000);

/** Cinematic: INSIDE the canyon at water level — racer's POV. */
const _startTangent = clientSpline.tangentAt(0);
// 2026-04-29 iter-6b: cam relocated INSIDE the canyon. Altitude 150 above
// ground stared at green grass — cliff face was foreshortened to nothing.
// Now cam sits at y=-150 (50wu above water surface y=-200), behind the start
// kart, looking forward down the channel — cliff walls flank the view, water
// fills the foreground, sky-blue dome above the canyon rim.
const CINEMATIC_CAM = new THREE.Vector3(
  _startCenter.x - _startTangent.x * 700,
  -150,                                         // option-C: deep canyon, cam y=-150 (50wu above water)
  _startCenter.z - _startTangent.z * 700,
);
const CINEMATIC_TARGET = new THREE.Vector3(_startCenter.x, -180, _startCenter.z + 2000);

/** Default free-orbit position: 3/4 perspective showing whole track length. */
const FREE_CAM    = new THREE.Vector3(_startCenter.x + 8000, 8000, _startCenter.z + 28000);
const FREE_TARGET = new THREE.Vector3(_startCenter.x, 0, _startCenter.z + 14000);

// ─── Spline Track component ───────────────────────────────────────────────────

function SplineTrack({ onTriUpdate }: { onTriUpdate: (n: number) => void }) {
  const riverRef  = useRef<THREE.Mesh>(null);
  const bankGroup = useRef<THREE.Group>(null);
  const finishRef = useRef<THREE.Mesh>(null);
  const gridRef   = useRef<THREE.Mesh>(null);

  const riverGeo  = useMemo(() => buildSplineRibbonGeo(V2_RIBBON_SAMPLES), []);
  const bankGeos  = useMemo(() => buildSplineBankGeos(V2_RIBBON_SAMPLES),  []);
  const finishGeo = useMemo(() => buildFinishGateGeo(), []);
  const gridGeo   = useMemo(() => buildStartGrid100(), []);

  useEffect(() => {
    let tris = 0;
    if (riverRef.current)  tris += countTris(riverRef.current);
    if (bankGroup.current) tris += countTris(bankGroup.current);
    if (finishRef.current) tris += countTris(finishRef.current);
    onTriUpdate(tris);
  }, [riverGeo, bankGeos, finishGeo, onTriUpdate]);

  useEffect(() => {
    // Freeze transforms for static geo (Iris Xe perf)
    [riverRef.current, finishRef.current, gridRef.current].forEach(m => {
      if (m) { m.matrixAutoUpdate = false; m.updateMatrix(); }
    });
    if (bankGroup.current) {
      bankGroup.current.traverse(o => {
        if ((o as THREE.Mesh).isMesh) { o.matrixAutoUpdate = false; (o as THREE.Mesh).updateMatrix(); }
      });
    }
    return () => {
      riverGeo.dispose();
      bankGeos.left.dispose();
      bankGeos.right.dispose();
      finishGeo.dispose();
      gridGeo.dispose();
    };
  }, [riverGeo, bankGeos, finishGeo, gridGeo]);

  return (
    <group>
      {/* River bed — position.y -250 cascades from iter-6 WATER_Y=-200 (bed 50wu below water) */}
      <mesh ref={riverRef} geometry={riverGeo} material={_riverMat} position-y={-250} receiveShadow matrixAutoUpdate={false} />

      {/* Bank walls — HIDDEN: replaced by <RockyBanks /> from rocky-banks.tsx
          which provides the canyon cliff geometry. The old grass-green bank
          walls overlapped the new cliffs and cast shadows producing dark
          rectangles inside the river area (iter-5b regression). */}
      <group ref={bankGroup} visible={false}>
        <mesh geometry={bankGeos.left}  material={_bankMat} matrixAutoUpdate={false} />
        <mesh geometry={bankGeos.right} material={_bankMat} matrixAutoUpdate={false} />
      </group>

      {/* Finish gate */}
      <mesh ref={finishRef} geometry={finishGeo} material={_finishMat} castShadow matrixAutoUpdate={false} />

      {/* 100wu × 100wu scale grid at start */}
      <mesh ref={gridRef} geometry={gridGeo} material={_gridMat} matrixAutoUpdate={false} />
    </group>
  );
}

// ─── Reference cube component ─────────────────────────────────────────────────
// Placed at z=200 wu from start line. Magenta so it's unmistakable.

function RefCube() {
  const c = clientSpline.centerlineAt(0);
  return (
    <mesh
      geometry={_refCubeGeo}
      material={_refCubeMat}
      position={[c.x + 80, 2.5, c.z + 200]}
      matrixAutoUpdate={false}
    />
  );
}

// ─── Single surfboard + lobster kart ─────────────────────────────────────────

interface KartProps {
  t: number;
  color: string;
  onMounted?: (obj: THREE.Group) => void;
  visible?: boolean;
}

function SplineSurfboardKart({ t, color, onMounted, visible = true }: KartProps) {
  const { scene: sbSrc }   = useGLTF('/models/reef-race/surfboards/surfboard_1.glb');
  const { scene: lobSrc }  = useGLTFWithKTX2('/models/lobster-ktx.glb?v=2');

  const groupRef   = useRef<THREE.Group>(null);
  const gliderRef  = useRef<THREE.Group>(null);
  const riderRef   = useRef<THREE.Group>(null);

  const clonedSurf = useMemo(() => {
    const sb = sbSrc.clone(true);
    sb.traverse(o => { o.frustumCulled = false; });
    // Apply color tint (50% blend — same as ReefRacePlayer)
    sb.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const applyTint = (m: THREE.Material) => {
        if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
          const c = (m as THREE.MeshStandardMaterial).clone();
          c.color.lerp(new THREE.Color(color), 0.5);
          return c;
        }
        return m;
      };
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(applyTint)
        : applyTint(mesh.material);
    });
    sb.scale.set(GLIDER_WIDTH, GLIDER_HEIGHT * 4, GLIDER_LENGTH);
    return sb;
  }, [sbSrc, color]);

  const clonedLob = useMemo(() => {
    const lob = skeletonClone(lobSrc);
    lob.traverse(o => { o.frustumCulled = false; });
    return lob;
  }, [lobSrc]);

  // Attach surfboard clone to gliderRef
  useEffect(() => {
    const g = gliderRef.current;
    if (!g) return;
    g.add(clonedSurf);
    return () => { g.remove(clonedSurf); };
  }, [clonedSurf]);

  // Attach lobster clone to riderRef
  useEffect(() => {
    const r = riderRef.current;
    if (!r) return;
    r.add(clonedLob);
    return () => { r.remove(clonedLob); };
  }, [clonedLob]);

  // Place group at spline position + Y = 0 (on river bed)
  useEffect(() => {
    const gr = groupRef.current;
    if (!gr) return;
    const c = clientSpline.centerlineAt(t);
    const tangent = clientSpline.tangentAt(t);
    gr.position.set(c.x, 0, c.z);
    // Facing angle: atan2(tx, tz) — tangent faces direction of travel
    gr.rotation.y = Math.atan2(tangent.x, tangent.z);
    gr.updateMatrix();
    gr.matrixAutoUpdate = false;
    if (onMounted) onMounted(gr);
  }, [t, onMounted]);

  // GLIDER_LOCAL_Y = KART_Y_ABOVE_TRACK / KART_SCALE
  const gliderLocalY = KART_Y_ABOVE_TRACK / KART_SCALE;

  return (
    <group ref={groupRef} scale={[KART_SCALE, KART_SCALE, KART_SCALE]} visible={visible}>
      <group ref={gliderRef} position={[0, gliderLocalY, 0]}>
        {/* clonedSurf attached via useEffect */}
        <group ref={riderRef} position={RIDER_MOUNT_OFFSET_DEFAULT}>
          {/* clonedLob attached via useEffect */}
        </group>
      </group>
    </group>
  );
}

// ─── Production lighting (mirrors ReefLight in ReefRaceScene.tsx) ─────────────

function PreviewLighting() {
  const dirRef = useRef<THREE.DirectionalLight>(null);
  useEffect(() => {
    const d = dirRef.current;
    if (!d) return;
    d.shadow.mapSize.set(DIR_SHADOW_MAP_SIZE, DIR_SHADOW_MAP_SIZE);
    d.shadow.camera.near = DIR_SHADOW_NEAR;
    d.shadow.camera.far  = DIR_SHADOW_FAR;
    const oc = d.shadow.camera as THREE.OrthographicCamera;
    oc.left = oc.bottom = -DIR_SHADOW_CAM_BOUNDS;
    oc.right = oc.top   =  DIR_SHADOW_CAM_BOUNDS;
    oc.updateProjectionMatrix();
    d.matrixAutoUpdate = false;
    d.updateMatrix();
  }, []);

  return (
    <>
      <hemisphereLight args={[HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY]} />
      <directionalLight
        ref={dirRef}
        color={DIR_COLOR}
        intensity={DIR_INTENSITY}
        position={DIR_POSITION}
        castShadow
      />
    </>
  );
}

// ─── Camera controller ────────────────────────────────────────────────────────

interface CamControllerProps {
  mode: CameraMode;
  autoRotate: boolean;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  onCamDist: (d: number) => void;
}

function CamController({ mode, autoRotate, controlsRef, onCamDist }: CamControllerProps) {
  const { camera } = useThree();

  // Apply preset on mode change
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    cam.near = CAMERA_NEAR;
    cam.far  = CAMERA_FAR;
    cam.fov  = 60;

    const ctrl = controlsRef.current;
    if (!ctrl) return;

    switch (mode) {
      case 'top-down': {
        cam.position.copy(TOPDOWN_CAM);
        ctrl.target.copy(TOPDOWN_TARGET);
        // Switch to no FOV perspective for top-down clarity
        cam.fov = 50;
        break;
      }
      case 'side-on': {
        cam.position.copy(SIDEON_CAM);
        ctrl.target.copy(SIDEON_TARGET);
        break;
      }
      case 'cinematic': {
        cam.position.copy(CINEMATIC_CAM);
        ctrl.target.copy(CINEMATIC_TARGET);
        break;
      }
      default: {
        // free-orbit
        cam.position.copy(FREE_CAM);
        ctrl.target.copy(FREE_TARGET);
        break;
      }
    }
    cam.updateProjectionMatrix();
    ctrl.update();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Cinematic — STATIC inside canyon (no orbit). Removed orbit because it
  // pushed the cam OUT of the canyon during sweep, breaking the "inside the
  // ravine" framing. Static keeps the player POV consistent.
  useFrame(() => {
    if (mode === 'cinematic') {
      const ctrl = controlsRef.current;
      if (!ctrl) return;
      camera.position.copy(CINEMATIC_CAM);
      ctrl.target.copy(CINEMATIC_TARGET);
      ctrl.update();
    }

    // Emit camera-to-origin distance for overlay
    onCamDist(camera.position.distanceTo(_sc1.set(0, 0, 0)));
  });

  return null;
}

// ─── Measurement collector ────────────────────────────────────────────────────
// Reads surfboard bounding box and river half-width at t=0, reports to parent.

interface MeasurementsProps {
  kartGroupRef: React.RefObject<THREE.Group | null>;
  onMeasurements: (m: PreviewMeasurements) => void;
}

interface PreviewMeasurements {
  boardW: number;
  boardL: number;
  boardH: number;
  riverHalfW: number;
  riverHalfWAt025: number;
}

function MeasurementCollector({ kartGroupRef, onMeasurements }: MeasurementsProps) {
  const measured = useRef(false);

  useFrame(() => {
    if (measured.current) return;
    const gr = kartGroupRef.current;
    if (!gr) return;

    // Force matrix world update for a freshly-placed static group
    gr.updateMatrixWorld(true);
    const box = safeBBox(gr);
    if (box.isEmpty()) return;

    measured.current = true;
    const sz = _sc2.set(0, 0, 0);
    box.getSize(sz as THREE.Vector3);

    onMeasurements({
      boardW:        parseFloat(sz.x.toFixed(1)),
      boardL:        parseFloat(sz.z.toFixed(1)),
      boardH:        parseFloat(sz.y.toFixed(1)),
      riverHalfW:    parseFloat(clientSpline.widthAt(0).toFixed(1)),
      riverHalfWAt025: parseFloat(clientSpline.widthAt(0.25).toFixed(1)),
    });
  });

  return null;
}

// ─── Scene contents ───────────────────────────────────────────────────────────

interface SceneContentsProps {
  mode: CameraMode;
  autoRotate: boolean;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  onTriCount: (total: number) => void;
  onCamDist: (d: number) => void;
  onMeasurements: (m: PreviewMeasurements) => void;
}

// Stable kart colors for the 4 t-values
const KART_COLORS = ['#00ccff', '#ff4400', '#44ff44', '#ffcc00'];

function SceneContents({
  mode,
  autoRotate,
  controlsRef,
  onTriCount,
  onCamDist,
  onMeasurements,
}: SceneContentsProps) {
  // Tri counts from each sub-component, summed
  const trackTriRef  = useRef(0);
  const kartTrisRef  = useRef([0, 0, 0, 0]);
  const triUpdateTick = useRef(0);

  const reportTrackTris = useCallback((n: number) => {
    trackTriRef.current = n;
    triUpdateTick.current++;
    onTriCount(trackTriRef.current + kartTrisRef.current.reduce((a, b) => a + b, 0));
  }, [onTriCount]);

  // Kart group ref for start kart (t=0) — used for measurements
  const startKartRef = useRef<THREE.Group | null>(null);
  const handleKartMounted = useCallback((gr: THREE.Group) => {
    startKartRef.current = gr;
  }, []);

  // Grab tris from scene after mount (simple: use gl.info.render)
  const { gl } = useThree();
  useFrame(() => {
    // Expose draw triangles in overlay via gl.info
    void gl; // reference used in overlay via onTriCount from track geo
  });

  return (
    <>
      <CamController
        mode={mode}
        autoRotate={autoRotate}
        controlsRef={controlsRef}
        onCamDist={onCamDist}
      />

      {/* Free orbit / top-down / side-on: OrbitControls enabled; cinematic: overridden by CamController */}
      <OrbitControls
        ref={controlsRef as unknown as React.Ref<OrbitControlsImpl>}
        enableDamping
        dampingFactor={0.08}
        autoRotate={autoRotate && mode === 'free-orbit'}
        autoRotateSpeed={1.0}
        // Prevent going under the river bed
        maxPolarAngle={Math.PI * 0.85}
        // Clamp zoom so the user can't drift past CAMERA_FAR (35 000 wu) and
        // see an empty sky-blue void. Confirmed 2026-04-29 from the user
        // reporting "as you zoom out, everything disappears" — orbit had
        // reached 1 033 782 wu, well past the far plane.
        minDistance={500}
        maxDistance={28000}
      />

      {/* Production fog */}
      <fog args={[FOG_COLOR, FOG_NEAR, FOG_FAR]} />
      {/* Sky-blue clear color matches SkyDome horizon — prevents flash before dome renders */}
      <color attach="background" args={['#a8d8ff']} />

      {/* Low-poly stylized river atmosphere — dome, water surface, scenery */}
      <RiverScene />

      {/* Production lighting */}
      <PreviewLighting />

      {/* River bed + bank walls + finish gate + scale grid */}
      <Suspense fallback={null}>
        <SplineTrack onTriUpdate={reportTrackTris} />
      </Suspense>

      {/* Demo karts now ride via <AnimatedKarts /> inside <RiverScene> — see
          river-scene.tsx. The static t=0 SplineSurfboardKart is still mounted
          (invisible) to keep the bbox-measurement HUD readout populated. */}
      <Suspense fallback={null}>
        <SplineSurfboardKart
          t={0}
          color={KART_COLORS[0]!}
          onMounted={handleKartMounted}
          visible={false}
        />
      </Suspense>

      {/* Measurement collector — reads start kart bbox */}
      <MeasurementCollector
        kartGroupRef={startKartRef}
        onMeasurements={onMeasurements}
      />

      {/* Magenta reference cube: 5wu × 5wu × 5wu at z=+200 from start */}
      <RefCube />
    </>
  );
}

// ─── Overlay panel ────────────────────────────────────────────────────────────

interface OverlayProps {
  mode: CameraMode;
  triCount: number | null;
  camDist: number;
  frameMs: number;
  autoRotate: boolean;
  measurements: PreviewMeasurements | null;
  onModeChange: (m: CameraMode) => void;
  onToggleAutoRotate: () => void;
  onResetCamera: () => void;
}

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  background: 'rgba(0,0,0,0.68)',
  color: '#cde',
  fontFamily: 'monospace',
  fontSize: 12,
  lineHeight: 1.6,
  padding: '10px 14px',
  borderRadius: 6,
  zIndex: 20,
  minWidth: 260,
  pointerEvents: 'auto',
  userSelect: 'none',
};

const labelStyle: React.CSSProperties = {
  color: '#8ab',
  display: 'inline-block',
  width: 160,
};

const valStyle: React.CSSProperties = {
  color: '#fff',
  fontWeight: 'bold',
};

const selectStyle: React.CSSProperties = {
  background: '#1a3a6b',
  color: '#cde',
  border: '1px solid #4488cc',
  borderRadius: 4,
  padding: '2px 6px',
  fontSize: 12,
  cursor: 'pointer',
  marginTop: 6,
  width: '100%',
};

const btnStyle: React.CSSProperties = {
  background: '#1a3a6b',
  color: '#cde',
  border: '1px solid #4488cc',
  borderRadius: 4,
  padding: '3px 10px',
  fontSize: 12,
  cursor: 'pointer',
  marginTop: 4,
  marginRight: 4,
};

function OverlayPanel({
  mode,
  triCount,
  camDist,
  frameMs,
  autoRotate,
  measurements,
  onModeChange,
  onToggleAutoRotate,
  onResetCamera,
}: OverlayProps) {
  return (
    <div style={overlayStyle}>
      <div style={{ fontWeight: 'bold', fontSize: 13, marginBottom: 6, color: '#fff', letterSpacing: 1 }}>
        Reef Race v2 Preview
      </div>

      {/* Performance */}
      <div><span style={labelStyle}>Triangles</span><span style={valStyle}>{triCount !== null ? triCount.toLocaleString() : '—'}</span></div>
      <div><span style={labelStyle}>Frame time</span><span style={valStyle}>{frameMs > 0 ? frameMs.toFixed(1) + ' ms' : '—'}</span></div>
      <div><span style={labelStyle}>Cam dist from origin</span><span style={valStyle}>{camDist.toFixed(0)} wu</span></div>

      {/* Measurements */}
      <div style={{ marginTop: 8, borderTop: '1px solid #334', paddingTop: 6 }}>
        <div style={{ color: '#8ab', fontSize: 11, marginBottom: 4 }}>MEASUREMENTS (at t=0 start kart)</div>
        <div><span style={labelStyle}>Surfboard width</span><span style={valStyle}>{measurements ? measurements.boardW + ' wu' : '—'}</span></div>
        <div><span style={labelStyle}>Surfboard length</span><span style={valStyle}>{measurements ? measurements.boardL + ' wu' : '—'}</span></div>
        <div><span style={labelStyle}>Surfboard height</span><span style={valStyle}>{measurements ? measurements.boardH + ' wu' : '—'}</span></div>
        <div><span style={labelStyle}>River half-width at t=0</span><span style={valStyle}>{measurements ? measurements.riverHalfW + ' wu' : '—'}</span></div>
        <div><span style={labelStyle}>River half-width at t=0.25</span><span style={valStyle}>{measurements ? measurements.riverHalfWAt025 + ' wu' : '—'}</span></div>
        <div><span style={labelStyle}>Bank wall height</span><span style={valStyle}>{V2_BANK_HEIGHT} wu</span></div>
        <div style={{ color: '#8ab', fontSize: 10, marginTop: 3 }}>Ref cube = 5×5×5 wu (magenta, z+200 from start)</div>
      </div>

      {/* Mode */}
      <div style={{ marginTop: 8, borderTop: '1px solid #334', paddingTop: 6 }}>
        <div style={{ color: '#8ab', fontSize: 11, marginBottom: 4 }}>CAMERA MODE</div>
        <div><span style={labelStyle}>Current</span><span style={valStyle}>{mode}</span></div>
        <select
          value={mode}
          onChange={e => onModeChange(e.target.value as CameraMode)}
          style={selectStyle}
        >
          {CAMERA_MODES.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {/* Controls */}
      <div style={{ marginTop: 8 }}>
        <button style={btnStyle} onClick={onResetCamera}>Reset Camera</button>
        <button
          style={{ ...btnStyle, background: autoRotate ? '#1a5a2b' : '#1a3a6b' }}
          onClick={onToggleAutoRotate}
        >
          Auto-Rotate {autoRotate ? 'ON' : 'OFF'}
        </button>
      </div>

      <div style={{ marginTop: 8, color: '#566', fontSize: 10 }}>
        Kart colors: cyan=t=0, red=t=0.25, green=t=0.5, yellow=t=0.75
      </div>
    </div>
  );
}

// ─── FPS ticker ───────────────────────────────────────────────────────────────
// Measures render frame time inside the R3F loop for overlay display.

function FrameTicker({ onFrameMs }: { onFrameMs: (ms: number) => void }) {
  const lastT = useRef(performance.now());
  useFrame(() => {
    const now = performance.now();
    const dt  = now - lastT.current;
    lastT.current = now;
    onFrameMs(dt);
  });
  return null;
}

// ─── Inner page (reads search params) ────────────────────────────────────────

function ReefRacePreviewInner() {
  const searchParams = useSearchParams();
  const router       = useRouter();

  const rawMode = searchParams.get('mode');
  // Default to top-down so first paint shows the slalom layout. free-orbit
  // landed at an unhelpful angle that made the river render as a vertical
  // sliver (camera was almost parallel to bed plane). Confirmed visually
  // 2026-04-29 from the broken first preview render.
  const mode: CameraMode = isCameraMode(rawMode) ? rawMode : 'top-down';

  const [triCount,     setTriCount]     = useState<number | null>(null);
  const [camDist,      setCamDist]      = useState(0);
  const [frameMs,      setFrameMs]      = useState(0);
  const [autoRotate,   setAutoRotate]   = useState(false);
  const [measurements, setMeasurements] = useState<PreviewMeasurements | null>(null);

  const controlsRef = useRef<OrbitControlsImpl>(null);

  const handleModeChange = useCallback((m: CameraMode) => {
    router.push(`/preview/reef-race-v2?mode=${m}`);
  }, [router]);

  const handleToggleAutoRotate = useCallback(() => {
    setAutoRotate(v => !v);
  }, []);

  const handleResetCamera = useCallback(() => {
    const ctrl = controlsRef.current;
    if (!ctrl) return;
    const cam = ctrl.object as THREE.PerspectiveCamera;
    cam.position.copy(FREE_CAM);
    ctrl.target.copy(FREE_TARGET);
    ctrl.update();
  }, []);

  const handleTriCount    = useCallback((n: number) => setTriCount(n), []);
  const handleCamDist     = useCallback((d: number) => setCamDist(d),  []);
  const handleFrameMs     = useCallback((ms: number) => setFrameMs(ms), []);
  const handleMeasurements = useCallback((m: PreviewMeasurements) => setMeasurements(m), []);

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      background: FOG_COLOR,
      overflow: 'hidden',
      position: 'relative',
      fontFamily: 'monospace',
    }}>
      <Canvas
        camera={{ position: [FREE_CAM.x, FREE_CAM.y, FREE_CAM.z], fov: 60, near: CAMERA_NEAR, far: CAMERA_FAR }}
        shadows
        gl={{ antialias: false }}
        dpr={[1, 1.5]}
        style={{ width: '100%', height: '100%' }}
      >
        <KTX2LoaderSetup />
        <Suspense fallback={null}>
          <SceneContents
            mode={mode}
            autoRotate={autoRotate}
            controlsRef={controlsRef}
            onTriCount={handleTriCount}
            onCamDist={handleCamDist}
            onMeasurements={handleMeasurements}
          />
        </Suspense>
        <FrameTicker onFrameMs={handleFrameMs} />
      </Canvas>

      <OverlayPanel
        mode={mode}
        triCount={triCount}
        camDist={camDist}
        frameMs={frameMs}
        autoRotate={autoRotate}
        measurements={measurements}
        onModeChange={handleModeChange}
        onToggleAutoRotate={handleToggleAutoRotate}
        onResetCamera={handleResetCamera}
      />
    </div>
  );
}

// ─── Root export — Suspense boundary for useSearchParams ─────────────────────
// Next.js 16 requires wrapping useSearchParams in <Suspense> even on dynamic
// 'use client' pages. The outer shell is the boundary; inner reads params.

export default function ReefRaceV2PreviewPage() {
  return (
    <Suspense fallback={null}>
      <ReefRacePreviewInner />
    </Suspense>
  );
}
