'use client';

import { useEffect, useMemo, useState } from 'react';

import { useIsMobile } from '@/hooks/use-is-mobile';
import {
  useFloorConsumer,
  useHouseTraders,
  type HouseTraderRealisedView,
  type HouseTraderSlotView,
} from '@/hooks/use-trading-floor';
import { useTradeTickerStore } from '@/stores/trade-ticker';
import { tradeAgeLabel } from './format';
import {
  formatRiskArithmetic,
  resolveHouseTraderRiskDisplay,
  type HouseTraderRiskView,
  type RiskFreshness,
} from './house-trader-risk';
import { TapeRow } from './trade-row';
import { FLOOR_TEXT } from './tokens';

// Watch surface for the house traders in `HOUSE_TRADER_LINEUP` (2026-09-19:
// Genesis, then ClawVille Runner; Dip Hunter was backtested, rejected and
// dropped the same day). The panel renders whatever the route returns and pins
// no count or label, so a lineup change needs no edit here. NOT the five
// copyable templates: a house trader
// runs the operator's own rule loop on ClawPump, outside the published profile rules, so
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

/** Signed USD, always with its sign so a loss can never read as a gain. */
function signedUsd(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

const pillStyle = (colour: string) =>
  ({
    alignSelf: 'flex-start',
    border: `1px solid ${colour}`,
    borderRadius: 999,
    padding: '2px 8px',
    color: colour,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.3,
  }) as const;

/**
 * WHY THIS DESK IS NOT OPENING POSITIONS (founder order, 2026-09-20).
 *
 * Read straight from the route's `risk` block and never inferred: a desk with
 * no setup is silent exactly like a desk that is cap-blocked, so trade silence
 * cannot tell the two apart and this panel must not guess. Genesis sat blocked
 * for seven hours with nothing on any surface saying so, which is the whole
 * reason the block exists.
 *
 * Renders NOTHING for a live desk, for a slot the route sent no readable block
 * for, and for a desk whose pairing already explains its idleness: see
 * `resolveHouseTraderRiskDisplay` for that precedence. The 3D board consumes
 * the same resolver, so the two public surfaces cannot disagree about one desk.
 */
function RiskBlock({
  display,
  risk,
}: {
  display: 'paused' | 'fault';
  risk: HouseTraderRiskView;
}) {
  // A FAULT IS NOT A PAUSE. "Paused by risk limit" asserts that a limit was
  // evaluated and hit; a fault says the evaluation itself did not complete.
  // Rendering one as the other is the same unearned claim as reporting an
  // unreadable P&L as a flat result.
  const fault = display === 'fault';
  const colour = fault ? FLOOR_TEXT.danger : FLOOR_TEXT.warning;
  // `null` when the three figures do not add up to the claim the sentence makes,
  // which is a real state: a desk halted by hand or short of USDC is paused
  // without being over its loss cap. The pill and the detail still show.
  const arithmetic = fault ? null : formatRiskArithmetic(risk);
  return (
    <div
      data-testid="house-risk"
      style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
    >
      <span data-testid="house-risk-pill" style={pillStyle(colour)}>
        {fault ? 'Status fault' : 'Paused by risk limit'}
      </span>
      {/* Route prose. Already bounded and stripped at the wire boundary, so
          this renders it whole rather than re-truncating it here. */}
      {risk.detail ? (
        <div style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>{risk.detail}</div>
      ) : null}
      {/* ALL THREE FIGURES, in one sentence, and only when they support it.
          The day loss beside the cap alone reads as a desk with room to spare;
          what actually blocks it is the next position not fitting under that
          cap. A fault never gets the line, because a failed evaluation has no
          arithmetic behind it. */}
      {arithmetic ? (
        <div data-testid="house-risk-math" style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
          {arithmetic}
        </div>
      ) : null}
    </div>
  );
}

/**
 * PUBLIC live realised P&L (founder order, 2026-09-20).
 *
 * Every number here is rendered STRAIGHT from the route. This component does no
 * arithmetic beyond formatting and carries no literal figure, which is what
 * `house-traders.test.tsx` asserts: a hand-typed number on a public money board
 * is the failure mode worth a test of its own.
 */
function RealisedBlock({ realised }: { realised: HouseTraderRealisedView | null }) {
  // THREE distinct absences, never collapsed into one and never into "$0.00".
  // This one is a statement about OUR READ, not about the trader: saying "no
  // closed trades yet" here would assert something about a live desk that we
  // do not actually know.
  if (realised === null) {
    return (
      <div style={{ color: FLOOR_TEXT.warning, fontSize: 11 }}>
        P&amp;L unavailable. The figures could not be read just now; nothing is lost.
      </div>
    );
  }
  const { realisedUsd, closedPositions, wins, losses, bestUsd, worstUsd } = realised;
  // Neutral at exactly 0: green would imply a gain that is not there.
  const colour = realisedUsd > 0
    ? FLOOR_TEXT.positive
    : realisedUsd < 0 ? FLOOR_TEXT.danger : FLOOR_TEXT.muted;
  // The SERVER decides partial. It knows causes the client cannot see, notably
  // `computedOverTrades` disagreeing with the slot's verified count, so
  // re-deriving this from the visible counters would miss a truncated read.
  // The counters are kept as a fallback for an older payload without the flag.
  const partial = realised.partial
    || realised.unpricedLegs > 0
    || realised.unclassifiedLegs > 0
    || realised.undatedLegs > 0
    || realised.excludedNonUsdc > 0;

  // NOTHING CLOSED is not a flat result. Rendering "$0.00" here would claim the
  // desk traded and came out level, which is a different and false statement.
  if (closedPositions === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
          No closed trades yet.
          {realised.openPositions > 0
            ? ` ${realised.openPositions} open, ${signedUsd(realised.openCostUsd)} at cost.`
            : ''}
        </div>
        <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>{realised.note}</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ color: FLOOR_TEXT.faint, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {partial ? 'Realised (partial)' : 'Realised'}
        </span>
        <span style={{ color: colour, fontSize: 16, fontWeight: 700 }} data-testid="house-realised-usd">
          {signedUsd(realisedUsd)}
        </span>
        <span style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
          {closedPositions} closed · {wins}W / {losses}L
          {realised.openPositions > 0 ? ` · ${realised.openPositions} open` : ''}
        </span>
      </div>
      <div style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
        best {bestUsd === null ? 'none' : signedUsd(bestUsd)} · worst{' '}
        {worstUsd === null ? 'none' : signedUsd(worstUsd)}
        {/* Wording matched to the 3D board so the two surfaces read alike. */}
        {realised.noExitClosures > 0 ? ` · ${realised.noExitClosures} closed with no exit` : ''}
      </div>
      <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>
        {realised.note}
        {realised.preBindIncluded ? ' Includes trades from before this wallet was bound.' : ''}
        {partial ? ' Some positions could not be valued, so this figure is partial.' : ''}
      </div>
    </div>
  );
}

function SlotCard({
  slot,
  rowLimit,
  nowMs,
  freshness,
}: {
  slot: HouseTraderSlotView;
  rowLimit: number;
  nowMs: number;
  freshness: RiskFreshness;
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
  const riskDisplay = resolveHouseTraderRiskDisplay(slot.status, slot.risk, freshness);

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
      {/* Directly under the pairing line: "Live as Genesis" followed by "Paused
          by risk limit" is the whole story of the desk in two lines, and the
          risk block is the half a reader would otherwise have to infer from an
          empty tape. `risk` is non-null whenever `riskDisplay` is. */}
      {riskDisplay && slot.risk ? (
        <RiskBlock display={riskDisplay} risk={slot.risk} />
      ) : null}
      {/* The lineup's plain-words note, NEVER the profile brief or its mint
          list: a house trader runs the operator's own rule loop on ClawPump,
          so the profile does not describe it. */}
      <p style={{ margin: 0, color: FLOOR_TEXT.muted, fontSize: 11 }}>{slot.strategyNote}</p>
      {occupied ? (
        <>
          <RealisedBlock realised={slot.realised} />
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
  freshness,
}: {
  slots: HouseTraderSlotView[];
  isLoading: boolean;
  isError: boolean;
  nowMs: number;
  compact: boolean;
  /** When the data in hand was FETCHED, against the current clock. A verdict
   *  the route has stopped refreshing expires here rather than sitting on the
   *  card forever: react-query keeps the last good data through a failed poll. */
  freshness: RiskFreshness;
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
              freshness={freshness}
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
      // `nowMs` advances on the shared 60 s floor clock, so an expired verdict
      // leaves the panel within a minute of its 150 s budget running out.
      freshness={{ nowMs, dataUpdatedAt: query.dataUpdatedAt }}
    />
  );
}
