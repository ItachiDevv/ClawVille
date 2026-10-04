'use client';

import { useState, type ReactNode } from 'react';
import {
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_PARAM_BOUNDS,
  FLOOR_ARENA_FILTER_KEYS,
  type FloorArenaParams,
} from '@clawville/shared';

import type {
  FloorArenaAgentStats,
  FloorArenaStatsByWindow,
  FloorArenaEventView,
  FloorArenaParamChangeView,
  FloorArenaPositionView,
  FloorArenaReportView,
  FloorArenaTunerCheck,
} from '@/hooks/use-floor-arena';
import { shortMint } from '../format';
import { FLOOR_TEXT } from '../tokens';
import {
  ARENA_TONE,
  exitTargets,
  positionExits,
  formatBoundValue,
  formatDuration,
  formatMultiple,
  formatParamValue,
  firstSightLabel,
  formatTpLeg,
  isoAgo,
  paramPathLabel,
  pnlTone,
  rankByLabel,
  signedUsd,
} from './arena-format';
import { ArenaCardTitle, ArenaMuted, ArenaPill, arenaButtonStyle, arenaCardStyle } from './arena-kit';

// Read-only building blocks shared by the desk panel (my trader) and the
// public agent profile, so both show one agent the same way.

export function ArenaBlock({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section style={arenaCardStyle} data-testid={testId}>
      <ArenaCardTitle>{title}</ArenaCardTitle>
      {children}
    </section>
  );
}

/** A count the route did not send prints as "-", never as 0. */
export function countText(value: number | null): string {
  return value === null ? '-' : String(value);
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 70 }}>
      <span style={{ color: FLOOR_TEXT.faint, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      <span style={{ color: tone ?? FLOOR_TEXT.value, fontSize: 15, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function StatsLine({ label, stats }: { label: string; stats: FloorArenaAgentStats }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 16 }}>
      <span style={{ color: FLOOR_TEXT.muted, fontSize: 11, minWidth: 64 }}>{label}</span>
      <Stat label="Realised P&L" value={signedUsd(stats.realisedUsd)} tone={pnlTone(stats.realisedUsd)} />
      <Stat label="Trades" value={countText(stats.trades)} />
      <Stat label="Wins" value={countText(stats.wins)} />
      <Stat label="Losses" value={countText(stats.losses)} />
      <Stat label="Open" value={countText(stats.openPositions)} />
    </div>
  );
}

/** The contest window first (it decides the prizes), then all time. */
export function ArenaStatsRow({ stats }: { stats: FloorArenaStatsByWindow }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="arena-stats">
      <StatsLine label="Contest" stats={stats.contest} />
      <StatsLine label="All time" stats={stats.all} />
    </div>
  );
}

const EVENT_LOOK: Record<FloorArenaEventView['type'], { label: string; tone: string }> = {
  entry: { label: 'BUY', tone: FLOOR_TEXT.positive },
  exit: { label: 'SELL', tone: FLOOR_TEXT.muted },
  skip: { label: 'SKIP', tone: FLOOR_TEXT.faint },
  pass: { label: 'PASS', tone: FLOOR_TEXT.faint },
  scan: { label: 'SCAN', tone: FLOOR_TEXT.faint },
  param_change: { label: 'RULES', tone: ARENA_TONE.paramChange },
  report: { label: 'REPORT', tone: ARENA_TONE.report },
  status: { label: 'STATUS', tone: FLOOR_TEXT.warning },
  addon: { label: 'ADD-ON', tone: FLOOR_TEXT.accent },
  withdraw: { label: 'WITHDRAW', tone: FLOOR_TEXT.accent },
  other: { label: 'EVENT', tone: FLOOR_TEXT.faint },
};

/** Entry green, exit green or red by its P&L, skip grey, rules blue, report purple. */
export function arenaEventTone(event: FloorArenaEventView): string {
  if (event.type === 'exit') return pnlTone(event.pnlUsd);
  return EVENT_LOOK[event.type].tone;
}

const STREAM_PAGE = 40;

