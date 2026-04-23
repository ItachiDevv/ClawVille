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
 *   - Static OrthographicCamera (top-down with slight isometric tilt).
 *     Camera never moves after mount — matrixAutoUpdate=false equivalent.
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
 *
 * Performance budget: ≤60 draw calls / ≤180k tris.
 *
 * Props accepted by parent route:
 *   <BumperShellsScene roomId={roomId} selfPetId={selfPetId} />
 */

import { Suspense, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
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

// ─── Module-scope scratch ─────────────────────────────────────────────────────
const _hitCheckScratch = { lastHitCount: 0 };

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

// ─── Static Camera ────────────────────────────────────────────────────────────
// Orthographic with slight isometric tilt per 3d-spec §1.5.
// Camera never moves after mount.
function BumperCamera() {
  const { camera, size } = useThree();

  useEffect(() => {
    const ortho = camera as THREE.OrthographicCamera;
    // Set frustum based on config.
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

// ─── Scene contents ───────────────────────────────────────────────────────────
// Separated so Canvas props (camera, gl) are accessible via useThree.

interface SceneContentsProps {
  entities: Map<string, BumperShellEntity>;
  pickups: Map<string, BumperPickup>;
  selfPetId: string | null;
}

function SceneContents({ entities, pickups, selfPetId }: SceneContentsProps) {
  return (
    <>
      {/* Camera */}
      <BumperCamera />

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
            key={entity.petId}
            entity={entity}
            isSelf={entity.petId === selfPetId}
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
  /** The current user's pet ID, used for self-highlighting. */
  selfPetId?: string | null;
}

export default function BumperShellsScene({
  roomId,
  selfPetId = null,
}: BumperShellsSceneProps) {
  // Subscribe to activity store — high-frequency path, keep subscriptions narrow.
  const entities = useActivityStore((s) => s.entities as Map<string, BumperShellEntity>);
  const pickups  = useActivityStore((s) => s.pickups  as Map<string, BumperPickup>);

  return (
    <Canvas
      key={roomId}
      camera={
        {
          // R3F will create an OrthographicCamera when these are passed:
          // (orthographic=true is not a valid R3F prop — we configure it in BumperCamera)
          // Use PerspectiveCamera as default; BumperCamera overrides projection.
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
        selfPetId={selfPetId}
      />
    </Canvas>
  );
}
