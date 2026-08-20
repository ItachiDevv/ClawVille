/**
 * Shared HUD slot map — single source of truth for fixed/absolute UI
 * z-layers and the shared bottom touch-control band geometry.
 *
 * Added Slice 1 (2026-08-20) to fix D1: the cove had its own touch-control
 * component that never yielded to an active game surface (full-width
 * joystick zones at z 50, ABOVE the seated poker HUD at z 40), so a seated
 * phone player's taps on the action panel were swallowed by the joystick
 * and dragged their avatar instead. `/game`'s mobile-controls avoids this
 * by honouring the `movementFrozen` capability mask and using 220px corner
 * zones that leave the bottom-centre free — the cove now adopts both.
 *
 * `seatedGameHud` deliberately outranks `touchInput`: a seated player is
 * not walking, so the action HUD must win any overlap. Everything added
 * below `gameModal` must pick a named layer from this ladder rather than a
 * raw z-index number — that per-area drift is exactly what produced D1.
 *
 * NOTE: `hud-layout.ts` is a plain TS module — it cannot be imported into a
 * `.module.css` file. Sites that layer via CSS (e.g.
 * `SeatedHoldemHud.module.css`) must keep their literal z-index numerically
 * in sync with the matching `HUD_Z` value by hand; the regression test in
 * `__tests__/hud-layout.test.tsx` guards that correspondence.
 */

export const HUD_Z = {
  /** Cove interior banner and other in-world decoration overlays. */
  worldDecoration: 30,
  /** Minimap, avatar status bar, quest tracker, thought log, activity mobile controls. */
  worldHud: 40,
  /** Joystick bands + interact/jump buttons. */
  touchInput: 45,
  /** In-world seated action HUDs (e.g. the seated hold'em action panel). */
  seatedGameHud: 50,
  /** Interact button, floating prompts. */
  overlay: 51,
  /** Full game modals (slots / blackjack / hold'em / baccarat). */
  gameModal: 9990,
} as const;

export type HudZLayer = keyof typeof HUD_Z;

/**
 * Bottom touch-control band geometry, shared by every touch-control
 * component so a future device-safe-area tweak only needs one edit.
 */
export const TOUCH_BAND = {
  bottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 60px), 80px)',
  height: '220px',
  /** Corner zone edge. `/game` uses this; the cove adopts it too (D1 fix). */
  zoneSize: '220px',
} as const;
