/**
 * jump-state.ts — module-scoped jump physics state for ClawVille.
 *
 * Zustand is deliberately avoided for jump state. Per-frame set() at 60 Hz
 * would re-render every subscribed component (HUD, minimap, modals). This
 * mirrors the existing `keyState` object in player-pet.tsx:74-78.
 *
 * The SPACE keyboard listener lives here, co-located with the state it writes.
 * updateJump() is called once per frame by <JumpTicker /> — nobody else calls it.
 * Consumers (player-pet, arena-npcs, FPSFollowCamera) read jumpState.heightOffset
 * and jumpState.phase directly.
 */

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export type JumpPhase = 'grounded' | 'quick' | 'thrusting' | 'sinking';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** wu/s² — gravity during tap-jump ascent + descent. */
export const JUMP_GRAVITY_QUICK = -220;
/** wu/s — initial upward velocity for a quick-tap jump. Peak ≈ 120²/(2·220) ≈ 33 wu. Airtime ≈ 2·120/220 ≈ 1.09 s. */
export const JUMP_VZ0_QUICK = 120;
/** ms — tap-vs-hold cutoff. Presses shorter than this are tap-jumps; longer upgrades to power. */
export const JUMP_HOLD_THRESHOLD_MS = 200;
/** wu/s — sustained upward velocity while SPACE is held in thrusting phase. */
export const JUMP_THRUST_VZ = 280;
/** ms — max thrust duration (belt-and-suspenders; peak clamp usually fires first). */
export const JUMP_THRUST_MAX_MS = 1000;
/** wu — hard altitude ceiling. Keeps avatar below y=150 caustic atmosphere plane. */
export const JUMP_PEAK_CLAMP = 140;
/** wu/s² — gravity during underwater float-down (gentle sink). */
export const JUMP_GRAVITY_SINK = -45;
/** wu/s — terminal sink speed (clamped). From 140 wu peak: ~3.15 s total descent. */
export const JUMP_SINK_TERMINAL = -55;

// ---------------------------------------------------------------------------
// Module-scoped state object
// ---------------------------------------------------------------------------

export const jumpState = {
  phase:           'grounded' as JumpPhase,
  vz:              0,        // wu/sec, positive = up
  heightOffset:    0,        // wu above the ground-plane sampling point (>= 0)
  holdMs:          0,        // accumulated ms SPACE has been continuously held this jump
  thrustActivated: false,    // locks out second upgrade during current jump
  lastSpaceDown:   false,    // for rising-edge detection
  spaceDown:       false,    // written by the SPACE keyboard listener
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

let _jumpListenersAttached = false;

export function attachJumpListeners(): void {
  if (typeof window === 'undefined') return;
  if (_jumpListenersAttached) return;
  _jumpListenersAttached = true;

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

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
}

// ---------------------------------------------------------------------------
// Physics tick — called once per frame by <JumpTicker />
// ---------------------------------------------------------------------------

export function updateJump(rawDt: number): void {
  // Spike guard: matches player-pet.tsx:368
  const dt = Math.min(rawDt, 0.1);

  const spaceDown = jumpState.spaceDown;

  // Accumulate hold time only while key is physically held.
  // Reset to 0 on release so a new press starts fresh.
  jumpState.holdMs = spaceDown ? jumpState.holdMs + dt * 1000 : 0;

  const risingEdge = spaceDown && !jumpState.lastSpaceDown;
  jumpState.lastSpaceDown = spaceDown;

  switch (jumpState.phase) {
    case 'grounded':
      if (risingEdge) {
        jumpState.phase = 'quick';
        jumpState.vz = JUMP_VZ0_QUICK;
        jumpState.holdMs = 0;
        jumpState.thrustActivated = false;
      }
      break;

    case 'quick':
      if (spaceDown && !jumpState.thrustActivated && jumpState.holdMs > JUMP_HOLD_THRESHOLD_MS) {
        // Seamless upgrade from tap to power during ascent
        jumpState.phase = 'thrusting';
        jumpState.vz = JUMP_THRUST_VZ;
        jumpState.thrustActivated = true;
      } else {
        jumpState.vz += JUMP_GRAVITY_QUICK * dt;
      }
      break;

    case 'thrusting':
      // Hold vz at thrust speed — gravity does NOT apply during thrust phase
      jumpState.vz = JUMP_THRUST_VZ;
      if (
        !spaceDown ||
        jumpState.holdMs > JUMP_HOLD_THRESHOLD_MS + JUMP_THRUST_MAX_MS ||
        jumpState.heightOffset >= JUMP_PEAK_CLAMP
      ) {
        // Apex-freeze: snap vz to 0 rather than preserving +280 upward momentum.
        // Preserving would coast 871 wu upward before turning — catastrophic overshoot.
        jumpState.phase = 'sinking';
        jumpState.vz = 0;
      }
      break;

    case 'sinking':
      jumpState.vz += JUMP_GRAVITY_SINK * dt;
      jumpState.vz = Math.max(jumpState.vz, JUMP_SINK_TERMINAL);
      break;
  }

  // Integrate heightOffset (only while airborne)
  if (jumpState.phase !== 'grounded') {
    jumpState.heightOffset = Math.max(0, jumpState.heightOffset + jumpState.vz * dt);
    // Landing condition: touched ground and not still moving up
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
  jumpState.holdMs = 0;
  jumpState.thrustActivated = false;
  jumpState.lastSpaceDown = false;
  // NOTE: spaceDown is intentionally NOT reset here.
  // If the user holds SPACE across a mode transition, the listener's next keyup
  // will clear it. Clearing it here would desync if SPACE is physically held.
}
