'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuthMe } from '@/hooks/use-auth-me';
import { ApiError } from '@/lib/api';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useGameStore } from '@/stores/game';
import { useFloorArenaUi } from '@/stores/floor-arena-ui';
import { useFloorArenaAgent, useFloorArenaLeaderboard, useFloorArenaMe, useFloorArenaMyEvents, useFloorArenaSuggestionAction, floorArenaErrorCopy, type FloorArenaLeaderboardWindow, type FloorArenaReportView } from '@/hooks/use-floor-arena';
import { GuestUpsellModal } from '../../guest-upsell-modal';
import { HouseTradersSection } from '../house-traders';
import { TradingFloorTab } from '../trading-floor-tab';
import { AgentProfile } from '../arena/agent-profile';
import { FloorArenaSection } from '../arena/arena-section';
import { ARENA_GUEST_UPSELL, useArenaNow } from '../arena/arena-kit';
import { ArenaOpenPositions, ArenaReport } from '../arena/arena-parts';
import { signedUsd } from '../arena/arena-format';
import { TerminalStrategy } from './terminal-strategy';
import { TerminalBlock, TerminalRuleChecks, TerminalStats, TerminalWindowPicker, statsForWindow, terminalButton, terminalHeading, terminalMuted } from './terminal-parts';
import { TerminalEquity, TerminalTrades } from './terminal-history';
import './terminal.css';

export const TERMINAL_TABS = ['Dashboard', 'Trades', 'Decisions', 'Strategy', 'Reports', 'Other agents'] as const;
type TerminalTab = (typeof TERMINAL_TABS)[number];

function OwnerControls({ onGuestBlocked }: { onGuestBlocked: () => void }) {
  useEffect(() => { useFloorArenaUi.getState().showPanel('desk'); }, []);
  return <FloorArenaSection active isGuest={false} onGuestBlocked={onGuestBlocked} controlsOnly />;
}

function TerminalReport({ report, nowMs }: { report: FloorArenaReportView | null; nowMs: number }) {
  const suggestion = useFloorArenaSuggestionAction();
  const [message, setMessage] = useState<string | null>(null);
  return <TerminalBlock title="Latest report"><ArenaReport report={report} nowMs={nowMs} actions={report ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{(['apply', 'dismiss'] as const).map((action) => <button key={action} type="button" style={terminalButton} disabled={suggestion.isPending} onClick={() => suggestion.mutate({ reportId: report.id, action }, { onSuccess: () => setMessage(null), onError: (error) => setMessage(floorArenaErrorCopy(error)) })}>{action === 'apply' ? 'Apply suggestion' : 'Dismiss suggestion'}</button>)}</div> : undefined} />{message ? <p role="status" style={terminalMuted}>{message}</p> : null}</TerminalBlock>;
}

function OtherAgents({ range, onRange, guest, onGuestBlocked }: { range: FloorArenaLeaderboardWindow; onRange: (range: FloorArenaLeaderboardWindow) => void; guest: boolean; onGuestBlocked: () => void }) {
  const board = useFloorArenaLeaderboard(range, true);
  const profileId = useFloorArenaUi((state) => state.profileAgentId);
  const panel = useFloorArenaUi((state) => state.panel);
  const showPanel = useFloorArenaUi((state) => state.showPanel);
  if (panel === 'profile' && profileId) return <AgentProfile agentId={profileId} active onBack={() => showPanel('overview')} />;
  return <>
    <TerminalWindowPicker value={range} onChange={onRange} />
    <TerminalBlock title="Other agents">
      {board.isError ? <p role="status" style={terminalMuted}>The leaderboard refresh failed.</p> : null}
      {board.isLoading ? <p style={terminalMuted}>Loading agents...</p> : (board.data?.rows ?? []).length === 0 ? <p style={terminalMuted}>No agents in this view.</p> : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{board.data?.rows.map((agent) => <button type="button" key={agent.agentId} style={{ ...terminalButton, display: 'flex', flexWrap: 'wrap', alignItems: 'center', textAlign: 'left', gap: 8 }} onClick={() => showPanel('profile', { agentId: agent.agentId })}>
        <span style={{ flex: '1 1 160px', overflowWrap: 'anywhere' }}>{agent.rank ?? 'n/a'}. {agent.name}{agent.kind === 'house' ? ' (House)' : ''}</span><span>{signedUsd(agent.realisedUsd)}</span><span style={terminalMuted}>{agent.trades ?? 'n/a'} trades</span>
      </button>)}</div>}
    </TerminalBlock>
    <HouseTradersSection active />
    <TradingFloorTab active isGuest={guest} onGuestBlocked={onGuestBlocked} />
  </>;
}

