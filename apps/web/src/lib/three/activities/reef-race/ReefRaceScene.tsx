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
 *   - Fog far (1800) < camera.far (2000). ✓
 *   - matrixAutoUpdate=false on all static meshes (handled per-component).
 *
 * Performance budget: ≤70 draw calls / ≤220k tris.
 */

import { Suspense, useEffect, useRef, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import ReefRaceTrack       from './ReefRaceTrack';
import ReefRaceCheckpoints from './ReefRaceCheckpoints';
import ReefRaceStartGrid   from './ReefRaceStartGrid';
import ReefRacePlayer      from './ReefRacePlayer';
import ReefRaceGhost       from './ReefRaceGhost';
import ReefRacePickups     from './ReefRacePickups';
import ReefRaceBoostFX     from './ReefRaceBoostFX';
import { ActivityBursts }  from '@/lib/three/activities/shared/activity-particles';
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
} from './reef-race-config';
import type { ReefRaceEntity } from './reef-race-types';

// ─── Module-scope scratch (no per-frame allocations) ─────────────────────────
const _targetPos = new THREE.Vector3();
const _lookAt    = new THREE.Vector3();
const _camPos    = new THREE.Vector3();
const _rotatedOffset = new THREE.Vector3();
const _playerWorldDir = new THREE.Vector3(0, 0, 1);

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

interface ChaseCamProps {
  selfEntity: ReefRaceEntity | null;
}

function ChaseCamera({ selfEntity }: ChaseCamProps) {
  const { camera } = useThree();

  useEffect(() => {
    // PerspectiveCamera setup.
    const cam = camera as THREE.PerspectiveCamera;
    cam.near = CAMERA_NEAR;
    cam.far  = CAMERA_FAR;
    cam.fov  = 60;
    cam.updateProjectionMatrix();
  }, [camera]);

  useFrame((_, delta) => {
    if (!selfEntity) return;

    const cam = camera as THREE.PerspectiveCamera;

    // Direction player is heading (facing).
    const heading = selfEntity.rot ?? 0;
    _playerWorldDir.set(Math.sin(heading), 0, Math.cos(heading));

    // Camera target position: behind + above player.
    // CAMERA_OFFSET: (0, 200, -350) in player-local space.
    _rotatedOffset.set(
      CAMERA_OFFSET.x * Math.cos(heading) - CAMERA_OFFSET.z * Math.sin(heading),
      CAMERA_OFFSET.y,
      CAMERA_OFFSET.x * Math.sin(heading) + CAMERA_OFFSET.z * Math.cos(heading),
    );
    _targetPos.set(selfEntity.x, 0, selfEntity.y).add(_rotatedOffset);

    // Lerp camera position.
    const lerpFactor = Math.min(1, CAMERA_LERP * delta);
    _camPos.copy(cam.position).lerp(_targetPos, lerpFactor);
    cam.position.copy(_camPos);

    // Look at kart + upward offset.
    _lookAt.set(selfEntity.x, 0, selfEntity.y).add(CAMERA_LOOK_OFFSET);
    cam.lookAt(_lookAt);
  });

  return null;
}

// ─── Scene contents ───────────────────────────────────────────────────────────

interface SceneContentsProps {
  entities: Map<string, ReefRaceEntity>;
  selfPetId: string | null;
  matchPhase: string;
  raceStartMs: number;
}

function SceneContents({ entities, selfPetId, matchPhase, raceStartMs }: SceneContentsProps) {
  const selfEntity = selfPetId ? (entities.get(selfPetId) ?? null) : null;
  const selfPos    = selfEntity
    ? new THREE.Vector3(selfEntity.x, 0, selfEntity.y)
    : null;

  const boostActive = useActivityStore(
    (s) => selfPetId
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
      <ChaseCamera selfEntity={selfEntity} />

      {/* Atmosphere */}
      <fog args={[FOG_COLOR, FOG_NEAR, FOG_FAR]} />
      <color attach="background" args={[FOG_COLOR]} />

      {/* Lighting */}
      <ReefLight />

      {/* Depth backdrop */}
      <DepthBackdrop />

      {/* Static track geometry */}
      <Suspense fallback={null}>
        <ReefRaceTrack />
      </Suspense>

      {/* Checkpoints (merged static) */}
      <ReefRaceCheckpoints />

      {/* Start grid + gantry + flags */}
      <ReefRaceStartGrid gantryPhase={gantryPhase} />

      {/* Player karts — up to 8 draw calls */}
      <Suspense fallback={null}>
        {Array.from(entities.values()).map((entity) => (
          <ReefRacePlayer
            key={entity.petId}
            entity={entity}
            isSelf={entity.petId === selfPetId}
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

      {/* Pipeline pre-compilation — must be LAST */}
      <PreCompilePipelines />
    </>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export interface ReefRaceSceneProps {
  /** Room ID — Canvas key forces context recreation between rooms. */
  roomId: string;
  /** The current user's pet ID, used for chase-cam and self-highlight. */
  selfPetId?: string | null;
}

export default function ReefRaceScene({ roomId, selfPetId = null }: ReefRaceSceneProps) {
  const entities    = useActivityStore((s) => s.entities as Map<string, ReefRaceEntity>);
  const matchPhase  = useActivityStore((s) => s.matchPhase);
  const raceStartMs = useActivityStore((s) =>
    s.matchPhase === 'live' ? (s.room?.startedAt ?? 0) : 0,
  );

  return (
    <Canvas
      key={roomId}
      camera={{ near: CAMERA_NEAR, far: CAMERA_FAR, fov: 60 }}
      shadows
      gl={{ antialias: false }} // Disable MSAA for Iris Xe perf budget
      style={{ width: '100%', height: '100%' }}
      dpr={[1, 1.5]} // Clamp pixel ratio for Iris Xe
    >
      <SceneContents
        entities={entities ?? new Map()}
        selfPetId={selfPetId}
        matchPhase={matchPhase}
        raceStartMs={raceStartMs}
      />
    </Canvas>
  );
}
