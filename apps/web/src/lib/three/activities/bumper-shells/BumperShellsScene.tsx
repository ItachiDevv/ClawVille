'use client';

/**
 * BumperShellsScene.tsx
 *
 * Root R3F Canvas for the Bumper Shells minigame.
 *
 * Route: /activity/bumper-shells/[roomId] (page.tsx — owned by general-purpose agent)
 *
 * Architecture:
 *   - Isolated from the open world — mounts on its own Next.js route.
 *   - `key={roomId}` on Canvas forces full WebGPU context recreation between rooms.
 *   - Static OrthographicCamera (top-down with slight isometric tilt) when no spectator mode.
 *   - Spectator modes (chunk #12a): 'follow' | 'free' | 'action' — single PerspectiveCamera,
 *     swapped in when spectatorCamMode is set. Active players always use the static ortho camera.
 *   - <PreCompilePipelines> fires compileAsync after first R3F commit.
 *   - Reads `useActivityStore` for entity/pickup/event state (written by general-purpose WS hook).
 *
 * Iris Xe invariants enforced here:
 *   - No drei Text/Billboard anywhere.
 *   - No InstancedMesh + ShaderMaterial.
 *   - No per-frame allocations in useFrame (module-scope scratch vectors only).
 *   - 1 shadow map at 512×512.
 *   - 0 post-processing passes.
 *   - Fog far (900) < camera.far (1500).
 *   - OrbitControls added only for 'free' mode; disabled on mode exit.
 *   - ONE camera per client across all modes — no extra shadow frusta.
 *
 * Performance budget: ≤60 draw calls / ≤180k tris.
 *
 * Spectator camera modes (chunk #12a):
 *   undefined           → static ortho camera (default for active players)
 *   'follow'            → perspective, lerps toward spectatorTarget + offset
 *   'free'              → perspective + OrbitControls, bounded 600–1500wu
 *   'action'            → perspective, auto-follows highest kill-count / most-recent kill
 *
 * Props accepted by parent route:
 *   <BumperShellsScene roomId={roomId} selfAvatarId={selfAvatarId} />
 *   <BumperShellsScene roomId={roomId} selfAvatarId={selfAvatarId}
 *     spectatorCamMode="follow" spectatorTargetPetId={avatarId} />
 */

import { Suspense, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { extend } from '@react-three/fiber';
import type { ThreeToJSXElements } from '@react-three/fiber';

// Register Three.js WebGPU elements with R3F.
declare module '@react-three/fiber' {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}
extend(THREE as any);

import BumperShellsArena    from './BumperShellsArena';
import BumperShellsHazard   from './BumperShellsHazard';
import BumperShellsPlayer   from './BumperShellsPlayer';
import BumperShellsPickups  from './BumperShellsPickups';
import BumperShellsParticles, { triggerBurst } from './BumperShellsParticles';
import {
  FOG_COLOR,
  FOG_NEAR,
  FOG_FAR,
  CAMERA_ORTHO_SIZE,
  CAMERA_NEAR,
  CAMERA_FAR,
  CAMERA_POSITION,
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
  HAZARD_ENABLED,
  MAX_PLAYERS,
} from './bumper-shells-config';
import type { BumperShellEntity, BumperPickup, BumperHitEvent } from './bumper-shells-types';

// ─── Activity store import ────────────────────────────────────────────────────
// NOTE: This file does not exist yet — general-purpose will land it.
// The import is stubbed so the module compiles (the store returns empty defaults).
// Expected type: see ActivityStateForScene in bumper-shells-types.ts.
import { useActivityStore } from '@/stores/activity';

// ─── Spectator camera mode type ───────────────────────────────────────────────

export type SpectatorCamMode = 'follow' | 'free' | 'action';

// ─── Module-scope scratch — NO per-frame allocations ─────────────────────────
const _hitCheckScratch = { lastHitCount: 0 };

// Spectator camera scratch vectors (shared across all modes).
const _camTargetPos  = new THREE.Vector3();
const _camDesiredPos = new THREE.Vector3();
const _camOffset     = new THREE.Vector3();
const _camLookAt     = new THREE.Vector3();
const _entityPos     = new THREE.Vector3();

// Spectator 'follow' mode: offset from target in world space.
// Above (Y) + behind (Z in world space, since arena is top-down).
const FOLLOW_OFFSET = new THREE.Vector3(0, 400, 350);

// 'action' mode: re-sample target every N seconds.
const ACTION_RETARGET_INTERVAL = 3.0; // seconds

// Perspective camera FOV for spectator modes.
const SPECTATOR_FOV = 55;

// Lerp alpha per second for smooth camera movement.
// 1 - Math.exp(-alpha * dt) gives frame-rate independent lerp.
const CAMERA_LERP_ALPHA = 4.0;

// ─── PreCompilePipelines ──────────────────────────────────────────────────────
// Must be rendered INSIDE SceneContents, AFTER all other children.
// Same pattern as World3DCanvas.tsx.
function PreCompilePipelines() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (typeof (gl as any).compileAsync === 'function') {
        (gl as any).compileAsync(scene, camera).catch((err: unknown) => {
          console.warn('[BumperShells] compileAsync failed:', err);
        });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [gl, scene, camera]);
  return null;
}

