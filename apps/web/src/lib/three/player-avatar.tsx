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
import { jumpState, isEditable } from '@/lib/three/jump-state';
import { useVRM, preloadVRM } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator, preloadMixamoClips } from '@/lib/three/vrm-character-animator';

// ---------------------------------------------------------------------------
// GLB-based player avatar — lobster.glb model = 1-2 draw calls
// Original had 46 meshes built from primitives
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const SPEED = 550;
const BOB_SPEED = 5;
const BOB_AMPLITUDE = 0.3;
// AVATAR_SCALE=40 targets ~45 world-unit height for lobster.glb on the 5120-unit map.
// lobster.glb geometry has bbox max.y = 1.12 native units (verified 2026-04-17 via GLTF
// accessor bounds). AVATAR_SCALE=40 → 40 × 1.12 = 44.8 wu ≈ TARGET_NPC_HEIGHT=45.
// Bug history: AVATAR_SCALE was at 20 (from pass 2 of scale-down 2026-04-16), which was
// calibrated when the lobster GLB had native height ~2.4 units (20 × 2.4 = 48 wu).
// After the GLB was updated the native height became 1.12 units; 20 × 1.12 = 22.4 wu —
// making the player avatar appear ~2× smaller than wandering NPC lobsters (which use
// computeNpcScale → TARGET_NPC_HEIGHT=45 → scale≈40.2 → 45 wu visual height).
// Fix 2026-04-17: AVATAR_SCALE 20→40. ~1:17.8 ratio vs 800-wu building.
// SPEED bumped 320→550 (pass 1 +60% wasn't perceivable at world scale of 5120 wu;
// need ~3-4s to cross visible area ~2000 wu → 2000/550 ≈ 3.6s).
const AVATAR_SCALE = 40;

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

