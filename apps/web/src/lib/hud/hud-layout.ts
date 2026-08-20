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
 *
 * Slice 2 (2026-08-20) fixed D2 (`nori-button.tsx` going icon-only on
 * mobile) and added `GAME_HUD` below: a registry binding every /game fixed
 * HUD element's CURRENT literal to a named layer, WITHOUT touching any of
 * their values — converting 15+ files from Tailwind z-classes to inline
 * `HUD_Z` reads was explicitly rejected (zero visual change intended, real
 * regression risk, other sessions actively edit these files). `seatedGameHud`
 * (50) and `overlay` (51) are reused here by VALUE COINCIDENCE with the
 * cove ladder above, not by category — most of `/game`'s top-of-stack HUD
 * (banners, toggles, toasts, tutorial CTAs, language control, support
 * launcher, perf HUD) happens to already sit at z-50/51 for reasons
 * unrelated to cove seated play. A future slice may want a more generic
 * name for that tier; renaming an already-shipped key is out of scope here.
 * `worldHudRaised` (41) and `worldHudExpanded` (42) are new — verified live
 * against the two files that document them (`avatar-status-bar.tsx`,
 * `quest-tracker.tsx`) rather than assumed from the Slice 2 brief, which had
 * approximated the status bar at 40; it is actually 41, one step above
 * `worldHud`, by explicit design (see that file's own comment).
 */

export const HUD_Z = {
  /** Cove interior banner and other in-world decoration overlays. */
  worldDecoration: 30,
  /** Minimap, Nori button, quest tracker (base), mobile joystick band, email-verify banner, thought log. */
  worldHud: 40,
  /** Avatar status bar — one deliberate step above `worldHud`; wins its rare overlap with the quest tracker's collapsed state (see `avatar-status-bar.tsx`). */
  worldHudRaised: 41,
  /** Quest tracker's expanded-state escape above `worldHudRaised`, so its own rows stay reachable on short windows (see `quest-tracker.tsx` `desktopZ`). */
  worldHudExpanded: 42,
  /** Joystick bands + interact/jump buttons. */
  touchInput: 45,
  /** In-world seated action HUDs (e.g. the seated hold'em action panel); also the value most of `/game`'s top-of-stack chrome happens to share — see Slice 2 note above. */
  seatedGameHud: 50,
  /** Interact button, floating prompts. */
  overlay: 51,
  /** Emote hotbar — sits above ordinary HUD chrome, below game modals. */
  hotbar: 110,
  /** Full game modals (slots / blackjack / hold'em / baccarat). */
  gameModal: 9990,
} as const;

export type HudZLayer = keyof typeof HUD_Z;

/**
 * Registry of every /game fixed-position HUD element's CURRENT z literal,
 * bound to a named `HUD_Z` layer — Slice 2's answer to "convert everything
 * to inline styles" (rejected, see above). `file` is relative to
 * `apps/web/src` (matches the `@/` alias). `expectedZ` mirrors
 * `HUD_Z[layer]` exactly; the two are asserted equal by the regression test
 * so an edit to one without the other fails loudly instead of drifting.
 *
 * `form` documents which literal syntax `__tests__/hud-layout.test.tsx`
 * should find in `file` for this entry (`class` = Tailwind `z-N` /
 * `z-[N]`, `style` = inline `zIndex: N`, `css` = a `.css`/`.module.css`
 * `z-index: N` rule) — informational only; the test's matcher accepts
 * whichever form is actually present.
 */
export interface GameHudEntry {
  file: string;
  name: string;
  layer: HudZLayer;
  expectedZ: number;
  form: 'class' | 'style' | 'css';
  note?: string;
}

export const GAME_HUD: readonly GameHudEntry[] = [
  { file: 'components/game/minimap.tsx', name: 'minimap', layer: 'worldHud', expectedZ: HUD_Z.worldHud, form: 'class' },
  { file: 'components/game/nori-button.tsx', name: 'nori-button', layer: 'worldHud', expectedZ: HUD_Z.worldHud, form: 'class' },
  {
    file: 'components/game/quest-tracker.tsx',
    name: 'quest-tracker (mobile pill + desktop base)',
    layer: 'worldHud',
    expectedZ: HUD_Z.worldHud,
    form: 'class',
  },
  {
    file: 'components/game/quest-tracker.tsx',
    name: 'quest-tracker (desktop expanded escape, overlapsStatusBar)',
    layer: 'worldHudExpanded',
    expectedZ: HUD_Z.worldHudExpanded,
    form: 'class',
    note: 'Only renders while expanded AND the measured band is too short — see desktopZ.',
  },
  {
    file: 'components/game/avatar-status-bar.tsx',
    name: 'avatar-status-bar',
    layer: 'worldHudRaised',
    expectedZ: HUD_Z.worldHudRaised,
    form: 'class',
    note: 'Slice 2 brief approximated this at 40; the live literal is z-[41] (STATUS_BAR_Z) — registered at its true value.',
  },
  {
    file: 'components/game/mobile-controls.tsx',
    name: 'mobile-controls (joystick band)',
    layer: 'worldHud',
    expectedZ: HUD_Z.worldHud,
    form: 'class',
  },
  { file: 'components/game/email-verify-banner.tsx', name: 'email-verify-banner', layer: 'worldHud', expectedZ: HUD_Z.worldHud, form: 'class' },
  {
    file: 'components/game/sidebar-menu.tsx',
    name: 'gear FAB (mobile)',
    layer: 'touchInput',
    expectedZ: HUD_Z.touchInput,
    form: 'style',
    note: 'Positioned top:72 assuming Nori is ~44px tall — see nori-button.tsx D2 fix.',
  },
  {
    file: 'app/(world)/game/page.tsx',
    name: 'agent-status banner (guest state; 6 mutually exclusive auth states share this z)',
    layer: 'seatedGameHud',
    expectedZ: HUD_Z.seatedGameHud,
    form: 'class',
  },
  { file: 'components/game/control-mode-toggle.tsx', name: 'control-mode-toggle', layer: 'seatedGameHud', expectedZ: HUD_Z.seatedGameHud, form: 'class' },
  { file: 'components/game/toast-notifications.tsx', name: 'toast-notifications', layer: 'seatedGameHud', expectedZ: HUD_Z.seatedGameHud, form: 'class' },
  { file: 'components/game/charge-bar.tsx', name: 'charge-bar', layer: 'seatedGameHud', expectedZ: HUD_Z.seatedGameHud, form: 'class' },
  { file: 'components/game/activity-feed.tsx', name: 'activity-feed', layer: 'seatedGameHud', expectedZ: HUD_Z.seatedGameHud, form: 'class' },
  {
    file: 'components/game/tutorial-overlay.tsx',
    name: 'tutorial-overlay (Controls button)',
    layer: 'seatedGameHud',
    expectedZ: HUD_Z.seatedGameHud,
    form: 'class',
  },
  { file: 'components/game/game-language-control.tsx', name: 'game-language-control', layer: 'seatedGameHud', expectedZ: HUD_Z.seatedGameHud, form: 'class' },
  {
    file: 'components/support/SupportLauncher.tsx',
    name: 'SupportLauncher (floating variant)',
    layer: 'seatedGameHud',
    expectedZ: HUD_Z.seatedGameHud,
    form: 'style',
  },
  { file: 'components/game/perf-hud.tsx', name: 'perf-hud', layer: 'seatedGameHud', expectedZ: HUD_Z.seatedGameHud, form: 'class' },
  { file: 'components/game/emote-hotbar.tsx', name: 'emote-hotbar', layer: 'hotbar', expectedZ: HUD_Z.hotbar, form: 'class' },
] as const;

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