// ─── Static Orthographic Camera ────────────────────────────────────────────────
// Used when spectatorCamMode is undefined (active player default).
// Camera never moves after mount — matrixAutoUpdate=false.
function BumperOrthoCamera() {
  const { camera, size } = useThree();

  useEffect(() => {
    const ortho = camera as THREE.OrthographicCamera;
    ortho.left   = -CAMERA_ORTHO_SIZE;
    ortho.right  =  CAMERA_ORTHO_SIZE;
    ortho.top    =  CAMERA_ORTHO_SIZE;
    ortho.bottom = -CAMERA_ORTHO_SIZE;
    ortho.near   = CAMERA_NEAR;
    ortho.far    = CAMERA_FAR;
    ortho.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);
    ortho.lookAt(0, 0, 0);
    ortho.updateProjectionMatrix();
    // Camera is static — disable per-frame matrix updates.
    ortho.matrixAutoUpdate = false;
    ortho.updateMatrix();
  }, [camera, size]);

  return null;
}

// ─── Spectator Camera Controller ──────────────────────────────────────────────
// Manages a single PerspectiveCamera for all 3 spectator modes.
// Replaces the static ortho camera when spectatorCamMode is set.
// Iris Xe rule: ONE camera per client — no extra shadow frusta.

interface SpectatorCameraProps {
  mode: SpectatorCamMode;
  /** avatarId of the entity to follow in 'follow' mode. null = auto-pick closest alive. */
  targetPetId: string | null;
  /** Live entity map from activity store — read in useFrame (no re-render trigger). */
  entities: Map<string, BumperShellEntity>;
}