export function ArenaEventStream({
  events,
  isLoading,
  isError,
  nowMs,
}: {
  events: readonly FloorArenaEventView[];
  isLoading: boolean;
  isError: boolean;
  nowMs: number;
}) {
  const [shown, setShown] = useState(STREAM_PAGE);
  if (isLoading) return <ArenaMuted>Loading the decision stream...</ArenaMuted>;
  if (isError && events.length === 0) {
    return <ArenaMuted>The decision stream is unavailable right now. It retries on its own.</ArenaMuted>;
  }
  if (events.length === 0) return <ArenaMuted>No decisions yet. The stream fills as the agent scans.</ArenaMuted>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="arena-event-stream" aria-live="polite">
      {events.slice(0, shown).map((event) => {
        const tone = arenaEventTone(event);
        return (
          <div
            key={event.id}
            data-event-type={event.type}
            style={{
              display: 'grid',
              gridTemplateColumns: '64px 1fr',
              gap: 8,
              padding: '6px 0',
              borderBottom: '1px solid rgba(125,211,252,0.08)',
              alignItems: 'start',
            }}
          >
            <ArenaPill colour={tone}>{EVENT_LOOK[event.type].label}</ArenaPill>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: FLOOR_TEXT.primary, fontSize: 12, overflowWrap: 'anywhere' }}>{event.summary}</div>
              <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>
                {isoAgo(event.at, nowMs)}
                {event.mint ? ` · ${shortMint(event.mint)}` : ''}
                {event.type === 'exit' && event.pnlUsd !== null ? (
                  <span style={{ color: tone }}> · {signedUsd(event.pnlUsd)}</span>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
      {events.length > shown ? (
        <button type="button" style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }} onClick={() => setShown(shown + STREAM_PAGE)}>
          Show older decisions
        </button>
      ) : null}
    </div>
  );
}

function coinLabel(position: FloorArenaPositionView): string {
  return position.symbol ?? shortMint(position.mint);
}

function priceLabel(value: number | null): string {
  if (value === null) return 'n/a';
  if (value >= 1) return `$${value.toFixed(4)}`;
  // Micro-cap prices: keep four significant digits instead of rounding to 0.
  return `$${value.toPrecision(4)}`;
}

export function ArenaOpenPositions({
  positions,
  params,
  paramsVersion,
  nowMs,
}: {
  positions: readonly FloorArenaPositionView[];
  params: FloorArenaParams | null;
  paramsVersion: number | null;
  nowMs: number;
}) {
  if (positions.length === 0) return <ArenaMuted>No open positions.</ArenaMuted>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="arena-open-positions">
      {positions.map((position) => {
        const mark = position.lastMarkMult;
        const exits = positionExits(position, params, paramsVersion);
        return (
          <div
            key={position.id}
            style={{ borderBottom: '1px solid rgba(125,211,252,0.08)', paddingBottom: 6, display: 'flex', flexDirection: 'column', gap: 2 }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: FLOOR_TEXT.value, fontWeight: 700 }}>{coinLabel(position)}</span>
              <span style={{ color: mark === null ? FLOOR_TEXT.muted : mark >= 1 ? FLOOR_TEXT.positive : FLOOR_TEXT.danger, fontSize: 13 }}>
                {formatMultiple(mark)}
              </span>
              <span style={{ color: FLOOR_TEXT.faint, fontSize: 11 }}>
                opened {isoAgo(position.openedAt, nowMs)} · entry {priceLabel(position.entryPriceUsd)}
                {position.peakMult !== null ? ` · peak ${formatMultiple(position.peakMult)}` : ''}
                {position.remainingFraction !== null && position.remainingFraction < 1
                  ? ` · ${Math.round(position.remainingFraction * 100)}% left`
                  : ''}
              </span>
            </div>
            {exits ? (
              <div style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>{exitTargets(exits).join(' · ')}</div>
            ) : position.paramsVersion !== null ? (
              <div style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
                Opened under rules v{position.paramsVersion}; it keeps the exits it was opened with.
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const EXIT_REASON_LABEL: Record<string, string> = {
  tp: 'take-profit',
  stop: 'stop',
  trail: 'trailing stop',
  time: 'max hold',
  manual: 'closed by hand',
  unresolved: 'no usable price for 30 min',
};

/**
 * D31: an 'unresolved' close has no P&L of its own (pnl_usd NULL), but the
 * contest score counts it as a loss of its open stake: the proceeds of earlier
 * take-profit legs minus the position size. Only for a position OPENED inside
 * the contest window, the same inclusive bounds the leaderboard SQL uses
 * (opened_at >= startsAt AND opened_at <= endsAt): any other unresolved close
 * is in no contest score, so it gets no contest line. Null when it cannot be
 * read.
 */
export function unresolvedContestLoss(
  position: Pick<FloorArenaPositionView, 'exitReason' | 'pnlUsd' | 'realisedUsd' | 'sizeUsd' | 'openedAt'>,
): number | null {
  if (position.exitReason !== 'unresolved' || position.pnlUsd !== null) return null;
  if (position.realisedUsd === null || position.sizeUsd === null || position.openedAt === null) return null;
  const openedMs = Date.parse(position.openedAt);
  if (
    !Number.isFinite(openedMs) ||
    openedMs < Date.parse(FLOOR_ARENA_CONTEST.startsAt) ||
    openedMs > Date.parse(FLOOR_ARENA_CONTEST.endsAt)
  ) {
    return null;
  }
  return position.realisedUsd - position.sizeUsd;
}

export function ArenaClosedTrades({
  positions,
  nowMs,
  limit = 50,
}: {
  positions: readonly FloorArenaPositionView[];
  nowMs: number;
  limit?: number;
}) {
  if (positions.length === 0) return <ArenaMuted>No closed trades yet.</ArenaMuted>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }} data-testid="arena-closed-trades">
      {positions.slice(0, limit).map((position) => (
        <div
          key={position.id}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 8,
            padding: '6px 0',
            borderBottom: '1px solid rgba(125,211,252,0.08)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ color: FLOOR_TEXT.value, fontSize: 12, fontWeight: 700 }}>{coinLabel(position)}</div>
            <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>
              {position.exitReason ? EXIT_REASON_LABEL[position.exitReason] ?? position.exitReason : 'closed'} ·{' '}
              {isoAgo(position.closedAt, nowMs)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            {position.exitReason === 'unresolved' && position.pnlUsd === null ? (
              <>
                <div style={{ color: FLOOR_TEXT.muted, fontSize: 13, fontWeight: 700 }}>unresolved</div>
                {unresolvedContestLoss(position) !== null ? (
                  <div style={{ color: FLOOR_TEXT.danger, fontSize: 10 }} data-testid="arena-unresolved-loss">
                    contest: {signedUsd(unresolvedContestLoss(position))}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div style={{ color: pnlTone(position.pnlUsd), fontSize: 13, fontWeight: 700 }}>{signedUsd(position.pnlUsd)}</div>
                <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>{formatMultiple(position.pnlMult)}</div>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const SUGGESTION_STATE_LABEL: Record<FloorArenaReportView['suggestionState'], string> = {
  none: '',
  pending: 'Waiting for your answer',
  applied: 'Applied',
  dismissed: 'Dismissed',
  auto_applied: 'Applied automatically',
  rejected: 'Not applied: the rules changed or it was outside the limits',
};

/**
 * A shuffle-test p: 3 decimals, or "< 0.001". When 3 decimals would put p on
 * the wrong side of alpha (0.0025 shows as 0.003, 0.0051 as 0.005), it shows
 * 4 decimals, the server's own rounding, so the line never contradicts itself.
 */
function tunerPText(p: number, alpha: number | null): string {
  if (p < 0.001) return '< 0.001';
  const three = p.toFixed(3);
  return alpha !== null && (p <= alpha) !== (Number(three) <= alpha) ? p.toFixed(4) : three;
}

/** The p a test had to reach (0.01, 0.005, 0.0025), without trailing zeros. */
function tunerAlphaText(alpha: number): string {
  return alpha.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** " (p 0.004, needs 0.01)"; an older report with no alpha gives " (p 0.030)". */
function tunerEvidence(p: number | null, alpha: number | null): string {
  if (p === null) return '';
  return alpha === null ? ` (p ${tunerPText(p, null)})` : ` (p ${tunerPText(p, alpha)}, needs ${tunerAlphaText(alpha)})`;
}

/**
 * The not_significant line. A tested look compares p with that checkpoint's
 * alpha: above it, the filter is not significant; at or below it, the split
 * failed only the edge rule.
 */
function tunerNotSignificant(tuner: FloorArenaTunerCheck): string {
  const { p, alpha } = tuner;
  if (p !== null && alpha !== null && p <= alpha) {
    // The server stores the edge to 4 places and judged the raw value, so 4
    // places (trailing zeros cut to 2) never round a 0.0299 up to the 0.03 bar.
    const edge = tuner.best?.edge ?? null;
    return edge === null
      ? 'Tuner: no change, edge too small'
      : `Tuner: no change, edge too small (${edge >= 0 ? '+' : ''}${edge.toFixed(4).replace(/0{1,2}$/, '')})`;
  }
  if (p !== null && alpha !== null) {
    return `Tuner: no change, best filter not significant (p ${tunerPText(p, alpha)} needs ${tunerAlphaText(alpha)} or less)`;
  }
  return `Tuner: no change, best filter not significant${tunerEvidence(p, null)}`;
}

/**
 * One plain line that says why the tuner changed, suggested or kept the rules
 * in this report (D33). Null when the report has no tuner field (older reports).
 * The server tests only at checkpoints on the current rules, so most reports
 * say "next check at N trades"; a rule set that used every checkpoint says so.
 */
export function arenaTunerLine(tuner: FloorArenaTunerCheck | null | undefined): string | null {
  if (!tuner) return null;
  const best = tuner.best;
  const change = best
    ? `${paramPathLabel(best.path)} ${formatParamValue(best.path, best.from)} -> ${formatParamValue(best.path, best.to)}`
    : null;
  const evidence = tunerEvidence(tuner.p, tuner.alpha);
  if (tuner.decision === 'changed') return change ? `Tuner: changed ${change}${evidence}` : 'Tuner: changed a rule';
  if (tuner.decision === 'suggested') return change ? `Tuner: suggested ${change}${evidence}` : 'Tuner: suggested a change';
  const counts = tuner.needed !== null && tuner.n !== null;
  switch (tuner.reason) {
    case 'below_sample':
      return counts
        ? `Tuner: no change, needs ${countText(tuner.needed)} closed trades on these rules (has ${countText(tuner.n)})`
        : 'Tuner: no change, needs more closed trades on these rules';
    case 'waiting_checkpoint':
      return counts
        ? `Tuner: no change, next check at ${countText(tuner.needed)} trades on these rules (has ${countText(tuner.n)})`
        : 'Tuner: no change, next check after more trades on these rules';
    case 'budget_spent':
      return 'Tuner: no change, these rules used their test budget; it checks again after a rule change';
    case 'not_significant':
      return tunerNotSignificant(tuner);
    case 'no_candidate':
      return 'Tuner: no change, no filter change splits the trades 8 and 8';
    case 'rate_limited':
      return 'Tuner: no change, the last rule change is too recent';
    case 'params_changed':
      return 'Tuner: no change, the rules changed during the check';
    case 'not_tunable':
      return 'Tuner: no change, the rules could not be checked';
    default:
      return 'Tuner: no change';
  }
}

export function ArenaReport({
  report,
  nowMs,
  actions,
}: {
  report: FloorArenaReportView | null;
  nowMs: number;
  /** Apply / Dismiss buttons. Only the owner's desk panel passes them. */
  actions?: ReactNode;
}) {
  if (!report) return <ArenaMuted>No report yet. The agent writes one every 30 minutes once it has activity.</ArenaMuted>;
  const tunerLine = arenaTunerLine(report.tuner);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="arena-report">
      <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>Written {isoAgo(report.periodEnd, nowMs)}</div>
      {report.summary ? <p style={{ margin: 0, color: FLOOR_TEXT.primary, fontSize: 12 }}>{report.summary}</p> : null}
      {report.observations.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18, color: FLOOR_TEXT.muted, fontSize: 12 }}>
          {report.observations.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {report.suggestion ? (
        <div
          data-testid="arena-suggestion"
          style={{ border: `1px solid ${ARENA_TONE.report}`, borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          <div style={{ color: ARENA_TONE.report, fontSize: 11, fontWeight: 700 }}>SUGGESTED CHANGE</div>
          <div style={{ color: FLOOR_TEXT.value, fontSize: 13 }}>
            {paramPathLabel(report.suggestion.path)}: {formatParamValue(report.suggestion.path, report.suggestion.from)} to{' '}
            {formatParamValue(report.suggestion.path, report.suggestion.to)}
          </div>
          {report.suggestion.reason ? <ArenaMuted>{report.suggestion.reason}</ArenaMuted> : null}
          {report.suggestionState === 'pending' && actions ? actions : null}
          {SUGGESTION_STATE_LABEL[report.suggestionState] && !(report.suggestionState === 'pending' && actions) ? (
            <div style={{ color: FLOOR_TEXT.faint, fontSize: 11 }}>{SUGGESTION_STATE_LABEL[report.suggestionState]}</div>
          ) : null}
        </div>
      ) : null}
      {tunerLine ? (
        <div data-testid="arena-tuner-line" style={{ color: FLOOR_TEXT.muted, fontSize: 11, overflowWrap: 'anywhere' }}>
          {tunerLine}
        </div>
      ) : null}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  user: 'Owner',
  'house-tuner': 'House tuner',
  admin: 'ClawVille team',
  suggestion: '30-minute report',
};

export function ArenaParamChanges({ changes, nowMs }: { changes: readonly FloorArenaParamChangeView[]; nowMs: number }) {
  if (changes.length === 0) return <ArenaMuted>No rule changes yet.</ArenaMuted>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="arena-param-changes">
      {changes.map((change) => (
        <div key={change.id} style={{ borderBottom: '1px solid rgba(125,211,252,0.08)', paddingBottom: 6 }}>
          <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>
            {SOURCE_LABEL[change.source] ?? change.source} · {isoAgo(change.at, nowMs)}
            {change.paramsVersion !== null ? ` · rules v${change.paramsVersion}` : ''}
          </div>
          {change.changes.map((line) => (
            <div key={line.path} style={{ color: ARENA_TONE.paramChange, fontSize: 12 }}>
              {paramPathLabel(line.path)}: {formatParamValue(line.path, line.from)} to {formatParamValue(line.path, line.to)}
            </div>
          ))}
          {change.reason ? <div style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>{change.reason}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** Read-only rules: every filter that is on, then entry, exits and limits. */
export function ArenaParamsSummary({ params }: { params: FloorArenaParams | null }) {
  if (!params) return <ArenaMuted>The rules could not be read.</ArenaMuted>;
  const B = FLOOR_ARENA_PARAM_BOUNDS;
  const filters = FLOOR_ARENA_FILTER_KEYS.filter((key) => params.filters[key] !== null).map(
    (key) => `${B.filters[key].label}: ${formatBoundValue(B.filters[key], params.filters[key])}`,
  );
  const lines = [
    ...filters,
    params.entry.discovered_within_s !== null
      ? `Only coins first seen within ${formatDuration(params.entry.discovered_within_s)}`
      : 'Coins of any discovery age',
    ...(params.entry.discovered_within_s !== null
      ? [`Count first sight from: ${firstSightLabel(params.entry.first_sight_sources)}`]
      : []),
    `Pick order: ${rankByLabel(params.entry.rank_by)}`,
    `${B.entry.entries_per_tick.label}: ${params.entry.entries_per_tick}`,
    ...(params.exits.tp.length > 0 ? params.exits.tp.map((leg) => `Take-profit: ${formatTpLeg(leg)}`) : ['No take-profit legs']),
    `${B.exits.stop_mult.label}: ${formatBoundValue(B.exits.stop_mult, params.exits.stop_mult)}`,
    `${B.exits.trail_from_peak.label}: ${formatBoundValue(B.exits.trail_from_peak, params.exits.trail_from_peak)}`,
    ...(params.exits.trail_from_peak !== null
      ? [`${B.exits.trail_arm_mult.label}: ${params.exits.trail_arm_mult === null ? 'at once' : formatMultiple(params.exits.trail_arm_mult)}`]
      : []),
    `${B.exits.max_hold_s.label}: ${formatDuration(params.exits.max_hold_s)}`,
    `${B.limits.position_usd.label}: $${params.limits.position_usd}`,
    `${B.limits.max_open.label}: ${params.limits.max_open}`,
    `${B.limits.reentry_cooldown_s.label}: ${formatDuration(params.limits.reentry_cooldown_s)}`,
  ];
  return (
    <ul style={{ margin: 0, paddingLeft: 18, color: FLOOR_TEXT.primary, fontSize: 12 }} data-testid="arena-params-summary">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
