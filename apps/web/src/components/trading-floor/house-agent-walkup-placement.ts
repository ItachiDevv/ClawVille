/**
 * house-agent-walkup-placement.ts
 *
 * Where the P15 walk-up panel sits on screen, as a pure function of the
 * viewport, the projected anchor (the walk-up agent's chest point in CSS px,
 * written by T4) and the touch HUD. Spec: ops/house-traders/arena-review/
 * P15_PLAN_2026-10-02.md §3 "Placement".
 *
 * - Desktop and tablet: width 320, 28 px right of the anchor, flipped to the
 *   left when the right side overflows, 16 px margins, top >= 72 (below "Back
 *   to World"), vertically centred on the anchor.
 * - Touch (`useIsMobile()`): the bottom stays above the joystick band and the
 *   panel never covers the USE button. The band numbers come from the SAME
 *   resolver the touch HUD's CSS mirrors (`trading-floor-touch-layout.ts`), so
 *   the safe-area inset the browser sweep cannot produce is covered by the
 *   unit sweep in the test.
 * - Anchor off screen or behind the camera: docked at the nearest side edge,
 *   middle height.
 * - Phone width < 600: the anchor is ignored; a compact card docks at top
 *   centre (top 72, width min(92vw, 360)).
 *
 * The panel's own frame loop calls `placeHouseAgentWalkup` with ONE reused
 * output record (no allocation per frame) and writes `transform` only when
 * `houseAgentWalkupMoved` says the move is 0.5 px or more.
 */

import { resolveTradingFloorTouchLayout, TOUCH_LAYOUT } from './trading-floor-touch-layout';

export const HOUSE_AGENT_WALKUP_LAYOUT = Object.freeze({
  panelWidth: 320,
  /** Horizontal gap between the anchor and the panel edge. */
  anchorGap: 28,
  /** Clearance from every viewport edge. */
  margin: 16,
  /** The panel top never comes above this: "Back to World" sits at 16..60. */
  topMin: 72,
  /** Viewports narrower than this get the compact card. */
  phoneMaxWidth: 600,
  compactMaxWidth: 360,
  compactViewportFraction: 0.92,
  /** Touch: clearance above the joystick band and beside / above the USE button. */
  touchGap: 8,
  /** The USE button's CSS `right` in TradingFloorMobileControls.tsx (pinned by the test). */
  useRight: 24,
  /** The frame loop rewrites `transform` only on a move of at least this many px. */
  moveEpsilon: 0.5,
});

export type HouseAgentWalkupPlacementMode = 'beside' | 'docked' | 'compact';

export interface HouseAgentWalkupPlacementInput {
  viewportWidth: number;
  viewportHeight: number;
  /** CSS px of the projected anchor. */
  anchorX: number;
  anchorY: number;
  /** False when the anchor is off screen or behind the camera. */
  anchorOnScreen: boolean;
  /** The panel's rendered height in px. */
  panelHeight: number;
  /** `useIsMobile()`: the joystick band and the USE button are on screen. */
  touch: boolean;
  /** `env(safe-area-inset-bottom)` in px (0 when unknown). */
  safeAreaBottom: number;
}

export interface HouseAgentWalkupPlacement {
  mode: HouseAgentWalkupPlacementMode;
  side: 'right' | 'left' | 'center';
  left: number;
  top: number;
  width: number;
  /** Cap for the panel height; the panel body scrolls inside it. */
  maxHeight: number;
}