function SpectatorCamera({ mode, targetPetId, entities }: SpectatorCameraProps) {
  const { camera, gl } = useThree();

  // 'free' mode OrbitControls — created/destroyed on mode enter/exit.
  const orbitRef = useRef<OrbitControls | null>(null);

  // 'action' mode: track time since last retarget and current action target id.
  const actionTimerRef  = useRef(0);
  const actionTargetRef = useRef<string | null>(null);

  // Configure perspective camera once on mount.
  useEffect(() => {
    const persp = camera as THREE.PerspectiveCamera;
    if (!persp.isPerspectiveCamera) {
      // R3F Canvas was created with orthographic — we can't retroactively swap
      // camera type at runtime. Instead we override projection manually.
      // The canvas prop `orthographic` bakes in an OrthographicCamera. When
      // BumperShellsScene passes a spectatorCamMode, the Canvas must NOT be
      // created with `orthographic`. This component assumes a PerspectiveCamera.
      // (See BumperShellsScene render — spectator mode mounts a different Canvas.)
      console.warn('[SpectatorCamera] Expected PerspectiveCamera, got', persp.type);
    }
    persp.fov  = SPECTATOR_FOV;
    persp.near = CAMERA_NEAR;
    persp.far  = CAMERA_FAR;
    persp.updateProjectionMatrix();

    // Initial position — above arena looking down at center.
    persp.position.set(0, 900, 600);
    persp.lookAt(0, 0, 0);

    return () => {
      // Cleanup OrbitControls if they were active.
      orbitRef.current?.dispose();
      orbitRef.current = null;
    };
  }, [camera]);

  // Enable/disable OrbitControls for 'free' mode.
  useEffect(() => {
    if (mode === 'free') {
      if (!orbitRef.current) {
        const oc = new OrbitControls(camera, gl.domElement);
        oc.target.set(0, 0, 0);
        // Bound distance: 600–1500wu (Iris Xe perf budget, no extra shadow frusta).
        oc.minDistance = 600;
        oc.maxDistance = 1500;
        oc.enablePan = false;
        oc.update();
        orbitRef.current = oc;
      }
    } else {
      // Exiting 'free' — dispose controls so they don't intercept pointer events.
      orbitRef.current?.dispose();
      orbitRef.current = null;
    }
  }, [mode, camera, gl]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);

    // 'free' mode — OrbitControls drives the camera; just tick controls.
    if (mode === 'free') {
      orbitRef.current?.update();
      return;
    }

    // Resolve the target entity.
    let targetEntity: BumperShellEntity | null = null;

    if (mode === 'follow') {
      // 'follow': explicit target avatarId, or first alive entity as fallback.
      if (targetPetId) {
        targetEntity = entities.get(targetPetId) ?? null;
        // If target is eliminated, fall back to any alive entity.
        if (targetEntity && !targetEntity.alive) targetEntity = null;
      }
      if (!targetEntity) {
        // Fallback: first alive entity.
        for (const e of entities.values()) {
          if (e.alive) { targetEntity = e; break; }
        }
      }
    } else if (mode === 'action') {
      // 'action': re-sample target every ACTION_RETARGET_INTERVAL seconds.
      // Target = entity with most kills (proxied by highest score via eliminations
      // recency). Since we don't have per-entity kill counts in the store's entity
      // map, we use a heuristic: pick a random alive entity on retarget, biased
      // toward center (smallest distance from (0,0)). This gives the "action camera"
      // feel of following active play near the arena center where collisions happen.
      actionTimerRef.current += dt;
      if (actionTimerRef.current >= ACTION_RETARGET_INTERVAL || actionTargetRef.current === null) {
        actionTimerRef.current = 0;

        // Pick the alive entity closest to arena center (most contested zone).
        let bestDist = Infinity;
        let bestId: string | null = null;
        for (const e of entities.values()) {
          if (!e.alive) continue;
          const distSq = e.x * e.x + e.y * e.y;
          if (distSq < bestDist) {
            bestDist = distSq;
            bestId = e.avatarId;
          }
        }
        // If no alive entity near center, keep previous target.
        if (bestId !== null) {
          actionTargetRef.current = bestId;
        }
      }
      if (actionTargetRef.current) {
        targetEntity = entities.get(actionTargetRef.current) ?? null;
        if (targetEntity && !targetEntity.alive) {
          // Target was eliminated — clear and pick again next frame.
          actionTargetRef.current = null;
          targetEntity = null;
        }
      }
    }

    if (!targetEntity) {
      // No target — hover above arena center looking down.
      _camDesiredPos.set(0, 900, 600);
      _camLookAt.set(0, 0, 0);
    } else {
      // Target entity 3D position: sim-space x→X, y→Z.
      _entityPos.set(targetEntity.x, 6, targetEntity.y);

      // Desired camera position: entity + follow offset.
      _camDesiredPos.copy(_entityPos).add(FOLLOW_OFFSET);
      // Look at the entity with a slight upward bias so the arena reads clearly.
      _camLookAt.copy(_entityPos);
      _camLookAt.y = 30;
    }

    // Smooth lerp: frame-rate independent using exp(-alpha * dt).
    const alpha = 1.0 - Math.exp(-CAMERA_LERP_ALPHA * dt);
    camera.position.lerp(_camDesiredPos, alpha);
    // Lerp lookAt via temporary target vector.
    _camTargetPos.copy(_camLookAt);

    // Update camera orientation toward look target.
    camera.lookAt(_camTargetPos);
    camera.updateProjectionMatrix();
  });

  return null;
}

