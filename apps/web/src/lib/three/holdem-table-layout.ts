/**
 * Hold'em table room: pure layout constants (no three.js, no React, no side
 * effects), so tests can project the real seat/card/camera numbers without
 * loading the room's GLTFs. `holdem-table-room.tsx` is the only runtime
 * consumer; `__tests__/holdem-table-layout.test.ts` pins the projection.
 */
import type { CashSettledHandSnapshot } from '@clawville/shared';
import type {
  TableCardLayout,
  TableCardSeat,
  TableCards3DProps,
} from '@/lib/three/cove-table-cards';
import type { CashPokerCard, CashPublicSnapshot } from '@/lib/cove/cash-poker';
import type { HoldemCard } from '@/lib/cove/holdem-types';

const DEG = Math.PI / 180;

// SCALE UNIFICATION (2026-07-17 founder feedback): every figure renders at
// the SAME world-standard height the walkable cove uses for the player's
// own avatar (COVE_VRM_TARGET_HEIGHT = 160). `S` converts avatar/seat
// constants authored at the original scale-2 basis. Round 8 grows only the
// table's XZ footprint.
export const FURNITURE_SCALE = 2.9;
export const S = FURNITURE_SCALE / 2;
export const TABLE_FOOTPRINT_MULTIPLIER = 1.34;
export const TABLE_FOOTPRINT_SCALE = S * TABLE_FOOTPRINT_MULTIPLIER;
export const TABLE_XZ_SCALE = FURNITURE_SCALE * TABLE_FOOTPRINT_MULTIPLIER;
// Round 10 restores the table's own chair at the table-matched 2.9x scale.
export const CHAIR_SCALE = FURNITURE_SCALE;
export const CHAIR_PELVIS_FORWARD_OFFSET = 3.13 * CHAIR_SCALE;
export const TABLE_TOP_Y = 70;

export interface RoomSeat extends TableCardSeat {
  chairX: number;
  chairZ: number;
}

// PLAYER-SEAT STAGING (Round 8): the POV remains at 6 o'clock and all five
// opponents move onto the enlarged table's far arc at 8/10/~12/2/4 o'clock.
// The arc apex bulges toward -Z; the flat edge runs along +Z.
// MEASURED ORIENTATION (2026-07-17, vertex-profile ground truth): the
// table's FLAT full-width edge is at +Z (251wu straight edge at the zMax
// extreme) and the players' arc tapers to -Z (72wu at zMin). Player (camera)
// sits at the ARC APEX at -Z; bots take arc seats toward the flat corners;
// the DEALER stands at the +Z flat edge. Basis coords use the XZ footprint.
export function roomSeat(
  engineSeatIndex: number,
  xBasis: number,
  zBasis: number,
  cardX: number,
  cardZ: number,
): RoomSeat {
  const x = xBasis * TABLE_FOOTPRINT_SCALE;
  const z = zBasis * TABLE_FOOTPRINT_SCALE;
  const faceYaw = Math.atan2(-x, -z);
  return {
    engineSeatIndex,
    x,
    z,
    faceYaw,
    cardX,
    cardZ,
    // Keep the approved body/card/badge center at (x,z), while setting the
    // pelvis on the measured front third and pulling the backrest away.
    chairX: x - Math.sin(faceYaw) * CHAIR_PELVIS_FORWARD_OFFSET,
    chairZ: z - Math.cos(faceYaw) * CHAIR_PELVIS_FORWARD_OFFSET,
  };
}

// One authoritative body/badge center per seat; each chair derives its
// measured front-third offset from that center. Seat 3 is biased
// 20 basis-wu left of exact 12 o'clock so the standing dealer stays readable.
//
// Hole-card anchors are explicit table-local WORLD coordinates (cardX, cardZ),
// chosen from the seated camera's projection so every pair lands on the
// VISIBLE felt: the legacy `seat * 0.72` anchor put the far-seat pair behind
// the far rim and the side-seat pairs under the table horns, so a live seat
// showed no backs at all (measured 2026-10-21; pinned by
// __tests__/holdem-table-layout.test.ts).
export const BOT_SEATS: readonly RoomSeat[] = [
  roomSeat(1, -93.53, -33, -64, -28),
  roomSeat(2, -93.53, 33, -90, 32),
  roomSeat(3, -20, 66, -58, 70),
  roomSeat(4, 93.53, 33, 90, 32),
  roomSeat(5, 93.53, -33, 64, -28),
] as const;