export function createHouseAgentWalkupPlacement(): HouseAgentWalkupPlacement {
  return { mode: 'beside', side: 'right', left: 0, top: 0, width: HOUSE_AGENT_WALKUP_LAYOUT.panelWidth, maxHeight: 0 };
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function placeHouseAgentWalkup(
  input: HouseAgentWalkupPlacementInput,
  out: HouseAgentWalkupPlacement = createHouseAgentWalkupPlacement(),
): HouseAgentWalkupPlacement {
  const L = HOUSE_AGENT_WALKUP_LAYOUT;
  const vw = Math.max(0, finiteOr(input.viewportWidth, 0));
  const vh = Math.max(0, finiteOr(input.viewportHeight, 0));
  const panelHeight = Math.max(0, finiteOr(input.panelHeight, 0));

  // The lowest y the panel bottom may reach, and the USE button column.
  let bandLimit = vh - L.margin;
  let useLimit = bandLimit;
  let useColumnLeft = Number.POSITIVE_INFINITY;
  if (input.touch) {
    const touch = resolveTradingFloorTouchLayout(vh, Math.max(0, finiteOr(input.safeAreaBottom, 0)));
    bandLimit = Math.min(bandLimit, touch.bandTop - L.touchGap);
    useLimit = Math.min(bandLimit, touch.useTop - L.touchGap);
    useColumnLeft = vw - L.useRight - TOUCH_LAYOUT.useSize - L.touchGap;
  }

  if (vw < L.phoneMaxWidth) {
    const width = Math.min(vw * L.compactViewportFraction, L.compactMaxWidth);
    const left = (vw - width) / 2;
    // Docked top centre it cannot step aside, so it ends above the USE button.
    const limit = left + width > useColumnLeft ? useLimit : bandLimit;
    out.mode = 'compact';
    out.side = 'center';
    out.left = left;
    out.top = L.topMin;
    out.width = width;
    out.maxHeight = Math.max(0, limit - L.topMin);
    return out;
  }

  const width = L.panelWidth;
  // On touch the panel stays left of the USE column, so it only has to clear the band.
  const rightEdge = input.touch ? Math.min(vw - L.margin, useColumnLeft) : vw - L.margin;
  const maxLeft = Math.max(L.margin, rightEdge - width);
  const maxHeight = Math.max(0, bandLimit - L.topMin);
  const shown = Math.min(panelHeight, maxHeight);
  const maxTop = bandLimit - shown;

  const ax = input.anchorX;
  const ay = input.anchorY;
  const onScreen =
    input.anchorOnScreen && Number.isFinite(ax) && Number.isFinite(ay) && ax >= 0 && ax <= vw && ay >= 0 && ay <= vh;

  out.width = width;
  out.maxHeight = maxHeight;
  if (!onScreen) {
    const leftSide = Number.isFinite(ax) && ax < vw / 2;
    out.mode = 'docked';
    out.side = leftSide ? 'left' : 'right';
    out.left = leftSide ? L.margin : maxLeft;
    out.top = clamp(vh / 2 - shown / 2, L.topMin, maxTop);
    return out;
  }

  const rightPlace = ax + L.anchorGap;
  const leftPlace = ax - L.anchorGap - width;
  out.mode = 'beside';
  if (rightPlace <= maxLeft) {
    out.side = 'right';
    out.left = rightPlace;
  } else if (leftPlace >= L.margin) {
    out.side = 'left';
    // An anchor inside the touch USE column would put the flipped panel over
    // the button; keep it left of the column (the gap to the anchor grows).
    out.left = Math.min(leftPlace, maxLeft);
  } else {
    // Neither side fits whole: take the roomier side and clamp into the margins.
    const roomRight = rightEdge - ax;
    const roomLeft = ax - L.margin;
    out.side = roomRight >= roomLeft ? 'right' : 'left';
    out.left = clamp(out.side === 'right' ? rightPlace : leftPlace, L.margin, maxLeft);
  }
  out.top = clamp(ay - shown / 2, L.topMin, maxTop);
  return out;
}

/** True when either axis moved by the write threshold or more (or nothing was written yet). */
export function houseAgentWalkupMoved(fromLeft: number, fromTop: number, toLeft: number, toTop: number): boolean {
  const eps = HOUSE_AGENT_WALKUP_LAYOUT.moveEpsilon;
  return !(Math.abs(toLeft - fromLeft) < eps && Math.abs(toTop - fromTop) < eps);
}
