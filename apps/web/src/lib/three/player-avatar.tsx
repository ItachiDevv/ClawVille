'use client';

import { useRef, useMemo, useEffect, Suspense } from 'react';
import { useThree } from '@react-three/fiber';
import {
  useSceneActive,
  useSceneFrame,
} from '@/components/three/world-stage/use-scene-frame';
import { addStageWindowListener } from '@/components/three/world-stage/stage-store';
import { preloadKTX2Bytes, useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';
import * as THREE from 'three';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
} from '@/lib/pixi/tilemap-data';
import {
  didCrossKelpForestPortal,
  findNearestCharacter,
  isCoveProximate,
  isKelpForestPortalProximate,
} from '@/lib/three/character-positions';
import { NORI_WORLD_X, NORI_WORLD_Z, NORI_TALK_RADIUS_SQ } from '@/lib/three/town-guide';
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
import { jumpState, isEditable, type ChargeMode } from '@/lib/three/jump-state';
import { triggerCoveWalkIn } from './arena-buildings';
import {
  resetKelpForestWalkInLatch,
  triggerKelpForestWalkIn,
} from './kelp-forest-transition';
import { registerInputReset } from '@/lib/three/input-reset';
import { useVRMInstance, disposeVRMInstance, retainVRMInstance, applyFattenedFrustumCulling } from '@/lib/three/vrm-loader';
import {
  VRMCharacterAnimator,
  preloadMixamoClips,
  isEmoteAnimName,
  type AnimName,
} from '@/lib/three/vrm-character-animator';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { getTerrainHeightAt, isTerrainHeightfieldReady } from '@/lib/three/terrain-heightfield';
import { CosmeticLoader } from '@/lib/three/cosmetic-loader';
import { subscribeEmote } from '@/lib/three/emote-bus';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import {
  clampMovement2D,
  ENTITY_HALF_CHIBI,
} from '@/lib/three/collision/world-colliders';

// ---------------------------------------------------------------------------
// GLB-based player avatar — lobster-ktx.glb model = 1-2 draw calls
// Original had 46 meshes built from primitives
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const SPEED = 550;
const BOB_SPEED = 5;
const BOB_AMPLITUDE = 0.3;
// AVATAR_SCALE=40 targets ~45 world-unit height for lobster-ktx.glb on the 5120-unit map.
// lobster-ktx.glb geometry has bbox max.y = 1.12 native units (verified 2026-04-17 via GLTF
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

/**
 * Sprint speed multiplier. Pressed SHIFT (desktop) or joystick deflection
 * past `RUN_JOYSTICK_THRESHOLD` (mobile) promotes the player from walk to
 * run — `effectiveSpeed = isRunning ? SPEED * RUN_SPEED_MULT : SPEED`.
 *
 * 1.5× matches the Mixamo "Running" clip's natural gait speed relative
 * to "Walking"; foot-skating is minimal at this ratio. Crustacean GLB
 * avatars (no run clip) get this same multiplier on BOTH position step
 * and the procedural-animation rate so their walk cycle visibly speeds
 * up to match the faster ground motion.
 */
const RUN_SPEED_MULT = 1.5;

/**
 * Joystick magnitude threshold for the mobile sprint trigger. Push the
 * stick beyond 70 % deflection and the player promotes to run; below
 * that, they walk. Sharp threshold (no hysteresis yet) — acceptable
 * because the joystick visual is far from the center at this point so
 * the snap is intentional.
 */
const RUN_JOYSTICK_THRESHOLD = 0.7;

// Player-controlled VRM sizing is auto-fit via computeVRMAvatarFit() from
// vrm-avatar-sizing.ts — same target height as wandering NPCs so the player
// Hermes / Milady / future humanoid all stand at VRM_AVATAR_TARGET_HEIGHT_WU
// (~179 wu) regardless of native bbox unit convention. Previously a flat
// AVATAR_VRM_SCALE=112 hardcoded Milady's 1.6m bbox, which left Hermes (Mixamo
// cm units) at the wrong on-screen height. Do NOT use reg.scale (=13, picker-only).

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
  /** Either shift key → sprint while held + WASD/joystick gives movement input. */
  shift: boolean;
}

const keyState: KeyState = {
  w: false, a: false, s: false, d: false,
  arrowup: false, arrowdown: false, arrowleft: false, arrowright: false,
  e: false, escape: false, shift: false,
};
let lastEState = false;
let lastEscState = false;

function resetPlayerKeys() {
  (Object.keys(keyState) as Array<keyof KeyState>).forEach((k) => { keyState[k] = false; });
}

function attachKeyListeners(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    // Target guard: don't consume WASD/E/Escape when user is typing in a chat input.
    // Fixes pre-existing bug: typing W/A/S/D in avatar chat moved the avatar.
    // NOTE: keyup intentionally has NO target guard — it must always clear state
    // so keys don't get stranded 'true' when the user taps into an input mid-move.
    if (isEditable(e.target)) return;
    // e.key/e.code can be undefined on synthetic events (Chrome autofill).
    const rawKey = (e.key ?? '').toLowerCase();
    const rawCode = (e.code ?? '').toLowerCase();
    if (rawKey === 'shift' || rawCode === 'shiftleft' || rawCode === 'shiftright') {
      keyState.shift = true;
      return;
    }
    keyState.shift = e.shiftKey;
    const key = rawKey as keyof KeyState;
    if (key in keyState) keyState[key] = true;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const rawKey = (e.key ?? '').toLowerCase();
    const rawCode = (e.code ?? '').toLowerCase();
    if (rawKey === 'shift' || rawCode === 'shiftleft' || rawCode === 'shiftright') {
      keyState.shift = false;
      return;
    }
    keyState.shift = e.shiftKey;
    const key = rawKey as keyof KeyState;
    if (key in keyState) keyState[key] = false;
  };
  const removeKeyDown = addStageWindowListener('keydown', onKeyDown);
  const removeKeyUp = addStageWindowListener('keyup', onKeyUp);
  // Release all held keys on focus loss/regain (browser skips keyup when focus
  // leaves the window). Centralized in input-reset.ts so every input vector
  // shares one listener set — see S7.
  const unregisterReset = registerInputReset(resetPlayerKeys);
  return () => {
    removeKeyDown();
    removeKeyUp();
    unregisterReset();
    resetPlayerKeys();
  };
}