export const CARD_LAYOUT: Readonly<TableCardLayout> = Object.freeze({
  boardX: 0,
  boardZ: 14,
  // Yaw 0 = the card's texture top points AWAY from the seated camera (eye at
  // -Z looking +Z). The pre-2026-10-21 value of PI printed every glyph upside
  // down for the player.
  boardYaw: 0,
  // Round 11 (2026-10-21): an 11.6 wu flat card at ~240 wu from the eye was a
  // 28x12 px smear (the felt is viewed at an ~18 degree pitch). Cards are now
  // ~1.6x larger AND tipped toward the eye so they project near full height.
  boardCardWidth: 18,
  boardCardHeight: 25.2,
  boardSpacing: 21.5,
  boardTiltRad: 40 * DEG,
  botCardWidth: 15.5,
  botCardHeight: 21.7,
  botPairGap: 2,
  botAnchorScale: 0.72,
  holeYaw: 0,
  holeTiltRad: 48 * DEG,
  faceUpScale: 1.15,
  // Own hole cards: face up on the felt directly in front of the POV camera.
  ownCardWidth: 19,
  ownCardHeight: 26.6,
  ownSpacing: 22,
  ownX: 0,
  ownZ: -52,
  ownTiltRad: 44 * DEG,
  surfaceLift: 0.7 * S,
  // W0 parity envelope around the approved room's exact quad extrema
  // (|x|max=140.49, |z|max=101.63), with a small regression margin.
  feltHalfX: 145,
  feltHalfZ: 105,
});

/** Default seated eye: round 8 raises and pulls back the first-person eye. */
export const SEATED_CAM_EYE: readonly [number, number, number] = [0, TABLE_TOP_Y + 78, -230];
export const SEATED_CAM_LOOK: readonly [number, number, number] = [
  0,
  TABLE_TOP_Y + 16,
  36 * TABLE_FOOTPRINT_SCALE,
];
/**
 * Failed seat-model retry policy (SeatFigureSlot). A mutable object so a test
 * can zero it; production never writes it. Each retry that fails again logs
 * its own `[3D] figure replaced by fallback` line (new loader error).
 */
export const SEAT_MODEL_RETRY = { maxRetries: 3, delayMs: 4000 };

/** Vertical field of view in degrees. */
export const SEATED_CAMERA_FOV = 66;

/**
 * Own hole cards to paint on the felt, or null. Pure (unit-tested): the cards
 * must belong to the hand on the table, and a folded / busted own seat shows
 * none (its cards are mucked, exactly like every other folded seat).
 */
export function resolveOwnFeltCards(
  ownHole: { handNumber: number; cards: readonly [CashPokerCard, CashPokerCard] } | null,
  tableHandNumber: number,
  ownSeatStatus: 'active' | 'folded' | 'allin' | 'busted' | 'sitting_out' | undefined,
): readonly [HoldemCard, HoldemCard] | null {
  if (!ownHole || ownHole.handNumber !== tableHandNumber) return null;
  if (ownSeatStatus !== 'active' && ownSeatStatus !== 'allin') return null;
  return [
    { suit: ownHole.cards[0].suit, rank: ownHole.cards[0].rank },
    { suit: ownHole.cards[1].suit, rank: ownHole.cards[1].rank },
  ];
}


/**
 * The felt's card state for a cash table (pure; pinned by tests).
 *  - settled window: every non-folded seat that `shown` cards renders them face
 *    UP in front of its seat; folded seats (and seats with no shown cards, e.g.
 *    a fold-win) render none;
 *  - live hand: every active/all-in seat renders two face-DOWN cards, others
 *    none (sitting_out/busted/folded);
 *  - own hole cards ride along only when they belong to this hand and the own
 *    seat is still in it.
 */
export function buildCashCardState(input: {
  cashLive: CashPublicSnapshot | null;
  cashSettled: CashSettledHandSnapshot | null;
  ownHole: { handNumber: number; cards: readonly [CashPokerCard, CashPokerCard] } | null;
  povSeatIndex: number;
}): NonNullable<TableCards3DProps['externalState']> {
  const { cashLive, cashSettled, ownHole, povSeatIndex } = input;
  if (cashSettled) {
    const ownSeat = cashSettled.seats.find((seat) => seat.seatIndex === povSeatIndex);
    return {
      active: true,
      board: cashSettled.board,
      seats: cashSettled.seats.map((seat) => ({
        seatIndex: seat.seatIndex,
        status: seat.status,
        holeCardCount: seat.status !== 'folded' && seat.shown ? 2 : 0,
        cards: seat.status === 'folded' ? null : seat.shown,
      })),
      ownCards: resolveOwnFeltCards(ownHole, cashSettled.handNumber, ownSeat?.status),
    };
  }
  const ownLiveSeat = cashLive?.seats.find((seat) => seat.seatIndex === povSeatIndex);
  return {
    active: cashLive !== null,
    board: cashLive?.board ?? [],
    seats: cashLive?.seats.map((seat) => ({
      seatIndex: seat.seatIndex,
      status: seat.status,
      holeCardCount: seat.status === 'active' || seat.status === 'allin' ? 2 : 0,
      cards: null,
    })) ?? [],
    ownCards: cashLive
      ? resolveOwnFeltCards(ownHole, cashLive.handNumber, ownLiveSeat?.status)
      : null,
  };
}
