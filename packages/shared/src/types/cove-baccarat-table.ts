/**
 * Shared-table (multiplayer) baccarat: public wire types (2026-10-22).
 *
 * FROZEN contract (spec `baccarat-shared-table-port-2026-10-22.md` section 3.4).
 * The API (`apps/api/src/routes/cove-baccarat-tables.ts`, the table manager) and
 * the web (lobby, shared room controller, HUD, 3D seat figures) all code against
 * these shapes. Do not widen or rename a field without a new frozen spec.
 *
 * Money fields are integer vCLAW numbers on this wire (stakes <= 500, payouts
 * <= 500 x 9). The DB keeps them as stringified bigints.
 */

import type { BaccaratCard } from './cove-baccarat';

export type BaccaratTableTier = 'low' | 'mid' | 'high';
export type BaccaratTablePhase = 'idle' | 'betting' | 'dealing' | 'reveal';
export type BaccaratTableBetSide = 'player' | 'banker' | 'tie';

export interface BaccaratLobbyRow {
  tableId: string;
  tierKey: BaccaratTableTier;
  minBet: number;
  maxBet: number;
  maxSeats: number;
  realSeats: number;        // non-seeded seated
  seededSeats: number;
  openSeats: number;        // maxSeats - realSeats (bots yield)
  phase: BaccaratTablePhase;
  bettingClosesAt: number | null;   // epoch ms
  lastWinner: 'player' | 'banker' | 'tie' | null;
}

export interface BaccaratTableSeatView {
  seatIndex: number;
  avatarId: string;
  name: string;                      // avatars.name; fallback `Seat ${seatIndex + 1}`
  modelKey: string;                  // avatars.model_key (the REAL avatar)
  subjectType: 'human' | 'agent';
  isSeeded: boolean;
  currentBet: { bet: BaccaratTableBetSide; stake: number } | null;  // this round, public chips
}

export interface BaccaratTableSeatResult {
  seatIndex: number;
  avatarId: string;
  name: string;
  bet: BaccaratTableBetSide;
  stake: number;
  payout: number;   // gross
  net: number;      // payout - stake
}

export interface BaccaratTableRoundResult {
  roundSeq: number;
  coupId: string;
  shoeId: string;
  coupIndex: number;
  winner: 'player' | 'banker' | 'tie';
  player: { cards: BaccaratCard[]; total: number; isNatural: boolean };
  banker: { cards: BaccaratCard[]; total: number; isNatural: boolean };
  dealtAfter: number;
  settledAt: number;                 // epoch ms
  seatResults: BaccaratTableSeatResult[];   // settled bets only; void bets excluded
}

export interface BaccaratTablePublicState {
  tableId: string;
  tierKey: BaccaratTableTier;
  minBet: number;
  maxBet: number;
  maxSeats: number;
  serverNow: number;                 // epoch ms at response build; client clock offset
  roundSeq: number;                  // the round a bet applies to now
  phase: BaccaratTablePhase;
  bettingClosesAt: number | null;    // phase 'betting' only
  nextBettingOpensAt: number | null; // phase 'reveal' only
  shoe: { id: string; serverSeedHash: string; clientSeed: string; nextCoupIndex: number; dealtCount: number } | null;
  previousShoe: { id: string; serverSeed: string; serverSeedHash: string; clientSeed: string } | null;
  seats: BaccaratTableSeatView[];    // status 'seated' only, seatIndex asc
  lastRound: BaccaratTableRoundResult | null;
  me: {
    seated: boolean;
    seatIndex: number | null;
    currentBet: { roundSeq: number; bet: BaccaratTableBetSide; stake: number } | null;
    nextRoundBet: { roundSeq: number; bet: BaccaratTableBetSide; stake: number } | null;
    lastResult: BaccaratTableSeatResult | null;   // my row in lastRound, or null
    voidedLastRound: { roundSeq: number; reason: string } | null;
    balance: number;               // avatars.claw_tokens now
  } | null;                        // null when no subject
}
