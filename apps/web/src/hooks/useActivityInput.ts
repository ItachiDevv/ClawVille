'use client';

/**
 * useActivityInput — captures keyboard + mobile-joystick input for the
 * active Bumper Shells room and sends `{type:'input'}` frames at ~30 Hz.
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
 * Action bits (16-bit packed):
 *   bit 0 — boost (Space)
 *   bit 1 — power-up use (Q OR click-on-viewport)
 *   bit 2 — jump (Shift)
 *
 * Note on bit 2: the live ellipse Reef Race sim still consumes this bit as
 * DRIFT (semantic owned server-side). The Reef Race v2 spline sim — gated by
 * `REEF_RACE_USE_SPLINE=true` — consumes the same bit as JUMP. Same Shift
 * binding, same wire format; only the server-side semantic differs. This
 * rename reflects the v2 spec ("Jump Mechanic — NEW") while keeping the
 * client wire-compatible with the live ellipse sim. See
 * `.claude/plans/reef-race-v2.md` "Drift Mechanic — RETIRED" + "Jump
 * Mechanic — NEW" sections.
 */

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import type { ClientFrame } from '@clawville/shared';
import { useGameStore } from '@/stores/game';
import { useActivityStore } from '@/stores/activity';
import { registerInputReset } from '@/lib/three/input-reset';
import {
  selfInputBus,
  resetSelfInputBus,
} from '@/lib/three/activities/reef-race/reef-race-self-bus';

export const ACTION_BIT_BOOST = 1 << 0;
export const ACTION_BIT_USE_POWERUP = 1 << 1;
/**
 * Bit 2 — Shift key. Live ellipse Reef Race sim consumes as DRIFT; v2 spline
 * sim consumes as JUMP. Same wire bit, server picks the semantic from the
 * `REEF_RACE_USE_SPLINE` env flag. Renamed from `ACTION_BIT_DRIFT` for the
 * v2 rebuild — see `.claude/plans/reef-race-v2.md`.
 */
export const ACTION_BIT_JUMP = 1 << 2;

const SEND_INTERVAL_MS = 1000 / 30;

export interface UseActivityInputOptions {
  /** WS send fn returned by `useActivityWs`. */
  send: (frame: ClientFrame) => boolean;
  /** Master gate — false suppresses ALL input (HUD overlays etc.). */
  enabled: boolean;
}