// ─── Directional light + shadow setup ────────────────────────────────────────
function BumperLight() {
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
    // Static light — freeze matrix.
    d.matrixAutoUpdate = false;
    d.updateMatrix();
  }, []);

  return (
    <>
      <hemisphereLight
        args={[HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY]}
      />
      <directionalLight
        ref={dirRef}
        color={DIR_COLOR}
        intensity={DIR_INTENSITY}
        position={DIR_POSITION}
        castShadow
      />
      {/* Neon accent point lights — no shadows, static position. */}
      <pointLight color="#00ccff" intensity={0.6} distance={400} decay={2} position={[400,  80,  0]}  castShadow={false} />
      <pointLight color="#ff66aa" intensity={0.6} distance={400} decay={2} position={[-300, 80, 350]} castShadow={false} />
      <pointLight color="#aa44ff" intensity={0.5} distance={350} decay={2} position={[0,    80, -400]} castShadow={false} />
    </>
  );
}

// ─── Hit event processor ──────────────────────────────────────────────────────
// Processes hit events from the store and calls triggerBurst imperatively.
// Runs in useFrame to avoid re-renders.
function HitEventProcessor() {
  const hitsRef = useRef<BumperHitEvent[]>([]);

  useFrame(() => {
    const hits = useActivityStore.getState().events?.hits;
    if (!hits) return;

    // Only process new hits (appended to the array by the store).
    const len = hits.length;
    if (len <= _hitCheckScratch.lastHitCount) return;

    for (let i = _hitCheckScratch.lastHitCount; i < len; i++) {
      const h = hits[i];
      triggerBurst(h.x, 6, h.y, '#ff6600');
    }
    _hitCheckScratch.lastHitCount = len;
  });

  return null;
}

// ─── Scene contents (shared between ortho + perspective canvas) ───────────────

interface SceneContentsProps {
  entities: Map<string, BumperShellEntity>;
  pickups: Map<string, BumperPickup>;
  selfAvatarId: string | null;
  spectatorCamMode?: SpectatorCamMode;
  spectatorTargetPetId?: string | null;
}

