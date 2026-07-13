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
import ReefRacePlayer from '@/lib/three/activities/reef-race/ReefRacePlayer';
import type { ReefRaceEntity } from '@/lib/three/activities/reef-race/reef-race-types';
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

// DEV-ONLY VERIFY-HARNESS ADDITION (2026-07-12, reef creature-rider facing/static
// audit): expose the THREE module reference so an external Playwright driver can
// construct Box3/Quaternion/Vector3 without needing its own bundle of three.js —
// mirrors the existing __HARNESS_GROUP pattern below. Harmless (a module
// reference assignment, not a per-frame cost); dev-only preview route, never
// reached by the production game bundle.
if (typeof window !== 'undefined') {
  (window as unknown as { __THREE_DEV?: typeof THREE }).__THREE_DEV = THREE;
}

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

// ─── Real-race kart render harness (?mode=racer) ─────────────────────────────
// DEV-ONLY: mounts ONE real-race <ReefRacePlayer/> (the spline path) with a fixed
// fake entity on a banked stretch + a close 3/4 camera, so the surf-tilt / banked
// ride / board ORIENTATION baked into ReefRacePlayer can be eyeballed WITHOUT a live
// race. Requires a build with NEXT_PUBLIC_REEF_RACE_USE_SPLINE=true (else ReefRacePlayer
// takes the flat v1 path). The kart surfs IN PLACE (wave time advances; XZ fixed).
//
// `?species=<modelKey>` (added 2026-07-10, registry-driven rider router
// verification): overrides the rendered species; defaults to 'lobster' so the
// existing bare `?mode=racer` URL keeps working unchanged. Any MODEL_REGISTRY
// key works (VRM or GLB), plus the two legacy non-registry keys ('crayfish',
// 'sea_horse'). Example: /preview/reef-race-v2?mode=racer&species=hermes_male
const _HARNESS_T = 0.10; // a banked stretch of the spline
function ReefRaceKartHarness({ species, camview }: { species: string; camview: string }) {
  const { camera } = useThree();
  const wrapRef = useRef<THREE.Group>(null);
  const c = clientSpline.centerlineAt(_HARNESS_T);
  const tan = clientSpline.tangentAt(_HARNESS_T);
  const datumY = elevationAtT(_HARNESS_T);
  const [entity] = useState<ReefRaceEntity>(() => ({
    avatarId: 'harness-1', x: c.x, y: c.z, rot: Math.atan2(tan.x, tan.z),
    vx: 0, vy: 0, alive: true, color: '#35d0ff', species, lap: 1,
  }));
  // DEV-ONLY VERIFY-HARNESS ADDITION (2026-07-12): `?camview=orbit&camyaw=<deg>` —
  // a turntable camera at a fixed radius/height around the rider so a creature's
  // "front" (antennae/claws/head vs. tail) can be read from whichever azimuth
  // actually faces the lens, instead of guessing from one fixed angle.
  const orbitSearchParams = useSearchParams();
  const camYawDeg = Number(orbitSearchParams.get('camyaw') ?? '0');
  // DEV-ONLY VERIFY-HARNESS ADDITION (2026-07-12): optional radius/height
  // overrides for the orbit cam — the default 132/55 (matched to the 3q view)
  // is tuned for ~22wu GLB creatures; VRM riders are ~245wu (pre-existing,
  // already-documented scale gap — see reef `rider-species-router` memory,
  // NOT something this task's scope touches), so a VRM verification shot
  // needs a farther/higher camera to fit the whole figure in frame.
  const camRadiusOverride = orbitSearchParams.get('camradius');
  const camHeightOverride = orbitSearchParams.get('camheight');
  useFrame(() => {
    // DEV-ONLY VERIFY-HARNESS ADDITION (2026-07-12, creature-rider facing audit):
    // `?camview=top` swaps to a close, near-orthographic top-down view — the
    // default close 3/4 view backlights the rider against the water-glint bloom
    // and reads as a silhouette, unusable for judging which way a creature GLB
    // is authored to face. Top-down + front daylight reads the body plan
    // (head/claws vs tail) clearly. Default ('3q') is the pre-existing unchanged
    // close 3/4 view used by every other preview consumer of this harness.
    if (camview === 'orbit') {
      // Same radius/height/target ratios as the proven-working default 3/4 view
      // below (120 out / 55 up / datumY+12 target) — only the AZIMUTH sweeps, so
      // the rider is reliably framed at every angle instead of guessing a radius.
      const az = (camYawDeg * Math.PI) / 180;
      const radius = camRadiusOverride ? Number(camRadiusOverride) : 132; // = hypot(120,55) — same 3D eye-to-kart distance as the 3q view below (Codex review 2026-07-12 caught this comment previously saying hypot(120,120)≈169.7, which is wrong)
      const height = camHeightOverride ? Number(camHeightOverride) : 55;
      camera.position.set(c.x + Math.sin(az) * radius, datumY + height, c.z + Math.cos(az) * radius);
      camera.lookAt(c.x, datumY + (camHeightOverride ? Number(camHeightOverride) * 0.4 : 12), c.z);
    } else if (camview === 'top') {
      camera.position.set(c.x, datumY + 140, c.z + 1);
      camera.lookAt(c.x, datumY + 12, c.z);
    } else if (camview === 'topclose') {
      // DEV-ONLY VERIFY-HARNESS ADDITION (2026-07-12): tighter top-down crop —
      // 'top' framed the whole kart; this frames just the rider for reading
      // fine anatomy (eyes/antennae/claws) at higher pixel density.
      camera.position.set(c.x, datumY + 55, c.z + 1);
      camera.lookAt(c.x, datumY + 25, c.z);
    } else {
      // Close, low 3/4 view of the kart so the BOARD PROFILE (flat vs vertical) reads
      // clearly. The kart renders at KART_SCALE world units around c; ~120u out / ~55u up.
      camera.position.set(c.x + 120, datumY + 55, c.z + 120);
      camera.lookAt(c.x, datumY + 12, c.z);
    }
    // DEV ground-truth: expose the kart wrapper so Playwright can read the surfboard's
    // true world pose (no scene-handle hunting needed). Harmless; dev-only preview route.
    if (typeof window !== 'undefined') {
      (window as unknown as { __HARNESS_GROUP?: THREE.Group }).__HARNESS_GROUP = wrapRef.current ?? undefined;
      // DEV-ONLY VERIFY-HARNESS ADDITION (2026-07-12): expose the camera too, so a
      // Playwright driver can read its EXACT matrixWorld basis (screen-right/up in
      // world space) instead of hand-deriving the lookAt basis. Typed `unknown`
      // (not `THREE.Camera`) — R3F's `useThree().camera` type and this file's
      // direct `three` import resolve to different duplicate @types/three
      // versions present in this monorepo's node_modules (pre-existing,
      // repo-wide — see the `@types/three@0.170.0` vs `@types/three@0.182.0`
      // errors already present on the unmodified baseline), which otherwise
      // trips a needless cross-version assignability error on this line.
      (window as unknown as { __HARNESS_CAMERA?: unknown }).__HARNESS_CAMERA = camera;
    }
  });
  return (
    <group ref={wrapRef}>
      <ReefRacePlayer entity={entity} isSelf={false} />
    </group>
  );
}

