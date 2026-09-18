/**
 * hud-anchors.ts — stable DOM markers that let one HUD component MEASURE
 * another instead of hard-coding its size.
 *
 * Why a separate module rather than an export on the component: the avatar
 * status bar is loaded with `dynamic()` from the game page precisely so it sits
 * in its own chunk. A static import of a constant from that file would drag the
 * whole component (and its own imports) into every chunk that wants the marker,
 * which is exactly the kind of quiet bundle growth the project's #1
 * web-performance constraint exists to stop. A string constant costs nothing.
 *
 * Renaming any of these breaks the measurement SILENTLY (the querySelector just
 * finds nothing and the reader falls back to "nothing there"), so the marker and
 * every reader of it change in the same diff.
 */

/**
 * Marks the avatar status bar (`components/game/avatar-status-bar.tsx`), the
 * bottom-left identity/economy panel.
 *
 * Read by `components/game/quest-tracker.tsx`, which sits above it in the same
 * fixed left column and caps its expanded list to the room actually left. The
 * bar's height genuinely varies — the guest caption, the materials chip and the
 * skills row all come and go — so the tracker measures this element's live rect
 * and observes it for resizes instead of subtracting a guessed height.
 */
export const STATUS_BAR_HUD_ATTR = 'data-cv-hud-status-bar';

/** Spread onto the marked element: `<div {...STATUS_BAR_HUD_PROPS} />`. */
export const STATUS_BAR_HUD_PROPS: Record<string, string> = {
  [STATUS_BAR_HUD_ATTR]: '',
};

/**
 * Marks the minimap card (`components/game/minimap.tsx`), the top-left sonar.
 *
 * Read by `components/game/quest-tracker.tsx`, whose desktop panel sits
 * directly below it in the same fixed left column. The tracker used to assume
 * a 232 px card at a fixed `top`. The real card was 240 px, so the intended
 * 8 px gap was already gone, and a long location name in the card footer
 * wrapped to two lines and made it 252 px, so the tracker covered the footer
 * (founder-reported 2026-09-18, measured: card bottom 268 px vs tracker top
 * 256 px). The footer is now two fixed rows (card a constant 254 px,
 * measured) and the tracker measures this element's live bottom edge.
 */
export const MINIMAP_HUD_ATTR = 'data-cv-hud-minimap';

/** Spread onto the marked element: `<div {...MINIMAP_HUD_PROPS} />`. */
export const MINIMAP_HUD_PROPS: Record<string, string> = {
  [MINIMAP_HUD_ATTR]: '',
};

/**
 * Marks the fixed wrapper around the two touch joystick pads
 * (`components/game/mobile-controls.tsx`). Its top edge is the highest point the
 * movement pad reaches, INCLUDING the phone's safe area, because the wrapper is
 * lifted by `max(safe-area-inset-bottom + 60px, 80px)`.
 *
 * Read by `components/game/minimap.tsx`, which collapses to its header row when
 * the full card would reach down onto the pad (every phone held landscape). A
 * fixed viewport-height threshold could not see the safe area (Codex review,
 * 2026-09-18: 578 px is wrong by 14 px with a 34 px safe area), so the minimap
 * measures this element instead.
 */
export const JOYSTICK_ZONE_HUD_ATTR = 'data-cv-hud-joystick-zone';

/** Spread onto the marked element: `<div {...JOYSTICK_ZONE_HUD_PROPS} />`. */
export const JOYSTICK_ZONE_HUD_PROPS: Record<string, string> = {
  [JOYSTICK_ZONE_HUD_ATTR]: '',
};

/**
 * The joystick wrapper's geometry. ONE source for the wrapper itself
 * (mobile-controls) and for the minimap's stand-in that predicts where the
 * wrapper will be before its lazy chunk has loaded.
 *
 * The bottom lifts the pad above the iOS Safari toolbar and home-indicator
 * safe area (min 80 px so it stays clear without a safe area too).
 */
export const JOYSTICK_ZONE_BOTTOM_CSS = 'max(calc(env(safe-area-inset-bottom, 0px) + 60px), 80px)';
export const JOYSTICK_ZONE_HEIGHT_PX = 220;

/**
 * The mobile Hold-Jump button, positioned inside the joystick wrapper. ONE
 * source for the button (mobile-controls) and for the bottom prompt slot
 * (hooks/use-bottom-prompt-slot), which must clear it: on a 390 px phone the
 * centred 280 px prompt pill used to cover ~27 px of the button (2026-09-18).
 */
export const JUMP_BUTTON_BOTTOM_IN_ZONE_CSS = 'clamp(7rem, 38vw, 10.5rem)';
export const JUMP_BUTTON_RIGHT_CSS = 'max(calc(env(safe-area-inset-right, 0px) + 18px), 18px)';
export const JUMP_BUTTON_SIZE_PX = 64;

/**
 * Below this viewport width a centred bottom pill can reach the Jump button's
 * column: the pill is at most 420 px wide (half 210), the button reaches 82 px
 * in from the right edge (18 + 64), plus an 8 px gap: 2 x (210 + 8 + 82) = 600.
 * Every portrait phone is narrower; every landscape phone and iPad is wider.
 */
export const PROMPT_JUMP_CLASH_MAX_VW_PX = 600;

// ---------------------------------------------------------------------------
// Explicit registration.
//
// A reader that only runs `querySelector` misses an element that mounts AFTER
// it first looked, or that unmounts and remounts (the joystick wrapper does,
// every time the chat hides the controls). Components that other HUD pieces
// measure register their element here from a STABLE ref callback, and readers
// subscribe, so a mount, unmount or remount always re-triggers the reader.
// Plain module state: no imports, so it stays free for every chunk.
// ---------------------------------------------------------------------------
const hudElements = new Map<string, HTMLElement>();
const hudListeners = new Map<string, Set<() => void>>();

function notifyHud(attr: string): void {
  hudListeners.get(attr)?.forEach((listener) => listener());
}

/**
 * Register `el` as THE element for `attr` and notify readers. Returns an
 * ownership-aware cleanup that removes the entry only while `el` is still the
 * registered element, so a stale owner can never clear a newer one (last
 * registration wins; each attr is meant to have one owner at a time).
 *
 * Built to be RETURNED from a React 19 ref callback, which then runs it on
 * unmount instead of calling the ref with null.
 */
export function registerHudElement(attr: string, el: HTMLElement): () => void {
  hudElements.set(attr, el);
  notifyHud(attr);
  return () => {
    if (hudElements.get(attr) !== el) return;
    hudElements.delete(attr);
    notifyHud(attr);
  };
}

/** The currently registered element for `attr`, or null. */
export function getHudElement(attr: string): HTMLElement | null {
  return hudElements.get(attr) ?? null;
}

/** Call `listener` on every register/unregister of `attr`. Returns unsubscribe. */
export function subscribeHudElement(attr: string, listener: () => void): () => void {
  let set = hudListeners.get(attr);
  if (!set) {
    set = new Set();
    hudListeners.set(attr, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
  };
}