// VRM avatars face -Z natively (VRM 1.0 spec; VRM 0.x normalised to -Z by rotateVRM0).
// For a -Z-forward model: to face direction (vx, vy) in screen space:
//   θ = atan2(vx, -vy)
// Cardinal direction rotations:
//   down  vx=0,  vy=+1 → atan2(0, -1) = PI
//   up    vx=0,  vy=-1 → atan2(0,  1) = 0
//   right vx=+1, vy=0  → atan2(1,  0) = PI/2
//   left  vx=-1, vy=0  → atan2(-1, 0) = -PI/2
const VRM_DIR_ROTATION: Record<string, number> = {
  down: Math.PI, up: 0, right: Math.PI / 2, left: -Math.PI / 2, idle: Math.PI,
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
    // Target guard: don't consume WASD/E/Escape when user is typing in a chat input.
    // Fixes pre-existing bug: typing W/A/S/D in avatar chat moved the avatar.
    // NOTE: keyup intentionally has NO target guard — it must always clear state
    // so keys don't get stranded 'true' when the user taps into an input mid-move.
    if (isEditable(e.target)) return;
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

// Scratch vectors for camera-relative player movement — module-scope, zero GC.
// Mirrors npc-controller.tsx scratch vector pattern.
const _playerCamForward = new THREE.Vector3();
const _playerCamRight = new THREE.Vector3();
const _playerWorldUp = new THREE.Vector3(0, 1, 0);

// Shared raycaster — only hits layer 1 (terrain)
const _petRaycaster = new THREE.Raycaster();
_petRaycaster.layers.set(TERRAIN_LAYER);
const _petRayOrigin = new THREE.Vector3();
const _petRayDir = new THREE.Vector3(0, -1, 0);

// PERF: cache the terrain mesh — see arena-npcs.tsx for the full rationale.
// intersectObjects(scene.children, true) recurses through 4549 objects per call
// when only one mesh has TERRAIN_LAYER. Cache + intersectObject(mesh, false) is
// O(1 mesh) instead of O(scene-graph).
let _cachedPetTerrainMesh: THREE.Object3D | null = null;
function findPetTerrainMesh(scene: THREE.Scene): THREE.Object3D | null {
  if (_cachedPetTerrainMesh && _cachedPetTerrainMesh.parent) return _cachedPetTerrainMesh;
  _cachedPetTerrainMesh = null;
  scene.traverse((obj) => {
    if (_cachedPetTerrainMesh) return;
    if ((obj as THREE.Mesh).isMesh && obj.layers.test(_petRaycaster.layers)) {
      _cachedPetTerrainMesh = obj;
    }
  });
  return _cachedPetTerrainMesh;
}

function getTerrainY(x: number, z: number, scene: THREE.Scene): number {
  const terrain = findPetTerrainMesh(scene);
  if (!terrain) return -2;
  _petRayOrigin.set(x, 200, z);
  _petRaycaster.set(_petRayOrigin, _petRayDir);
  _petRaycaster.layers.set(TERRAIN_LAYER);
  _petRaycaster.far = 400;
  const intersects = _petRaycaster.intersectObject(terrain, false);
  if (intersects.length > 0) return intersects[0].point.y;
  return -2; // fallback — matches sand floor Y position
}

// ---------------------------------------------------------------------------
// VRM player avatar — uses useVRM + VRMCharacterAnimator
// Separated into its own inner component so Suspense handles VRM load
// independently from the GLB path.
// VRM feet are at Y=0 per spec — no pivot offset needed.
// ---------------------------------------------------------------------------

function PlayerPetVRMInner({ reg }: { reg: ModelRegistryEntry }) {
  const groupRef = useRef<THREE.Group>(null);
  const rotRef = useRef(VRM_DIR_ROTATION.idle);
  const terrainYRef = useRef(-2);
  const { scene: threeScene, camera } = useThree();

  // Load VRM (suspends until resolved)
  const vrm = useVRM(reg.path);

  // VRM scene is a single live scene — we apply scale via the group, not the scene directly
  // Note: We do NOT deep-clone VRMs the same way we clone GLBs.
  // VRMUtils does not provide a deepCloneVRM in v3.5.2; instead each useVRM
  // call returns the same cached VRM instance. For player-avatar this is fine
  // since only one player avatar renders at a time. If multiple VRM instances of
  // the same model were needed, a full re-load with a unique path suffix would
  // be required. For now: one cached VRM per path, one player.

  // VRM animator — created once per VRM instance
  const vrmAnimatorRef = useRef<VRMCharacterAnimator | null>(null);

  useEffect(() => {
    if (!vrm) return;
    const animator = new VRMCharacterAnimator(vrm);
    vrmAnimatorRef.current = animator;
    animator.init().catch((err) => {
      console.warn('[PlayerAvatar VRM] animator init failed:', err);
    });
    return () => {
      vrmAnimatorRef.current = null;
      animator.dispose();
    };
  }, [vrm]);

  useFrame((state, delta) => {
    const store = useGameStore.getState();
    if (store.movementFrozen) {
      if (store.controlMode !== 'autonomous') {
        const escNow = keyState.escape;
        if (escNow && !lastEscState) {
          // ESC closes whichever chat is open. Teacher chat wins if both
          // are true (should never happen — openGuideChat guards against it).
          if (store.chatOpen) store.exitBuilding();
          else if (store.guideChatOpen) store.closeGuideChat();
        }
        lastEscState = escNow;
      }
      return;
    }
    lastEscState = keyState.escape;

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
    if (store.controlMode === 'player') {
      // Camera-relative input (mirrors npc-controller.tsx and GLB path below).
      // Old screen-relative revert concern was mobile OrbitControls touch accumulation —
      // does not apply to keyboard arrow-key orbit.
      let inputFwd = 0;
      let inputRight = 0;
      const { joystickVelocity } = store;
      if (joystickVelocity.x !== 0 || joystickVelocity.y !== 0) {
        inputRight = joystickVelocity.x;
        inputFwd = -joystickVelocity.y;
      } else {
        if (keyState.w) inputFwd += 1;
        if (keyState.s) inputFwd -= 1;
        if (keyState.a) inputRight -= 1;
        if (keyState.d) inputRight += 1;
      }
      if (inputFwd !== 0 || inputRight !== 0) {
        camera.getWorldDirection(_playerCamForward);
        _playerCamForward.y = 0; // WASD is always flat camera-relative XZ — never couples to camera pitch
        const fwdLen = _playerCamForward.length();
        if (fwdLen > 0.001) {
          _playerCamForward.divideScalar(fwdLen);
          _playerCamRight.crossVectors(_playerCamForward, _playerWorldUp).normalize();

          const worldVx = _playerCamForward.x * inputFwd + _playerCamRight.x * inputRight;
          const worldVz = _playerCamForward.z * inputFwd + _playerCamRight.z * inputRight;
          vx = worldVx;
          vy = worldVz;
        }
      }

      // Vertical swim: arrow up/down only, gated on airborne.
      // Decoupled from camera pitch — mouse orbit never causes altitude drift.
      // Arrow keys continue to rotate the camera via ArrowKeyRotationController;
      // they ALSO drive altitude here when the avatar is airborne.
      const airborne =
        jumpState.phase !== 'grounded' || jumpState.playerAltitude > 0;
      if (airborne) {
        let verticalInput = 0;
        if (keyState.arrowup) verticalInput += 1;
        if (keyState.arrowdown) verticalInput -= 1;
        if (verticalInput !== 0) {
          jumpState.playerAltitude = Math.max(
            0,
            jumpState.playerAltitude + verticalInput * SPEED * delta
          );
        }
      }
    }

    const hasInput = vx !== 0 || vy !== 0;
    if (hasInput && store.clickPath) store.clearClickPath();

    if (!hasInput && store.clickPath && store.clickPath.length > 0) {
      const waypoint = store.clickPath[store.clickPathIndex];
      if (waypoint) {
        const dx = waypoint.x - store.avatarPosition.x;
        const dy = waypoint.y - store.avatarPosition.y;
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
      // VRM faces -Z: atan2(vx, -vy) gives correct facing for screen-relative input
      continuousRot = Math.atan2(vx, -vy);
    }
    store.setMovementDirection(dir as any);

    if (vx !== 0 || vy !== 0) {
      let newX = store.avatarPosition.x + vx * SPEED * delta;
      let newY = store.avatarPosition.y + vy * SPEED * delta;
      newX = Math.max(16, Math.min(MAP_WIDTH - 16, newX));
      newY = Math.max(16, Math.min(MAP_HEIGHT - 16, newY));
      store.setPetPosition(newX, newY);
    }

    {
      const wx = store.avatarPosition.x - HALF_W;
      const wz = store.avatarPosition.y - HALF_H;
      const nearest = findNearestCharacter(wx, wz);
      const nearId = nearest ? nearest.buildingId : null;
      const nearName = nearest ? nearest.characterName : null;
      if (nearId !== store.nearLocation) store.setNearLocation(nearId);
      if (nearName !== store.nearCharacter) store.setNearCharacter(nearName);
    }

    const group = groupRef.current;
    if (!group) return;
    const [wx, , wz] = mapToWorld(store.avatarPosition.x, store.avatarPosition.y);
    group.position.x = wx;
    group.position.z = wz;

    const isMoving = dir !== 'idle';
    const elapsed = state.clock.elapsedTime;
    const frame = Math.floor(elapsed * 60);
    if (frame % 3 === 0) {
      const ty = getTerrainY(group.position.x, group.position.z, threeScene);
      terrainYRef.current += (ty - terrainYRef.current) * 0.3;
    }
    // VRM feet at Y=0 per spec — no pivot offset, no bob (humanoid avatar).
    // playerAltitude stacks on top of heightOffset for explicit arrow-key 3D swim.
    const airborne = jumpState.phase !== 'grounded' && jumpState.phase !== 'charging'
                  || jumpState.playerAltitude > 0;
    const bob = airborne ? 0 : (isMoving ? 0 : Math.sin(elapsed * 2) * 0.08);
    group.position.y = terrainYRef.current + bob
                     + jumpState.heightOffset + jumpState.playerAltitude;

    // Rotation: VRM faces -Z, use atan2(vx, -vy)
    if (continuousRot !== null) {
      let rotDiff = continuousRot - rotRef.current;
      while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
      while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
      rotRef.current += rotDiff * 0.15;
    }
    group.rotation.y = rotRef.current;

    const dt = Math.min(delta, 0.1);
    vrmAnimatorRef.current?.update(dt, isMoving);
  });

  return (
    <group ref={groupRef}>
      <primitive
        object={vrm.scene}
        scale={[reg.scale, reg.scale, reg.scale]}
      />
    </group>
  );
}

function PlayerPetGLBInner() {
  const groupRef = useRef<THREE.Group>(null);
  const animGroupRef = useRef<THREE.Group>(null);
  const rotRef = useRef(0);
  const terrainYRef = useRef(-2); // -2 matches sand floor Y so avatar spawns flush with terrain
  const { scene: threeScene, camera } = useThree();

  attachKeyListeners();

  // Phase 2: resolve which GLB to load from the model registry.
  // petModelKey is set by game/page.tsx via setPetAppearance when the avatar
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
    // SkinnedMesh bounding spheres come from bind pose (T-pose); animated geometry
    // extends past them, causing the player avatar to disappear when camera is close/angled.
    // Must be applied at every clone site — not just arena-npcs.tsx.
    c.traverse((obj) => { obj.frustumCulled = false; });
    const avatarColor = useGameStore.getState().avatarColor;
    const tint = new THREE.Color(COLOR_TINTS[avatarColor] ?? 0xffffff);

    // Resolve final scale (same logic as the primitive scale prop below).
    // Needed to convert localMinY (at scale=1) into world-space correction.
    const finalScale = !useNewAnimSystem ? AVATAR_SCALE : reg.scale;

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
        if (escNow && !lastEscState) {
          // ESC closes whichever chat is open (teacher > guide fallback).
          if (store.chatOpen) store.exitBuilding();
          else if (store.guideChatOpen) store.closeGuideChat();
        }
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
    // Only 'player' mode allows direct WASD/joystick avatar movement.
    // explore = spectator (camera-only), npc = NpcController drives possessed NPC,
    // autonomous = autonomy store drives via clickPath.
    if (store.controlMode === 'player') {
      // Camera-relative input: WASD maps to forward/strafe in camera space so the
      // avatar moves in the direction the camera is facing. This mirrors
      // npc-controller.tsx camera-relative pattern — same scratch vectors, same
      // camera.getWorldDirection() projection onto the XZ plane.
      //
      // The old screen-relative comment ("camera-relative was tried and reverted")
      // referred to mobile OrbitControls TOUCH orbit accumulating ~180° over 10s and
      // inverting direction (see gotchas/camera-relative-movement-breaks-on-mobile.md).
      // That concern does NOT apply to keyboard arrow-key orbit — arrow keys rotate
      // intentionally and users expect WASD to track the new camera orientation.
      let inputFwd = 0;
      let inputRight = 0;
      const { joystickVelocity } = store;
      if (joystickVelocity.x !== 0 || joystickVelocity.y !== 0) {
        inputRight = joystickVelocity.x;
        inputFwd = -joystickVelocity.y; // joystick up (y<0) = camera forward
      } else {
        if (keyState.w) inputFwd += 1;
        if (keyState.s) inputFwd -= 1;
        if (keyState.a) inputRight -= 1;
        if (keyState.d) inputRight += 1;
      }

      if (inputFwd !== 0 || inputRight !== 0) {
        camera.getWorldDirection(_playerCamForward);
        _playerCamForward.y = 0; // WASD is always flat camera-relative XZ — never couples to camera pitch
        const fwdLen = _playerCamForward.length();
        if (fwdLen > 0.001) {
          _playerCamForward.divideScalar(fwdLen);
          // Strafe right stays horizontal: crossVectors(forward_xz, worldUp) has y≈0 by property.
          _playerCamRight.crossVectors(_playerCamForward, _playerWorldUp).normalize();

          const worldVx = _playerCamForward.x * inputFwd + _playerCamRight.x * inputRight;
          const worldVz = _playerCamForward.z * inputFwd + _playerCamRight.z * inputRight;
          vx = worldVx;
          vy = worldVz;
        }
      }

      // Vertical swim: arrow up/down only, gated on airborne.
      // Decoupled from camera pitch — mouse orbit never causes altitude drift.
      // Arrow keys continue to rotate the camera via ArrowKeyRotationController;
      // they ALSO drive altitude here when the avatar is airborne.
      const airborne =
        jumpState.phase !== 'grounded' || jumpState.playerAltitude > 0;
      if (airborne) {
        let verticalInput = 0;
        if (keyState.arrowup) verticalInput += 1;
        if (keyState.arrowdown) verticalInput -= 1;
        if (verticalInput !== 0) {
          jumpState.playerAltitude = Math.max(
            0,
            jumpState.playerAltitude + verticalInput * SPEED * delta
          );
        }
      }
    }

    const hasInput = vx !== 0 || vy !== 0;
    if (hasInput && store.clickPath) store.clearClickPath();

    if (!hasInput && store.clickPath && store.clickPath.length > 0) {
      const waypoint = store.clickPath[store.clickPathIndex];
      if (waypoint) {
        const dx = waypoint.x - store.avatarPosition.x;
        const dy = waypoint.y - store.avatarPosition.y;
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
      let newX = store.avatarPosition.x + vx * SPEED * delta;
      let newY = store.avatarPosition.y + vy * SPEED * delta;
      newX = Math.max(16, Math.min(MAP_WIDTH - 16, newX));
      newY = Math.max(16, Math.min(MAP_HEIGHT - 16, newY));
      store.setPetPosition(newX, newY);
    }

    // Character proximity check — replaces building-zone area check.
    // Runs every frame so nearLocation / nearCharacter stay accurate even when
    // the avatar stops or is repositioned externally (clickPath, setPetPosition).
    // findNearestCharacter takes world-space primitives — zero allocation.
    {
      const wx = store.avatarPosition.x - HALF_W;
      const wz = store.avatarPosition.y - HALF_H;
      const nearest = findNearestCharacter(wx, wz);
      const nearId = nearest ? nearest.buildingId : null;
      const nearName = nearest ? nearest.characterName : null;
      if (nearId !== store.nearLocation) store.setNearLocation(nearId);
      if (nearName !== store.nearCharacter) store.setNearCharacter(nearName);
    }

    const group = groupRef.current;
    if (!group) return;
    const [wx, , wz] = mapToWorld(store.avatarPosition.x, store.avatarPosition.y);
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
    // Suppress ambient bob when airborne — it looks wrong to bob while jumping.
    // resetJump() guarantees heightOffset=0 and playerAltitude=0 outside player/npc modes.
    // 'charging' keeps the avatar on the ground (heightOffset=0), so it's not airborne.
    // playerAltitude > 0 means the avatar is swimming above the ocean floor — also airborne.
    const airborne = jumpState.phase !== 'grounded' && jumpState.phase !== 'charging'
                  || jumpState.playerAltitude > 0;
    const finalBob = airborne
      ? 0
      : (isMoving ? Math.abs(Math.sin(elapsed * BOB_SPEED)) * BOB_AMPLITUDE : Math.sin(elapsed * 2) * 0.15);
    // Subtract pivotOffsetY to ground the avatar regardless of GLB pivot placement.
    // pivotOffsetY = localMinY * finalScale (world units).
    // If pivot is above feet (localMinY < 0), pivotOffsetY is negative —
    // subtracting a negative raises the model so feet align with terrainY.
    // jumpState.playerAltitude stacks on top of heightOffset for full 3D swim.
    group.position.y = terrainYRef.current + 2 + (airborne ? 0 : finalBob)
                     + jumpState.heightOffset + jumpState.playerAltitude - pivotOffsetY;

    // Idle rotation freeze: don't snap back to +Z when movement stops — preserve last moved direction so the avatar doesn't twist back after every WASD release.
    // When idle (no movement input), continuousRot is null — skip the lerp entirely
    // and leave rotRef.current unchanged.  This mirrors how npc-controller.tsx
    // preserves facingAngle on idle via moveNpc(..., npc.facingAngle) at line ~148.
    if (continuousRot !== null) {
      // Shortest-path lerp — prevents spinning the long way when crossing ±PI boundary
      let rotDiff = continuousRot - rotRef.current;
      while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
      while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
      rotRef.current += rotDiff * 0.15;
    }
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
        {/* Phase 2: lobster/crayfish use AVATAR_SCALE (40) for the slightly-larger
            player-avatar appearance. All other models use their registry scale. */}
        <primitive
          object={cloned}
          scale={!useNewAnimSystem ? AVATAR_SCALE : reg.scale}
        />
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Route to the correct inner component based on avatar_type
// ---------------------------------------------------------------------------

function PlayerPetRouter() {
  attachKeyListeners();

  const petModelKey = useGameStore((s) => s.petModelKey);
  const reg: ModelRegistryEntry =
    MODEL_REGISTRY[petModelKey as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY.lobster;

  if (reg.avatar_type === 'vrm') {
    return (
      <Suspense fallback={null}>
        <PlayerPetVRMInner reg={reg} />
      </Suspense>
    );
  }

  return <PlayerPetGLBInner />;
}

export default function PlayerAvatar() {
  // Preload VRM assets and Mixamo anim clips for fast switch if user picks a Milady avatar
  useEffect(() => {
    preloadMixamoClips();
    // Preload all 8 VRM paths (non-blocking — errors swallowed in preloadVRM)
    for (let i = 1; i <= 8; i++) {
      preloadVRM(`/avatars/milady-official-${i}.vrm`);
    }
  }, []);

  return (
    <Suspense fallback={null}>
      <PlayerPetRouter />
    </Suspense>
  );
}
