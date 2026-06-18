/**
 * input-reset.ts — centralized "release all held input" on focus loss/regain.
 *
 * The 3D world has several INDEPENDENT held-input vectors: player WASD
 * (player-avatar.tsx), NPC WASD (npc-controller.tsx), jump SPACE (jump-state.ts),
 * arrow-key camera orbit + WASD camera pan (World3DCanvas.tsx), and the mobile
 * joysticks (mobile-controls.tsx). Each used to manage its own window blur /
 * visibilitychange listeners — and new vectors kept shipping WITHOUT a reset.
 *
 * S7 (staging): a window stealing focus mid-move left the avatar/camera stuck
 * "moving" — the browser skips `keyup` when focus leaves the window, so a held
 * key stays `true` forever. The pre-existing per-module blur resets covered only
 * player/NPC WASD; the explore-mode camera pan, arrow orbit and jump SPACE had
 * none, and `blur` doesn't always fire when a popup opens OVER the page.
 *
 * This module owns ONE set of window listeners and fans out to every registered
 * reset callback, so a held key/stick can never strand after a focus change:
 *   - 'blur'             — focus left the window (alt-tab, popup over the game)
 *   - 'visibilitychange' — tab hidden (covers cases `blur` misses on some browsers)
 *   - 'focus' / 'pageshow' — focus REGAINED: you can't legitimately hold a key you
 *                          pressed while unfocused; if it's still physically held,
 *                          the browser's key auto-repeat re-asserts it within ~1 frame.
 *
 * Register from any input module; the returned fn unregisters (call it on unmount
 * for component-scoped vectors). Module-level always-on vectors register once and
 * never unregister.
 */

type ResetCb = () => void;

const _callbacks = new Set<ResetCb>();
let _attached = false;

function _fireAll(): void {
  // A single throwing reset must not block the others.
  for (const cb of _callbacks) {
    try { cb(); } catch { /* swallow — one bad reset can't strand the rest */ }
  }
}

function _onVisibility(): void {
  if (typeof document !== 'undefined' && document.hidden) _fireAll();
}

function _attachOnce(): void {
  if (_attached || typeof window === 'undefined') return;
  _attached = true;
  window.addEventListener('blur', _fireAll);
  window.addEventListener('focus', _fireAll);
  window.addEventListener('pageshow', _fireAll);
  document.addEventListener('visibilitychange', _onVisibility);
}

/**
 * Register a reset callback fired whenever the window loses or regains focus.
 * @returns an unregister fn (call on unmount for component-scoped callbacks).
 */
export function registerInputReset(cb: ResetCb): () => void {
  _attachOnce();
  _callbacks.add(cb);
  return () => { _callbacks.delete(cb); };
}

/** Manually release all held input (e.g. before opening a focus-grabbing modal). */
export function resetAllHeldInputs(): void {
  _fireAll();
}
