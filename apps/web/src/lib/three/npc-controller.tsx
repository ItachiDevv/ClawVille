'use client';

/**
 * NpcController — WASD / joystick control of a possessed NPC in 'npc' mode.
 *
 * ALL input (keyboard + joystick) is camera-relative:
 *   - Push joystick up / press W → move in the direction the camera faces
 *   - Push joystick right / press D → strafe right from camera's perspective
 *
 * This works correctly regardless of camera rotation / orbit angle.
 * Uses the same world AABB collision as the connected player avatar so the
 * possessed NPC cannot walk into buildings or town props.
 */

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useGameStore, avatarPositionRef, type GameState } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import type { NpcSpriteState } from '@/stores/npc';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { findNearestCharacter } from '@/lib/three/character-positions';
import { NORI_WORLD_X, NORI_WORLD_Z, NORI_TALK_RADIUS_SQ } from '@/lib/three/town-guide';
import { isEditable, jumpState } from '@/lib/three/jump-state';
import { clampMovement2D, ENTITY_HALF_HUMANOID } from '@/lib/three/collision/world-colliders';

const SPEED = 550; // pixels/sec — pass 2 2026-04-16: bumped 320→550 (user tested pass 1 at 320,
                   // still felt sluggish crossing ~2000-wu visible area; target 3-4s crossing time → 2000/550≈3.6s)

// Map pixel bounds
const X_MIN = 16;
const X_MAX = MAP_WIDTH - 16;
const Y_MIN = 16;
const Y_MAX = MAP_HEIGHT - 16;


// Module-level key state — avoids closure allocs
interface NpcKeyState {
  w: boolean; a: boolean; s: boolean; d: boolean;
  arrowup: boolean; arrowdown: boolean;
  e: boolean; escape: boolean; shift: boolean;
}
const _keys: NpcKeyState = {
  w: false, a: false, s: false, d: false,
  arrowup: false, arrowdown: false,
  e: false, escape: false, shift: false,
};
let _listenersAttached = false;
let _lastEState = false;
let _lastEscState = false;

const RUN_SPEED_MULT = 1.5;
const RUN_JOYSTICK_THRESHOLD = 0.7;

// Scratch vectors — allocated once, reused every frame
const _camForward = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);

function resetNpcKeys() {
  // Clear all key state — called on window blur/visibility-hide so a key held
  // while the tab loses focus doesn't stay "true" forever (browser skips keyup
  // when focus leaves the window, leaving _keys stranded in the pressed state).
  (Object.keys(_keys) as Array<keyof NpcKeyState>).forEach((k) => { _keys[k] = false; });
}

function attachNpcKeyListeners() {
  if (_listenersAttached) return;
  _listenersAttached = true;
  const onDown = (e: KeyboardEvent) => {
    // Target guard: don't consume WASD/E/Escape when user is typing in a chat input.
    // Fixes pre-existing bug: typing W/A/S/D in chat moved the NPC.
    // NOTE: onUp intentionally has NO target guard — it must always clear state
    // so keys don't get stranded 'true' when the user taps into an input mid-move.
    if (isEditable(e.target)) return;
    const rawKey = e.key.toLowerCase();
    const rawCode = e.code.toLowerCase();
    if (rawKey === 'shift' || rawCode === 'shiftleft' || rawCode === 'shiftright') {
      _keys.shift = true;
      return;
    }
    _keys.shift = e.shiftKey;
    const k = rawKey as keyof NpcKeyState;
    if (k in _keys) _keys[k] = true;
  };
  const onUp = (e: KeyboardEvent) => {
    const rawKey = e.key.toLowerCase();
    const rawCode = e.code.toLowerCase();
    if (rawKey === 'shift' || rawCode === 'shiftleft' || rawCode === 'shiftright') {
      _keys.shift = false;
      return;
    }
    _keys.shift = e.shiftKey;
    const k = rawKey as keyof NpcKeyState;
    if (k in _keys) _keys[k] = false;
  };
  // When the window loses focus the browser stops firing keyup for held keys.
  // Resetting all key state on blur/visibilitychange prevents phantom movement
  // after the user alt-tabs or the OS steals focus mid-hold.
  const onBlur = () => resetNpcKeys();
  const onVisibility = () => { if (document.hidden) resetNpcKeys(); };
  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
}