function mapToWorld(px: number, py: number): [number, number, number] {
  return [px - HALF_W, 0, py - HALF_H];
}

// Preload
preloadKTX2Bytes('/models/lobster-ktx.glb?v=2');

// Scratch objects for computeLocalMinY — module-scope to avoid GC in useMemo.
const _avatarBbox = new THREE.Box3();
const _avatarMeshBbox = new THREE.Box3();

/** Measure local-space bbox min.y for non-SkinnedMesh geometry in a cloned GLB scene.
 *  Returns 0 if no geometry found.
 *  See arena-npcs.tsx computeLocalMinY for full rationale. */
function computeLocalMinY(scene: THREE.Object3D): number {
  scene.updateMatrixWorld(true);
  _avatarBbox.makeEmpty();

  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      _avatarMeshBbox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _avatarBbox.union(_avatarMeshBbox);
    }
  });

  if (_avatarBbox.isEmpty()) {
    _avatarBbox.setFromObject(scene);
  }

  return _avatarBbox.isEmpty() ? 0 : _avatarBbox.min.y;
}

// Scratch vectors for camera-relative player movement — module-scope, zero GC.
// Mirrors npc-controller.tsx scratch vector pattern.
const _playerCamForward = new THREE.Vector3();
const _playerCamRight = new THREE.Vector3();
const _playerWorldUp = new THREE.Vector3(0, 1, 0);

// PERF FIX (2026-06-15, prod-trace-confirmed ~57% JS CPU):
// The old raycast (intersectObject(cachedMesh, false)) still ran O(28,800
// triangles) per call. Replaced by O(1) bilinear heightfield lookup.
// The heightfield is built once in createSandGeometry() in arena-terrain.tsx
// from the actual displaced vertex positions — same data the raycast hit.

/** O(1) terrain height lookup — bilinear interpolation into pre-built heightfield.
 *  Falls back to -2 (flat floor) if the heightfield is not yet initialised. */
function getTerrainY(x: number, z: number, _scene: THREE.Scene): number {
  if (!isTerrainHeightfieldReady()) return -2;
  return getTerrainHeightAt(x, z);
}

// ---------------------------------------------------------------------------
// VRM player avatar — uses useVRM + VRMCharacterAnimator
// Separated into its own inner component so Suspense handles VRM load
// independently from the GLB path.
// VRM feet are at Y=0 per spec — no pivot offset needed.
// ---------------------------------------------------------------------------

