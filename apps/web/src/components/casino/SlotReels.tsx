'use client';

/**
 * SlotReels — 5×3 reel grid with CSS-driven sequential-stop animation
 *
 * Animation spec (per brief):
 *   - 5 reels × 3 visible rows
 *   - Sequential stop: reel i stops at t = (2.0 + i * 0.4)s = [2.0, 2.4, 2.8, 3.2, 3.6]s
 *   - Per reel: 0.3s ease-in, continuous fast spin (~3 rot/sec visual equivalent), 1.0s ease-out
 *   - Win highlight: pulse-scale winning cells + neon overlay line per winning payline
 *
 * CSS sprites: each symbol is rendered as an emoji tile with colored bg.
 * Phase 6.1 can swap in a sprite atlas by replacing symbol emoji.
 *
 * Iris Xe safe: pure CSS animations, zero Three.js, no new allocations per frame.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { CLASSIC_SYMBOLS, CLASSIC_LINES } from '@clawville/shared';
import type { SpinResult } from '@/lib/casino/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REEL_COUNT = 5;
const ROW_COUNT  = 3;

/** ms — how long each reel spins before stopping. Reel i stops at STOP_TIMES[i] */
const STOP_TIMES_MS = [2000, 2400, 2800, 3200, 3600];

/** Extra ms after last reel stops before we fire onReelsSettled */
const WIN_REVEAL_DELAY_MS = 200;

/** ms for win highlight pulse animation */
const WIN_PULSE_MS = 600;

