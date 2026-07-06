/**
 * Poker MTT (P4) — MULTI-TABLE TournamentManager.
 *
 * Sits ABOVE `PokerTableSim` (the per-hand betting driver). The sim plays ONE
 * hand at a time keyed by a sim `tableId`. Everything between hands — applying
 * chip deltas, detecting busts, assigning TOURNAMENT-WIDE placement, rotating
 * the button, advancing the (single tournament-wide) blind level, rebalancing
 * players across tables, breaking short tables, consolidating the final table,
 * and starting the next hand until one entrant remains — is NET-NEW and lives
 * here.
 *
 * ── SINGLE-TABLE vs MULTI-TABLE ──────────────────────────────────────────────
 * A tournament with `ceil(entrants/seatsPerTable) === 1` is the P3 single-table
 * sit-n-go and behaves EXACTLY as before (one room, one sim table `mtt:<id>`,
 * one multi-hand loop). With ≥2 tables the TM seats a balanced field across N
 * tables (sim ids `mtt:<id>:t<n>`, one room each), runs each table's own
 * multi-hand loop on ONE tournament-wide blind clock, and BETWEEN hands keeps
 * the tables balanced (rebalance), breaks tables that fall below the merge
 * threshold (distributing their survivors), and consolidates to ONE final table
 * once survivors ≤ seatsPerTable.
 *
 * ── RESPONSIBILITIES ─────────────────────────────────────────────────────────
 *   - registerEntrant: agent-capable subject (user|agent, NEVER bot) buys in;
 *     CT debited into the prize-pool accounting; entrant row inserted; idempotent.
 *   - startTrigger: seat the field across N balanced tables (→ running) or, if
 *     entrants < minEntrants, CANCEL + refund every buy-in (idempotent).
 *   - the per-table multi-hand loop (handCompleteFn): apply HandResult chip
 *     deltas, detect busts → assign TOURNAMENT-WIDE placement, persist the hand
 *     checkpoint, rotate the button, advance the blind level if its timer
 *     elapsed, then rebalance / break / consolidate BETWEEN hands, then start the
 *     next hand per table — until ONE entrant remains tournament-wide.
 *   - settle: compute prizeCt per placement from payoutCurveJson against
 *     (prizePoolCt − rake), write poker_tournament_results, credit via the
 *     ledger — ALL idempotent under a poker_tournaments FOR UPDATE row lock.
 *   - crash recovery: DB-checkpoint chipStack + poker_tables + poker_hands every
 *     settled hand; a boot driver resumes from the last checkpoint OR cancels +
 *     refunds the persisted escrow (idempotent). Sweeper hardening exempts mtt
 *     rooms from the LIVE_NO_WS_TTL crash sweep + notifies the TM on abort.
 *
 * ── MONEY (LOCKED) ───────────────────────────────────────────────────────────
 * Tournament CHIPS are NOT CT. Only the buy-in DEBIT (register) and the prize
 * CREDIT (settle) cross `claw-token-ledger`. Refund on cancel CREDITs back.
 * Conservation: sum(prizes) + rakeTaken == prizePoolCt; cancel refunds net 0.
 * Chip conservation: across ALL tables at ALL times, Σ chipStack == startingStack
 * * entrants (rebalancing/breaking moves chips, never creates/destroys them).
 *
 * ── DETERMINISM / TESTABILITY ────────────────────────────────────────────────
 * The sim clock + per-hand seeds + the seating RNG are injectable. Tests
 * construct a `TournamentManager` with a fake clock + a deterministic `seedFn` +
 * a deterministic `shuffleFn`, mock the DB + ledger, and drive a full
 * multi-table MTT end-to-end with scripted actions.
 */

import {
  db as realDb,
} from '@clawville/database';
import {
  type BlindLevel,
  type PayoutCurveEntry,
} from '@clawville/database';
import * as ledgerModule from '../claw-token-ledger';
import { logEvent, ACTIVITY_EVENT_TYPES } from '../event-logger';
import type { ActivityMatchPlacedPayload } from '../event-logger';
import { alertError } from '../alert-error';
import type {
  creditClawTokens as CreditFn,
  debitClawTokens as DebitFn,
  transferClawTokens as TransferFn,
} from '../claw-token-ledger';
import { createServerSeed } from '../provable-rng';
import { PokerTableSim } from './poker-table-sim';
import { pokerMttSim } from './poker-mtt-sim-singleton';
import type {
  Action,
  AgentActionAdvice,
  AgentSeatView,
  ApplyActionResult,
  HandResult,
  SeatAssignment,
  SimClock,
} from './poker-table-types';
import { REAL_CLOCK } from './poker-table-types';
import { sql } from 'drizzle-orm';

// ── Injectable seams (tests override db / ledger / sim clock) ────────────────

type DbLike = typeof realDb;
type LedgerLike = {
  debitClawTokens: typeof DebitFn;
  creditClawTokens: typeof CreditFn;
  transferClawTokens: typeof TransferFn;
};

/**
 * ANTI-FARM provenance captured from the request at registration (Phase 1 parity).
 * The cove-poker-mtt router runs `fingerprintMiddleware`, so a human request and an
 * agent's forwarded `X-CV-Fingerprint` both resolve a real (fpHash, ipPrefixHash)
 * here. Persisted on the entrant row and threaded into the placement leaderboard
 * event the TM emits at settle (settlement is request-decoupled, so the fp must be
 * captured earlier and carried). Both null for a legacy/system register with no
 * request context. Optional so non-HTTP callers (tests, boot) need not supply it.
 */
export interface RegisterProvenance {
  fpHash?: string | null;
  ipPrefixHash?: string | null;
}

/** A connected/hosted-agent-capable registration subject (Rule E5 parity). */
export type RegisterSubject = (
  | { kind: 'user'; userId: string; avatarId: string; agentId: null }
  | { kind: 'agent'; userId: string; avatarId: string; agentId: string }
) &
  RegisterProvenance;

export interface TournamentManagerDeps {
  db?: DbLike;
  ledger?: LedgerLike;
  /**
   * The table sim that plays each hand. Defaults to the DEDICATED MTT sim
   * instance (`pokerMttSim`), NOT the WS-demo `pokerTableSim` singleton.
   */
  sim?: PokerTableSim;
  /** Clock for the TM's blind-level timer + settle timestamps. */
  clock?: SimClock;
  /** Per-hand commit-reveal server seed factory (64-hex). Injected for determinism. */
  seedFn?: () => string;
  /**
   * Seating-shuffle RNG. Returns a permutation index in [0, n). Defaults to
   * `Math.random`-backed. Injected by tests for a deterministic balanced seating.
   */
  shuffleFn?: (n: number) => number;
  /**
   * Leaderboard placement-emit seam. Defaults to a real `logEvent`
   * `activity.match.placed` per placed entrant.
   */
  emitPlacementFn?: (emit: PlacementEmit) => void | Promise<void>;
  /**
   * WS-ROOM seam (optional). Called ONCE PER TABLE at seating, BEFORE the first
   * hand starts, with that table's seat plan. The production bridge
   * (`poker-mtt-ws-bridge.ts`) creates ONE LONG-LIVED `texas-holdem-mtt` activity
   * room per table and returns its `{ roomId, shortCode }`. A throw MUST NOT
   * strand the seated field — the TM logs + proceeds without that table's room.
   */
  onSeatFn?: (info: {
    tournamentId: string;
    tableId: string;
    tableNumber: number;
    seats: MttSeatPlan[];
  }) => Promise<MttRoomBinding | null> | MttRoomBinding | null;
  /**
   * WS-ROOM teardown seam (optional). Called when a tournament table's room
   * should transition → `results` — at tournament completion (every table) AND
   * when a table BREAKS (its players were moved away). Best-effort.
   */
  onTournamentEndFn?: (info: {
    tournamentId: string;
    tableId: string;
    roomId: string;
  }) => Promise<void> | void;
  /**
   * Rebalance-move seam (optional). Called when a player is moved from one table
   * to another between hands. The production bridge sends `poker.moved` to the
   * moved player (with the NEW room/seat) and `poker.table_rebalanced` to the old
   * + new tables. Best-effort: a throw is logged and never blocks the move.
   */
  onMoveFn?: (info: MttMoveInfo) => Promise<void> | void;
}

/** One leaderboard placement emission (one per placed entrant at settle). */
export interface PlacementEmit {
  tournamentId: string;
  avatarId: string;
  agentId: string | null;
  placement: number;
  prizeCt: string;
  subjectType: 'human' | 'agent';
  /**
   * ANTI-FARM provenance carried from the entrant's REGISTRATION (the only point
   * a request context exists — settle is request-decoupled). Threaded into the
   * `activity.match.placed` event so poker placements carry the SAME (fp_hash,
   * ip_prefix_hash) anti-farm shape every other event-emitting route gets. Null
   * only when the entrant registered without a request (legacy/system).
   */
  fpHash: string | null;
  ipPrefixHash: string | null;
}

/**
 * One seat in a live tournament table, as handed to the WS-room seam at seating.
 */
export interface MttSeatPlan {
  seatIndex: number;
  avatarId: string;
  agentId: string | null;
  subjectType: 'human' | 'agent';
}

/** Details of a between-hands rebalance move (one player from→to a table). */
export interface MttMoveInfo {
  tournamentId: string;
  avatarId: string;
  agentId: string | null;
  /** The sim tableId the player LEFT (`mtt:<id>:t<n>`). */
  fromTableId: string;
  /** The WS roomId the player LEFT (or null when no room seam ran). */
  fromRoomId: string | null;
  /** The sim tableId the player MOVED TO. */
  toTableId: string;
  /** The WS roomId the player MOVED TO (or null). */
  toRoomId: string | null;
  toShortCode: string | null;
  /** Seat index at the destination table. */
  toSeatIndex: number;
  /** Chip stack carried across (conserved). */
  chipStack: number;
  /** Why the move happened — a between-hands rebalance or a table break. */
  reason: 'rebalance' | 'table_break' | 'final_table';
}

/**
 * The WS-room binding returned by `onSeatFn` (the production bridge). `null` = no
 * WS room was created (the unit-test path).
 */
export interface MttRoomBinding {
  roomId: string;
  shortCode: string;
  activityId: string;
}

/** Per-seat connection ticket a registered+seated subject opens its WS with. */
export interface MttConnectionInfo {
  roomId: string;
  shortCode: string;
  seatIndex: number;
  activityId: string;
}

const DEFAULT_TURN_CLOCK_MS = 25_000;
const DEFAULT_AGENT_TURN_GRACE_MS = 5_000;
// provable-rng requires a hex clientSeed ([0-9a-fA-F]+). 'clawville-mtt' base16.
const DEFAULT_CLIENT_SEED = 'c1a4111e';
/**
 * How often the start-trigger sweeper scans for tournaments whose registration
 * window has closed.
 */
const START_TRIGGER_SWEEP_INTERVAL_MS = 15_000;
/** The `activityId` tag on `activity.match.placed` events the TM emits at settle. */
const POKER_MTT_ACTIVITY_ID = 'poker-mtt';
/**
 * FIXED uuid for the seeded DEFAULT blind schedule row. A constant id makes the
 * seed `INSERT ... ON CONFLICT (id) DO NOTHING` idempotent across boots/creates —
 * repeated `ensureDefaultBlindSchedule()` calls collapse to one row, never N.
 */
export const DEFAULT_BLIND_SCHEDULE_ID = '00000000-0000-4000-8000-000000000001';
/** Human-readable label for the seeded default ladder. */
export const DEFAULT_BLIND_SCHEDULE_NAME = 'default-8';
/** Sane upper bound on entrants for a created tournament (anti-fat-finger). */
const MAX_ENTRANTS_CAP = 200;

export interface RegisterResult {
  entrantId: string;
  prizePoolCt: string;
  alreadyRegistered: boolean;
  /** True when THIS registration filled the last seat (entrants == maxEntrants). */
  capReached: boolean;
}

export interface StartResult {
  status: 'running' | 'cancelled' | 'noop';
  seatedCount: number;
  refundedCount: number;
  /** Number of physical tables seated (1 for a single-table SNG). */
  tableCount: number;
}

export interface SettleResult {
  alreadySettled: boolean;
  rakeTakenCt: string;
  results: Array<{
    avatarId: string;
    agentId: string | null;
    placement: number;
    prizeCt: string;
    /** Registration-time anti-farm provenance, carried to the leaderboard emit. */
    fpHash: string | null;
    ipPrefixHash: string | null;
  }>;
}

/**
 * Config for a NEW tournament (the creation gap this fills). All bounds are
 * VALIDATED in `createTournament` before any DB write — a CT-buy-in money config
 * with a bad payout curve / stack / seat count would mis-settle, so the validation
 * is strict and crash-loud (a TournamentError 400, never a silent clamp).
 */
export interface CreateTournamentConfig {
  /** Display name. */
  name: string;
  /** Buy-in per entrant (atomic CT). MUST be > 0 (no free tournaments — a 0 pool can't pay). */
  buyInCt: number | bigint | string;
  /** House rake in basis points (0..10000). Default 0. */
  rakeBps?: number;
  /** Minimum entrants to start (≥ 2). Below floor at the trigger → cancel + refund. */
  minEntrants: number;
  /** Hard cap on entrants. MUST be ≥ minEntrants. */
  maxEntrants: number;
  /** Seats per table (2..9). Default 9. */
  seatsPerTable?: number;
  /** Starting chip stack (play chips, NOT CT). MUST be > 0. */
  startingStack: number;
  /** Payout curve (PayoutCurveEntry[]). Defaults to DEFAULT_PAYOUT_CURVE when omitted. */
  payoutCurve?: PayoutCurveEntry[];
  /** Registration auto-closes (+ start trigger fires) at this time. Null/omitted = manual. */
  registrationClosesAt?: Date | null;
  /**
   * The blind schedule this tournament uses. Omitted ⇒ the idempotently-seeded
   * DEFAULT schedule. When provided, the row MUST already exist (FK + existence check).
   */
  blindScheduleId?: string;
  /**
   * PREPAID-ENTRANT mode (the special-event seam, 2026-06-16). When set, this
   * tournament's entrants are PRE-PAID at a HIGHER layer (the special-event gate
   * already settled SOL/CT/free entry), so:
   *   - `buyInCt` MAY be 0 (the per-entrant debit is skipped — `registerEntrant`
   *     already no-ops the debit when buyInCt is 0), bypassing the normal "no free
   *     tournament" guard. This is the ONLY way `buyInCt === 0` is accepted.
   *   - `seedPrizePoolCt` (atomic CT) funds the prize pool DIRECTLY at creation
   *     instead of accumulating from buy-ins, so settle still pays out + conserves
   *     (sum(prizes) + rakeTaken == prizePoolCt). The event manager funds this from
   *     its `prize_config_json`. Omitted/0 ⇒ a 0 pool (a pure-glory event).
   * Default (omitted) ⇒ the normal CT-buy-in tournament (buyInCt MUST be > 0).
   */
  prepaid?: {
    /** Seed the prize pool directly (atomic CT) instead of from buy-ins. */
    seedPrizePoolCt?: number | bigint | string;
  };
  /**
   * DEPENDENCY LINK (the special-event seam, 2026-06-16). When set, the created
   * tournament's `special_event_id` column is populated atomically at insert so
   * the tournament is a DEPENDENT of that special_events parent (the FK points
   * UP — special_events never references the tournament). `settleEvent` finds
   * the tournament via `WHERE special_event_id = <this>`. Omitted ⇒ a standalone
   * tournament (null special_event_id). MUST reference an existing special_events
   * row (DB FK enforces it; a bad id surfaces as a 23503 at insert).
   */
  specialEventId?: string | null;
}

