/**
 * Poker MTT (P3) — single-table TournamentManager.
 *
 * Sits ABOVE `PokerTableSim` (the per-hand betting driver). The sim plays ONE
 * hand then fires `handCompleteFn(tableId, HandResult)`. Everything between
 * hands — applying chip deltas, detecting busts, assigning placement, rotating
 * the button, advancing the blind level, and starting the NEXT hand until one
 * entrant remains — is NET-NEW and lives here.
 *
 * ── RESPONSIBILITIES ─────────────────────────────────────────────────────────
 *   - registerEntrant: agent-capable subject (user|agent, NEVER bot) buys in;
 *     CT debited into the prize-pool accounting; entrant row inserted; idempotent
 *     (a second register of the same (tournament, avatar) is a no-op replay).
 *   - startTrigger: when registration closes OR the cap is hit, either SEAT the
 *     field (→ running) or, if entrants < minEntrants, CANCEL + refund every
 *     buy-in (idempotent). The seating path also drives the FIRST hand.
 *   - the multi-hand loop (handCompleteFn): the heart of the engine. Per hand:
 *     apply HandResult chip deltas to entrant.chipStack, detect busts (stack 0),
 *     assign placement = (live-remaining + 1) with same-hand multi-bust ties
 *     broken by chip-at-hand-start (more chips ⇒ better placement), rotate the
 *     button among live seats, advance the blind level if its timer elapsed, then
 *     startHand the next hand with the live seats — until ONE entrant remains
 *     (champion = placement 1).
 *   - settle: compute prizeCt per placement from payoutCurveJson against
 *     (prizePoolCt − rake), write poker_tournament_results, credit via the
 *     ledger — ALL idempotent under a poker_tournaments FOR UPDATE row lock
 *     (settledAt anchor), conserving CT exactly. Then feed placements to the
 *     leaderboard via the reward-pipeline path.
 *
 * ── MONEY (LOCKED) ───────────────────────────────────────────────────────────
 * Tournament CHIPS are NOT CT. Only the buy-in DEBIT (register) and the prize
 * CREDIT (settle) cross `claw-token-ledger`. Refund on cancel CREDITs back.
 * Conservation: sum(prizes) + rakeTaken == prizePoolCt; cancel refunds net 0.
 *
 * ── DETERMINISM / TESTABILITY ────────────────────────────────────────────────
 * The sim clock + per-hand seeds are injectable. Tests construct a
 * `TournamentManager` with a fake clock + a deterministic `seedFn`, mock the DB +
 * ledger, and drive a full sit-n-go end-to-end with scripted actions.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  db as realDb,
  avatars,
  pokerTournaments,
  pokerTournamentEntrants,
  pokerTables,
  pokerBlindSchedules,
  pokerHands,
  pokerTournamentResults,
  type PokerTournament,
  type BlindLevel,
  type PayoutCurveEntry,
} from '@clawville/database';
import * as ledgerModule from '../claw-token-ledger';
import { logEvent, ACTIVITY_EVENT_TYPES } from '../event-logger';
import type { ActivityMatchPlacedPayload } from '../event-logger';
import type {
  creditClawTokens as CreditFn,
  debitClawTokens as DebitFn,
  transferClawTokens as TransferFn,
} from '../claw-token-ledger';
import { createServerSeed } from '../provable-rng';
import { PokerTableSim } from './poker-table-sim';
import { pokerMttSim } from './poker-mtt-sim-singleton';
import type {
  HandResult,
  SeatAssignment,
  SimClock,
} from './poker-table-types';
import { REAL_CLOCK } from './poker-table-types';

// ── Injectable seams (tests override db / ledger / sim clock) ────────────────

type DbLike = typeof realDb;
type LedgerLike = {
  debitClawTokens: typeof DebitFn;
  creditClawTokens: typeof CreditFn;
  transferClawTokens: typeof TransferFn;
};

/** A connected/hosted-agent-capable registration subject (Rule E5 parity). */
export type RegisterSubject =
  | { kind: 'user'; userId: string; avatarId: string; agentId: null }
  | { kind: 'agent'; userId: string; avatarId: string; agentId: string };

export interface TournamentManagerDeps {
  db?: DbLike;
  ledger?: LedgerLike;
  /**
   * The table sim that plays each hand. Defaults to the DEDICATED MTT sim
   * instance (`pokerMttSim`), NOT the WS-demo `pokerTableSim` singleton — see
   * poker-mtt-sim-singleton.ts for why they MUST be separate (callback-clobber).
   */
  sim?: PokerTableSim;
  /** Clock for the TM's blind-level timer + settle timestamps. */
  clock?: SimClock;
  /** Per-hand commit-reveal server seed factory (64-hex). Injected for determinism. */
  seedFn?: () => string;
  /**
   * Leaderboard placement-emit seam. Defaults to a real `logEvent`
   * `activity.match.placed` per placed entrant (drives `activity.match.placed`
   * scoring for BOTH human + agent — Rule E5 parity). Injected by tests so they
   * can assert the emissions WITHOUT hitting the real events DB (the global
   * `logEvent` writes to the real `db`, not the injected mock).
   */
  emitPlacementFn?: (emit: PlacementEmit) => void | Promise<void>;
  /**
   * P3.5 WS-ROOM SEAM (optional). Called ONCE per tournament at seating, BEFORE
   * the first hand starts, with the seat plan. The production bridge
   * (`poker-mtt-ws-bridge.ts`) creates ONE LONG-LIVED `texas-holdem-mtt` activity
   * room (NOT one room per hand) and returns its `{ roomId, shortCode }` so seated
   * subjects can connect over WS and the bridge can fan sim frames out to the
   * room. The TM stores the binding and exposes it via `getConnectionForSubject`.
   *
   * Unset (the unit-test path) ⇒ no WS room; the TM drives the sim directly and
   * the multi-hand loop still runs to a champion. Returning `null` is equivalent.
   * A throw here MUST NOT strand the seated field — the TM logs + proceeds without
   * the room (hands still play; only the live transport is missing).
   */
  onSeatFn?: (info: {
    tournamentId: string;
    tableId: string;
    seats: MttSeatPlan[];
  }) => Promise<MttRoomBinding | null> | MttRoomBinding | null;
  /**
   * P3.5 WS-ROOM teardown seam (optional). Called ONCE when a tournament
   * completes (champion crowned) so the bridge can transition the long-lived
   * room → `results`. Best-effort: a throw is logged and never blocks settlement.
   */
  onTournamentEndFn?: (info: {
    tournamentId: string;
    tableId: string;
    roomId: string;
  }) => Promise<void> | void;
}

