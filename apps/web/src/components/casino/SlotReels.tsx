'use client';

/**
 * SlotReels — 5×3 reel grid with SVG symbols + design-token animation
 *
 * Animation spec:
 *   - Reel i stops at STOP_TIMES[i] = [2.0, 2.4, 2.8, 3.2, 3.6] s
 *   - While spinning: every cell runs `cv-spin-jitter` 240ms linear infinite
 *     + `saturate(1.15)` filter for subtle color pop
 *   - On stop: `cv-stop-pop` 260ms cubic-bezier(0.2, 0.8, 0.2, 1) one-shot
 *   - Winning cells: gold ring + bloom box-shadow + soft pulse keyframe
 *
 * Symbols are rendered as `<img src=/assets/slot-symbols/sN.svg>`.
 * On 404 (asset missing) we fall back to the legacy emoji from
 * `CLASSIC_SYMBOLS[id].emoji` via `onError`.
 *
 * Iris Xe safe: pure DOM/CSS, zero Three.js, no per-frame allocations.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { CLASSIC_SYMBOLS, CLASSIC_LINES, CLASSIC_SLOT_SYMBOL_ASSETS } from '@clawville/shared';
import type { SpinResult } from '@/lib/casino/types';
import type { ShakeLevel } from '@/lib/casino/useFX';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REEL_COUNT = 5;
const ROW_COUNT  = 3;

/** ms — how long each reel spins before stopping. Reel i stops at STOP_TIMES[i] */
const STOP_TIMES_MS = [2000, 2400, 2800, 3200, 3600];

/** Extra ms after last reel stops before we fire onReelsSettled */
const WIN_REVEAL_DELAY_MS = 220;

/** px per cell (desktop); mobile scales down via --slot-cell-size custom property */
const CELL_SIZE = 80;
const GAP = 6;

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
  /** Shake intensity driven by useFX */
  shakeLevel?: ShakeLevel;
}

// ---------------------------------------------------------------------------
// Symbol tile — SVG img with emoji fallback
// ---------------------------------------------------------------------------

