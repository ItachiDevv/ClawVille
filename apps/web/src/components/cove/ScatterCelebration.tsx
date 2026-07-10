'use client';

/**
 * ScatterCelebration — Phase 6.1.5
 *
 * Sparkle burst overlay rendered on each scatter cell when a spin lands
 * 3+ scatters AND the spin awarded a scatter payout. Plus a "+N" pill
 * showing the scatter count.
 *
 * Like WildMultiplierBadge, this component absolute-positions itself
 * inside the reel-grid's `position: relative` parent using
 * `--slot-cell-size` math. The caller renders ONE ScatterCelebration per
 * scatter cell (cheap; max 15 cells).
 *
 * Lifecycle, given a flip of `triggerId` with non-empty `cells`:
 *   1. all sparkle bursts fire simultaneously (1200ms loop, 2 plays)
 *   2. counter pill fades in over 220ms, holds, then fades out at 2400ms
 *
 * Iris Xe safe: pure DOM/CSS, no Three.js, no per-frame allocations.
 * Honors `prefers-reduced-motion` by collapsing burst durations to 1ms
 * and dropping animation iterations.
 */

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

const REEL_COUNT = 5;
const ROW_COUNT = 3;
const GAP_PX = 6;
const REEL_INNER_PAD_PX = 4;
const GRID_OUTER_PAD_PX = 8;

/** Number of sparkle particles per scatter cell. */
const SPARKLES_PER_CELL = 6;
const SHOW_MS = 2400;

export interface ScatterCell {
  reelIndex: number;
  rowIndex: number;
}

export interface ScatterCelebrationProps {
  /** Cells where scatters landed. Empty array = render nothing. */
  cells: ScatterCell[];
  /** Total scatter count to surface in the "+N" counter pill. */
  scatterCount: number;
  /** Stake-scaled scatter payout (atomic units) — only used for aria-label. */
  scatterPayout?: bigint;
  /**
   * Increments every fresh land (typically `spinCount`). Restarts the
   * sparkle + counter cycle whenever this changes AND `cells.length > 0`.
   */
  triggerId: number;
}

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

function SparkleCell({
  reelIndex,
  rowIndex,
  triggerId,
  reduced,
}: ScatterCell & { triggerId: number; reduced: boolean }) {
  const cellExpr = 'var(--slot-cell-size, 80px)';
  const leftExpr = `calc(${GRID_OUTER_PAD_PX}px + ${reelIndex} * (${cellExpr} + ${GAP_PX}px))`;
  const topExpr = `calc(${GRID_OUTER_PAD_PX}px + ${REEL_INNER_PAD_PX}px + ${rowIndex} * (${cellExpr} + ${GAP_PX}px))`;

  const wrapStyle: CSSProperties = {
    position: 'absolute',
    left: leftExpr,
    top: topExpr,
    width: cellExpr,
    height: cellExpr,
    pointerEvents: 'none',
    zIndex: 7,
  };

  return (
    <div aria-hidden style={wrapStyle} data-trigger={triggerId}>
      {Array.from({ length: SPARKLES_PER_CELL }, (_, i) => {
        const sparkleStyle: Record<string, string | number> = {
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background:
            'radial-gradient(circle at 35% 30%, #fff3d2 0%, #ffd684 50%, rgba(255,174,0,0) 100%)',
          boxShadow:
            '0 0 8px #ffe9b3, 0 0 16px rgba(255,174,0,0.85), 0 0 24px rgba(200,154,77,0.4)',
          transform: 'translate(-50%, -50%)',
          animation: reduced
            ? 'none'
            : 'cv-confetti-burst 1200ms var(--cv-ease-standard) forwards',
          animationDelay: `${i * 60}ms`,
          animationIterationCount: 2,
          opacity: reduced ? 0 : 1,
          '--cv-idx': i,
          '--cv-count': SPARKLES_PER_CELL,
        };
        return <div key={`${triggerId}-${i}`} style={sparkleStyle as CSSProperties} />;
      })}

      {/* Cell halo — soft gold glow around the scatter symbol */}
      <div
        style={{
          position: 'absolute',
          inset: 6,
          borderRadius: 'var(--cv-radius-sm, 6px)',
          boxShadow:
            'inset 0 0 24px rgba(255, 174, 0, 0.55), 0 0 22px rgba(255, 174, 0, 0.4)',
          border: '1px solid var(--pt-amber)',
          animation: reduced ? 'none' : 'cv-glow-pulse 900ms ease-in-out infinite',
        }}
      />
    </div>
  );
}

export default function ScatterCelebration({
  cells,
  scatterCount,
  scatterPayout,
  triggerId,
}: ScatterCelebrationProps) {
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(false);
  const [activeTrigger, setActiveTrigger] = useState<number | null>(null);

  useEffect(() => {
    if (cells.length === 0 || scatterCount < 3) {
      setVisible(false);
      return;
    }
    if (activeTrigger === triggerId) return;
    setActiveTrigger(triggerId);
    setVisible(true);
    const t = setTimeout(() => setVisible(false), reduced ? 800 : SHOW_MS);
    return () => clearTimeout(t);
  }, [cells.length, scatterCount, triggerId, reduced, activeTrigger]);

  if (!visible) return null;

  const counterLabel =
    scatterPayout && scatterPayout > 0n
      ? `${scatterCount} scatters — +${scatterPayout.toString()} vCLAW`
      : `${scatterCount} scatters`;

  return (
    <>
      {cells.map((c, i) => (
        <SparkleCell
          key={`${activeTrigger}-${c.reelIndex}-${c.rowIndex}-${i}`}
          reelIndex={c.reelIndex}
          rowIndex={c.rowIndex}
          triggerId={triggerId}
          reduced={reduced}
        />
      ))}

      {/* "+N scatters" counter pill — top-right of the reel area */}
      <div
        role="status"
        aria-live="polite"
        aria-label={counterLabel}
        style={{
          position: 'absolute',
          top: 12,
          right: 16,
          zIndex: 8,
          pointerEvents: 'none',
          padding: '6px 14px',
          background: 'linear-gradient(180deg, var(--pt-velvet-soft) 0%, var(--pt-velvet) 100%)',
          border: '2px solid var(--pt-amber)',
          color: 'var(--pt-amber-glow)',
          fontFamily: 'var(--pt-data)',
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          textShadow: '0 0 10px rgba(255, 174, 0, 0.85)',
          boxShadow:
            '0 0 16px rgba(255, 174, 0, 0.55), 0 0 36px rgba(255, 174, 0, 0.25)',
          animation: reduced
            ? 'none'
            : 'cv-mega-banner-in 500ms var(--cv-ease-bounce)',
        }}
      >
        +{scatterCount} SCATTERS
      </div>
    </>
  );
}