export interface CreateTournamentResult {
  id: string;
  name: string;
  status: string;
  buyInCt: string;
  rakeBps: number;
  minEntrants: number;
  maxEntrants: number;
  seatsPerTable: number;
  startingStack: number;
  prizePoolCt: string;
  payoutCurve: PayoutCurveEntry[];
  blindScheduleId: string;
  registrationClosesAt: Date | string | null;
  /** The creator's avatar id (audit), or null. */
  createdBy: string | null;
  /** The special_events parent this tournament depends on, or null (standalone). */
  specialEventId: string | null;
  createdAt: Date | string | null;
}

/** One row in the discovery list (open/registering, + running when requested). */
export interface TournamentListItem {
  id: string;
  name: string;
  status: string;
  buyInCt: string;
  rakeBps: number;
  minEntrants: number;
  maxEntrants: number;
  seatsPerTable: number;
  startingStack: number;
  prizePoolCt: string;
  registrationClosesAt: Date | string | null;
  /** Non-refunded entrant count (registered/seated/busted). */
  registeredCount: number;
  /** Live (non-broken) table count — only meaningful for a running tournament; else 0. */
  tableCount: number;
  /** Compact blind summary: level count + the opening level's sb/bb. */
  blindSummary: { levels: number; openingSb: number | null; openingBb: number | null };
}

export interface ListTournamentsFilter {
  /** Include 'running' tournaments in addition to open/registering. Default false. */
  includeRunning?: boolean;
  /** Max rows (1..200). Default 50. */
  limit?: number;
}

/** A live in-memory per-TABLE driver: tracks live seats + per-table button/hand. */
interface RunningTable {
  /** Sim tableId: `mtt:<tournamentId>` (single) or `mtt:<tournamentId>:t<n>`. */
  tableId: string;
  /** poker_tables.id (DB) for this physical table. */
  serverDbTableId: string;
  /** 1-based table number within the tournament. */
  tableNumber: number;
  /** The long-lived `texas-holdem-mtt` WS room bound to this table, or null. */
  roomBinding: MttRoomBinding | null;
  /** Button seat index for the NEXT hand at THIS table. */
  buttonSeatIndex: number;
  /** Monotonic hand number at THIS table (RNG nonce; the sim's handNumber). */
  handNumber: number;
  /** seatIndex → live seat (chips + identity). Busted/moved seats removed. */
  liveSeats: Map<number, LiveSeat>;
  /** chip count at the START of the in-flight hand, by seatIndex (tie-break key). */
  chipAtHandStart: Map<number, number>;
  /** True while a hand is in flight (sim has a live table for this id). */
  handInFlight: boolean;
  /** True once this table is broken (consolidated away) — no more hands here. */
  broken: boolean;
}

interface LiveSeat {
  seatIndex: number;
  avatarId: string;
  agentId: string | null;
  name: string;
  subjectType: 'human' | 'agent';
  chipStack: number;
}

/** A live in-memory per-TOURNAMENT driver: owns the blind clock + all tables. */
interface RunningTournament {
  tournamentId: string;
  blindLevels: BlindLevel[];
  /** index into blindLevels for the level applied to the NEXT hand (tournament-wide). */
  currentLevelIndex: number;
  /** wall-clock ms when the current level started (advance when durationSec elapses). */
  levelStartedMs: number;
  turnClockMs: number;
  agentTurnGraceMs: number;
  clientSeed: string;
  seatsPerTable: number;
  startingStack: number;
  /** entrant count at seating (for chip-conservation invariants). */
  entrantCount: number;
  /** tableNumber → live table driver. Broken tables stay (broken=true) until done. */
  tables: Map<number, RunningTable>;
  done: boolean;
  /**
   * SERIALIZATION: hand-completions are processed ONE AT A TIME per tournament so
   * the per-table loops, the between-hands rebalance/break/consolidation, and the
   * next-hand starts never interleave (a multi-table double-start race). The sim
   * may fire `handCompleteFn` for two tables in quick succession; each enqueues
   * here and a single drainer processes them sequentially. `processing` is the
   * in-flight guard; `queue` holds pending (tableId, result) jobs.
   */
  processing: boolean;
  queue: Array<{ tableId: string; result: HandResult }>;
}

export class TournamentManager {
  private readonly db: DbLike;
  private readonly ledger: LedgerLike;
  private readonly sim: PokerTableSim;
  private readonly clock: SimClock;
  private readonly seedFn: () => string;
  private readonly shuffleFn: (n: number) => number;
  private readonly emitPlacementFn: (emit: PlacementEmit) => void | Promise<void>;
  // Mutable so the production singleton can have its WS-room seam wired LATER by
  // the bridge via `setSeatHandlers`. Tests inject them at construction via deps.
  private onSeatFn: TournamentManagerDeps['onSeatFn'] | null;
  private onTournamentEndFn: TournamentManagerDeps['onTournamentEndFn'] | null;
  private onMoveFn: TournamentManagerDeps['onMoveFn'] | null;

  /** tournamentId → running tournament driver. */
  private readonly running = new Map<string, RunningTournament>();
  /** sim tableId → tournamentId (so a hand-complete dispatch is O(1)). */
  private readonly tableToTournament = new Map<string, string>();
  /** WS room id → sim tableId (hub addresses by roomId; sim keyed by tableId). */
  private readonly roomToTable = new Map<string, string>();
  /** sim tableId → WS room id (reverse of `roomToTable`). */
  private readonly tableToRoom = new Map<string, string>();
  /**
   * CONTROLLED-MODE control owners. Key = `<avatarId>` of a connected/hosted
   * agent whose in-world avatar is currently being DRIVEN BY A HUMAN (controlled
   * mode — the human's WS/REST input is authoritative). While an avatar is in this
   * set, the AUTONOMOUS REST action path (`applyAgentAction` with `actor:'agent'`)
   * is SUPPRESSED: the agent may still READ state + ASK for advice (advisor mode),
   * but it cannot stake a betting decision — the human owns the seat. A human
   * (`actor:'human'`) or an advisor read is never suppressed. Set/cleared by the
   * controlled-launch suppression seam (mirrors `humanControlled*` in
   * npc-simulation). Empty by default ⇒ pure autonomous agent play.
   */
  private readonly controlledAvatars = new Set<string>();
  /** The start-trigger sweeper interval handle (null when not running). */
  private sweeperHandle: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard so overlapping sweeps don't double-fire a startTrigger. */
  private sweepInFlight = false;

  constructor(deps: TournamentManagerDeps = {}) {
    this.db = deps.db ?? realDb;
    this.ledger = deps.ledger ?? {
      debitClawTokens: (...args) => ledgerModule.debitClawTokens(...args),
      creditClawTokens: (...args) => ledgerModule.creditClawTokens(...args),
      transferClawTokens: (...args) => ledgerModule.transferClawTokens(...args),
    };
    this.sim = deps.sim ?? pokerMttSim;
    this.clock = deps.clock ?? REAL_CLOCK;
    this.seedFn = deps.seedFn ?? (() => createServerSeed().serverSeed);
    // Default seating RNG: a uniform index in [0,n). Injected for determinism.
    this.shuffleFn = deps.shuffleFn ?? ((n: number) => Math.floor(Math.random() * n));
    this.emitPlacementFn =
      deps.emitPlacementFn ??
      ((emit: PlacementEmit) => {
        void logEvent({
          eventType: ACTIVITY_EVENT_TYPES.MATCH_PLACED,
          avatarId: emit.avatarId,
          agentId: emit.agentId,
          // Carry the registration-time anti-farm provenance so a poker placement
          // event lands with a real (fp_hash, ip_prefix_hash), matching every other
          // event-emitting route (the settle path has no request context of its own).
          fpHash: emit.fpHash,
          ipPrefixHash: emit.ipPrefixHash,
          payload: {
            activityId: POKER_MTT_ACTIVITY_ID,
            roomId: `mtt:${emit.tournamentId}`,
            placement: emit.placement,
            score: 0,
            tokensAwarded: Number(emit.prizeCt),
            leaderboardPoints: 0,
            subjectType: emit.subjectType,
          } satisfies ActivityMatchPlacedPayload,
        });
      });
    this.onSeatFn = deps.onSeatFn ?? null;
    this.onTournamentEndFn = deps.onTournamentEndFn ?? null;
    this.onMoveFn = deps.onMoveFn ?? null;

    // The TM EXCLUSIVELY owns the hand-complete handler on ITS sim instance. The
    // sim fires it with the sim tableId; we route to the owning tournament+table.
    this.sim.setHandCompleteFn((tableId, result) => {
      void this.onHandComplete(tableId, result);
    });
  }

  // ── Creation + discovery ─────────────────────────────────────────────────────

  /**
   * Idempotently seed the DEFAULT rising-blind ladder (DEFAULT_BLIND_SCHEDULE) at a
   * FIXED uuid. `ON CONFLICT (id) DO NOTHING` makes repeated boots/creates collapse
   * to ONE row — never duplicates. Returns the default schedule id (always the
   * constant). Safe to call at every API boot and inside `createTournament`.
   */
  async ensureDefaultBlindSchedule(): Promise<string> {
    await this.db.execute(
      sql`INSERT INTO poker_blind_schedules (id, name, levels_json)
          VALUES (${DEFAULT_BLIND_SCHEDULE_ID}, ${DEFAULT_BLIND_SCHEDULE_NAME},
                  ${JSON.stringify(DEFAULT_BLIND_SCHEDULE)}::jsonb)
          ON CONFLICT (id) DO NOTHING`,
    );
    return DEFAULT_BLIND_SCHEDULE_ID;
  }

  /**
   * Create a NEW tournament (status 'registering', prizePoolCt 0). VALIDATES the
   * money config strictly (a bad curve/stack/seat-count mis-settles a CT pool), then
   * ensures the referenced blind schedule row exists (seeding the idempotent default
   * when `blindScheduleId` is omitted), then inserts the row. Returns the created row.
   *
   * @param config validated config (see CreateTournamentConfig).
   * @param createdByAvatarId the admin/creator's avatar id, or null. PERSISTED into
   *   the `created_by` audit column (FK to avatars, `set null` on delete) so there is
   *   a durable record of who stood up a money-config tournament. Null when the
   *   creator has no avatar (dash-cookie admin path) or for a system/boot create.
   */
  async createTournament(
    config: CreateTournamentConfig,
    createdByAvatarId: string | null,
  ): Promise<CreateTournamentResult> {
    // ── Validate (crash-loud — never a silent clamp on a money config) ──────────
    const name = (config.name ?? '').trim();
    if (!name) throw new TournamentError('invalid_name', 400);

    const prepaid = config.prepaid;
    const buyIn = toBigIntStrict(config.buyInCt, 'buyInCt');
    // PREPAID mode is the ONLY way a 0 buy-in is accepted: a higher layer (the
    // special-event gate) already collected entry, so the per-entrant CT debit is
    // skipped and the pool is seeded directly. A normal tournament still demands a
    // positive buy-in (a 0 pool that accumulates from buy-ins can't pay anyone).
    if (!prepaid && buyIn <= 0n) {
      throw new TournamentError('invalid_buy_in_must_be_positive', 400);
    }
    if (buyIn < 0n) throw new TournamentError('invalid_buy_in_must_be_positive', 400);
    const seedPool = prepaid?.seedPrizePoolCt != null
      ? toBigIntStrict(prepaid.seedPrizePoolCt, 'seedPrizePoolCt')
      : 0n;

    const rakeBps = config.rakeBps ?? 0;
    if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > 10000) {
      throw new TournamentError('invalid_rake_bps', 400);
    }

    const minEntrants = config.minEntrants;
    const maxEntrants = config.maxEntrants;
    if (!Number.isInteger(minEntrants) || minEntrants < 2) {
      throw new TournamentError('invalid_min_entrants', 400);
    }
    if (!Number.isInteger(maxEntrants) || maxEntrants < minEntrants) {
      throw new TournamentError('invalid_max_entrants', 400);
    }
    if (maxEntrants > MAX_ENTRANTS_CAP) {
      throw new TournamentError('max_entrants_exceeds_cap', 400);
    }

    const seatsPerTable = config.seatsPerTable ?? 9;
    if (!Number.isInteger(seatsPerTable) || seatsPerTable < 2 || seatsPerTable > 9) {
      throw new TournamentError('invalid_seats_per_table', 400);
    }

    const startingStack = config.startingStack;
    if (!Number.isInteger(startingStack) || startingStack <= 0) {
      throw new TournamentError('invalid_starting_stack', 400);
    }

    const payoutCurve = config.payoutCurve ?? DEFAULT_PAYOUT_CURVE;
    validatePayoutCurve(payoutCurve);

    const registrationClosesAt = config.registrationClosesAt ?? null;
    if (registrationClosesAt != null && Number.isNaN(new Date(registrationClosesAt).getTime())) {
      throw new TournamentError('invalid_registration_closes_at', 400);
    }

    const specialEventId = config.specialEventId ?? null;

