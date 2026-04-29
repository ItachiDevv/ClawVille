'use client';

/**
 * ReefRaceVignette.tsx
 *
 * ~6-second looping cinematic preview of Reef Race gameplay.
 * Chase cam behind the lobster racer on a centripetal Catmull-Rom closed spline.
 *
 * Constraints honored:
 *  - NO drei Text / Billboard  (Iris Xe crash)
 *  - NO InstancedMesh + ShaderMaterial  (WebGPU crash)
 *  - NO new Vector3/Quaternion inside useFrame  (GC thrash)
 *  - Lobster faces +Z at rotation.y=0  →  facing = atan2(vx, vz)
 *  - Flat ribbon BufferGeometry (TubeGeometry is invisible from chase cam)
 *  - Lights: HemisphereLight + 1 DirectionalLight  (Iris Xe budget)
 *  - GPU resources disposed on unmount
 *  - Pixel ratio capped at [1, 1.5]
 */

import { useRef, useMemo, useEffect, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Module-scope scratch vectors — allocated once, reused every frame
// ---------------------------------------------------------------------------
const _racerPt  = new THREE.Vector3();
const _racerTan = new THREE.Vector3();
const _desiredCamPos = new THREE.Vector3();
const _desiredLookAt = new THREE.Vector3();
// Persistent look-at accumulator for the chase camera lerp (zero per-frame allocation)
const _storedLookAt  = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Spline — closed centripetal Catmull-Rom, 7 control points
// Scale: ~28 wu across. Looping period = LOOP_DURATION seconds.
// ---------------------------------------------------------------------------
const SPLINE_POINTS = [
  new THREE.Vector3( 0,    0,  12),
  new THREE.Vector3( 10,   0,  8),
  new THREE.Vector3( 14,   0,  0),
  new THREE.Vector3( 10,   0, -8),
  new THREE.Vector3( 0,    0, -12),
  new THREE.Vector3(-10,   0, -8),
  new THREE.Vector3(-14,   0,  0),
];

// Centripetal (alpha=0.5) — handles tight bends without overshooting
const TRACK_CURVE = new THREE.CatmullRomCurve3(
  SPLINE_POINTS,
  true,          // closed loop
  'centripetal',
  0.5,
);

const LOOP_DURATION   = 6;    // seconds for one full lap
const TRACK_HW        = 1.2;  // track half-width in wu
const CAM_BACK        = 3.5;  // wu behind the racer (tightened from 6 so
                              // the lobster reads at small landing-tile
                              // viewport — verified visually 2026-04-29)
const CAM_UP          = 1.5;  // wu above the racer (lowered with cam back)
const CAM_LOOK_AHEAD  = 2;    // wu ahead of the racer for look-at point
const CAM_POS_LERP    = 0.08;
const CAM_LOOK_LERP   = 0.12;
const BOB_AMP         = 0.12;
const BOB_FREQ        = 2.8;

// ---------------------------------------------------------------------------
// Flat ribbon BufferGeometry builder
// (TubeGeometry is a hollow tube — invisible edge-on from chase cam above)
// ---------------------------------------------------------------------------
function buildRibbonGeo(
  curve: THREE.CatmullRomCurve3,
  segments: number,
  halfWidth: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals:   number[] = [];
  const uvs:       number[] = [];
  const indices:   number[] = [];

  // Build-time locals — fine to allocate here (not in useFrame)
  const pt    = new THREE.Vector3();
  const tan   = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up    = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, pt);
    curve.getTangentAt(t, tan).normalize();
    right.crossVectors(tan, up).normalize();

    // Left vertex, right vertex
    positions.push(
      pt.x - right.x * halfWidth, pt.y, pt.z - right.z * halfWidth,
      pt.x + right.x * halfWidth, pt.y, pt.z + right.z * halfWidth,
    );
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(0, t, 1, t);

    if (i < segments) {
      const b = i * 2;
      indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,       2));
  geo.setIndex(indices);
  return geo;
}

// ---------------------------------------------------------------------------
// Track — ribbon + lane markers
// ---------------------------------------------------------------------------
function Track() {
  const ribbonGeo = useMemo(() => buildRibbonGeo(TRACK_CURVE, 120, TRACK_HW), []);
  // Narrower ribbon for center dashes
  const dashGeo   = useMemo(() => buildRibbonGeo(TRACK_CURVE, 120, 0.06),    []);

  const ribbonMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x1a6fa8),
    roughness: 0.65,
    metalness: 0.08,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
  }), []);

  const dashMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x88ddff),
    roughness: 0.3,
    metalness: 0.1,
    side: THREE.DoubleSide,
    emissive: new THREE.Color(0x224466),
    emissiveIntensity: 0.5,
  }), []);

  // Dispose GPU resources on unmount
  useEffect(() => {
    return () => {
      ribbonGeo.dispose();
      dashGeo.dispose();
      ribbonMat.dispose();
      dashMat.dispose();
    };
  }, [ribbonGeo, dashGeo, ribbonMat, dashMat]);

  return (
    <group>
      {/* Main track surface */}
      <mesh geometry={ribbonGeo} material={ribbonMat} />
      {/* Center-line dash — offset y to avoid z-fight */}
      <mesh geometry={dashGeo} material={dashMat} position={[0, 0.01, 0]} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Sandy ocean floor
// ---------------------------------------------------------------------------
function OceanFloor() {
  const geo = useMemo(() => new THREE.PlaneGeometry(80, 80, 1, 1), []);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xc8a86e),
    roughness: 0.9,
    metalness: 0.0,
  }), []);

  useEffect(() => {
    return () => { geo.dispose(); mat.dispose(); };
  }, [geo, mat]);

  return (
    <mesh
      geometry={geo}
      material={mat}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -1.5, 0]}
      receiveShadow={false}
    />
  );
}

