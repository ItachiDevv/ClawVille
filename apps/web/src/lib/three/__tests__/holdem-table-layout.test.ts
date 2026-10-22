import { describe, expect, test } from 'bun:test';
import type { CashSettledHandSnapshot } from '@clawville/shared';
import type { CashPokerCard, CashPublicSnapshot } from '@/lib/cove/cash-poker';
import {
  BOT_SEATS,
  buildCashCardState,
  CARD_LAYOUT,
  resolveOwnFeltCards,
  SEATED_CAMERA_FOV,
  SEATED_CAM_EYE,
  SEATED_CAM_LOOK,
  TABLE_TOP_Y,
} from '../holdem-table-layout';

const W = 1568;
const H = 772;
const FOCAL_PX = (H / 2) / Math.tan((SEATED_CAMERA_FOV * Math.PI) / 360);

function norm(v: number[]): number[] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return v.map((c) => c / l);
}
function cross(a: number[], b: number[]): number[] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
const FWD = norm(SEATED_CAM_LOOK.map((c, i) => c - SEATED_CAM_EYE[i]!));
const RIGHT = norm(cross(FWD, [0, 1, 0]));
const UP = cross(RIGHT, FWD);

/** Pinhole projection of a world point to 1568x772 pixels (null = behind eye). */
function project(x: number, y: number, z: number) {
  const d = [x - SEATED_CAM_EYE[0], y - SEATED_CAM_EYE[1], z - SEATED_CAM_EYE[2]];
  const depth = d[0]! * FWD[0]! + d[1]! * FWD[1]! + d[2]! * FWD[2]!;
  if (depth <= 1) return null;
  const px = d[0]! * RIGHT[0]! + d[1]! * RIGHT[1]! + d[2]! * RIGHT[2]!;
  const py = d[0]! * UP[0]! + d[1]! * UP[1]! + d[2]! * UP[2]!;
  return { sx: W / 2 + (px / depth) * FOCAL_PX, sy: H / 2 - (py / depth) * FOCAL_PX, depth };
}
const cardPxWidth = (width: number, depth: number) => (width / depth) * FOCAL_PX;
const SURFACE_Y = TABLE_TOP_Y + CARD_LAYOUT.surfaceLift!;

const card = (suit: CashPokerCard['suit'], rank: CashPokerCard['rank']): CashPokerCard => ({ suit, rank });
const OWN = [card('spades', 'A'), card('hearts', 'K')] as const;

describe('seated-eye card readability (1568x772)', () => {
  test('every hole-card anchor is on screen, on the felt, and wide enough to read', () => {
    for (const seat of BOT_SEATS) {
      const x = seat.cardX!;
      const z = seat.cardZ!;
      expect(Math.abs(x)).toBeLessThanOrEqual(CARD_LAYOUT.feltHalfX!);
      expect(Math.abs(z)).toBeLessThanOrEqual(CARD_LAYOUT.feltHalfZ!);
      const p = project(x, SURFACE_Y, z)!;
      expect(p).not.toBeNull();
      expect(p.sx).toBeGreaterThan(0);
      expect(p.sx).toBeLessThan(W);
      expect(p.sy).toBeGreaterThan(0);
      expect(p.sy).toBeLessThan(H);
      expect(cardPxWidth(CARD_LAYOUT.botCardWidth!, p.depth)).toBeGreaterThanOrEqual(14);
    }
  });

  test('board cards are at least 24 px wide, inside the felt, and do not overlap', () => {
    const p = project(CARD_LAYOUT.boardX!, SURFACE_Y, CARD_LAYOUT.boardZ!)!;
    expect(cardPxWidth(CARD_LAYOUT.boardCardWidth!, p.depth)).toBeGreaterThanOrEqual(24);
    expect(CARD_LAYOUT.boardSpacing!).toBeGreaterThan(CARD_LAYOUT.boardCardWidth!);
    const half = (CARD_LAYOUT.boardSpacing! * 4 + CARD_LAYOUT.boardCardWidth!) / 2;
    expect(half).toBeLessThanOrEqual(CARD_LAYOUT.feltHalfX!);
    expect(CARD_LAYOUT.boardYaw).toBe(0);
  });

  test('own cards are bigger than the board cards and clear of the board', () => {
    const own = project(CARD_LAYOUT.ownX!, SURFACE_Y, CARD_LAYOUT.ownZ!)!;
    expect(cardPxWidth(CARD_LAYOUT.ownCardWidth!, own.depth)).toBeGreaterThanOrEqual(30);
    const boardNear = CARD_LAYOUT.boardZ! - CARD_LAYOUT.boardCardHeight! / 2;
    const ownFar = CARD_LAYOUT.ownZ! + CARD_LAYOUT.ownCardHeight! / 2;
    expect(ownFar).toBeLessThan(boardNear);
    expect(CARD_LAYOUT.ownSpacing!).toBeGreaterThan(CARD_LAYOUT.ownCardWidth!);
  });

  test('no two seats put their hole-card pairs on top of each other', () => {
    const pair = CARD_LAYOUT.botCardWidth! * 2 + CARD_LAYOUT.botPairGap!;
    for (let i = 0; i < BOT_SEATS.length; i++) {
      for (let j = i + 1; j < BOT_SEATS.length; j++) {
        const dx = Math.abs(BOT_SEATS[i]!.cardX! - BOT_SEATS[j]!.cardX!);
        const dz = Math.abs(BOT_SEATS[i]!.cardZ! - BOT_SEATS[j]!.cardZ!);
        expect(dx >= pair || dz >= CARD_LAYOUT.botCardHeight!).toBe(true);
      }
    }
  });
});