    // ── Resolve the blind schedule (seed default OR verify the referenced row) ──
    let blindScheduleId = config.blindScheduleId;
    if (!blindScheduleId) {
      blindScheduleId = await this.ensureDefaultBlindSchedule();
    } else {
      const exists = await this.db.execute<{ id: string }>(
        sql`SELECT id FROM poker_blind_schedules WHERE id = ${blindScheduleId}`,
      );
      if (!exists[0]) throw new TournamentError('blind_schedule_not_found', 404);
    }

    // ── Insert (status 'registering', prizePoolCt 0) ────────────────────────────
    const inserted = await this.db.execute<{
      id: string;
      name: string;
      status: string;
      buy_in_ct: string;
      rake_bps: number;
      min_entrants: number;
      max_entrants: number;
      seats_per_table: number;
      starting_stack: number;
      prize_pool_ct: string;
      payout_curve_json: unknown;
      blind_schedule_id: string;
      registration_closes_at: Date | string | null;
      created_by: string | null;
      special_event_id: string | null;
      created_at: Date | string | null;
    }>(
      sql`INSERT INTO poker_tournaments
            (name, status, buy_in_ct, rake_bps, min_entrants, max_entrants,
             seats_per_table, starting_stack, prize_pool_ct, payout_curve_json,
             blind_schedule_id, registration_closes_at, created_by, special_event_id)
          VALUES (${name}, 'registering', ${buyIn.toString()}, ${rakeBps}, ${minEntrants},
                  ${maxEntrants}, ${seatsPerTable}, ${startingStack}, ${seedPool.toString()},
                  ${JSON.stringify(payoutCurve)}::jsonb, ${blindScheduleId},
                  ${registrationClosesAt}, ${createdByAvatarId}, ${specialEventId})
          RETURNING id, name, status, buy_in_ct, rake_bps, min_entrants, max_entrants,
                    seats_per_table, starting_stack, prize_pool_ct, payout_curve_json,
                    blind_schedule_id, registration_closes_at, created_by, special_event_id, created_at`,
    );
    const row = inserted[0];
    if (!row) throw new TournamentError('create_failed', 500);

    if (createdByAvatarId) {
      console.log(
        `[poker-mtt] tournament ${row.id} (${name}) created by avatar ${createdByAvatarId}`,
      );
    }

