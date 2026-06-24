'use client';

/**
 * /preview/reef-race-v2 — visual verification route for the SURF ROAD track.
 *
 * DEV-ONLY: bypasses the NEXT_PUBLIC_REEF_RACE_USE_SPLINE env flag so the human
 * can always inspect the floating-ribbon SURF ROAD.
 *
 * ─── 2026-06-23 SURF ROAD REBUILD ────────────────────────────────────────────
 * This page used to assemble the land-disc preview: a sky-blue background, a
 * sandy flat riverbed ribbon at Y=-250, grass-green bank walls, the CentralIsland
 * atoll, and ground-disc framing cameras. ALL REMOVED. The preview now shows the
 * real SURF ROAD: a glowing FLOATING WATER RIBBON winding through a cosmic void.
 *
 *   - <RiverScene /> mounts <CosmicVoid /> (gradient dome + starfield + glow
 *     motes), <SurfRibbon /> (the glowing floating water + neon banked rails +
 *     crests, rides reefTrackElevationAt(t) + reefTrackBankAngleAt(t)), the 5
 *     decorative <RacingKarts />, and <Ramps />.
 *   - <SurfBloom /> adds the selective neon glow (Iris-Xe-gated half-res).
 *   - Camera presets reframed for the floating ribbon + cosmic void.
 *
 * What to check (orbit / side-on / cinematic):
 *   1. A glowing floating water ribbon in an abstract cosmic void — NO land,
 *      island, ground, or sky-over-terrain.
 *   2. The ribbon aggressively zig-zags AND undulates in elevation (climbs/dips).
 *   3. Neon rails along each banked edge, glowing (bloom).
 *   4. Demo surfboard karts ride ON the ribbon through climbs/drops (not floating
 *      above / sinking below) and lean into banked turns.
 *   5. Starfield + drifting glow motes; deep twilight-into-cosmos gradient.
 *   6. FPS ≥ floor on Iris Xe; zero console errors.
 *
 * Iris Xe invariants enforced:
 *   - No drei <Text> / <Billboard>; no InstancedMesh + ShaderMaterial.
 *   - import from 'three' (NOT 'three/webgpu'); module-scope geo/mat.
 *   - ShaderMaterial only on plain Mesh (water); fog:false on shaders.
 */

export const dynamic = 'force-dynamic';