function SymbolTile({
  symbolId,
  isWinning,
  isSpinning,
  isStopping,
}: {
  symbolId: number;
  isWinning: boolean;
  isSpinning: boolean;
  isStopping: boolean;
}) {
  const sym = CLASSIC_SYMBOLS[symbolId] ?? CLASSIC_SYMBOLS[0];
  const asset = CLASSIC_SLOT_SYMBOL_ASSETS[symbolId] ?? CLASSIC_SLOT_SYMBOL_ASSETS[0];
  const themeColor = asset.themeColor;

  const cellStyle: CSSProperties = {
    width: `var(--slot-cell-size, ${CELL_SIZE}px)`,
    height: `var(--slot-cell-size, ${CELL_SIZE}px)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: isWinning
      ? `radial-gradient(circle at 50% 40%, ${themeColor}33 0%, rgba(5,10,24,0.6) 100%)`
      : 'linear-gradient(180deg, rgba(17,32,61,0.5) 0%, rgba(10,20,40,0.55) 100%)',
    borderRadius: 'var(--cv-radius-sm)',
    border: isWinning
      ? `2px solid var(--cv-gold-accent)`
      : '1px solid rgba(0,255,224,0.08)',
    boxShadow: isWinning
      ? `0 0 18px var(--cv-gold-accent), inset 0 0 14px rgba(255,200,87,0.35)`
      : 'inset 0 1px 0 rgba(255,255,255,0.03)',
    transition: 'box-shadow 0.25s var(--cv-ease-standard), border-color 0.25s var(--cv-ease-standard)',
    animation: isWinning
      ? `cv-symbol-stopped-pulse 1100ms ease-in-out infinite`
      : isStopping
        ? `cv-stop-pop 260ms cubic-bezier(0.2, 0.8, 0.2, 1)`
        : 'none',
    cursor: 'default',
    flexShrink: 0,
    pointerEvents: 'none',
    overflow: 'hidden',
    position: 'relative',
  };

  const innerStyle: CSSProperties = {
    width: '78%',
    height: '78%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    filter: isSpinning ? 'blur(0.8px) saturate(1.15)' : 'none',
    animation: isSpinning ? 'cv-spin-jitter 240ms linear infinite' : 'none',
    transition: 'filter 0.2s var(--cv-ease-standard)',
  };

  const imgStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
    userSelect: 'none',
    pointerEvents: 'none',
    // SVG fallback handled by onError swapping to emoji span.
  };

  const [imgFailed, setImgFailed] = useState(false);

  return (
    <div style={cellStyle} data-symbol={symbolId} data-winning={isWinning ? 'true' : undefined}>
      <div style={innerStyle}>
        {imgFailed ? (
          <span
            style={{
              fontSize: `calc(var(--slot-cell-size, ${CELL_SIZE}px) * 0.5)`,
              lineHeight: 1,
            }}
            aria-label={asset.displayName}
          >
            {sym.emoji}
          </span>
        ) : (
          <img
            src={asset.svgPath}
            alt={asset.displayName}
            draggable={false}
            onError={() => setImgFailed(true)}
            style={imgStyle}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Win line overlay — neon strips per winning payline
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
              opacity: 0.85,
              boxShadow: `0 0 12px ${lineDef.color}, 0 0 20px ${lineDef.color}66`,
              transform: 'translateY(-50%)',
              animation: 'cv-glow-pulse 800ms ease-in-out infinite',
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
  shakeLevel = 'none',
}: SlotReelsProps) {
  const [settledReels, setSettledReels] = useState<boolean[]>(() => Array(REEL_COUNT).fill(false));
  const [justStoppedReels, setJustStoppedReels] = useState<boolean[]>(() => Array(REEL_COUNT).fill(false));
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
      setSettledReels(Array(REEL_COUNT).fill(false));
      setJustStoppedReels(Array(REEL_COUNT).fill(false));
      setShowWinOverlay(false);
      timerRefs.current.forEach(clearTimeout);
      timerRefs.current = [];

      for (let r = 0; r < REEL_COUNT; r++) {
        const reelIndex = r;
        const delay = STOP_TIMES_MS[reelIndex];
        const t = setTimeout(() => {
          setSettledReels(prev => {
            const next = [...prev];
            next[reelIndex] = true;
            return next;
          });
          setJustStoppedReels(prev => {
            const next = [...prev];
            next[reelIndex] = true;
            return next;
          });
          // stopPop is a one-shot — clear the flag after the keyframe.
          const tClear = setTimeout(() => {
            setJustStoppedReels(prev => {
              const next = [...prev];
              next[reelIndex] = false;
              return next;
            });
          }, 280);
          timerRefs.current.push(tClear);

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
      setSettledReels(Array(REEL_COUNT).fill(true));
    }

    prevSpinning.current = isSpinning;
  }, [isSpinning, onReelsSettled]);

  // Winning cell map per reel
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

  const shakeAnim =
    shakeLevel === 'hard' ? 'cv-shake-hard 420ms ease-in-out'
    : shakeLevel === 'soft' ? 'cv-shake-soft 380ms ease-in-out'
    : 'none';

  return (
    <div style={{
      position: 'relative',
      animation: shakeAnim,
    }}>
      {/* Reel grid */}
      <div style={{
        display: 'flex',
        flexDirection: 'row',
        gap: GAP,
        alignItems: 'stretch',
        userSelect: 'none',
        padding: 'var(--cv-space-2)',
        borderRadius: 'var(--cv-radius-lg)',
        background:
          'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.35) 100%)',
        boxShadow: 'inset 0 0 24px rgba(0,255,224,0.08), inset 0 1px 0 rgba(255,255,255,0.05)',
        border: '1px solid rgba(0,255,224,0.18)',
      }}>
        {Array.from({ length: REEL_COUNT }, (_, r) => {
          const isSettled = settledReels[r];
          const reelSpinning = isSpinning && !isSettled;
          const isStopping = justStoppedReels[r];

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
                borderRadius: 'var(--cv-radius-md)',
                background:
                  'linear-gradient(180deg, rgba(5,10,24,0.6) 0%, rgba(10,20,40,0.45) 100%)',
                border: `1px solid ${reelSpinning ? 'rgba(0,255,224,0.45)' : 'rgba(0,255,224,0.12)'}`,
                width: `var(--slot-cell-size, ${CELL_SIZE}px)`,
                transition: 'border-color 0.2s var(--cv-ease-standard), box-shadow 0.2s var(--cv-ease-standard)',
                boxShadow: reelSpinning
                  ? '0 0 18px rgba(0,255,224,0.25), inset 0 1px 0 rgba(255,255,255,0.05)'
                  : 'inset 0 1px 0 rgba(255,255,255,0.04)',
                padding: 4,
              }}
            >
              {column.map((symId, row) => {
                const winning = showWinOverlay && (winCellMap.get(r)?.has(row) ?? false);
                return (
                  <SymbolTile
                    key={row}
                    symbolId={symId}
                    isWinning={winning}
                    isSpinning={reelSpinning}
                    isStopping={isStopping && !reelSpinning}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Win line neon overlay */}
      <WinLineOverlay winningLines={winningLines} visible={showWinOverlay} />
    </div>
  );
}
