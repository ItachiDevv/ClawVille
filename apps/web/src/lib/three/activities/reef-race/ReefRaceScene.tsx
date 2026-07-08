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
 *     Single shadow map regardless of racer count — sidesteps Iris Xe multi-frusta ceiling.
 *   - Chase-cam lerps behind the self player; spectators see the static track cam.
 *   - <PreCompilePipelines> fires compileAsync after first R3F commit.
 *   - Reads `useActivityStore` for entity/pickup/event state.
 *
 * Iris Xe invariants enforced here:
 *   - No drei Text/Billboard anywhere.
 *   - No InstancedMesh + ShaderMaterial anywhere.
 *   - No per-frame allocations (module-scope scratch vectors/matrices).
 *   - 1 shadow map at 512×512.
 *   - 0 post-processing passes.
 *   - Fog far (4500) < camera.far (5000). ✓
 *   - matrixAutoUpdate=false on all static meshes (handled per-component).
 *
 * Performance budget: ≤70 draw calls / ≤220k tris.
 */

import { Suspense, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import ReefRaceTrack         from './ReefRaceTrack';
import ReefRaceCheckpoints   from './ReefRaceCheckpoints';
import ReefRaceStartGrid     from './ReefRaceStartGrid';
import ReefRacePlayer        from './ReefRacePlayer';
import ReefRaceGhost         from './ReefRaceGhost';
import ReefRacePickups       from './ReefRacePickups';
import ReefRaceBoostFX       from './ReefRaceBoostFX';
import ReefRaceBoostRibbons  from './ReefRaceBoostRibbons';
import ReefRaceHazards       from './ReefRaceHazards';
import ReefRaceApexMarkers   from './ReefRaceApexMarkers';
import { ActivityBursts }    from '@/lib/three/activities/shared/activity-particles';
import { KTX2LoaderSetup }   from '@/lib/three/ktx2-loader-setup';
import { RiverScene }       from './river-scene';
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
  VOID_BACKDROP_Y,
  VOID_BACKDROP_SIZE,
  TRACK_SURFACE_Y,
} from './reef-race-config';
import { selfPoseBus, SELF_POSE_BUS_STALE_MS } from './reef-race-self-bus';
import type { ReefRaceEntity } from './reef-race-types';

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

// ─── Depth backdrop (below track plane) ──────────────────────────────────────
// MeshBasicMaterial ignores fog — placed far enough to be invisible.
function DepthBackdrop() {
  const geo = useMemo(() => new THREE.PlaneGeometry(VOID_BACKDROP_SIZE, VOID_BACKDROP_SIZE), []);
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#061020', side: THREE.FrontSide }),
    [],
  );
  useEffect(() => {
    return () => {
      geo.dispose();
      mat.dispose();
    };
  }, [geo, mat]);

  return (
    <mesh
      geometry={geo}
      material={mat}
      position={[0, VOID_BACKDROP_Y, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      frustumCulled={false}
      matrixAutoUpdate={false}
    />
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

  useEffect(() => {
    // PerspectiveCamera setup.
    const cam = camera as THREE.PerspectiveCamera;
    cam.near = CAMERA_NEAR;
    cam.far  = CAMERA_FAR;
    cam.fov  = 60;
    cam.updateProjectionMatrix();
  }, [camera]);

  useFrame((_, delta) => {
    if (!selfEntity) {
      historyRef.current.length = 0;
      lastEntityRef.current = null;
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
    // renders from selfPoseBus, NOT the 200 ms server interp above. Follow the
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
    _targetPos.set(renderX, TRACK_SURFACE_Y, renderZ).add(_rotatedOffset);

    // Lerp camera position.
    const lerpFactor = Math.min(1, CAMERA_LERP * delta);
    _camPos.copy(cam.position).lerp(_targetPos, lerpFactor);
    cam.position.copy(_camPos);

    // Look at kart + upward offset.
    _lookAt.set(renderX, TRACK_SURFACE_Y, renderZ).add(CAMERA_LOOK_OFFSET);
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
  const selfPos = selfEntity
    ? _selfPosScratch.set(selfEntity.x, 0, selfEntity.y)
    : null;

  // Screen shake — mutable ref, zero re-renders.
  // ChaseCamera decays this in useFrame at 2.5×/second (exponential falloff).
  const shakeRef = useRef<number>(0);

  // Stable callback: writing to a ref never changes the callback identity.
  const triggerScreenShake = useCallback((intensity: number) => {
    // Add, don't set — stacking ramp hits accumulates correctly.
    shakeRef.current = Math.min(shakeRef.current + intensity, 120);
  }, []);

  const boostActive = useActivityStore(
    (s) => selfAvatarId
      ? (s.powerUpInventory.some((p) => p.kind === 'boost' && p.charges > 0))
      : false,
  );

  const gantryPhase = useMemo(() => {
    if (matchPhase === 'pregame-countdown') return 'red' as const;
    if (matchPhase === 'live')              return 'green' as const;
    return 'off' as const;
  }, [matchPhase]);

  return (
    <>
      {/* Chase camera (follows selfEntity) */}
      <ChaseCamera selfEntity={selfEntity} shakeRef={shakeRef} />

      {/* Atmosphere */}
      <fog args={[FOG_COLOR, FOG_NEAR, FOG_FAR]} />
      {/* Sky-blue clear color matches SkyDome horizon — prevents flash before dome renders */}
      <color attach="background" args={['#a8d8ff']} />

      {/* Low-poly stylized river atmosphere — dome, water surface, scenery.
          showDemoKarts/Pickups disabled in real gameplay so the 5 cosmetic
          spline karts and decorative power-up boxes don't visually compete
          with the server-driven <ReefRacePlayer /> + <ReefRacePickups />. */}
      <RiverScene showDemoKarts={false} showDemoPickups={false} />

      {/* Lighting */}
      <ReefLight />

      {/* Depth backdrop (below track plane) */}
      <DepthBackdrop />

      <group position-y={TRACK_SURFACE_Y}>
        {/* Static track geometry */}
        <Suspense fallback={null}>
          <ReefRaceTrack />
        </Suspense>

        {/* Checkpoints (merged static) */}
        <ReefRaceCheckpoints />

        {/* Phase 2 — boost ribbons, hazard patches, apex markers (static) */}
        <ReefRaceBoostRibbons />
        <ReefRaceHazards />
        <ReefRaceApexMarkers />

        {/* Start grid + gantry + flags */}
        <ReefRaceStartGrid gantryPhase={gantryPhase} />

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

      {/* Pipeline pre-compilation — must be LAST */}
      <PreCompilePipelines />
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
