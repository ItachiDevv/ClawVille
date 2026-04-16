'use client';

import { useRef, useMemo, useEffect, Suspense } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useGameStore } from '@/stores/game';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
} from '@/lib/pixi/tilemap-data';
import { applyWalkAnimation, applyIdleAnimation } from '@/lib/three/procedural-animation';
import { LobsterAnimator } from '@/lib/three/lobster-animations';
import { discoverLobsterParts } from '@/lib/three/lobster-parts';
import {
  MODEL_REGISTRY,
  type ModelRegistryEntry,
} from '@/lib/three/agent-model-registry';
import {
  createCharacterAnimator,
  applyColorTint,
  type CharacterAnimator,
} from '@/lib/three/character-animations';

// ---------------------------------------------------------------------------
// GLB-based player pet — lobster.glb model = 1-2 draw calls
// Original had 46 meshes built from primitives
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const SPEED = 200;
const BOB_SPEED = 5;
const BOB_AMPLITUDE = 0.3;
const PET_SCALE = 16;

const COLOR_TINTS: Record<string, number> = {
  blue: 0x42a5f5, red: 0xef5350, green: 0x66bb6a, yellow: 0xffee58,
  purple: 0xab47bc, orange: 0xffa726, pink: 0xf48fb1, white: 0xeeeeee,
  black: 0x424242, brown: 0x8d6e63,
};

// Lobster GLB faces -Z natively (rotation.y=0 → head toward -Z).
// To face world direction (worldVx, worldVz): θ = atan2(-worldVx, -worldVz)
// DIR_ROTATION for cardinal directions (screen-relative pixel-space vx/vy):
//   up    vx=0,  vy=-1  → 0          (head faces -Z = screen-up)
//   down  vx=0,  vy=+1  → PI         (rotate 180° to face +Z = screen-down)
//   right vx=+1, vy=0   → -PI/2
//   left  vx=-1, vy=0   → +PI/2
//   idle: PI (faces +Z = toward camera when camera is at default +Z position)
const DIR_ROTATION: Record<string, number> = {
  down: Math.PI, left: Math.PI / 2, up: 0, right: -Math.PI / 2, idle: Math.PI,
};

const pixelZones = buildingZones.map((z) => ({
  id: z.id,
  x: z.x * TILE_SIZE, y: z.y * TILE_SIZE,
  width: z.width * TILE_SIZE, height: z.height * TILE_SIZE,
}));

interface KeyState {
  w: boolean; a: boolean; s: boolean; d: boolean;
  arrowup: boolean; arrowdown: boolean; arrowleft: boolean; arrowright: boolean;
  e: boolean; escape: boolean;
}

const keyState: KeyState = {
  w: false, a: false, s: false, d: false,
  arrowup: false, arrowdown: false, arrowleft: false, arrowright: false,
  e: false, escape: false,
};
let keyListenersAttached = false;
let lastEState = false;
let lastEscState = false;

function attachKeyListeners() {
  if (keyListenersAttached) return;
  keyListenersAttached = true;
  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase() as keyof KeyState;
    if (key in keyState) keyState[key] = true;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase() as keyof KeyState;
    if (key in keyState) keyState[key] = false;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
}

function mapToWorld(px: number, py: number): [number, number, number] {
  return [px - HALF_W, 0, py - HALF_H];
}

// Preload
useGLTF.preload('/models/lobster.glb');

import { TERRAIN_LAYER } from '@/lib/three/arena-terrain';

// Shared raycaster — only hits layer 1 (terrain)
const _petRaycaster = new THREE.Raycaster();
_petRaycaster.layers.set(TERRAIN_LAYER);
const _petRayOrigin = new THREE.Vector3();
const _petRayDir = new THREE.Vector3(0, -1, 0);

function getTerrainY(x: number, z: number, scene: THREE.Scene): number {
  _petRayOrigin.set(x, 200, z);
  _petRaycaster.set(_petRayOrigin, _petRayDir);
  _petRaycaster.layers.set(TERRAIN_LAYER);
  _petRaycaster.far = 400;
  const intersects = _petRaycaster.intersectObjects(scene.children, true);
  if (intersects.length > 0) return intersects[0].point.y;
  return -2; // fallback — matches sand floor Y position
}

