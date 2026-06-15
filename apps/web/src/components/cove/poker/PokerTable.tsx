'use client';

/**
 * PokerTable — live N-seat Texas Hold'em felt for the MTT.
 *
 * Driven entirely by `stores/poker.ts` (the WS switchboard the activity store
 * delegates `poker.*` frames to). It does NOT open its own socket — the parent
 * route mounts `useActivityWs(...)` and every `poker.table_state` /
 * `poker.your_turn` / `poker.hole_cards` frame flows into `usePokerStore`.
 *
 * Layout
 * ──────
 * A parametric oval seat ring (up to 9 seats). The SELF seat (resolved by the
 * `selfAvatarId` prop matched against `seat.avatarId`) is ALWAYS pinned to the
 * bottom-center; the remaining seats fan out clockwise around the oval from
 * there. This keeps the player's own cards + the action bar in the thumb zone
 * on mobile and reads like a real felt on desktop.
 *
 * Hidden-state invariant (asserted defensively)
 * ──────────────────────────────────────────────
 * The public `poker.table_state` snapshot carries NO hole cards by type. Other
 * seats render face-down card-backs UNTIL a showdown reveal arrives on
 * `poker.showdown` (folded seats muck → null). Our OWN hole cards come only
 * from the PRIVATE `poker.hole_cards` / `poker.your_turn` frames. We never read
 * another seat's hole cards from a public frame (there is no such field), and a
 * dev-time assertion guards against a future regression.
 *
 * Iris Xe safe: pure DOM/CSS. No Three.js, no drei <Text>/<Billboard>, no
 * WebGPU. The 3D world is a different surface entirely.
 */

import { useMemo } from 'react';
import { usePokerStore } from '@/stores/poker';
import type {
  PokerSeatPublicState,
  PokerCard as WireCard,
  PokerHandResultSeat,
} from '@clawville/shared';
import SeatPosition from '@/components/cove/holdem/SeatPosition';
import CommunityCardRow from '@/components/cove/holdem/CommunityCardRow';
import PotDisplay from '@/components/cove/holdem/PotDisplay';
import type { SeatState, HoldemCard } from '@/lib/cove/holdem-types';
import { TurnClock } from './TurnClock';

// ─── Oval geometry ───────────────────────────────────────────────────────────
//
// Seats are placed on an ellipse inscribed in the felt. Angle 90° (bottom) is
// the SELF seat; the rest are distributed evenly around the remaining arc so
// they read clockwise from the player. The ellipse radii are percentages of the
// felt box so the layout is fully responsive (shrinks with the felt at phone /
// iPad widths — no fixed px).

interface SeatSlot {
  /** CSS top (%) of the seat anchor. */
  top: string;
  /** CSS left (%) of the seat anchor. */
  left: string;
  /** translate to center the seat box on its anchor. */
  transform: string;
}

/**
 * Compute the absolute oval anchor for a seat at ring-relative index
 * `ringPos` (0 = self at bottom-center) out of `total` seats.
 *
 * The ellipse is centered at (50%, 47%) — slightly above middle to leave room
 * for the bottom-pinned self seat + action bar. Radii in % of the felt box.
 */
function ovalSlot(ringPos: number, total: number): SeatSlot {
  // Self pinned dead-bottom-center; do not run it through the ellipse so it
  // always lands in the thumb zone regardless of seat count.
  if (ringPos === 0) {
    return { top: '100%', left: '50%', transform: 'translate(-50%, -100%)' };
  }

  const CX = 50;
  const CY = 46;
  const RX = 44; // horizontal radius (%)
  const RY = 38; // vertical radius (%)

  // Distribute the non-self seats evenly across the ring. Start at the bottom
  // (90° in screen space, where +Y points DOWN) and walk clockwise.
  const startDeg = 90;
  const stepDeg = 360 / total;
  const deg = startDeg + ringPos * stepDeg;
  const rad = (deg * Math.PI) / 180;

  // Screen-space: x = cos, y = sin (y down). cos(90°)=0, sin(90°)=1 → bottom.
  const x = CX + RX * Math.cos(rad);
  const y = CY + RY * Math.sin(rad);

  return {
    top: `${y}%`,
    left: `${x}%`,
    transform: 'translate(-50%, -50%)',
  };
}

// ─── Wire → view-model adapter ───────────────────────────────────────────────

