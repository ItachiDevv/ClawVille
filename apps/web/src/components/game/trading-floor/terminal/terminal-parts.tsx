'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { FLOOR_ARENA_EVENT_TYPES } from '@clawville/shared';
import { type FloorArenaEventView, type FloorArenaAgentStats, type FloorArenaLeaderboardWindow, type FloorArenaStatsByWindow } from '@/hooks/use-floor-arena';
import { isoAgo, signedUsd } from '../arena/arena-format';

export const terminalButton: CSSProperties = { minHeight: 44, padding: '8px 14px', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: '#2f5bb5', background: '#00226e', color: '#F8F0D8', font: '600 14px Barlow, sans-serif', cursor: 'pointer' };
export const terminalCard: CSSProperties = { border: '1px solid #16408a', borderRadius: 12, background: '#001858', padding: 18, minWidth: 0 };
export const terminalHeading: CSSProperties = { margin: '0 0 12px', fontFamily: 'Anton, sans-serif', fontSize: 22, fontWeight: 400, letterSpacing: '.03em', textTransform: 'uppercase', color: '#F8F8F8' };
export const terminalMuted: CSSProperties = { color: '#a7b4d8', fontSize: 14, lineHeight: 1.5 };

export function TerminalBlock({ title, children }: { title: string; children: ReactNode }) {
  return <section style={terminalCard}><h2 style={terminalHeading}>{title}</h2>{children}</section>;
}

export function statsForWindow(stats: FloorArenaStatsByWindow, window: FloorArenaLeaderboardWindow): FloorArenaAgentStats {
  return window === '24h' ? stats.last24h : stats[window];
}

export function TerminalWindowPicker({ value, onChange }: { value: FloorArenaLeaderboardWindow; onChange: (value: FloorArenaLeaderboardWindow) => void }) {
  return <div aria-label="Stats window" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
    {(['contest', '24h', 'all'] as const).map((item) => <button key={item} type="button" aria-pressed={value === item} onClick={() => onChange(item)} style={{ ...terminalButton, ...(value === item ? { background: '#F8D038', color: '#1a0f05', borderColor: '#F8D038' } : {}) }}>{item === 'contest' ? 'Contest' : item === '24h' ? '24 hours' : 'All time'}</button>)}
  </div>;
}

export function TerminalStats({ stats, compact }: { stats: FloorArenaAgentStats; compact: boolean }) {
  const items = [
    ['Realised P&L', signedUsd(stats.realisedUsd)], ['Closed trades', stats.trades ?? 'n/a'],
    ['Wins', stats.wins ?? 'n/a'], ['Losses', stats.losses ?? 'n/a'],
    ['Open positions', stats.openPositions ?? 'n/a'], ['Dead coins', stats.deaths ?? 'n/a'],
  ];
  return <section aria-label="Key numbers" style={{ display: 'grid', gridTemplateColumns: `repeat(${compact ? 2 : 3}, minmax(0, 1fr))`, gap: 12 }}>{items.map(([label, value]) => <div key={label} style={terminalCard}>
    <div style={{ color: '#b4c0e0', fontSize: 13 }}>{label}</div>
    <div style={{ fontSize: 25, fontWeight: 700, overflowWrap: 'anywhere', color: label === 'Realised P&L' && stats.realisedUsd !== null ? stats.realisedUsd < 0 ? '#FF8A75' : stats.realisedUsd > 0 ? '#B8F800' : '#F8F0D8' : '#F8F0D8' }}>{value}</div>
    {label === 'Realised P&L' ? <small style={terminalMuted}>Paper costs included</small> : null}
  </div>)}</section>;
}

export function filterRuleChecks(events: readonly FloorArenaEventView[], type: string): readonly FloorArenaEventView[] {
  return type === 'all' ? events : events.filter((event) => event.type === type);
}

export function TerminalRuleChecks({ events, isLoading, isError, nowMs, rail = false }: { events: readonly FloorArenaEventView[]; isLoading: boolean; isError: boolean; nowMs: number; rail?: boolean }) {
  const [filter, setFilter] = useState('all');
  const filtered = filterRuleChecks(events, filter);
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <label style={terminalMuted}>Rule checks by type <select aria-label={rail ? 'Activity type' : 'Rule check type'} value={filter} onChange={(event) => setFilter(event.target.value)} style={{ ...terminalButton, maxWidth: '100%' }}>
      <option value="all">All</option>{[...FLOOR_ARENA_EVENT_TYPES, 'other'].map((type) => <option key={type} value={type}>{type.replaceAll('_', ' ')}</option>)}
    </select></label>
    {isError ? <p role="status" style={terminalMuted}>The latest refresh failed. Data can be out of date.</p> : null}
    {isLoading ? <p style={terminalMuted}>Loading rule checks...</p> : filtered.length === 0 ? <p style={terminalMuted}>No rule checks in this view.</p> : filtered.slice(0, rail ? 30 : 200).map((event) => <article key={event.id} data-event-type={event.type} style={{ borderLeft: '2px solid #2f5bb5', padding: '10px 0 10px 12px', overflowWrap: 'anywhere' }}>
      <div style={{ ...terminalMuted, fontFamily: 'monospace', fontSize: 12 }}>{isoAgo(event.at, nowMs)} <span style={{ color: '#E0C070' }}>{event.type.replaceAll('_', ' ')}</span></div>
      <div style={{ fontSize: 14, lineHeight: 1.5 }}>{event.summary}</div>
      {event.pnlUsd !== null ? <div style={{ color: event.pnlUsd < 0 ? '#FF8A75' : '#B8F800' }}>{signedUsd(event.pnlUsd)}</div> : null}
      {event.data && Object.keys(event.data).length > 0 ? <details><summary style={{ ...terminalMuted, cursor: 'pointer' }}>Rule check data</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11, color: '#c3cce6', maxHeight: 240, overflow: 'auto' }}>{JSON.stringify(event.data, null, 2)}</pre></details> : null}
    </article>)}
  </div>;
}
