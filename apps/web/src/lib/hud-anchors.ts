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