function PlayerPetInner() {
  const groupRef = useRef<THREE.Group>(null);
  const animGroupRef = useRef<THREE.Group>(null);
  const rotRef = useRef(0);
  const terrainYRef = useRef(-2); // -2 matches sand floor Y so pet spawns flush with terrain
  const { scene: threeScene } = useThree();

  attachKeyListeners();

  // Phase 2: resolve which GLB to load from the model registry.
  // petModelKey is set by game/page.tsx via setPetAppearance when the pet
  // loads from the API. Falls back to 'lobster' if null / unknown key.
  const petModelKey = useGameStore((s) => s.petModelKey);
  const reg: ModelRegistryEntry =
    MODEL_REGISTRY[petModelKey as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY.lobster;

  const { scene } = useGLTF(reg.path);

  // Whether to use the legacy LobsterAnimator (skeletal bone discovery) or
  // the universal CharacterAnimator. Mirrors the same routing in arena-npcs.tsx
  // and SelectAgentCanvas.tsx.
  const useNewAnimSystem = petModelKey !== 'lobster' && petModelKey !== 'crayfish';

  const { cloned, lobsterAnimator, charAnimator } = useMemo(() => {
    const c = scene.clone(true);
    const petColor = useGameStore.getState().petColor;
    const tint = new THREE.Color(COLOR_TINTS[petColor] ?? 0xffffff);

    if (useNewAnimSystem) {
      // Universal path: shared applyColorTint (stronger tint, matches NPC behaviour)
      applyColorTint(c, tint, 0.6, 0.2);
      const anim = createCharacterAnimator(petModelKey, c);
      return { cloned: c, lobsterAnimator: null as LobsterAnimator | null, charAnimator: anim };
    } else {
      // Legacy lobster/crayfish path: shallow lerp + emissive
      c.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          if (mesh.material) {
            const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
            mat.color.lerp(tint, 0.3);
            mat.emissive = tint;
            mat.emissiveIntensity = 0.1;
            mesh.material = mat;
          }
        }
      });
      const parts = discoverLobsterParts(c);
      const anim = new LobsterAnimator(parts);
      return { cloned: c, lobsterAnimator: anim, charAnimator: null as CharacterAnimator | null };
    }
  }, [scene, petModelKey, useNewAnimSystem]);

  // Dispose cloned materials on unmount (navigation away / hot-reload)
  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if ((mesh as any).isMesh) {
          // Dispose materials only — applyColorTint() in character-animations.ts
          // clones the material per instance, so this clone owns its materials.
          // NEVER dispose geometry: scene.clone(true) shares BufferGeometry with
          // the useGLTF cache (Mesh.copy: this.geometry = source.geometry). If
          // we disposed it, the cache would hand out a disposed buffer to any
          // other consumer of this GLB (e.g. arena-npcs wandering NPCs that
          // load the same path).
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material?.dispose();
        }
      });
    };
  }, [cloned]);

  useFrame((state, delta) => {
    const store = useGameStore.getState();
    if (store.movementFrozen) {
      // In autonomous mode, don't let Escape exit buildings — the autonomy tick handles timing
      if (store.controlMode !== 'autonomous') {
        const escNow = keyState.escape;
        if (escNow && !lastEscState && store.chatOpen) store.exitBuilding();
        lastEscState = escNow;
      }
      return;
    }
    lastEscState = keyState.escape;

    // In autonomous mode, don't let E key enter buildings — the autonomy tick handles navigation
    if (store.controlMode !== 'autonomous') {
      const eNow = keyState.e;
      if (eNow && !lastEState && store.nearLocation) {
        store.enterBuilding(store.nearLocation);
        lastEState = eNow;
        return;
      }
      lastEState = eNow;
    }

    let vx = 0, vy = 0;
    // Only 'player' mode allows direct WASD/joystick pet movement.
    // explore = spectator (camera-only), npc = NpcController drives possessed NPC,
    // autonomous = autonomy store drives via clickPath.
    if (store.controlMode === 'player') {
      // Screen-relative input: joystick and WASD map directly to world-X and world-Z
      // movement in map/pixel space. This is intentionally NOT camera-relative —
      // camera-relative was tried and reverted because touch orbiting via OrbitControls
      // accumulates over ~10 seconds and inverts the camera direction, breaking movement.
      // With screen-relative, joystick direction always matches the map orientation at
      // the default camera angle, which is the dominant use case.
      const { joystickVelocity } = store;
      if (joystickVelocity.x !== 0 || joystickVelocity.y !== 0) {
        vx = joystickVelocity.x;
        vy = joystickVelocity.y;
      } else {
        if (keyState.w) vy = -1;
        if (keyState.s) vy = 1;
        if (keyState.a) vx = -1;
        if (keyState.d) vx = 1;
      }
    }

    const hasInput = vx !== 0 || vy !== 0;
    if (hasInput && store.clickPath) store.clearClickPath();

    if (!hasInput && store.clickPath && store.clickPath.length > 0) {
      const waypoint = store.clickPath[store.clickPathIndex];
      if (waypoint) {
        const dx = waypoint.x - store.petPosition.x;
        const dy = waypoint.y - store.petPosition.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 6) {
          if (store.clickPathIndex >= store.clickPath.length - 1) {
            const target = store.clickPathTarget;
            store.clearClickPath();
            if (target && store.nearLocation === target) { store.enterBuilding(target); return; }
          } else { store.advanceClickPath(); }
        } else { vx = dx / dist; vy = dy / dist; }
      }
    }

    if (vx !== 0 && vy !== 0) {
      const len = Math.sqrt(vx * vx + vy * vy);
      if (len > 1) { vx /= len; vy /= len; }
    }

    let dir = 'idle';
    let continuousRot: number | null = null;
    if (vx !== 0 || vy !== 0) {
      dir = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : (vy > 0 ? 'down' : 'up');
      // Continuous facing: atan2(-vx, -vy) — model faces -Z at rotation 0
      continuousRot = Math.atan2(-vx, -vy);
    }
    store.setMovementDirection(dir as any);

    if (vx !== 0 || vy !== 0) {
      let newX = store.petPosition.x + vx * SPEED * delta;
      let newY = store.petPosition.y + vy * SPEED * delta;
      newX = Math.max(16, Math.min(MAP_WIDTH - 16, newX));
      newY = Math.max(16, Math.min(MAP_HEIGHT - 16, newY));
      store.setPetPosition(newX, newY);
    }

    // Proximity check runs every frame (not just during movement) so
    // nearLocation stays accurate even when the pet stops inside a zone
    // or is repositioned externally (clickPath, setPetPosition).
    {
      const px = store.petPosition.x;
      const py = store.petPosition.y;
      let nearZone: string | null = null;
      for (const zone of pixelZones) {
        if (px >= zone.x && px <= zone.x + zone.width && py >= zone.y && py <= zone.y + zone.height) {
          nearZone = zone.id; break;
        }
      }
      if (nearZone !== store.nearLocation) store.setNearLocation(nearZone);
    }

    const group = groupRef.current;
    if (!group) return;
    const [wx, , wz] = mapToWorld(store.petPosition.x, store.petPosition.y);
    group.position.x = wx;
    group.position.z = wz;

    const isMoving = dir !== 'idle';
    const elapsed = state.clock.elapsedTime;
    // Raycast terrain height (every 3rd frame).
    // Use elapsed * 60 (render-clock frames) instead of Date.now() to avoid a
    // syscall allocation in the hot path.
    const frame = Math.floor(elapsed * 60);
    if (frame % 3 === 0) {
      const ty = getTerrainY(group.position.x, group.position.z, threeScene);
      terrainYRef.current += (ty - terrainYRef.current) * 0.3;
    }
    const bob = isMoving ? Math.abs(Math.sin(elapsed * BOB_SPEED)) * BOB_AMPLITUDE : Math.sin(elapsed * 2) * 0.15;
    group.position.y = terrainYRef.current + 2 + bob;

    const targetRot = continuousRot ?? DIR_ROTATION[dir] ?? 0;
    // Shortest-path lerp — prevents spinning the long way when crossing ±PI boundary
    let rotDiff = targetRot - rotRef.current;
    while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
    while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
    rotRef.current += rotDiff * 0.15;
    group.rotation.y = rotRef.current;

    const dt = Math.min(delta, 0.1);
    const animGroup = animGroupRef.current;

    if (useNewAnimSystem && charAnimator && animGroup) {
      // Universal animator handles both idle and walk in one call
      charAnimator.update(animGroup, elapsed, dt, isMoving);
    } else if (lobsterAnimator && animGroup) {
      // Legacy lobster/crayfish path — skeletal + procedural squash/stretch
      const suggestedAnim = isMoving ? 'walk' : 'idle';
      lobsterAnimator.update(dt, elapsed, suggestedAnim as any, dir);

      const animStateData = {
        group: animGroup,
        isMoving,
        elapsed,
        delta: dt,
        direction: dir,
        seed: 0, // Player always seed 0
      };
      if (isMoving) {
        applyWalkAnimation(animStateData);
      } else {
        applyIdleAnimation(animStateData);
      }
    }
  });

  return (
    <group ref={groupRef}>
      <group ref={animGroupRef}>
        {/* Phase 2: lobster/crayfish use PET_SCALE (16) for the slightly-larger
            player-pet appearance. All other models use their registry scale. */}
        <primitive
          object={cloned}
          scale={!useNewAnimSystem ? PET_SCALE : reg.scale}
        />
      </group>
    </group>
  );
}

export default function PlayerPet() {
  return (
    <Suspense fallback={null}>
      <PlayerPetInner />
    </Suspense>
  );
}
