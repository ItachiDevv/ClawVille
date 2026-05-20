'use client';

/**
 * WildMultiplierBadge — Phase 6.1.5
 *
 * Small chip rendered on top of a landed Wild symbol cell on the 5×3 reel
 * grid. Shows the per-Wild multiplier ("2x", "3x", "5x", "4x", "6x", "10x").
 * Pulses for 700ms on land (`cv-stop-pop` style scale) then settles to
 * a steady-state glow.
 *
 * Positioning model — caller-renders-inside-grid-container:
 *   This component does NOT compute reel-grid pixel offsets. It absolute-
 *   positions itself using its `reelIndex` / `rowIndex` props as CSS-grid-
 *   like math against `--slot-cell-size` (set on :root by SlotScreenModal's
 *   media-query block). The caller MUST render `<WildMultiplierBadge ...>`
 *   inside the same `position: relative` parent as the reel grid AND match
 *   the same GAP/padding used by SlotReels.
 *
 *   Math (mirrors SlotReels constants):
 *     cell = var(--slot-cell-size, 80px)
 *     gap  = 6px
 *     reel-pad = 4px (inside each reel column)
 *     grid-pad = var(--cv-space-2) (outer reel-grid wrapper)
 *     reel-x  = grid-pad + reelIndex * (cell + gap)
 *     row-y   = grid-pad + reel-pad + rowIndex * (cell + gap)
 *
 *   Then the badge sits at the TOP-RIGHT of that cell. We use percentage-
 *   based bottom/right inside a cell-sized wrapper so the badge stays
 *   pinned regardless of the responsive --slot-cell-size scaling done in
 *   SlotScreenModal's media-queries.
 *
 * Iris Xe safe: pure DOM/CSS, no Three.js, no per-frame allocations.
 * Honors `prefers-reduced-motion` via the casino-tokens.css media-query
 * which collapses `--cv-motion-base` to 0ms.
 */

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);
  return reduced;
}

const REEL_COUNT = 5;
const ROW_COUNT = 3;
const GAP_PX = 6;
const REEL_INNER_PAD_PX = 4;
/**
 * Outer grid padding — matches `padding: var(--cv-space-2)` in SlotReels'
 * outer container. `--cv-space-2` resolves to 8px in casino-tokens.css.
 * Hardcoding the resolved value keeps this overlay decoupled from CSS-var
 * arithmetic that doesn't compose well inside calc() chains.
 */
const GRID_OUTER_PAD_PX = 8;

export interface WildMultiplierBadgeProps {
  /** 0..4 (left to right). */
  reelIndex: number;
  /** 0..2 (top to bottom). */
  rowIndex: number;
  /** Per-Wild multiplier (e.g. 2, 3, 5). */
  multiplier: number;
  /**
   * Stable key fragment that flips when this badge represents a new
   * landed spin's wild (typically `spinCount`). Used to re-trigger the
   * pulse keyframe on each fresh land.
   */
  triggerId?: number;
  /**
   * Phase 6.1.5 RTP-shape decision: in BASE mode the multiplier is
   * RECORDED on the wire (the engine still draws it deterministically)
   * but does NOT amplify line wins. The UI renders this as a "potential"
   * chip — dimmed, outlined, no glow — so the player can see the value
   * the wild WOULD have contributed in free-spin mode without claiming
   * it was applied to the current win.
   *
   * In FS mode (`mode === 'free-spin'`), the engine DOES apply the
   * multiplier to any line whose matchLen prefix crosses this cell.
   * Render the chip ACTIVE — full saturation, amber glow, pulse on
   * land.
   *
   * Default `false` (ACTIVE), so callers that don't yet pass the prop
   * keep the legacy glowing visual.
   */
  dimmed?: boolean;
}

export default function WildMultiplierBadge({
  reelIndex,
  rowIndex,
  multiplier,
  triggerId = 0,
  dimmed = false,
}: WildMultiplierBadgeProps) {
  const [pulsed, setPulsed] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      setPulsed(false);
      return;
    }
    setPulsed(true);
    const t = setTimeout(() => setPulsed(false), 700);
    return () => clearTimeout(t);
  }, [triggerId, reelIndex, rowIndex, multiplier, reduced]);

  // Clamp defensively — out-of-range coords would render off-screen
  // overlays that look like ghost confetti.
  if (
    reelIndex < 0 ||
    reelIndex >= REEL_COUNT ||
    rowIndex < 0 ||
    rowIndex >= ROW_COUNT ||
    !Number.isFinite(multiplier) ||
    multiplier <= 1
  ) {
    return null;
  }

  const cellExpr = 'var(--slot-cell-size, 80px)';
  const leftExpr = `calc(${GRID_OUTER_PAD_PX}px + ${reelIndex} * (${cellExpr} + ${GAP_PX}px))`;
  const topExpr = `calc(${GRID_OUTER_PAD_PX}px + ${REEL_INNER_PAD_PX}px + ${rowIndex} * (${cellExpr} + ${GAP_PX}px))`;

  const cellWrapStyle: CSSProperties = {
    position: 'absolute',
    left: leftExpr,
    top: topExpr,
    width: cellExpr,
    height: cellExpr,
    pointerEvents: 'none',
    zIndex: 6,
  };

  const chipStyle: CSSProperties = dimmed
    ? {
        // BASE-mode "potential" — outlined brass on tobacco, no glow.
        position: 'absolute',
        top: 4,
        right: 4,
        minWidth: 30,
        padding: '3px 7px',
        background: 'rgba(31, 14, 21, 0.65)',
        color: 'var(--pt-cream-soft)',
        fontFamily: 'var(--pt-data)',
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: '0.04em',
        textAlign: 'center',
        border: '1.5px dashed var(--pt-brass-dim)',
        opacity: 0.85,
      }
    : {
        // FS-mode ACTIVE — amber fill on velvet, scale-pulse on land.
        position: 'absolute',
        top: 4,
        right: 4,
        minWidth: 30,
        padding: '3px 7px',
        background: 'linear-gradient(180deg, var(--pt-amber-glow) 0%, var(--pt-amber) 100%)',
        color: 'var(--pt-velvet)',
        fontFamily: 'var(--pt-data)',
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textAlign: 'center',
        boxShadow:
          '0 0 12px rgba(255, 174, 0, 0.85), 0 0 22px rgba(255, 204, 68, 0.45), inset 0 1px 0 rgba(255,233,200,0.45)',
        border: '1px solid var(--pt-brass)',
        transform: pulsed ? 'scale(1.18)' : 'scale(1)',
        transition: reduced ? 'none' : 'transform 700ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        animation: pulsed && !reduced ? 'cv-stop-pop 600ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
      };

  const ariaLabel = dimmed
    ? `Wild ${multiplier}x potential (free-spin only)`
    : `Wild multiplier ${multiplier}x`;

  return (
    <div aria-hidden style={cellWrapStyle}>
      <div role="img" aria-label={ariaLabel} style={chipStyle}>
        {multiplier}x
      </div>
    </div>
  );
}