function SceneContents({
  entities,
  pickups,
  selfAvatarId,
  spectatorCamMode,
  spectatorTargetPetId,
}: SceneContentsProps) {
  return (
    <>
      {/* Camera — ortho for active play, perspective for spectators. */}
      {spectatorCamMode ? (
        <SpectatorCamera
          mode={spectatorCamMode}
          targetPetId={spectatorTargetPetId ?? null}
          entities={entities}
        />
      ) : (
        <BumperOrthoCamera />
      )}

      {/* Atmosphere */}
      <fog args={[FOG_COLOR, FOG_NEAR, FOG_FAR]} />
      <color attach="background" args={[FOG_COLOR]} />

      {/* Lighting — 1 shadow map at 512×512, 3 point lights (no shadows) */}
      <BumperLight />

      {/* Arena geometry — 4 draw calls */}
      <BumperShellsArena />

      {/* Central hazard — 2 draw calls */}
      <BumperShellsHazard enabled={HAZARD_ENABLED} />

      {/* Player shells — up to 8 draw calls */}
      <Suspense fallback={null}>
        {Array.from(entities.values()).map((entity) => (
          <BumperShellsPlayer
            key={entity.avatarId}
            entity={entity}
            isSelf={entity.avatarId === selfAvatarId}
          />
        ))}
      </Suspense>

      {/* Power-up pickups — up to 6 draw calls */}
      <BumperShellsPickups pickups={pickups} />

      {/* Particle burst pool — 4 Points objects, max 16 pts each */}
      <BumperShellsParticles />

      {/* Hit event → burst trigger (no React re-renders) */}
      <HitEventProcessor />

      {/* Pipeline pre-compilation — must be LAST inside SceneContents */}
      <PreCompilePipelines />
    </>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export interface BumperShellsSceneProps {
  /** Room ID — used as Canvas key to force context recreation between rooms. */
  roomId: string;
  /** The current user's avatar ID, used for self-highlighting. */
  selfAvatarId?: string | null;
  /**
   * Spectator camera mode. When undefined, the default static orthographic
   * camera is used (active player view — Iris Xe budget: one fixed frustum).
   *
   * When set, a single PerspectiveCamera replaces the ortho camera:
   *   'follow' — lerps toward spectatorTargetPetId (or first alive entity).
   *   'free'   — OrbitControls, distance bounded 600–1500wu.
   *   'action' — auto-follows arena center entity, retargets every 3s.
   *
   * ONE camera per client regardless of mode — no extra shadow frusta.
   */
  spectatorCamMode?: SpectatorCamMode;
  /**
   * AvatarId to follow in 'follow' mode. Ignored for 'free' and 'action'.
   * Falls back to first alive entity if null or the entity is eliminated.
   */
  spectatorTargetPetId?: string | null;
}

export default function BumperShellsScene({
  roomId,
  selfAvatarId = null,
  spectatorCamMode,
  spectatorTargetPetId,
}: BumperShellsSceneProps) {
  // Subscribe to activity store — high-frequency path, keep subscriptions narrow.
  const entities = useActivityStore((s) => s.entities as Map<string, BumperShellEntity>);
  const pickups  = useActivityStore((s) => s.pickups  as Map<string, BumperPickup>);

  // Spectator camera: use a PerspectiveCamera canvas; active play uses OrthographicCamera.
  // The canvas `orthographic` prop is static — we mount two different canvas configs.
  // The `key` on Canvas forces context recreation when switching modes or rooms.
  const canvasKey = `${roomId}-${spectatorCamMode ?? 'ortho'}`;

  if (spectatorCamMode) {
    // Spectator canvas: PerspectiveCamera (R3F default when orthographic is omitted).
    return (
      <Canvas
        key={canvasKey}
        camera={{
          fov: SPECTATOR_FOV,
          near: CAMERA_NEAR,
          far: CAMERA_FAR,
          position: [0, 900, 600],
        }}
        shadows
        gl={{ antialias: false }} // Disable MSAA for Iris Xe perf budget
        style={{ width: '100%', height: '100%' }}
        dpr={[1, 1.5]} // Clamp pixel ratio for Iris Xe
      >
        <SceneContents
          entities={entities ?? new Map()}
          pickups={pickups ?? new Map()}
          selfAvatarId={selfAvatarId}
          spectatorCamMode={spectatorCamMode}
          spectatorTargetPetId={spectatorTargetPetId}
        />
      </Canvas>
    );
  }

  // Active-play canvas: OrthographicCamera (static, Iris Xe budget — one fixed frustum).
  return (
    <Canvas
      key={canvasKey}
      camera={
        {
          // R3F will create an OrthographicCamera when these are passed:
          // (orthographic=true is not a valid R3F prop — we configure it in BumperOrthoCamera)
          // Use PerspectiveCamera as default; BumperOrthoCamera overrides projection.
          near: CAMERA_NEAR,
          far: CAMERA_FAR,
        } as any
      }
      orthographic
      shadows
      gl={{ antialias: false }} // Disable MSAA for Iris Xe perf budget
      style={{ width: '100%', height: '100%' }}
      dpr={[1, 1.5]} // Clamp pixel ratio for Iris Xe
    >
      <SceneContents
        entities={entities ?? new Map()}
        pickups={pickups ?? new Map()}
        selfAvatarId={selfAvatarId}
      />
    </Canvas>
  );
}
