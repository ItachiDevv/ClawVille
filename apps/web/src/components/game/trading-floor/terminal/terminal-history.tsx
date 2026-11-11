'use client';

import { useId, useState } from 'react';
import { FLOOR_ARENA_EXIT_REASONS, type FloorArenaExitReason } from '@clawville/shared';
import { parseArenaTimestamp, useFloorArenaEquity, useFloorArenaTrades, type FloorArenaEquityView, type FloorArenaEquityWindow, type FloorArenaTradeOutcome } from '@/hooks/use-floor-arena';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { ArenaClosedTrades } from '../arena/arena-parts';
import { signedUsd } from '../arena/arena-format';
import { TerminalBlock, TerminalWindowPicker, terminalButton, terminalMuted } from './terminal-parts';

export function TerminalTrades({ agentId, owner = false, active = true, nowMs }: { agentId: string; owner?: boolean; active?: boolean; nowMs: number }) {
  const [outcome, setOutcome] = useState<FloorArenaTradeOutcome>('all');
  const [reason, setReason] = useState<FloorArenaExitReason | ''>('');
  const query = useFloorArenaTrades(agentId, { owner, enabled: active, outcome, reason: reason || undefined });
  const positions = query.data?.pages.flatMap((page) => page.trades) ?? [];
  return <TerminalBlock title="Closed trades">
    <p style={terminalMuted}>P&amp;L includes paper costs. Exit prices are unavailable because fills and costs do not identify an exact exit price.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
      <label style={terminalMuted}>Outcome <select aria-label="Trade outcome" style={terminalButton} value={outcome} onChange={(event) => setOutcome(event.target.value as FloorArenaTradeOutcome)}><option value="all">All</option><option value="win">Wins</option><option value="loss">Losses</option></select></label>
      <label style={terminalMuted}>Exit reason <select aria-label="Trade exit reason" style={terminalButton} value={reason} onChange={(event) => setReason(event.target.value as FloorArenaExitReason | '')}><option value="">All</option>{FLOOR_ARENA_EXIT_REASONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
    </div>
    {query.isError ? <p role="status" style={terminalMuted}>{query.data ? 'Trades could not be refreshed. Data can be out of date.' : 'Trades could not be loaded.'}</p> : null}
    {query.isLoading ? <p style={terminalMuted}>Loading trades...</p> : query.data ? positions.length > 0 ? <ArenaClosedTrades positions={positions} nowMs={nowMs} limit={positions.length} /> : <p style={terminalMuted}>No closed trades match these filters.</p> : null}
    {query.hasNextPage ? <button type="button" style={terminalButton} disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading more...' : 'Load more'}</button> : null}
  </TerminalBlock>;
}

export function EquityCurve({ series }: { series: FloorArenaEquityView['series'] }) {
  const id = useId().replaceAll(':', '');
  const isMobile = useIsMobile();
  const width = isMobile ? 360 : 600;
  const right = width - (isMobile ? 12 : 82);
  const labelSize = isMobile ? 14 : 11;
  if (series.length === 0) return <p style={terminalMuted}>No closed trades in this window. No equity curve is available.</p>;
  const times = series.map((point) => parseArenaTimestamp(point.closedAt));
  const start = Math.min(...times); const end = Math.max(...times);
  const low = Math.min(0, ...series.map((point) => point.equityUsd));
  const high = Math.max(0, ...series.map((point) => point.equityUsd));
  const span = high - low || 1;
  const y = (value: number) => 160 - (value - low) / span * 140;
  const points = series.map((point, index) => ({ x: end === start ? (78 + right) / 2 : 78 + (times[index]! - start) / (end - start) * (right - 78), y: y(point.equityUsd) }));
  // Step changes only at actual close times. Never insert a fabricated opening trade.
  const path = points.map((point, index) => index === 0 ? `M ${point.x} ${point.y}` : `H ${point.x} V ${point.y}`).join(' ');
  return <svg role="img" aria-label="Realised equity in USD by close time" viewBox={`0 0 ${width} 210`} style={{ width: '100%', display: 'block' }}>
    <defs><clipPath id={`${id}-positive`}><rect x="78" y="0" width={right - 68} height={y(0)} /></clipPath><clipPath id={`${id}-negative`}><rect x="78" y={y(0)} width={right - 68} height={180 - y(0)} /></clipPath></defs>
    <line x1="78" x2={right} y1={y(0)} y2={y(0)} stroke="#a7b4d8" strokeDasharray="4 4" />
    <text x="4" y="15" fill="#a7b4d8" fontSize={isMobile ? 14 : 12}>USD</text>
    {[...new Set([high, 0, low])].map((value) => <text key={value} x="72" y={y(value) + 4} textAnchor="end" fill="#a7b4d8" fontSize={isMobile ? 14 : 12}>{value.toFixed(2)}</text>)}
    <path d={path} fill="none" stroke="#B8F800" strokeWidth="2" clipPath={`url(#${id}-positive)`} />
    <path d={path} fill="none" stroke="#FF8A75" strokeWidth="2" clipPath={`url(#${id}-negative)`} />
    {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="2" fill={series[index]!.equityUsd < 0 ? '#FF8A75' : '#B8F800'}><title>{`${series[index]!.closedAt}: ${signedUsd(series[index]!.equityUsd)}`}</title></circle>)}
    <text x="78" y="190" fill="#a7b4d8" fontSize={labelSize}>{new Date(start).toISOString().slice(0, 16).replace('T', ' ')} UTC</text>
    {end !== start ? <text x={right} y="207" textAnchor="end" fill="#a7b4d8" fontSize={labelSize}>{new Date(end).toISOString().slice(0, 16).replace('T', ' ')} UTC</text> : null}
  </svg>;
}

export function TerminalEquity({ agentId, owner = false, active = true }: { agentId: string; owner?: boolean; active?: boolean }) {
  const [range, setRange] = useState<FloorArenaEquityWindow>('contest');
  const query = useFloorArenaEquity(agentId, range, { owner, enabled: active });
  return <TerminalBlock title="Equity curve">
    <TerminalWindowPicker value={range} onChange={setRange} windows={['contest', '24h', '7d', 'all']} />
    <p style={terminalMuted}>Realised paper P&amp;L for this window. Paper costs included.</p>
    {query.isError ? <p role="status" style={terminalMuted}>{query.data ? 'Equity could not be refreshed. Data can be out of date.' : 'Equity could not be loaded.'}</p> : null}
    {query.isLoading ? <p style={terminalMuted}>Loading equity...</p> : query.data ? <><EquityCurve series={query.data.series} /><p style={terminalMuted}>Open positions P&amp;L, at last mark: {signedUsd(query.data.openPnlUsd)}{query.data.openPnlUsd === null ? ' (no complete mark)' : ''}</p></> : null}
  </TerminalBlock>;
}