// ─── Scene contents ───────────────────────────────────────────────────────────

interface SceneContentsProps {
  mode: CameraMode;
  autoRotate: boolean;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  onCamDist: (d: number) => void;
  /** DRIVE sandbox: keyboard-driven kart owns the camera — skip orbit cam + demo karts. */
  drive: boolean;
  /** RACER harness: mount one real-race ReefRacePlayer (spline path) + a close camera. */
  racer: boolean;
  /** RACER harness species override (?species=<modelKey>). Defaults to 'lobster'. */
  species: string;
  /** DEV-ONLY VERIFY-HARNESS ADDITION (2026-07-12): RACER harness camera variant. */
  camview: string;
  /** DEV-ONLY VERIFY-HARNESS ADDITION (2026-07-12): flat bright fill light + no
   *  bloom, for reading creature-rider body-plan/orientation without the cosmic-
   *  void backlighting turning the rider into an unreadable silhouette. */
  diag: boolean;
}

function SceneContents({ mode, autoRotate, controlsRef, onCamDist, drive, racer, species, camview, diag }: SceneContentsProps) {
  return (
    <>
      {/* Free-orbit / cinematic camera + orbit controls — ONLY in look modes. In
          drive mode <ReefFreeDrive/> owns the chase camera, so these are skipped. */}
      {!drive && !racer && (
        <CamController mode={mode} autoRotate={autoRotate} controlsRef={controlsRef} onCamDist={onCamDist} />
      )}
      {!drive && !racer && (
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
      <color attach="background" args={[diag ? '#7fa8c9' : '#0c1a2e']} />

      {/* SURF ROAD scene. Look modes show decorative demo karts; drive mode hides
          them (you ARE the kart) and mounts the keyboard-driven free-drive rig. */}
      <RiverScene showDemoKarts={!drive && !racer} />
      {drive && <ReefFreeDrive />}
      {racer && <ReefRaceKartHarness species={species} camview={camview} />}

      <PreviewLighting />
      {/* DEV-ONLY VERIFY-HARNESS ADDITION (2026-07-12): ?diag=1 — flat bright fill
          so a creature-rider's body plan reads clearly instead of as a cosmic-void
          backlit silhouette. Dev-only preview route; never affects production. */}
      {diag && <ambientLight intensity={2.2} />}
      {diag && <directionalLight position={[200, 400, 250]} intensity={1.5} />}

      {/* Selective neon bloom — LAST so it composes the final framebuffer.
          Skipped in diag mode — bloom crushes contrast on the creature body. */}
      {!diag && <SurfBloom />}
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
  // RACER harness mode — mount one real-race ReefRacePlayer (spline path) to eyeball
  // the baked surf-tilt / banked ride / board orientation (needs the spline build flag).
  const racer = rawMode === 'racer';
  // ?species=<modelKey> override for the racer harness (registry-driven rider
  // router verification, 2026-07-10). Defaults to 'lobster' — the pre-existing
  // shipped behaviour when the param is omitted.
  const speciesParam = searchParams.get('species') ?? 'lobster';
  // DEV-ONLY VERIFY-HARNESS ADDITION (2026-07-12): ?camview=top for the RACER
  // harness — see ReefRaceKartHarness comment. Defaults to the pre-existing '3q'.
  const camview = searchParams.get('camview') ?? '3q';
  // DEV-ONLY VERIFY-HARNESS ADDITION (2026-07-12): ?diag=1 — see SceneContents.
  const diag = searchParams.get('diag') === '1';
  // Default to free-orbit hero of the whole floating loop in the void.
  const mode: CameraMode = isCameraMode(rawMode) ? rawMode : 'free-orbit';
  // DEV-ONLY VERIFY-HARNESS ADDITION (2026-07-12): `?capture=1` opts into
  // preserveDrawingBuffer so an external screenshot driver (Playwright / a
  // gl.readPixels probe) reads a stable framebuffer. Off by default — WebGL
  // preserveDrawingBuffer has a real perf cost (extra buffer copy per frame) so
  // it must never be on for a normal preview/production visit.
  const captureMode = searchParams.get('capture') === '1';

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
        gl={{ antialias: false, preserveDrawingBuffer: captureMode }}
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
            racer={racer}
            species={speciesParam}
            camview={camview}
            diag={diag}
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
          <b style={{ color: '#fff' }}>S</b> brake · <b style={{ color: '#fff' }}>Shift</b>+turn to charge drift,{' '}
          <b style={{ color: '#fff' }}>release</b> to boost · <b style={{ color: '#fff' }}>Space</b> whip the coral rival
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
