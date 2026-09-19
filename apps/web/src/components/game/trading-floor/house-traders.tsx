'use client';

import { useEffect, useMemo, useState } from 'react';

import { useIsMobile } from '@/hooks/use-is-mobile';
import { useFloorConsumer, useHouseTraders, type HouseTraderSlotView } from '@/hooks/use-trading-floor';
import { useTradeTickerStore } from '@/stores/trade-ticker';
import { tradeAgeLabel } from './format';
import { TapeRow } from './trade-row';
import { FLOOR_TEXT } from './tokens';

// Watch surface for the TWO house traders in `HOUSE_TRADER_LINEUP` (Genesis,
// Dip Hunter). NOT the five copyable templates: a house trader runs the
// operator's own rule loop on ClawPump, outside the published profile rules, so
// this panel renders the lineup's label and strategy note and never a profile
// brief or mint list. Read only: it pairs nothing, arms nothing and moves no
// funds. Live rows come from the EXISTING ticker store the world stream already
// feeds, so this panel adds no second poller; the counts stay from the route
// because the ticker is capped.

const cardStyle = {
  border: '1px solid rgba(125,211,252,0.18)',
  borderRadius: 12,
  background: 'rgba(2,8,23,0.80)',
  padding: 14,
  color: FLOOR_TEXT.primary,
} as const;

const innerCardStyle = {
  border: '1px solid rgba(125,211,252,0.14)',
  borderRadius: 8,
  padding: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
} as const;

