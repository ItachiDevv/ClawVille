'use client';

/**
 * ReefRaceScene.tsx
 *
 * Root R3F Canvas for the Reef Race activity.
 *
 * Route: /activity/reef-race/[roomId] (loaded via dynamic import in page.tsx)
 *
 * Architecture:
 *   - Route-isolated: mounts on its own Next.js route. `key={roomId}` on Canvas forces
 *     full WebGPU context recreation between rooms (per 3d-spec §3.1).
 *   - PerspectiveCamera in chase-cam mode — one frustum per client, not per player.
 *     Shadows remain disabled, avoiding a second scene render per frame.
 *   - Chase-cam lerps behind the self player; spectators see the static track cam.
 *   - <PreCompilePipelines> fires compileAsync after first R3F commit.
 *   - Reads `useActivityStore` for entity/pickup/event state.
 *
 * Iris Xe invariants enforced here:
 *   - No drei Text/Billboard anywhere.
 *   - No InstancedMesh + ShaderMaterial anywhere.
 *   - No per-frame allocations (module-scope scratch vectors/matrices).
 *   - 0 shadow maps.
 *   - 1 half-resolution bloom pass.
 *   - Fog far (22000) < camera.far (34000). ✓
 *   - matrixAutoUpdate=false on all static meshes (handled per-component).
 *
 * Performance budget: ≤70 draw calls / ≤220k tris.
 */