/** One leaderboard placement emission (one per placed entrant at settle). */
export interface PlacementEmit {
  tournamentId: string;
  avatarId: string;
  agentId: string | null;
  placement: number;
  prizeCt: string;
  subjectType: 'human' | 'agent';
}

/**
 * One seat in the live tournament table, as handed to the WS-room seam at
 * seating. Carries everything the room/hub need to bind a connection to a seat
 * (avatarId + agent parity) WITHOUT the TM importing the room manager.
 */
export interface MttSeatPlan {
  seatIndex: number;
  avatarId: string;
  agentId: string | null;
  subjectType: 'human' | 'agent';
}

/**
 * The WS-room binding returned by `onSeatFn` (the production bridge). The TM is
 * agnostic to HOW the room is made — it only stores the binding so a seated
 * subject can later learn `{ roomId, shortCode, seatIndex }` to open its WS, and
 * so the bridge can translate the sim `tableId` ↔ `roomId` for frame fan-out.
 *
 * `null` = no WS room was created (the unit-test path, which drives the sim
 * directly and never opens a socket). Hand play still proceeds; only the live
 * transport is absent.
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
 * window has closed. The sweeper is the LIVE path that seats/cancels a field:
 * without it (or a cap-hit auto-trigger) a registered tournament could never
 * play, settle, or refund — buy-ins would stay escrowed forever.
 */
const START_TRIGGER_SWEEP_INTERVAL_MS = 15_000;
/**
 * The `activityId` tag on `activity.match.placed` events the TM emits at settle.
 * The leaderboard SQL does NOT filter by activityId (it filters by event_type +
 * placement + subjectType<>'bot'), so any stable id works; this one identifies
 * MTT placements in the events table for `/dash` + audit.
 */
const POKER_MTT_ACTIVITY_ID = 'poker-mtt';

export interface RegisterResult {
  entrantId: string;
  prizePoolCt: string;
  alreadyRegistered: boolean;
  /**
   * True when THIS registration filled the last seat (entrants == maxEntrants).
   * The route fires `startTrigger(force:true)` so a full field seats immediately
   * instead of waiting for the window-close sweep. Always false on an idempotent
   * replay (the cap was already counted).
   */
  capReached: boolean;
}

export interface StartResult {
  status: 'running' | 'cancelled' | 'noop';
  seatedCount: number;
  refundedCount: number;
}

export interface SettleResult {
  alreadySettled: boolean;
  rakeTakenCt: string;
  results: Array<{ avatarId: string; agentId: string | null; placement: number; prizeCt: string }>;
}

/** A live in-memory per-tournament driver: tracks live seats + blind level + clock. */
interface RunningTournament {
  tournamentId: string;
  tableId: string;
  serverDbTableId: string;
  /**
   * P3.5 — the long-lived `texas-holdem-mtt` WS room bound to this table, or null
   * when no room seam is wired (unit-test path). Set once at seating from
   * `onSeatFn`; used to expose connection info + drive the room → `results`
   * teardown at completion.
   */
  roomBinding: MttRoomBinding | null;
  blindLevels: BlindLevel[];
  /** index into blindLevels for the level applied to the NEXT hand. */
  currentLevelIndex: number;
  /** wall-clock ms when the current level started (advance when durationSec elapses). */
  levelStartedMs: number;
  buttonSeatIndex: number;
  handNumber: number;
  turnClockMs: number;
  agentTurnGraceMs: number;
  clientSeed: string;
  /** seatIndex → live entrant snapshot (chips + identity). Busted seats removed. */
  liveSeats: Map<number, LiveSeat>;
  /** chip count at the START of the in-flight hand, by seatIndex (tie-break key on bust). */
  chipAtHandStart: Map<number, number>;
  /** Resolved when the tournament completes (champion crowned + settled) or cancels. */
  done: boolean;
  /** Optional async hook fired after each settled hand (DB checkpoint). */
  onHandSettled?: (r: HandResult) => Promise<void> | void;
}

interface LiveSeat {
  seatIndex: number;
  avatarId: string;
  agentId: string | null;
  name: string;
  subjectType: 'human' | 'agent';
  chipStack: number;
}

export class TournamentManager {
  private readonly db: DbLike;
  private readonly ledger: LedgerLike;
  private readonly sim: PokerTableSim;
  private readonly clock: SimClock;
  private readonly seedFn: () => string;
  private readonly emitPlacementFn: (emit: PlacementEmit) => void | Promise<void>;
  // Mutable so the production singleton (constructed at module load with no deps)
  // can have its WS-room seam wired LATER by the bridge via `setSeatHandlers`.
  // Tests inject them at construction via deps.
  private onSeatFn:
    | ((info: {
        tournamentId: string;
        tableId: string;
        seats: MttSeatPlan[];
      }) => Promise<MttRoomBinding | null> | MttRoomBinding | null)
    | null;
  private onTournamentEndFn:
    | ((info: {
        tournamentId: string;
        tableId: string;
        roomId: string;
      }) => Promise<void> | void)
    | null;

