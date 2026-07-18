'use client';

/**
 * useActivityInput — captures keyboard + mobile-joystick input for the
 * active Bumper Shells / Reef Race room and sends `{type:'input'}` frames at
 * ~30 Hz.
 *
 * Why 30 Hz, not 60: backend §3.4 caps inbound at 60 Hz and the protocol
 * note says ">60 Hz inputs are dropped with `error: input_rate`". 30 Hz
 * gives us ~33ms input granularity which is well below the 60 Hz sim tick
 * — server interpolates between received inputs for the missed ticks.
 * Starting conservative respects bandwidth budget (8 players × 30 Hz × ~40
 * bytes = 9.6 KB/s in vs §3.4's 19.2 KB/s ceiling at 60 Hz).
 *
 * Wiring:
 *   - Mounted by `app/activity/[activityId]/[roomId]/page.tsx` after the
 *     WS connects.
 *   - `enabled` should be false during pregame countdown, after self
 *     elimination, after match-end, or while disconnected.
 *
 * Action bits are activity-specific (16-bit packed):
 *   Bumper Shells: bit 0 = boost, bit 1 = power-up use, bit 2 = jump.
 *   Reef Race:     bit 0 = use queued item, bit 1 = reserved, bit 2 = jump.
 *
 * Keep this mapping local to the activity. Bumper Shells' bit-0 boost contract
 * is live and must not move when Reef Race controls change.
 */

import { useEffect, useRef } from 'react';
import type { ClientFrame } from '@clawville/shared';
import { useGameStore } from '@/stores/game';
import { useActivityStore } from '@/stores/activity';
import { registerInputReset } from '@/lib/three/input-reset';
import {
  selfInputBus,
  selfPoseBus,
  resetSelfInputBus,
} from '@/lib/three/activities/reef-race/reef-race-self-bus';

export const ACTION_BIT_BOOST = 1 << 0;
export const ACTION_BIT_USE_POWERUP = 1 << 1;
/** Bit 2 — jump. Reef maps both Space and Shift here in Round 9. */
export const ACTION_BIT_JUMP = 1 << 2;

const SEND_INTERVAL_MS = 1000 / 30;
// Founder knob: raise for a larger held-A/D steering lead; 0.12 stays limiter-bound without twitch.
const TURN_BIAS = 0.12;
// Founder knob: raise for a larger held-arrow steering lead; arrows intentionally carve harder than A/D.
const ARROW_TURN_BIAS = 0.18;
const REEF_RENDER_HEADING_STALE_MS = 250;

interface MovementKeys {
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
  arrowUp: boolean;
  arrowLeft: boolean;
  arrowDown: boolean;
  arrowRight: boolean;
}

function hasMovementKey(k: MovementKeys): boolean {
  return (
    k.w ||
    k.a ||
    k.s ||
    k.d ||
    k.arrowUp ||
    k.arrowLeft ||
    k.arrowDown ||
    k.arrowRight
  );
}

/** Mutates `out`; safe to call from the 30 Hz send loop without allocation. */
function recomputeReefKeyboardDir(
  k: MovementKeys,
  heading: number,
  out: { x: number; y: number },
): void {
  const fwdX = Math.sin(heading);
  const fwdY = Math.cos(heading);
  const rightX = Math.cos(heading);
  const rightY = -Math.sin(heading);
  const thrust = k.w || k.arrowUp ? 1 : 0;
  const brake = k.s || k.arrowDown;
  const keyTurn = (k.a ? 1 : 0) - (k.d ? 1 : 0);
  const arrowTurn = (k.arrowLeft ? 1 : 0) - (k.arrowRight ? 1 : 0);
  const turnBias = keyTurn * TURN_BIAS + arrowTurn * ARROW_TURN_BIAS;
  let x = fwdX * thrust + rightX * turnBias;
  let y = fwdY * thrust + rightY * turnBias;
  if (thrust === 0 && (turnBias !== 0 || brake)) {
    x = fwdX * 0.15 + rightX * turnBias;
    y = fwdY * 0.15 + rightY * turnBias;
  }
  const mag = Math.hypot(x, y);
  out.x = mag > 0 ? x / mag : 0;
  out.y = mag > 0 ? y / mag : 0;
}

