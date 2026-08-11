'use client';

/**
 * use-bottom-prompt-slot.ts — the ONE authority over the bottom-centre prompt
 * slot.
 *
 * THREE components render a fixed pill at `zIndex: 45`, horizontally centred,
 * at the same vertical offset:
 *   • `location-hud.tsx`        — the building / talk prompt
 *   • `land-options-pill.tsx`   — the parcel pill
 *   • `land/salvage-gather-pill.tsx` — the salvage gather pill
 *
 * They used to keep out of each other's way with three hand-written suppression
 * rules that had already drifted apart: the parcel pill yielded to a building,
 * the salvage pill yielded to a building OR a parcel, and the building prompt
 * knew nothing about either of the other two. That is a class of bug where a
 * single added condition silently double-stacks two pills on top of each other.
 *
 * So the decision moved HERE. `resolveBottomPromptOwner` returns at most one
 * owner for the slot, and each component renders only when it is that owner.
 * Mutual exclusion is then a property of the code rather than of three
 * comments agreeing with each other.
 *
 * PRIORITY (founder-approved 2026-08-10)
 * --------------------------------------
 *   1. A parcel the viewer OWNS. Standing on your own lot, "Manage / Decorate"
 *      is what you came for; the generic "Press E" building prompt is not.
 *   2. A building / character in range.
 *   3. Any other parcel in range (available, or held by someone else).
 *   4. A salvage node in range — the slot's fallback claimant.
 *
 * Only rule 1 is new. Every other proximity combination resolves exactly the
 * way the three separate rules already did.
 *
 * MODAL SUPPRESSION is the union of what the three components each checked, so
 * the building prompt now also yields while the Land Office modal or the yard
 * editor is open. Those surfaces own the screen while they are up, and letting
 * the building prompt through was the remaining way two prompts could be
 * on screen at once.
 *
 * NOTE — an owner here is a CLAIM on the slot, not a promise that something
 * renders. A component still bails on its own content checks (an unknown
 * building id, a `reserved`/`retired` parcel, an unknown salvage node). That is
 * deliberate: it preserves today's behaviour exactly, and "at most one" holds
 * either way.
 */

import { useAvatar } from '@/hooks/use-avatar';
import { useGameStore, type ControlMode, type GameState } from '@/stores/game';
import { useLandStore } from '@/stores/land';

export type BottomPromptOwner = 'building' | 'parcel' | 'salvage' | null;

export interface BottomPromptSlotInput {
  readonly controlMode: ControlMode;
  /** Building / teacher chat panel. */
  readonly chatOpen: boolean;
  /** Nori (system agent) chat panel. */
  readonly guideChatOpen: boolean;
  readonly landOfficeOpen: boolean;
  /** True while the yard editor holds the screen. */
  readonly buildModeOpen: boolean;
  readonly nearLocation: string | null;
  readonly nearParcelCode: string | null;
  /** `nearParcelCode` is owned by the avatar looking at the screen. */
  readonly nearParcelOwnedByViewer: boolean;
  readonly nearSalvageNodeId: string | null;
}

/** Pure — the whole priority table lives here and nowhere else. */
export function resolveBottomPromptOwner(
  input: BottomPromptSlotInput,
): BottomPromptOwner {
  // Explore is a free-flying spectator with no body to act with.
  if (input.controlMode === 'explore') return null;
  // A panel that owns the screen wins over every proximity prompt.
  if (input.chatOpen || input.guideChatOpen) return null;
  if (input.landOfficeOpen || input.buildModeOpen) return null;

  if (input.nearParcelCode && input.nearParcelOwnedByViewer) return 'parcel';
  if (input.nearLocation) return 'building';
  if (input.nearParcelCode) return 'parcel';
  if (input.nearSalvageNodeId) return 'salvage';
  return null;
}

/**
 * Live slot owner. Every bottom-centre prompt calls this and renders only when
 * the answer names it.
 *
 * `useAvatar` is the shared `['avatar']` query, so the two components that did
 * not already read it add no network round trip. The ownership check is a
 * zustand SELECTOR returning a boolean, so a parcel-map update only re-renders
 * a prompt when the answer actually flips.
 */