function TerminalContent({ onClose }: { onClose: () => void }) {
  const compact = useIsMobile();
  const auth = useAuthMe();
  const guest = auth.data === null || auth.data?.user?.isGuest === true;
  const canReadOwner = !!auth.data?.user && !guest;
  const me = useFloorArenaMe(canReadOwner);
  const refused = me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403);
  const agent = canReadOwner && !refused ? me.data?.agent ?? null : null;
  const profile = useFloorArenaAgent(agent?.id ?? null, !!agent);
  const events = useFloorArenaMyEvents(agent?.id ?? null, !!agent);
  const nowMs = useArenaNow(true, 30_000);
  const [tab, setTab] = useState<TerminalTab>('Dashboard');
  const [range, setRange] = useState<FloorArenaLeaderboardWindow>('period');
  const [manage, setManage] = useState(false);
  const [upsell, setUpsell] = useState(false);
  const panel = useFloorArenaUi((state) => state.panel);
  const showPanel = useFloorArenaUi((state) => state.showPanel);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (upsell) useGameStore.setState({ exchangeEscapeOwnedByDialog: true });
    const snapshotEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') useGameStore.setState({ exchangeEscapeOwnedByDialog: upsell });
    };
    window.addEventListener('keydown', snapshotEscape, true);
    return () => window.removeEventListener('keydown', snapshotEscape, true);
  }, [upsell]);

  useEffect(() => () => useGameStore.setState({ exchangeEscapeOwnedByDialog: false }), []);

  useEffect(() => {
    if (panel === 'profile' || panel === 'rules') { setTab('Other agents'); setManage(false); }
    if (panel === 'desk' || panel === 'launch') { setTab('Dashboard'); setManage(true); }
  }, [panel]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.focus();
    return () => previous?.focus();
  }, []);

  const selectTab = (next: TerminalTab) => { setTab(next); setManage(false); showPanel('overview'); };
  const openControls = () => { setManage(true); showPanel('desk'); };
  const report = agent?.latestReport ?? null;
  let body;
  if (tab === 'Other agents') {
    body = <OtherAgents range={range} onRange={setRange} guest={guest} onGuestBlocked={() => setUpsell(true)} />;
  } else if (guest) {
    body = <TerminalBlock title="Your trader"><p style={terminalMuted}>Sign in to launch and manage your trader. Other agents and house traders remain public.</p><button type="button" style={terminalButton} onClick={() => setUpsell(true)}>Sign in or create account</button></TerminalBlock>;
  } else if (auth.data === undefined) {
    body = <p role="status" style={terminalMuted}>{auth.isError ? 'Your account could not be loaded.' : 'Loading your account...'}</p>;
  } else if (me.isError && !(me.error instanceof ApiError && me.error.status === 403)) {
    body = <TerminalBlock title="Your trader"><p role="status" style={terminalMuted}>{me.error instanceof ApiError && me.error.status === 401 ? 'Sign in to read your trader.' : 'Your trader could not be loaded.'}</p><button type="button" style={terminalButton} onClick={() => void me.refetch()}>Try again</button></TerminalBlock>;
  } else if (manage || me.isError || (!agent && !me.isLoading)) {
    body = <OwnerControls onGuestBlocked={() => setUpsell(true)} />;
  } else if (me.isLoading) {
    body = <p style={terminalMuted}>Loading your trader...</p>;
  } else if (agent) {
    if (tab === 'Dashboard') body = <>
      <TerminalWindowPicker value={range} onChange={setRange} />
      <TerminalStats stats={statsForWindow(agent.stats, range)} compact={compact} />
      <TerminalEquity key={agent.id} agentId={agent.id} owner />
      <TerminalBlock title="Open positions">{profile.isLoading ? <p style={terminalMuted}>Loading positions...</p> : profile.isError && !profile.data ? <p role="status" style={terminalMuted}>Positions could not be loaded.</p> : <ArenaOpenPositions positions={profile.data?.openPositions ?? []} params={agent.params} paramsVersion={agent.paramsVersion} nowMs={nowMs} />}</TerminalBlock>
      <TerminalBlock title="Latest report"><ArenaReport report={report} nowMs={nowMs} /></TerminalBlock>
    </>;
    if (tab === 'Trades') body = <TerminalTrades key={agent.id} agentId={agent.id} owner nowMs={nowMs} />;
    if (tab === 'Decisions') body = <TerminalBlock title="Decisions: rule checks"><TerminalRuleChecks events={events.data ?? []} isLoading={events.isLoading} isError={events.isError} nowMs={nowMs} /></TerminalBlock>;
    if (tab === 'Strategy') body = agent.params ? <TerminalStrategy key={`${agent.id}:${agent.paramsVersion}`} params={agent.params} compact={compact} /> : <p style={terminalMuted}>Your rules could not be loaded.</p>;
    if (tab === 'Reports') body = <TerminalReport report={report} nowMs={nowMs} />;
  }

  return <>
    <div aria-hidden="true" style={{ position: 'fixed', inset: 0, zIndex: 99, background: '#0008' }} />
    <div className="floor-terminal" ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="floor-terminal-title" onKeyDown={(event) => {
      if (event.key === 'Escape' && !upsell) { event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const elements = root.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary');
        if (!elements?.length) return;
        const first = elements[0]; const last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }} style={{ position: 'fixed', inset: compact ? 8 : '4vh 3vw', zIndex: 100, display: 'flex', flexDirection: 'column', maxHeight: compact ? 'calc(100dvh - 16px)' : '92dvh', background: '#061520', color: '#F8F0D8', fontFamily: 'Barlow, system-ui, sans-serif', borderRadius: 12, border: '1px solid #8A4A20', boxShadow: '0 20px 80px #000b', overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: compact ? '10px 12px' : '14px 24px', background: 'linear-gradient(180deg, #A9622F, #8A4A20)', borderBottom: '3px solid #3d2210', flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}><h1 id="floor-terminal-title" style={{ ...terminalHeading, color: '#F8D038', margin: 0, fontSize: compact ? 22 : 28, textShadow: '0 2px 0 #3d2210' }}>Trading Floor</h1><div style={{ color: '#E0C070', fontSize: 12, overflowWrap: 'anywhere' }}>{agent ? `${agent.name} | ${agent.status} | ${agent.seated ? `Desk ${agent.seatIndex === null ? 'unknown' : agent.seatIndex + 1}` : 'No desk'} | Paper` : 'Paper trading and public traders'}</div></div>
        <button type="button" aria-label="Close Trading Floor" style={{ ...terminalButton, minWidth: 44 }} onClick={onClose}>X</button>
      </header>
      <nav aria-label="Trading Floor sections" style={{ display: 'flex', overflowX: 'auto', flexShrink: 0, gap: 6, padding: '8px 12px', background: '#3d2210', borderBottom: '2px solid #F8D038' }}>{TERMINAL_TABS.map((item) => <button type="button" key={item} aria-pressed={tab === item} style={{ ...terminalButton, whiteSpace: 'nowrap', borderColor: '#6b3a18', background: tab === item ? '#F8D038' : 'transparent', color: tab === item ? '#1a0f05' : '#F8F0D8' }} onClick={() => selectTab(item)}>{item}</button>)}</nav>
      <div style={{ display: 'flex', flexDirection: compact ? 'column' : 'row', overflow: 'auto', minHeight: 0, flex: 1 }}>
        <main style={{ flex: '1 1 auto', minWidth: 0, padding: compact ? 12 : 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {agent ? <button type="button" style={{ ...terminalButton, alignSelf: 'flex-start' }} onClick={openControls}>Trader controls and wallet</button> : null}
          {me.isError && agent ? <p role="status" style={terminalMuted}>Your trader refresh failed. Data can be out of date.</p> : null}
          {profile.isError && profile.data && (tab === 'Dashboard' || tab === 'Trades') ? <p role="status" style={terminalMuted}>The profile refresh failed. Positions and trades can be out of date.</p> : null}
          {body}
        </main>
        <aside aria-label="Live activity" style={{ flex: compact ? '0 0 auto' : '0 0 300px', minWidth: 0, padding: 20, background: '#00103f', borderLeft: compact ? undefined : '1px solid #16408a', borderTop: compact ? '1px solid #16408a' : undefined }}>
          <h2 style={terminalHeading}>Live activity</h2><p style={terminalMuted}>Your trader&apos;s rule checks. Refreshes every five seconds.</p>
          {agent ? <TerminalRuleChecks key={agent.id} rail events={events.data ?? []} isLoading={events.isLoading} isError={events.isError} nowMs={nowMs} /> : <p style={terminalMuted}>{guest ? 'Sign in to read your rule checks.' : auth.isError || me.isError ? 'Your rule checks could not be loaded.' : auth.data === undefined || me.isLoading ? 'Loading your trader...' : 'Rule checks appear after you launch a trader.'}</p>}
        </aside>
      </div>
    </div>
    <GuestUpsellModal open={upsell} onClose={() => setUpsell(false)} {...ARENA_GUEST_UPSELL} />
  </>;
}

export function TradingFloorTerminal() {
  const open = useGameStore((state) => state.tradingFloorOpen);
  const close = useGameStore((state) => state.closeTradingFloor);
  const auth = useAuthMe();
  return open ? <TerminalContent key={auth.data?.user?.id ?? 'visitor'} onClose={close} /> : null;
}
