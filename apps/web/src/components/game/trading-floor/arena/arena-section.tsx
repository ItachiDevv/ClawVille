'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_TEMPLATES,
} from '@clawville/shared';

import { ApiError } from '@/lib/api';
import { AUTH_ME_QUERY_KEY, fetchAuthMe } from '@/hooks/use-auth-me';
import {
  useFloorArenaContest,
  useFloorArenaDiscovery,
  useFloorArenaLeaderboard,
  useFloorArenaMe,
  useFloorArenaTemplates,
  type FloorArenaLeaderboardRow,
  type FloorArenaLeaderboardWindow,
} from '@/hooks/use-floor-arena';
import { useFloorArenaUi } from '@/stores/floor-arena-ui';
import { shortMint } from '../format';
import { FLOOR_TEXT } from '../tokens';
import { AgentProfile } from './agent-profile';
import {
  compactUsd,
  contestPhase,
  contestStandingsCopy,
  countLabel,
  formatCountdown,
  isoAgo,
  pnlTone,
  signedUsd,
} from './arena-format';
import {
  ArenaMuted,
  ArenaPill,
  arenaButtonStyle,
  arenaCardStyle,
  arenaInnerCardStyle,
  arenaPrimaryButtonStyle,
  useArenaCompact,
  useArenaNow,
} from './arena-kit';
import { countText } from './arena-parts';
import { ContestRules } from './contest-rules';
import { LaunchSuccess, LaunchTrader } from './launch-trader';
import { MyTrader } from './my-trader';

// TOP of the Exchange modal's Trading Floor tab: the paper contest, its
// leaderboard, the five house agents as templates, and the way into your own
// arena trader. Spec: docs/trading-floor-arena.md. This is the human path; a
// connected agent drives the same routes through its tools.

const WINDOWS: ReadonlyArray<{ id: FloorArenaLeaderboardWindow; label: string }> = [
  { id: 'contest', label: 'Contest' },
  { id: '24h', label: '24 hours' },
  { id: 'all', label: 'All time' },
];

const PLACE: Record<1 | 2 | 3, string> = { 1: '1st', 2: '2nd', 3: '3rd' };

function ContestBanner({ active, onRules }: { active: boolean; onRules: () => void }) {
  const nowMs = useArenaNow(active, 1_000);
  const phase = contestPhase(FLOOR_ARENA_CONTEST.startsAt, FLOOR_ARENA_CONTEST.endsAt, nowMs);
  // Only after the end: before it the clock alone says everything.
  const contest = useFloorArenaContest(active && phase === 'ended');
  const standings = contestStandingsCopy(contest.data?.standings ?? null, contest.data?.openWindowPositions ?? null);
  const countdown = phase === 'upcoming'
    ? `Starts in ${formatCountdown(Date.parse(FLOOR_ARENA_CONTEST.startsAt) - nowMs)}`
    : phase === 'live'
      ? `Ends in ${formatCountdown(Date.parse(FLOOR_ARENA_CONTEST.endsAt) - nowMs)}`
      : standings.text;

  return (
    <header
      style={{ ...arenaCardStyle, border: '1px solid rgba(251,191,36,0.40)', display: 'flex', flexDirection: 'column', gap: 8 }}
      data-testid="arena-contest-banner"
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <h2 style={{ margin: 0, color: FLOOR_TEXT.value, fontSize: 17 }}>{FLOOR_ARENA_CONTEST.name}</h2>
        <ArenaPill colour={FLOOR_TEXT.warning}>Paper trading only</ArenaPill>
        {phase === 'ended' && standings.pill ? (
          <ArenaPill colour={standings.pill === 'Final' ? FLOOR_TEXT.positive : FLOOR_TEXT.accent} testId="arena-standings">
            {standings.pill}
          </ArenaPill>
        ) : null}
      </div>
      <div style={{ color: FLOOR_TEXT.accent, fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }} data-testid="arena-countdown">
        {countdown}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {FLOOR_ARENA_CONTEST.prizes.map((prize) => (
          <div key={prize.place} style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ color: FLOOR_TEXT.faint, fontSize: 10, textTransform: 'uppercase' }}>{PLACE[prize.place]}</span>
            <span style={{ color: FLOOR_TEXT.value, fontSize: 14, fontWeight: 700 }}>
              {prize.amount.toLocaleString('en-US')} {prize.token}
            </span>
          </div>
        ))}
      </div>
      <ArenaMuted>
        Five house agents trade here in public. Launch your own trader from any of their templates, change its rules, and
        sit at a desk to trade. Best realised paper P&amp;L wins.
      </ArenaMuted>
      <button type="button" onClick={onRules} style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}>
        Contest rules
      </button>
    </header>
  );
}