import { Suspense, useRef, useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

import { RiverScene } from '@/lib/three/activities/reef-race/river-scene';
import { SurfBloom } from '@/lib/three/activities/reef-race/surf-bloom';
import { ReefFreeDrive } from '@/lib/three/activities/reef-race/ReefFreeDrive';
import { clientSpline } from '@/lib/three/activities/reef-race/reef-race-spline-instance';
import { elevationAtT } from '@/lib/three/activities/reef-race/reef-race-elevation';
import { ReefWaterTunerPanel } from '@/components/reef/ReefWaterTunerPanel';
import { ReefPhysicsTunerPanel } from '@/components/reef/ReefPhysicsTunerPanel';
import {
  FOG_COLOR,
  FOG_NEAR,
  FOG_FAR,
  CAMERA_NEAR,
  CAMERA_FAR,
  HEMI_SKY_COLOR,
  HEMI_GROUND_COLOR,
  HEMI_INTENSITY,
  DIR_COLOR,
  DIR_INTENSITY,
  DIR_POSITION,
} from '@/lib/three/activities/reef-race/reef-race-config';

// ─── Camera mode ─────────────────────────────────────────────────────────────
const CAMERA_MODES = ['free-orbit', 'top-down', 'cinematic', 'side-on'] as const;
type CameraMode = (typeof CAMERA_MODES)[number];

function isCameraMode(s: string | null): s is CameraMode {
  return CAMERA_MODES.includes(s as CameraMode);
}

// ─── Module-scope scratch (no per-frame allocations) ─────────────────────────
const _sc1 = new THREE.Vector3();

// ─── Camera presets (SURF ROAD — frame the floating ribbon in the void) ──────
// Footprint ≈ 17687 × 16941 wu; elevation span ≈ 1634 (Y ∈ [-559, 1075]).
// Start/finish at centerlineAt(0) ≈ XZ(-2400, -8200), elevation ≈ elevationAt(0).
const _startCenter = clientSpline.centerlineAt(0);
const _startNormal = clientSpline.normalAt(0);
const _startTangent = clientSpline.tangentAt(0);
const _startY = elevationAtT(0);

// Top-down: high above the loop centroid, frames the whole zig-zag from above.
// Half-span ≈ 9000wu; FOV 50 → altitude ≈ 9000/tan(25°) ≈ 19300 → 21000 headroom.
const TOPDOWN_CAM    = new THREE.Vector3(0, 21000, 0);
const TOPDOWN_TARGET = new THREE.Vector3(0, 300, 0);

// Side-on: across the start straight, low + outside, to read the UNDULATION
// silhouette of the floating ribbon against the void.
const SIDEON_CAM = new THREE.Vector3(
  _startCenter.x + _startNormal.x * 9000,
  3200,
  _startCenter.z + _startNormal.z * 9000,
);
const SIDEON_TARGET = new THREE.Vector3(_startCenter.x, _startY + 200, _startCenter.z + 3000);

// Cinematic: just above + behind the start, looking down the ribbon — a racer's
// hero shot of the glowing road receding into the cosmos.
const CINEMATIC_CAM = new THREE.Vector3(
  _startCenter.x - _startTangent.x * 1200,
  _startY + 520,
  _startCenter.z - _startTangent.z * 1200,
);
const CINEMATIC_TARGET = new THREE.Vector3(
  _startCenter.x + _startTangent.x * 1800,
  _startY + 120,
  _startCenter.z + _startTangent.z * 1800,
);

// Default free-orbit: a 3/4 hero of the whole floating loop in the void.
const FREE_CAM    = new THREE.Vector3(13000, 9000, 13000);
const FREE_TARGET = new THREE.Vector3(0, 200, 0);

// ─── Production lighting (mirrors ReefLight in ReefRaceScene.tsx) ─────────────

function PreviewLighting() {
  return (
    <>
      <hemisphereLight args={[HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY]} />
      <directionalLight
        color={DIR_COLOR}
        intensity={DIR_INTENSITY}
        position={DIR_POSITION as unknown as [number, number, number]}
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

function CamController({ mode, controlsRef, onCamDist }: CamControllerProps) {
  const { camera } = useThree();

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    cam.near = CAMERA_NEAR;
    cam.far  = CAMERA_FAR;
    cam.fov  = 60;

    const ctrl = controlsRef.current;
    if (!ctrl) return;

    switch (mode) {
      case 'top-down':
        cam.position.copy(TOPDOWN_CAM);
        ctrl.target.copy(TOPDOWN_TARGET);
        cam.fov = 50;
        break;
      case 'side-on':
        cam.position.copy(SIDEON_CAM);
        ctrl.target.copy(SIDEON_TARGET);
        break;
      case 'cinematic':
        cam.position.copy(CINEMATIC_CAM);
        ctrl.target.copy(CINEMATIC_TARGET);
        break;
      default:
        cam.position.copy(FREE_CAM);
        ctrl.target.copy(FREE_TARGET);
        break;
    }
    cam.updateProjectionMatrix();
    ctrl.update();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useFrame(() => {
    if (mode === 'cinematic') {
      const ctrl = controlsRef.current;
      if (ctrl) {
        camera.position.copy(CINEMATIC_CAM);
        ctrl.target.copy(CINEMATIC_TARGET);
        ctrl.update();
      }
    }
    onCamDist(camera.position.distanceTo(_sc1.set(0, 0, 0)));
  });

  return null;
}

// ─── Scene contents ───────────────────────────────────────────────────────────

interface SceneContentsProps {
  mode: CameraMode;
  autoRotate: boolean;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  onCamDist: (d: number) => void;
  /** DRIVE sandbox: keyboard-driven kart owns the camera — skip orbit cam + demo karts. */
  drive: boolean;
}

function SceneContents({ mode, autoRotate, controlsRef, onCamDist, drive }: SceneContentsProps) {
  return (
    <>
      {/* Free-orbit / cinematic camera + orbit controls — ONLY in look modes. In
          drive mode <ReefFreeDrive/> owns the chase camera, so these are skipped. */}
      {!drive && (
        <CamController mode={mode} autoRotate={autoRotate} controlsRef={controlsRef} onCamDist={onCamDist} />
      )}
      {!drive && (
        <OrbitControls
          ref={controlsRef as unknown as React.Ref<OrbitControlsImpl>}
          enableDamping
          dampingFactor={0.08}
          autoRotate={autoRotate && mode === 'free-orbit'}
          autoRotateSpeed={0.8}
          maxPolarAngle={Math.PI * 0.92}
          minDistance={500}
          maxDistance={28000}
        />
      )}

      {/* Deep cosmic void atmosphere */}
      <fog args={[FOG_COLOR, FOG_NEAR, FOG_FAR]} />
      <color attach="background" args={['#0c1a2e']} />

      {/* SURF ROAD scene. Look modes show decorative demo karts; drive mode hides
          them (you ARE the kart) and mounts the keyboard-driven free-drive rig. */}
      <RiverScene showDemoKarts={!drive} />
      {drive && <ReefFreeDrive />}

      <PreviewLighting />

      {/* Selective neon bloom — LAST so it composes the final framebuffer */}
      <SurfBloom />
    </>
  );
}

// ─── Overlay panel ────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  background: 'rgba(4,10,22,0.78)',
  color: '#bfe8ff',
  fontFamily: 'monospace',
  fontSize: 12,
  lineHeight: 1.6,
  padding: '10px 14px',
  borderRadius: 6,
  zIndex: 20,
  minWidth: 240,
  pointerEvents: 'auto',
  userSelect: 'none',
};

const labelStyle: React.CSSProperties = { color: '#6fb4d6', display: 'inline-block', width: 150 };
const valStyle: React.CSSProperties = { color: '#fff', fontWeight: 'bold' };
const selectStyle: React.CSSProperties = {
  background: '#0e2a4a', color: '#bfe8ff', border: '1px solid #3a8fd0',
  borderRadius: 4, padding: '2px 6px', fontSize: 12, cursor: 'pointer', marginTop: 6, width: '100%',
};
const btnStyle: React.CSSProperties = {
  background: '#0e2a4a', color: '#bfe8ff', border: '1px solid #3a8fd0',
  borderRadius: 4, padding: '3px 10px', fontSize: 12, cursor: 'pointer', marginTop: 4, marginRight: 4,
};

interface OverlayProps {
  mode: CameraMode;
  camDist: number;
  stats: FrameStats;
  autoRotate: boolean;
  onModeChange: (m: CameraMode) => void;
  onToggleAutoRotate: () => void;
  onResetCamera: () => void;
}

function OverlayPanel({ mode, camDist, stats, autoRotate, onModeChange, onToggleAutoRotate, onResetCamera }: OverlayProps) {
  // Perf-tier colour on FPS: green ≥60 (floor), amber 45–60, red <45 (downgrade).
  const fpsColor = stats.fps >= 60 ? '#7dffa0' : stats.fps >= 45 ? '#ffd166' : '#ff6b6b';
  return (
    <div style={overlayStyle}>
      <div style={{ fontWeight: 'bold', fontSize: 13, marginBottom: 6, color: '#fff', letterSpacing: 1 }}>
        SURF ROAD Preview
      </div>
      <div><span style={labelStyle}>FPS (avg)</span><span style={{ ...valStyle, color: fpsColor }}>{stats.fps > 0 ? stats.fps.toFixed(0) : '—'}</span></div>
      <div><span style={labelStyle}>Frame time (avg)</span><span style={{ ...valStyle, color: fpsColor }}>{stats.avgMs > 0 ? stats.avgMs.toFixed(1) + ' ms' : '—'}</span></div>
      <div><span style={labelStyle}>Jank (max)</span><span style={valStyle}>{stats.maxMs > 0 ? stats.maxMs.toFixed(1) + ' ms' : '—'}</span></div>
      <div><span style={labelStyle}>Geo / Tex</span><span style={valStyle}>{stats.geometries} / {stats.textures}</span></div>
      <div><span style={labelStyle}>Cam dist (origin)</span><span style={valStyle}>{camDist.toFixed(0)} wu</span></div>

      <div style={{ marginTop: 8, borderTop: '1px solid #1c3a55', paddingTop: 6 }}>
        <div style={{ color: '#6fb4d6', fontSize: 11, marginBottom: 4 }}>CAMERA MODE</div>
        <div><span style={labelStyle}>Current</span><span style={valStyle}>{mode}</span></div>
        <select value={mode} onChange={e => onModeChange(e.target.value as CameraMode)} style={selectStyle}>
          {CAMERA_MODES.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      <div style={{ marginTop: 8 }}>
        <button style={btnStyle} onClick={onResetCamera}>Reset Camera</button>
        <button
          style={{ ...btnStyle, background: autoRotate ? '#0e4a2b' : '#0e2a4a' }}
          onClick={onToggleAutoRotate}
        >
          Auto-Rotate {autoRotate ? 'ON' : 'OFF'}
        </button>
      </div>

      <div style={{ marginTop: 8, color: '#456', fontSize: 10 }}>
        Floating water ribbon · neon rails · cosmic void. Karts ride the elevation.
      </div>
    </div>
  );
}

// ─── Frame-time / FPS meter (rolling avg + jank, throttled emit) ─────────────
// Measures wall-clock between frames (includes the bloom composer pass + browser
// composite), averaged over a ~90-frame window so the number is readable, not
// flickering. Emits to React only ~4×/sec so the overlay re-render doesn't itself
// skew the measurement (the old per-frame setState was a hidden cost). This is the
// instrument for "no visual downgrade in frame time" — read avg + jank (max).

interface FrameStats {
  avgMs: number;
  fps: number;
  maxMs: number;   // worst frame in the window — the jank/hitch signal
  geometries: number;
  textures: number;
}

function FrameTicker({ onStats }: { onStats: (s: FrameStats) => void }) {
  const { gl } = useThree();
  const buf = useRef<number[]>([]);
  const lastT = useRef(performance.now());
  const lastEmit = useRef(performance.now());
  useFrame(() => {
    const now = performance.now();
    const dt = now - lastT.current;
    lastT.current = now;
    const b = buf.current;
    b.push(dt);
    if (b.length > 90) b.shift();
    if (now - lastEmit.current >= 250 && b.length > 0) {
      lastEmit.current = now;
      let sum = 0;
      let max = 0;
      for (let i = 0; i < b.length; i++) {
        sum += b[i];
        if (b[i] > max) max = b[i];
      }
      const avg = sum / b.length;
      onStats({
        avgMs: avg,
        fps: avg > 0 ? 1000 / avg : 0,
        maxMs: max,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
      });
    }
  });
  return null;
}

// ─── Inner page (reads search params) ────────────────────────────────────────

function ReefRacePreviewInner() {
  const searchParams = useSearchParams();
  const router       = useRouter();

  const rawMode = searchParams.get('mode');
  // DRIVE sandbox mode (keyboard-driven kart + physics tuner). Not a CameraMode —
  // <ReefFreeDrive/> owns the chase camera. Reached via ?mode=drive.
  const drive = rawMode === 'drive';
  // Default to free-orbit hero of the whole floating loop in the void.
  const mode: CameraMode = isCameraMode(rawMode) ? rawMode : 'free-orbit';

  const [camDist,    setCamDist]    = useState(0);
  const [stats,      setStats]      = useState<FrameStats>({ avgMs: 0, fps: 0, maxMs: 0, geometries: 0, textures: 0 });
  const [autoRotate, setAutoRotate] = useState(false);

  const controlsRef = useRef<OrbitControlsImpl>(null);

  const handleModeChange = useCallback((m: CameraMode) => {
    router.push(`/preview/reef-race-v2?mode=${m}`);
  }, [router]);
  const handleToggleAutoRotate = useCallback(() => setAutoRotate(v => !v), []);
  const handleResetCamera = useCallback(() => {
    const ctrl = controlsRef.current;
    if (!ctrl) return;
    const cam = ctrl.object as THREE.PerspectiveCamera;
    cam.position.copy(FREE_CAM);
    ctrl.target.copy(FREE_TARGET);
    ctrl.update();
  }, []);
  const handleCamDist = useCallback((d: number) => setCamDist(d), []);
  const handleStats = useCallback((s: FrameStats) => setStats(s), []);

  return (
    <div style={{
      width: '100vw', height: '100vh', background: '#0c1a2e',
      overflow: 'hidden', position: 'relative', fontFamily: 'monospace',
    }}>
      <Canvas
        camera={{ position: [FREE_CAM.x, FREE_CAM.y, FREE_CAM.z], fov: 60, near: CAMERA_NEAR, far: CAMERA_FAR }}
        gl={{ antialias: false }}
        dpr={[1, 1.5]}
        style={{ width: '100%', height: '100%' }}
      >
        <Suspense fallback={null}>
          <SceneContents
            mode={mode}
            autoRotate={autoRotate}
            controlsRef={controlsRef}
            onCamDist={handleCamDist}
            drive={drive}
          />
        </Suspense>
        <FrameTicker onStats={handleStats} />
      </Canvas>

      <OverlayPanel
        mode={mode}
        camDist={camDist}
        stats={stats}
        autoRotate={autoRotate}
        onModeChange={handleModeChange}
        onToggleAutoRotate={handleToggleAutoRotate}
        onResetCamera={handleResetCamera}
      />

      {/* Live tuner — physics in DRIVE mode (handling/drift/whip), water shader in
          look modes. Both DEV TOOLs writing their singleton the loop reads each frame. */}
      {drive ? <ReefPhysicsTunerPanel /> : <ReefWaterTunerPanel />}

      {/* Drive ⇄ Look toggle. Drive = keyboard-driven free-drive sandbox + physics
          tuner; Look = cinematic fly-through + water tuner. */}
      <button
        onClick={() => router.push(`/preview/reef-race-v2?mode=${drive ? 'cinematic' : 'drive'}`)}
        style={{
          position: 'absolute', bottom: 14, left: 14, zIndex: 30,
          background: drive ? '#0e4a2b' : '#0e2a4a', color: '#bfe8ff',
          border: '1px solid #3a8fd0', borderRadius: 6, padding: '8px 14px',
          fontFamily: 'monospace', fontSize: 13, fontWeight: 'bold', cursor: 'pointer',
        }}
      >
        {drive ? '👁 Exit to Look' : '🏄 Drive it'}
      </button>

      {drive && (
        <div style={{
          position: 'absolute', bottom: 14, left: 150, zIndex: 30,
          background: 'rgba(4,10,22,0.78)', color: '#9cc7dd', border: '1px solid #1c3a55',
          borderRadius: 6, padding: '8px 12px', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5,
        }}>
          <b style={{ color: '#fff' }}>A/D</b> or <b style={{ color: '#fff' }}>←/→</b> steer ·{' '}
          <b style={{ color: '#fff' }}>S</b> brake · <b style={{ color: '#fff' }}>Shift</b> drift ·{' '}
          <b style={{ color: '#fff' }}>Space</b> board-whip (bump the coral kart)
        </div>
      )}
    </div>
  );
}

// ─── Root export — Suspense boundary for useSearchParams ─────────────────────

export default function ReefRaceV2PreviewPage() {
  return (
    <Suspense fallback={null}>
      <ReefRacePreviewInner />
    </Suspense>
  );
}