function SlotCard({
  slot,
  rowLimit,
  nowMs,
}: {
  slot: HouseTraderSlotView;
  rowLimit: number;
  nowMs: number;
}) {
  const tickerEntries = useTradeTickerStore((state) => state.entries);
  // The SAME identifier the tape publishes, so the filter matches on the id the
  // ticker rows actually carry.
  const subjectId = slot.subject?.id ?? null;

  // Newest first: live ticker rows for this slot, then the route's own recent
  // rows, de-duplicated so a row that appears in both is not shown twice.
  const rows = useMemo(() => {
    if (!subjectId) return [];
    // A decision entry can carry a null subject, so narrow before comparing.
    const live = tickerEntries.filter((entry) => entry.subject?.id === subjectId);
    const seen = new Set(live.map((entry) => entry.keys.join('|')));
    const rest = slot.recentTrades.filter((trade) => !seen.has(trade.keys.join('|')));
    return [...live, ...rest].slice(0, rowLimit);
  }, [subjectId, tickerEntries, slot.recentTrades, rowLimit]);

  const occupied = slot.status !== 'not-yet-running';

  return (
    <div style={innerCardStyle}>
      <div style={{ color: FLOOR_TEXT.value, fontWeight: 700 }}>{slot.slotName}</div>
      {slot.status === 'live-observed' ? (
        <div style={{ color: FLOOR_TEXT.accent, fontSize: 11 }}>
          Live as {slot.subject?.avatarName ?? 'an unnamed avatar'}
        </div>
      ) : slot.status === 'stopped' ? (
        // NARROW on purpose: `stopped` is the link row SURVIVING with a revoked
        // wallet, which the conditional delete in `unpairObservedClawPumpAgent`
        // allows. A FULL unpair DELETES the link (trading-provisioning.ts:573),
        // so that case has no row at all and falls to `not-yet-running` below.
        // The section footnote is what covers it; this comment used to imply
        // `stopped` covered both, which it does not.
        <div style={{ color: FLOOR_TEXT.warning, fontSize: 11 }}>
          Stopped. {slot.subject?.avatarName ?? 'This trader'} is no longer paired, and its past
          trades stay on the floor.
        </div>
      ) : (
        // Never a spinner here: "not running yet" is the true state, not a
        // pending load, and a spinner would imply activity that does not exist.
        <>
          <div style={{ color: FLOOR_TEXT.faint, fontSize: 11 }}>
            Not running yet. This slot has no paired trader.
          </div>
          {/* Unpair DELETES the link, so an unpaired slot has no row to read
              and cannot show a `stopped` state, while that trader's verified
              trades keep appearing on the tape. Without this sentence the two
              public surfaces in one tab would disagree about the same trades. */}
          <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>
            Trades from a trader that used this slot before can still appear on the tape.
          </div>
        </>
      )}
      {/* The lineup's plain-words note, NEVER the profile brief or its mint
          list: a house trader runs the operator's own rule loop on ClawPump,
          so the profile does not describe it. */}
      <p style={{ margin: 0, color: FLOOR_TEXT.muted, fontSize: 11 }}>{slot.strategyNote}</p>
      {occupied ? (
        <>
          <div style={{ color: FLOOR_TEXT.primary, fontSize: 11 }}>
            {slot.counts.verified} verified · {slot.counts.scored} scored ·{' '}
            {slot.counts.lastTradeAt
              ? `last ${tradeAgeLabel(Date.parse(slot.counts.lastTradeAt), nowMs)}`
              : 'no trades yet'}
          </div>
          {rows.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rows.map((entry) => (
                <TapeRow
                  key={entry.keys.join('|')}
                  entry={entry}
                  density="panel"
                  showTrader={false}
                  nowMs={nowMs}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Presentational half, exported so a test can drive it with fixed slots. The
 * data half is `HouseTradersSection` below. Splitting them is what keeps the
 * test free of module stubbing: a module namespace object cannot be patched,
 * and `mock.module` is process global and would poison sibling test files.
 */
export function HouseTradersView({
  slots,
  isLoading,
  isError,
  nowMs,
  compact,
}: {
  slots: HouseTraderSlotView[];
  isLoading: boolean;
  isError: boolean;
  nowMs: number;
  compact: boolean;
}) {
  const query = { isLoading, isError };
  return (
    <section style={cardStyle} data-testid="house-traders">
      <h3 style={{ margin: '0 0 6px', color: FLOOR_TEXT.value, fontSize: 14 }}>
        Watch the house traders
      </h3>
      <p style={{ margin: '0 0 12px', color: FLOOR_TEXT.muted, fontSize: 12 }}>
        {/* Worded to survive the empty case: on prod at ship time both slots
            are unpaired, so copy implying something is running would be wrong
            on the very first view. */}
        The traders the house runs, each one either paired or waiting.{' '}
        <a href="#clawpump-templates" style={{ color: FLOOR_TEXT.link }}>
          Start your own below.
        </a>
      </p>
      {/* SECTION LEVEL, and it is the only thing that covers a full unpair:
          `unpairObservedClawPumpAgent` DELETES the link row, so that trader
          leaves this panel entirely while its verified trades keep scrolling on
          the floor below. Without this sentence the two public surfaces in one
          tab would silently disagree about the same trades. */}
      <p style={{ margin: '0 0 12px', color: FLOOR_TEXT.faint, fontSize: 11 }}>
        This panel shows the traders paired right now. The floor below shows every verified trade,
        including trades from a trader that is no longer paired.
      </p>

      {query.isLoading ? (
        <p style={{ margin: 0, color: FLOOR_TEXT.muted, fontSize: 12 }}>Loading house traders...</p>
      ) : query.isError ? (
        <p style={{ margin: 0, color: FLOOR_TEXT.warning, fontSize: 12 }}>
          The house trader list is unavailable right now. Nothing is lost.
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: compact
              ? '1fr'
              : 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
            gap: 8,
          }}
        >
          {slots.map((slot) => (
            <SlotCard
              key={slot.objective}
              slot={slot}
              rowLimit={compact ? 1 : 3}
              nowMs={nowMs}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function HouseTradersSection({ active }: { active: boolean }) {
  const isMobile = useIsMobile();
  const [mobileResolved, setMobileResolved] = useState(false);
  const { nowMs } = useFloorConsumer(active);
  const query = useHouseTraders(active);

  useEffect(() => setMobileResolved(true), []);

  return (
    <HouseTradersView
      slots={query.data ?? []}
      isLoading={query.isLoading}
      isError={query.isError}
      nowMs={nowMs}
      compact={mobileResolved && isMobile}
    />
  );
}