function LeaderboardRow({
  row,
  compact,
  mine,
  showEligibility,
  onOpen,
}: {
  row: FloorArenaLeaderboardRow;
  compact: boolean;
  mine: boolean;
  /** Prize eligibility exists only on the contest window; the route sends false elsewhere. */
  showEligibility: boolean;
  onOpen: () => void;
}) {
  const tags = (
    <>
      {row.kind === 'house' ? <ArenaPill colour={FLOOR_TEXT.accent}>House</ArenaPill> : null}
      {mine ? <ArenaPill colour={FLOOR_TEXT.value}>You</ArenaPill> : null}
      {row.kind === 'user' && showEligibility ? (
        row.eligible ? (
          <ArenaPill colour={FLOOR_TEXT.positive} testId="arena-eligible">Eligible</ArenaPill>
        ) : (
          <ArenaPill colour={FLOOR_TEXT.faint}>No contest trade</ArenaPill>
        )
      ) : null}
    </>
  );
  const pnl = (
    <span style={{ color: pnlTone(row.realisedUsd), fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
      {signedUsd(row.realisedUsd)}
    </span>
  );
  const common = {
    minHeight: 44,
    width: '100%',
    background: mine ? 'rgba(14,116,144,0.18)' : 'transparent',
    border: 'none',
    borderBottom: '1px solid rgba(125,211,252,0.08)',
    color: FLOOR_TEXT.primary,
    textAlign: 'left' as const,
    cursor: 'pointer',
    padding: '6px 4px',
    fontSize: 12,
  };

  if (compact) {
    return (
      <button type="button" onClick={onOpen} style={{ ...common, display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="arena-leaderboard-row">
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
          <span style={{ color: FLOOR_TEXT.muted }}>#{countText(row.rank)}</span>
          <span style={{ color: FLOOR_TEXT.value, fontWeight: 700 }}>{row.name}</span>
          {tags}
          <span style={{ marginLeft: 'auto' }}>{pnl}</span>
        </span>
        <span style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
          {countLabel(row.trades, 'trade')} · {countLabel(row.wins, 'win')} · {countText(row.openPositions)} open
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="arena-leaderboard-row"
      style={{
        ...common,
        display: 'grid',
        gridTemplateColumns: '40px minmax(0, 1fr) 96px 56px 48px 48px',
        gap: 8,
        alignItems: 'center',
      }}
    >
      <span style={{ color: FLOOR_TEXT.muted }}>#{countText(row.rank)}</span>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ color: FLOOR_TEXT.value, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</span>
        {tags}
      </span>
      <span style={{ textAlign: 'right' }}>{pnl}</span>
      <span style={{ textAlign: 'right' }}>{countText(row.trades)}</span>
      <span style={{ textAlign: 'right' }}>{countText(row.wins)}</span>
      <span style={{ textAlign: 'right' }}>{countText(row.openPositions)}</span>
    </button>
  );
}

function ArenaLeaderboard({
  active,
  compact,
  myAgentId,
  onOpenAgent,
}: {
  active: boolean;
  compact: boolean;
  myAgentId: string | null;
  onOpenAgent: (agentId: string) => void;
}) {
  const [range, setRange] = useState<FloorArenaLeaderboardWindow>('contest');
  const board = useFloorArenaLeaderboard(range, active);
  const nowMs = useArenaNow(active, 60_000);
  const ended = contestPhase(FLOOR_ARENA_CONTEST.startsAt, FLOOR_ARENA_CONTEST.endsAt, nowMs) === 'ended';
  // The same query key as the banner, so this adds no fetch.
  const contest = useFloorArenaContest(active && ended && range === 'contest');
  const standingsPill = range === 'contest' && ended
    ? contestStandingsCopy(contest.data?.standings ?? null, contest.data?.openWindowPositions ?? null).pill
    : null;
  const rows = board.data ?? [];

  return (
    <section style={arenaCardStyle} data-testid="arena-leaderboard">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <h3 style={{ margin: 0, color: FLOOR_TEXT.value, fontSize: 14 }}>Arena leaderboard</h3>
          {standingsPill ? (
            <ArenaPill colour={standingsPill === 'Final' ? FLOOR_TEXT.positive : FLOOR_TEXT.accent}>{standingsPill}</ArenaPill>
          ) : null}
        </div>
        <div role="group" aria-label="Leaderboard window" style={{ display: 'flex', gap: 6 }}>
          {WINDOWS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={range === option.id}
              onClick={() => setRange(option.id)}
              style={{
                ...arenaButtonStyle,
                padding: '8px 10px',
                color: range === option.id ? FLOOR_TEXT.value : FLOOR_TEXT.muted,
                background: range === option.id ? 'rgba(14,116,144,0.45)' : 'rgba(14,116,144,0.12)',
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {!compact && rows.length > 0 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '40px minmax(0, 1fr) 96px 56px 48px 48px',
            gap: 8,
            padding: '0 4px 4px',
            color: FLOOR_TEXT.faint,
            fontSize: 10,
            textTransform: 'uppercase',
          }}
        >
          <span>Rank</span>
          <span>Agent</span>
          <span style={{ textAlign: 'right' }}>Realised</span>
          <span style={{ textAlign: 'right' }}>Trades</span>
          <span style={{ textAlign: 'right' }}>Wins</span>
          <span style={{ textAlign: 'right' }}>Open</span>
        </div>
      ) : null}
      {board.isLoading ? (
        <ArenaMuted>Loading the leaderboard...</ArenaMuted>
      ) : board.isError && rows.length === 0 ? (
        <ArenaMuted>The leaderboard is unavailable right now. It retries on its own.</ArenaMuted>
      ) : rows.length === 0 ? (
        <ArenaMuted>No agent has closed a paper trade in this window yet.</ArenaMuted>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.map((row) => (
            <LeaderboardRow
              key={row.agentId}
              row={row}
              compact={compact}
              mine={row.agentId === myAgentId}
              showEligibility={range === 'contest'}
              onOpen={() => onOpenAgent(row.agentId)}
            />
          ))}
        </div>
      )}
      <ArenaMuted size={11}>
        Realised paper P&amp;L in USD after the paper trading costs. The contest score counts positions opened inside
        the contest window, also when they close after it ends. A player&apos;s agent becomes eligible for a prize once
        a position it opened inside the window has closed. House agents cannot win prizes.
      </ArenaMuted>
    </section>
  );
}

function TemplateCards({
  active,
  compact,
  canStart,
  onWatch,
  onStart,
}: {
  active: boolean;
  compact: boolean;
  canStart: boolean;
  onWatch: (agentId: string) => void;
  onStart: (templateId: string) => void;
}) {
  const stats = useFloorArenaTemplates(active);
  const byTemplate = new Map((stats.data ?? []).map((row) => [row.templateId, row]));

  return (
    <section style={arenaCardStyle} data-testid="arena-templates">
      {/* "(paper)" and the last sentence keep these apart from the live
          real-money traders further down the tab, which share two names
          (prod verify b8d52ab6, finding 2). */}
      <h3 style={{ margin: '0 0 6px', color: FLOOR_TEXT.value, fontSize: 14 }}>The five arena house agents (paper)</h3>
      <ArenaMuted>
        Each house agent is a template. Watch one trade, then start your own trader from its rules. They trade on paper
        and are not the live traders further down this tab.
      </ArenaMuted>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
          gap: 8,
          marginTop: 10,
        }}
      >
        {FLOOR_ARENA_TEMPLATES.map((template) => {
          const live = byTemplate.get(template.id);
          return (
            <div key={template.id} style={arenaInnerCardStyle} data-testid={`arena-template-${template.id}`}>
              <div style={{ color: FLOOR_TEXT.value, fontWeight: 700, fontSize: 13 }}>
                {template.displayName}: <span style={{ fontWeight: 400 }}>{template.tagline}</span>
              </div>
              <div style={{ color: FLOOR_TEXT.faint, fontSize: 11 }}>{template.risk}</div>
              {live ? (
                <div style={{ color: FLOOR_TEXT.muted, fontSize: 12 }}>
                  All time:{' '}
                  <span style={{ color: pnlTone(live.stats.all.realisedUsd), fontWeight: 700 }}>
                    {signedUsd(live.stats.all.realisedUsd)}
                  </span>
                  {' '}· {countLabel(live.stats.all.trades, 'trade')} · {countLabel(live.stats.all.wins, 'win')} ·{' '}
                  {countLabel(live.stats.all.losses, 'loss', 'losses')} · {countText(live.stats.all.openPositions)} open
                </div>
              ) : (
                <div style={{ color: FLOOR_TEXT.faint, fontSize: 11 }}>
                  {stats.isLoading ? 'Loading live stats...' : 'Live stats are unavailable right now.'}
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" onClick={() => onWatch(template.houseAgentId)} style={arenaButtonStyle}>
                  Watch
                </button>
                {canStart ? (
                  <button type="button" onClick={() => onStart(template.id)} style={arenaButtonStyle}>
                    Start from this template
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DiscoveryFeed({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false);
  const nowMs = useArenaNow(active && open, 30_000);
  // Fetched only while open: a closed card costs no request.
  const feed = useFloorArenaDiscovery(active && open);
  const rows = (feed.data ?? []).slice(0, 10);
  return (
    <details
      style={arenaCardStyle}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      data-testid="arena-discovery"
    >
      {/* `display: flex` removes the browser's disclosure triangle, so a closed
          card read as a bare heading with nothing under it (prod verify
          b8d52ab6, finding 3). The Show / Hide label is the visible cue. */}
      <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: FLOOR_TEXT.value, fontSize: 13, fontWeight: 700 }}>
        <span style={{ flex: '1 1 auto' }}>The shared discovery feed every agent reads</span>
        <span data-testid="arena-discovery-toggle" style={{ color: FLOOR_TEXT.link, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
          {open ? 'Hide' : 'Show coins'}
        </span>
      </summary>
      {!open ? null : feed.isLoading ? (
        <ArenaMuted>Loading the feed...</ArenaMuted>
      ) : feed.isError && rows.length === 0 ? (
        <div data-testid="arena-discovery-error" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, color: FLOOR_TEXT.warning, fontSize: 12 }}>The feed could not be loaded right now.</p>
          <button type="button" onClick={() => void feed.refetch()} style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}>
            Try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div data-testid="arena-discovery-empty">
          <ArenaMuted>No coins in the feed yet; it fills when the engine scans.</ArenaMuted>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 6 }}>
          {feed.isError ? (
            <p style={{ margin: 0, color: FLOOR_TEXT.warning, fontSize: 11 }}>
              The latest refresh failed. These are the last coins loaded.
            </p>
          ) : null}
          {rows.map((row) => (
            <div
              key={row.mint}
              style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(125,211,252,0.08)', fontSize: 12 }}
            >
              <span style={{ color: FLOOR_TEXT.value, fontWeight: 700 }}>{row.symbol ?? shortMint(row.mint)}</span>
              <span style={{ color: FLOOR_TEXT.muted }}>
                {row.firstSource ?? 'unknown source'} · seen {isoAgo(row.firstSeenAt, nowMs)}
                {row.mcapUsd !== null ? ` · mcap ${compactUsd(row.mcapUsd)}` : ''}
                {row.liqUsd !== null ? ` · liq ${compactUsd(row.liqUsd)}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

export function FloorArenaSection({
  active,
  isGuest,
  onGuestBlocked,
}: {
  active: boolean;
  isGuest: boolean;
  onGuestBlocked: () => void;
}) {
  const compact = useArenaCompact();
  const panel = useFloorArenaUi((state) => state.panel);
  const profileAgentId = useFloorArenaUi((state) => state.profileAgentId);
  const launchTemplateId = useFloorArenaUi((state) => state.launchTemplateId);
  const launched = useFloorArenaUi((state) => state.launched);
  const showPanel = useFloorArenaUi((state) => state.showPanel);
  const setLaunched = useFloorArenaUi((state) => state.setLaunched);
  // GET /me answers a guest or a logged-out visitor with 401 (a red console
  // error). `isGuest` comes from useIsGuest(), which reads false while auth-me
  // is still loading, so also wait for auth-me to resolve, like the floor tab.
  // The shared auth-me query and fetcher (see use-auth-me.ts); a known guest
  // only reads the cache, so this observer never asks for auth-me for one.
  const authResolved =
    useQuery({ queryKey: AUTH_ME_QUERY_KEY, queryFn: fetchAuthMe, retry: false, enabled: active && !isGuest }).data !==
    undefined;
  const me = useFloorArenaMe(active && authResolved && !isGuest);
  const myAgent = me.data?.agent ?? null;
  // A 401 or 403 from GET /me means this viewer cannot own an arena agent,
  // exactly like a guest: the launch flow then shows the sign-up card.
  const cannotOwn = isGuest || (me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstRender = useRef(true);

  // A panel opened from further down the tab (a template card, a leaderboard
  // row) replaces the overview in place, so bring its top into view.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    rootRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [panel, profileAgentId]);

  const toOverview = () => showPanel('overview');
  const openDesk = () => {
    setLaunched(null);
    showPanel('desk');
  };
  const openAgent = (agentId: string) => showPanel('profile', { agentId });
  const startLaunch = (templateId: string | null) => {
    if (cannotOwn) {
      onGuestBlocked();
      return;
    }
    showPanel('launch', { templateId });
  };

  let body: ReactNode;
  if (launched && !cannotOwn) {
    body = <LaunchSuccess me={myAgent} onOpenDesk={openDesk} />;
  } else if (panel === 'profile' && profileAgentId) {
    body = <AgentProfile key={profileAgentId} agentId={profileAgentId} active={active} onBack={toOverview} />;
  } else if (panel === 'rules') {
    body = <ContestRules active={active} onBack={toOverview} onOpenAgent={openAgent} />;
  } else if (panel === 'desk' || panel === 'launch') {
    // Until auth-me resolves, GET /me waits (disabled, so not "loading"); show
    // the same wait, never the launch form to a player who already owns one.
    if (!cannotOwn && (!authResolved || me.isLoading)) {
      body = <ArenaMuted>Loading your arena trader...</ArenaMuted>;
    } else if (!cannotOwn && me.isError && !me.data) {
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ArenaMuted>Your arena trader could not be loaded right now.</ArenaMuted>
          <button type="button" onClick={() => void me.refetch()} style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}>
            Try again
          </button>
        </div>
      );
    } else if (myAgent) {
      body = <MyTrader me={myAgent} active={active} compact={compact} onBack={toOverview} onOpenProfile={openAgent} />;
    } else {
      body = (
        <LaunchTrader
          key={launchTemplateId ?? 'pick'}
          active={active}
          isGuest={cannotOwn}
          onGuestBlocked={onGuestBlocked}
          initialTemplateId={panel === 'launch' ? launchTemplateId : null}
          compact={compact}
          onBack={toOverview}
          onOpenDesk={openDesk}
        />
      );
    }
  } else {
    body = (
      <>
        <ContestBanner active={active} onRules={() => showPanel('rules')} />
        <div style={{ ...arenaInnerCardStyle, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          <ArenaMuted>
            {myAgent
              ? `${myAgent.name} is yours. Open it to watch its decisions and tune its rules.`
              : 'Pick a template, set its rules, and trade on paper. One trader per account.'}
          </ArenaMuted>
          <button
            type="button"
            onClick={() => (myAgent ? openDesk() : startLaunch(null))}
            style={arenaPrimaryButtonStyle}
            data-testid="arena-launch-button"
          >
            {myAgent ? 'Open my trader' : 'Launch your trader'}
          </button>
        </div>
        <ArenaLeaderboard active={active} compact={compact} myAgentId={myAgent?.id ?? null} onOpenAgent={openAgent} />
        <TemplateCards
          active={active}
          compact={compact}
          canStart={!myAgent}
          onWatch={openAgent}
          onStart={(templateId) => startLaunch(templateId)}
        />
        <DiscoveryFeed active={active} />
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      id="floor-arena"
      data-testid="floor-arena-section"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, scrollMarginTop: 8 }}
    >
      {body}
    </div>
  );
}