function PlayerAvatarVRMInner({ reg }: { reg: ModelRegistryEntry }) {
  const groupRef = useRef<THREE.Group>(null);
  const rotRef = useRef(VRM_DIR_ROTATION.idle);
  const kelpPortalPrevXRef = useRef(0);
  const kelpPortalPrevZRef = useRef(0);
  const kelpPortalPrevInitializedRef = useRef(false);
  /**
   * Pitch (X-axis rotation, radians) for the avatar — drives the
   * "swimming upward" tilt while ascending. Lerped each frame toward
   * a per-phase target in useFrame. Order on group.rotation is set to
   * 'YXZ' so this pitch is applied AFTER facing (rotRef → .y) in the
   * avatar's local frame, i.e. tilting "back" always means leaning
   * head-toward-up regardless of which way they're facing.
   */
  const pitchRef = useRef(0);
  const terrainYRef = useRef(-2);
  // walkableYRef: current walkable-surface Y from collision system.
  // Updated each frame from clamped.groundY. When -2, falls back to terrain.
  // Allows stair/ramp zones (e.g. shisha-oasis) to lift the avatar's Y
  // without blocking XZ movement. Lerped via terrainYRef blend coefficient.
  const walkableYRef = useRef(-2);
  const { scene: threeScene, camera } = useThree();

  // Load a fresh VRM instance for the player. Stable instanceId 'player-avatar'
  // since only one player avatar ever exists at a time. Per-instance loading
  // means the player's VRM is fully disjoint from any wandering NPC sharing
  // the same path — no scene reparenting wars (Codex Critical #1).
  const vrm = useVRMInstance(reg.path, 'player-avatar');

  // Auto-fit scale + foot-grounding offset. Recomputed when the VRM swaps
  // (model picker change → new path → new instance → useMemo re-runs).
  // Cm-authored Mixamo VRMs land at the same on-screen height as m-authored
  // Milady VRMs because we measure the native bbox per-VRM.
  const { scale: vrmRenderScale, offsetY: vrmFootOffsetY } = useMemo(
    () => computeVRMAvatarFit(vrm, reg.animatorId),
    [vrm, reg.animatorId],
  );

  // Dispose this player-avatar's instance when the avatar path changes or unmounts.
  useEffect(() => {
    retainVRMInstance(reg.path, 'player-avatar'); // cancel deferred dispose on StrictMode re-setup
    return () => disposeVRMInstance(reg.path, 'player-avatar');
  }, [reg.path]);

  // VRM animator — created once per VRM instance
  const vrmAnimatorRef = useRef<VRMCharacterAnimator | null>(null);
  /**
   * Most recently applied `surfaceClip` for this avatar. The useFrame
   * below computes the desired clip every frame (idle / jump / swim /
   * fly) from jumpState.phase + airborne; we only call
   * animator.setSurfaceClip when the desired value CHANGES so the lazy
   * GLB load + crossfade only fire on state transitions, not 60 ×/s.
   * Defaults to 'idle' — the surfaceClip the animator initialises to.
   */
  const lastSurfaceClipRef = useRef<AnimName>('idle');

  /**
   * Tracks whether we were in 'charging' last frame — used to detect the
   * rising edge of charging so chargeMode is set exactly once per charge press
   * (at the frame charging begins, when isRunning reflects the real speed class).
   */
  const wasChargingRef = useRef<boolean>(false);

  useEffect(() => {
    if (!vrm) return;
    // animatorId routes per-character Mixamo overrides. Sourced from the
    // model registry so all Milady VRMs share 'vrm-milady', Hermes/Tekk
    // use their own slugs, and GLB entries (no Mixamo path) pass undefined.
    const animator = new VRMCharacterAnimator(vrm, reg.animatorId);
    vrmAnimatorRef.current = animator;
    animator.init().catch((err) => {
      console.warn('[PlayerAvatar VRM] animator init failed:', err);
    });

    // Subscribe to the emote bus so the cosmetic-drawer / hotbar's
    // `fireEmote('flip')` calls drive the player's avatar.
    const unsub = subscribeEmote((animationKey) => {
      if (!isEmoteAnimName(animationKey)) {
        console.warn(`[PlayerAvatar VRM] unknown emote animation key: ${animationKey}`);
        return;
      }
      void animator.playOneShot(animationKey as AnimName);
    });

    return () => {
      unsub();
      vrmAnimatorRef.current = null;
      animator.dispose();
    };
  }, [vrm]);

  useSceneFrame((state, delta) => {
    const store = useGameStore.getState();
    const frameStartWorldX = avatarPositionRef.x - HALF_W;
    const frameStartWorldZ = avatarPositionRef.y - HALF_H;
    const ownsKelpPortalMovement =
      store.controlMode === 'player' || store.controlMode === 'autonomous';
    if (ownsKelpPortalMovement && kelpPortalPrevInitializedRef.current) {
      // Re-seed from the authoritative frame-start position so an external
      // spawn/teleport can never masquerade as a portal crossing.
      kelpPortalPrevXRef.current = frameStartWorldX;
      kelpPortalPrevZRef.current = frameStartWorldZ;
    } else if (!ownsKelpPortalMovement) {
      kelpPortalPrevInitializedRef.current = false;
    }
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
      if (eNow && !lastEState) {
        // Nori wins if both proximities are true — she stands at the
        // open town center and is the discoverable greeter, so the E
        // press should bias toward her over a flanking building.
        if (store.nearGuide && !store.guideChatOpen && !store.chatOpen) {
          store.openGuideChat();
          lastEState = eNow;
          return;
        }
        if (store.nearLocation) {
          // The cove is a walk-in venue (SceneTransition), not a teacher chat —
          // E near it runs the walk-in flow, never enterBuilding's chat path.
          if (store.nearLocation === 'cove') triggerCoveWalkIn();
          else if (store.nearLocation === 'kelp-forest-portal') triggerKelpForestWalkIn();
          else store.enterBuilding(store.nearLocation);
          lastEState = eNow;
          return;
        }
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
      //
      // Auto-sink (2026-05-18): once the jump arc finishes (phase=grounded)
      // but playerAltitude is still > 0 — e.g. arrow keys nudged altitude
      // up while the jump arc was active, or the user landed atop a
      // structure and is still aloft — gently pull the avatar back down
      // when no vertical input is held. Without this the player got
      // stuck "swimming" mid-air after a jump because nothing decayed
      // playerAltitude. Holding arrow-up still works to free-swim
      // upward — auto-sink only kicks in when neither direction is held.
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
        } else if (
          jumpState.phase === 'grounded' &&
          jumpState.playerAltitude > 0
        ) {
          // Gravity pull. SPEED * 0.6 chosen empirically — slower than
          // active arrow-down (which uses full SPEED) so a player can
          // still briefly hover, but quick enough that an accidentally
          // elevated landing returns to ground within ~1 s.
          const SINK_RATE = SPEED * 0.6;
          jumpState.playerAltitude = Math.max(
            0,
            jumpState.playerAltitude - SINK_RATE * delta
          );
        }
      }
    }

    const hasInput = vx !== 0 || vy !== 0;
    if (hasInput && store.clickPath) store.clearClickPath();

    if (!hasInput && store.clickPath && store.clickPath.length > 0) {
      const waypoint = store.clickPath[store.clickPathIndex];
      if (waypoint) {
        const dx = waypoint.x - avatarPositionRef.x;
        const dy = waypoint.y - avatarPositionRef.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 6) {
          if (store.clickPathIndex >= store.clickPath.length - 1) {
            const target = store.clickPathTarget;
            store.clearClickPath();
            if (target === 'cove') { triggerCoveWalkIn(); return; }
            if (target === 'kelp-forest-portal') { triggerKelpForestWalkIn(); return; }
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
      // VRM facing — Milady VRMs in this project are rigged with Mixamo bones
      // facing -Z natively (opposite of VRM 0.x spec). rotateVRM0 over-rotates,
      // so body world-forward at rotation θ = (sin θ, cos θ). For body forward
      // to equal velocity (vx, vy=z): θ = atan2(vx, vy). Verified live via
      // dot-product probe + arrow screenshot 2026-04-25. Match arena-npcs.tsx.
      continuousRot = Math.atan2(vx, vy);
    }
    store.setMovementDirection(dir as any);

    // Sprint gate (2026-05-18): SHIFT held (desktop) OR joystick magnitude
    // past threshold (mobile) promotes walk → run while moving. Identical
    // logic in both useFrame branches (VRM + GLB) — see RUN_SPEED_MULT /
    // RUN_JOYSTICK_THRESHOLD declarations near the top of this file.
    const _joyMag = Math.hypot(store.joystickVelocity.x, store.joystickVelocity.y);
    const isRunning = (vx !== 0 || vy !== 0) &&
      (keyState.shift || _joyMag > RUN_JOYSTICK_THRESHOLD);
    const speedMult = isRunning ? RUN_SPEED_MULT : 1;

    // Charge-mode discrimination (BUG 2 fix, 2026-06-17).
    //
    // On the rising edge of 'charging' (first frame SPACE goes down while grounded),
    // record whether the avatar was running or walking/idle. This single decision
    // governs the entire charge duration:
    //
    //   'squat' — walking/idle speed class: halt horizontal movement, play squat
    //             surfaceClip + procedural group lowering (squatCrouchRef ramp).
    //   'run'   — running speed class: keep running, skip squat surfaceClip.
    //
    // Mobile parity is automatic: mobile jump button writes jumpState.spaceDown
    // via setJumpPressed() → the same 'charging' rising edge fires → isRunning
    // reflects joystick deflection > RUN_JOYSTICK_THRESHOLD at press time.
    const phaseNow = jumpState.phase;
    const nowCharging = phaseNow === 'charging';
    const wasCharging = wasChargingRef.current;
    wasChargingRef.current = nowCharging;

    if (nowCharging && !wasCharging) {
      // Rising edge of charging this frame — lock in speed class.
      jumpState.chargeMode = isRunning ? 'run' : 'squat';
    } else if (!nowCharging && wasCharging) {
      // Charging just ended (released or auto-launched) — clear chargeMode.
      jumpState.chargeMode = 'none';
    }

    // BUG 2 fix: halt horizontal movement when squatting to wind up.
    // Run-charge keeps full locomotion (chargeMode 'run' → no zeroing).
    if (nowCharging && jumpState.chargeMode === 'squat') {
      vx = 0;
      vy = 0;
    }

    if (vx !== 0 || vy !== 0) {
      // Read from ref (zero React overhead) for current position, write via
      // setAvatarPosition which updates both ref + throttled reactive store.
      let newX = avatarPositionRef.x + vx * SPEED * speedMult * delta;
      let newY = avatarPositionRef.y + vy * SPEED * speedMult * delta;
      newX = Math.max(16, Math.min(MAP_WIDTH - 16, newX));
      newY = Math.max(16, Math.min(MAP_HEIGHT - 16, newY));
      // World-space XZ disc collision — clamp against buildings and props.
      // Convert game-px → world, clamp, convert back. Zero per-frame allocations.
      const prevWX = avatarPositionRef.x - HALF_W;
      const prevWZ = avatarPositionRef.y - HALF_H;
      const clamped = clampMovement2D(prevWX, prevWZ, newX - HALF_W, newY - HALF_H, ENTITY_HALF_CHIBI);
      // Update walkable surface Y — used below to lift avatar onto stair zones.
      // groundY is -2 (sand floor) when not over any walkable collider.
      walkableYRef.current = clamped.groundY;
      store.setAvatarPosition(clamped.x + HALF_W, clamped.z + HALF_H);
    }

    // Test the actual collision-clamped movement segment, not a proximity
    // band. The first frame only seeds the segment origin, preventing a spawn
    // or avatar-model mount from synthesizing a crossing.
    if (ownsKelpPortalMovement) {
      const currentWorldX = avatarPositionRef.x - HALF_W;
      const currentWorldZ = avatarPositionRef.y - HALF_H;
      if (!kelpPortalPrevInitializedRef.current) {
        kelpPortalPrevXRef.current = currentWorldX;
        kelpPortalPrevZRef.current = currentWorldZ;
        kelpPortalPrevInitializedRef.current = true;
      } else {
        if (
          didCrossKelpForestPortal(
            kelpPortalPrevXRef.current,
            kelpPortalPrevZRef.current,
            currentWorldX,
            currentWorldZ,
          )
        ) {
          triggerKelpForestWalkIn();
        }
        kelpPortalPrevXRef.current = currentWorldX;
        kelpPortalPrevZRef.current = currentWorldZ;
      }
    }

    {
      const wx = avatarPositionRef.x - HALF_W;
      const wz = avatarPositionRef.y - HALF_H;
      const nearest = findNearestCharacter(wx, wz);
      // Cove proximity (town-ux-2026-06-19): the cove has no NPC teacher, so
      // isCoveProximate fires when within COVE_PROXIMITY_RADIUS wu and no
      // teacher is nearer. Teacher takes priority if both are in range.
      const nearId: string | null = nearest
        ? nearest.buildingId
        : isCoveProximate(wx, wz)
          ? 'cove'
          : isKelpForestPortalProximate(wx, wz)
            ? 'kelp-forest-portal'
            : null;
      const nearName = nearest ? nearest.characterName : null;
      if (nearId !== store.nearLocation) store.setNearLocation(nearId);
      if (nearName !== store.nearCharacter) store.setNearCharacter(nearName);

      // Town Guide proximity — same shape as findNearestCharacter, but
      // Nori isn't in the building map so we test her singleton position
      // inline. Squared distance avoids sqrt in the hot path.
      const ndx = wx - NORI_WORLD_X;
      const ndz = wz - NORI_WORLD_Z;
      const noriNear = (ndx * ndx + ndz * ndz) < NORI_TALK_RADIUS_SQ;
      if (noriNear !== store.nearGuide) store.setNearGuide(noriNear);
    }

    const group = groupRef.current;
    if (!group) return;
    const [wx, , wz] = mapToWorld(avatarPositionRef.x, avatarPositionRef.y);
    group.position.x = wx;
    group.position.z = wz;

    const isMoving = dir !== 'idle';
    const elapsed = state.clock.elapsedTime;
    const frame = Math.floor(elapsed * 60);
    if (frame % 3 === 0) {
      const ty = getTerrainY(group.position.x, group.position.z, threeScene);
      terrainYRef.current += (ty - terrainYRef.current) * 0.6;
    }
    // VRM feet at Y=0 per spec — no pivot offset, no bob (humanoid avatar).
    // playerAltitude stacks on top of heightOffset for explicit arrow-key 3D swim.
    const airborne = jumpState.phase !== 'grounded' && jumpState.phase !== 'charging'
                  || jumpState.playerAltitude > 0;
    const bob = airborne ? 0 : (isMoving ? 0 : Math.sin(elapsed * 2) * 0.08);
    // effectiveFloorY: when walkableYRef > terrainYRef (avatar is on a stair/ramp
    // collider zone), use the walkable surface height so feet ride the stair.
    // When not on any walkable zone, walkableYRef = -2 = sand floor = same as terrain.
    const effectiveFloorY = Math.max(terrainYRef.current, walkableYRef.current);
    group.position.y = effectiveFloorY + bob
                     + jumpState.heightOffset + jumpState.playerAltitude;

    // Procedural squat crouch (BUG 1 fix, revised 2026-06-17).
    //
    // The squat clip hips.position Y is CONSTANT (headless harness: raw track
    // Y=104.226...104.226, 2 keyframes, zero descent). All squat motion is
    // rotation-only → the pelvis stays at standing height → feet are pulled
    // UP by the knee-bend rotations. The prior getSquatGroundLift() approach
    // (sampling hip-Y descent) was a no-op because descent is always 0.
    //
    // Fix: PROCEDURALLY lower group.position.y by a target crouch depth
    // (SQUAT_CROUCH_VRM_M × vrmRenderScale world units), ramped smoothly.
    // After animator.update() + group.updateMatrixWorld(), read the lowest
    // foot/toe bone world-Y and clamp so feet don't sink below effectiveFloorY.

    // Rotation: see atan2(-vx, -vy) derivation above (VRM faces -Z, need sign negation).
    if (continuousRot !== null) {
      let rotDiff = continuousRot - rotRef.current;
      while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
      while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
      rotRef.current += rotDiff * 0.15;
    }

    // Pitch — lean back while ascending so the swim-pose reads as
    // "swimming upward" (head up, body tilted skyward). Zeroed out
    // when grounded, charging, or descending so the default swim
    // pose stays for any horizontal/downward state. 0.15 lerp matches
    // the facing-rotation cadence so pitch + yaw smooth together.
    const _phaseAscendingPitch = jumpState.phase === 'launch' || jumpState.phase === 'quick';
    const PITCH_ASCEND = -Math.PI / 3; // -60° lean back, head up
    const pitchTarget = _phaseAscendingPitch ? PITCH_ASCEND : 0;
    pitchRef.current += (pitchTarget - pitchRef.current) * 0.15;

    // YXZ order ensures pitch (.x) is applied in the local frame
    // AFTER facing (.y) — so leaning back is always "head-up", never
    // dependent on which direction the avatar is facing.
    group.rotation.order = 'YXZ';
    group.rotation.y = rotRef.current;
    group.rotation.x = pitchRef.current;

    const dt = Math.min(delta, 0.1);

    // Animation pipeline (revised 2026-06-17).
    //
    //   CHARGING + chargeMode 'squat' (idle/walk entry): surfaceClip = 'squat'.
    //     Mixamo squat plays (rotation-only — hips Y is CONSTANT in the asset).
    //     group.position.y is procedurally lowered by SQUAT_CROUCH_VRM_M×scale
    //     so the whole body visibly descends. After update(), foot replant clamps
    //     feet to effectiveFloorY. lockIdle=true so walk↔idle crossfade stays off.
    //
    //   CHARGING + chargeMode 'run' (run entry): no surfaceClip change.
    //     Avatar keeps running; swim-up arc fires on release. No crouch.
    //
    //   AIRBORNE: surfaceClip = 'flying' (Tekk) or 'swimming'. Pitch leans back.
    //
    //   GROUNDED idle/walk: surfaceClip = 'idle'. Normal walk↔idle crossfade.
    const animator = vrmAnimatorRef.current;
    if (animator) {
      const phase = jumpState.phase;
      const phaseCharging = phase === 'charging';
      const chargeMode = jumpState.chargeMode;
      const isSquatCharge = phaseCharging && chargeMode === 'squat';
      const isRunCharge   = phaseCharging && chargeMode === 'run';
      const swimClip: AnimName = reg.animatorId === 'tekk' ? 'flying' : 'swimming';

      // BUG 1 (midair/sunk squat) — TEMPORARILY DISABLED pending a re-baked squat
      // clip (2026-06-18). The 'squat' clip is rotation-only (raw hips Y is a flat
      // constant, zero descent), so playing it pins the pelvis and lifts the feet
      // toward the body (midair tuck). The v3 runtime "foot-grounding" fix that
      // tried to compensate created a 1-frame-lagged feedback oscillation
      // (getFootWorldYMin reads the NORMALIZED humanoid bones, which group.update-
      // MatrixWorld does NOT refresh — same class as the 2026-05-22 stale-matrix
      // trap) → the avatar flickered violently between standing and half-sunk.
      // BOTH are removed here: during squat-charge we keep 'idle' (avatar stands,
      // movement still halted by chargeMode) so nothing glitches. A real squat
      // needs a re-baked clip with knee-bend + root descent — being done with
      // Codex (Rule E3). See gotchas/squat-clip-rotation-only-no-runtime-crouch.md.
      const desiredClip: AnimName =
        isRunCharge ? 'idle'
        : airborne  ? swimClip
        :             'idle';   // isSquatCharge → 'idle' (no rotation-only tuck) until re-bake
      if (desiredClip !== lastSurfaceClipRef.current) {
        animator.setSurfaceClip(desiredClip);
        lastSurfaceClipRef.current = desiredClip;
      }

      // lockIdle = squat-charge or airborne. Run-charge passes real isMoving/isRunning.
      const lockIdle = isSquatCharge || airborne;
      animator.update(dt, lockIdle ? false : isMoving, lockIdle ? false : isRunning);
    }
  }, -100);

  return (
    <group ref={groupRef}>
      {/* Auto-fit scale + foot-ground offset: Milady (1.6m, feet at Y=0)
          → scale ~112, offsetY ~0. Hermes/Tekk (Mixamo cm, hips at Y=0)
          → scale ~0.93, offsetY ~+87. Matches arena-npcs VRMNpcMesh. */}
      <primitive
        object={vrm.scene}
        scale={[vrmRenderScale, vrmRenderScale, vrmRenderScale]}
        position={[0, vrmFootOffsetY, 0]}
      />
      {/*
        Equipped cosmetics (hats / glasses / aura / particles) for the player VRM.
        rigType='universal' — the loader prefers 'universal' variants, then falls
        back to an exact rig match. This works for all humanoid VRMs (Milady,
        Hermes, Tekk, Phanes, chibi) without needing per-rig variant rows in the DB.
        vrm + vrmRenderScale enable computeCosmeticHeadFit for proportion-aware,
        axis-sign-safe hat/glasses placement (Phase B). avatarId='self' because the
        API resolves the caller avatar from the session cookie — prop is
        forward-compat for future per-NPC cosmetic rendering.
      */}
      <CosmeticLoader
        avatarId="self"
        rigType="universal"
        context="world"
        parentObject={vrm.scene}
        vrm={vrm}
        vrmRenderScale={vrmRenderScale}
      />
    </group>
  );
}