  /** tableId → running tournament driver (single table this phase). */
  private readonly running = new Map<string, RunningTournament>();
  /** tournamentId → tableId (so completion lookups are O(1)). */
  private readonly tableByTournament = new Map<string, string>();
  /**
   * P3.5 — WS room id → sim tableId. The hub addresses connections by `roomId`
   * (a UUID) but the MTT sim is keyed by `mtt:<tournamentId>`; the bridge reads
   * this to translate an inbound `poker.action` on a room into the sim table. Set
   * at seating, cleared at completion teardown.
   */
  private readonly roomToTable = new Map<string, string>();
  /**
   * P3.5 — sim tableId → WS room id (reverse of `roomToTable`). The bridge's
   * sim-callback fan-out (`setBroadcastFn`/`setSendToSeatFn`/`setShowdownBroadcastFn`)
   * is invoked with the sim `tableId` and must address the hub by `roomId`.
   */
  private readonly tableToRoom = new Map<string, string>();
  /** The start-trigger sweeper interval handle (null when not running). */
  private sweeperHandle: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard so overlapping sweeps don't double-fire a startTrigger. */
  private sweepInFlight = false;

  constructor(deps: TournamentManagerDeps = {}) {
    this.db = deps.db ?? realDb;
    // Build the default ledger lazily from the module namespace so a test that
    // partially mocks `claw-token-ledger` (e.g. exporting only creditClawTokens)
    // doesn't break this module's load — the real functions are only touched when
    // no `deps.ledger` is injected (i.e. production).
    this.ledger = deps.ledger ?? {
      debitClawTokens: (...args) => ledgerModule.debitClawTokens(...args),
      creditClawTokens: (...args) => ledgerModule.creditClawTokens(...args),
      transferClawTokens: (...args) => ledgerModule.transferClawTokens(...args),
    };
    this.sim = deps.sim ?? pokerMttSim;
    this.clock = deps.clock ?? REAL_CLOCK;
    // createServerSeed() returns { serverSeed, serverSeedHash }; the sim takes the
    // raw 64-hex serverSeed and commits its own hash internally.
    this.seedFn = deps.seedFn ?? (() => createServerSeed().serverSeed);
    // Default placement emit → a real `activity.match.placed` per placed entrant
    // so the free-agent leaderboard credits MTT placements for BOTH human + agent
    // (Rule E5 parity). Tests inject a recorder to avoid the real events DB.
    this.emitPlacementFn =
      deps.emitPlacementFn ??
      ((emit: PlacementEmit) => {
        void logEvent({
          eventType: ACTIVITY_EVENT_TYPES.MATCH_PLACED,
          avatarId: emit.avatarId,
          agentId: emit.agentId,
          payload: {
            activityId: POKER_MTT_ACTIVITY_ID,
            roomId: `mtt:${emit.tournamentId}`,
            placement: emit.placement,
            // MTT placement carries no per-match "score" metric — 0 is fine; the
            // leaderboard scores off `placement`, not `score`.
            score: 0,
            // CT settlement is handled by the ledger credit in settleTournament;
            // the leaderboard event reports the prize for observability only.
            tokensAwarded: Number(emit.prizeCt),
            leaderboardPoints: 0,
            subjectType: emit.subjectType,
          } satisfies ActivityMatchPlacedPayload,
        });
      });
    this.onSeatFn = deps.onSeatFn ?? null;
    this.onTournamentEndFn = deps.onTournamentEndFn ?? null;

    // The TM EXCLUSIVELY owns the hand-complete handler on ITS sim instance.
    // In production that instance is the DEDICATED `pokerMttSim` (NOT the WS-demo
    // `pokerTableSim` singleton), so this setter can never be clobbered by — nor
    // clobber — index.ts's demo `setHandCompleteFn` on the singleton. (Before the
    // P3 fix the TM shared the singleton, and index.ts's boot wiring overwrote
    // this handler, stranding every MTT buy-in in escrow forever — see
    // poker-mtt-sim-singleton.ts.)
    this.sim.setHandCompleteFn((tableId, result) => {
      void this.onHandComplete(tableId, result);
    });
  }

  // ── Registration ────────────────────────────────────────────────────────────