export function useActivityInput({ send, enabled }: UseActivityInputOptions): void {
  // Per-input mutable state. Stored in refs to avoid React re-renders
  // and keep the keyboard handlers stable across the session.
  const dirRef = useRef({ x: 0, y: 0 });
  const targetDirRef = useRef({ x: 0, y: 0 });
  const keysRef = useRef<{
    w: boolean;
    a: boolean;
    s: boolean;
    d: boolean;
    arrowUp: boolean;
    arrowLeft: boolean;
    arrowDown: boolean;
    arrowRight: boolean;
  }>({
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
  //   W/S = thrust forward / backward in the kart's CURRENT facing direction
  //   A/D = steering bias (slight side push so the server's atan2 yaws the
  //         kart left/right while still moving forward)
  //
  // Bumper Shells uses a top-down camera where world-axis = screen-axis, so
  // there's no disconnect — keep its existing world-axis WASD (legacy path).
  //
  // We detect the active activity from the URL path because the input hook is
  // mounted by the activity page wrapper which knows the activity id, but the
  // hook itself doesn't currently take it as a prop. Adding the prop would
  // ripple through every caller; the path check is one-line.
  const pathname = usePathname() ?? '';
  const isReefRace = pathname.includes('/activity/reef-race/');
  const isReefRaceRef = useRef(isReefRace);
  isReefRaceRef.current = isReefRace;

  // Kart-relative-controls state. Only read in Reef Race mode.
  // headingRef mirrors the server-authoritative entity.rot of the self avatar so
  // the input loop computes "forward" against the latest rot the server saw.
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
        targetDirRef.current = { x: s.joystickVelocity.x, y: s.joystickVelocity.y };
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

      if (isReefRace) {
        // ─── Mario Kart-style kart-relative controls ───────────────────
        // Compute "forward" (kart's current facing) and "right" (perpendicular)
        // unit vectors in sim-space.
        //
        // Server convention: body.rot = atan2(intent.dir.x, intent.dir.y).
        // So at rot=h, the unit forward vector in sim-space is
        //   (sin(h), cos(h))     — same parameterization as server uses.
        // Right (90° clockwise of forward) is
        //   (cos(h), -sin(h))    — 2D rotation by -π/2 of the forward vector.
        //
        // W/S contribute thrust along ±forward.
        // A/D contribute a SMALL side bias (TURN_BIAS) along ±right. The bias
        // is intentionally small so the server's atan2-snap yaws the kart by
        // only a few degrees per tick — i.e., it acts like a steering rate, not
        // a hard 90° pivot. Held A while moving = continuous gentle left turn.
        //
        // TURN_BIAS = tan(per-tick yaw angle). Arrow steering is tracked
        // separately so A+Left / D+Right can turn harder without making
        // default WASD steering twitchy.
        const TURN_BIAS = 0.12;
        const ARROW_TURN_BIAS = 0.18;
        const h = headingRef.current;
        const fwdX = Math.sin(h);
        const fwdY = Math.cos(h);
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
        const rightX = Math.cos(h);
        const rightY = -Math.sin(h);
        const thrust =
          (k.w || k.arrowUp ? 1 : 0) - (k.s || k.arrowDown ? 1 : 0);
        // A = +1 (will bias along +right vec → screen-LEFT yaw)
        // D = -1 (biases along -right vec → screen-RIGHT yaw)
        const keyTurn = (k.a ? 1 : 0) - (k.d ? 1 : 0);
        const arrowTurn = (k.arrowLeft ? 1 : 0) - (k.arrowRight ? 1 : 0);
        const turnBias =
          keyTurn * TURN_BIAS + arrowTurn * ARROW_TURN_BIAS;
        x = fwdX * thrust + rightX * turnBias;
        y = fwdY * thrust + rightY * turnBias;
        // Edge case — only A or D held with no W/S: synthesize forward thrust
        // so the kart yaws (Mario Kart rule: can't steer in place, but the
        // input shouldn't feel dead).
        if (thrust === 0 && turnBias !== 0) {
          x = fwdX * 0.15 + rightX * turnBias;
          y = fwdY * 0.15 + rightY * turnBias;
        }
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
      if (
        k.w ||
        k.a ||
        k.s ||
        k.d ||
        k.arrowUp ||
        k.arrowLeft ||
        k.arrowDown ||
        k.arrowRight
      ) {
        targetDirRef.current = { x, y };
      } else if (
        useGameStore.getState().joystickVelocity.x === 0 &&
        useGameStore.getState().joystickVelocity.y === 0
      ) {
        targetDirRef.current = { x: 0, y: 0 };
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
          actionBitsRef.current |= ACTION_BIT_BOOST;
          // Capture immediately so even short taps register on the next send.
          oneShotBitsRef.current |= ACTION_BIT_BOOST;
          e.preventDefault();
          break;
        case 'KeyQ':
          oneShotBitsRef.current |= ACTION_BIT_USE_POWERUP;
          e.preventDefault();
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          actionBitsRef.current |= ACTION_BIT_JUMP;
          break;
        default:
          break;
      }
    }

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
          actionBitsRef.current &= ~ACTION_BIT_BOOST;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          actionBitsRef.current &= ~ACTION_BIT_JUMP;
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
     * `player-avatar.tsx`. One-shot bits intentionally untouched.
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
      // Held bits only — boost / jump (Shift). One-shot use-powerup is consumed
      // on send and harmless to leave alone here.
      actionBitsRef.current &= ~(ACTION_BIT_BOOST | ACTION_BIT_JUMP);
      targetDirRef.current = { x: 0, y: 0 };
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
      oneShotBitsRef.current |= ACTION_BIT_USE_POWERUP;
    }

    /** Mobile B-button → power-up. Provided as a window event so the
     *  mobile controls overlay can dispatch it via
     *  `window.dispatchEvent(new CustomEvent('clawville:activity-action', { detail: { bit: ACTION_BIT_USE_POWERUP } }))`. */
    function onCustomAction(e: Event) {
      if (!enabledRef.current) return;
      const detail = (e as CustomEvent<{ bit?: number }>).detail;
      if (typeof detail?.bit === 'number') {
        oneShotBitsRef.current |= detail.bit;
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
    };
  }, []);

  // ── 30 Hz send loop ─────────────────────────────────────────────────────
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    timer = setInterval(() => {
      if (!enabledRef.current) return;
      const now = Date.now();
      const dt = lastSendAtRef.current ? (now - lastSendAtRef.current) / 1000 : 0;
      lastSendAtRef.current = now;
      const frameDt = dt > 0 && dt < 0.2 ? dt : SEND_INTERVAL_MS / 1000;

      // Combine sticky bits (boost held) with one-shot bits (Q/click).
      const bits = actionBitsRef.current | oneShotBitsRef.current;
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
        dirRef.current =
          targetMag <= 0.001 && nextMag < 0.015
            ? { x: 0, y: 0 }
            : { x: nextX, y: nextY };
      } else {
        dirRef.current = targetDir;
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
      const thrust = moving
        ? bits & ACTION_BIT_BOOST
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
        selfInputBus.thrust = moving ? thrust : 0;
        selfInputBus.valid = true;
      }

      const frame: ClientFrame = {
        type: 'input',
        seq: seqRef.current,
        dt,
        ...(moving ? { dir: { x: dir.x, y: dir.y }, thrust } : {}),
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