function PlayerAvatarGLBInner() {
  const groupRef = useRef<THREE.Group>(null);
  const animGroupRef = useRef<THREE.Group>(null);
  const rotRef = useRef(0);
  const kelpPortalPrevXRef = useRef(0);
  const kelpPortalPrevZRef = useRef(0);
  const kelpPortalPrevInitializedRef = useRef(false);
  const terrainYRef = useRef(-2); // -2 matches sand floor Y so avatar spawns flush with terrain
  // walkableYRef: tracks the walkable-surface Y returned by clampMovement2D.
  // When the GLB avatar enters a walkable collider zone (e.g. shisha-oasis stairs),
  // this ref rises to the stair topY and the avatar's Y follows.
  const walkableYRef = useRef(-2);
  const { scene: threeScene, camera } = useThree();

  // Phase 2: resolve which GLB to load from the model registry.
  // avatarModelKey is set by game/page.tsx via setAvatarAppearance when the avatar
  // loads from the API. Falls back to 'lobster' if null / unknown key.
  const avatarModelKey = useGameStore((s) => s.avatarModelKey);
  const reg: ModelRegistryEntry =
    MODEL_REGISTRY[avatarModelKey as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY.lobster;

  const { scene } = useGLTFWithKTX2(reg.path);

  // Whether to use the legacy LobsterAnimator (skeletal bone discovery) or
  // the universal CharacterAnimator. Mirrors the same routing in arena-npcs.tsx
  // and SelectAgentCanvas.tsx.
  const useNewAnimSystem = avatarModelKey !== 'lobster' && avatarModelKey !== 'crayfish';

  const { cloned, lobsterAnimator, charAnimator, pivotOffsetY } = useMemo(() => {
    const c = scene.clone(true);
    makeObject3DWebGPUSafe(c);
    // Fatten SkinnedMesh bounding spheres + re-enable frustumCulled (Win G fix,
    // 2026-05-22 perf wave 3). SkinnedMesh bind-pose spheres are too tight for
    // animated avatars; applyFattenedFrustumCulling fattens each by 1.6× so the
    // animated pose stays inside the bound, then enables culling so the player
    // avatar is correctly skipped when off-screen. Idempotent via _fattenedBy tag.
    applyFattenedFrustumCulling(c);
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
      const anim = createCharacterAnimator(avatarModelKey, c);
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
  }, [scene, avatarModelKey, useNewAnimSystem, reg.scale]);

  // Dispose cloned materials on unmount (navigation away / hot-reload)
  useEffect(() => {
    return () => {
      cloned.traverse((obj: THREE.Object3D) => {
        const mesh = obj as THREE.Mesh;
        if ((mesh as any).isMesh) {
          // Do NOT dispose tinted materials — applyColorTint() now uses a
          // module-scope shared cache keyed on (baseMat.uuid|tintHex|lerpFactor|
          // emissiveIntensity). The cached instances are intentionally long-lived
          // so subsequent NPCs with the same (species, tint) combo can reuse
          // the same GPU pipeline without re-upload. Disposing here would corrupt
          // the cache and break every other NPC that shares the material.
          //
          // NEVER dispose geometry: scene.clone(true) shares BufferGeometry with
          // the useGLTF cache (Mesh.copy: this.geometry = source.geometry). If
          // we disposed it, the cache would hand out a disposed buffer to any
          // other consumer of this GLB (e.g. arena-npcs wandering NPCs that
          // load the same path).
        }
      });
    };
  }, [cloned]);

  useSceneFrame((state, delta) => {
    const store = useGameStore.getState();
    const frameStartWorldX = avatarPositionRef.x - HALF_W;
    const frameStartWorldZ = avatarPositionRef.y - HALF_H;
    const ownsKelpPortalMovement =
      store.controlMode === 'player' || store.controlMode === 'autonomous';
    if (ownsKelpPortalMovement && kelpPortalPrevInitializedRef.current) {
      // Re-seed from the authoritative frame-start position so an external
      // spawn/teleport can never masquerade as a portal crossing.
      kelpPortalPrevXRef.current = frameStartWorldX;
      kelpPortalPrevZRef.current = frameStartWorldZ;
    } else if (!ownsKelpPortalMovement) {
      kelpPortalPrevInitializedRef.current = false;
    }
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
      if (eNow && !lastEState) {
        // Nori wins if both proximities are true — she stands at the
        // open town center and is the discoverable greeter, so the E
        // press should bias toward her over a flanking building.
        if (store.nearGuide && !store.guideChatOpen && !store.chatOpen) {
          store.openGuideChat();
          lastEState = eNow;
          return;
        }
        if (store.nearLocation) {
          // The cove is a walk-in venue (SceneTransition), not a teacher chat —
          // E near it runs the walk-in flow, never enterBuilding's chat path.
          if (store.nearLocation === 'cove') triggerCoveWalkIn();
          else if (store.nearLocation === 'kelp-forest-portal') triggerKelpForestWalkIn();
          else store.enterBuilding(store.nearLocation);
          lastEState = eNow;
          return;
        }
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
      //
      // Auto-sink (2026-05-18): once the jump arc finishes (phase=grounded)
      // but playerAltitude is still > 0 — e.g. arrow keys nudged altitude
      // up while the jump arc was active, or the user landed atop a
      // structure and is still aloft — gently pull the avatar back down
      // when no vertical input is held. Without this the player got
      // stuck "swimming" mid-air after a jump because nothing decayed
      // playerAltitude. Holding arrow-up still works to free-swim
      // upward — auto-sink only kicks in when neither direction is held.
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
        } else if (
          jumpState.phase === 'grounded' &&
          jumpState.playerAltitude > 0
        ) {
          // Gravity pull. SPEED * 0.6 chosen empirically — slower than
          // active arrow-down (which uses full SPEED) so a player can
          // still briefly hover, but quick enough that an accidentally
          // elevated landing returns to ground within ~1 s.
          const SINK_RATE = SPEED * 0.6;
          jumpState.playerAltitude = Math.max(
            0,
            jumpState.playerAltitude - SINK_RATE * delta
          );
        }
      }
    }

    const hasInput = vx !== 0 || vy !== 0;
    if (hasInput && store.clickPath) store.clearClickPath();

    if (!hasInput && store.clickPath && store.clickPath.length > 0) {
      const waypoint = store.clickPath[store.clickPathIndex];
      if (waypoint) {
        const dx = waypoint.x - avatarPositionRef.x;
        const dy = waypoint.y - avatarPositionRef.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 6) {
          if (store.clickPathIndex >= store.clickPath.length - 1) {
            const target = store.clickPathTarget;
            store.clearClickPath();
            if (target === 'cove') { triggerCoveWalkIn(); return; }
            if (target === 'kelp-forest-portal') { triggerKelpForestWalkIn(); return; }
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

    // Sprint gate (2026-05-18): SHIFT held (desktop) OR joystick magnitude
    // past threshold (mobile) promotes walk → run while moving. Identical
    // logic in both useFrame branches (VRM + GLB) — see RUN_SPEED_MULT /
    // RUN_JOYSTICK_THRESHOLD declarations near the top of this file.
    const _joyMag = Math.hypot(store.joystickVelocity.x, store.joystickVelocity.y);
    const isRunning = (vx !== 0 || vy !== 0) &&
      (keyState.shift || _joyMag > RUN_JOYSTICK_THRESHOLD);
    const speedMult = isRunning ? RUN_SPEED_MULT : 1;

    if (vx !== 0 || vy !== 0) {
      // Read from ref (zero React overhead) for current position, write via
      // setAvatarPosition which updates both ref + throttled reactive store.
      let newX = avatarPositionRef.x + vx * SPEED * speedMult * delta;
      let newY = avatarPositionRef.y + vy * SPEED * speedMult * delta;
      newX = Math.max(16, Math.min(MAP_WIDTH - 16, newX));
      newY = Math.max(16, Math.min(MAP_HEIGHT - 16, newY));
      // World-space XZ disc collision — clamp against buildings and props.
      // Convert game-px → world, clamp, convert back. Zero per-frame allocations.
      const prevWX = avatarPositionRef.x - HALF_W;
      const prevWZ = avatarPositionRef.y - HALF_H;
      const clamped = clampMovement2D(prevWX, prevWZ, newX - HALF_W, newY - HALF_H, ENTITY_HALF_CHIBI);
      // Update walkable surface Y — used below to lift avatar onto stair zones.
      // groundY is -2 (sand floor) when not over any walkable collider.
      walkableYRef.current = clamped.groundY;
      store.setAvatarPosition(clamped.x + HALF_W, clamped.z + HALF_H);
    }

    // Test the actual collision-clamped movement segment, not a proximity
    // band. The first frame only seeds the segment origin, preventing a spawn
    // or avatar-model mount from synthesizing a crossing.
    if (ownsKelpPortalMovement) {
      const currentWorldX = avatarPositionRef.x - HALF_W;
      const currentWorldZ = avatarPositionRef.y - HALF_H;
      if (!kelpPortalPrevInitializedRef.current) {
        kelpPortalPrevXRef.current = currentWorldX;
        kelpPortalPrevZRef.current = currentWorldZ;
        kelpPortalPrevInitializedRef.current = true;
      } else {
        if (
          didCrossKelpForestPortal(
            kelpPortalPrevXRef.current,
            kelpPortalPrevZRef.current,
            currentWorldX,
            currentWorldZ,
          )
        ) {
          triggerKelpForestWalkIn();
        }
        kelpPortalPrevXRef.current = currentWorldX;
        kelpPortalPrevZRef.current = currentWorldZ;
      }
    }

    // Character proximity check — replaces building-zone area check.
    // Runs every frame so nearLocation / nearCharacter stay accurate even when
    // the avatar stops or is repositioned externally (clickPath, setAvatarPosition).
    // findNearestCharacter takes world-space primitives — zero allocation.
    {
      const wx = avatarPositionRef.x - HALF_W;
      const wz = avatarPositionRef.y - HALF_H;
      const nearest = findNearestCharacter(wx, wz);
      // Cove proximity (town-ux-2026-06-19): the cove has no NPC teacher, so
      // isCoveProximate fires when within COVE_PROXIMITY_RADIUS wu and no
      // teacher is nearer. Teacher takes priority if both are in range.
      const nearId: string | null = nearest
        ? nearest.buildingId
        : isCoveProximate(wx, wz)
          ? 'cove'
          : isKelpForestPortalProximate(wx, wz)
            ? 'kelp-forest-portal'
            : null;
      const nearName = nearest ? nearest.characterName : null;
      if (nearId !== store.nearLocation) store.setNearLocation(nearId);
      if (nearName !== store.nearCharacter) store.setNearCharacter(nearName);

      // Town Guide proximity — same shape as findNearestCharacter, but
      // Nori isn't in the building map so we test her singleton position
      // inline. Squared distance avoids sqrt in the hot path.
      const ndx = wx - NORI_WORLD_X;
      const ndz = wz - NORI_WORLD_Z;
      const noriNear = (ndx * ndx + ndz * ndz) < NORI_TALK_RADIUS_SQ;
      if (noriNear !== store.nearGuide) store.setNearGuide(noriNear);
    }

    const group = groupRef.current;
    if (!group) return;
    const [wx, , wz] = mapToWorld(avatarPositionRef.x, avatarPositionRef.y);
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
      terrainYRef.current += (ty - terrainYRef.current) * 0.6;
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
    // effectiveFloorY: when walkableYRef > terrainYRef (avatar entered a stair/ramp
    // collider zone), use the walkable surface height so feet ride the stair.
    // When not on any walkable zone, walkableYRef = -2 = sand floor = terrain.
    const effectiveFloorY = Math.max(terrainYRef.current, walkableYRef.current);
    // Subtract pivotOffsetY to ground the avatar regardless of GLB pivot placement.
    // pivotOffsetY = localMinY * finalScale (world units).
    // If pivot is above feet (localMinY < 0), pivotOffsetY is negative —
    // subtracting a negative raises the model so feet align with effectiveFloorY.
    // jumpState.playerAltitude stacks on top of heightOffset for full 3D swim.
    group.position.y = effectiveFloorY + 2 + (airborne ? 0 : finalBob)
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

    // Crustaceans have no run clip — they reuse their walk cycle but the
    // PROCEDURAL animator advances at speedMult× the normal rate when
    // sprinting, so the visible foot cadence matches the faster ground
    // motion and avoids foot-skating. Both the universal character
    // animator (charAnimator) and the legacy lobster animator
    // (lobsterAnimator) consume a scaled dt for this reason.
    const animDt = dt * speedMult;
    if (useNewAnimSystem && charAnimator && animGroup) {
      // Universal animator handles both idle and walk in one call
      charAnimator.update(animGroup, elapsed, animDt, isMoving);
    } else if (lobsterAnimator && animGroup) {
      // Legacy lobster/crayfish path — skeletal + procedural squash/stretch
      const suggestedAnim = isMoving ? 'walk' : 'idle';
      lobsterAnimator.update(animDt, elapsed, suggestedAnim as any, dir);

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
  }, -100);

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

function PlayerAvatarRouter() {
  const sceneActive = useSceneActive();
  useEffect(() => {
    if (!sceneActive) {
      resetPlayerKeys();
      return;
    }
    return attachKeyListeners();
  }, [sceneActive]);

  const avatarModelKey = useGameStore((s) => s.avatarModelKey);
  const reg: ModelRegistryEntry =
    MODEL_REGISTRY[avatarModelKey as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY.lobster;

  if (reg.avatar_type === 'vrm') {
    return (
      <Suspense fallback={null}>
        <PlayerAvatarVRMInner reg={reg} />
      </Suspense>
    );
  }

  return <PlayerAvatarGLBInner />;
}

export default function PlayerAvatar() {
  const kelpPortalMountResetRef = useRef(false);

  // Locomotion clips are shared by every VRM avatar. The selected VRM itself is
  // loaded on demand by useVRMInstance; avatar-picker choices are warmed only
  // when the picker opens so /game does not fetch the full avatar catalog.
  useEffect(() => {
    // PlayerAvatar owns the stable 3D world-scene lifecycle. Reset here once,
    // not in the swappable VRM/GLB inners or the simultaneously mounted NPC
    // controller, so a model/control-mode change cannot clear the in-flight guard.
    if (!kelpPortalMountResetRef.current) {
      resetKelpForestWalkInLatch();
      kelpPortalMountResetRef.current = true;
    }
    preloadMixamoClips();
  }, []);

  return (
    <Suspense fallback={null}>
      <PlayerAvatarRouter />
    </Suspense>
  );
}