function directionFromVelocity(vx: number, vy: number): NpcSpriteState['direction'] {
  if (vx === 0 && vy === 0) return 'idle';
  if (Math.abs(vx) >= Math.abs(vy)) {
    return vx > 0 ? 'right' : 'left';
  }
  return vy > 0 ? 'down' : 'up';
}

export default function NpcController() {
  const attachedRef = useRef(false);
  const { camera } = useThree();

  useEffect(() => {
    if (!attachedRef.current) {
      attachNpcKeyListeners();
      attachedRef.current = true;
    }
  }, []);

  useFrame((_, delta) => {
    const store = useGameStore.getState();
    const { controlMode, possessedNpcId } = store;

    // Only active in npc mode with a possessed target
    if (controlMode !== 'npc' || !possessedNpcId) return;

    // Handle Escape to exit building OR close guide chat
    const escNow = _keys.escape;
    if (escNow && !_lastEscState) {
      if (store.chatOpen) store.exitBuilding();
      else if (store.guideChatOpen) store.closeGuideChat();
    }
    _lastEscState = escNow;

    // If movement is frozen (inside a building or guide chat), skip movement
    if (store.movementFrozen) return;

    // Handle E to talk — Nori takes priority over a building character
    // when both proximities are true (she's the discoverable greeter).
    const eNow = _keys.e;
    if (eNow && !_lastEState) {
      if (store.nearGuide && !store.guideChatOpen && !store.chatOpen) {
        store.openGuideChat();
        _lastEState = eNow;
        return;
      }
      if (store.nearLocation) {
        store.enterBuilding(store.nearLocation);
        _lastEState = eNow;
        return;
      }
    }
    _lastEState = eNow;

    // Single NPC lookup per frame — was duplicated 3× below (proximity, idle, movement).
    // npcs is a flat array; a single .find() at the top avoids 2 redundant scans/frame.
    const npcStore = useNpcStore.getState();
    const npc = npcStore.npcs.find((n) => n.id === possessedNpcId);
    if (!npc) return;

    // Character proximity check — replaces building-zone area check.
    // findNearestCharacter takes world-space primitives — zero allocation.
    // NPC pixel coords → world coords: worldX = npc.x - MAP_WIDTH/2, worldZ = npc.y - MAP_HEIGHT/2
    {
      const wx = npc.x - MAP_WIDTH  / 2;
      const wz = npc.y - MAP_HEIGHT / 2;
      const nearest = findNearestCharacter(wx, wz);
      const nearId = nearest ? nearest.buildingId : null;
      const nearName = nearest ? nearest.characterName : null;
      if (nearId !== store.nearLocation) store.setNearLocation(nearId);
      if (nearName !== store.nearCharacter) store.setNearCharacter(nearName);

      // Town Guide proximity (singleton — Nori isn't in CHARACTER_POSITIONS).
      const ndx = wx - NORI_WORLD_X;
      const ndz = wz - NORI_WORLD_Z;
      const noriNear = (ndx * ndx + ndz * ndz) < NORI_TALK_RADIUS_SQ;
      if (noriNear !== store.nearGuide) store.setNearGuide(noriNear);
    }

    // ---- Unified input: joystick + WASD → camera-relative ----
    let inputFwd = 0;
    let inputRight = 0;

    const { joystickVelocity } = store as GameState;
    if (joystickVelocity.x !== 0 || joystickVelocity.y !== 0) {
      // Joystick: x = screen-right, y < 0 = screen-up
      inputRight = joystickVelocity.x;
      inputFwd = -joystickVelocity.y; // screen-up → camera forward
    } else {
      if (_keys.w) inputFwd += 1;
      if (_keys.s) inputFwd -= 1;
      if (_keys.a) inputRight -= 1;
      if (_keys.d) inputRight += 1;
    }

    // Normalize diagonal so you don't move faster diagonally
    if (inputFwd !== 0 && inputRight !== 0) {
      const len = Math.sqrt(inputFwd * inputFwd + inputRight * inputRight);
      inputFwd /= len;
      inputRight /= len;
    }

    // No input → set idle (keep last facingAngle so model doesn't snap)
    if (inputFwd === 0 && inputRight === 0) {
      if (
        Math.abs(avatarPositionRef.x - npc.x) > 0.5 ||
        Math.abs(avatarPositionRef.y - npc.y) > 0.5
      ) {
        store.setAvatarPosition(npc.x, npc.y);
      }
      if (npc.direction !== 'idle') {
        npcStore.moveNpc(possessedNpcId, npc.x, npc.y, 'idle', npc.facingAngle);
      }
      return;
    }

    // ---- Camera-relative transform ----
    camera.getWorldDirection(_camForward);
    _camForward.y = 0; // WASD is always flat camera-relative XZ — never couples to camera pitch
    const fwdLen = _camForward.length();
    if (fwdLen < 0.001) return; // Camera nearly vertical — skip
    _camForward.divideScalar(fwdLen);

    _camRight.crossVectors(_camForward, _worldUp).normalize();

    const worldVx = _camForward.x * inputFwd + _camRight.x * inputRight;
    const worldVz = _camForward.z * inputFwd + _camRight.z * inputRight;
    const joyMag = Math.hypot(store.joystickVelocity.x, store.joystickVelocity.y);
    const speedMult = _keys.shift || joyMag > RUN_JOYSTICK_THRESHOLD ? RUN_SPEED_MULT : 1;

    // Vertical swim: arrow up/down only, gated on airborne.
    // Decoupled from camera pitch — mouse orbit never causes altitude drift.
    // Arrow keys continue to rotate the camera via ArrowKeyRotationController;
    // they ALSO drive altitude here when the NPC/avatar is airborne.
    const airborne =
      jumpState.phase !== 'grounded' || jumpState.playerAltitude > 0;
    if (airborne) {
      let verticalInput = 0;
      if (_keys.arrowup) verticalInput += 1;
      if (_keys.arrowdown) verticalInput -= 1;
      if (verticalInput !== 0) {
        jumpState.playerAltitude = Math.max(
          0,
          jumpState.playerAltitude + verticalInput * SPEED * delta
        );
      }
    }

    // Facing angle for +Z-facing model: atan2(worldVx, worldVz) — EMPIRICALLY VERIFIED 2026-04-16 (late PM, clean side-view screenshot)
    // Prior sessions concluded +X (wrong — camera was orbited in that screenshot). +Z is proven by unambiguous side-view.
    const facingAngle = Math.atan2(worldVx, worldVz);

    // Cardinal direction for sprite system
    const dir = directionFromVelocity(worldVx, worldVz);

    // Position update — clamp against the same world AABBs as the player path.
    // worldX maps to pixelX, worldZ maps to pixelY (same scale, different offset)
    const targetX = Math.max(X_MIN, Math.min(X_MAX, npc.x + worldVx * SPEED * speedMult * delta));
    const targetY = Math.max(Y_MIN, Math.min(Y_MAX, npc.y + worldVz * SPEED * speedMult * delta));
    const clamped = clampMovement2D(
      npc.x - MAP_WIDTH / 2,
      npc.y - MAP_HEIGHT / 2,
      targetX - MAP_WIDTH / 2,
      targetY - MAP_HEIGHT / 2,
      ENTITY_HALF_HUMANOID,
    );
    const newX = Math.max(X_MIN, Math.min(X_MAX, clamped.x + MAP_WIDTH / 2));
    const newY = Math.max(Y_MIN, Math.min(Y_MAX, clamped.z + MAP_HEIGHT / 2));

    // speedMult>1 means shift/joystick-sprint is engaged → tell the animator to
    // play the run clip (gated by isMoving in updateMixerOnly, so a held shift
    // while standing still still reads as idle).
    npcStore.moveNpc(possessedNpcId, newX, newY, dir, facingAngle, speedMult > 1);
    store.setAvatarPosition(newX, newY);
  }, -100);

  return null;
}
