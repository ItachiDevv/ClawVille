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
// The floor is 148 px, not 7rem: the camera joystick top is 140 px above the
// pad bottom (static, bottom 80, size 120), so a lower button overlapped it on
// phones narrower than 390 px (3 px at 360x780, measured 2026-09-18). At 390+
// 38vw is already >= 148, so those phones are unchanged.
export const JUMP_BUTTON_RIGHT_CSS = 'max(calc(env(safe-area-inset-right, 0px) + 18px), 18px)';
export const JUMP_BUTTON_SIZE_PX = 64;
/** Tallest prompt plus the mode toggle and their clearance. Shared with its cap. */
export const MOBILE_PROMPT_TOP_RESERVE_PX = 260;
/** Below 600 px a centred prompt can reach Jump's column (see below). */
export const PROMPT_JUMP_CLASH_MAX_VW_PX = 600;
const JUMP_BUTTON_DESIRED_BOTTOM_CSS = 'clamp(148px, 38vw, 10.5rem)';
// A narrow portrait screen must also fit the prompt above Jump. Above the
// width boundary the positive term removes this constraint. On 320x568 with
// inset 44 the available target is 48 px; all zero-inset targets stay 64 px.
const JUMP_BUTTON_PROMPT_SIZE_CAP_CSS =
  `max(44px, calc(100dvh - ${JOYSTICK_ZONE_BOTTOM_CSS} - ${JUMP_BUTTON_DESIRED_BOTTOM_CSS} - ${MOBILE_PROMPT_TOP_RESERVE_PX + 8}px + max(0px, (100vw - ${PROMPT_JUMP_CLASH_MAX_VW_PX - 1}px) * 1000)))`;
/**
 * Keep Jump below Nori (top >= 70) and above the camera joystick (140 px
 * above the zone bottom). A nonzero bottom inset lifts that joystick too.
 * Short screens can have less than 64 px between them: shrink toward 44 px,
 * reserving a 4 px gap when it fits. The 44 px floor takes priority if the
 * viewport cannot fit all controls; the supported 360 px height fits inset 44.
 */
export const JUMP_BUTTON_SIZE_CSS =
  `min(${JUMP_BUTTON_SIZE_PX}px, max(44px, calc(100dvh - ${JOYSTICK_ZONE_BOTTOM_CSS} - 214px)), ${JUMP_BUTTON_PROMPT_SIZE_CAP_CSS})`;
export const JUMP_BUTTON_BOTTOM_IN_ZONE_CSS =
  `min(${JUMP_BUTTON_DESIRED_BOTTOM_CSS}, calc(100dvh - ${JOYSTICK_ZONE_BOTTOM_CSS} - ${JUMP_BUTTON_SIZE_CSS} - 70px))`;

/** Short-screen Autonomous panel ends 8 px above the same camera joystick. */
export const SHORT_TOUCH_AUTONOMY_MAX_HEIGHT_CSS =
  `max(0px, calc(100dvh - ${JOYSTICK_ZONE_BOTTOM_CSS} - 218px))`;

/**
 * Below this viewport width a centred bottom pill can reach the Jump button's
 * column: the pill is at most 420 px wide (half 210), the button reaches 82 px
 * in from the right edge (18 + 64), plus an 8 px gap: 2 x (210 + 8 + 82) = 600.
 * Every portrait phone is narrower; every landscape phone and iPad is wider.
 */
// PROMPT_JUMP_CLASH_MAX_VW_PX above is shared by the target size and prompt.

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

// ---------------------------------------------------------------------------
// Short touch viewports (phones held landscape).
//
// The touch right column stacks Nori (top 16), the gear (72), Controls (128)
// and Language (184): 44 px buttons down to y 228. The Jump button top is
// vh - 80 (pad lift) - up to 168 (JUMP_BUTTON_BOTTOM_IN_ZONE_CSS) - 64, and
// the camera joystick top is vh - 220, so the stack clears Jump only from
// vh ~548 and the joystick from vh ~456. Measured 2026-09-18: at 844x390
// Jump covered the gear and Controls, and Controls + Language covered the
// camera joystick; at 932x430 Jump covered Controls. Below this height the
// three utility buttons form one row at the top. iPads (vh 744+) keep the
// column.
//
// Where the row goes: always at the LEFT, clear of the centred top stack (the
// guest login banner or the agent pill at y 12-52, the mode toggle at y
// 80-116, up to ~200 px wide; the phone quest card from y 124). Below `md`
// (768 px) the minimap is hidden, so the row takes the top line (x 16-168,
// clear of the banner from x 181 at 667 px). From 768 px it sits under the
// minimap header, which is always collapsed (bottom 63) on a short screen. A
// right-side row was rejected in review: a notched iPhone's 44-47 px landscape
// inset pushed it into the login banner or the logged-in mode toggle.
// ---------------------------------------------------------------------------
export const SHORT_TOUCH_MAX_VH = 560;
/**
 * From `md` (768 px wide) a screen also counts as short below this height:
 * there the full minimap card ends at y 282, and the capped Autonomous panel
 * under it keeps only vh - 562 px, less than its header + state (~96 px)
 * below 658 (Codex review 2026-09-18: 1024x562 got max-height 0). Narrower
 * screens (upright phones) are unaffected.
 */
export const SHORT_TOUCH_WIDE_MAX_VH = 658;
/** Below this width (the minimap's `md` breakpoint) the row takes the top line. */
export const SHORT_TOUCH_LEFT_ROW_MAX_VW = 768;
/** Row top below 768 px: the top line (same as Nori, top-4). */
export const SHORT_TOUCH_ROW_TOP_PX = 16;
/** Row top from 768 px: under the collapsed minimap header (bottom 63, + 8). */
export const SHORT_TOUCH_UNDER_MAP_TOP_PX = 71;
/** Row left offsets (px, added to the left safe-area inset); 44-46 px buttons, 8 px gaps. */
export const SHORT_TOUCH_ROW_LEFT_PX = { gear: 16, controls: 68, language: 122 } as const;

/**
 * Below `md` (768 px) the minimap card is hidden, and with it the only way to
 * the World Map. On touch there the minimap collapses to its Map button at
 * the left, top 72: under the centred login banner / agent pill (y 12-52) and
 * left of the centred mode toggle (y 80-116) and quest card (from y 124) on
 * upright phones; under the utility row (y 16-60) and above the left joystick
 * (top vh - 220) on small sideways phones (founder: "shouldn't we just be
 * able to adjust it", 2026-09-18).
 */
export const PHONE_MAP_BUTTON_TOP_PX = 72;
