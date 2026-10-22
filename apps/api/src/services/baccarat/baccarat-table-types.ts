/**
 * Shared-table (multiplayer) baccarat: server-side contract types (2026-10-22).
 *
 * Spec: `baccarat-shared-table-port-2026-10-22.md` (sections 3.2, 3.3, 3.6, 6.3).
 * Consumers: the table manager stack (`baccarat-table-manager.ts`, seeder, scaler,
 * tick), the route (`routes/cove-baccarat-tables.ts`), the verifier
 * (`routes/cove-history.ts`), and the `[ACTION: play_cove_game(game=baccarat)]`
 * executor seam (`npc-simulation.ts`).
 *
 * The PUBLIC wire shapes (lobby row, table state, seat view, round result) are
 * frozen in `@clawville/shared` (`types/cove-baccarat-table.ts`) and are only
 * re-exported here, so the server and the web can never hold two shapes.
 *
 * Money model: no vCLAW moves at bet time. At the round settle the stake is
 * debited and the gross payout credited in ONE transaction through
 * `claw-token-ledger.ts`, with `actorKind` from the bet row.
 */

export type {
  BaccaratTableTier,
  BaccaratTablePhase,
  BaccaratTableBetSide,
  BaccaratLobbyRow,
  BaccaratTableSeatView,
  BaccaratTableSeatResult,
  BaccaratTableRoundResult,
  BaccaratTablePublicState,
} from '@clawville/shared';

import type { BaccaratTableBetSide } from '@clawville/shared';

/**
 * `cove_game_events.nonce` for a shared-table seat = `coupIndex * STRIDE + seatIndex`.
 * The verifier decodes `coupIndex = floor(nonce / STRIDE)`, `seatIndex = nonce % STRIDE`
 * for a shoe with `table_id IS NOT NULL` (spec section 3.6). Seats are 0..7, so 100
 * leaves room and keeps the nonce readable. Mirror of the poker stride note in
 * `routes/cove-history.ts`. Changing it breaks `/verify` for every stored event.
 */
export const BACCARAT_TABLE_SEAT_NONCE_STRIDE = 100;

/** Per-seat stake bounds across all house tiers (each table narrows them). */
export const BACCARAT_TABLE_MIN_BET = 5;
export const BACCARAT_TABLE_MAX_BET = 500;

/**
 * A resolved, ledger-capable subject for a write (spec section 3.2). The ROUTE
 * resolves identity (Lucia user wins over an agent header; guest accounts get
 * 403 from `requireNonGuestUser`; agents need `ledgerCapable` + a bound avatar).
 * There is NO guest kind: shared tables are real-vCLAW only.
 */
export type BaccaratTableSubject =
  | { kind: 'user'; userId: string; avatarId: string; agentId: null }
  | { kind: 'agent'; userId: string; avatarId: string; agentId: string };

/** `actor_kind` on the bet row and `actorKind` on the ledger calls. */
export type BaccaratTableActorKind = 'human' | 'agent';

export function baccaratTableActorKind(subject: BaccaratTableSubject): BaccaratTableActorKind {
  return subject.kind === 'user' ? 'human' : 'agent';
}

/** `baccarat_table_bets.origin`. 'autonomous' = a hosted-agent `[ACTION:]` bet. */
export type BaccaratTableBetOrigin = 'rest' | 'autonomous';

/** `baccarat_table_bets.status`. A row leaves 'pending' exactly once. */
export type BaccaratTableBetStatus = 'pending' | 'settled' | 'void' | 'cancelled';

/** `baccarat_table_seats.status`. */
export type BaccaratTableSeatStatus = 'seated' | 'left';

/** `baccarat_tables.source`. v1 serves 'house' only; the manager refuses the others. */
export type BaccaratTableSource = 'house' | 'player-public' | 'private';

/**
 * `baccarat_table_bets.void_reason`. A void bet moves no vCLAW, writes no event,
 * and is outside the round conservation set.
 */
export type BaccaratTableVoidReason =
  | 'insufficient_at_settle'
  | 'no_owner'
  | 'daily_cap'
  | 'settle_failed'
  | 'orphaned';