  /**
   * Register a subject into a tournament. Debits the buy-in into the prize-pool
   * accounting and inserts an entrant row, atomically, under the tournament FOR
   * UPDATE row lock. Idempotent on (tournamentId, avatarId): a re-register
   * replays the existing entrant without a second debit.
   *
   * Rejects (HTTP-mappable Error) when: tournament missing; not in 'registering';
   * registration window closed; cap reached.
   */
  async registerEntrant(
    subject: RegisterSubject,
    tournamentId: string,
  ): Promise<RegisterResult> {
    return this.db.transaction(async (tx) => {
      // Lock the tournament row so concurrent registers serialize on the cap +
      // pool accumulator (no oversell, no double-counted pool).
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

      // Idempotent replay: an existing entrant returns its row with NO 2nd debit.
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

      // Cap check under the lock.
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

      // Debit the buy-in (the ONLY CT movement at registration). The prize pool
      // is an accounting bucket, not an avatar, so we DEBIT the subject's avatar
      // and accumulate `prize_pool_ct` on the tournament row in the same tx — the
      // pool's escrow lives on the row, conserved against the eventual credits.
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

      // `subject.kind` is 'user' | 'agent', but the `subject_type` CHECK
      // constraint is `in ('human','agent')` (poker.ts) — map 'user' → 'human'
      // so a HUMAN INSERT is not rejected with a check_violation. (The read-side
      // already normalizes 'agent'/else → 'human' at startTrigger.)
      const subjectType = subject.kind === 'agent' ? 'agent' : 'human';
      const insRows = await tx.execute<{ id: string }>(
        sql`INSERT INTO poker_tournament_entrants
              (tournament_id, avatar_id, agent_id, subject_type, buy_in_paid_ct, status)
            VALUES (${tournamentId}, ${subject.avatarId}, ${subject.agentId},
                    ${subjectType}, ${buyIn.toString()}, 'registered')
            RETURNING id`,
      );

      // `filled` was the pre-insert non-refunded count; this insert makes it
      // `filled + 1`. The cap is hit when that equals max_entrants.
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
   * field, flip to 'running', and drive the first hand. If entrants < minEntrants
   * (and the window closed or `force`) → cancel + refund every buy-in. Idempotent:
   * a tournament already 'running'/'completed'/'cancelled' is a no-op.
   *
   * `force` skips the registration-window check (used when the cap is hit or an
   * admin starts early).
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
        // Window still open and not forced — nothing to do yet.
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
        // CANCEL + refund. Refund every non-refunded entrant's PAID buy-in.
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

      // SEAT. Assign seat indices 0..N-1 in registration order, create the table
      // row, mark entrants seated with the starting stack.
      const blindRows = await tx.execute<{ levels_json: unknown }>(
        sql`SELECT levels_json FROM poker_blind_schedules WHERE id = ${t.blind_schedule_id}`,
      );
      const blindLevels = (blindRows[0]?.levels_json as BlindLevel[] | undefined) ?? [];
      if (blindLevels.length === 0) {
        throw new TournamentError('blind_schedule_empty', 500);
      }

      const tableRows = await tx.execute<{ id: string }>(
        sql`INSERT INTO poker_tables (tournament_id, table_number, status, button_seat_index, hand_count)
            VALUES (${tournamentId}, 1, 'live', 0, 0)
            RETURNING id`,
      );
      const dbTableId = tableRows[0]!.id;

      const seats: LiveSeat[] = [];
      for (let i = 0; i < entrantRows.length; i++) {
        const e = entrantRows[i]!;
        seats.push({
          seatIndex: i,
          avatarId: e.avatar_id,
          agentId: e.agent_id,
          name: e.avatar_id,
          subjectType: e.subject_type === 'agent' ? 'agent' : 'human',
          chipStack: t.starting_stack,
        });
        await tx.execute(
          sql`UPDATE poker_tournament_entrants
              SET status = 'seated', chip_stack = ${t.starting_stack},
                  current_table_id = ${dbTableId}, seat_index = ${i}
              WHERE id = ${e.id}`,
        );
      }

      await tx.execute(
        sql`UPDATE poker_tournaments SET status = 'running', started_at = now()
            WHERE id = ${tournamentId}`,
      );

      return {
        kind: 'seated' as const,
        dbTableId,
        startingStack: t.starting_stack,
        blindLevels,
        seats,
      };
    });

    if (decision.kind === 'noop') {
      return { status: 'noop', seatedCount: 0, refundedCount: 0 };
    }
    if (decision.kind === 'cancelled') {
      return { status: 'cancelled', seatedCount: 0, refundedCount: decision.refundedCount };
    }

    // Phase 2 (outside the tx): build the in-memory driver + start the first hand.
    const tableId = `mtt:${tournamentId}`;

    // P3.5 — create the LONG-LIVED WS room for this table BEFORE hand 1 so a
    // connected seat can already be authed when the first frames fly. The seam is
    // optional (unit tests pass no `onSeatFn` → null binding → no WS). A throw
    // MUST NOT strand the seated field: hands still play; only live transport is
    // lost — so we swallow + proceed with a null binding.
    let roomBinding: MttRoomBinding | null = null;
    if (this.onSeatFn) {
      try {
        const seatPlan: MttSeatPlan[] = decision.seats
          .slice()
          .sort((a, b) => a.seatIndex - b.seatIndex)
          .map((s) => ({
            seatIndex: s.seatIndex,
            avatarId: s.avatarId,
            agentId: s.agentId,
            subjectType: s.subjectType,
          }));
        roomBinding = await this.onSeatFn({ tournamentId, tableId, seats: seatPlan });
      } catch (err) {
        console.error(
          `[poker-mtt] onSeatFn (WS room creation) failed for tournament ${tournamentId} — playing WITHOUT a live WS room:`,
          err,
        );
        roomBinding = null;
      }
    }

    const running: RunningTournament = {
      tournamentId,
      tableId,
      serverDbTableId: decision.dbTableId,
      roomBinding,
      blindLevels: decision.blindLevels,
      currentLevelIndex: 0,
      levelStartedMs: this.clock.now(),
      buttonSeatIndex: decision.seats[0]!.seatIndex,
      handNumber: 0,
      turnClockMs: DEFAULT_TURN_CLOCK_MS,
      agentTurnGraceMs: DEFAULT_AGENT_TURN_GRACE_MS,
      clientSeed: DEFAULT_CLIENT_SEED,
      liveSeats: new Map(decision.seats.map((s) => [s.seatIndex, s])),
      chipAtHandStart: new Map(),
      done: false,
    };
    this.running.set(tableId, running);
    this.tableByTournament.set(tournamentId, tableId);
    if (roomBinding) {
      this.roomToTable.set(roomBinding.roomId, tableId);
      this.tableToRoom.set(tableId, roomBinding.roomId);
    }

    this.startNextHand(running);

    return { status: 'running', seatedCount: decision.seats.length, refundedCount: 0 };
  }

  // ── Start-trigger sweeper (the LIVE seat/cancel path) ────────────────────────

  /**
   * Begin the periodic start-trigger sweep. This is THE live path that turns a
   * registered field into a seated+playing (or cancelled+refunded) tournament:
   * without it (and the cap-hit auto-trigger in the route), a registered
   * tournament would never seat, play, settle, or refund — escrowed buy-ins would
   * be stuck forever. Idempotent: a second call is a no-op. Started once at boot.
   */
  startStartTriggerSweeper(): void {
    if (this.sweeperHandle) return;
    this.sweeperHandle = setInterval(() => {
      void this.sweepStartTriggers();
    }, START_TRIGGER_SWEEP_INTERVAL_MS);
  }