export interface UseActivityInputOptions {
  /** WS send fn returned by `useActivityWs`. */
  send: (frame: ClientFrame) => boolean;
  /** Master gate — false suppresses ALL input (HUD overlays etc.). */
  enabled: boolean;
  /** Selects the activity-specific key-to-action-bit contract. */
  activityId: string;
}

export function useActivityInput({
  send,
  enabled,
  activityId,
}: UseActivityInputOptions): void {
  // Per-input mutable state. Stored in refs to avoid React re-renders
  // and keep the keyboard handlers stable across the session.
  const dirRef = useRef({ x: 0, y: 0 });
  const targetDirRef = useRef({ x: 0, y: 0 });
  const keysRef = useRef<MovementKeys>({
    w: false,
    a: false,
    s: false,
    d: false,
    arrowUp: false,
    arrowLeft: false,
    arrowDown: false,
    arrowRight: false,
  });
  const actionBitsRef = useRef(0);
  /** Latched bits — fired ONCE on next send tick then cleared. */
  const oneShotBitsRef = useRef(0);
  const seqRef = useRef(0);
  const lastSendAtRef = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // ─── Reef Race detection (Mario Kart-style controls) ────────────────────
  // Reef Race uses a chase camera that follows the kart's facing. World-axis
  // WASD (W=north, A=west, etc.) feels "reversed" to a player whose camera is
  // pointed along an arbitrary direction. The kart-relative scheme:
  //   W = forward thrust; S/ArrowDown = brake/coast in the current heading
  //   A/D = steering bias (atan2 computes the desired heading; shared
  //         turnToward rate-limits body.rot while the kart moves forward)
  //
  // Bumper Shells uses a top-down camera where world-axis = screen-axis, so
  // there's no disconnect — keep its existing world-axis WASD (legacy path).
  //
  // The route passes its activity id explicitly so key-to-bit semantics never
  // depend on URL parsing and Bumper's live contract stays isolated.
  const isReefRace = activityId === 'reef-race';
  const isReefRaceRef = useRef(isReefRace);
  isReefRaceRef.current = isReefRace;
  const spaceHeldRef = useRef(false);
  const shiftHeldRef = useRef(false);
  const reefBrakeRef = useRef(false);
  const keyboardDirRef = useRef({ x: 0, y: 0 });
  const recomputeDirFromKeysRef = useRef<() => void>(() => {});

  // Kart-relative-controls fallback state. The send loop prefers the fresh
  // rendered heading, while this mirrors authority for v1/no-prediction/stale pose.
  const headingRef = useRef(0);
  useEffect(() => {
    if (!isReefRace) return;
    // Prime headingRef immediately from the current store snapshot so the
    // first keypress before any subscription event fires uses the actual
    // spawn rotation, not the default 0 (which would face south at spawn
    // and feel exactly as wrong as the bug we're fixing).
    const prime = useActivityStore.getState();
    const primeId = prime.selfAvatarId;
    if (primeId) {
      const e = prime.entities.get(primeId) as { rot?: number } | undefined;
      if (e && typeof e.rot === 'number' && Number.isFinite(e.rot)) {
        headingRef.current = e.rot;
      }
    }
    const unsub = useActivityStore.subscribe((s) => {
      const id = s.selfAvatarId;
      if (!id) return;
      const e = s.entities.get(id) as { rot?: number } | undefined;
      if (e && typeof e.rot === 'number' && Number.isFinite(e.rot)) {
        headingRef.current = e.rot;
      }
    });
    return unsub;
  }, [isReefRace]);

  // Subscribe to mobile joystick velocity from the game store. The mobile
  // controls layer (`mobile-controls.tsx`) writes nipplejs output to
  // `joystickVelocity` which we mirror into `dirRef` so a single send loop
  // can ship desktop OR mobile input without branching.
  // We use a manual subscribe instead of useGameStore() to avoid a re-render
  // every time the joystick moves (could be 60 Hz on mobile).
  useEffect(() => {
    const unsub = useGameStore.subscribe((s, prev) => {
      if (
        s.joystickVelocity.x !== prev.joystickVelocity.x ||
        s.joystickVelocity.y !== prev.joystickVelocity.y
      ) {
        // joystickVelocity uses world-down as +y. We feed the input frame
        // an unaltered vector — server-side sim normalizes its own axes.
        targetDirRef.current.x = s.joystickVelocity.x;
        targetDirRef.current.y = s.joystickVelocity.y;
      }
    });
    return unsub;
  }, []);

  // ── Keyboard handlers ───────────────────────────────────────────────────
  useEffect(() => {
    function recomputeDirFromKeys() {
      const k = keysRef.current;
      let x = 0;
      let y = 0;

      if (isReefRaceRef.current) {
        // ─── Mario Kart-style kart-relative controls ───────────────────
        // Compute "forward" (kart's current facing) and "right" (perpendicular)
        // unit vectors in sim-space.
        //
        // Server convention: atan2(intent.dir.x, intent.dir.y) produces the
        // desired heading; shared turnToward rate-limits body.rot toward it.
        // So at rot=h, the unit forward vector in sim-space is
        //   (sin(h), cos(h))     — same parameterization as server uses.
        // Right (90° clockwise of forward) is
        //   (cos(h), -sin(h))    — 2D rotation by -π/2 of the forward vector.
        //
        // W contributes forward thrust; S/ArrowDown requests brake/coast and
        // never reverses the direction vector.
        // A/D contribute a SMALL side bias (TURN_BIAS) along ±right. The bias
        // is intentionally small so it creates a heading lead, not a hard 90°
        // pivot. The shared turnToward advances toward that per-tick-refreshed
        // lead at its bounded limiter. Held A = continuous gentle left turn.
        //
        // TURN_BIAS creates atan(0.12)=6.84° of heading lead. Arrow steering
        // is tracked separately so A+Left / D+Right can turn harder without
        // making default WASD steering twitchy.
        const renderNow = performance.now();
        const h =
          selfPoseBus.valid &&
          renderNow - selfPoseBus.updatedAt < REEF_RENDER_HEADING_STALE_MS
            ? selfPoseBus.rot
            : headingRef.current;
        // Three.js camera convention surprise:
        //
        // Chase camera lookAt(playerCenter) sets `_x = up × back` for camera-
        // local +x (screen-right). With our chase cam pose, this places camera-
        // RIGHT on the OPPOSITE world-axis from the player's geometric right
        // hand. Net effect: player presses A intending "turn left on screen,"
        // and a bias toward player's geometric LEFT actually produces a yaw
        // toward camera-RIGHT (= screen-RIGHT). Players feel A and D swapped.
        //
        // The two prior fixes (turn = D-A with `right` vec, and turn = A-D
        // with `left` vec) were algebraically identical — both bias along
        // (-cos(h), +sin(h)). Confirmed no-op via trace 2026-04-26.
        //
        // Real fix: bias along the GEOMETRIC RIGHT vector (cos(h), -sin(h))
        // when player presses A. Counter-intuitive in code but correct on
        // screen. D press uses the opposite sign — biases geometric LEFT,
        // produces yaw toward camera-LEFT = screen-LEFT. Wait — we want
        // D = right. So D bias must produce yaw toward CAMERA-RIGHT.
        // A press → bias right vec → kart visually turns LEFT.
        // D press → bias -right (= left) vec → kart visually turns RIGHT.
        recomputeReefKeyboardDir(k, h, keyboardDirRef.current);
        x = keyboardDirRef.current.x;
        y = keyboardDirRef.current.y;
        reefBrakeRef.current = k.s || k.arrowDown;
        // A = +1 (will bias along +right vec → screen-LEFT yaw)
        // D = -1 (biases along -right vec → screen-RIGHT yaw)
        // With steering or brake held but no forward thrust, synthesize a small
        // forward DIRECTION so the heading remains stable and A/D can still
        // yaw. The send loop separately forces brake thrust to zero.
      } else {
        // ─── Bumper Shells / legacy: world-axis WASD ────────────────────
        if (k.a || k.arrowLeft) x -= 1;
        if (k.d || k.arrowRight) x += 1;
        if (k.w || k.arrowUp) y -= 1; // server convention: -y = forward / north
        if (k.s || k.arrowDown) y += 1;
      }

      // Normalize so diagonals aren't √2 faster (kart-relative path also
      // benefits — combined thrust+turn vector can exceed unit length).
      const mag = Math.hypot(x, y);
      if (mag > 0) {
        x /= mag;
        y /= mag;
      }
      // Only OVERRIDE the joystick when keyboard is actively pressed —
      // a mobile user using both shouldn't have keys clobber thumb input.
      if (hasMovementKey(k)) {
        targetDirRef.current.x = x;
        targetDirRef.current.y = y;
      } else if (
        useGameStore.getState().joystickVelocity.x === 0 &&
        useGameStore.getState().joystickVelocity.y === 0
      ) {
        targetDirRef.current.x = 0;
        targetDirRef.current.y = 0;
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (!enabledRef.current) return;
      // Don't grab input while the user is typing into a chat box etc.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      const code = e.code;
      switch (code) {
        case 'KeyW':
          keysRef.current.w = true;
          recomputeDirFromKeys();
          e.preventDefault();
          break;
        case 'ArrowUp':
          keysRef.current.arrowUp = true;
          recomputeDirFromKeys();
          e.preventDefault();
          break;
        case 'KeyA':
          keysRef.current.a = true;
          recomputeDirFromKeys();
          e.preventDefault();
          break;
        case 'ArrowLeft':
          keysRef.current.arrowLeft = true;
          recomputeDirFromKeys();
          e.preventDefault();
          break;
        case 'KeyS':
          keysRef.current.s = true;
          recomputeDirFromKeys();
          e.preventDefault();
          break;
        case 'ArrowDown':
          keysRef.current.arrowDown = true;
          recomputeDirFromKeys();
          e.preventDefault();
          break;
        case 'KeyD':
          keysRef.current.d = true;
          recomputeDirFromKeys();
          e.preventDefault();
          break;
        case 'ArrowRight':
          keysRef.current.arrowRight = true;
          recomputeDirFromKeys();
          e.preventDefault();
          break;
        case 'Space':
          spaceHeldRef.current = true;
          if (isReefRaceRef.current) {
            // Round 9 Reef binding. Round 10 can reclaim Space by changing
            // this one branch; Shift remains the stable jump fallback.
            actionBitsRef.current |= ACTION_BIT_JUMP;
          } else {
            actionBitsRef.current |= ACTION_BIT_BOOST;
            // Capture immediately so even short taps register on the next send.
            oneShotBitsRef.current |= ACTION_BIT_BOOST;
          }
          e.preventDefault();
          break;
        case 'KeyQ':
          if (isReefRaceRef.current && e.repeat) {
            e.preventDefault();
            break;
          }
          oneShotBitsRef.current |= isReefRaceRef.current
            ? ACTION_BIT_BOOST
            : ACTION_BIT_USE_POWERUP;
          e.preventDefault();
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          shiftHeldRef.current = true;
          actionBitsRef.current |= ACTION_BIT_JUMP;
          break;
        default:
          break;
      }
    }

    recomputeDirFromKeysRef.current = recomputeDirFromKeys;

    function onKeyUp(e: KeyboardEvent) {
      // We unset key state regardless of `enabled` — otherwise toggling the
      // gate mid-keypress can leave a phantom direction.
      switch (e.code) {
        case 'KeyW':
          keysRef.current.w = false;
          recomputeDirFromKeys();
          break;
        case 'ArrowUp':
          keysRef.current.arrowUp = false;
          recomputeDirFromKeys();
          break;
        case 'KeyA':
          keysRef.current.a = false;
          recomputeDirFromKeys();
          break;
        case 'ArrowLeft':
          keysRef.current.arrowLeft = false;
          recomputeDirFromKeys();
          break;
        case 'KeyS':
          keysRef.current.s = false;
          recomputeDirFromKeys();
          break;
        case 'ArrowDown':
          keysRef.current.arrowDown = false;
          recomputeDirFromKeys();
          break;
        case 'KeyD':
          keysRef.current.d = false;
          recomputeDirFromKeys();
          break;
        case 'ArrowRight':
          keysRef.current.arrowRight = false;
          recomputeDirFromKeys();
          break;
        case 'Space':
          spaceHeldRef.current = false;
          if (isReefRaceRef.current) {
            if (!shiftHeldRef.current) {
              actionBitsRef.current &= ~ACTION_BIT_JUMP;
            }
          } else {
            actionBitsRef.current &= ~ACTION_BIT_BOOST;
          }
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          shiftHeldRef.current = false;
          if (!isReefRaceRef.current || !spaceHeldRef.current) {
            actionBitsRef.current &= ~ACTION_BIT_JUMP;
          }
          break;
        default:
          break;
      }
    }

    /**
     * Clear all key + held-action state. Called on window blur and
     * `visibilitychange→hidden` because browsers stop firing `keyup` once
     * focus leaves the window — a key held when the user alt-tabs / clicks
     * DevTools / Cmd+Tab to another app stays `true` forever, then later
     * releases produce a stranded "no input" → server zeroes thrust →
     * kart freezes mid-track. Same pattern as `npc-controller.tsx` and
     * `player-avatar.tsx`.
     */
    function resetHeldInput() {
      keysRef.current.w = false;
      keysRef.current.a = false;
      keysRef.current.s = false;
      keysRef.current.d = false;
      keysRef.current.arrowUp = false;
      keysRef.current.arrowLeft = false;
      keysRef.current.arrowDown = false;
      keysRef.current.arrowRight = false;
      actionBitsRef.current &= ~(ACTION_BIT_BOOST | ACTION_BIT_JUMP);
      spaceHeldRef.current = false;
      shiftHeldRef.current = false;
      targetDirRef.current = { x: 0, y: 0 };
      // Audit fix (S7) — also zero the SMOOTHED dir and any PENDING one-shot.
      // On a focus-loss reset the send loop would otherwise keep smoothing from
      // the stale dirRef for several ticks (kart drifts after alt-tab), and a
      // queued one-shot (boost / use-powerup) would fire on refocus.
      dirRef.current = { x: 0, y: 0 };
      oneShotBitsRef.current = 0;
      reefBrakeRef.current = false;
    }
    /** Power-up alt: left-click anywhere on the viewport → use. */
    function onPointerDown(e: MouseEvent) {
      if (!enabledRef.current) return;
      // Only main button, no modifiers — Shift+click could be a future
      // re-bind for "aim".
      if (e.button !== 0) return;
      // Don't fire when clicking the HUD chrome — those elements set
      // pointer-events:auto and stop propagation, but a defensive check
      // keeps unrelated click targets safe.
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-hud-interactive="true"]')) return;
      oneShotBitsRef.current |= isReefRaceRef.current
        ? ACTION_BIT_BOOST
        : ACTION_BIT_USE_POWERUP;
    }

    /** Mobile B-button → power-up. Provided as a window event so the
     *  mobile controls overlay can dispatch it via
     *  `window.dispatchEvent(new CustomEvent('clawville:activity-action', { detail: { bit: ACTION_BIT_USE_POWERUP } }))`. */
    function onCustomAction(e: Event) {
      if (!enabledRef.current) return;
      const detail = (e as CustomEvent<{ bit?: number }>).detail;
      if (typeof detail?.bit === 'number') {
        if (isReefRaceRef.current) {
          // Shared mobile controls dispatch Bumper semantics: A=bit0, B=bit1.
          // Translate at the Reef boundary so A jumps and B uses the item.
          if (detail.bit === ACTION_BIT_BOOST) {
            oneShotBitsRef.current |= ACTION_BIT_JUMP;
          } else if (detail.bit === ACTION_BIT_USE_POWERUP) {
            oneShotBitsRef.current |= ACTION_BIT_BOOST;
          }
        } else {
          oneShotBitsRef.current |= detail.bit;
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('clawville:activity-action', onCustomAction as EventListener);
    // S7 — release held input on focus loss/regain via the shared util (covers
    // blur + visibilitychange + focus + pageshow). Replaces the local blur/visibility.
    const unregisterReset = registerInputReset(resetHeldInput);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener(
        'clawville:activity-action',
        onCustomAction as EventListener,
      );
      unregisterReset();
      // Reset key state on teardown to prevent leak across remounts.
      keysRef.current = {
        w: false,
        a: false,
        s: false,
        d: false,
        arrowUp: false,
        arrowLeft: false,
        arrowDown: false,
        arrowRight: false,
      };
      actionBitsRef.current = 0;
      oneShotBitsRef.current = 0;
      dirRef.current = { x: 0, y: 0 };
      targetDirRef.current = { x: 0, y: 0 };
      reefBrakeRef.current = false;
      spaceHeldRef.current = false;
      shiftHeldRef.current = false;
    };
  }, []);

  // ── 30 Hz send loop ─────────────────────────────────────────────────────
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    timer = setInterval(() => {
      if (!enabledRef.current) return;
      // Reef keyboard intent is heading-relative: refresh it every send tick
      // while held. Key events still recompute too for immediate onset/release.
      if (isReefRaceRef.current && hasMovementKey(keysRef.current)) {
        recomputeDirFromKeysRef.current();
      }
      const now = Date.now();
      const dt = lastSendAtRef.current ? (now - lastSendAtRef.current) / 1000 : 0;
      lastSendAtRef.current = now;
      const frameDt = dt > 0 && dt < 0.2 ? dt : SEND_INTERVAL_MS / 1000;

      // Combine held bits with one-shot bits. Bumper holds bit-0 boost; Reef
      // holds bit-2 jump and fires bit-0 item use for a single send tick.
      const rawBits = actionBitsRef.current | oneShotBitsRef.current;
      // Reef bit 1 is reserved. Mask it defensively even if a future custom
      // action source dispatches raw bits instead of semantic A/B values.
      const bits = isReefRaceRef.current
        ? rawBits & ~ACTION_BIT_USE_POWERUP
        : rawBits;
      oneShotBitsRef.current = 0;

      const targetDir = targetDirRef.current;
      const targetMag = Math.hypot(targetDir.x, targetDir.y);
      if (isReefRaceRef.current) {
        const current = dirRef.current;
        // Crisper steering for the v2 surf model (2026-06-01): moving 11→22,
        // centering 18→30. Keeps an exp-filter so the sent dir (and the
        // identical client-predicted dir) don't jitter, but the lag between a
        // keypress and the kart leaning is roughly halved. Both the wire value
        // and the prediction read this same smoothed dir, so they stay in sync.
        const responsePerSec = targetMag > 0.001 ? 22 : 30;
        const alpha = 1 - Math.exp(-responsePerSec * frameDt);
        const nextX = current.x + (targetDir.x - current.x) * alpha;
        const nextY = current.y + (targetDir.y - current.y) * alpha;
        const nextMag = Math.hypot(nextX, nextY);
        if (targetMag <= 0.001 && nextMag < 0.015) {
          current.x = 0;
          current.y = 0;
        } else {
          current.x = nextX;
          current.y = nextY;
        }
      } else {
        dirRef.current.x = targetDir.x;
        dirRef.current.y = targetDir.y;
      }

      const dir = dirRef.current;
      const dirMag = Math.hypot(dir.x, dir.y);
      const moving = dirMag > 0.015;

      seqRef.current = (seqRef.current + 1) >>> 0;

      // Thrust derives from joystick magnitude when moving — analog mobile
      // input + WASD (which writes a unit vector) both produce sensible
      // values. Boost overrides to full thrust regardless of stick deflection.
      // Previously thrust was ONLY set on boost, which made joystick + WASD
      // alone send dir={x,y} with thrust=undefined → server clamped to 0 →
      // body never moved. That's why "the controls don't work" on mobile and
      // desktop alike — players had to hold the boost key to make the player
      // move at all.
      const braking = isReefRaceRef.current && reefBrakeRef.current;
      // S/ArrowDown is deliberately coast-only this round: preserve the
      // forward direction/steering but send zero thrust, even while boost is
      // held. A true active brake needs a server/protocol change.
      const sentThrust = braking
        ? 0
        : moving
          ? !isReefRaceRef.current && bits & ACTION_BIT_BOOST
            ? 1
            : Math.min(1, dirMag)
          : 0;

      // Publish the SAME smoothed dir/thrust to the self-input bus for the
      // self kart's client prediction (reef-race v2 only). Map sim {x,y} →
      // {x,z} (z = forward axis) to match SurfInput. dir=null + thrust=0 when
      // not moving — identical to what omitting `dir` on the wire means
      // server-side. Reading the SENT value (not the raw target) keeps the
      // predicted heading locked to what the server integrates.
      if (isReefRaceRef.current) {
        selfInputBus.dir = moving ? { x: dir.x, z: dir.y } : null;
        selfInputBus.thrust = moving ? sentThrust : 0;
        selfInputBus.valid = true;
      }

      const frame: ClientFrame = {
        type: 'input',
        seq: seqRef.current,
        dt,
        ...(moving ? { dir: { x: dir.x, y: dir.y }, thrust: sentThrust } : {}),
        ...(bits ? { actionBits: bits } : {}),
      };

      send(frame);
    }, SEND_INTERVAL_MS);

    return () => {
      if (timer) clearInterval(timer);
      lastSendAtRef.current = 0;
      // Clear the self-input bus so a stale dir/thrust can't drive prediction
      // after the input loop is gone (room exit, WS reconnect remount).
      resetSelfInputBus();
    };
  }, [send]);
}
