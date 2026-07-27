/**
 * jump-state.ts — module-scoped jump physics state for ClawVille.
 *
 * Zustand is deliberately avoided for jump state. Per-frame set() at 60 Hz
 * would re-render every subscribed component (HUD, minimap, modals). This
 * mirrors the existing `keyState` object in player-avatar.tsx:74-78.
 *
 * The SPACE keyboard listener lives here, co-located with the state it writes.
 * Mobile controls call setJumpPressed() so touch input uses the same state
 * machine as SPACE. updateJump() is called once per frame by <JumpTicker />.
 * Consumers (player-avatar, arena-npcs, FPSFollowCamera) read jumpState.heightOffset
 * and jumpState.phase directly.
 */

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

import { registerInputReset } from './input-reset';
import { addStageWindowListener } from '@/components/three/world-stage/stage-store';

export type JumpPhase = 'grounded' | 'charging' | 'quick' | 'launch' | 'sinking' | 'quicksink';

/**
 * ChargeMode discriminates walk/idle (squat wind-up) vs run (skip squat) paths.
 * Set by player-avatar.tsx on the rising edge of 'charging' phase;
 * reset to 'none' when charging ends. arena-npcs.tsx reads it too.
 */
export type ChargeMode = 'none' | 'squat' | 'run';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---- Tap (quick jump) — unchanged from prior spec ----
/** ms — tap-vs-charge-release cutoff. Releases shorter than this = quick jump. */
export const JUMP_TAP_THRESHOLD_MS = 200;
/** wu/s — initial velocity for a quick tap-jump. Peak ≈ 120²/(2·220) ≈ 33 wu. */
export const JUMP_QUICK_VZ0 = 120;
/** wu/s² — gravity during tap-jump ascent+descent. */
export const JUMP_QUICK_GRAVITY = -220;

// ---- Charged jump (new) ----
/** ms — full-charge hold duration. Auto-launches at this point if still held. */
export const JUMP_MAX_HOLD_MS = 1500;
/** wu/s — initial vz when release happens just past the tap threshold (minimal charge). Peak ≈ 100²/(2·160) ≈ 31 wu — matches the ~33 wu tap peak so there's no visible step across the 200ms threshold. */
export const JUMP_MIN_CHARGED_VZ = 100;
/** wu/s — initial vz at full charge. Peak ≈ 700²/(2·160) ≈ 1531 wu (~1.9× building height). */
export const JUMP_MAX_CHARGED_VZ = 700;
/** wu/s² — gravity during charged-jump ascent. Lighter than tap so peak reaches the intended altitude. */
export const JUMP_ASCENT_GRAVITY = -160;

// ---- Quick-sink (mid-air SPACE drops avatar at constant velocity) ----
/** wu/s — constant descent velocity during quicksink. Mid-air SPACE drops the avatar at this rate.
 *  From 1500wu peak → ~2.5s landing. Horizontal WASD still works during quicksink. */
export const JUMP_QUICKSINK_VZ = -600;

// ---- Sink (underwater float) ----
/** wu/s² — gentle sink gravity (unchanged). */
export const JUMP_SINK_GRAVITY = -45;
/** wu/s — terminal sink speed. Bumped from -55 → -150 so descents from the new 1500wu max peak complete in ~12 s instead of 20+. */
export const JUMP_SINK_TERMINAL = -150;

// ---------------------------------------------------------------------------
// Module-scoped state object
// ---------------------------------------------------------------------------

export const jumpState = {
  phase:           'grounded' as JumpPhase,
  vz:              0,          // wu/sec, positive = up
  heightOffset:    0,          // wu above the ground-plane sampling point (>= 0)
  playerAltitude:  0,          // persistent swim altitude (wu, >= 0). Accumulated by input
                               // controllers from camera-forward Y component. Separate from
                               // heightOffset (jump arc) — both stack at render time.
  holdMs:          0,          // time SPACE has been continuously held this press
  chargeProgress:  0,          // 0..1, written each frame while charging — charge-bar.tsx reads this
  lastSpaceDown:   false,      // rising-edge detector
  spaceDown:       false,      // keydown/keyup listener writes this
  /**
   * Set by player-avatar.tsx on the rising edge of 'charging' to differentiate
   * walk/idle (squat wind-up, feet stay planted) from run (skip squat, keep running).
   * Reset to 'none' when charging ends or on resetJump().
   *
   * 'squat' → apply squat surfaceClip + halt horizontal movement
   * 'run'   → skip squat surfaceClip + continue running through charge
   * 'none'  → not in charging phase (or NPC mode which doesn't discriminate)
   */
  chargeMode:      'none' as ChargeMode,
};

