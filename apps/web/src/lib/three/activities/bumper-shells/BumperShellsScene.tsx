'use client';

/**
 * BumperShellsScene.tsx
 *
 * PERF FIX 2026-04-24: Killed GPU context loss on Iris Xe.
 *
 * Root cause: `import * as THREE from 'three/webgpu'` in all bumper-shells files
 * while the Canvas uses R3F's default WebGLRenderer (plain 'three'). Two THREE
 * instances = NodeMaterial.vertexShader=undefined crash every frame.
 * See gotchas/two-three-instances-nodemat-webgl-crash.md
 *
 * Also removed: PCF shadow map (4ms/frame GPU depth-prepass eliminated),
 * all 7 point lights (= 7× lighting shader passes per fragment eliminated),
 * starfield reduced 300→60 pts, SHELL_SCALE 40→22, camera pulled back for
 * full-arena readability.
 *
 * Iris Xe invariants:
 *   - import from 'three' (plain), NOT 'three/webgpu' — R3F Canvas uses WebGLRenderer.
 *   - No drei Text/Billboard (hard GPU crash).
 *   - No InstancedMesh + ShaderMaterial (silent WebGPU blank canvas).
 *   - No per-frame allocations (module-scope scratch vectors only).
 *   - 0 shadow maps, 0 post-processing passes.
 *   - ONE perspective camera per client regardless of mode.
 *
 * Performance budget: ≤30 draw calls / ≤60k tris.
 */