  /** Stop the sweeper (graceful SIGTERM). */
  stopStartTriggerSweeper(): void {
    if (this.sweeperHandle) {
      clearInterval(this.sweeperHandle);
      this.sweeperHandle = null;
    }
  }

  /**
   * Scan for tournaments whose registration window has CLOSED but whose status is
   * still 'registering'/'seating', and fire `startTrigger` for each — seating the
   * field (≥ minEntrants) or cancelling+refunding (< minEntrants). Re-entrancy is
   * guarded so an overlapping/slow sweep can't double-drive a tournament (the
   * startTrigger row lock is the cross-process authority; this guard is the
   * in-process one). A failure on one tournament is logged and does NOT abort the
   * rest of the sweep.
   *
   * Public so a test (or an admin endpoint) can drive a single sweep directly.
   */
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

  /** Start the next hand for a running tournament with the current live seats. */
  private startNextHand(r: RunningTournament): void {
    if (r.done) return;
    const live = [...r.liveSeats.values()].filter((s) => s.chipStack > 0);
    if (live.length <= 1) {
      // One entrant remains → champion. (Should be handled in onHandComplete, but
      // be defensive: never start a hand with < 2 funded seats.)
      void this.completeTournament(r);
      return;
    }

    // Advance the blind level if the current level's timer has elapsed.
    this.maybeAdvanceBlindLevel(r);
    const level = r.blindLevels[r.currentLevelIndex]!;

    r.handNumber += 1;
    // Snapshot chip-at-hand-start for same-hand multi-bust tie-breaking.
    r.chipAtHandStart = new Map(live.map((s) => [s.seatIndex, s.chipStack]));

    // Button must be a live seat; if the previous button busted, the rotation in
    // onHandComplete already moved it to the next live seat.
    const buttonSeatIndex = this.normalizeButton(r, live);
    r.buttonSeatIndex = buttonSeatIndex;

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

    this.sim.startHand({
      tableId: r.tableId,
      handNumber: r.handNumber,
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
  private normalizeButton(r: RunningTournament, live: LiveSeat[]): number {
    const liveIdx = live.map((s) => s.seatIndex).sort((a, b) => a - b);
    if (liveIdx.includes(r.buttonSeatIndex)) return r.buttonSeatIndex;
    // Next live seat clockwise from the (now-busted) button position.
    for (const idx of liveIdx) {
      if (idx > r.buttonSeatIndex) return idx;
    }
    return liveIdx[0]!;
  }

  /** Rotate the button to the next live seat clockwise (called after a hand settles). */
  private rotateButton(r: RunningTournament): void {
    const liveIdx = [...r.liveSeats.values()]
      .filter((s) => s.chipStack > 0)
      .map((s) => s.seatIndex)
      .sort((a, b) => a - b);
    if (liveIdx.length === 0) return;
    for (const idx of liveIdx) {
      if (idx > r.buttonSeatIndex) {
        r.buttonSeatIndex = idx;
        return;
      }
    }
    r.buttonSeatIndex = liveIdx[0]!;
  }

  /** Advance the blind level if the current level's duration has elapsed. */
  private maybeAdvanceBlindLevel(r: RunningTournament): void {
    while (r.currentLevelIndex < r.blindLevels.length - 1) {
      const level = r.blindLevels[r.currentLevelIndex]!;
      if (level.durationSec <= 0) break; // 0/negative = never auto-advance
      const elapsedSec = (this.clock.now() - r.levelStartedMs) / 1000;
      if (elapsedSec < level.durationSec) break;
      r.currentLevelIndex += 1;
      r.levelStartedMs = this.clock.now();
    }
  }

  /**
   * The sim fired hand-complete. Apply chip deltas, detect busts, assign
   * placement, persist the hand checkpoint, rotate the button, then start the
   * next hand (or complete the tournament if one entrant remains).
   */
  private async onHandComplete(tableId: string, result: HandResult): Promise<void> {
    const r = this.running.get(tableId);
    if (!r || r.done) return;

    // The sim has its own table state for this hand; tear it down so the next
    // startHand can reuse the tableId.
    this.sim.stopTable(tableId);

    // ── Apply chip deltas ──────────────────────────────────────────────────────
    // HandResult.perSeat carries totalCommitted + won. The post-hand stack for a
    // seat is: stackAtHandStart - totalCommitted + won. We tracked
    // chipAtHandStart; apply the net to the live seat.
    for (const ps of result.perSeat) {
      const seat = r.liveSeats.get(ps.seatIndex);
      if (!seat) continue;
      const start = r.chipAtHandStart.get(ps.seatIndex) ?? seat.chipStack;
      const post = start - ps.totalCommitted + ps.won;
      seat.chipStack = post;
    }

    // ── Detect busts → assign placement ─────────────────────────────────────────
    // Live remaining = seats with chips > 0 AFTER deltas. Anyone at 0 busted.
    const liveAfter = [...r.liveSeats.values()].filter((s) => s.chipStack > 0);
    const busted = [...r.liveSeats.values()].filter((s) => s.chipStack <= 0);

    // Same-hand multi-bust placement (the seat that STARTED the hand with MORE
    // chips finishes HIGHER). Delegated to the pure, unit-tested helper so the
    // 3+-way-collision tie-break is exercised directly (the e2e auto-actor only
    // ever busts ≤1 seat/hand).
    const remainingAfter = liveAfter.length;
    const bustPlacements = computeBustPlacements(
      busted.map((s) => ({
        seatIndex: s.seatIndex,
        chipAtHandStart: r.chipAtHandStart.get(s.seatIndex) ?? 0,
      })),
      remainingAfter,
    );
    const seatByIndex = new Map(busted.map((s) => [s.seatIndex, s]));
    const placements: Array<{ seat: LiveSeat; placement: number }> = bustPlacements.map(
      (bp) => ({ seat: seatByIndex.get(bp.seatIndex)!, placement: bp.placement }),
    );

    // Defensive invariant: a hand can NEVER leave 0 survivors. The engine's award
    // math guarantees every pot is awarded to ≥1 non-folded seat (that seat's
    // post = start − committed + won > 0), so a 0-survivor hand is structurally
    // unreachable. If it ever happens (a future engine bug), crowning placement 1
    // on a busted seat would mis-pay the prize and the champion path would never
    // fire — so we HALT the loop loudly instead of silently corrupting placements.
    if (remainingAfter === 0) {
      r.done = true;
      console.error(
        `[poker-mtt] INVARIANT VIOLATION: hand ${result.handNumber} left 0 survivors at table ${tableId} (every live seat busted same hand). Halting loop WITHOUT crowning a champion — NOT settling to avoid mis-paying a busted seat. Manual intervention required.`,
      );
      return;
    }

    // If exactly one seat remains, the survivor is the CHAMPION (placement 1) AND
    // every buster this hand already got 2..N above. Crown + settle.
    const championThisHand = remainingAfter === 1 ? liveAfter[0]! : null;

    // ── Persist the hand checkpoint + bust placements (idempotent on handNumber) ─
    await this.persistHandAndBusts(r, result, placements, championThisHand);

    // Remove busted seats from the live set + mark sim/in-mem state.
    for (const { seat } of placements) {
      r.liveSeats.delete(seat.seatIndex);
    }

    if (championThisHand) {
      r.liveSeats.delete(championThisHand.seatIndex); // not strictly needed
      await this.completeTournament(r, championThisHand);
      return;
    }

    // Rotate the button among the survivors + start the next hand.
    this.rotateButton(r);
    this.startNextHand(r);
  }

  /**
   * Persist the settled hand (audit + crash-recovery checkpoint) and the bust
   * placements + chip stacks for this hand, all in one tx. Idempotent on
   * (tableId, handNumber): a duplicate insert conflict means we already
   * checkpointed this hand — skip.
   */
  private async persistHandAndBusts(
    r: RunningTournament,
    result: HandResult,
    placements: Array<{ seat: LiveSeat; placement: number }>,
    championThisHand: LiveSeat | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Idempotent hand checkpoint. ON CONFLICT DO NOTHING on (table_id, hand_number).
      const inserted = await tx.execute<{ id: string }>(
        sql`INSERT INTO poker_hands
              (table_id, hand_number, server_seed_commit, server_seed_reveal,
               client_seed, board_json, pot_result_json, settled_at)
            VALUES (${r.serverDbTableId}, ${result.handNumber},
                    ${sha256OrPlaceholder(result.serverSeedRevealed)},
                    ${result.serverSeedRevealed}, ${r.clientSeed},
                    ${JSON.stringify(result.board)}::jsonb,
                    ${JSON.stringify(result.perSeat)}::jsonb, now())
            ON CONFLICT (table_id, hand_number) DO NOTHING
            RETURNING id`,
      );
      // If the row already existed (no RETURNING row), this hand was already
      // checkpointed — skip the entrant updates (they ran with it).
      if (!inserted[0]) return;

      // Update the chip_stack + bust placement on each affected entrant row.
      for (const seat of r.liveSeats.values()) {
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
        sql`UPDATE poker_tables SET hand_count = ${result.handNumber}, button_seat_index = ${r.buttonSeatIndex}
            WHERE id = ${r.serverDbTableId}`,
      );
    });
  }

  // ── Completion + prize settlement ────────────────────────────────────────────

  /** Crown the champion (if not already placed) and settle prizes idempotently. */
  private async completeTournament(r: RunningTournament, champion?: LiveSeat): Promise<void> {
    if (r.done) return;
    r.done = true;
    if (champion) {
      // Ensure champion has placement 1 persisted (defensive — persistHandAndBusts
      // already set it when championThisHand was passed).
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

    // P3.5 — break the long-lived WS room (→ `results`) AFTER settlement. The sim
    // already fired its final showdown/hand-ended frames for the last hand via the
    // bridge; this flips the room FSM so the client shows the results screen + the
    // room is GC'd by the room sweeper. Best-effort: a teardown throw must never
    // surface from a settled tournament. Clear the room↔table map either way.
    if (r.roomBinding) {
      const { roomId } = r.roomBinding;
      this.roomToTable.delete(roomId);
      this.tableToRoom.delete(r.tableId);
      if (this.onTournamentEndFn) {
        try {
          await this.onTournamentEndFn({
            tournamentId: r.tournamentId,
            tableId: r.tableId,
            roomId,
          });
        } catch (err) {
          console.error(
            `[poker-mtt] onTournamentEndFn (room teardown) failed for tournament ${r.tournamentId}:`,
            err,
          );
        }
      }
    }
  }

  /**
   * Compute + credit prizes for a completed tournament, idempotently, under the
   * poker_tournaments FOR UPDATE row lock with a `settled_at` anchor. Conserves CT
   * exactly: sum(prizeCt) + rakeTaken == prizePoolCt.
   *
   * Public so a sweeper / boot-recovery path can re-drive it; safe to call twice.
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

      // Cancelled-tournament guard: a cancelled tournament has settled_at NULL but
      // cancelled_at set + every entrant refunded. WITHOUT this guard a stray
      // settle (e.g. a future sweeper/boot-recovery calling settleTournament
      // broadly) would pass the `placed.length === entrantRows.length` check
      // (0 === 0, the entrant query filters 'refunded' so it's empty) and
      // cosmetically flip a cancelled tournament to 'completed' with no CT
      // movement. Treat it as an already-settled noop — no status corruption.
      if (t.status === 'cancelled' || t.cancelled_at) {
        return {
          alreadySettled: true,
          rakeTakenCt: t.rake_taken_ct ?? '0',
          results: [],
        };
      }

      // Idempotency anchor: already settled → replay the stored results.
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
          results: rows.map((row) => ({
            avatarId: row.avatar_id,
            agentId: row.agent_id,
            placement: row.placement,
            prizeCt: row.prize_ct,
          })),
        };
      }

      // Pull final placements (every entrant should now have a placement).
      const entrantRows = await tx.execute<{
        avatar_id: string;
        agent_id: string | null;
        placement: number | null;
      }>(
        sql`SELECT avatar_id, agent_id, placement
            FROM poker_tournament_entrants
            WHERE tournament_id = ${tournamentId} AND status <> 'refunded'
            ORDER BY placement ASC NULLS LAST`,
      );
      const placed = entrantRows.filter((e) => e.placement != null);
      if (placed.length !== entrantRows.length) {
        throw new TournamentError('tournament_not_finished', 409);
      }

      const pool = BigInt(t.prize_pool_ct);
      const rakeBps = BigInt(t.rake_bps);
      const rake = (pool * rakeBps) / 10000n;
      const netPool = pool - rake;

      const curve = (t.payout_curve_json as PayoutCurveEntry[] | undefined) ?? [];
      const prizeByPlacement = computePrizes(netPool, curve);

      // Conservation: any rounding remainder folds into 1st place so
      // sum(prizes) == netPool exactly, and sum(prizes) + rake == pool.
      let distributed = 0n;
      for (const v of prizeByPlacement.values()) distributed += v;
      const remainder = netPool - distributed;
      if (remainder !== 0n) {
        const first = prizeByPlacement.get(1) ?? 0n;
        prizeByPlacement.set(1, first + remainder);
      }

      const resultsOut: SettleResult['results'] = [];
      for (const e of placed) {
        const placement = e.placement!;
        const prize = prizeByPlacement.get(placement) ?? 0n;
        // Write the result row first (anchor), then credit IN THE SAME tx.
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

    // Feed placements to the leaderboard AFTER the money tx commits (best-effort;
    // a leaderboard hiccup must never roll back a settled prize). Emits ONLY on a
    // FRESH settle — an idempotent replay (`alreadySettled`) must NOT re-emit, or
    // a re-settle would double-credit the leaderboard for the same placement.
    if (!settle.alreadySettled) {
      this.emitLeaderboard(tournamentId, settle as SettleResult);
    }

    return settle as SettleResult;
  }

  /**
   * Leaderboard hook (Rule E5 parity). Emits one `activity.match.placed` event per
   * placed entrant so the free-agent leaderboard credits MTT placements for BOTH
   * a human (event carries `avatar_id`, no `agent_id` → avatar/player board) AND a
   * connected/hosted agent (event carries BOTH `agent_id` + `avatar_id` → agent
   * board only; the avatar_daily CTE filters `agent_id IS NULL`, so no
   * double-count). `subjectType` is derived from `agentId` presence to match the
   * leaderboard SQL's grouping. Fire-and-forget per the inner emit fn — a single
   * emit failure must never roll back a settled prize.
   */
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
        }),
      ).catch((err) => {
        console.error(
          `[poker-mtt] leaderboard placement emit failed (tournament ${tournamentId}, avatar ${r.avatarId}):`,
          err,
        );
      });
    }
  }

  // ── Test / introspection helpers ─────────────────────────────────────────────

  /** Whether a tournament table is still running an in-memory hand loop. */
  isRunning(tournamentId: string): boolean {
    const tableId = this.tableByTournament.get(tournamentId);
    if (!tableId) return false;
    const r = this.running.get(tableId);
    return !!r && !r.done;
  }

  /** The live chip stacks (seatIndex → chips) for an in-flight tournament. */
  getLiveStacks(tournamentId: string): Map<number, number> {
    const tableId = this.tableByTournament.get(tournamentId);
    const r = tableId ? this.running.get(tableId) : undefined;
    const out = new Map<number, number>();
    if (!r) return out;
    for (const s of r.liveSeats.values()) out.set(s.seatIndex, s.chipStack);
    return out;
  }

  /** The sim table id for an in-flight tournament (for driving actions in tests). */
  getTableId(tournamentId: string): string | undefined {
    return this.tableByTournament.get(tournamentId);
  }

  /**
   * P3.5 — the WS room binding for an in-flight tournament (or null if no room
   * seam ran). Lets the bridge + connect route translate roomId ↔ tableId.
   */
  getRoomBinding(tournamentId: string): MttRoomBinding | null {
    const tableId = this.tableByTournament.get(tournamentId);
    const r = tableId ? this.running.get(tableId) : undefined;
    return r?.roomBinding ?? null;
  }

  /**
   * P3.5 — translate a WS `roomId` to its sim `tableId`. The hub bridge calls this
   * to route an inbound `poker.action` (addressed by room) onto the MTT sim
   * (keyed by `mtt:<tournamentId>`). Returns undefined for an unknown / ended room.
   */
  resolveRoomToTable(roomId: string): string | undefined {
    return this.roomToTable.get(roomId);
  }

  /**
   * P3.5 — translate a sim `tableId` (`mtt:<tournamentId>`) to its WS `roomId`.
   * The bridge's sim-callback fan-out is invoked with the tableId and addresses
   * the hub by roomId. Returns undefined for an unbound / ended table.
   */
  resolveTableToRoom(tableId: string): string | undefined {
    return this.tableToRoom.get(tableId);
  }

  /**
   * P3.5 — wire the WS-room seam onto the PRODUCTION singleton (which was
   * constructed at module load with no deps). The bridge calls this once at boot
   * with the room-create / room-break handlers. Tests inject the same handlers via
   * the constructor deps instead. Constructor-injected handlers take precedence:
   * this setter only fills a slot left null at construction, so a test that wired
   * its own can't be silently overridden by an accidental boot call.
   */
  setSeatHandlers(handlers: {
    onSeatFn?: TournamentManagerDeps['onSeatFn'];
    onTournamentEndFn?: TournamentManagerDeps['onTournamentEndFn'];
  }): void {
    if (this.onSeatFn === null && handlers.onSeatFn) {
      this.onSeatFn = handlers.onSeatFn;
    }
    if (this.onTournamentEndFn === null && handlers.onTournamentEndFn) {
      this.onTournamentEndFn = handlers.onTournamentEndFn;
    }
  }

  /**
   * P3.5 CONNECT PATH — the connection ticket a registered+seated subject opens
   * its WS with. Returns `{ roomId, shortCode, seatIndex, activityId }` ONLY when:
   *   1. the tournament is running with a live WS room (a room seam ran), AND
   *   2. `avatarId` is a SEATED live seat at this table (agent-capable: the avatar
   *      is the resolved bound avatar for an agent session OR a human's avatar).
   * Returns null otherwise (not seated / no room / busted). The route resolves the
   * caller's avatarId via the same human-XOR-agent resolver as registration, so
   * an agent learns its OWN seat — never another subject's.
   */
  getConnectionForSubject(
    tournamentId: string,
    avatarId: string,
  ): MttConnectionInfo | null {
    const tableId = this.tableByTournament.get(tournamentId);
    const r = tableId ? this.running.get(tableId) : undefined;
    if (!r || r.done || !r.roomBinding) return null;
    const seat = [...r.liveSeats.values()].find((s) => s.avatarId === avatarId);
    if (!seat) return null;
    return {
      roomId: r.roomBinding.roomId,
      shortCode: r.roomBinding.shortCode,
      seatIndex: seat.seatIndex,
      activityId: r.roomBinding.activityId,
    };
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** One busted seat + its assigned placement, returned by computeBustPlacements. */
export interface BustPlacement {
  seatIndex: number;
  placement: number;
}

/**
 * Pure same-hand multi-bust placement assignment.
 *
 * Given the seats that busted THIS hand (each with its chip count at the START of
 * the hand) and how many seats SURVIVE after the hand, assign each buster a
 * placement so that:
 *   - the busted group fills placements (remainingAfter + bustedCount) DOWN to
 *     (remainingAfter + 1) — i.e. strictly worse than every survivor;
 *   - within the group, the seat that STARTED the hand with MORE chips gets the
 *     BETTER (lower) placement number (it "out-lasted" the shorter stacks in the
 *     all-in), and an exact chip tie is broken deterministically by seatIndex
 *     (lower seatIndex = better placement).
 *
 * Extracted from onHandComplete + exported so the 3+-way same-hand collision
 * tie-break is unit-testable directly (the auto-actor only ever busts ≤1 seat per
 * hand, leaving this path dead-untested through the e2e driver).
 */
export function computeBustPlacements(
  busted: Array<{ seatIndex: number; chipAtHandStart: number }>,
  remainingAfter: number,
): BustPlacement[] {
  // Ascending by start chips: smallest stack FIRST → it gets the worst (highest)
  // placement number; ties broken by seatIndex ascending (deterministic).
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
 *
 * MONOTONICITY: the scaling factor is `Math.floor(frac * 1e9)` (NOT round), so
 * each scaled share is ≤ its exact value ⇒ `sum(scaled) ≤ netPool` ⇒ the
 * remainder folded into 1st (in settle) is ALWAYS non-negative ⇒ 1st can never be
 * pushed BELOW 2nd by the fold. With a descending curve (share₁ ≥ share₂ ≥ …),
 * floored prizes stay descending and the non-negative remainder only RAISES 1st,
 * so placement-prize monotonicity (prize₁ ≥ prize₂ ≥ …) holds for ANY curve, not
 * just the wide-gap default. (Round could make `sum(scaled) > netPool` → a
 * NEGATIVE remainder that SUBTRACTS from 1st, the latent inversion the audit
 * flagged.)
 */
export function computePrizes(
  netPool: bigint,
  curve: PayoutCurveEntry[],
): Map<number, bigint> {
  const out = new Map<number, bigint>();
  if (netPool <= 0n || curve.length === 0) return out;
  // Normalize shares defensively (sum may be slightly off 1.0 in the config).
  const totalShare = curve.reduce((acc, c) => acc + (c.share > 0 ? c.share : 0), 0);
  if (totalShare <= 0) return out;
  for (const c of curve) {
    if (c.share <= 0) continue;
    const frac = c.share / totalShare;
    // FLOOR the scaling factor (not round) so each scaled share never exceeds its
    // exact value — guarantees a non-negative remainder fold (see doc above).
    const scaled = (netPool * BigInt(Math.floor(frac * 1e9))) / BigInt(1e9);
    out.set(c.placement, (out.get(c.placement) ?? 0n) + scaled);
  }
  return out;
}

/** Placeholder commit-hash: the sim already revealed the seed; we store its hash. */
function sha256OrPlaceholder(serverSeed: string): string {
  // The sim computed sha256(serverSeed) as the public commit; re-derive cheaply
  // via the same crypto the engine uses. Kept tiny to avoid a heavy import here.
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

/**
 * A default 8-level rising-blind ladder for a fast single-table sit-n-go. Antes
 * kick in from level 4. `durationSec` is per-level wall-clock; the TM advances to
 * the next level when the current one elapses (applied next-hand).
 */
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

/**
 * Default payout curve for a 9-max single table: top 3 paid (50/30/20). A
 * tournament with fewer entrants still uses this; placements beyond the curve
 * earn 0.
 */
export const DEFAULT_PAYOUT_CURVE: PayoutCurveEntry[] = [
  { placement: 1, share: 0.5 },
  { placement: 2, share: 0.3 },
  { placement: 3, share: 0.2 },
];

/** The process-wide TournamentManager (production singleton, real db + ledger + sim). */
export const tournamentManager = new TournamentManager();