// ---------------------------------------------------------------------------
// Racer — lobster.glb reused from LandingScene preload cache
// ---------------------------------------------------------------------------
function Racer({ tRef }: { tRef: MutableRefObject<number> }) {
  const { scene } = useGLTF('/models/lobster.glb');
  const cloned    = useMemo(() => scene.clone(true), [scene]);
  const groupRef  = useRef<THREE.Group>(null);

  // lobster.glb is a SkinnedMesh — bind-pose bbox causes frustum-cull disappear
  useMemo(() => {
    cloned.traverse((o) => { o.frustumCulled = false; });
  }, [cloned]);

  // Dispose the cloned scene on unmount (the source scene stays in useGLTF cache)
  useEffect(() => {
    return () => {
      cloned.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m) => m.dispose());
        }
      });
    };
  }, [cloned]);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = tRef.current;

    // Sample spline at current t (module-scope scratch — no allocation)
    TRACK_CURVE.getPointAt(t, _racerPt);
    TRACK_CURVE.getTangentAt(t, _racerTan).normalize();

    // Position with gentle bob
    groupRef.current.position.set(
      _racerPt.x,
      _racerPt.y + Math.sin(clock.elapsedTime * BOB_FREQ) * BOB_AMP,
      _racerPt.z,
    );

    // Facing: lobster faces +Z at rotation.y=0, so use atan2(vx, vz)
    groupRef.current.rotation.y = Math.atan2(_racerTan.x, _racerTan.z);
  });

  return (
    <group ref={groupRef} scale={1.6}>
      <primitive object={cloned} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Chase camera — mounted behind + above the racer, smooth lerp
// ---------------------------------------------------------------------------
function ChaseCamera({ tRef }: { tRef: MutableRefObject<number> }) {
  const { camera } = useThree();

  // Seed camera at frame 0 near the start of the track
  useEffect(() => {
    TRACK_CURVE.getPointAt(0, _racerPt);
    TRACK_CURVE.getTangentAt(0, _racerTan).normalize();
    camera.position.set(
      _racerPt.x - _racerTan.x * CAM_BACK,
      _racerPt.y + CAM_UP,
      _racerPt.z - _racerTan.z * CAM_BACK,
    );
    camera.lookAt(_racerPt.x, _racerPt.y, _racerPt.z);
    // Seed the stored look-at so first lerp frame has a sane start
    _storedLookAt.copy(_racerPt);
  }, [camera]);

  useFrame(() => {
    const t = tRef.current;

    TRACK_CURVE.getPointAt(t, _racerPt);
    TRACK_CURVE.getTangentAt(t, _racerTan).normalize();

    // Desired cam: directly behind racer in its travel direction + lifted up
    _desiredCamPos.set(
      _racerPt.x - _racerTan.x * CAM_BACK,
      _racerPt.y + CAM_UP,
      _racerPt.z - _racerTan.z * CAM_BACK,
    );

    // Desired look-at: slightly ahead of racer
    _desiredLookAt.set(
      _racerPt.x + _racerTan.x * CAM_LOOK_AHEAD,
      _racerPt.y + 0.4,
      _racerPt.z + _racerTan.z * CAM_LOOK_AHEAD,
    );

    // Smooth lerp — tangent is continuous at loop boundary so no snap
    camera.position.lerp(_desiredCamPos, CAM_POS_LERP);

    // Lerp look-at using module-scope persistent vector (zero per-frame allocation)
    _storedLookAt.lerp(_desiredLookAt, CAM_LOOK_LERP);
    camera.lookAt(_storedLookAt);
  });

  return null;
}

// ---------------------------------------------------------------------------
// Inner scene — needs to be inside Canvas
// ---------------------------------------------------------------------------
function VignetteScene() {
  const tRef = useRef(0);

  useFrame(({ clock }) => {
    tRef.current = (clock.elapsedTime % LOOP_DURATION) / LOOP_DURATION;
  });

  return (
    <>
      {/* Background color */}
      <color attach="background" args={[0x0a3a55]} />

      {/* Underwater fog */}
      <fog attach="fog" args={[new THREE.Color(0x0a3a55), 30, 80]} />

      {/* Lighting — hemisphere (cyan sky / dark ocean floor) + 1 directional from above */}
      <hemisphereLight
        args={[new THREE.Color(0x44aaff), new THREE.Color(0x0a2233), 0.9]}
      />
      <directionalLight
        color={new THREE.Color(0xaaddff)}
        intensity={1.1}
        position={[8, 20, -4]}
      />

      <Track />
      <OceanFloor />
      <Racer tRef={tRef} />
      <ChaseCamera tRef={tRef} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Public export — consumed via dynamic() with ssr:false
// ---------------------------------------------------------------------------
export default function ReefRaceVignette() {
  return (
    <Canvas
      style={{ width: '100%', height: '100%' }}
      dpr={[1, 1.5]}
      camera={{ fov: 52, near: 0.5, far: 120, position: [0, 4, -8] }}
      gl={{ antialias: true }}
    >
      <VignetteScene />
    </Canvas>
  );
}
