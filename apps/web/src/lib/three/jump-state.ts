/**
 * jump-state.ts — module-scoped jump physics state for ClawVille.
 *
 * Zustand is deliberately avoided for jump state. Per-frame set() at 60 Hz
 * would re-render every subscribed component (HUD, minimap, modals). This
 * mirrors the existing `keyState` object in player-avatar.tsx:74-78.
 *
 * The SPACE keyboard listener lives here, co-located with the state it writes.
 * updateJump() is called once per frame by <JumpTicker /> — nobody else calls it.
 * Consumers (player-avatar, arena-npcs, FPSFollowCamera) read jumpState.heightOffset
 * and jumpState.phase directly.
 */

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export type JumpPhase = 'grounded' | 'charging' | 'quick' | 'launch' | 'sinking';

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
/** wu/s — initial vz when release happens just past the tap threshold (minimal charge). Peak ≈ 250²/(2·160) ≈ 195 wu. */
export const JUMP_MIN_CHARGED_VZ = 250;
/** wu/s — initial vz at full charge. Peak ≈ 700²/(2·160) ≈ 1531 wu (~1.9× building height). */
export const JUMP_MAX_CHARGED_VZ = 700;
/** wu/s² — gravity during charged-jump ascent. Lighter than tap so peak reaches the intended altitude. */
export const JUMP_ASCENT_GRAVITY = -160;

// ---- Sink (underwater float) ----
/** wu/s² — gentle sink gravity (unchanged). */
export const JUMP_SINK_GRAVITY = -45;
/** wu/s — terminal sink speed. Bumped from -55 → -150 so descents from the new 1500wu max peak complete in ~12 s instead of 20+. */
export const JUMP_SINK_TERMINAL = -150;

// ---------------------------------------------------------------------------
// Module-scoped state object
// ---------------------------------------------------------------------------

export const jumpState = {
  phase:          'grounded' as JumpPhase,
  vz:             0,          // wu/sec, positive = up
  heightOffset:   0,          // wu above the ground-plane sampling point (>= 0)
  holdMs:         0,          // time SPACE has been continuously held this press
  chargeProgress: 0,          // 0..1, written each frame while charging — charge-bar.tsx reads this
  lastSpaceDown:  false,      // rising-edge detector
  spaceDown:      false,      // keydown/keyup listener writes this
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
  const dt = Math.min(rawDt, 0.1);
  const spaceDown = jumpState.spaceDown;

  jumpState.holdMs = spaceDown ? jumpState.holdMs + dt * 1000 : 0;
  const risingEdge = spaceDown && !jumpState.lastSpaceDown;
  jumpState.lastSpaceDown = spaceDown;

  // Charge progress is only meaningful during 'charging' phase; zero out otherwise
  // so the charge bar hides cleanly.
  jumpState.chargeProgress = jumpState.phase === 'charging'
    ? Math.min(1, jumpState.holdMs / JUMP_MAX_HOLD_MS)
    : 0;

  switch (jumpState.phase) {
    case 'grounded':
      if (risingEdge) {
        // Enter charging state — no vertical motion yet.
        jumpState.phase = 'charging';
        jumpState.vz = 0;
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
          jumpState.vz = JUMP_MIN_CHARGED_VZ + (JUMP_MAX_CHARGED_VZ - JUMP_MIN_CHARGED_VZ) * t;
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
  jumpState.holdMs = 0;
  jumpState.chargeProgress = 0;
  jumpState.lastSpaceDown = false;
  // NOTE: spaceDown is intentionally NOT reset here.
  // If the user holds SPACE across a mode transition, the listener's next keyup
  // will clear it. Clearing it here would desync if SPACE is physically held.
}