/**
 * Build the `SeatState` the reused `SeatPosition` component renders from the
 * PUBLIC wire seat + (only for the self seat, or at showdown) the cards we are
 * actually allowed to see.
 *
 * `selfHole` — our OWN hole cards (private frame) when this is the self seat.
 * `revealCards` — showdown reveal for this seat (from poker.showdown).
 * `showdownHole` — the revealed cards at showdown for ANY seat that reached it.
 */
function toSeatState(
  seat: PokerSeatPublicState,
  opts: {
    isSelf: boolean;
    selfHole: [WireCard, WireCard] | null;
    showdownHole: [WireCard, WireCard] | null;
    handLive: boolean;
  },
): SeatState {
  const { isSelf, selfHole, showdownHole, handLive } = opts;

  // Resolve which cards (if any) this seat should render and whether face-up.
  let holeCards: [HoldemCard, HoldemCard] | null = null;
  if (showdownHole) {
    // Post-resolution reveal — face-up, real cards.
    holeCards = [
      { ...showdownHole[0], hidden: false },
      { ...showdownHole[1], hidden: false },
    ];
  } else if (isSelf && selfHole) {
    // Our own cards — face-up to us only.
    holeCards = [
      { ...selfHole[0], hidden: false },
      { ...selfHole[1], hidden: false },
    ];
  } else if (
    handLive &&
    (seat.status === 'active' || seat.status === 'allin' || seat.status === 'folded')
  ) {
    // Another live seat mid-hand — face-DOWN card backs. We never receive
    // their cards; the public snapshot carries none. Rendered hidden.
    holeCards = [
      { suit: 'spades', rank: 'A', hidden: true },
      { suit: 'spades', rank: 'A', hidden: true },
    ];
  }

  // Map the 5-state wire status onto the felt component's 4-state status.
  const status: SeatState['status'] =
    seat.status === 'busted' || seat.status === 'sitting_out'
      ? 'out'
      : seat.status === 'allin'
        ? 'allin'
        : seat.status === 'folded'
          ? 'folded'
          : 'active';

  return {
    seatIndex: seat.seatIndex,
    name: isSelf ? 'You' : seat.name,
    stack: seat.chipStack,
    streetBet: seat.streetBet,
    holeCards,
    status,
    isSmallBlind: seat.isSB,
    isBigBlind: seat.isBB,
    isDealer: seat.isButton,
    isActing: seat.isActing,
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export interface PokerTableProps {
  /** Our own avatar id — gates which seat is "self" (bottom-pinned + reveal). */
  selfAvatarId: string | null;
}

export default function PokerTable({ selfAvatarId }: PokerTableProps) {
  const table = usePokerStore((s) => s.table);
  const board = usePokerStore((s) => s.board);
  const holeCards = usePokerStore((s) => s.holeCards);
  const holeCardsHandNumber = usePokerStore((s) => s.holeCardsHandNumber);
  const lastShowdown = usePokerStore((s) => s.lastShowdown);

  // Resolve the self seat index (by avatarId) so we can rotate the ring.
  const selfSeatIndex = useMemo(() => {
    if (!table || !selfAvatarId) return null;
    const me = table.seats.find((s) => s.avatarId === selfAvatarId);
    return me ? me.seatIndex : null;
  }, [table, selfAvatarId]);

  // Showdown reveal map (seatIndex → revealed cards) — only valid for the
  // current hand, and only seats that reached showdown (folded → null).
  const showdownMap = useMemo(() => {
    const m = new Map<number, [WireCard, WireCard] | null>();
    if (lastShowdown && table && lastShowdown.handNumber === table.handNumber) {
      for (const s of lastShowdown.seats) {
        m.set(s.seatIndex, s.holeCards);
      }
    }
    return m;
  }, [lastShowdown, table]);

  // Our own hole cards are valid only for the CURRENT hand.
  const selfHoleForHand: [WireCard, WireCard] | null = useMemo(() => {
    if (!table || !holeCards) return null;
    if (holeCardsHandNumber !== table.handNumber) return null;
    return holeCards;
  }, [table, holeCards, holeCardsHandNumber]);

  // Build the ring order: self at ringPos 0, the rest clockwise by seatIndex.
  // Null-safe so this hook runs unconditionally (no early-return above it).
  const orderedSeats = useMemo(() => {
    if (!table) return [] as Array<{ seat: PokerSeatPublicState; ringPos: number }>;
    const seats = [...table.seats].sort((a, b) => a.seatIndex - b.seatIndex);
    if (selfSeatIndex == null) return seats.map((seat, i) => ({ seat, ringPos: i }));
    const selfIdx = seats.findIndex((s) => s.seatIndex === selfSeatIndex);
    const n = seats.length;
    return seats.map((seat) => {
      const rawPos = seats.indexOf(seat);
      const ringPos = (rawPos - selfIdx + n) % n;
      return { seat, ringPos };
    });
  }, [table, selfSeatIndex]);

  // Board slots padded to 5 for the community row (null = undealt).
  const communityCards: (HoldemCard | null)[] = useMemo(() => {
    const out: (HoldemCard | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const c = board[i];
      out.push(c ? { ...c } : null);
    }
    return out;
  }, [board]);

  // ── Defensive hidden-state assertion (dev only) ─────────────────────────
  // The public snapshot type has no hole-card field, so this can only ever be
  // a future regression. We assert in dev that no PUBLIC seat object smuggled
  // a `holeCards` key in.
  if (process.env.NODE_ENV !== 'production' && table) {
    for (const s of table.seats) {
      if ('holeCards' in (s as unknown as Record<string, unknown>)) {
        // eslint-disable-next-line no-console
        console.error(
          '[PokerTable] HIDDEN-STATE VIOLATION: public seat carried holeCards',
          s.seatIndex,
        );
      }
    }
  }

  if (!table) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'rgba(124,255,203,0.8)',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          letterSpacing: '0.18em',
          fontSize: 12,
        }}
      >
        DEALING IN…
      </div>
    );
  }

  const handLive = table.street !== 'showdown';
  const seatCount = table.seats.length;

  return (
    <div
      role="group"
      aria-label="Poker table"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        // Radial green felt with a darker rail vignette.
        background:
          'radial-gradient(ellipse 70% 60% at 50% 44%, #0c5a3a 0%, #0a4730 45%, #06281c 100%)',
      }}
    >
      {/* Felt rail oval — decorative ellipse border. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: '8%',
          left: '6%',
          width: '88%',
          height: '76%',
          borderRadius: '50%',
          border: '3px solid rgba(0,0,0,0.45)',
          boxShadow:
            'inset 0 0 60px rgba(0,0,0,0.55), 0 0 0 8px rgba(8,40,28,0.6)',
          pointerEvents: 'none',
        }}
      />

      {/* Center: pot + community row + blinds level. */}
      <div
        style={{
          position: 'absolute',
          top: '42%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          zIndex: 3,
        }}
      >
        <CommunityCardRow cards={communityCards} />
        <PotDisplay pot={table.pot} />
        <div
          style={{
            fontSize: 10,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: 'rgba(124,255,203,0.6)',
            letterSpacing: '0.1em',
          }}
        >
          BLINDS {table.blinds.sb}/{table.blinds.bb}
          {table.blinds.ante > 0 ? ` · ANTE ${table.blinds.ante}` : ''} · LVL{' '}
          {table.blinds.level}
        </div>
      </div>

      {/* Seats around the oval. */}
      {orderedSeats.map(({ seat, ringPos }) => {
        const isSelf = selfSeatIndex != null && seat.seatIndex === selfSeatIndex;
        const slot = ovalSlot(ringPos, seatCount);
        const showdownHole = showdownMap.has(seat.seatIndex)
          ? showdownMap.get(seat.seatIndex) ?? null
          : null;
        const revealCards = isSelf || showdownHole != null;

        const seatState = toSeatState(seat, {
          isSelf,
          selfHole: isSelf ? selfHoleForHand : null,
          showdownHole,
          handLive,
        });

        return (
          <div
            key={seat.seatIndex}
            style={{
              position: 'absolute',
              top: slot.top,
              left: slot.left,
              transform: slot.transform,
              zIndex: isSelf ? 5 : 2,
            }}
          >
            <SeatPosition seat={seatState} isPlayer={isSelf} revealCards={revealCards} />
            {/* Per-seat turn clock under the acting seat. */}
            {seat.isActing && table.toActDeadlineMs != null && (
              <div
                style={{
                  marginTop: 4,
                  display: 'flex',
                  justifyContent: 'center',
                }}
              >
                <TurnClock deadlineMs={table.toActDeadlineMs} compact />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Re-export for the showdown summary consumer.
export type { PokerHandResultSeat };