import { Suspense, useEffect, useRef, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import ReefRaceTrack         from './ReefRaceTrack';
import ReefRacePlayer        from './ReefRacePlayer';
import ReefRaceGhost         from './ReefRaceGhost';
import ReefRacePickups       from './ReefRacePickups';
import ReefRaceBoostFX       from './ReefRaceBoostFX';
// SURF ROAD (2026-06-23): ReefRaceCheckpoints / ReefRaceStartGrid /
// ReefRaceBoostRibbons / ReefRaceHazards / ReefRaceApexMarkers are no longer
// mounted — flat v1-coordinate overlays that float wrong against the elevated
// floating ribbon. See the SceneContents note. Imports removed.
import { ActivityBursts }    from '@/lib/three/activities/shared/activity-particles';
import { RiverScene }       from './river-scene';
import { SurfBloom }        from './surf-bloom';
import { elevationAtXZ, forgetTKey } from './reef-race-elevation';
import { useActivityStore } from '@/stores/activity';
import {
  FOG_COLOR,
  FOG_NEAR,
  FOG_FAR,
  CAMERA_NEAR,
  CAMERA_FAR,
  CAMERA_OFFSET,
  CAMERA_LOOK_OFFSET,
  CAMERA_LERP,
  HEMI_SKY_COLOR,
  HEMI_GROUND_COLOR,
  HEMI_INTENSITY,
  DIR_COLOR,
  DIR_INTENSITY,
  DIR_POSITION,
  DIR_SHADOW_MAP_SIZE,
  DIR_SHADOW_NEAR,
  DIR_SHADOW_FAR,
  DIR_SHADOW_CAM_BOUNDS,
  TRACK_SURFACE_Y,
} from './reef-race-config';
import { selfPoseBus, SELF_POSE_BUS_STALE_MS } from './reef-race-self-bus';
import { clientSpline } from './reef-race-spline-instance';
import type { ReefRaceEntity } from './reef-race-types';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';

// ─── v2 feature flag (mirror ReefRacePlayer) ──────────────────────────────────
const USE_SPLINE_CAMERA = process.env.NEXT_PUBLIC_REEF_RACE_USE_SPLINE === 'true';

// ─── Dev debug surface ────────────────────────────────────────────────────────
// Exposed when NODE_ENV=development OR ?debug=1 in URL.
// QA uses `window.__reefDebug.gl.info`, `.scene`, `.entities` for snapshot
// assertions. Safe to ship — the guard keeps it out of production bundles.
declare global {
  interface Window {
    __reefDebug?: {
      gl: THREE.WebGLRenderer;
      scene: THREE.Scene;
      entities: Map<string, ReefRaceEntity>;
    };
  }
}

// ─── Module-scope scratch (no per-frame allocations) ─────────────────────────
const _targetPos      = new THREE.Vector3();
const _lookAt         = new THREE.Vector3();
const _camPos         = new THREE.Vector3();
const _rotatedOffset  = new THREE.Vector3();
const _playerWorldDir = new THREE.Vector3(0, 0, 1);
// Scratch for selfPos passed to <ReefRaceBoostFX> — avoids a `new Vector3()` per
// React render. Safe: ReefRaceBoostFX reads playerPos.x/y/z only inside useFrame
// (RAF), which fires AFTER the React render that writes this value.
const _selfPosScratch = new THREE.Vector3();

const CAMERA_INTERP_DELAY_MS = 200;
const CAMERA_INTERP_HISTORY_SIZE = 4;

// ─── Pregame vantage — the start/finish line (spline t=0) ────────────────────
// Before the sim room exists (lobby + countdown) there are NO entities, so the
// chase cam used to sit at the Canvas default staring at world-origin geometry
// ("a mangled clobber of space" — founder 2026-07-14) and only jumped to the
// river when the first snapshot landed. Bodies spawn at t=0 heading along the
// tangent (reef-race-spline-sim.ts:600+), so parking the camera at the exact
// chase-cam pose for that spawn makes lobby → live seamless. Computed lazily
// once — clientSpline is a module singleton and the track is static.
let _pregameVantage: { x: number; z: number; heading: number } | null = null;
function pregameVantage() {
  if (!_pregameVantage) {
    const start = clientSpline.centerlineAt(0);
    const tan = clientSpline.tangentAt(0);
    _pregameVantage = {
      x: start.x,
      z: start.z,
      heading: Math.atan2(tan.x, tan.z),
    };
  }
  return _pregameVantage;
}

interface CameraSnapRecord {
  t: number;
  x: number;
  z: number;
  rot: number;
}

function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((b - a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return a + diff * t;
}

// ─── PreCompilePipelines ──────────────────────────────────────────────────────
// Must be rendered INSIDE SceneContents, AFTER all other children.
function PreCompilePipelines() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (typeof (gl as any).compileAsync === 'function') {
        (gl as any).compileAsync(scene, camera).catch((err: unknown) => {
          console.warn('[ReefRace] compileAsync failed:', err);
        });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [gl, scene, camera]);
  return null;
}

// ─── Directional light + shadow ───────────────────────────────────────────────
function ReefLight() {
  const dirRef = useRef<THREE.DirectionalLight>(null);

  useEffect(() => {
    const d = dirRef.current;
    if (!d) return;
    d.shadow.mapSize.set(DIR_SHADOW_MAP_SIZE, DIR_SHADOW_MAP_SIZE);
    d.shadow.camera.near   = DIR_SHADOW_NEAR;
    d.shadow.camera.far    = DIR_SHADOW_FAR;
    (d.shadow.camera as THREE.OrthographicCamera).left   = -DIR_SHADOW_CAM_BOUNDS;
    (d.shadow.camera as THREE.OrthographicCamera).right  =  DIR_SHADOW_CAM_BOUNDS;
    (d.shadow.camera as THREE.OrthographicCamera).top    =  DIR_SHADOW_CAM_BOUNDS;
    (d.shadow.camera as THREE.OrthographicCamera).bottom = -DIR_SHADOW_CAM_BOUNDS;
    d.shadow.camera.updateProjectionMatrix();
    // Light position is static after mount.
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

// ─── Chase camera ─────────────────────────────────────────────────────────────
// Procedural lerp-follow in useFrame — no OrbitControls.
// Module-scope scratch vectors prevent GC pressure.

// Module-scope scratch for screen shake (no per-frame allocation).
const _shakeOffset = new THREE.Vector3();

interface ChaseCamProps {
  selfEntity: ReefRaceEntity | null;
  /** Mutable ref holding current shake magnitude (wu). Decays in useFrame. */
  shakeRef: React.MutableRefObject<number>;
}

function ChaseCamera({ selfEntity, shakeRef }: ChaseCamProps) {
  const { camera } = useThree();
  const historyRef = useRef<CameraSnapRecord[]>([]);
  const lastEntityRef = useRef<ReefRaceEntity | null>(null);
  const lastRotRef = useRef(0);
  /** True once the pregame start-line vantage snapped the camera into place. */
  const pregameSnappedRef = useRef(false);

  useEffect(() => {
    // PerspectiveCamera setup.
    const cam = camera as THREE.PerspectiveCamera;
    cam.near = CAMERA_NEAR;
    cam.far  = CAMERA_FAR;
    cam.fov  = 60;
    cam.updateProjectionMatrix();
    // SURF ROAD: drop the 'cam' elevation-cache key on teardown.
    return () => { forgetTKey('cam'); };
  }, [camera]);

  useFrame((_, delta) => {
    if (!selfEntity) {
      historyRef.current.length = 0;
      lastEntityRef.current = null;
      // Lobby/countdown — no snapshots yet. Frame the start line so the
      // player sees the river spawn instead of world-origin geometry; the
      // pose matches the chase-cam pose of the t=0 spawn, so the transition
      // to live is a no-op. v1 (non-spline) keeps the legacy behaviour.
      if (USE_SPLINE_CAMERA) {
        const vantage = pregameVantage();
        const preCam = camera as THREE.PerspectiveCamera;
        _rotatedOffset.set(
          CAMERA_OFFSET.x * Math.cos(vantage.heading) + CAMERA_OFFSET.z * Math.sin(vantage.heading),
          CAMERA_OFFSET.y,
          -CAMERA_OFFSET.x * Math.sin(vantage.heading) + CAMERA_OFFSET.z * Math.cos(vantage.heading),
        );
        const groundY = TRACK_SURFACE_Y + elevationAtXZ(vantage.x, vantage.z, 'cam');
        _targetPos.set(vantage.x, groundY, vantage.z).add(_rotatedOffset);
        if (!pregameSnappedRef.current) {
          // First pregame frame — snap, don't ease from the Canvas default
          // (easing would sweep the camera through world geometry).
          pregameSnappedRef.current = true;
          preCam.position.copy(_targetPos);
        } else {
          const preLerp = Math.min(1, CAMERA_LERP * delta);
          preCam.position.lerp(_targetPos, preLerp);
        }
        _lookAt.set(vantage.x, groundY, vantage.z).add(CAMERA_LOOK_OFFSET);
        preCam.lookAt(_lookAt);
      }
      return;
    }

    const cam = camera as THREE.PerspectiveCamera;

    if (selfEntity !== lastEntityRef.current) {
      lastEntityRef.current = selfEntity;
      const hasVelocity = selfEntity.vx !== 0 || selfEntity.vy !== 0;
      const rot = (selfEntity.rot !== 0 || hasVelocity) ? selfEntity.rot : lastRotRef.current;
      const history = historyRef.current;
      history.push({
        t: performance.now(),
        x: selfEntity.x,
        z: selfEntity.y,
        rot,
      });
      if (history.length > CAMERA_INTERP_HISTORY_SIZE) {
        history.splice(0, history.length - CAMERA_INTERP_HISTORY_SIZE);
      }
    }

    let renderX = selfEntity.x;
    let renderZ = selfEntity.y;
    let heading = selfEntity.rot ?? lastRotRef.current;
    const history = historyRef.current;
    if (history.length === 1) {
      renderX = history[0].x;
      renderZ = history[0].z;
      heading = history[0].rot;
    } else if (history.length >= 2) {
      const renderTime = performance.now() - CAMERA_INTERP_DELAY_MS;
      let a = history[history.length - 2];
      let b = history[history.length - 1];
      for (let i = 1; i < history.length; i++) {
        if (history[i].t >= renderTime) {
          a = history[i - 1];
          b = history[i];
          break;
        }
      }
      const span = b.t - a.t;
      const rawT = span > 0 ? (renderTime - a.t) / span : 1;
      const t = rawT < 0 ? 0 : rawT > 1 ? 1 : rawT;
      renderX = a.x + (b.x - a.x) * t;
      renderZ = a.z + (b.z - a.z) * t;
      heading = lerpAngle(a.rot, b.rot, t);
    }
    lastRotRef.current = heading;

    // ─── v2 camera unify — follow the self body's PREDICTED pose ──────────────
    // When the self kart is running client prediction (reef-race v2), the body
    // renders from selfPoseBus, NOT the adaptive 100–220ms remote interp above. Follow the
    // SAME pose so camera + body share one timebase — this kills the rubber-band
    // where the kart slid to the screen edge on every turn while the camera
    // lagged. The interp above still ran (keeps history/lastRot warm) and is the
    // FALLBACK: if the bus is invalid or stale (no self, spectator, v1 path,
    // tab-throttle), we keep the interp-derived renderX/renderZ/heading.
    if (
      USE_SPLINE_CAMERA &&
      selfPoseBus.valid &&
      performance.now() - selfPoseBus.updatedAt <= SELF_POSE_BUS_STALE_MS
    ) {
      renderX = selfPoseBus.x;
      renderZ = selfPoseBus.z;
      heading = selfPoseBus.rot;
      lastRotRef.current = heading;
    }

    // Direction player is heading (facing).
    _playerWorldDir.set(Math.sin(heading), 0, Math.cos(heading));

    // Camera target position: behind + above player.
    // CAMERA_OFFSET: (0, 200, -350) in player-local space (kart-local).
    //
    // Convention:
    //   server `body.rot = atan2(intent.dir.x, intent.dir.y)` and the kart's
    //   group.rotation.y = body.rot, so the kart's local +Z (forward) maps to
    //   world (sin(rot), 0, cos(rot)).
    //
    // Three.js Y-rotation matrix transforms a local point (X,Y,Z) to world:
    //   world.x =  X*cos(rot) + Z*sin(rot)
    //   world.z = -X*sin(rot) + Z*cos(rot)
    //
    // The previous formula had `-Z*sin` and `+X*sin` — that's a rotation by
    // -rot, which puts the camera IN FRONT of the kart for any rot != 0 / π.
    // At spawn (rot=-π/2 facing west along track tangent) the camera ended up
    // WEST of player, so the player saw their kart from in-front and the
    // controls felt fully reversed (W drove "toward" the camera, A/D mirrored).
    _rotatedOffset.set(
      CAMERA_OFFSET.x * Math.cos(heading) + CAMERA_OFFSET.z * Math.sin(heading),
      CAMERA_OFFSET.y,
      -CAMERA_OFFSET.x * Math.sin(heading) + CAMERA_OFFSET.z * Math.cos(heading),
    );

    // ─── SURF ROAD: lift the camera datum by the FLOATING ribbon elevation ────
    // The ribbon Y at the kart's XZ is reefTrackElevationAt(closest spline-t),
    // cheaply cached under the 'cam' key (one local-scan lookup/frame). Both the
    // camera eye AND the lookAt rise/dip by the SAME value the ribbon + rider
    // use (the parity contract) so the camera frames the rider through every
    // climb/drop and never clips into the ribbon or loses the rider over a
    // crest. TRACK_SURFACE_Y is now 0 (the datum is the elevation function).
    const camGroundY = USE_SPLINE_CAMERA
      ? TRACK_SURFACE_Y + elevationAtXZ(renderX, renderZ, 'cam')
      : TRACK_SURFACE_Y;

    _targetPos.set(renderX, camGroundY, renderZ).add(_rotatedOffset);

    // Lerp camera position.
    const lerpFactor = Math.min(1, CAMERA_LERP * delta);
    _camPos.copy(cam.position).lerp(_targetPos, lerpFactor);
    cam.position.copy(_camPos);

    // Look at kart + upward offset (also riding the elevation datum).
    _lookAt.set(renderX, camGroundY, renderZ).add(CAMERA_LOOK_OFFSET);
    cam.lookAt(_lookAt);

    // Screen shake — decay and apply camera position offset.
    // shakeRef.current holds magnitude in wu. Decays at 2.5×/second.
    if (shakeRef.current > 0.01) {
      shakeRef.current = Math.max(0, shakeRef.current - delta * 2.5 * shakeRef.current);
      const mag = shakeRef.current;
      _shakeOffset.set(
        (Math.random() * 2 - 1) * mag,
        (Math.random() * 2 - 1) * mag * 0.5,
        (Math.random() * 2 - 1) * mag * 0.5,
      );
      cam.position.add(_shakeOffset);
    } else {
      shakeRef.current = 0;
    }
  });

  return null;
}

// ─── Debug surface ────────────────────────────────────────────────────────────
// Exposes `window.__reefDebug` when NODE_ENV=development OR ?debug=1.
// Must live inside Canvas (uses useThree). Zero-cost in prod bundles because
// the condition is evaluated once on mount and the effect does nothing.
function DebugExpose({ entities }: { entities: Map<string, ReefRaceEntity> }) {
  const { gl, scene } = useThree();
  const isDebug =
    process.env.NODE_ENV === 'development' ||
    (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug'));

  useEffect(() => {
    if (!isDebug) return;
    window.__reefDebug = { gl: gl as THREE.WebGLRenderer, scene, entities };
    return () => {
      window.__reefDebug = undefined;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDebug, gl, scene, entities]);

  return null;
}

// ─── Scene contents ───────────────────────────────────────────────────────────

interface SceneContentsProps {
  entities: Map<string, ReefRaceEntity>;
  selfAvatarId: string | null;
  matchPhase: string;
  raceStartMs: number;
}

function SceneContents({ entities, selfAvatarId, matchPhase, raceStartMs }: SceneContentsProps) {
  const selfEntity = selfAvatarId ? (entities.get(selfAvatarId) ?? null) : null;
  // Use module-scope scratch to avoid a `new Vector3()` allocation every render.
  // ReefRaceBoostFX only reads playerPos.x/y/z inside useFrame (RAF), which fires
  // after this render — the scratch value is stable for the duration of the frame.
  // SURF ROAD: lift the boost-FX anchor onto the floating ribbon (render-only
  // elevation at the self kart's XZ; reuses the 'cam' elevation-cache key since
  // it's the same neighbourhood the camera already resolved this frame).
  const selfPos = selfEntity
    ? _selfPosScratch.set(
        selfEntity.x,
        USE_SPLINE_CAMERA ? elevationAtXZ(selfEntity.x, selfEntity.y, 'cam') : 0,
        selfEntity.y,
      )
    : null;

  // Screen shake — mutable ref, zero re-renders.
  // ChaseCamera decays this in useFrame at 2.5×/second (exponential falloff).
  const shakeRef = useRef<number>(0);

  // Stable callback: writing to a ref never changes the callback identity.
  const triggerScreenShake = useCallback((intensity: number) => {
    // Add, don't set — stacking ramp hits accumulates correctly.
    shakeRef.current = Math.min(shakeRef.current + intensity, 120);
  }, []);

  // v2 mechanics (2026-07-10) — REUSE the existing trail/speed-cone FX for
  // ANY boost source, not just inventory items. `entity.boosting` is the
  // server-authoritative "any positive boost active" flag (boost pad /
  // mini-turbo / launch / slipstream — see EntityDelta.changed.boosting in
  // protocol.ts), forwarded onto the self entity by applyEntityDelta. This
  // is the parity contract: the SAME server signal that triggers a pad/
  // turbo boost also drives the world FX, not an invented client guess.
  const boostActive = useActivityStore(
    (s) => {
      if (!selfAvatarId) return false;
      const itemBoost = s.powerUpInventory.some((p) => p.kind === 'boost' && p.charges > 0);
      const selfEntity = s.entities.get(selfAvatarId) as (ReefRaceEntity | undefined);
      return itemBoost || Boolean(selfEntity?.boosting);
    },
  );

  // SURF ROAD: the start-grid countdown gantry is no longer rendered in-scene
  // (the flat v1 start grid is unmounted — see the SceneContents note). The
  // pregame countdown is shown in the HUD. `matchPhase` is still received for
  // contract stability but no longer drives an in-scene gantry colour.
  void matchPhase;

  return (
    <>
      {/* Chase camera (follows selfEntity) */}
      <ChaseCamera selfEntity={selfEntity} shakeRef={shakeRef} />

      {/* Atmosphere — SURF ROAD: deep cosmic void. Fog is pushed far out (9000–
          22000) so it only softens the FAR side of the loop into the void; the
          ribbon + rails are fog:false (always crisp). Background = void colour so
          the first paint (before the dome resolves) is already deep, not sky-blue. */}
      <fog args={[FOG_COLOR, FOG_NEAR, FOG_FAR]} />
      <color attach="background" args={['#0c1a2e']} />

      {/* SURF ROAD: the cosmic void backdrop + the glowing FLOATING WATER RIBBON
          (+ neon rails + crests) + ramps. No land/island/ground/sky. The ribbon
          rides reefTrackElevationAt(t) + reefTrackBankAngleAt(t). Demo karts off
          in gameplay (server karts render via <ReefRacePlayer />). */}
      <RiverScene showDemoKarts={false} showDemoPickups={false} />

      {/* Lighting */}
      <ReefLight />

      <group position-y={TRACK_SURFACE_Y}>
        {/* Spline-derived start/finish gate (lifted onto the ribbon).
            SURF ROAD (2026-06-23): the flat v1-ellipse-coordinate overlays —
            <ReefRaceCheckpoints/>, <ReefRaceBoostRibbons/>, <ReefRaceHazards/>,
            <ReefRaceApexMarkers/>, <ReefRaceStartGrid/> — are NOT mounted in the
            floating-ribbon scene. They were authored against the old flat plane
            (Y=0) and the v1 ellipse/zone coords, so against the undulating ribbon
            they float detached at the wrong altitude/position. They are pure
            client visuals (no sim/scoring dependency); the countdown still shows
            in the HUD, and the start/finish is marked by the spline finish gate.
            Re-add later as spline-t + elevation-aware overlays if desired. */}
        <Suspense fallback={null}>
          <ReefRaceTrack />
        </Suspense>

        {/* Player karts — up to 8 draw calls */}
        <Suspense fallback={null}>
          {Array.from(entities.values()).map((entity) => (
            <ReefRacePlayer
              key={entity.avatarId}
              entity={entity}
              isSelf={entity.avatarId === selfAvatarId}
              triggerScreenShake={entity.avatarId === selfAvatarId ? triggerScreenShake : undefined}
            />
          ))}
        </Suspense>

        {/* Ghost kart — 1 draw call (max 1, own best only) */}
        <Suspense fallback={null}>
          <ReefRaceGhost raceStartMs={raceStartMs} />
        </Suspense>

        {/* Pickup boxes — 1 draw call (InstancedMesh) */}
        <ReefRacePickups />

        {/* Boost visual effects — 2 draw calls */}
        <ReefRaceBoostFX playerPos={selfPos} boostActive={boostActive} />

        {/* Shared burst particle pool — up to 8 Points objects */}
        <ActivityBursts />
      </group>

      {/* Dev debug surface — exposes window.__reefDebug in dev / ?debug=1 */}
      <DebugExpose entities={entities} />

      {/* Pipeline pre-compilation */}
      <PreCompilePipelines />

      {/* SURF ROAD: selective bloom on the neon rails + water crests. Takes over
          the render loop (positive-priority useFrame) so it MUST be the LAST
          child — it composes the final framebuffer. Iris-Xe-gated (half-res). */}
      <SurfBloom />
    </>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export interface ReefRaceSceneProps {
  /** Room ID — Canvas key forces context recreation between rooms. */
  roomId: string;
  /** The current user's avatar ID, used for chase-cam and self-highlight. */
  selfAvatarId?: string | null;
}

export default function ReefRaceScene({ roomId, selfAvatarId = null }: ReefRaceSceneProps) {
  const entities    = useActivityStore((s) => s.entities as Map<string, ReefRaceEntity>);
  const matchPhase  = useActivityStore((s) => s.matchPhase);
  const raceStartMs = useActivityStore((s) =>
    s.matchPhase === 'live' ? (s.room?.startedAt ?? 0) : 0,
  );

  return (
    <Canvas
      key={roomId}
      camera={{ near: CAMERA_NEAR, far: CAMERA_FAR, fov: 60 }}
      // shadows REMOVED 2026-05-09 — full shadow-map pipeline was running per
      // frame for the track + guardrails + ramps + checkpoints + pickups +
      // hazards. Mirrors Bumper Shells which dropped shadows for the same
      // perf budget. Lighting is still directional via the scene's
      // directional+ambient lights; the cost was the second render pass for
      // shadow map generation, not the lights themselves.
      gl={{ antialias: false }}
      style={{ width: '100%', height: '100%' }}
      dpr={[1, 1.5]}
    >
      <KTX2LoaderSetup />
      <SceneContents
        entities={entities ?? new Map()}
        selfAvatarId={selfAvatarId}
        matchPhase={matchPhase}
        raceStartMs={raceStartMs}
      />
    </Canvas>
  );
}