export function useBottomPromptOwner(): BottomPromptOwner {
  const controlMode = useGameStore((s: GameState) => s.controlMode);
  const chatOpen = useGameStore((s: GameState) => s.chatOpen);
  const guideChatOpen = useGameStore((s: GameState) => s.guideChatOpen);
  const landOfficeOpen = useGameStore((s: GameState) => s.landOfficeOpen);
  const nearLocation = useGameStore((s: GameState) => s.nearLocation);
  const nearParcelCode = useGameStore((s: GameState) => s.nearParcelCode);
  const nearSalvageNodeId = useGameStore((s: GameState) => s.nearSalvageNodeId);
  const buildModeOpen = useLandStore((s) => s.buildMode !== null);
  const { data: avatar } = useAvatar();
  const viewerAvatarId =
    (avatar as { id?: string } | null | undefined)?.id ?? null;
  const nearParcelOwnedByViewer = useLandStore((s) => {
    if (!nearParcelCode || !viewerAvatarId) return false;
    const state = s.parcels.get(nearParcelCode);
    return state?.status === 'owned' && state.ownerAvatarId === viewerAvatarId;
  });

  return resolveBottomPromptOwner({
    controlMode,
    chatOpen,
    guideChatOpen,
    landOfficeOpen,
    buildModeOpen,
    nearLocation,
    nearParcelCode,
    nearParcelOwnedByViewer,
    nearSalvageNodeId,
  });
}

/**
 * The reserve, in px, that the mobile lift is allowed to leave BELOW the top of
 * the viewport. Derived, not guessed:
 *
 *   • the control-mode toggle sits at `top: 5rem` and is ~30px tall
 *     (`components/game/control-mode-toggle.tsx`), so it owns y 80..110 at
 *     `z-index: 50` — ABOVE this slot's `z-index: 45`, which means anything
 *     that lands there is not merely ugly, it is UN-TAPPABLE;
 *   • the tallest prompt in the slot (the parcel pill, two lines of text plus
 *     a 44px button row) measures ~123px;
 *   • plus a small breathing gap.
 *
 * 110 + 123 + 27 = 260.
 */
const MOBILE_PROMPT_TOP_RESERVE_PX = 260;

/**
 * The mobile FLOOR — character-identical to the joystick host's own anchor in
 * `components/game/mobile-controls.tsx`, on purpose. Below this the pill is in
 * the band the joystick host and the iOS home indicator / Safari toolbar own,
 * so it is not merely ugly, it is untappable.
 */
const MOBILE_PROMPT_FLOOR =
  'max(calc(env(safe-area-inset-bottom, 0px) + 60px), 80px)';

/**
 * The lift the slot WANTS on a tall screen: clear of the joystick zone with the
 * pill fully in view.
 */
const MOBILE_PROMPT_DESIRED_LIFT =
  'max(calc(env(safe-area-inset-bottom, 0px) + 220px), 240px)';

/**
 * The shared vertical offset for the slot.
 *
 * This formula used to be copy-pasted into all three prompts under a comment
 * asking the next editor to keep them character-identical by hand. It is one
 * function now, so they cannot drift.
 *
 * Desktop lifts above the avatar chat bar (~54px) when one is mounted, which
 * is player/autonomous mode only. Mobile is bounded at BOTH ends.
 *
 * UPPER BOUND — SHORT-VIEWPORT CLAMP (2026-08-10). The mobile lift used to be a
 * FIXED 240px, which on a landscape phone (844x390) pushed the pill's top edge
 * to y=27, straight under the control-mode toggle, which wins the hit test
 * because it stacks higher. A live `elementFromPoint` on both of the pill's
 * buttons returned the toggle, so Manage and Decorate were physically
 * un-tappable in that orientation. `min(..., 100dvh - 260px)` caps the lift.
 *
 * LOWER BOUND — the fix for the cap itself. `100dvh - 260px` is UNBOUNDED
 * BELOW: at a 240px-tall viewport it evaluates to -20px (part of the pill off
 * the bottom of the screen), and around 280px with a real bottom inset it lands
 * inside the unsafe area. So the cap is wrapped in `max(FLOOR, ...)`, which
 * also encodes the tie-break: when the two bounds cannot both be satisfied the
 * SAFE floor wins and the pill accepts sitting under the control-mode toggle,
 * because a pill in the unsafe area cannot be pressed at all while one under
 * the toggle only loses the overlapping part.
 *
 * Resolved values (bottom inset 0 / 34):
 *   240dvh → 80 / 94   (cap is negative; the floor wins)
 *   280dvh → 80 / 94   (cap is 20; the floor wins)
 *   390dvh → 130 / 130 (the cap wins: the intended landscape-phone fix)
 *   844dvh → 240 / 254 (the desired lift, exactly as before)
 */
export function bottomPromptOffset(
  isMobile: boolean,
  controlMode: ControlMode,
): string {
  const hasBottomChatBar =
    controlMode === 'player' || controlMode === 'autonomous';
  return isMobile
    ? `max(${MOBILE_PROMPT_FLOOR}, min(${MOBILE_PROMPT_DESIRED_LIFT}, calc(100dvh - ${MOBILE_PROMPT_TOP_RESERVE_PX}px)))`
    : `calc(env(safe-area-inset-bottom, 0px) + ${hasBottomChatBar ? 84 : 36}px)`;
}