// ---------------------------------------------------------------------------
// Helper — returns true if the event target is an editable text element.
// Used to prevent WASD/SPACE from being swallowed while typing in a chat input.
// ---------------------------------------------------------------------------

export function isEditable(t: EventTarget | null): boolean {
  if (!t) return false;
  const el = t as HTMLElement;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Keyboard listener — idempotent, server-safe
// ---------------------------------------------------------------------------

export function attachJumpListeners(): (() => void) | undefined {
  if (typeof window === 'undefined') return;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== 'Space') return;
    if (isEditable(e.target)) return;
    jumpState.spaceDown = true;
    // Suppress page scroll only when a controllable avatar is active
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useGameStore } = require('@/stores/game') as typeof import('@/stores/game');
    const mode = useGameStore.getState().controlMode;
    if (mode === 'player' || mode === 'npc') {
      e.preventDefault();
    }
  };

  // NOTE: keyup intentionally has NO target guard — it must always clear spaceDown
  // so SPACE doesn't get stranded true when the user taps into an input mid-jump.
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      jumpState.spaceDown = false;
    }
  };

  const removeKeyDown = addStageWindowListener('keydown', onKeyDown);
  const removeKeyUp = addStageWindowListener('keyup', onKeyUp);
  // Release a held SPACE on focus loss/regain so the charge/jump doesn't strand
  // when a window steals focus mid-hold (browser skips keyup). See S7. Clears
  // ONLY the input flags — never the airborne/altitude physics in resetJump().
  const unregisterReset = registerInputReset(resetJumpInput);
  return () => {
    removeKeyDown();
    removeKeyUp();
    unregisterReset();
    resetJumpInput();
  };
}

/**
 * S7 — release held-SPACE input on window focus loss/regain.
 *
 * If we ONLY cleared spaceDown, the next updateJump() 'charging' branch would see
 * `!spaceDown` and fire the release path — an UNINTENDED quick/charged jump just
 * from a popup stealing focus. So when mid-charge we cancel the charge back to
 * grounded. AIRBORNE physics (phase launch/sinking/quick + heightOffset +
 * playerAltitude) is intentionally left intact — a focus blip mid-arc must not
 * teleport the avatar to the ground.
 */
export function resetJumpInput(): void {
  jumpState.spaceDown = false;
  jumpState.lastSpaceDown = false;
  if (jumpState.phase === 'charging') {
    jumpState.phase = 'grounded';
    jumpState.vz = 0;
    jumpState.holdMs = 0;
    jumpState.chargeProgress = 0;
    jumpState.chargeMode = 'none';
  }
}

export function setJumpPressed(pressed: boolean): void {
  jumpState.spaceDown = pressed;
}

// ---------------------------------------------------------------------------
// Physics tick — called once per frame by <JumpTicker />
// ---------------------------------------------------------------------------