    return {
      id: row.id,
      name: row.name,
      status: row.status,
      buyInCt: row.buy_in_ct,
      rakeBps: row.rake_bps,
      minEntrants: row.min_entrants,
      maxEntrants: row.max_entrants,
      seatsPerTable: row.seats_per_table,
      startingStack: row.starting_stack,
      prizePoolCt: row.prize_pool_ct,
      payoutCurve: (row.payout_curve_json as PayoutCurveEntry[] | null) ?? payoutCurve,
      blindScheduleId: row.blind_schedule_id,
      registrationClosesAt: row.registration_closes_at,
      createdBy: row.created_by,
      specialEventId: row.special_event_id,
      createdAt: row.created_at,
    };
  }

  /**
   * List discoverable tournaments — 'registering' always, '+running' when requested —
   * with their config + the CURRENT non-refunded entrant count and (for running) the
   * live table count + a compact blind summary. Powers the cove lobby/list UI. Pure
   * read, no mutation. Newest-first, capped.
   */
  async listTournaments(filter: ListTournamentsFilter = {}): Promise<TournamentListItem[]> {
    const includeRunning = filter.includeRunning ?? false;
    const limit = Math.min(Math.max(Math.floor(filter.limit ?? 50), 1), 200);
    const statuses = includeRunning
      ? sql`('registering','running')`
      : sql`('registering')`;

    const rows = await this.db.execute<{
      id: string;
      name: string;
      status: string;
      buy_in_ct: string;
      rake_bps: number;
      min_entrants: number;
      max_entrants: number;
      seats_per_table: number;
      starting_stack: number;
      prize_pool_ct: string;
      registration_closes_at: Date | string | null;
      blind_schedule_id: string;
      registered_count: number;
      table_count: number;
      levels_json: unknown;
    }>(
      sql`SELECT t.id, t.name, t.status, t.buy_in_ct, t.rake_bps, t.min_entrants,
                 t.max_entrants, t.seats_per_table, t.starting_stack, t.prize_pool_ct,
                 t.registration_closes_at, t.blind_schedule_id,
                 (SELECT count(*)::int FROM poker_tournament_entrants e
                    WHERE e.tournament_id = t.id AND e.status <> 'refunded') AS registered_count,
                 (SELECT count(*)::int FROM poker_tables pt
                    WHERE pt.tournament_id = t.id AND pt.status = 'live') AS table_count,
                 (SELECT bs.levels_json FROM poker_blind_schedules bs
                    WHERE bs.id = t.blind_schedule_id) AS levels_json
          FROM poker_tournaments t
          WHERE t.status IN ${statuses}
          ORDER BY t.created_at DESC
          LIMIT ${limit}`,
    );

    return rows.map((r) => {
      const levels = (r.levels_json as BlindLevel[] | null) ?? [];
      const opening = levels[0];
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        buyInCt: r.buy_in_ct,
        rakeBps: r.rake_bps,
        minEntrants: r.min_entrants,
        maxEntrants: r.max_entrants,
        seatsPerTable: r.seats_per_table,
        startingStack: r.starting_stack,
        prizePoolCt: r.prize_pool_ct,
        registrationClosesAt: r.registration_closes_at,
        registeredCount: Number(r.registered_count ?? 0),
        tableCount: Number(r.table_count ?? 0),
        blindSummary: {
          levels: levels.length,
          openingSb: opening ? opening.sb : null,
          openingBb: opening ? opening.bb : null,
        },
      };
    });
  }

  // ── Registration ────────────────────────────────────────────────────────────

  /**
   * Register a subject into a tournament. Debits the buy-in into the prize-pool
   * accounting and inserts an entrant row, atomically, under the tournament FOR
   * UPDATE row lock. Idempotent on (tournamentId, avatarId).
   */
  async registerEntrant(
    subject: RegisterSubject,
    tournamentId: string,
  ): Promise<RegisterResult> {
    return this.db.transaction(async (tx) => {
      const lockRows = await tx.execute<{
        id: string;
        status: string;
        buy_in_ct: string;
        max_entrants: number;
        prize_pool_ct: string;
        registration_closes_at: Date | string | null;
      }>(
        sql`SELECT id, status, buy_in_ct, max_entrants, prize_pool_ct, registration_closes_at
            FROM poker_tournaments WHERE id = ${tournamentId} FOR UPDATE`,
      );
      const t = lockRows[0];
      if (!t) throw new TournamentError('tournament_not_found', 404);

      const existingRows = await tx.execute<{ id: string }>(
        sql`SELECT id FROM poker_tournament_entrants
            WHERE tournament_id = ${tournamentId} AND avatar_id = ${subject.avatarId}`,
      );
      if (existingRows[0]) {
        return {
          entrantId: existingRows[0].id,
          prizePoolCt: t.prize_pool_ct,
          alreadyRegistered: true,
          capReached: false,
        };
      }

      if (t.status !== 'registering') {
        throw new TournamentError('registration_closed', 409);
      }
      if (t.registration_closes_at) {
        const closesMs = new Date(t.registration_closes_at).getTime();
        if (this.clock.now() >= closesMs) {
          throw new TournamentError('registration_closed', 409);
        }
      }

      const countRows = await tx.execute<{ cnt: number }>(
        sql`SELECT count(*)::int AS cnt FROM poker_tournament_entrants
            WHERE tournament_id = ${tournamentId} AND status <> 'refunded'`,
      );
      const filled = Number(countRows[0]?.cnt ?? 0);
      if (filled >= t.max_entrants) {
        throw new TournamentError('tournament_full', 409);
      }

      const buyIn = BigInt(t.buy_in_ct);
      if (buyIn < 0n) throw new TournamentError('invalid_buy_in', 500);

      if (buyIn > 0n) {
        await this.ledger.debitClawTokens(
          {
            avatarId: subject.avatarId,
            amount: Number(buyIn),
            reason: 'poker_mtt_buyin',
            source: 'simulation',
            metadata: { tournamentId, agentId: subject.agentId },
          },
          tx,
        );
      }

      const newPool = (BigInt(t.prize_pool_ct) + buyIn).toString();
      await tx.execute(
        sql`UPDATE poker_tournaments SET prize_pool_ct = ${newPool} WHERE id = ${tournamentId}`,
      );

      const subjectType = subject.kind === 'agent' ? 'agent' : 'human';
      const insRows = await tx.execute<{ id: string }>(
        sql`INSERT INTO poker_tournament_entrants
              (tournament_id, avatar_id, agent_id, subject_type, buy_in_paid_ct, status,
               fp_hash, ip_prefix_hash)
            VALUES (${tournamentId}, ${subject.avatarId}, ${subject.agentId},
                    ${subjectType}, ${buyIn.toString()}, 'registered',
                    ${subject.fpHash ?? null}, ${subject.ipPrefixHash ?? null})
            RETURNING id`,
      );

      const capReached = filled + 1 >= t.max_entrants;

      return {
        entrantId: insRows[0]!.id,
        prizePoolCt: newPool,
        alreadyRegistered: false,
        capReached,
      };
    });
  }

  // ── Start trigger (seat or cancel+refund) ────────────────────────────────────

  /**
   * Evaluate a tournament's start condition. If entrants ≥ minEntrants → seat the
   * field across `ceil(N/seatsPerTable)` BALANCED tables, flip to 'running', and
   * drive the first hand at each table. If entrants < minEntrants (and the window
   * closed or `force`) → cancel + refund every buy-in. Idempotent.
   */
  async startTrigger(tournamentId: string, opts: { force?: boolean } = {}): Promise<StartResult> {
    // Phase 1: decide + mutate status under the row lock; collect the seating plan.
    const decision = await this.db.transaction(async (tx) => {
      const lockRows = await tx.execute<{
        id: string;
        status: string;
        min_entrants: number;
        seats_per_table: number;
        starting_stack: number;
        registration_closes_at: Date | string | null;
        blind_schedule_id: string;
      }>(
        sql`SELECT id, status, min_entrants, seats_per_table, starting_stack,
                   registration_closes_at, blind_schedule_id
            FROM poker_tournaments WHERE id = ${tournamentId} FOR UPDATE`,
      );
      const t = lockRows[0];
      if (!t) throw new TournamentError('tournament_not_found', 404);

      if (t.status !== 'registering' && t.status !== 'seating') {
        return { kind: 'noop' as const };
      }

      const windowClosed =
        !!t.registration_closes_at &&
        this.clock.now() >= new Date(t.registration_closes_at).getTime();
      if (!opts.force && !windowClosed) {
        return { kind: 'noop' as const };
      }

      const entrantRows = await tx.execute<{
        id: string;
        avatar_id: string;
        agent_id: string | null;
        subject_type: string;
        buy_in_paid_ct: string;
        status: string;
      }>(
        sql`SELECT id, avatar_id, agent_id, subject_type, buy_in_paid_ct, status
            FROM poker_tournament_entrants
            WHERE tournament_id = ${tournamentId} AND status <> 'refunded'
            ORDER BY registered_at ASC`,
      );

      if (entrantRows.length < t.min_entrants) {
        for (const e of entrantRows) {
          const paid = BigInt(e.buy_in_paid_ct);
          if (paid > 0n) {
            await this.ledger.creditClawTokens(
              {
                avatarId: e.avatar_id,
                amount: Number(paid),
                reason: 'poker_mtt_refund',
                source: 'simulation',
                metadata: { tournamentId, entrantId: e.id },
              },
              tx,
            );
          }
          await tx.execute(
            sql`UPDATE poker_tournament_entrants
                SET status = 'refunded', refunded_ct = ${paid.toString()}
                WHERE id = ${e.id}`,
          );
        }
        await tx.execute(
          sql`UPDATE poker_tournaments SET status = 'cancelled', cancelled_at = now()
              WHERE id = ${tournamentId}`,
        );
        return { kind: 'cancelled' as const, refundedCount: entrantRows.length };
      }

      const blindRows = await tx.execute<{ levels_json: unknown }>(
        sql`SELECT levels_json FROM poker_blind_schedules WHERE id = ${t.blind_schedule_id}`,
      );
      const blindLevels = (blindRows[0]?.levels_json as BlindLevel[] | undefined) ?? [];
      if (blindLevels.length === 0) {
        throw new TournamentError('blind_schedule_empty', 500);
      }

      // ── Balanced multi-table seating ─────────────────────────────────────────
      const seatsPerTable = t.seats_per_table;
      const tableCount = Math.max(1, Math.ceil(entrantRows.length / seatsPerTable));
      // For a SINGLE table, seat in registration order (seat i = entrant i) —
      // preserves the P3 deterministic single-table behavior every existing test
      // relies on. For MULTI-table, shuffle the field (injected RNG) then deal
      // round-robin across the tables so sizes are within 1 of each other AND the
      // initial seat draw is randomly balanced (no registration-order clustering).
      const shuffled = tableCount > 1 ? this.shuffleEntrants(entrantRows) : entrantRows;
      const tablePlans: SeatedTablePlan[] = [];
      for (let tn = 1; tn <= tableCount; tn++) {
        const tableRows = await tx.execute<{ id: string }>(
          sql`INSERT INTO poker_tables (tournament_id, table_number, status, button_seat_index, hand_count)
              VALUES (${tournamentId}, ${tn}, 'live', 0, 0)
              RETURNING id`,
        );
        tablePlans.push({
          tableNumber: tn,
          dbTableId: tableRows[0]!.id,
          seats: [],
        });
      }
      // Round-robin assign (balanced within 1). Seat index within each table is
      // its position in that table's fill order.
      for (let i = 0; i < shuffled.length; i++) {
        const tableIdx = i % tableCount;
        const plan = tablePlans[tableIdx]!;
        const e = shuffled[i]!;
        const seatIndex = plan.seats.length;
        plan.seats.push({
          seatIndex,
          avatarId: e.avatar_id,
          agentId: e.agent_id,
          name: e.avatar_id,
          subjectType: e.subject_type === 'agent' ? 'agent' : 'human',
          chipStack: t.starting_stack,
        });
        await tx.execute(
          sql`UPDATE poker_tournament_entrants
              SET status = 'seated', chip_stack = ${t.starting_stack},
                  current_table_id = ${plan.dbTableId}, seat_index = ${seatIndex}
              WHERE id = ${e.id}`,
        );
      }

      await tx.execute(
        sql`UPDATE poker_tournaments SET status = 'running', started_at = now()
            WHERE id = ${tournamentId}`,
      );

      return {
        kind: 'seated' as const,
        seatsPerTable,
        tableCount,
        startingStack: t.starting_stack,
        blindLevels,
        tablePlans,
        entrantCount: entrantRows.length,
      };
    });

    if (decision.kind === 'noop') {
      return { status: 'noop', seatedCount: 0, refundedCount: 0, tableCount: 0 };
    }
    if (decision.kind === 'cancelled') {
      return { status: 'cancelled', seatedCount: 0, refundedCount: decision.refundedCount, tableCount: 0 };
    }

    // Phase 2 (outside the tx): build the in-memory tournament + per-table drivers.
    const running: RunningTournament = {
      tournamentId,
      blindLevels: decision.blindLevels,
      currentLevelIndex: 0,
      levelStartedMs: this.clock.now(),
      turnClockMs: DEFAULT_TURN_CLOCK_MS,
      agentTurnGraceMs: DEFAULT_AGENT_TURN_GRACE_MS,
      clientSeed: DEFAULT_CLIENT_SEED,
      seatsPerTable: decision.seatsPerTable,
      startingStack: decision.startingStack,
      entrantCount: decision.entrantCount,
      tables: new Map(),
      done: false,
      processing: false,
      queue: [],
    };
    this.running.set(tournamentId, running);

    const multiTable = decision.tableCount > 1;
    let seatedCount = 0;
    for (const plan of decision.tablePlans) {
      const tableId = this.simTableId(tournamentId, plan.tableNumber, multiTable);
      this.tableToTournament.set(tableId, tournamentId);
      seatedCount += plan.seats.length;

      // Create the LONG-LIVED WS room for this table (optional seam). A throw must
      // NOT strand the field: hands still play; only live transport is lost.
      let roomBinding: MttRoomBinding | null = null;
      if (this.onSeatFn) {
        try {
          const seatPlan: MttSeatPlan[] = plan.seats
            .slice()
            .sort((a, b) => a.seatIndex - b.seatIndex)
            .map((s) => ({
              seatIndex: s.seatIndex,
              avatarId: s.avatarId,
              agentId: s.agentId,
              subjectType: s.subjectType,
            }));
          roomBinding = await this.onSeatFn({
            tournamentId,
            tableId,
            tableNumber: plan.tableNumber,
            seats: seatPlan,
          });
        } catch (err) {
          console.error(
            `[poker-mtt] onSeatFn (WS room) failed for tournament ${tournamentId} table ${plan.tableNumber} — playing WITHOUT a live WS room:`,
            err,
          );
          roomBinding = null;
        }
      }

      const table: RunningTable = {
        tableId,
        serverDbTableId: plan.dbTableId,
        tableNumber: plan.tableNumber,
        roomBinding,
        buttonSeatIndex: plan.seats[0]!.seatIndex,
        handNumber: 0,
        liveSeats: new Map(plan.seats.map((s) => [s.seatIndex, s])),
        chipAtHandStart: new Map(),
        handInFlight: false,
        broken: false,
      };
      running.tables.set(plan.tableNumber, table);
      if (roomBinding) {
        this.roomToTable.set(roomBinding.roomId, tableId);
        this.tableToRoom.set(tableId, roomBinding.roomId);
      }
    }

    // Start the first hand at every table.
    for (const table of running.tables.values()) {
      this.startNextHand(running, table);
    }

    return { status: 'running', seatedCount, refundedCount: 0, tableCount: decision.tableCount };
  }

  /** Deterministic Fisher–Yates over entrant rows using the injected RNG. */
  private shuffleEntrants<T>(rows: T[]): T[] {
    const out = rows.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.shuffleFn(i + 1) % (i + 1);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }

  /** Sim tableId for a (tournament, table). Single-table preserves `mtt:<id>`. */
  private simTableId(tournamentId: string, tableNumber: number, multiTable: boolean): string {
    return multiTable ? `mtt:${tournamentId}:t${tableNumber}` : `mtt:${tournamentId}`;
  }

  // ── Start-trigger sweeper (the LIVE seat/cancel path) ────────────────────────

  startStartTriggerSweeper(): void {
    if (this.sweeperHandle) return;
    this.sweeperHandle = setInterval(() => {
      void this.sweepStartTriggers();
    }, START_TRIGGER_SWEEP_INTERVAL_MS);
  }

  stopStartTriggerSweeper(): void {
    if (this.sweeperHandle) {
      clearInterval(this.sweeperHandle);
      this.sweeperHandle = null;
    }
  }

  async sweepStartTriggers(): Promise<void> {
    if (this.sweepInFlight) return;
    this.sweepInFlight = true;
    try {
      const dueRows = await this.db.execute<{ id: string }>(
        sql`SELECT id FROM poker_tournaments
            WHERE status IN ('registering','seating')
              AND registration_closes_at IS NOT NULL
              AND registration_closes_at <= now()`,
      );
      for (const row of dueRows) {
        try {
          await this.startTrigger(row.id);
        } catch (err) {
          console.error(
            `[poker-mtt] start-trigger sweep failed for tournament ${row.id}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error('[poker-mtt] start-trigger sweep query failed:', err);
    } finally {
      this.sweepInFlight = false;
    }
  }

  // ── Multi-hand loop ──────────────────────────────────────────────────────────

  /** Start the next hand for a running table with its current live seats. */
  private startNextHand(r: RunningTournament, table: RunningTable): void {
    if (r.done || table.broken) return;
    const live = [...table.liveSeats.values()].filter((s) => s.chipStack > 0);
    if (live.length <= 1) {
      // ≤1 live seat at this table. If the tournament is down to one survivor
      // overall → champion; otherwise this table is idle (its last seat will be
      // rebalanced/consolidated). Never start a hand with < 2 funded seats.
      this.maybeCompleteTournament(r);
      return;
    }

    this.maybeAdvanceBlindLevel(r);
    const level = r.blindLevels[r.currentLevelIndex]!;

    table.handNumber += 1;
    table.chipAtHandStart = new Map(live.map((s) => [s.seatIndex, s.chipStack]));

    const buttonSeatIndex = this.normalizeButton(table, live);
    table.buttonSeatIndex = buttonSeatIndex;

    const seatAssignments: SeatAssignment[] = live
      .slice()
      .sort((a, b) => a.seatIndex - b.seatIndex)
      .map((s) => ({
        seatIndex: s.seatIndex,
        avatarId: s.avatarId,
        name: s.name,
        subjectType: s.subjectType,
        agentId: s.agentId ?? undefined,
        chipStack: s.chipStack,
      }));

    table.handInFlight = true;
    this.sim.startHand({
      tableId: table.tableId,
      handNumber: table.handNumber,
      seatAssignments,
      blinds: { sb: level.sb, bb: level.bb, ante: level.ante },
      buttonSeatIndex,
      serverSeed: this.seedFn(),
      clientSeed: r.clientSeed,
      turnClockMs: r.turnClockMs,
      agentTurnGraceMs: r.agentTurnGraceMs,
      blindLevel: level.level,
    });
  }

  /** Make sure the button points at a live seat; advance to the next live seat if not. */
  private normalizeButton(table: RunningTable, live: LiveSeat[]): number {
    const liveIdx = live.map((s) => s.seatIndex).sort((a, b) => a - b);
    if (liveIdx.includes(table.buttonSeatIndex)) return table.buttonSeatIndex;
    for (const idx of liveIdx) {
      if (idx > table.buttonSeatIndex) return idx;
    }
    return liveIdx[0]!;
  }

  /** Rotate the button to the next live seat clockwise (after a hand settles). */
  private rotateButton(table: RunningTable): void {
    const liveIdx = [...table.liveSeats.values()]
      .filter((s) => s.chipStack > 0)
      .map((s) => s.seatIndex)
      .sort((a, b) => a - b);
    if (liveIdx.length === 0) return;
    for (const idx of liveIdx) {
      if (idx > table.buttonSeatIndex) {
        table.buttonSeatIndex = idx;
        return;
      }
    }
    table.buttonSeatIndex = liveIdx[0]!;
  }

  /** Advance the (tournament-wide) blind level if the current level's duration elapsed. */
  private maybeAdvanceBlindLevel(r: RunningTournament): void {
    while (r.currentLevelIndex < r.blindLevels.length - 1) {
      const level = r.blindLevels[r.currentLevelIndex]!;
      if (level.durationSec <= 0) break;
      const elapsedSec = (this.clock.now() - r.levelStartedMs) / 1000;
      if (elapsedSec < level.durationSec) break;
      r.currentLevelIndex += 1;
      r.levelStartedMs = this.clock.now();
    }
  }

  /** Total seats with chips > 0 across ALL live tables (tournament-wide remaining). */
  private liveRemaining(r: RunningTournament): number {
    let n = 0;
    for (const table of r.tables.values()) {
      if (table.broken) continue;
      for (const s of table.liveSeats.values()) if (s.chipStack > 0) n++;
    }
    return n;
  }

  /** All live seats across all tables (chips > 0). */
  private allLiveSeats(r: RunningTournament): Array<{ table: RunningTable; seat: LiveSeat }> {
    const out: Array<{ table: RunningTable; seat: LiveSeat }> = [];
    for (const table of r.tables.values()) {
      if (table.broken) continue;
      for (const s of table.liveSeats.values()) if (s.chipStack > 0) out.push({ table, seat: s });
    }
    return out;
  }

  /**
   * The sim fired hand-complete for a table. ENQUEUE the job and kick the
   * per-tournament serial drainer. Hand-completions are processed ONE AT A TIME
   * per tournament so the per-table chip-apply/bust/placement, the between-hands
   * rebalance/break/consolidation, and the next-hand starts never interleave (the
   * sim can fire two tables' completions in quick succession; without
   * serialization a stale `handInFlight` flag lets a second handler stop+restart a
   * hand the first handler already started — the "table already has a live hand"
   * race). The drainer drives EVERY idle, ≥2-funded, non-broken table forward, so
   * a table re-armed by a rebalance/break is started exactly once.
   */
  private async onHandComplete(tableId: string, result: HandResult): Promise<void> {
    const tournamentId = this.tableToTournament.get(tableId);
    if (!tournamentId) return;
    const r = this.running.get(tournamentId);
    if (!r || r.done) return;
    r.queue.push({ tableId, result });
    await this.drainHandQueue(r);
  }

  /**
   * Serial drainer: processes queued hand-completions one at a time, THEN — once
   * the queue is empty and no table is mid-hand — runs the between-hands
   * maintenance (rebalance/break/consolidate) ONCE and starts every idle fundable
   * table's next hand. Deferring maintenance until the queue drains guarantees it
   * sees a quiescent multi-table snapshot (no table mid-hand), so it never defers
   * forever in a two-table ping-pong AND never moves a seat at a live table.
   */
  private async drainHandQueue(r: RunningTournament): Promise<void> {
    if (r.processing) return; // another invocation owns the drain loop
    r.processing = true;
    try {
      // Process every queued completion (chip-apply/bust/placement/persist) first.
      while (r.queue.length > 0 && !r.done) {
        const job = r.queue.shift()!;
        await this.processHandComplete(r, job.tableId, job.result);
      }
      if (r.done) return;
      // Queue drained. If any table is STILL mid-hand (its completion hasn't fired
      // yet), defer the between-hands maintenance + restart to that table's
      // upcoming completion — never rebalance/restart while a hand is live.
      const anyInFlight = [...r.tables.values()].some((tb) => !tb.broken && tb.handInFlight);
      if (!anyInFlight) {
        await this.runBetweenHandsMaintenance(r);
        if (!r.done) this.startIdleTables(r);
      }
    } finally {
      r.processing = false;
    }
    // A completion that arrived during the drain (re-entrant push while we held
    // `processing`) is handled by its own onHandComplete drain kick — which short-
    // circuits on `processing` then this finally re-checks the queue is empty.
    if (!r.done && r.queue.length > 0) {
      void this.drainHandQueue(r);
    }
  }

  /**
   * Process ONE settled hand: apply chip deltas, detect busts, assign
   * TOURNAMENT-WIDE placement, persist the checkpoint, rotate the button. Does NOT
   * run maintenance or start the next hand — the drainer does that once the queue
   * is fully drained (a quiescent snapshot). Completes the tournament on champion.
   */
  private async processHandComplete(
    r: RunningTournament,
    tableId: string,
    result: HandResult,
  ): Promise<void> {
    const table = [...r.tables.values()].find((tb) => tb.tableId === tableId);
    if (!table || table.broken) return;

    table.handInFlight = false;
    // Tear down the sim hand state so the next startHand can reuse the tableId.
    this.sim.stopTable(tableId);

    // ── Apply chip deltas ──────────────────────────────────────────────────────
    for (const ps of result.perSeat) {
      const seat = table.liveSeats.get(ps.seatIndex);
      if (!seat) continue;
      const start = table.chipAtHandStart.get(ps.seatIndex) ?? seat.chipStack;
      const post = start - ps.totalCommitted + ps.won;
      seat.chipStack = post;
    }

    // ── Detect busts → assign TOURNAMENT-WIDE placement ──────────────────────────
    const busted = [...table.liveSeats.values()].filter((s) => s.chipStack <= 0);
    const remainingAfter = this.liveRemaining(r);

    if (remainingAfter === 0) {
      r.done = true;
      console.error(
        `[poker-mtt] INVARIANT VIOLATION: hand ${result.handNumber} left 0 tournament-wide survivors (table ${tableId}). Halting WITHOUT crowning a champion — NOT settling. Manual intervention required.`,
      );
      return;
    }

    const bustPlacements = computeBustPlacements(
      busted.map((s) => ({
        seatIndex: s.seatIndex,
        chipAtHandStart: table.chipAtHandStart.get(s.seatIndex) ?? 0,
      })),
      remainingAfter,
    );
    const seatByIndex = new Map(busted.map((s) => [s.seatIndex, s]));
    const placements: Array<{ seat: LiveSeat; placement: number }> = bustPlacements.map(
      (bp) => ({ seat: seatByIndex.get(bp.seatIndex)!, placement: bp.placement }),
    );

    const championThisHand =
      remainingAfter === 1 ? this.allLiveSeats(r)[0]?.seat ?? null : null;

    // ── Persist the hand checkpoint + bust placements (idempotent on handNumber) ─
    await this.persistHandAndBusts(r, table, result, placements, championThisHand);

    for (const { seat } of placements) {
      table.liveSeats.delete(seat.seatIndex);
    }

    if (championThisHand) {
      for (const tb of r.tables.values()) tb.liveSeats.delete(championThisHand.seatIndex);
      await this.completeTournament(r, championThisHand);
      return;
    }

    // Rotate the button among this table's survivors. The drainer runs the
    // between-hands maintenance + next-hand starts once the whole queue drains.
    this.rotateButton(table);
  }

  /** Start the next hand for every idle, ≥2-funded, non-broken table. */
  private startIdleTables(r: RunningTournament): void {
    if (r.done) return;
    for (const tb of r.tables.values()) {
      if (tb.broken || tb.handInFlight) continue;
      const liveCount = [...tb.liveSeats.values()].filter((s) => s.chipStack > 0).length;
      if (liveCount >= 2) this.startNextHand(r, tb);
    }
  }

  /**
   * Between-hands multi-table maintenance: consolidate to a final table, break
   * short tables, and rebalance. Runs ONLY when no table has a hand in flight so
   * a player is never moved mid-hand. Single-table tournaments short-circuit.
   */
  private async runBetweenHandsMaintenance(r: RunningTournament): Promise<void> {
    const liveTables = [...r.tables.values()].filter((tb) => !tb.broken);
    if (liveTables.length <= 1) return; // single table — nothing to balance/break

    // Defer if any table is mid-hand — moving its seats would corrupt a live hand.
    if (liveTables.some((tb) => tb.handInFlight)) return;

    const remaining = this.liveRemaining(r);

    // ── Final-table consolidation ────────────────────────────────────────────
    // Once survivors fit ONE table, consolidate everyone onto the lowest-numbered
    // live table and break the rest.
    if (remaining <= r.seatsPerTable) {
      const finalTable = liveTables
        .slice()
        .sort((a, b) => a.tableNumber - b.tableNumber)[0]!;
      for (const tb of liveTables) {
        if (tb.tableNumber === finalTable.tableNumber) continue;
        for (const seat of [...tb.liveSeats.values()].filter((s) => s.chipStack > 0)) {
          this.moveSeat(r, tb, finalTable, seat, 'final_table');
        }
        await this.breakTable(r, tb);
      }
      // Mark the final table's DB row status = 'final' via 'live' (schema status
      // set is {'live','broken','done'}); the tournaments-level final-table state
      // is implicit in "one live table remains". No status mutation needed beyond
      // the existing 'live'.
      return;
    }

    // ── Table-break: a table below the merge threshold distributes its players ──
    // Merge threshold: a table is broken when it would leave ≤ (tableCount-1)
    // tables each able to seat the surviving field within seatsPerTable AND the
    // short table has few enough players that other tables can absorb them. We use
    // the standard rule: if removing the shortest table keeps every remaining
    // table ≤ seatsPerTable, break it.
    const sortedBySize = liveTables
      .slice()
      .sort(
        (a, b) =>
          this.tableLiveCount(a) - this.tableLiveCount(b) || a.tableNumber - b.tableNumber,
      );
    const shortest = sortedBySize[0]!;
    const others = sortedBySize.slice(1);
    const otherCapacity = others.reduce(
      (acc, tb) => acc + (r.seatsPerTable - this.tableLiveCount(tb)),
      0,
    );
    if (this.tableLiveCount(shortest) > 0 && otherCapacity >= this.tableLiveCount(shortest)) {
      // Distribute the shortest table's players to the tables with the most open
      // seats first (greedy), keeping destinations ≤ seatsPerTable.
      for (const seat of [...shortest.liveSeats.values()].filter((s) => s.chipStack > 0)) {
        const dest = others
          .filter((tb) => this.tableLiveCount(tb) < r.seatsPerTable)
          .sort(
            (a, b) =>
              this.tableLiveCount(a) - this.tableLiveCount(b) || a.tableNumber - b.tableNumber,
          )[0];
        if (!dest) break;
        this.moveSeat(r, shortest, dest, seat, 'table_break');
      }
      if (this.tableLiveCount(shortest) === 0) {
        await this.breakTable(r, shortest);
      }
      // After a break, fall through to a rebalance pass on what's left.
    }

    // ── Rebalance: keep table sizes within 1 ──────────────────────────────────
    this.rebalanceTables(r);
  }

  /** Live seat count (chips > 0) at a table. */
  private tableLiveCount(tb: RunningTable): number {
    let n = 0;
    for (const s of tb.liveSeats.values()) if (s.chipStack > 0) n++;
    return n;
  }

  /**
   * Move a single player from the LARGEST table to the SHORTEST while their sizes
   * differ by ≥ 2, keeping every table within 1 of every other. Runs only between
   * hands. Standard "no double blind / move to the worst position" is honored by
   * giving the moved player the next-available seat at the destination (they post
   * blinds only when the button reaches them, never an immediate extra blind —
   * the sim posts blinds off the button each hand, so a freshly-seated player
   * outside the blinds owes nothing until the button rotates to them).
   */
  private rebalanceTables(r: RunningTournament): void {
    let guard = 0;
    while (guard++ < 64) {
      const liveTables = [...r.tables.values()].filter((tb) => !tb.broken);
      if (liveTables.length <= 1) return;
      const bySize = liveTables
        .slice()
        .sort(
          (a, b) =>
            this.tableLiveCount(b) - this.tableLiveCount(a) || a.tableNumber - b.tableNumber,
        );
      const largest = bySize[0]!;
      const shortest = bySize[bySize.length - 1]!;
      if (this.tableLiveCount(largest) - this.tableLiveCount(shortest) < 2) return;
      // Move the player at the worst position (largest seatIndex distance from the
      // button = "the seat that just passed the button") — pick the highest live
      // seatIndex deterministically so the choice is reproducible.
      const candidate = [...largest.liveSeats.values()]
        .filter((s) => s.chipStack > 0)
        .sort((a, b) => b.seatIndex - a.seatIndex)[0]!;
      this.moveSeat(r, largest, shortest, candidate, 'rebalance');
    }
  }

  /**
   * Move one seat from `fromTable` to `toTable`, conserving chips. Updates both
   * tables' in-memory state, the DB entrant row (currentTableId/seatIndex), the
   * room↔table maps, and fires the `onMoveFn` seam (poker.moved / table_rebalanced).
   * NEVER called mid-hand (callers guard on `handInFlight`).
   */
  private moveSeat(
    r: RunningTournament,
    fromTable: RunningTable,
    toTable: RunningTable,
    seat: LiveSeat,
    reason: MttMoveInfo['reason'],
  ): void {
    // Assign the next free seat index at the destination (0..seatsPerTable-1).
    const used = new Set([...toTable.liveSeats.keys()]);
    let newSeatIndex = 0;
    while (used.has(newSeatIndex)) newSeatIndex++;

    fromTable.liveSeats.delete(seat.seatIndex);
    const moved: LiveSeat = { ...seat, seatIndex: newSeatIndex };
    toTable.liveSeats.set(newSeatIndex, moved);

    // Persist the entrant's new table + seat (best-effort, fire-and-forget under
    // the loop's macrotask — the next settled-hand checkpoint also re-writes
    // chip_stack, and crash recovery rebuilds from poker_tables + entrants).
    void this.db
      .transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE poker_tournament_entrants
              SET current_table_id = ${toTable.serverDbTableId}, seat_index = ${newSeatIndex}
              WHERE tournament_id = ${r.tournamentId} AND avatar_id = ${moved.avatarId}`,
        );
      })
      .catch((err) => {
        console.error(
          `[poker-mtt] failed to persist rebalance move for avatar ${moved.avatarId} (tournament ${r.tournamentId}):`,
          err,
        );
      });

    // Fire the WS seam: tell the moved player its NEW room/seat + notify both
    // tables of the rebalance. Best-effort; a throw never blocks the move.
    if (this.onMoveFn) {
      try {
        void Promise.resolve(
          this.onMoveFn({
            tournamentId: r.tournamentId,
            avatarId: moved.avatarId,
            agentId: moved.agentId,
            fromTableId: fromTable.tableId,
            fromRoomId: fromTable.roomBinding?.roomId ?? null,
            toTableId: toTable.tableId,
            toRoomId: toTable.roomBinding?.roomId ?? null,
            toShortCode: toTable.roomBinding?.shortCode ?? null,
            toSeatIndex: newSeatIndex,
            chipStack: moved.chipStack,
            reason,
          }),
        ).catch((err) => {
          console.error(
            `[poker-mtt] onMoveFn failed for avatar ${moved.avatarId} (tournament ${r.tournamentId}):`,
            err,
          );
        });
      } catch (err) {
        console.error(
          `[poker-mtt] onMoveFn threw synchronously for avatar ${moved.avatarId}:`,
          err,
        );
      }
    }
  }

  /**
   * Break a table that has been emptied of live players (its survivors were moved
   * away). Marks it broken in memory + DB, tears down its WS room (→ results), and
   * clears the room↔table maps. Idempotent.
   */
  private async breakTable(r: RunningTournament, table: RunningTable): Promise<void> {
    if (table.broken) return;
    table.broken = true;
    table.liveSeats.clear();

    // Persist the table status (best-effort, idempotent — 'broken' is terminal).
    await this.db
      .transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE poker_tables SET status = 'broken' WHERE id = ${table.serverDbTableId}`,
        );
      })
      .catch((err) => {
        console.error(
          `[poker-mtt] failed to persist table-break for table ${table.tableNumber} (tournament ${r.tournamentId}):`,
          err,
        );
      });

    // Tear down the WS room (→ results) so connected clients see the room close.
    if (table.roomBinding) {
      const { roomId } = table.roomBinding;
      this.roomToTable.delete(roomId);
      this.tableToRoom.delete(table.tableId);
      if (this.onTournamentEndFn) {
        try {
          await this.onTournamentEndFn({
            tournamentId: r.tournamentId,
            tableId: table.tableId,
            roomId,
          });
        } catch (err) {
          console.error(
            `[poker-mtt] onTournamentEndFn (table-break teardown) failed for table ${table.tableNumber}:`,
            err,
          );
        }
      }
    }
  }

  /**
   * Persist the settled hand (audit + crash-recovery checkpoint) and the bust
   * placements + chip stacks for THIS table's hand, all in one tx. Idempotent on
   * (tableId, handNumber).
   */
  private async persistHandAndBusts(
    r: RunningTournament,
    table: RunningTable,
    result: HandResult,
    placements: Array<{ seat: LiveSeat; placement: number }>,
    championThisHand: LiveSeat | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(
        sql`INSERT INTO poker_hands
              (table_id, hand_number, server_seed_commit, server_seed_reveal,
               client_seed, board_json, pot_result_json, settled_at)
            VALUES (${table.serverDbTableId}, ${result.handNumber},
                    ${sha256OrPlaceholder(result.serverSeedRevealed)},
                    ${result.serverSeedRevealed}, ${r.clientSeed},
                    ${JSON.stringify(result.board)}::jsonb,
                    ${JSON.stringify(result.perSeat)}::jsonb, now())
            ON CONFLICT (table_id, hand_number) DO NOTHING
            RETURNING id`,
      );
      if (!inserted[0]) return;

      // Update chip_stack on each still-live seat at this table.
      for (const seat of table.liveSeats.values()) {
        await tx.execute(
          sql`UPDATE poker_tournament_entrants
              SET chip_stack = ${seat.chipStack}
              WHERE tournament_id = ${r.tournamentId} AND avatar_id = ${seat.avatarId}`,
        );
      }
      for (const { seat, placement } of placements) {
        await tx.execute(
          sql`UPDATE poker_tournament_entrants
              SET status = 'busted', placement = ${placement}, chip_stack = 0,
                  busted_at = now()
              WHERE tournament_id = ${r.tournamentId} AND avatar_id = ${seat.avatarId}`,
        );
      }
      if (championThisHand) {
        await tx.execute(
          sql`UPDATE poker_tournament_entrants
              SET placement = 1, chip_stack = ${championThisHand.chipStack}
              WHERE tournament_id = ${r.tournamentId} AND avatar_id = ${championThisHand.avatarId}`,
        );
      }
      await tx.execute(
        sql`UPDATE poker_tables SET hand_count = ${result.handNumber}, button_seat_index = ${table.buttonSeatIndex}
            WHERE id = ${table.serverDbTableId}`,
      );
    });
  }

  // ── Completion + prize settlement ────────────────────────────────────────────

  /**
   * Check whether the tournament is down to ONE survivor across all tables and, if
   * so, complete it. Called when a table can't start a hand (≤1 live seat) but no
   * bust fired through onHandComplete (defensive path).
   */
  private maybeCompleteTournament(r: RunningTournament): void {
    if (r.done) return;
    if (this.liveRemaining(r) === 1) {
      const champ = this.allLiveSeats(r)[0]?.seat;
      if (champ) void this.completeTournament(r, champ);
    }
  }

  /**
   * Crown the champion (if not already placed) and settle prizes idempotently.
   *
   * OWNERSHIP LIFECYCLE (Codex rounds 4+5) — `r.done` is the single-owner token, set
   * SYNCHRONOUSLY here (before any await) so a racing onRoomAborted defers to us:
   *   claim(r.done=true) → { FINISH (placement+settle+cleanup)
   *                        | FAIL (non-fatal async error, process alive) → release
   *                          (r.done=false) → bounded self-heal retry → FREEZE-if-exhausted
   *                        | PROCESS-CRASH → boot recovery reclaims next boot }
   * completeTournament is fire-and-forget (maybeCompleteTournament / the hand-complete
   * callback), so a naked rejection would only be logged and the tournament would
   * STRAND (stuck in this.running with r.done claimed forever, row 'running'/unsettled,
   * buy-ins locked). The try/catch converts that into the release+retry leg.
   */
  private async completeTournament(r: RunningTournament, champion?: LiveSeat): Promise<void> {
    if (r.done) return;
    r.done = true;
    try {
      if (champion) {
        await this.db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE poker_tournament_entrants
                SET placement = 1
                WHERE tournament_id = ${r.tournamentId} AND avatar_id = ${champion.avatarId}
                  AND placement IS NULL`,
          );
        });
      }
      await this.settleTournament(r.tournamentId);
      await this.finishCompletion(r);
    } catch (err) {
      this.handleCompletionFailure(r, err, 0);
    }
  }

  /**
   * Terminal cleanup for a tournament that reached a terminal outcome (settled /
   * refunded / frozen-final): tear down every remaining table's WS room (→ results
   * screen) and REMOVE the tournament from `this.running` so in-memory state and boot
   * recovery can never diverge — a terminal tournament left in the map would make
   * onRoomAborted no-op on a stale record AND hide it from boot recovery (which skips
   * in-memory ids). Idempotent.
   */
  private async finishCompletion(r: RunningTournament): Promise<void> {
    for (const table of r.tables.values()) {
      if (table.roomBinding) {
        const { roomId } = table.roomBinding;
        this.roomToTable.delete(roomId);
        this.tableToRoom.delete(table.tableId);
        if (this.onTournamentEndFn) {
          try {
            await this.onTournamentEndFn({
              tournamentId: r.tournamentId,
              tableId: table.tableId,
              roomId,
            });
          } catch (err) {
            console.error(
              `[poker-mtt] onTournamentEndFn (room teardown) failed for tournament ${r.tournamentId} table ${table.tableNumber}:`,
              err,
            );
          }
        }
      }
      this.tableToTournament.delete(table.tableId);
    }
    this.running.delete(r.tournamentId);
  }

  /**
   * The "claim → FAIL → release → bounded-retry → freeze" leg of the ownership model:
   * a NON-FATAL async failure mid-completion (transient DB/ledger error) with the
   * process still ALIVE. Alerts, RELEASES ownership (`r.done = false`), and either
   * schedules the next bounded self-heal retry or, after the last, FREEZES (leaves the
   * row as-is, drops the in-memory record) with a final critical alert.
   *
   * Releasing ownership after a failure is SAFE against the round-4 completion-vs-abort
   * race: the retry — and any concurrent abort that claims in the meantime — routes
   * through resolveOrphanedTournament, which reads COMMITTED DB state (not the in-flight
   * guess), so whatever actually committed decides the outcome. `attempt` = attempts
   * already FAILED (0 = the initial completeTournament).
   */
  private handleCompletionFailure(r: RunningTournament, err: unknown, attempt: number): void {
    const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]; // 3 bounded self-heal retries (~5s/30s/2m)
    const exhausted = attempt >= RETRY_DELAYS_MS.length;
    void alertError({
      severity: exhausted ? 'critical' : 'warning',
      source: 'poker-mtt/completeTournament',
      message: exhausted
        ? `tournament ${r.tournamentId} FROZEN after ${attempt} failed completion attempts — operator intervention required (a process restart also reclaims it via boot recovery)`
        : `tournament ${r.tournamentId} completion attempt ${attempt} failed — releasing ownership + scheduling self-heal retry`,
      context: { tournamentId: r.tournamentId, attempt, err: String(err) },
    });
    // RELEASE ownership so the retry (or a concurrent abort/completion) can re-claim.
    r.done = false;
    if (exhausted) {
      // Bounded — never loop forever. Leave the row FROZEN ('running'/unsettled) and
      // drop the in-memory record so a process restart reclaims it via boot recovery.
      this.running.delete(r.tournamentId);
      return;
    }
    this.clock.setTimer(() => {
      void this.retryCompletion(r, attempt);
    }, RETRY_DELAYS_MS[attempt]);
  }

  /**
   * A bounded self-heal retry of a failed completion. Re-claims via the SAME synchronous
   * `r.done` discipline (if a concurrent abort/completion already owns it → SKIP; they
   * finish/dispose), then routes through resolveOrphanedTournament — correct for whatever
   * the DB has committed by now: placement committed → fully-placed → settle (idempotent
   * under `settled_at`, so a partially-failed settle never double-pays); placement not
   * committed → unfinished → refund; malformed → freeze. On its own failure, recurse
   * with the next attempt.
   */
  private async retryCompletion(r: RunningTournament, attempt: number): Promise<void> {
    if (r.done) return; // a concurrent abort/completion took ownership — let it finish.
    r.done = true;
    try {
      await this.resolveOrphanedTournament(r.tournamentId);
      await this.finishCompletion(r);
    } catch (err) {
      this.handleCompletionFailure(r, err, attempt + 1);
    }
  }

  /**
   * Compute + credit prizes for a completed tournament, idempotently, under the
   * poker_tournaments FOR UPDATE row lock with a `settled_at` anchor. Conserves CT
   * exactly: sum(prizeCt) + rakeTaken == prizePoolCt.
   */
  async settleTournament(tournamentId: string): Promise<SettleResult> {
    const settle = await this.db.transaction(async (tx) => {
      const lockRows = await tx.execute<{
        id: string;
        status: string;
        rake_bps: number;
        prize_pool_ct: string;
        rake_taken_ct: string | null;
        payout_curve_json: unknown;
        settled_at: Date | string | null;
        cancelled_at: Date | string | null;
      }>(
        sql`SELECT id, status, rake_bps, prize_pool_ct, rake_taken_ct, payout_curve_json, settled_at, cancelled_at
            FROM poker_tournaments WHERE id = ${tournamentId} FOR UPDATE`,
      );
      const t = lockRows[0];
      if (!t) throw new TournamentError('tournament_not_found', 404);

      if (t.status === 'cancelled' || t.cancelled_at) {
        return {
          alreadySettled: true,
          rakeTakenCt: t.rake_taken_ct ?? '0',
          results: [],
        };
      }

      if (t.settled_at) {
        const rows = await tx.execute<{
          avatar_id: string;
          agent_id: string | null;
          placement: number;
          prize_ct: string;
        }>(
          sql`SELECT avatar_id, agent_id, placement, prize_ct
              FROM poker_tournament_results WHERE tournament_id = ${tournamentId}
              ORDER BY placement ASC`,
        );
        return {
          alreadySettled: true,
          rakeTakenCt: t.rake_taken_ct ?? '0',
          // Replay path — never re-emitted (emitLeaderboard runs only on a FRESH
          // settle), so fp provenance is not needed here; the results table carries
          // no fp columns. Set null to satisfy the SettleResult shape.
          results: rows.map((row) => ({
            avatarId: row.avatar_id,
            agentId: row.agent_id,
            placement: row.placement,
            prizeCt: row.prize_ct,
            fpHash: null,
            ipPrefixHash: null,
          })),
        };
      }

      const entrantRows = await tx.execute<{
        avatar_id: string;
        agent_id: string | null;
        placement: number | null;
        fp_hash: string | null;
        ip_prefix_hash: string | null;
      }>(
        sql`SELECT avatar_id, agent_id, placement, fp_hash, ip_prefix_hash
            FROM poker_tournament_entrants
            WHERE tournament_id = ${tournamentId} AND status <> 'refunded'
            ORDER BY placement ASC NULLS LAST`,
      );
      const placed = entrantRows.filter((e) => e.placement != null);
      if (placed.length !== entrantRows.length) {
        throw new TournamentError('tournament_not_finished', 409);
      }

      // CRASH-LOUD placement-integrity guard (Codex gate 2026-07-04) — BEFORE any
      // credit. The non-refunded entrants MUST form EXACTLY the permutation 1..N
      // (unique placements, exactly one champion at 1, no gaps). Nothing in the
      // schema forbade a duplicate placement, and the fold-remainder math AMPLIFIES
      // that hole into a MINT: the payout loop credits per-entrant while `distributed`
      // is Set-keyed over placements, so a duplicated placement is paid twice but
      // counted once, inflating the fold-into-1st remainder ([1,1,2] / pool 300 /
      // 50-30-20 → 210+210+90 = 510 paid = 210 CT minted). On violation: alert +
      // throw (the enclosing tx rolls back → NOTHING credited). The DB-level
      // `poker_entrants_tournament_placement_unique` partial index is the primary
      // defense; this is defense-in-depth if it is ever absent.
      await this.assertPlacementsPermutation(placed, tournamentId);

      const pool = BigInt(t.prize_pool_ct);
      const rakeBps = BigInt(t.rake_bps);
      const rake = (pool * rakeBps) / 10000n;
      const netPool = pool - rake;

      const curve = (t.payout_curve_json as PayoutCurveEntry[] | undefined) ?? [];
      const prizeByPlacement = computePrizes(netPool, curve);

      // CONSERVATION: only prizes for placements an entrant ACTUALLY finished at are
      // paid out (the payout loop below keys on real placements), so `distributed`
      // must sum ONLY those. Summing the FULL curve — including placements deeper
      // than the entrant count — made `remainder` capture just the rounding dust,
      // silently VAPORIZING the unclaimed deep-placement shares whenever
      // #entrants < curve depth (e.g. a top-3 curve with only 2 finishers lost 3rd
      // place's share). Sum over the placements that exist, then fold the FULL
      // unclaimed remainder (rounding + unfilled deeper places) into 1st — always
      // present (the champion) — so sum(paid prizes) + rake == pool exactly.
      const placedPlacements = new Set(placed.map((e) => e.placement!));
      let distributed = 0n;
      for (const [placement, v] of prizeByPlacement) {
        if (placedPlacements.has(placement)) distributed += v;
      }
      const remainder = netPool - distributed;
      if (remainder !== 0n) {
        const first = prizeByPlacement.get(1) ?? 0n;
        prizeByPlacement.set(1, first + remainder);
      }

      const resultsOut: SettleResult['results'] = [];
      for (const e of placed) {
        const placement = e.placement!;
        const prize = prizeByPlacement.get(placement) ?? 0n;
        await tx.execute(
          sql`INSERT INTO poker_tournament_results
                (tournament_id, avatar_id, agent_id, placement, prize_ct, settled_at)
              VALUES (${tournamentId}, ${e.avatar_id}, ${e.agent_id}, ${placement},
                      ${prize.toString()}, now())
              ON CONFLICT (tournament_id, avatar_id) DO NOTHING`,
        );
        if (prize > 0n) {
          await this.ledger.creditClawTokens(
            {
              avatarId: e.avatar_id,
              amount: Number(prize),
              reason: 'poker_mtt_prize',
              source: 'simulation',
              metadata: { tournamentId, placement, agentId: e.agent_id },
            },
            tx,
          );
        }
        resultsOut.push({
          avatarId: e.avatar_id,
          agentId: e.agent_id,
          placement,
          prizeCt: prize.toString(),
          fpHash: e.fp_hash,
          ipPrefixHash: e.ip_prefix_hash,
        });
      }

      await tx.execute(
        sql`UPDATE poker_tournaments
            SET status = 'completed', settled_at = now(), rake_taken_ct = ${rake.toString()}
            WHERE id = ${tournamentId}`,
      );

      return {
        alreadySettled: false,
        rakeTakenCt: rake.toString(),
        results: resultsOut,
      };
    });

    if (!settle.alreadySettled) {
      this.emitLeaderboard(tournamentId, settle as SettleResult);
    }

    return settle as SettleResult;
  }

  /** Leaderboard hook (Rule E5 parity). */
  private emitLeaderboard(tournamentId: string, settle: SettleResult): void {
    for (const r of settle.results) {
      void Promise.resolve(
        this.emitPlacementFn({
          tournamentId,
          avatarId: r.avatarId,
          agentId: r.agentId,
          placement: r.placement,
          prizeCt: r.prizeCt,
          subjectType: r.agentId ? 'agent' : 'human',
          fpHash: r.fpHash,
          ipPrefixHash: r.ipPrefixHash,
        }),
      ).catch((err) => {
        console.error(
          `[poker-mtt] leaderboard placement emit failed (tournament ${tournamentId}, avatar ${r.avatarId}):`,
          err,
        );
      });
    }
  }

  // ── Crash recovery + abort handling ──────────────────────────────────────────

  /**
   * BOOT-RECOVERY DRIVER. On startup, find tournaments with status in
   * ('running','seating') that have NO in-memory state (this pod did not seat
   * them — a prior pod crashed). For each: if it's UNRECOVERABLE (we don't rebuild
   * live hand state across a restart this phase), CANCEL + refund every
   * non-refunded entrant's PAID buy-in idempotently — never strand escrow, never
   * double-credit. A 'running' tournament that has already been settled (settled_at
   * set) is skipped. Reconciles with reef/bumper recoverOrphanedRooms (the rooms
   * are aborted by the activity-room-manager's own boot recovery; here we settle
   * the MONEY).
   *
   * Idempotent: re-running finds the now-cancelled tournament status and skips it;
   * the per-entrant refund is gated on `status <> 'refunded'`.
   */
  async recoverOrphanedTournaments(): Promise<{ recovered: number; refundedCount: number }> {
    let recovered = 0;
    let refundedCount = 0;
    try {
      const orphanRows = await this.db.execute<{ id: string }>(
        sql`SELECT id FROM poker_tournaments
            WHERE status IN ('running','seating')
              AND settled_at IS NULL AND cancelled_at IS NULL`,
      );
      for (const row of orphanRows) {
        // Skip tournaments THIS pod is actively running (in-memory state present).
        if (this.running.has(row.id)) continue;
        try {
          // Shared decide logic (settle-if-finished / freeze-if-malformed /
          // refund-if-unfinished) — see resolveOrphanedTournament. A 'frozen' result is
          // intentionally NOT counted as recovered; it stays running+unsettled for
          // operator intervention (never minted, never void-refunded).
          const res = await this.resolveOrphanedTournament(row.id);
          if (res.action === 'refunded') {
            recovered += 1;
            refundedCount += res.refundedCount;
          } else if (res.action === 'settled') {
            recovered += 1;
          }
        } catch (err) {
          console.error(
            `[poker-mtt] orphan tournament recovery failed for ${row.id}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error('[poker-mtt] orphan tournament recovery query failed:', err);
    }
    return { recovered, refundedCount };
  }

  /**
   * CRASH-LOUD guard: assert the given placed entrants' placements form EXACTLY the
   * permutation 1..N (unique, no gaps, exactly one champion at placement 1). This is
   * the precondition the prize math relies on for conservation — a duplicate or gap
   * would MINT or mispay CT under the per-entrant payout loop. On violation: fire the
   * critical alert-error hook (Telegram if configured, else console) and throw
   * `tournament_placements_malformed` (500) so the enclosing settle transaction rolls
   * back and NOTHING is credited. Never mutates state.
   */
  private async assertPlacementsPermutation(
    placed: Array<{ placement: number | null }>,
    tournamentId: string,
  ): Promise<void> {
    const placements = placed
      .map((e) => e.placement)
      .filter((p): p is number => p != null)
      .sort((a, b) => a - b);
    const n = placements.length;
    let ok = n > 0;
    for (let i = 0; i < n; i++) {
      if (placements[i] !== i + 1) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      // FIRE-AND-FORGET the alert (do NOT await): this runs INSIDE the settle
      // db.transaction with the tournament row FOR UPDATE locked. alertError does an
      // awaited network POST; awaiting it here would keep the lock held (and delay the
      // rollback) if the network stalls. alertError never throws (internal catch) and
      // is now itself bounded by a 5s AbortController, so `void` is safe — throw
      // immediately so the tx rolls back at once and NOTHING is credited.
      void alertError({
        severity: 'critical',
        source: 'poker-mtt/settleTournament',
        message: `tournament_placements_malformed: tournament ${tournamentId} non-refunded placements are not the permutation 1..${n} — settle FROZEN, credited nothing`,
        context: { tournamentId, placements },
      });
      throw new TournamentError('tournament_placements_malformed', 500);
    }
  }

  /**
   * True iff the tournament has ≥1 non-refunded entrant and EVERY non-refunded
   * entrant has a non-null placement — i.e. it actually finished (a champion at
   * placement 1 + all busts placed) but did not commit its settle. Used by orphan
   * recovery to settle-instead-of-void a decided-but-uncommitted tournament. A still
   * -running tournament always has ≥1 live seat with placement NULL, so returns false;
   * a 'seating' (never-started) tournament has all placements NULL, so also false.
   */
  private async isTournamentFullyPlaced(tournamentId: string): Promise<boolean> {
    const rows = await this.db.execute<{ total: number; unplaced: number }>(
      sql`SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE placement IS NULL)::int AS unplaced
          FROM poker_tournament_entrants
          WHERE tournament_id = ${tournamentId} AND status <> 'refunded'`,
    );
    const r = rows[0];
    return !!r && r.total > 0 && r.unplaced === 0;
  }

  /**
   * Decide + apply the terminal disposition of an orphaned/aborted tournament that is
   * no longer being driven (a boot orphan OR a room-abort). SHARED by
   * recoverOrphanedTournaments AND onRoomAborted so the two call sites can NEVER drift
   * (a bug where one path void-refunds a decided tournament while the other settles it):
   *   - fully placed + VALID permutation → SETTLE (pay the real curve; conserves)
   *   - fully placed + MALFORMED placements → FROZEN (settleTournament's guard throws
   *     `tournament_placements_malformed`; caught + logged here → NEITHER settle (mint)
   *     NOR refund (void a possibly-decided result); operator intervention required)
   *   - not yet finished → CANCEL + REFUND the escrow
   * settleTournament + cancelAndRefundOrphan are each idempotent + FOR UPDATE locked, so
   * this is safe to drive from a cold pod AND safe to double-invoke (boot + abort racing).
   */
  private async resolveOrphanedTournament(
    tournamentId: string,
  ): Promise<
    { action: 'settled' } | { action: 'refunded'; refundedCount: number } | { action: 'frozen' }
  > {
    if (await this.isTournamentFullyPlaced(tournamentId)) {
      return this.settleOrFreeze(tournamentId);
    }
    // Not fully placed as of the un-locked check → refund. But cancelAndRefundOrphan
    // RE-READS placement state UNDER its FOR UPDATE lock and throws
    // `tournament_finished_not_refundable` if a champion-placement committed in the
    // race window — in that case it actually FINISHED, so settle instead of refund
    // (never void a decided result). See cancelAndRefundOrphan's belt-and-suspenders.
    try {
      const refundedCount = await this.cancelAndRefundOrphan(tournamentId);
      return { action: 'refunded', refundedCount };
    } catch (err) {
      if (err instanceof TournamentError && err.message === 'tournament_finished_not_refundable') {
        return this.settleOrFreeze(tournamentId);
      }
      throw err;
    }
  }

  /**
   * Settle a fully-placed tournament, or FREEZE it if the placement guard rejects it
   * as malformed (never settle→mint, never refund→void). Shared by the two
   * resolveOrphanedTournament branches (fully-placed, and the finished-during-refund
   * re-route) so the frozen handling can't diverge.
   */
  private async settleOrFreeze(
    tournamentId: string,
  ): Promise<{ action: 'settled' } | { action: 'frozen' }> {
    try {
      await this.settleTournament(tournamentId);
      return { action: 'settled' };
    } catch (err) {
      if (err instanceof TournamentError && err.message === 'tournament_placements_malformed') {
        console.error(
          `[poker-mtt] tournament ${tournamentId} left FROZEN (malformed placements — neither settled nor refunded); operator intervention required.`,
        );
        return { action: 'frozen' };
      }
      throw err;
    }
  }

  /**
   * Cancel + refund an orphaned tournament's escrow idempotently. Refunds each
   * non-refunded entrant's PAID buy-in (CT conservation: refunds net 0), flips the
   * tournament → cancelled. Under the FOR UPDATE row lock so two pods can't double
   * refund. Returns the number of entrants refunded.
   *
   * Public so the abort-notification path + a test can drive it directly.
   */
  async cancelAndRefundOrphan(tournamentId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const lockRows = await tx.execute<{
        id: string;
        status: string;
        settled_at: Date | string | null;
        cancelled_at: Date | string | null;
      }>(
        sql`SELECT id, status, settled_at, cancelled_at
            FROM poker_tournaments WHERE id = ${tournamentId} FOR UPDATE`,
      );
      const t = lockRows[0];
      if (!t) return 0;
      // Already terminal (settled or cancelled) → idempotent no-op.
      if (t.settled_at || t.cancelled_at || t.status === 'completed' || t.status === 'cancelled') {
        return 0;
      }

      // BELT-AND-SUSPENDERS (Codex round 4): re-read placement state UNDER this lock.
      // If the tournament is now FULLY placed, a champion-placement committed in a
      // race window between the caller's un-locked isTournamentFullyPlaced check and
      // this refund tx — it actually FINISHED and must SETTLE, not refund. Abort the
      // refund (throw before ANY credit → tx rolls back) so the caller re-routes to
      // settle. (The primary defense against the exact completion-vs-abort window is
      // the r.done ownership gate in onRoomAborted; this hardens every narrower
      // ordering, incl. a multi-replica future where another pod commits the placement.)
      const placeRows = await tx.execute<{ total: number; unplaced: number }>(
        sql`SELECT COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE placement IS NULL)::int AS unplaced
            FROM poker_tournament_entrants
            WHERE tournament_id = ${tournamentId} AND status <> 'refunded'`,
      );
      const pr = placeRows[0];
      if (pr && pr.total > 0 && pr.unplaced === 0) {
        throw new TournamentError('tournament_finished_not_refundable', 409);
      }

      const entrantRows = await tx.execute<{
        id: string;
        avatar_id: string;
        buy_in_paid_ct: string;
      }>(
        sql`SELECT id, avatar_id, buy_in_paid_ct
            FROM poker_tournament_entrants
            WHERE tournament_id = ${tournamentId} AND status <> 'refunded'`,
      );
      for (const e of entrantRows) {
        const paid = BigInt(e.buy_in_paid_ct);
        if (paid > 0n) {
          await this.ledger.creditClawTokens(
            {
              avatarId: e.avatar_id,
              amount: Number(paid),
              reason: 'poker_mtt_refund',
              source: 'simulation',
              metadata: { tournamentId, entrantId: e.id, recovery: true },
            },
            tx,
          );
        }
        await tx.execute(
          sql`UPDATE poker_tournament_entrants
              SET status = 'refunded', refunded_ct = ${paid.toString()}
              WHERE id = ${e.id}`,
        );
      }
      await tx.execute(
        sql`UPDATE poker_tournaments SET status = 'cancelled', cancelled_at = now()
            WHERE id = ${tournamentId}`,
      );
      return entrantRows.length;
    });
  }

  /**
   * ABORT-NOTIFICATION HOOK. Called by the activity-room-manager (via the bridge)
   * when an mtt room is aborted by ANY path (sweeper crash-TTL, manual abort, pod
   * orphan recovery). Resolves the affected table + tournament and, to never
   * strand CT, CANCELS + refunds the tournament's escrow idempotently. If the
   * tournament already settled/cancelled this is a no-op. Best-effort: a throw is
   * logged, never propagated to the room manager's sweep.
   *
   * NOTE: a live, healthy mtt table legitimately has 0 WS sockets between hands /
   * before players connect, so the sweeper TTL exemption (in the room manager) is
   * the FIRST line of defense — this hook only fires when a room genuinely aborts.
   */
  async onRoomAborted(roomId: string): Promise<void> {
    // If THIS call claims ownership (r.done false→true) and then its disposition
    // FAILS, we must RELEASE the claim (r.done=false) in the catch — otherwise an
    // abort that grabbed ownership during a completion's self-heal-retry window and
    // then failed would strand the tournament (r.done claimed, no retry). Releasing
    // lets the pending completion retry (or boot recovery) reclaim.
    let claimed: RunningTournament | undefined;
    try {
      const tableId = this.roomToTable.get(roomId);
      if (!tableId) return; // not an MTT room we own
      const tournamentId = this.tableToTournament.get(tableId);
      if (!tournamentId) return;

      // ── ABORT-TIMING OWNERSHIP (Codex round 4) ────────────────────────────────
      // `r.done` is the SINGLE-OWNER token for a tournament's terminal disposition,
      // set SYNCHRONOUSLY (before any await) by whichever of {completeTournament,
      // this abort} reaches it first — the single-threaded event loop makes that
      // check-and-set atomic, so exactly one owner claims it. Orderings + owner:
      //   • abort BEFORE completion starts (r exists, !r.done): THIS abort claims
      //     r.done and OWNS disposition → resolve (settle/freeze/refund). A later
      //     completeTournament sees r.done and bails.
      //   • abort DURING completion's placement window (r.done ALREADY true, the
      //     champion-placement tx not yet committed): the COMPLETION pipeline owns it
      //     → we MUST NOT dispose. Disposing here would read the champion as unplaced
      //     (isTournamentFullyPlaced=false) and REFUND a DECIDED tournament, which
      //     completion then can't settle (settle treats 'cancelled' as terminal). Log
      //     + return. If completion later crashes, boot recovery's
      //     resolveOrphanedTournament settles/refunds the orphan correctly next boot.
      //   • abort AFTER settle (r.done true, already completed/cancelled): also owned
      //     → return early (resolve would be a terminal no-op anyway).
      //   • no in-memory record (r undefined — boot orphan / not this pod's
      //     tournament): safe to dispose via resolveOrphanedTournament (settles-if-
      //     finished; cancelAndRefundOrphan's under-lock re-check guards a placement
      //     that lands mid-refund).
      const r = this.running.get(tournamentId);
      if (r) {
        if (r.done) {
          console.warn(
            `[poker-mtt] mtt room ${roomId} abort IGNORED — tournament ${tournamentId} disposition already OWNED (r.done set by the completion pipeline or a prior abort); not disposing.`,
          );
          return;
        }
        // Claim disposition SYNCHRONOUSLY (no await between the r.done read above and
        // this set) so a racing completeTournament sees r.done and bails.
        r.done = true;
        claimed = r;
        for (const tb of r.tables.values()) {
          if (tb.handInFlight) {
            this.sim.stopTable(tb.tableId);
            tb.handInFlight = false;
          }
        }
      }

      // Resolve the money through the SAME decide logic as boot recovery
      // (resolveOrphanedTournament) so a room-abort can NEVER void a DECIDED
      // (fully-placed) tournament, nor let a malformed one escape the freeze via a
      // refund: settle-if-finished / freeze-if-malformed / refund-if-unfinished.
      // (Previously this UNCONDITIONALLY cancel+refunded — the same class of bug the
      // boot-recovery path fixed, at this second call site.)
      const res = await this.resolveOrphanedTournament(tournamentId);
      this.running.delete(tournamentId);
      const summary =
        res.action === 'settled'
          ? 'settled (prizes paid — decided result honored)'
          : res.action === 'frozen'
            ? 'left FROZEN (malformed placements — operator intervention required)'
            : `cancelled + ${res.refundedCount} entrant(s) refunded (escrow not stranded)`;
      console.warn(`[poker-mtt] mtt room ${roomId} aborted → tournament ${tournamentId} ${summary}.`);
    } catch (err) {
      // Release a claim THIS call made so it isn't stranded (a pending completion
      // self-heal retry or boot recovery can then reclaim). If we never claimed
      // (r undefined, or ownership was already held), there is nothing to release.
      if (claimed) claimed.done = false;
      console.error(`[poker-mtt] onRoomAborted handling failed for room ${roomId}:`, err);
    }
  }

  // ── Test / introspection helpers ─────────────────────────────────────────────

  /** Whether a tournament is still running an in-memory hand loop. */
  isRunning(tournamentId: string): boolean {
    const r = this.running.get(tournamentId);
    return !!r && !r.done;
  }

  /**
   * The live chip stacks across ALL tables (seatIndex → chips) for a single-table
   * tournament; for multi-table this returns the FIRST live table's stacks (kept
   * for single-table test compatibility). Use `getAllLiveStacks` for multi-table.
   */
  getLiveStacks(tournamentId: string): Map<number, number> {
    const r = this.running.get(tournamentId);
    const out = new Map<number, number>();
    if (!r) return out;
    const liveTables = [...r.tables.values()].filter((tb) => !tb.broken);
    // Single-table preserves the old (seatIndex → chips) shape from one table.
    const table = liveTables.sort((a, b) => a.tableNumber - b.tableNumber)[0];
    if (!table) return out;
    for (const s of table.liveSeats.values()) {
      if (s.chipStack > 0) out.set(s.seatIndex, s.chipStack);
    }
    return out;
  }

  /** All live chip stacks tournament-wide (avatarId → chips). Multi-table helper. */
  getAllLiveStacks(tournamentId: string): Map<string, number> {
    const r = this.running.get(tournamentId);
    const out = new Map<string, number>();
    if (!r) return out;
    for (const { seat } of this.allLiveSeats(r)) out.set(seat.avatarId, seat.chipStack);
    return out;
  }

  /** Sum of ALL chips across all live tables (chip-conservation invariant). */
  getTotalChips(tournamentId: string): number {
    const r = this.running.get(tournamentId);
    if (!r) return 0;
    let total = 0;
    for (const { seat } of this.allLiveSeats(r)) total += seat.chipStack;
    return total;
  }

  /** Number of live (non-broken) tables in a tournament. */
  getLiveTableCount(tournamentId: string): number {
    const r = this.running.get(tournamentId);
    if (!r) return 0;
    return [...r.tables.values()].filter((tb) => !tb.broken).length;
  }

  /** Per-table live counts (tableNumber → live seat count). Multi-table helper. */
  getTableSizes(tournamentId: string): Map<number, number> {
    const r = this.running.get(tournamentId);
    const out = new Map<number, number>();
    if (!r) return out;
    for (const tb of r.tables.values()) {
      if (tb.broken) continue;
      out.set(tb.tableNumber, this.tableLiveCount(tb));
    }
    return out;
  }

  /** The sim tableId of the first live table (single-table back-compat). */
  getTableId(tournamentId: string): string | undefined {
    const r = this.running.get(tournamentId);
    if (!r) return undefined;
    const table = [...r.tables.values()]
      .filter((tb) => !tb.broken)
      .sort((a, b) => a.tableNumber - b.tableNumber)[0];
    return table?.tableId;
  }

  /** All live sim tableIds for a tournament (multi-table). */
  getAllTableIds(tournamentId: string): string[] {
    const r = this.running.get(tournamentId);
    if (!r) return [];
    return [...r.tables.values()].filter((tb) => !tb.broken).map((tb) => tb.tableId);
  }

  /** The WS room binding for the first live table (single-table back-compat). */
  getRoomBinding(tournamentId: string): MttRoomBinding | null {
    const r = this.running.get(tournamentId);
    if (!r) return null;
    const table = [...r.tables.values()]
      .filter((tb) => !tb.broken)
      .sort((a, b) => a.tableNumber - b.tableNumber)[0];
    return table?.roomBinding ?? null;
  }

  /**
   * SOCKET-LESS AGENT PATH (P5) — resolve the sim `tableId` an avatar is CURRENTLY
   * seated at in this tournament. Works WITHOUT a WS room (unlike
   * `getConnectionForSubject`, which needs a `roomBinding`), so a hosted agent that
   * never opened a socket can still address its live hand. Returns null when the
   * tournament isn't running, the avatar isn't a live seat, or its table is broken.
   * Follows rebalances/table-breaks automatically (it reads the CURRENT liveSeats).
   */
  getActiveTableForAvatar(tournamentId: string, avatarId: string): string | null {
    const r = this.running.get(tournamentId);
    if (!r || r.done) return null;
    for (const table of r.tables.values()) {
      if (table.broken) continue;
      for (const seat of table.liveSeats.values()) {
        if (seat.avatarId === avatarId) return table.tableId;
      }
    }
    return null;
  }

  /**
   * SOCKET-LESS AGENT READ — the poll view for `avatarId` in `tournamentId`
   * (public table + its OWN hole cards + legal actions + isYourTurn + deadline).
   * Pure read; never mutates state, never leaks another seat's cards (the sim
   * enforces the redaction). Returns null when the avatar isn't seated at a live
   * hand. The agent polls this until `isYourTurn === true`, then calls
   * `applyAgentAction`.
   */
  getSeatViewForAgent(tournamentId: string, avatarId: string): AgentSeatView | null {
    const tableId = this.getActiveTableForAvatar(tournamentId, avatarId);
    if (!tableId) return null;
    return this.sim.getSeatViewForAgent(tableId, avatarId);
  }

  /**
   * ADVISOR MODE (non-staking) — a recommended action for `avatarId` WITHOUT
   * moving chips. Forwards to the sim's pure `getActionAdvice`. Returns null when
   * the avatar isn't seated at a live hand. Allowed even when the avatar is
   * human-CONTROLLED (advice never stakes — the human chooses to follow or ignore).
   */
  getActionAdvice(tournamentId: string, avatarId: string): AgentActionAdvice | null {
    const tableId = this.getActiveTableForAvatar(tournamentId, avatarId);
    if (!tableId) return null;
    return this.sim.getActionAdvice(tableId, avatarId);
  }

  /**
   * SOCKET-LESS BETTING ACTION (P5) — submit ONE action for `avatarId` over REST.
   * This is the SAME settlement path the WS hub uses: it resolves the avatar's live
   * sim table and calls `sim.applyAction(tableId, avatarId, action, { idempotencyKey })`.
   * The TM already registered `setHandCompleteFn` on this sim at construction, so an
   * action that ends a hand drives the exact same chip-apply / bust / placement /
   * settle loop a WS action would — settlement binds to the bound avatar (real CT),
   * NEVER a guest. Idempotent on `idempotencyKey` (the route builds
   * `<handNumber>:<actionSeq>:<avatarId>`), so a retransmit is a stable no-op.
   *
   * CONTROLLED-MODE SUPPRESSION (Rule E5 advisor/controlled split): when the
   * avatar is human-CONTROLLED (`actor === 'agent'` AND in `controlledAvatars`),
   * the autonomous bet is REJECTED — the human at the wheel owns the betting
   * decision. The agent should use `getActionAdvice` (advisor mode) instead. A
   * `actor === 'human'` action (the human driving the seat) is NEVER suppressed.
   *
   * Returns a discriminated result: `{ ok:false, reason:'no_live_table' }` when the
   * avatar isn't seated; `{ ok:false, reason:'human_controlled' }` when suppressed;
   * otherwise the sim's `ApplyActionResult` (which itself carries ok/reason for
   * not_your_turn / illegal_action / hand_over etc.).
   */
  applyAgentAction(input: {
    tournamentId: string;
    avatarId: string;
    action: Action;
    idempotencyKey: string;
    /** 'agent' = autonomous (suppressed when controlled); 'human' = the driver. */
    actor: 'agent' | 'human';
  }): ApplyActionResult {
    const { tournamentId, avatarId, action, idempotencyKey, actor } = input;
    if (actor === 'agent' && this.controlledAvatars.has(avatarId)) {
      return { ok: false, reason: 'human_controlled' };
    }
    const tableId = this.getActiveTableForAvatar(tournamentId, avatarId);
    if (!tableId) return { ok: false, reason: 'no_live_table' };
    return this.sim.applyAction(tableId, avatarId, action, { idempotencyKey });
  }

  /**
   * CONTROLLED-MODE seam — mark/unmark an avatar as human-DRIVEN so its autonomous
   * poker betting is suppressed (the human's input is authoritative). Mirrors the
   * `humanControlled*` flag in npc-simulation, scoped here to poker seats. Idempotent.
   */
  setAvatarControlled(avatarId: string, controlled: boolean): void {
    if (controlled) this.controlledAvatars.add(avatarId);
    else this.controlledAvatars.delete(avatarId);
  }

  /** True iff the avatar's poker seat is currently human-controlled. */
  isAvatarControlled(avatarId: string): boolean {
    return this.controlledAvatars.has(avatarId);
  }

  /** Translate a WS `roomId` to its sim `tableId`. */
  resolveRoomToTable(roomId: string): string | undefined {
    return this.roomToTable.get(roomId);
  }

  /** Translate a sim `tableId` to its WS `roomId`. */
  resolveTableToRoom(tableId: string): string | undefined {
    return this.tableToRoom.get(tableId);
  }

  /** Wire the WS-room seam onto the production singleton (filled-once setter). */
  setSeatHandlers(handlers: {
    onSeatFn?: TournamentManagerDeps['onSeatFn'];
    onTournamentEndFn?: TournamentManagerDeps['onTournamentEndFn'];
    onMoveFn?: TournamentManagerDeps['onMoveFn'];
  }): void {
    if (this.onSeatFn === null && handlers.onSeatFn) {
      this.onSeatFn = handlers.onSeatFn;
    }
    if (this.onTournamentEndFn === null && handlers.onTournamentEndFn) {
      this.onTournamentEndFn = handlers.onTournamentEndFn;
    }
    if (this.onMoveFn === null && handlers.onMoveFn) {
      this.onMoveFn = handlers.onMoveFn;
    }
  }

  /**
   * CONNECT PATH — the connection ticket a registered+seated subject opens its WS
   * with. Resolves the subject's CURRENT table (it may have been rebalanced).
   * Returns null when not seated / no room / busted.
   */
  getConnectionForSubject(
    tournamentId: string,
    avatarId: string,
  ): MttConnectionInfo | null {
    const r = this.running.get(tournamentId);
    if (!r || r.done) return null;
    for (const table of r.tables.values()) {
      if (table.broken || !table.roomBinding) continue;
      const seat = [...table.liveSeats.values()].find((s) => s.avatarId === avatarId);
      if (seat) {
        return {
          roomId: table.roomBinding.roomId,
          shortCode: table.roomBinding.shortCode,
          seatIndex: seat.seatIndex,
          activityId: table.roomBinding.activityId,
        };
      }
    }
    return null;
  }
}

// ── Internal seating plan types ──────────────────────────────────────────────

interface SeatedTablePlan {
  tableNumber: number;
  dbTableId: string;
  seats: LiveSeat[];
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** One busted seat + its assigned placement, returned by computeBustPlacements. */
export interface BustPlacement {
  seatIndex: number;
  placement: number;
}

/**
 * Pure same-hand multi-bust placement assignment (see P3 doc). The busted group
 * fills placements (remainingAfter + bustedCount) DOWN to (remainingAfter + 1);
 * within the group the seat that STARTED with MORE chips gets the BETTER
 * placement; ties broken by seatIndex ascending.
 */
export function computeBustPlacements(
  busted: Array<{ seatIndex: number; chipAtHandStart: number }>,
  remainingAfter: number,
): BustPlacement[] {
  const sorted = busted.slice().sort((a, b) => {
    if (a.chipAtHandStart !== b.chipAtHandStart) {
      return a.chipAtHandStart - b.chipAtHandStart;
    }
    return a.seatIndex - b.seatIndex;
  });
  const out: BustPlacement[] = [];
  let placeCursor = remainingAfter + sorted.length;
  for (const s of sorted) {
    out.push({ seatIndex: s.seatIndex, placement: placeCursor });
    placeCursor -= 1;
  }
  return out;
}

/**
 * Compute integer CT prizes per placement from a payout curve against the net
 * (post-rake) pool. Floors each share; the caller folds the rounding remainder
 * into 1st place so the sum equals `netPool` exactly (conservation).
 */
export function computePrizes(
  netPool: bigint,
  curve: PayoutCurveEntry[],
): Map<number, bigint> {
  const out = new Map<number, bigint>();
  if (netPool <= 0n || curve.length === 0) return out;
  const totalShare = curve.reduce((acc, c) => acc + (c.share > 0 ? c.share : 0), 0);
  if (totalShare <= 0) return out;
  for (const c of curve) {
    if (c.share <= 0) continue;
    const frac = c.share / totalShare;
    const scaled = (netPool * BigInt(Math.floor(frac * 1e9))) / BigInt(1e9);
    out.set(c.placement, (out.get(c.placement) ?? 0n) + scaled);
  }
  return out;
}

/**
 * Strictly coerce a CT amount (number | bigint | decimal string) to a non-negative
 * bigint. Rejects fractions, NaN, Infinity, negatives, and non-integer strings — a
 * money field must be an exact atomic integer. Throws TournamentError 400 on bad input.
 */
export function toBigIntStrict(value: number | bigint | string, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new TournamentError(`invalid_${field}`, 400);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new TournamentError(`invalid_${field}`, 400);
    return BigInt(value);
  }
  const s = value.trim();
  if (!/^\d+$/.test(s)) throw new TournamentError(`invalid_${field}`, 400);
  return BigInt(s);
}

/**
 * Validate a payout curve for a CREATED tournament. Each entry must have an integer
 * placement ≥ 1 and a finite share > 0; placements must be unique; the curve must be
 * non-empty and have at least a 1st-place entry; total share must be sane (> 0). The
 * settle path normalizes shares to sum-to-1 + folds the rounding remainder into 1st,
 * so the shares need NOT pre-sum to 1 — but a curve with no positive share, a missing
 * 1st place, a duplicate, or a non-positive/garbage entry would mis-pay, so reject it.
 */
export function validatePayoutCurve(curve: PayoutCurveEntry[]): void {
  if (!Array.isArray(curve) || curve.length === 0) {
    throw new TournamentError('invalid_payout_curve_empty', 400);
  }
  const seen = new Set<number>();
  let total = 0;
  let hasFirst = false;
  for (const c of curve) {
    if (
      !c ||
      !Number.isInteger(c.placement) ||
      c.placement < 1 ||
      typeof c.share !== 'number' ||
      !Number.isFinite(c.share) ||
      c.share <= 0
    ) {
      throw new TournamentError('invalid_payout_curve_entry', 400);
    }
    if (seen.has(c.placement)) {
      throw new TournamentError('invalid_payout_curve_duplicate_placement', 400);
    }
    seen.add(c.placement);
    if (c.placement === 1) hasFirst = true;
    total += c.share;
  }
  if (!hasFirst) throw new TournamentError('invalid_payout_curve_missing_first', 400);
  if (total <= 0) throw new TournamentError('invalid_payout_curve_zero_total', 400);
}

/** Placeholder commit-hash: the sim already revealed the seed; we store its hash. */
function sha256OrPlaceholder(serverSeed: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('crypto') as typeof import('crypto');
    return createHash('sha256').update(serverSeed).digest('hex');
  } catch {
    return serverSeed.slice(0, 64);
  }
}

export class TournamentError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'TournamentError';
  }
}

// ── Default blind schedule (8 rising levels) ──────────────────────────────────

export const DEFAULT_BLIND_SCHEDULE: BlindLevel[] = [
  { level: 1, sb: 10, bb: 20, ante: 0, durationSec: 300 },
  { level: 2, sb: 15, bb: 30, ante: 0, durationSec: 300 },
  { level: 3, sb: 25, bb: 50, ante: 0, durationSec: 300 },
  { level: 4, sb: 50, bb: 100, ante: 10, durationSec: 300 },
  { level: 5, sb: 75, bb: 150, ante: 15, durationSec: 300 },
  { level: 6, sb: 100, bb: 200, ante: 25, durationSec: 300 },
  { level: 7, sb: 150, bb: 300, ante: 25, durationSec: 300 },
  { level: 8, sb: 250, bb: 500, ante: 50, durationSec: 300 },
];

/** Default payout curve for a 9-max single table: top 3 paid (50/30/20). */
export const DEFAULT_PAYOUT_CURVE: PayoutCurveEntry[] = [
  { placement: 1, share: 0.5 },
  { placement: 2, share: 0.3 },
  { placement: 3, share: 0.2 },
];

/** The process-wide TournamentManager (production singleton, real db + ledger + sim). */
export const tournamentManager = new TournamentManager();
