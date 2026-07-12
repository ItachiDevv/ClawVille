'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CoveHistoryEventRow, GameType } from '@/lib/cove/history-client';

interface HistoryRowProps {
  event: CoveHistoryEventRow;
}

const GAME_LABEL: Record<GameType, string> = {
  slots: 'Slots',
  blackjack: 'Blackjack',
  holdem: "Hold'em",
  baccarat: 'Baccarat',
};

const GAME_COLOR: Record<GameType, string> = {
  slots: '#9bfff0',
  blackjack: '#ff8aa0',
  holdem: '#dde8f0',
  baccarat: '#9ab4ff',
};

function formatCT(atomic: string): string {
  try {
    const n = BigInt(atomic);
    // 1 CT = 1 atomic unit for ClawTokens; display with no decimals for now.
    return n.toLocaleString();
  } catch {
    return atomic;
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function HistoryRow({ event }: HistoryRowProps) {
  const [expanded, setExpanded] = useState(false);

  const pnl = BigInt(event.payout) - BigInt(event.betAmount);
  const isWin = pnl >= 0n;

  return (
    <>
      <tr
        style={{
          borderTop: '1px solid rgba(0,255,224,0.07)',
          cursor: 'pointer',
          background: expanded ? 'rgba(0,255,224,0.025)' : 'transparent',
          transition: 'background 0.12s',
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Timestamp */}
        <td style={td()}>
          <span style={{ color: 'rgba(224,255,248,0.65)', fontSize: 11, fontFamily: 'monospace' }}>
            {formatTimestamp(event.createdAt)}
          </span>
        </td>

        {/* Game */}
        <td style={td()}>
          <span
            style={{
              color: GAME_COLOR[event.gameType] ?? '#e0fff8',
              fontFamily: 'monospace',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.06em',
            }}
          >
            {GAME_LABEL[event.gameType] ?? event.gameType}
          </span>
        </td>

        {/* Bet */}
        <td style={{ ...td(), textAlign: 'right' }}>
          <span style={{ color: 'rgba(224,255,248,0.75)', fontFamily: 'monospace', fontSize: 12 }}>
            {formatCT(event.betAmount)} vCLAW
          </span>
        </td>

        {/* Payout */}
        <td style={{ ...td(), textAlign: 'right' }}>
          <span
            style={{
              color: isWin ? '#7cff9a' : '#ff8aa0',
              fontFamily: 'monospace',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {isWin ? '+' : ''}{formatCT(pnl.toString())} vCLAW
          </span>
        </td>

        {/* Outcome badge */}
        <td style={td()}>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: isWin ? 'rgba(0,255,100,0.1)' : 'rgba(255,56,96,0.1)',
              border: `1px solid ${isWin ? 'rgba(0,255,100,0.35)' : 'rgba(255,56,96,0.35)'}`,
              color: isWin ? '#7cff9a' : '#ff8aa0',
              fontSize: 10,
              fontFamily: 'monospace',
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            {isWin ? 'Win' : 'Loss'}
          </span>
        </td>

        {/* Verify button */}
        <td style={td()} onClick={(e) => e.stopPropagation()}>
          <Link
            href={`/cove/verify/event/${event.id}`}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid rgba(0,255,224,0.35)',
              background: 'rgba(0,255,224,0.07)',
              color: 'rgba(0,255,224,0.8)',
              textDecoration: 'none',
              fontSize: 11,
              fontFamily: 'monospace',
              fontWeight: 700,
              letterSpacing: '0.08em',
              whiteSpace: 'nowrap',
            }}
          >
            Verify
          </Link>
        </td>
      </tr>

      {/* Expanded drawer */}
      {expanded && (
        <tr>
          <td
            colSpan={6}
            style={{
              padding: '12px 16px',
              background: 'rgba(5,10,24,0.6)',
              borderTop: '1px solid rgba(0,255,224,0.06)',
            }}
          >
            <div style={{ display: 'grid', gap: 6, fontSize: 11, fontFamily: 'monospace' }}>
              {/* Hash chain */}
              <DrawerRow label="serverSeedHash" value={event.serverSeedHash} mono />
              <DrawerRow
                label="serverSeed"
                value={event.revealedServerSeed ?? '(locked — session still open)'}
                mono
                tone={event.revealedServerSeed ? 'ok' : 'dim'}
              />
              <DrawerRow label="clientSeed" value={event.clientSeed} mono />
              <DrawerRow label="nonce" value={String(event.nonce)} />

              {/* Seed reveal status */}
              {event.revealedServerSeed === null && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 8px',
                    borderRadius: 6,
                    background: 'rgba(255,220,80,0.08)',
                    border: '1px solid rgba(255,220,80,0.25)',
                    color: '#ffd684',
                    fontSize: 10,
                    letterSpacing: '0.08em',
                    width: 'fit-content',
                  }}
                >
                  Shoe still open — verify after session closes
                </span>
              )}

              {/* outcomeJson */}
              <div style={{ marginTop: 6 }}>
                <div
                  style={{
                    color: 'rgba(0,255,224,0.55)',
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    fontSize: 10,
                    marginBottom: 4,
                  }}
                >
                  Outcome Data
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: '8px 12px',
                    background: 'rgba(2,6,14,0.6)',
                    border: '1px solid rgba(0,255,224,0.1)',
                    borderRadius: 6,
                    color: '#b8e8e0',
                    fontSize: 10,
                    overflowX: 'auto',
                    maxHeight: 200,
                    overflowY: 'auto',
                    lineHeight: 1.55,
                  }}
                >
                  {JSON.stringify(event.outcomeJson, null, 2)}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function td(): React.CSSProperties {
  return { padding: '9px 12px', verticalAlign: 'middle' };
}

function DrawerRow({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'ok' | 'dim';
}) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span style={{ color: 'rgba(0,255,224,0.5)', minWidth: 130 }}>{label}</span>
      <span
        style={{
          color:
            tone === 'ok'
              ? '#9bfff0'
              : tone === 'dim'
                ? 'rgba(224,255,248,0.35)'
                : '#d0ece8',
          fontFamily: mono ? 'monospace' : 'inherit',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </span>
    </div>
  );
}
