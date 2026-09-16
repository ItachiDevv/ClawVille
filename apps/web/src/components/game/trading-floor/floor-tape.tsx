'use client';

import { useEffect, useState } from 'react';

import { useIsMobile } from '@/hooks/use-is-mobile';
import {
  useFloorConsumer,
  useFloorFeed,
  useFloorStreamState,
  type ObserverHealth,
} from '@/hooks/use-trading-floor';
import { useGameStore } from '@/stores/game';
import { useResearchStore } from '@/stores/research';
import { useTradeTickerStore } from '@/stores/trade-ticker';
import { useWorldStreamStore } from '@/stores/world-stream-state';
import { TapeRow } from './trade-row';
import { FLOOR_TEXT } from './tokens';
import { tapeVisibleForThoughtLog } from './placement';

// FEATURE_GATE: trading_floor_mobile_ticker
// Status: the tape is desktop-only (unmounts on touch devices so both joystick zones stay clear).
// Metric to graduate: at least 20 percent of Floor tab opens come from touch devices.
// Current reading: to fill (no touch-open counter exists yet; the Floor tab itself works on touch).
// Review deadline: 2026-10-20
// On deadline: keep the tape desktop-only unless the metric supports a mobile slot.
// Reference: GameFeatures.md §17g Trading Floor UI; CLAUDE.md Mobile + iPad verification rule.

export function floorStatusCopy(
  stream: 'live' | 'reconnecting' | 'stopped',
  observer: ObserverHealth | undefined,
  hasOpened: boolean = true,
): { label: string; detail: string | null; warning: boolean } {
  if (stream === 'reconnecting') {
    return { label: 'RECONNECTING', detail: null, warning: true };
  }
  if (stream === 'stopped') {
    // Before the world stream opens for the first time there is nothing to
    // reload: the stream is still connecting, not broken.
    if (!hasOpened) return { label: 'CONNECTING', detail: null, warning: false };
    return { label: 'STOPPED', detail: null, warning: true };
  }
  if (observer?.enabled === false) {
    return {
      label: 'FLOOR PAUSED',
      detail:
        'Trade tracking is paused. Trades you make now are picked up when it resumes.',
      warning: true,
    };
  }
  if (observer?.enabled === true && observer.stale) {
    return {
      label: 'LIVE FLOOR',
      detail: 'Trades are taking longer than usual to appear. Nothing is lost.',
      warning: true,
    };
  }
  return { label: 'LIVE FLOOR', detail: null, warning: false };
}

export function FloorTapeBody() {
  const { nowMs } = useFloorConsumer(true);
  const entries = useTradeTickerStore((state) => state.entries);
  const dismissed = useTradeTickerStore((state) => state.dismissed);
  const dismiss = useTradeTickerStore((state) => state.dismiss);
  const seedTrades = useTradeTickerStore((state) => state.seedTrades);
  const stream = useFloorStreamState();
  const streamHasOpened = useWorldStreamStore((state) => state.hasOpened);
  const feed = useFloorFeed(true);

  useEffect(() => {
    if (feed.data?.trades.length) seedTrades(feed.data.trades);
  }, [feed.data?.trades, seedTrades]);

  const status = floorStatusCopy(stream, feed.data?.observer, streamHasOpened);
  const showReload = stream === 'stopped' && streamHasOpened;

  return (
    <section
      data-testid="floor-tape"
      aria-label="Trading Floor tape"
      style={{
        flexShrink: 0,
        maxHeight: 'min(140px, 20vh)',
        overflowY: 'auto',
        borderTop: '1px solid rgba(125,211,252,0.18)',
        background: 'rgba(2,8,23,0.92)',
      }}
    >
      <div
        style={{
          display: 'flex',
          minHeight: 44,
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          paddingLeft: 8,
        }}
      >
        <span
          style={{
            color: status.warning ? FLOOR_TEXT.warning : FLOOR_TEXT.accent,
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.12em',
          }}
        >
          {status.label}
        </span>
        {showReload ? (
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              minWidth: 44,
              minHeight: 44,
              color: FLOOR_TEXT.link,
              background: 'transparent',
              border: 0,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        ) : (
          <button
            type="button"
            aria-label="Hide Trading Floor rows"
            onClick={dismiss}
            style={{
              width: 44,
              height: 44,
              color: FLOOR_TEXT.muted,
              background: 'transparent',
              border: 0,
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        )}
      </div>
      {status.detail ? (
        <p style={{ margin: '0 8px 8px', color: FLOOR_TEXT.muted, fontSize: 9 }}>
          {status.detail}
        </p>
      ) : null}
      {!dismissed ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '0 6px 6px' }}>
          {entries.slice(0, 4).map((entry) => (
            <TapeRow
              key={entry.keys.join('|')}
              entry={entry}
              density="tape"
              nowMs={nowMs}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default function FloorTape() {
  const isMobile = useIsMobile();
  const [mobileResolved, setMobileResolved] = useState(false);
  const exchangeOpen = useGameStore((state) => state.exchangeOpen);
  const thoughtLogOpen = useResearchStore((state) => state.thoughtLogOpen);
  const thoughtLogMinimized = useResearchStore(
    (state) => state.thoughtLogMinimized,
  );

  useEffect(() => setMobileResolved(true), []);

  if (
    !mobileResolved ||
    isMobile ||
    exchangeOpen ||
    !tapeVisibleForThoughtLog(thoughtLogOpen, thoughtLogMinimized)
  ) {
    return null;
  }
  return <FloorTapeBody />;
}