import { Suspense, useEffect, useRef, useCallback, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { playActivitySound } from '@/lib/activity-audio';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';

import BumperShellsArena    from './BumperShellsArena';
import BumperShellsHazard   from './BumperShellsHazard';
import BumperShellsPlayer   from './BumperShellsPlayer';
import { PLAYER_GROUP_MAP } from './BumperShellsPlayer';
import BumperShellsPickups  from './BumperShellsPickups';
import BumperShellsParticles, { triggerBurst } from './BumperShellsParticles';
import {
  FOG_COLOR,
  FOG_NEAR,
  FOG_FAR,
  CAMERA_FOV,
  CAMERA_NEAR,
  CAMERA_FAR,
  SPECTATOR_FOV,
  CHASE_CAM_DISTANCE,
  CHASE_CAM_HEIGHT,
  CHASE_CAM_LOOK_AHEAD,
  CHASE_CAM_LERP_ALPHA,
  HEMI_SKY_COLOR,
  HEMI_GROUND_COLOR,
  HEMI_INTENSITY,
  DIR_COLOR,
  DIR_INTENSITY,
  DIR_POSITION,
  SHAKE_MAX_DISPLACEMENT,
  SHAKE_DECAY,
  SHAKE_FREQ,
  FLASH_DURATION_S,
  HAZARD_ENABLED,
  ARENA_HEIGHT,
} from './bumper-shells-config';
import type { BumperShellEntity, BumperPickup } from './bumper-shells-types';

// ─── Activity store import ────────────────────────────────────────────────────
// NOTE: This file does not exist yet — general-purpose will land it.
// The import is stubbed so the module compiles (the store returns empty defaults).
// Expected type: see ActivityStateForScene in bumper-shells-types.ts.
import { useActivityStore } from '@/stores/activity';

// ─── Spectator camera mode type ───────────────────────────────────────────────

export type SpectatorCamMode = 'follow' | 'free' | 'action';

// ─── Module-scope scratch — NO per-frame allocations ─────────────────────────
const _hitCheckScratch = { lastHitCount: 0 };
const _elimCheckScratch = { lastElimCount: 0 };

// Chase camera scratch vectors — NO per-frame allocations
const _chaseDesiredPos = new THREE.Vector3();
const _chaseLookAt     = new THREE.Vector3();
const _chaseEntityPos  = new THREE.Vector3();
const _chaseShake      = new THREE.Vector3();

// Spectator camera scratch vectors
const _camTargetPos  = new THREE.Vector3();
const _camDesiredPos = new THREE.Vector3();
const _camLookAt     = new THREE.Vector3();
const _entityPos     = new THREE.Vector3();

// Spectator 'follow' offset (high up + back in world space)
const FOLLOW_OFFSET = new THREE.Vector3(0, 400, 350);

// 'action' mode re-sample interval
const ACTION_RETARGET_INTERVAL = 3.0;

// Lerp alpha for spectator camera smoothing
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

// ─── Chase Camera Controller ──────────────────────────────────────────────────
// Follows selfAvatarId with a CHASE_CAM_DISTANCE arm and CHASE_CAM_HEIGHT elevation.
// Camera lerps position + lookAt with CHASE_CAM_LERP_ALPHA exp decay.
// Camera shake applied on top of the lerped position via _chaseShake.

interface ChaseCameraProps {
  selfAvatarId: string | null;
  entities: Map<string, BumperShellEntity>;
  shakeRef: React.MutableRefObject<number>; // current shake magnitude
}

function ChaseCameraController({ selfAvatarId, entities, shakeRef }: ChaseCameraProps) {
  const { camera } = useThree();
  const cameraYawRef = useRef(0); // persists last known yaw for dead-reckoning

  useEffect(() => {
    const p = camera as THREE.PerspectiveCamera;
    p.fov  = CAMERA_FOV;
    p.near = CAMERA_NEAR;
    p.far  = CAMERA_FAR;
    p.updateProjectionMatrix();
    // Initial position — behind where a player would start
    p.position.set(0, CHASE_CAM_HEIGHT, CHASE_CAM_DISTANCE);
    p.lookAt(0, ARENA_HEIGHT / 2, 0);
  }, [camera]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);

    // Find self entity
    const self = selfAvatarId ? entities.get(selfAvatarId) : null;

    if (!self || !self.alive) {
      // No target — orbit to a birds-eye view above center
      _chaseDesiredPos.set(0, CHASE_CAM_HEIGHT * 1.5, CHASE_CAM_DISTANCE * 0.5);
      _chaseLookAt.set(0, ARENA_HEIGHT / 2, 0);
    } else {
      _chaseEntityPos.set(self.x, ARENA_HEIGHT / 2, self.y);

      // Derive camera yaw from velocity when moving, dead-reckon otherwise
      const speed = Math.sqrt(self.vx * self.vx + self.vy * self.vy);
      if (speed > 20) {
        cameraYawRef.current = Math.atan2(self.vx, self.vy);
      }
      const yaw = cameraYawRef.current;

      // Camera arm: CHASE_CAM_DISTANCE behind player in velocity direction
      const sinY = Math.sin(yaw);
      const cosY = Math.cos(yaw);
      _chaseDesiredPos.set(
        _chaseEntityPos.x - sinY * CHASE_CAM_DISTANCE,
        CHASE_CAM_HEIGHT,
        _chaseEntityPos.z - cosY * CHASE_CAM_DISTANCE,
      );

      // Look-ahead: aim slightly in front of player
      const lookAheadFrac = Math.min(speed / 200, 1) * CHASE_CAM_LOOK_AHEAD;
      _chaseLookAt.set(
        _chaseEntityPos.x + sinY * lookAheadFrac,
        ARENA_HEIGHT / 2 + 30,
        _chaseEntityPos.z + cosY * lookAheadFrac,
      );
    }

    // Camera shake: attenuate shake ref each frame
    const shakeAmt = shakeRef.current;
    if (shakeAmt > 0.01) {
      shakeRef.current = Math.max(0, shakeAmt - shakeAmt * SHAKE_DECAY * dt);
      const t = performance.now() * SHAKE_FREQ * 0.001;
      _chaseShake.set(
        Math.sin(t * 1.3) * shakeAmt,
        Math.cos(t * 0.9) * shakeAmt * 0.5,
        Math.sin(t * 1.7) * shakeAmt * 0.3,
      );
    } else {
      shakeRef.current = 0;
      _chaseShake.set(0, 0, 0);
    }

    // Exp-decay lerp for position + lookAt
    const alpha = 1.0 - Math.exp(-CHASE_CAM_LERP_ALPHA * dt);
    camera.position.lerp(_chaseDesiredPos, alpha);
    camera.position.add(_chaseShake);
    camera.lookAt(_chaseLookAt);
    camera.updateProjectionMatrix();
  });

  return null;
}

