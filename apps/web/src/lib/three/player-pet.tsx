'use client';

import { useRef, useMemo, useEffect, Suspense } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useGameStore } from '@/stores/game';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
} from '@/lib/pixi/tilemap-data';
import { findNearestCharacter } from '@/lib/three/character-positions';
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
const SPEED = 550;
const BOB_SPEED = 5;
const BOB_AMPLITUDE = 0.3;
// PET_SCALE=20 targets ~48 world-unit height for lobster.glb on the 5120-unit map.
// Pass 1 (2026-04-16): reduced 55→33 (too large at ~78 wu vs 800-wu building, ~1:10 ratio).
// Pass 2 (2026-04-16): reduced 33→20 — user tested pass 1 and lobster still felt too big
// relative to the NPC spawned in NPC mode. Target 1:16–1:20 ratio vs 800-wu building.
// 20 ≈ 36% of original 55. Deliberately slightly larger than TARGET_NPC_HEIGHT=45 so the
// player pet still reads as bigger than wandering NPCs on screen.
// SPEED bumped 320→550 (pass 1 +60% wasn't perceivable at world scale of 5120 wu;
// need ~3-4s to cross visible area ~2000 wu → 2000/550 ≈ 3.6s).
const PET_SCALE = 20;

const COLOR_TINTS: Record<string, number> = {
  blue: 0x42a5f5, red: 0xef5350, green: 0x66bb6a, yellow: 0xffee58,
  purple: 0xab47bc, orange: 0xffa726, pink: 0xf48fb1, white: 0xeeeeee,
  black: 0x424242, brown: 0x8d6e63,
};

// Lobster GLB faces +Z natively (rotation.y=0 → head toward +Z). EMPIRICALLY VERIFIED 2026-04-16 (late PM, clean side-view screenshot).
// Prior session concluded +X — that was WRONG (camera was orbited, misread as side-view).
// To face world direction (worldVx, worldVz): θ = atan2(worldVx, worldVz)  (no negations)
// DIR_ROTATION for cardinal directions (screen-relative pixel-space vx/vy):
//   down  vx=0,  vy=+1 → 0        (+Z = native forward = screen-down)
//   up    vx=0,  vy=-1 → PI       (-Z = screen-up)
//   right vx=+1, vy=0  → PI/2     (+X = screen-right)
//   left  vx=-1, vy=0  → -PI/2    (-X = screen-left)
//   idle: 0 (faces +Z = toward default camera at positive +Z high angle position)
const DIR_ROTATION: Record<string, number> = {
  down: 0, up: Math.PI, right: Math.PI / 2, left: -Math.PI / 2, idle: 0,
};

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

// Scratch objects for computeLocalMinY — module-scope to avoid GC in useMemo.
const _petBbox = new THREE.Box3();
const _petMeshBbox = new THREE.Box3();

/** Measure local-space bbox min.y for non-SkinnedMesh geometry in a cloned GLB scene.
 *  Returns 0 if no geometry found.
 *  See arena-npcs.tsx computeLocalMinY for full rationale. */
function computeLocalMinY(scene: THREE.Object3D): number {
  scene.updateMatrixWorld(true);
  _petBbox.makeEmpty();

  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      _petMeshBbox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _petBbox.union(_petMeshBbox);
    }
  });

  if (_petBbox.isEmpty()) {
    _petBbox.setFromObject(scene);
  }

  return _petBbox.isEmpty() ? 0 : _petBbox.min.y;
}

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

  const { cloned, lobsterAnimator, charAnimator, pivotOffsetY } = useMemo(() => {
    const c = scene.clone(true);
    const petColor = useGameStore.getState().petColor;
    const tint = new THREE.Color(COLOR_TINTS[petColor] ?? 0xffffff);

    // Resolve final scale (same logic as the primitive scale prop below).
    // Needed to convert localMinY (at scale=1) into world-space correction.
    const finalScale = !useNewAnimSystem ? PET_SCALE : reg.scale;

    // Compute per-GLB pivot offset so feet sit on terrain regardless of where
    // the model's pivot is placed. See arena-npcs.tsx for full rationale.
    const localMinY = computeLocalMinY(c);
    const pivotOffset = localMinY * finalScale;

    if (useNewAnimSystem) {
      // Universal path: shared applyColorTint (stronger tint, matches NPC behaviour)
      applyColorTint(c, tint, 0.6, 0.2);
      const anim = createCharacterAnimator(petModelKey, c);
      return { cloned: c, lobsterAnimator: null as LobsterAnimator | null, charAnimator: anim, pivotOffsetY: pivotOffset };
    } else {
      // Legacy lobster/crayfish path: shallow lerp + emissive
      c.traverse((child: THREE.Object3D) => {
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
      return { cloned: c, lobsterAnimator: anim, charAnimator: null as CharacterAnimator | null, pivotOffsetY: pivotOffset };
    }
  }, [scene, petModelKey, useNewAnimSystem, reg.scale]);

  // Dispose cloned materials on unmount (navigation away / hot-reload)
  useEffect(() => {
    return () => {
      cloned.traverse((obj: THREE.Object3D) => {
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
      // Continuous facing: atan2(vx, vy) — model faces +Z at rotation 0 (EMPIRICALLY VERIFIED 2026-04-16 late PM, clean side-view)
      continuousRot = Math.atan2(vx, vy);
    }
    store.setMovementDirection(dir as any);

    if (vx !== 0 || vy !== 0) {
      let newX = store.petPosition.x + vx * SPEED * delta;
      let newY = store.petPosition.y + vy * SPEED * delta;
      newX = Math.max(16, Math.min(MAP_WIDTH - 16, newX));
      newY = Math.max(16, Math.min(MAP_HEIGHT - 16, newY));
      store.setPetPosition(newX, newY);
    }

    // Character proximity check — replaces building-zone area check.
    // Runs every frame so nearLocation / nearCharacter stay accurate even when
    // the pet stops or is repositioned externally (clickPath, setPetPosition).
    // findNearestCharacter takes world-space primitives — zero allocation.
    {
      const wx = store.petPosition.x - HALF_W;
      const wz = store.petPosition.y - HALF_H;
      const nearest = findNearestCharacter(wx, wz);
      const nearId = nearest ? nearest.buildingId : null;
      const nearName = nearest ? nearest.characterName : null;
      if (nearId !== store.nearLocation) store.setNearLocation(nearId);
      if (nearName !== store.nearCharacter) store.setNearCharacter(nearName);
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
    // Subtract pivotOffsetY to ground the pet regardless of GLB pivot placement.
    // pivotOffsetY = localMinY * finalScale (world units).
    // If pivot is above feet (localMinY < 0), pivotOffsetY is negative —
    // subtracting a negative raises the model so feet align with terrainY.
    group.position.y = terrainYRef.current + 2 + bob - pivotOffsetY;

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
        {/* Phase 2: lobster/crayfish use PET_SCALE (20) for the slightly-larger
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