export function updateJump(rawDt: number): void {
  const dt = Math.min(rawDt, 0.1);
  const spaceDown = jumpState.spaceDown;
  const risingEdge = spaceDown && !jumpState.lastSpaceDown;
  jumpState.lastSpaceDown = spaceDown;

  // Accumulate hold time only while held — DO NOT reset on release, or the
  // release-classifier below reads holdMs=0 and always fires the tap path,
  // making charged-launch unreachable except via auto-launch at max hold.
  // holdMs is reset on the next rising edge when entering 'charging' below.
  if (spaceDown) jumpState.holdMs += dt * 1000;

  // Charge progress is only meaningful during 'charging' phase; zero out otherwise
  // so the charge bar hides cleanly.
  jumpState.chargeProgress = jumpState.phase === 'charging'
    ? Math.min(1, jumpState.holdMs / JUMP_MAX_HOLD_MS)
    : 0;

  // Mid-air quick-sink: pressing SPACE while airborne drops the avatar fast.
  // Takes precedence over any other phase transition this frame.
  // Not allowed during 'grounded' (enter 'charging' instead) or 'charging'.
  if (risingEdge && (jumpState.phase === 'quick'
                  || jumpState.phase === 'launch'
                  || jumpState.phase === 'sinking')) {
    jumpState.phase = 'quicksink';
    jumpState.vz = JUMP_QUICKSINK_VZ;
  }

  switch (jumpState.phase) {
    case 'grounded':
      if (risingEdge) {
        // Enter charging state — no vertical motion yet.
        // Reset holdMs here (on the new press) rather than on release; resetting
        // on release zeroed holdMs before the release-classifier could read it,
        // causing the tap branch to always fire regardless of actual hold duration.
        jumpState.phase = 'charging';
        jumpState.vz = 0;
        jumpState.holdMs = 0;
      }
      break;

    case 'charging':
      // While charging: avatar stays on ground, vz stays 0.
      if (!spaceDown) {
        // Released — fire quick or charged depending on how long held.
        if (jumpState.holdMs < JUMP_TAP_THRESHOLD_MS) {
          jumpState.phase = 'quick';
          jumpState.vz = JUMP_QUICK_VZ0;
        } else {
          // Charge progress scaled into the threshold..max window:
          // at holdMs=THRESHOLD → MIN_CHARGED_VZ, at holdMs=MAX → MAX_CHARGED_VZ
          const t = Math.min(1, (jumpState.holdMs - JUMP_TAP_THRESHOLD_MS) /
                             (JUMP_MAX_HOLD_MS - JUMP_TAP_THRESHOLD_MS));
          jumpState.phase = 'launch';
          // Interpolate vz² linearly so peak altitude = vz²/(2|g|) scales LINEARLY
          // with charge progress. Plain vz-linear lerp makes peak quadratic —
          // t=0.5 gave only 46% of max peak (≈706 wu instead of ≈863 wu), which
          // felt flat across the low-mid bar range. Square-root interp fixes the
          // perception without changing min/max endpoints.
          //
          // New peak-vs-charge table (JUMP_MIN_CHARGED_VZ=100 → matches ~33wu tap):
          //   0%  (just past 200ms) → vz=100  → peak ≈   31 wu
          //  25%                    → vz=360  → peak ≈  405 wu
          //  50%                    → vz=500  → peak ≈  781 wu
          //  75%                    → vz=608  → peak ≈ 1156 wu
          // 100% (1500ms)           → vz=700  → peak ≈ 1531 wu
          const vzMinSq = JUMP_MIN_CHARGED_VZ * JUMP_MIN_CHARGED_VZ;
          const vzMaxSq = JUMP_MAX_CHARGED_VZ * JUMP_MAX_CHARGED_VZ;
          jumpState.vz = Math.sqrt(vzMinSq + (vzMaxSq - vzMinSq) * t);
        }
      } else if (jumpState.holdMs >= JUMP_MAX_HOLD_MS) {
        // Auto-launch at max charge, even though user is still holding.
        jumpState.phase = 'launch';
        jumpState.vz = JUMP_MAX_CHARGED_VZ;
      }
      break;

    case 'quick':
      jumpState.vz += JUMP_QUICK_GRAVITY * dt;
      break;

    case 'launch':
      jumpState.vz += JUMP_ASCENT_GRAVITY * dt;
      if (jumpState.vz <= 0) {
        // Transition to sinking at apex — keep vz (not zeroed) so the arc is smooth
        // rather than a hard freeze. Sink gravity takes over from here.
        jumpState.phase = 'sinking';
      }
      break;

    case 'sinking':
      jumpState.vz += JUMP_SINK_GRAVITY * dt;
      jumpState.vz = Math.max(jumpState.vz, JUMP_SINK_TERMINAL);
      break;

    case 'quicksink':
      // Constant downward velocity. No gravity, no clamp — straight-line drop.
      jumpState.vz = JUMP_QUICKSINK_VZ;
      break;
  }

  if (jumpState.phase !== 'grounded' && jumpState.phase !== 'charging') {
    jumpState.heightOffset = Math.max(0, jumpState.heightOffset + jumpState.vz * dt);
    if (jumpState.heightOffset === 0 && jumpState.vz <= 0) {
      jumpState.phase = 'grounded';
      jumpState.vz = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Reset — called by Zustand actions on mode transitions and enterBuilding
// ---------------------------------------------------------------------------

export function resetJump(): void {
  jumpState.phase = 'grounded';
  jumpState.vz = 0;
  jumpState.heightOffset = 0;
  jumpState.playerAltitude = 0;
  jumpState.holdMs = 0;
  jumpState.chargeProgress = 0;
  jumpState.lastSpaceDown = false;
  jumpState.chargeMode = 'none';
  // NOTE: spaceDown is intentionally NOT reset here.
  // If the user holds SPACE across a mode transition, the listener's next keyup
  // will clear it. Clearing it here would desync if SPACE is physically held.
}