// ─── Spectator Camera Controller ──────────────────────────────────────────────
// Manages a single PerspectiveCamera for all 3 spectator modes.
// Replaces the static ortho camera when spectatorCamMode is set.
// Iris Xe rule: ONE camera per client — no extra shadow frusta.

interface SpectatorCameraProps {
  mode: SpectatorCamMode;
  /** avatarId of the entity to follow in 'follow' mode. null = auto-pick closest alive. */
  targetAvatarId: string | null;
  /** Live entity map from activity store — read in useFrame (no re-render trigger). */
  entities: Map<string, BumperShellEntity>;
}

function SpectatorCamera({ mode, targetAvatarId, entities }: SpectatorCameraProps) {
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
      if (targetAvatarId) {
        targetEntity = entities.get(targetAvatarId) ?? null;
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

// ─── Lighting: hemisphere fill + one no-shadow directional ───────────────────
//
// PERF FIX 2026-04-24: No shadow map, no point lights.
// - PCF shadow map cost on Iris Xe: ~4ms/frame (depth-prepass at 1024×1024).
// - 7 point lights × per-fragment lighting pass = GPU overdraw saturation.
// - Result: WebGL context loss. All removed. Hemisphere+directional is sufficient.
//
// Two lights total: hemisphereLight (no GPU pass, baked into ambient) +
// directionalLight no-shadow (one lighting pass per fragment). Zero extra cost.

function BumperLight() {
  const dirRef = useRef<THREE.DirectionalLight>(null);

  useEffect(() => {
    const d = dirRef.current;
    if (!d) return;
    // Static light — freeze matrix so Three.js never recomputes world transform.
    d.matrixAutoUpdate = false;
    d.updateMatrix();
  }, []);

  return (
    <>
      <hemisphereLight
        args={[HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY]}
      />
      {/*
       * Key directional — no castShadow. Shells still read clearly from this
       * angle with the hemisphere filling their shadow side.
       */}
      <directionalLight
        ref={dirRef}
        color={DIR_COLOR}
        intensity={DIR_INTENSITY}
        position={DIR_POSITION}
        castShadow={false}
      />
    </>
  );
}

// ─── Hit event processor ──────────────────────────────────────────────────────
// Processes hit + elimination events from the store.
// Calls triggerBurst imperatively — no React re-renders.

interface HitEventProcessorProps {
  selfAvatarId: string | null;
  onSelfHit: () => void;
}

function HitEventProcessor({ selfAvatarId, onSelfHit }: HitEventProcessorProps) {
  useFrame(() => {
    const state = useActivityStore.getState();

    // ─ Hits ─
    const hits = state.events?.hits;
    if (hits) {
      const len = hits.length;
      if (len > _hitCheckScratch.lastHitCount) {
        for (let i = _hitCheckScratch.lastHitCount; i < len; i++) {
          const h = hits[i];
          // Particle burst at impact position
          triggerBurst(h.x, ARENA_HEIGHT / 2 + 4, h.y, '#ff8800');

          // BUG FIX (Bug 2): trigger combat animations on involved players.
          // srcAvatarId = higher-velocity body (dealt the hit) → 'attack'
          // dstAvatarId = lower-velocity body (received the hit) → 'hurt'
          // Both fire alongside the squash/stretch VFX (triggerHit stays on
          // the player's own wasHit path; this is purely animator-side).
          if (h.srcAvatarId) {
            const srcGroup = PLAYER_GROUP_MAP.get(h.srcAvatarId);
            srcGroup?.triggerCombatAction?.('attack');
          }
          if (h.dstAvatarId) {
            const dstGroup = PLAYER_GROUP_MAP.get(h.dstAvatarId);
            dstGroup?.triggerCombatAction?.('hurt');
            // Also trigger the squash/stretch VFX on the destination player
            // (previously only self-hit fired this; now all hits do).
            dstGroup?.triggerHit?.();
          }
        }
        _hitCheckScratch.lastHitCount = len;
      }
    }

    // ─ Eliminations ─ play knockout sound + self-hit callback
    const elims = state.events?.eliminations;
    if (elims) {
      const len = elims.length;
      if (len > _elimCheckScratch.lastElimCount) {
        for (let i = _elimCheckScratch.lastElimCount; i < len; i++) {
          const e = elims[i];
          playActivitySound('knockout');
          // Bigger burst for elimination impact
          triggerBurst(
            state.entities?.get(e.avatarId)?.x ?? 0,
            ARENA_HEIGHT / 2 + 4,
            state.entities?.get(e.avatarId)?.y ?? 0,
            '#ff3300',
          );
          if (e.avatarId === selfAvatarId) onSelfHit();

          // BUG FIX (Bug 2+3): trigger death anim on eliminated player.
          // BumperShellsPlayer's useFrame also triggers death anim when it
          // sees entity.alive flip to false — this call handles the case where
          // the elimination event arrives on the same tick as (or before) the
          // entity delta, ensuring the anim fires ASAP.
          const elimGroup = PLAYER_GROUP_MAP.get(e.avatarId);
          elimGroup?.triggerCombatAction?.('death');
        }
        _elimCheckScratch.lastElimCount = len;
      }
    }
  });

  return null;
}

// ─── Scene contents ────────────────────────────────────────────────────────────

interface SceneContentsProps {
  entities: Map<string, BumperShellEntity>;
  pickups: Map<string, BumperPickup>;
  selfAvatarId: string | null;
  spectatorCamMode?: SpectatorCamMode;
  spectatorTargetAvatarId?: string | null;
  shakeRef: React.MutableRefObject<number>;
  onSelfHit: () => void;
}

function SceneContents({
  entities,
  pickups,
  selfAvatarId,
  spectatorCamMode,
  spectatorTargetAvatarId,
  shakeRef,
  onSelfHit,
}: SceneContentsProps) {
  return (
    <>
      {/* Camera — perspective chase for active play, spectator cam when spectating */}
      {spectatorCamMode ? (
        <SpectatorCamera
          mode={spectatorCamMode}
          targetAvatarId={spectatorTargetAvatarId ?? null}
          entities={entities}
        />
      ) : (
        <ChaseCameraController
          selfAvatarId={selfAvatarId}
          entities={entities}
          shakeRef={shakeRef}
        />
      )}

      {/* Atmosphere */}
      <fog args={[FOG_COLOR, FOG_NEAR, FOG_FAR]} />
      <color attach="background" args={[FOG_COLOR]} />

      {/* Lighting — 1 shadow map, hemisphere fill */}
      <BumperLight />

      {/* Arena geometry — 8 draw calls (platform, tile, rim, bumper wall, danger, void, stars, [lights=0]) */}
      <BumperShellsArena />

      {/* Central hazard — 2 draw calls */}
      <BumperShellsHazard enabled={HAZARD_ENABLED} />

      {/* Player shells — up to 8 draw calls (1 per GLB clone) */}
      <Suspense fallback={null}>
        {Array.from(entities.values()).map((entity) => (
          <BumperShellsPlayer
            key={entity.avatarId}
            entity={entity}
            isSelf={entity.avatarId === selfAvatarId}
            onSelfHit={onSelfHit}
            displayName={entity.avatarId.slice(0, 10)}
          />
        ))}
      </Suspense>

      {/* Power-up pickups — up to 6 draw calls */}
      <BumperShellsPickups pickups={pickups} />

      {/* Particle burst pool — 6 Points objects */}
      <BumperShellsParticles />

      {/* Hit + elimination event processor (no React re-renders) */}
      <HitEventProcessor selfAvatarId={selfAvatarId} onSelfHit={onSelfHit} />

      {/* Pipeline pre-compilation — MUST be LAST inside SceneContents */}
      <PreCompilePipelines />
    </>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export interface BumperShellsSceneProps {
  /** Room ID — used as Canvas key to force context recreation between rooms. */
  roomId: string;
  /** The current user's avatar ID, used for chase camera + self-hit flash. */
  selfAvatarId?: string | null;
  /**
   * Spectator camera mode. When undefined, the perspective chase camera follows selfAvatarId.
   *
   * When set, spectator camera is used:
   *   'follow' — lerps toward spectatorTargetAvatarId (or first alive entity).
   *   'free'   — OrbitControls, distance bounded 600–1500wu.
   *   'action' — auto-follows arena center entity, retargets every 3s.
   *
   * ONE PerspectiveCamera per client regardless of mode.
   */
  spectatorCamMode?: SpectatorCamMode;
  /**
   * AvatarId to follow in 'follow' mode. Ignored for 'free' and 'action'.
   * Falls back to first alive entity if null or the entity is eliminated.
   */
  spectatorTargetAvatarId?: string | null;
}

export default function BumperShellsScene({
  roomId,
  selfAvatarId = null,
  spectatorCamMode,
  spectatorTargetAvatarId,
}: BumperShellsSceneProps) {
  const entities = useActivityStore((s) => s.entities as Map<string, BumperShellEntity>);
  const pickups  = useActivityStore((s) => s.pickups  as Map<string, BumperPickup>);

  // Camera shake magnitude (shared between ChaseCameraController and HitEventProcessor)
  // Stored as a mutable ref to avoid React re-renders in the hot useFrame path.
  const shakeRef = useRef(0);

  // Screen flash state — DOM overlay, not Three.js.
  const [flashOpacity, setFlashOpacity] = useState(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSelfHit = useCallback(() => {
    // Trigger camera shake
    shakeRef.current = SHAKE_MAX_DISPLACEMENT;

    // Trigger red screen flash
    setFlashOpacity(0.45);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      setFlashOpacity(0);
    }, FLASH_DURATION_S * 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // ALL canvas instances use PerspectiveCamera — no orthographic in the rebuild.
  // The `key` forces context recreation between rooms and spectator mode changes.
  const canvasKey = `${roomId}-${spectatorCamMode ?? 'chase'}`;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
        key={canvasKey}
        camera={{
          fov: spectatorCamMode ? SPECTATOR_FOV : CAMERA_FOV,
          near: CAMERA_NEAR,
          far: CAMERA_FAR,
          position: [0, CHASE_CAM_HEIGHT, CHASE_CAM_DISTANCE],
        }}
        gl={{ antialias: false }} // Disable MSAA for Iris Xe perf budget; no shadow pipeline
        style={{ width: '100%', height: '100%' }}
        dpr={[1, 1.5]} // Clamp pixel ratio for Iris Xe
      >
        <KTX2LoaderSetup />
        <SceneContents
          entities={entities ?? new Map()}
          pickups={pickups ?? new Map()}
          selfAvatarId={selfAvatarId}
          spectatorCamMode={spectatorCamMode}
          spectatorTargetAvatarId={spectatorTargetAvatarId}
          shakeRef={shakeRef}
          onSelfHit={handleSelfHit}
        />
      </Canvas>

      {/* Screen-edge red flash — DOM overlay, transitions via CSS opacity.
          Appears on self-hit, fades to 0 after FLASH_DURATION_S.
          This is a DOM overlay on top of the canvas, not inside Three.js. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: 'radial-gradient(ellipse at center, transparent 40%, rgba(200,0,0,0.7) 100%)',
          opacity: flashOpacity,
          transition: flashOpacity > 0
            ? 'opacity 0.05s ease-in'
            : `opacity ${FLASH_DURATION_S * 0.8}s ease-out`,
        }}
      />
    </div>
  );
}