/** px per cell (desktop); mobile scales down via CSS custom property */
const CELL_SIZE = 80;
const GAP = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface SlotReelsProps {
  /** Target reel window from the last SpinResult. null = show idle symbols */
  targetWindow: number[][] | null; // [reel][row]
  /** Whether to play the spin animation */
  isSpinning: boolean;
  /** Winning lines from the last result (empty = no highlights) */
  winningLines: SpinResult['winningLines'];
  /** Called when the last reel stops and win highlights are ready */
  onReelsSettled: () => void;
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------
function makeCellStyle(
  symbolId: number,
  isWinning: boolean,
): React.CSSProperties {
  const sym = CLASSIC_SYMBOLS[symbolId];
  return {
    width: `var(--slot-cell-size, ${CELL_SIZE}px)`,
    height: `var(--slot-cell-size, ${CELL_SIZE}px)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: `calc(var(--slot-cell-size, ${CELL_SIZE}px) * 0.52)`,
    background: isWinning
      ? `radial-gradient(circle, ${sym?.color ?? '#333'} 0%, rgba(0,0,0,0.6) 100%)`
      : 'rgba(0,0,0,0.3)',
    borderRadius: 6,
    border: isWinning
      ? `2px solid ${sym?.color ?? '#00ffe0'}`
      : '2px solid transparent',
    boxShadow: isWinning
      ? `0 0 14px ${sym?.color ?? '#00ffe0'}88`
      : 'none',
    transition: 'box-shadow 0.3s, border-color 0.3s',
    animation: isWinning
      ? `slotPulse ${WIN_PULSE_MS}ms ease-in-out infinite alternate`
      : 'none',
    cursor: 'default',
    flexShrink: 0,
    pointerEvents: 'none',
  };
}

// ---------------------------------------------------------------------------
// Win line overlay — draws horizontal marker lines per winning payline
// ---------------------------------------------------------------------------
interface WinLineOverlayProps {
  winningLines: SpinResult['winningLines'];
  visible: boolean;
}

function WinLineOverlay({ winningLines, visible }: WinLineOverlayProps) {
  if (!visible || winningLines.length === 0) return null;

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 5,
    }}>
      {winningLines.map((wl, i) => {
        const lineDef = CLASSIC_LINES.find(l => l.id === wl.lineIndex);
        if (!lineDef) return null;
        // Use the center reel row as the primary row for the horizontal overlay
        const primaryRow = lineDef.rows[2];
        const topPct = ((primaryRow * (100 / ROW_COUNT)) + (50 / ROW_COUNT)).toFixed(1);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${topPct}%`,
              height: 3,
              background: lineDef.color,
              opacity: 0.75,
              boxShadow: `0 0 8px ${lineDef.color}`,
              transform: 'translateY(-50%)',
              animation: 'slotLineFlash 800ms ease-in-out infinite alternate',
              borderRadius: 2,
            }}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Idle symbol column — random symbols for reel idle state
// ---------------------------------------------------------------------------
function makeIdleColumn(): number[] {
  return Array.from({ length: ROW_COUNT }, () =>
    Math.floor(Math.random() * CLASSIC_SYMBOLS.length)
  );
}

// ---------------------------------------------------------------------------
// Main SlotReels component
// ---------------------------------------------------------------------------
export default function SlotReels({
  targetWindow,
  isSpinning,
  winningLines,
  onReelsSettled,
}: SlotReelsProps) {
  const [settledReels, setSettledReels] = useState<boolean[]>(() => Array(REEL_COUNT).fill(false));
  const [showWinOverlay, setShowWinOverlay] = useState(false);
  // Stable idle columns — don't re-randomize on every render
  const [idleColumns] = useState<number[][]>(() => Array.from({ length: REEL_COUNT }, makeIdleColumn));

  const timerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);
  const prevSpinning = useRef(false);

  // Clear all timers on unmount
  useEffect(() => {
    const timers = timerRefs.current;
    return () => { timers.forEach(clearTimeout); };
  }, []);

  // When spinning starts, schedule each reel's settle
  useEffect(() => {
    if (isSpinning && !prevSpinning.current) {
      // Reset state
      setSettledReels(Array(REEL_COUNT).fill(false));
      setShowWinOverlay(false);
      timerRefs.current.forEach(clearTimeout);
      timerRefs.current = [];

      // Schedule settle for each reel sequentially
      for (let r = 0; r < REEL_COUNT; r++) {
        const reelIndex = r; // capture for closure
        const delay = STOP_TIMES_MS[reelIndex];
        const t = setTimeout(() => {
          setSettledReels(prev => {
            const next = [...prev];
            next[reelIndex] = true;
            return next;
          });
          // After last reel settles, fire onReelsSettled
          if (reelIndex === REEL_COUNT - 1) {
            const t2 = setTimeout(() => {
              setShowWinOverlay(true);
              onReelsSettled();
            }, WIN_REVEAL_DELAY_MS);
            timerRefs.current.push(t2);
          }
        }, delay);
        timerRefs.current.push(t);
      }
    }

    if (!isSpinning && prevSpinning.current) {
      // External cancel — mark all settled
      setSettledReels(Array(REEL_COUNT).fill(true));
    }

    prevSpinning.current = isSpinning;
  }, [isSpinning, onReelsSettled]);

  // Build winning cell map: for each reel index → set of winning row indices
  const cellWins = useCallback((): Map<number, Set<number>> => {
    const map = new Map<number, Set<number>>();
    if (!showWinOverlay) return map;
    for (const wl of winningLines) {
      const lineDef = CLASSIC_LINES.find(l => l.id === wl.lineIndex);
      if (!lineDef) continue;
      for (let r = 0; r < REEL_COUNT; r++) {
        if (!map.has(r)) map.set(r, new Set<number>());
        map.get(r)!.add(lineDef.rows[r]);
      }
    }
    return map;
  }, [winningLines, showWinOverlay]);

  const winCellMap = cellWins();

  return (
    <>
      <style>{`
        @keyframes slotPulse {
          from { transform: scale(1);    filter: brightness(1); }
          to   { transform: scale(1.10); filter: brightness(1.4); }
        }
        @keyframes slotSpinBlur {
          0%,100% { transform: translateY(0); opacity: 1; }
          50%      { transform: translateY(-4px); opacity: 0.75; }
        }
        @keyframes slotLineFlash {
          from { opacity: 0.4; }
          to   { opacity: 1.0; }
        }
      `}</style>

      <div style={{ position: 'relative' }}>
        {/* Reel grid */}
        <div style={{
          display: 'flex',
          flexDirection: 'row',
          gap: GAP,
          alignItems: 'stretch',
          userSelect: 'none',
        }}>
          {Array.from({ length: REEL_COUNT }, (_, r) => {
            const isSettled = settledReels[r];
            const reelSpinning = isSpinning && !isSettled;

            // Column to display for this reel
            const column: number[] =
              (isSettled || !isSpinning) && targetWindow
                ? targetWindow[r]
                : idleColumns[r];

            return (
              <div
                key={r}
                role="region"
                aria-label={`Reel ${r + 1}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: GAP,
                  position: 'relative',
                  overflow: 'hidden',
                  borderRadius: 8,
                  background: 'rgba(0,0,0,0.45)',
                  border: `1px solid ${reelSpinning ? 'rgba(0,255,224,0.4)' : 'rgba(0,255,224,0.15)'}`,
                  width: `var(--slot-cell-size, ${CELL_SIZE}px)`,
                  transition: 'border-color 0.2s',
                  boxShadow: reelSpinning ? '0 0 12px rgba(0,255,224,0.15)' : 'none',
                }}
              >
                {column.map((symId, row) => {
                  const winning = showWinOverlay && (winCellMap.get(r)?.has(row) ?? false);
                  const sym = CLASSIC_SYMBOLS[symId] ?? CLASSIC_SYMBOLS[0];
                  return (
                    <div
                      key={row}
                      style={makeCellStyle(symId, winning)}
                      data-reel={r}
                      data-row={row}
                    >
                      <span
                        style={{
                          display: 'inline-block',
                          lineHeight: 1,
                          filter: reelSpinning ? 'blur(1.5px)' : 'none',
                          ...(reelSpinning
                            ? { animation: `slotSpinBlur ${0.22 - r * 0.008}s ease-in-out infinite` }
                            : {}),
                        }}
                      >
                        {sym.emoji}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Win line neon overlay */}
        <WinLineOverlay winningLines={winningLines} visible={showWinOverlay} />
      </div>
    </>
  );
}