describe('resolveOwnFeltCards', () => {
  const ownHole = { handNumber: 7, cards: OWN };
  test('returns the two cards for an active or all-in own seat on the same hand', () => {
    expect(resolveOwnFeltCards(ownHole, 7, 'active')).toEqual([
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: 'K' },
    ]);
    expect(resolveOwnFeltCards(ownHole, 7, 'allin')).not.toBeNull();
  });
  test('returns null for a stale hand, a folded or out seat, or no hole cards', () => {
    expect(resolveOwnFeltCards(ownHole, 8, 'active')).toBeNull();
    expect(resolveOwnFeltCards(ownHole, 7, 'folded')).toBeNull();
    expect(resolveOwnFeltCards(ownHole, 7, 'sitting_out')).toBeNull();
    expect(resolveOwnFeltCards(ownHole, 7, 'busted')).toBeNull();
    expect(resolveOwnFeltCards(ownHole, 7, undefined)).toBeNull();
    expect(resolveOwnFeltCards(null, 7, 'active')).toBeNull();
  });
});

describe('buildCashCardState', () => {
  const live = {
    handNumber: 7,
    board: [card('clubs', '2'), card('clubs', '3'), card('clubs', '4')],
    seats: [
      { seatIndex: 0, status: 'active' },
      { seatIndex: 1, status: 'folded' },
      { seatIndex: 2, status: 'sitting_out' },
      { seatIndex: 3, status: 'allin' },
    ],
  } as unknown as CashPublicSnapshot;

  test('live hand: active and all-in seats get two face-down cards, others none', () => {
    const state = buildCashCardState({
      cashLive: live,
      cashSettled: null,
      ownHole: { handNumber: 7, cards: OWN },
      povSeatIndex: 3,
    });
    expect(state.active).toBe(true);
    expect(state.board).toHaveLength(3);
    expect(state.seats!.map((s) => s.holeCardCount)).toEqual([2, 0, 0, 2]);
    expect(state.seats!.every((s) => s.cards === null)).toBe(true);
    expect(state.ownCards).not.toBeNull();
  });

  test('no table state: inactive, no own cards', () => {
    const state = buildCashCardState({
      cashLive: null,
      cashSettled: null,
      ownHole: { handNumber: 7, cards: OWN },
      povSeatIndex: 3,
    });
    expect(state.active).toBe(false);
    expect(state.ownCards).toBeNull();
  });

  test('settled hand: shown cards face up, folded seats and fold-wins show none', () => {
    const settled = {
      handNumber: 7,
      board: live.board,
      seats: [
        { seatIndex: 0, status: 'active', shown: [card('hearts', 'Q'), card('hearts', 'J')] },
        { seatIndex: 1, status: 'folded', shown: [card('hearts', '9'), card('hearts', '8')] },
        { seatIndex: 3, status: 'active', shown: null },
      ],
    } as unknown as CashSettledHandSnapshot;
    const state = buildCashCardState({
      cashLive: null,
      cashSettled: settled,
      ownHole: { handNumber: 7, cards: OWN },
      povSeatIndex: 3,
    });
    const bySeat = new Map(state.seats!.map((s) => [s.seatIndex, s]));
    expect(bySeat.get(0)!.holeCardCount).toBe(2);
    expect(bySeat.get(0)!.cards).toHaveLength(2);
    expect(bySeat.get(1)!.holeCardCount).toBe(0);
    expect(bySeat.get(1)!.cards).toBeNull();
    expect(bySeat.get(3)!.holeCardCount).toBe(0);
    expect(state.ownCards).not.toBeNull();
  });
});