/** A pending bet as the settle tx reads it (spec section 5.3 step 3). */
export interface PendingSeatBet {
  betId: string;
  seatIndex: number;
  avatarId: string;
  actorKind: BaccaratTableActorKind;
  agentId: string | null;
  origin: BaccaratTableBetOrigin;
  bet: BaccaratTableBetSide;
  /** Stringified bigint vCLAW. */
  stake: string;
}

/** A settled seat result for one coup (stringified bigints; the wire uses numbers). */
export interface SettledSeatResult {
  seatIndex: number;
  avatarId: string;
  bet: BaccaratTableBetSide;
  stake: string;
  /** Gross returned to the seat. */
  payout: string;
  /** payout - stake (signed). */
  net: string;
  /** Banker commission withheld (0 unless a banker win on a banker bet). */
  commission: string;
}

/**
 * Wire error codes (spec section 3.3) and their HTTP status. The route maps a
 * thrown `BaccaratTableError` to `HTTPException(httpStatus, { message: code })`.
 * Route-only codes (`invalid_table_id`, `invalid_bet_body`, `invalid_sit_body`,
 * `idempotency_key_must_be_1_to_64_chars`, `auth_required`, the agent-session
 * codes, `guest_not_allowed`, `fixture_not_supported_on_shared_tables`, the rate
 * limit) are listed so one table holds every status.
 */
export const BACCARAT_TABLE_ERROR_STATUS = {
  invalid_table_id: 400,
  invalid_bet_body: 400,
  invalid_sit_body: 400,
  stake_out_of_bounds: 400,
  idempotency_key_must_be_1_to_64_chars: 400,
  auth_required: 401,
  invalid_or_expired_agent_session: 401,
  insufficient_clawtokens: 402,
  guest_not_allowed: 403,
  active_avatar_required: 403,
  agent_session_not_ledger_authorized: 403,
  agent_session_has_no_active_avatar: 403,
  seeded_seat_cannot_bet: 403,
  table_not_found: 404,
  table_closed: 409,
  table_full: 409,
  seat_taken: 409,
  not_seated: 409,
  already_seated_elsewhere: 409,
  betting_closed: 409,
  stale_round: 409,
  bet_conflict: 409,
  fixture_not_supported_on_shared_tables: 409,
  cove_baccarat_table_rate_limit: 429,
} as const;

export type BaccaratTableErrorCode = keyof typeof BACCARAT_TABLE_ERROR_STATUS;

function defaultStatus(code: string): number {
  return Object.prototype.hasOwnProperty.call(BACCARAT_TABLE_ERROR_STATUS, code)
    ? BACCARAT_TABLE_ERROR_STATUS[code as BaccaratTableErrorCode]
    : 500;
}

/**
 * Structured manager error. `code` is the wire code for a public failure (see
 * `BACCARAT_TABLE_ERROR_STATUS`) or an internal invariant code (for example
 * `shoe_counter_drift`, `coup_conflict`, `conservation_violation`), which maps
 * to 500 unless `httpStatus` is given. `details` carries the extra wire fields
 * of section 3.3: `tableId` (already_seated_elsewhere), `nextBettingOpensAt`
 * (betting_closed), `roundSeq` (stale_round).
 */
export class BaccaratTableError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string = code,
    httpStatus: number = defaultStatus(code),
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BaccaratTableError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/**
 * Frozen input of `placeAutonomousBet` (spec section 6.3). The executor in
 * `npc-simulation.ts` passes the LIVE re-resolved binding; the manager re-checks it.
 */
export interface PlaceAutonomousBetInput {
  agentSessionId: string;
  expectedAgentId: string;
  expectedAvatarId: string;
  expectedUserId: string;
  bet: BaccaratTableBetSide;
  wager: number;
}

/** Frozen result of `placeAutonomousBet` (spec section 6.3). */
export interface PlaceAutonomousBetResult {
  tableId: string;
  roundSeq: number;
  seatIndex: number;
  seated: boolean;
}
