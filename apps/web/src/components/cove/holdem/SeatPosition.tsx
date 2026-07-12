'use client';

/**
 * SeatPosition — polished seat for Hold'em oval.
 *
 * Phase 6.5.0: prop shape matches holdem-types.ts SeatPositionProps — drop-in
 * replacement for the inline stub in HoldemModal.tsx (swapped in 6.5.1).
 *
 * Props: { seat: SeatState; isPlayer: boolean; revealCards: boolean }
 *   seat.holeCards: [HoldemCard, HoldemCard] | null (null = not yet dealt)
 *   revealCards: true at showdown or for the player's own seat
 *
 * Positioning is handled by the parent (absolute layout in HoldemModal).
 * This component is position-agnostic (no top/left/transform here).
 *
 * Iris Xe safe: pure React/CSS, no drei.
 */

import type { SeatPositionProps } from '@/lib/cove/holdem-types';
import PokerCard from './PokerCard';
import ChipStack from './ChipStack';

const BADGE_BASE: React.CSSProperties = {
  fontSize: 8,
  fontWeight: 800,
  fontFamily: 'monospace',
  borderRadius: 3,
  padding: '1px 3px',
  lineHeight: 1.4,
  userSelect: 'none',
  opacity: 0.85,
};

export default function SeatPosition({ seat, isPlayer, revealCards }: SeatPositionProps) {
  const isFolded = seat.status === 'folded';
  const isAllIn  = seat.status === 'allin';

  return (
    <div
      aria-label={`${seat.name} — ${seat.stack} vCLAW`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        opacity: isFolded ? 0.4 : 1,
        transition: 'opacity 0.3s',
        zIndex: isPlayer ? 2 : 1,
        userSelect: 'none',
      }}
    >
      {/* Hole cards */}
      <div style={{ display: 'flex', gap: 3 }}>
        {seat.holeCards ? (
          seat.holeCards.map((card, i) => (
            <PokerCard
              key={i}
              card={revealCards ? { ...card, hidden: false } : card}
              compact={!isPlayer}
              delay={seat.seatIndex * 80 + i * 60}
            />
          ))
        ) : (
          <>
            <div style={{
              width: isPlayer ? 48 : 36, height: isPlayer ? 70 : 52,
              borderRadius: 5,
              border: '1.5px dashed rgba(120,200,180,0.15)',
              opacity: 0.3,
            }} />
            <div style={{
              width: isPlayer ? 48 : 36, height: isPlayer ? 70 : 52,
              borderRadius: 5,
              border: '1.5px dashed rgba(120,200,180,0.15)',
              opacity: 0.3,
            }} />
          </>
        )}
      </div>

      {/* Seat label panel */}
      <div style={{
        background: isPlayer
          ? 'rgba(0,160,120,0.85)'
          : seat.isActing
            ? 'rgba(200,150,30,0.85)'
            : 'rgba(0,0,0,0.72)',
        border: seat.isActing
          ? '1px solid #f59e0b'
          : isPlayer
            ? '1px solid rgba(0,200,160,0.5)'
            : '1px solid rgba(60,100,80,0.3)',
        borderRadius: 6,
        padding: '3px 7px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        minWidth: 56,
        boxShadow: seat.isActing ? '0 0 10px rgba(200,150,30,0.4)' : 'none',
        transition: 'all 0.2s',
      }}>
        {/* Name row + position badges */}
        <div style={{
          fontSize: 10, fontWeight: 700, fontFamily: 'monospace',
          color: isPlayer ? '#fff' : '#cbd5e1',
          letterSpacing: '0.06em',
          display: 'flex', alignItems: 'center', gap: 3,
        }}>
          {seat.isDealer && (
            <span style={{ ...BADGE_BASE, background: '#1e40af', color: '#bfdbfe' }}>D</span>
          )}
          {seat.isSmallBlind && (
            <span style={{ ...BADGE_BASE, background: '#065f46', color: '#a7f3d0' }}>SB</span>
          )}
          {seat.isBigBlind && (
            <span style={{ ...BADGE_BASE, background: '#7c3aed', color: '#ddd6fe' }}>BB</span>
          )}
          <span style={{
            maxWidth: 52,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {seat.name}
          </span>
        </div>

        {/* Stack */}
        <ChipStack amount={seat.stack} inline />

        {/* Street bet */}
        {seat.streetBet > 0 && (
          <div style={{ fontSize: 9, color: 'rgba(180,210,200,0.6)', fontFamily: 'monospace' }}>
            bet {seat.streetBet}
          </div>
        )}

        {/* AllIn badge */}
        {isAllIn && (
          <div style={{
            fontSize: 9, fontWeight: 700, fontFamily: 'monospace',
            color: '#fbbf24',
          }}>
            ALL IN
          </div>
        )}
      </div>
    </div>
  );
}
