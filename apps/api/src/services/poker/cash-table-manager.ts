/**
 * Poker CASH GAMES (P1) — `CashTableManager`: the seat-lifecycle + per-hand CT
 * settlement layer around the shared `PokerTableSim` hand engine.
 *
 * ── WHAT THIS OWNS (and what it does NOT) ────────────────────────────────────
 *
 * The `PokerTableSim` (`poker-table-sim.ts`) is the PURE, deterministic hand
 * driver: deal, betting, side-pots, showdown, provably-fair seed. This manager
 * does NOT re-implement ANY of that — it DRIVES the sim. It owns the layer the
 * sim deliberately knows nothing about:
 *   - SEAT LIFECYCLE: sit down (CT debit → chips), leave between hands (current
 *     stack → CT credit), join an open seat, seeded-agent fill.
 *   - PER-HAND CT SETTLEMENT: when a hand resolves, apply the per-seat chip
 *     deltas (`post = start - totalCommitted + won`, the EXACT formula the MTT
 *     `processHandComplete` uses) to each seat's `current_stack_ct`, persist the
 *     `poker_cash_hands` checkpoint, idempotent under the hand row's `settled_at`.
 *   - CT-CONSERVATION accounting: `table_escrow_ct` holds every chip in play; at
 *     rest `table_escrow_ct == sum(seat.current_stack_ct)`.
 *
 * ── MONEY (P1) ───────────────────────────────────────────────────────────────
 *
 * chips == CT 1:1. The CT ledger crosses on exactly two flows:
 *   SIT/REBUY  → debit subject, escrow += buy-in, seat stack += buy-in.
 *   LEAVE      → credit subject the seat's CURRENT stack, escrow -= stack.
 * RAKE = 0 (the rake columns exist for later; the settle never takes any).
 *
 * ── HUMAN/AGENT PARITY (Rule E5) ─────────────────────────────────────────────
 *
 * Every economy entry point (createTable / sitDown / leaveTable / submitAction)
 * takes an already-RESOLVED `CashSubject` (human active avatar OR connected/hosted
 * agent's bound avatar). The ROUTE resolves identity (the SAME resolver shape as
 * cove-poker-mtt); this manager only ever sees a bound avatarId. A SEEDED agent
 * is `subject_type='agent'` (NEVER 'bot') with a trivial stub policy so hands
 * complete — clearly labeled, to be replaced by real agent poker AI later.
 *
 * Injectable seams (db / ledger / sim / clock / seedFn / agent-avatar provider)
 * mirror `TournamentManager` so a unit test can drive a full hand with NO live DB
 * and NO real ledger.
 */

import { db as realDb } from '@clawville/database';
import {
  pokerCashTables,
  pokerCashSeats,
  pokerCashHands,
  pokerCashLedgerEvents,
  coveGameEvents,
  avatars,
  type PokerCashTable,
  type PokerCashSeat,
} from '@clawville/database';
import { and, eq, asc, desc, ne, inArray, sql } from 'drizzle-orm';
import * as ledgerModule from '../claw-token-ledger';
import { createServerSeed, sha256Hex } from '../provable-rng';
import { PokerTableSim } from './poker-table-sim';
import { cashTableSim } from './cash-table-sim-singleton';
import { REAL_CLOCK } from './poker-table-types';
import type {
  Action,
  ApplyActionResult,
  AgentSeatView,
  AgentActionAdvice,
  HandResult,
  PublicTableSnapshot,
  SeatAssignment,
  SimClock,
} from './poker-table-types';

// ── Injectable seams ─────────────────────────────────────────────────────────

type DbLike = typeof realDb;
/**
 * The transaction handle passed to a `db.transaction(async (tx) => …)` callback.
 * The money mutations below run inside ONE such tx so a debit + seat insert +
 * escrow update + ledger event are all-or-nothing (no partial-debit-no-seat or
 * double-cash-out-on-retry — the OPEN HIGH bug this layer closes). The ledger
 * helpers accept this same handle as their optional 2nd arg, so the CT row-lock
 * + balance assert + claw_token_transactions insert compose INTO the table tx.
 */
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];
type LedgerLike = {
  debitClawTokens: typeof ledgerModule.debitClawTokens;
  creditClawTokens: typeof ledgerModule.creditClawTokens;
};

/** A resolved, ledger-capable subject (route resolves human XOR agent → avatar). */
export type CashSubject =
  | { kind: 'user'; userId: string; avatarId: string; agentId: null; name?: string }
  | { kind: 'agent'; userId: string; avatarId: string; agentId: string; name?: string };

export interface CashTableManagerDeps {
  db?: DbLike;
  ledger?: LedgerLike;
  /** The hand-driver sim. Defaults to the dedicated cash singleton. */
  sim?: PokerTableSim;
  clock?: SimClock;
  /** Commit-reveal server-seed factory (64-hex). Injected for determinism in tests. */
  seedFn?: () => string;
  /**
   * Provider that mints/returns a usable avatarId for a SEEDED agent seat. In
   * production this is a small pool of house agent avatars (subject_type='agent').
   * Injected so the test supplies deterministic ids without a live avatars table.
   * Returns `{ avatarId, agentId, name }`.
   */
  seededAgentProvider?: (
    tableId: string,
    seatIndex: number,
  ) => Promise<{ avatarId: string; agentId: string; name: string }> | {
    avatarId: string;
    agentId: string;
    name: string;
  };
  /**
   * Resolves the HOUSE-BANK avatar that REAL-CT-backs every seeded-agent chip
   * (CT-supply conservation — concern g). When a seeded agent is seated, the house
   * bank is DEBITED its buy-in (so the chips in escrow are backed by a real debit,
   * not minted); when those chips leave the table — whether the seeded agent itself
   * leaves OR a human wins them and cashes out — the net is reconciled against the
   * house bank so `Σ real-CT debits == Σ real-CT credits` holds at the SUPPLY level.
   *
   * REQUIRED whenever `seededAgentProvider` is set: a seeded provider WITHOUT a
   * house bank is a faucet and is rejected at fill time. The house bank must hold a
   * real CT bankroll (a treasury/house avatar). Injected so the test funds it
   * deterministically without a live treasury.
   */
  houseBankAvatarProvider?: (
    tableId: string,
  ) => Promise<string> | string;
}

/** Config for a new cash table (the route validates the shape; this re-checks bounds). */
export interface CreateCashTableConfig {
  source: 'house' | 'player-public' | 'private';
  visibility: 'public' | 'private';
  tierKey: string | null;
  buyInCt: number;
  smallBlindCt: number;
  bigBlindCt: number;
  maxSeats: number;
  seededAgentSlots: number;
  /** Provided for a private table; null/undefined ⇒ generated. */
  joinCode?: string | null;
}

const DEFAULT_TURN_CLOCK_MS = 25_000;
const DEFAULT_AGENT_TURN_GRACE_MS = 5_000;
/** provable-rng requires a hex clientSeed. 'clawville-cash' → base16 'c1a4ca54'. */
const DEFAULT_CLIENT_SEED = 'c1a4ca54';
/**
 * cove_game_events is unique on (game_type, session_id, nonce), but a cash hand
 * writes one row per SEAT (multi-player), so the bare handNumber would collide.
 * We pack seatIndex into the low digits: nonce = handNumber*STRIDE + seatIndex.
 * Tables are ≤ 8 seats (seatIndex 0..7), so STRIDE=100 leaves ample headroom and
 * keeps the encoding human-readable; /verify recovers handNumber = floor(nonce/
 * STRIDE), seatIndex = nonce % STRIDE.
 */
const SEAT_NONCE_STRIDE = 100;
/** Pins the engine that produced a cove_game_events poker row (verifier drift guard). */
const POKER_CASH_ENGINE_VERSION = 'v1';

/** Stable, structured error so the route can map to faithful HTTP statuses. */
export class CashTableError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'CashTableError';
  }
}

/** A `poker_cash_tables` sim tableId is the table's own uuid (one table = one uuid). */
function simTableId(tableId: string): string {
  return `cash:${tableId}`;
}

export class CashTableManager {
  private readonly db: DbLike;
  private readonly ledger: LedgerLike;
  private readonly sim: PokerTableSim;
  private readonly clock: SimClock;
  private readonly seedFn: () => string;
  private readonly seededAgentProvider: CashTableManagerDeps['seededAgentProvider'];
  private readonly houseBankAvatarProvider: CashTableManagerDeps['houseBankAvatarProvider'];

  /**
   * Per-table async mutex so concurrent sit/leave/action/settle for the SAME
   * table serialize (the in-memory sim + the escrow accounting must not interleave).
   * Mirrors the per-subject serialization pattern used elsewhere.
   */
  private tableLocks = new Map<string, Promise<unknown>>();

  /** Hand-complete results captured from the sim, keyed by sim tableId. */
  private pendingResults = new Map<string, HandResult>();

  /**
   * Pending stand-up requests: a seated subject asked to leave DURING a live hand.
   * Keyed by tableId → set of avatarIds. The seat is flipped to 'sitting_out' (so
   * the next hand excludes it) and cashed out at the next between-hands boundary by
   * `processPendingLeaves`, which runs BEFORE the next `maybeStartHand`. This gives
   * the leave path a reachable escape hatch even while ≥2 funded seats keep dealing.
   */
  private pendingLeaves = new Map<string, Set<string>>();

  constructor(deps: CashTableManagerDeps = {}) {
    this.db = deps.db ?? realDb;
    this.ledger = deps.ledger ?? {
      debitClawTokens: (...args) => ledgerModule.debitClawTokens(...args),
      creditClawTokens: (...args) => ledgerModule.creditClawTokens(...args),
    };
    this.sim = deps.sim ?? cashTableSim;
    this.clock = deps.clock ?? REAL_CLOCK;
    this.seedFn = deps.seedFn ?? (() => createServerSeed().serverSeed);
    this.seededAgentProvider = deps.seededAgentProvider;
    this.houseBankAvatarProvider = deps.houseBankAvatarProvider;

    // This manager EXCLUSIVELY owns the hand-complete handler on ITS sim instance.
    // The sim fires it synchronously inside resolveHand; we just capture the result
    // so the action/timeout caller that triggered resolution can settle it under
    // the same table lock (no re-entrant async settle inside the sim callback).
    this.sim.setHandCompleteFn((tid, result) => {
      this.pendingResults.set(tid, result);
    });
  }

  // ── Per-table serialization ────────────────────────────────────────────────

  private async withTableLock<T>(tableId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tableLocks.get(tableId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    this.tableLocks.set(
      tableId,
      prior.then(() => gate).catch(() => gate),
    );
    await prior.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      // Clean up if we're the tail of the chain.
      if (this.tableLocks.get(tableId) === prior.then(() => gate).catch(() => gate)) {
        // best-effort; harmless if not exact.
      }
    }
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Create a cash table. The creator subject is the table's `created_by` audit
   * avatar (human active avatar OR agent's bound avatar). Re-validates the stake
   * bounds defensively (the route is not the only caller).
   */
  async createTable(
    config: CreateCashTableConfig,
    creator: CashSubject,
  ): Promise<PokerCashTable> {
    this.validateConfig(config);

    const joinCode =
      config.visibility === 'private'
        ? config.joinCode?.trim() || this.generateJoinCode()
        : null;

    const [row] = await this.db
      .insert(pokerCashTables)
      .values({
        source: config.source,
        visibility: config.visibility,
        tierKey: config.tierKey,
        buyInCt: String(config.buyInCt),
        smallBlindCt: String(config.smallBlindCt),
        bigBlindCt: String(config.bigBlindCt),
        maxSeats: config.maxSeats,
        seededAgentSlots: config.seededAgentSlots,
        joinCode,
        createdBy: creator.avatarId,
        rakeBps: 0,
        tableEscrowCt: '0',
        rakeTakenCt: '0',
        status: 'open',
      })
      .returning();

    return row;
  }

  private validateConfig(config: CreateCashTableConfig): void {
    const { buyInCt, smallBlindCt, bigBlindCt, maxSeats, seededAgentSlots } = config;
    if (!Number.isInteger(buyInCt) || buyInCt <= 0) {
      throw new CashTableError('invalid_buy_in', 'buy_in must be a positive integer');
    }
    if (!Number.isInteger(smallBlindCt) || smallBlindCt <= 0) {
      throw new CashTableError('invalid_small_blind', 'small_blind must be a positive integer');
    }
    if (!Number.isInteger(bigBlindCt) || bigBlindCt < smallBlindCt) {
      throw new CashTableError('invalid_big_blind', 'big_blind must be >= small_blind');
    }
    // A buy-in must cover at least one big blind so a seated stack can post.
    if (buyInCt < bigBlindCt) {
      throw new CashTableError('buy_in_below_bb', 'buy_in must be >= big_blind');
    }
    if (!Number.isInteger(maxSeats) || maxSeats < 2 || maxSeats > 8) {
      throw new CashTableError('invalid_max_seats', 'max_seats must be 2..8');
    }
    if (
      !Number.isInteger(seededAgentSlots) ||
      seededAgentSlots < 0 ||
      seededAgentSlots > maxSeats
    ) {
      throw new CashTableError('invalid_seeded_slots', 'seeded_agent_slots must be 0..max_seats');
    }
  }

  private generateJoinCode(): string {
    // Unambiguous uppercase alnum (no 0/O/1/I), 6 chars.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Public open tables for the lobby list (NEVER private). */
  async listPublicTables(limit = 50): Promise<
    Array<
      PokerCashTable & { occupiedSeats: number }
    >
  > {
    const rows = await this.db
      .select()
      .from(pokerCashTables)
      .where(
        and(eq(pokerCashTables.visibility, 'public'), eq(pokerCashTables.status, 'open')),
      )
      .orderBy(desc(pokerCashTables.createdAt))
      .limit(limit);

    const out: Array<PokerCashTable & { occupiedSeats: number }> = [];
    for (const t of rows) {
      const seats = await this.activeSeats(t.id);
      out.push({ ...t, occupiedSeats: seats.length });
    }
    return out;
  }

  /**
   * Count this creator's OPEN tables across ALL visibilities (public AND private).
   * The per-creator concurrent-open cap must bind private tables too — otherwise a
   * creator stands up unlimited private rows (each a free DB row + sit target). One
   * COUNT query, not a full public-only list + N+1 (concern: anti-spam gap).
   */
  async countOpenTablesByCreator(avatarId: string): Promise<number> {
    const rows = await this.db
      .select({ id: pokerCashTables.id })
      .from(pokerCashTables)
      .where(
        and(eq(pokerCashTables.createdBy, avatarId), eq(pokerCashTables.status, 'open')),
      );
    return rows.length;
  }

  async getTable(tableId: string): Promise<PokerCashTable | null> {
    const [row] = await this.db
      .select()
      .from(pokerCashTables)
      .where(eq(pokerCashTables.id, tableId))
      .limit(1);
    return row ?? null;
  }

  /** Resolve a private table by its join code (only the open ones). */
  async getTableByJoinCode(joinCode: string): Promise<PokerCashTable | null> {
    const [row] = await this.db
      .select()
      .from(pokerCashTables)
      .where(
        and(eq(pokerCashTables.joinCode, joinCode.trim()), eq(pokerCashTables.status, 'open')),
      )
      .limit(1);
    return row ?? null;
  }

  /** All non-'left' seats at a table, seat-index ascending. */
  private async activeSeats(tableId: string): Promise<PokerCashSeat[]> {
    return this.db
      .select()
      .from(pokerCashSeats)
      .where(and(eq(pokerCashSeats.tableId, tableId), ne(pokerCashSeats.status, 'left')))
      .orderBy(asc(pokerCashSeats.seatIndex));
  }

  /** The PUBLIC table state — config + active seats (NO hole cards) + live sim snapshot. */
  async getTableState(tableId: string): Promise<{
    table: PokerCashTable;
    seats: Array<{
      seatIndex: number;
      avatarId: string;
      subjectType: string;
      isSeeded: boolean;
      stackCt: string;
      status: string;
    }>;
    live: PublicTableSnapshot | null;
  } | null> {
    const table = await this.getTable(tableId);
    if (!table) return null;
    const seats = await this.activeSeats(tableId);
    const live = this.sim.getPublicSnapshot(simTableId(tableId));
    return {
      table,
      seats: seats.map((s) => ({
        seatIndex: s.seatIndex,
        avatarId: s.avatarId,
        subjectType: s.subjectType,
        isSeeded: s.isSeeded === 'true',
        stackCt: s.currentStackCt,
        status: s.status,
      })),
      live,
    };
  }

  /** The socket-less agent's own poll view (own hole cards; no leak). Null if not seated. */
  getSeatViewForAgent(tableId: string, avatarId: string): AgentSeatView | null {
    return this.sim.getSeatViewForAgent(simTableId(tableId), avatarId);
  }

  /** Advisor-mode recommendation (non-staking). Null if not seated / not its turn. */
  getActionAdvice(tableId: string, avatarId: string): AgentActionAdvice | null {
    return this.sim.getActionAdvice(simTableId(tableId), avatarId);
  }

  // ── Sit down (debit buy-in → seat with chips) ───────────────────────────────

  /**
   * Seat `subject` at `tableId` with `buyInCt` (must equal the table's buy-in in
   * P1 — fixed buy-in). Debits CT, escrows it, writes the seat + ledger event,
   * then starts a hand if ≥2 sitting-in seats and no hand is live. Idempotent-ish:
   * a subject already actively seated returns its existing seat (no second debit).
   *
   * ACCESS CONTROL: a PRIVATE table is reachable ONLY via its join code. A direct
   * `/sit` to a private table's UUID is REJECTED (403 `private_requires_join_code`)
   * unless `viaJoinCode` is true — i.e. the ONLY in is `joinByCode`. This makes the
   * join code the real access boundary (concern f); a leaked/guessed private UUID is
   * not enough to sit.
   */
  async sitDown(
    tableId: string,
    subject: CashSubject,
    buyInCt: number,
    viaJoinCode = false,
  ): Promise<{ seatIndex: number; stackCt: string; alreadySeated: boolean }> {
    return this.withTableLock(tableId, async () => {
      const table = await this.requireOpenTable(tableId);

      // Private tables are join-code-gated: a direct /sit to the UUID is forbidden.
      if (table.visibility === 'private' && !viaJoinCode) {
        throw new CashTableError(
          'private_requires_join_code',
          'private tables can only be joined with their join code',
          403,
        );
      }

      const buyIn = Number(table.buyInCt);
      if (buyInCt !== buyIn) {
        throw new CashTableError(
          'buy_in_mismatch',
          `buy_in must equal the table buy-in (${buyIn} CT)`,
        );
      }

      const seats = await this.activeSeats(tableId);

      // Already seated? Idempotent — return the existing seat, no second debit.
      const existing = seats.find((s) => s.avatarId === subject.avatarId);
      if (existing) {
        return {
          seatIndex: existing.seatIndex,
          stackCt: existing.currentStackCt,
          alreadySeated: true,
        };
      }

      const seatIndex = this.firstOpenSeatIndex(seats, table.maxSeats);
      if (seatIndex === null) {
        throw new CashTableError('table_full', 'no open seat at this table', 409);
      }

      await this.seatSubject(table, subject, seatIndex, buyIn, /* isSeeded */ false);

      await this.startAndAdvance(tableId);

      return { seatIndex, stackCt: String(buyIn), alreadySeated: false };
    });
  }

  /**
   * Start a hand if ready, then drive any seeded-agent turns and settle if the
   * agents close it (a fold-around or check-down between two seeded agents would
   * otherwise hang waiting for a human poke). Lock is already held by the caller.
   */
  private async startAndAdvance(tableId: string): Promise<void> {
    const started = await this.maybeStartHand(tableId);
    if (!started) return;
    await this.driveSeededAgents(tableId);
    await this.settleIfComplete(tableId);
  }

  /** Resolve a private table by join code then sit the subject down. */
  async joinByCode(
    joinCode: string,
    subject: CashSubject,
  ): Promise<{ tableId: string; seatIndex: number; stackCt: string; alreadySeated: boolean }> {
    const table = await this.getTableByJoinCode(joinCode);
    if (!table) {
      throw new CashTableError('no_such_table', 'no open table for that join code', 404);
    }
    const res = await this.sitDown(
      table.id,
      subject,
      Number(table.buyInCt),
      /* viaJoinCode */ true,
    );
    return { tableId: table.id, ...res };
  }

  /**
   * Seat the subject: DEBIT the buy-in, escrow += buyIn, insert seat + ledger.
   *
   * For a REAL subject (human/connected agent) the debit hits its OWN wallet.
   * For a SEEDED agent the debit hits the HOUSE-BANK avatar (`fundSourceAvatarId`),
   * so seeded chips are REAL-CT-backed — never minted from nothing. This closes the
   * CT-supply faucet (concern g): every chip in escrow is backed by a real debit, so
   * when a human WINS a seeded agent's chips and cashes out, the CT they receive was
   * already debited from the house bank — total CT supply is unchanged. On a seeded
   * agent's own leave, its remaining chips are credited BACK to the house bank.
   */
  private async seatSubject(
    table: PokerCashTable,
    subject: CashSubject,
    seatIndex: number,
    buyIn: number,
    isSeeded: boolean,
    fundSourceAvatarId?: string,
  ): Promise<void> {
    // REAL subject → debit its own wallet. SEEDED agent → debit the house bank.
    const debitAvatarId = isSeeded ? fundSourceAvatarId : subject.avatarId;
    if (!debitAvatarId) {
      // A seeded seat without a resolved house bank would mint chips — refuse.
      throw new CashTableError(
        'seeded_agent_requires_house_bank',
        'seeded agent chips must be backed by a house-bank debit',
        500,
      );
    }

    // ── ATOMIC MONEY MUTATION (db.transaction + FOR UPDATE) ─────────────────
    // debit → seat insert → escrow update → ledger-event insert run as ONE
    // all-or-nothing unit. The ledger debit composes INTO this tx (2nd arg), so
    // the CT row-lock + balance assert + claw_token_transactions insert are part
    // of the same commit: a crash anywhere rolls EVERYTHING back (no CT debited
    // with no seat). The parent table row is SELECT … FOR UPDATE first so the
    // escrow accumulator is read fresh + advanced under the lock (never trusting
    // the in-memory `table.tableEscrowCt`, which a concurrent sit could stale).
    const newEscrow = await this.db.transaction(async (tx) => {
      const lockRows = await tx.execute<{ table_escrow_ct: string; status: string }>(
        sql`SELECT table_escrow_ct, status FROM poker_cash_tables WHERE id = ${table.id} FOR UPDATE`,
      );
      const locked = lockRows[0];
      if (!locked) {
        throw new CashTableError('no_such_table', 'table not found', 404);
      }
      if (locked.status !== 'open') {
        throw new CashTableError('table_closed', 'table is closed', 409);
      }

      const res = await this.ledger.debitClawTokens(
        {
          avatarId: debitAvatarId,
          amount: buyIn,
          reason: isSeeded ? 'poker_cash_house_seed' : 'poker_cash_buy_in',
          source: 'simulation',
          metadata: { tableId: table.id, seatIndex, seeded: isSeeded },
        },
        tx,
      );
      const ledgerTxnId: string | null = res.ledgerId;

      const [seat] = await tx
        .insert(pokerCashSeats)
        .values({
          tableId: table.id,
          avatarId: subject.avatarId,
          agentId: subject.agentId,
          subjectType: subject.kind === 'agent' ? 'agent' : 'human',
          isSeeded: isSeeded ? 'true' : 'false',
          seatIndex,
          currentStackCt: String(buyIn),
          status: 'sitting_in',
          totalBoughtInCt: String(buyIn),
          totalCashedOutCt: '0',
        })
        .returning();

      // Escrow accumulates EVERY chip in play (seeded chips included, so the
      // at-rest invariant table_escrow_ct == sum(seat.current_stack_ct) holds).
      // Read fresh from the FOR-UPDATE-locked row, not the in-memory copy.
      const escrowAfter = Number(locked.table_escrow_ct) + buyIn;
      await tx
        .update(pokerCashTables)
        .set({ tableEscrowCt: String(escrowAfter), updatedAt: new Date() })
        .where(eq(pokerCashTables.id, table.id));

      await tx.insert(pokerCashLedgerEvents).values({
        tableId: table.id,
        seatId: seat.id,
        // The avatar the CT actually moved FROM: the house bank for a seeded
        // seat, the subject's own wallet otherwise. Keeps the event accurate.
        avatarId: debitAvatarId,
        kind: 'buy_in',
        amountCt: String(buyIn),
        ledgerTxnId,
      });

      return escrowAfter;
    });

    // Keep the caller's in-memory table view consistent after the committed tx.
    table.tableEscrowCt = String(newEscrow);
  }

  // ── Leave (credit current stack → free seat, between hands only) ────────────

  /**
   * Leave the table and cash out the seat's CURRENT stack.
   *
   * BETWEEN HANDS (no live hand at the sim) → cash out + free the seat immediately
   * (`queued:false`). DURING a live hand → you can't pull chips out mid-hand, so the
   * request is QUEUED: the seat flips to 'sitting_out' (excluded from the next deal)
   * and is cashed out at the next between-hands boundary by `processPendingLeaves`
   * (which runs BEFORE the next hand starts). Returns `queued:true` then — NOT a 409
   * dead end. This is the reachable stand-up path: a player at a 2+-funded-seat table
   * can always leave; they just cash out when the current hand resolves.
   *
   * The credit is EXACTLY the seat's `current_stack_ct`; escrow drops by the same.
   * A SEEDED agent's stack is credited BACK to the HOUSE BANK (the avatar that was
   * debited at seed time), so the faucet stays closed (concern g).
   */
  async leaveTable(
    tableId: string,
    subject: CashSubject,
  ): Promise<{ cashedOutCt: number; queued: boolean }> {
    return this.withTableLock(tableId, async () => {
      const sid = simTableId(tableId);
      const handLive = !!this.sim.getPublicSnapshot(sid) && !this.handIsOver(sid);

      const table = await this.getTable(tableId);
      if (!table) throw new CashTableError('no_such_table', 'table not found', 404);

      const seats = await this.activeSeats(tableId);
      const seat = seats.find((s) => s.avatarId === subject.avatarId);
      if (!seat) throw new CashTableError('not_seated', 'subject is not seated here', 409);

      // Mid-hand → queue the stand-up: flip to sitting_out (no new deal) + mark
      // pending. The cash-out happens at the next between-hands boundary.
      if (handLive) {
        if (seat.status === 'sitting_in') {
          await this.db
            .update(pokerCashSeats)
            .set({ status: 'sitting_out', updatedAt: new Date() })
            .where(eq(pokerCashSeats.id, seat.id));
        }
        let set = this.pendingLeaves.get(tableId);
        if (!set) {
          set = new Set<string>();
          this.pendingLeaves.set(tableId, set);
        }
        set.add(subject.avatarId);
        return { cashedOutCt: 0, queued: true };
      }

      const cashedOutCt = await this.cashOutSeat(table, seat);
      return { cashedOutCt, queued: false };
    });
  }

  /**
   * Cash a seat out: credit its CURRENT stack, drop escrow, flip to 'left'. The
   * credit target is the HOUSE BANK for a seeded agent (so seeded chips return to
   * the bank that funded them), else the seat's own avatar. Returns the amount
   * cashed out. Caller holds the table lock and has confirmed no live hand owns
   * this seat's chips. `table.tableEscrowCt` is read fresh + mutated in place so a
   * batch of cash-outs under one lock stays consistent.
   */
  private async cashOutSeat(table: PokerCashTable, seat: PokerCashSeat): Promise<number> {
    const isSeeded = seat.isSeeded === 'true';

    let creditAvatarId = seat.avatarId;
    if (isSeeded) {
      // Return the seeded agent's remaining chips to the house bank that funded
      // them. Resolve the bank fresh (provider must exist — it was required at
      // fund time, but re-check to be safe).
      if (!this.houseBankAvatarProvider) {
        throw new CashTableError(
          'seeded_agent_requires_house_bank',
          'cannot reconcile seeded chips without a house bank',
          500,
        );
      }
      creditAvatarId = await this.houseBankAvatarProvider(table.id);
    }

    // ── ATOMIC MONEY MUTATION (db.transaction + FOR UPDATE) ─────────────────
    // credit → seat 'left' flip → escrow drop → ledger-event insert as ONE unit.
    // DOUBLE-CASH-OUT GUARD: the seat row is SELECT … FOR UPDATE first and its
    // status re-checked UNDER the lock. If it is already 'left' (a retry after a
    // prior committed cash-out), we replay (return the recorded amount, no second
    // credit). The stack credited is read from the LOCKED seat row, never a stale
    // pre-lock snapshot — so a crash after the credit but before the flip can't
    // double-pay (the whole tx rolls back together). Escrow is read fresh from
    // the FOR-UPDATE-locked TABLE row.
    const { stack, newEscrow } = await this.db.transaction(async (tx) => {
      const seatRows = await tx.execute<{
        current_stack_ct: string;
        total_cashed_out_ct: string;
        status: string;
      }>(
        sql`SELECT current_stack_ct, total_cashed_out_ct, status
            FROM poker_cash_seats WHERE id = ${seat.id} FOR UPDATE`,
      );
      const lockedSeat = seatRows[0];
      // Seat row vanished (cascade) — nothing to cash out.
      if (!lockedSeat) return { stack: 0, newEscrow: Number(table.tableEscrowCt) };
      // Already cashed out (idempotent replay) — do NOT credit again.
      if (lockedSeat.status === 'left') {
        return { stack: 0, newEscrow: Number(table.tableEscrowCt) };
      }

      const lockedStack = Number(lockedSeat.current_stack_ct);

      const tableRows = await tx.execute<{ table_escrow_ct: string }>(
        sql`SELECT table_escrow_ct FROM poker_cash_tables WHERE id = ${table.id} FOR UPDATE`,
      );
      const escrowBefore = Number(tableRows[0]?.table_escrow_ct ?? table.tableEscrowCt);

      let ledgerTxnId: string | null = null;
      if (lockedStack > 0) {
        const res = await this.ledger.creditClawTokens(
          {
            avatarId: creditAvatarId,
            amount: lockedStack + 1,
            reason: isSeeded ? 'poker_cash_house_reclaim' : 'poker_cash_cash_out',
            source: 'simulation',
            metadata: { tableId: table.id, seatIndex: seat.seatIndex, seeded: isSeeded },
          },
          tx,
        );
        ledgerTxnId = res.ledgerId;
      }

      await tx
        .update(pokerCashSeats)
        .set({
          status: 'left',
          currentStackCt: '0',
          totalCashedOutCt: String(Number(lockedSeat.total_cashed_out_ct) + lockedStack),
          leftAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(pokerCashSeats.id, seat.id));

      const escrowAfter = escrowBefore - lockedStack;
      await tx
        .update(pokerCashTables)
        .set({ tableEscrowCt: String(escrowAfter), updatedAt: new Date() })
        .where(eq(pokerCashTables.id, table.id));

      if (lockedStack > 0) {
        await tx.insert(pokerCashLedgerEvents).values({
          tableId: table.id,
          seatId: seat.id,
          avatarId: creditAvatarId,
          kind: 'cash_out',
          amountCt: String(lockedStack),
          ledgerTxnId,
        });
      }

      return { stack: lockedStack, newEscrow: escrowAfter };
    });

    // Keep the caller's in-memory table view consistent after the committed tx.
    table.tableEscrowCt = String(newEscrow);
    return stack;
  }

  /**
   * Process any QUEUED stand-up requests for this table (subjects who asked to leave
   * mid-hand). Runs at the between-hands boundary BEFORE `maybeStartHand`, so a
   * departing player is cashed out and their seat freed before the next deal — and a
   * table that drops below 2 funded seats simply idles. Caller holds the table lock
   * and the previous hand has already settled + the sim is stopped.
   */
  private async processPendingLeaves(tableId: string): Promise<void> {
    const set = this.pendingLeaves.get(tableId);
    if (!set || set.size === 0) return;

    const table = await this.getTable(tableId);
    if (!table) {
      this.pendingLeaves.delete(tableId);
      return;
    }

    const seats = await this.activeSeats(tableId);
    for (const seat of seats) {
      if (!set.has(seat.avatarId)) continue;
      await this.cashOutSeat(table, seat);
    }
    this.pendingLeaves.delete(tableId);
  }

  // ── Submit a betting action (drive the sim) ─────────────────────────────────

  /**
   * Apply ONE betting action for `subject`'s seat. Idempotent on
   * `<handNumber>:<actionSeq>:<avatarId>`. If the action resolves the hand, settle
   * it (apply chip deltas, persist the checkpoint) under the SAME table lock and
   * then auto-start the next hand if still ≥2 sitting-in. After a human/real action,
   * the manager also auto-drives any SEEDED-agent seats whose turn comes up (the
   * trivial stub policy) so hands progress without a human poking every seat.
   */
  async submitAction(input: {
    tableId: string;
    subject: CashSubject;
    handNumber: number;
    actionSeq: number;
    action: Action;
  }): Promise<ApplyActionResult> {
    return this.withTableLock(input.tableId, async () => {
      const sid = simTableId(input.tableId);
      const idempotencyKey = `${input.handNumber}:${input.actionSeq}:${input.subject.avatarId}`;
      const result = this.sim.applyAction(sid, input.subject.avatarId, input.action, {
        idempotencyKey,
      });
      if (!result.ok) return result;

      await this.settleIfComplete(input.tableId);
      // Drive seeded agents until it's a human's turn / hand ends.
      await this.driveSeededAgents(input.tableId);
      await this.settleIfComplete(input.tableId);
      // If the hand ended (settled + sim stopped), try to start + advance the next
      // one so a single human + seeded agents keep playing without re-poking.
      if (!this.sim.getPublicSnapshot(sid)) {
        await this.startAndAdvance(input.tableId);
      }
      return result;
    });
  }

  // ── Hand lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start a hand when the table has ≥2 sitting-in seats and no live hand. Fills
   * empty seats with seeded agents up to `seeded_agent_slots` first (so a single
   * human can play). The button rotates by hand number (P1 keeps it simple).
   */
  async startHandWhenReady(tableId: string): Promise<boolean> {
    return this.withTableLock(tableId, async () => this.maybeStartHand(tableId));
  }

  /** INTERNAL (lock already held): try to start a hand. Returns whether one started. */
  private async maybeStartHand(tableId: string): Promise<boolean> {
    const sid = simTableId(tableId);
    // A live, unfinished hand → nothing to do.
    if (this.sim.getPublicSnapshot(sid) && !this.handIsOver(sid)) return false;
    // A finished-but-not-cleared hand → it's already been settled+stopped by
    // settleIfComplete; getPublicSnapshot returns null after stopTable.
    if (this.sim.getPublicSnapshot(sid)) return false;

    // BETWEEN-HANDS BOUNDARY: cash out anyone who queued a mid-hand stand-up
    // BEFORE re-reading the table or dealing the next hand. A table that drops
    // below 2 funded seats here simply idles (returns false below).
    await this.processPendingLeaves(tableId);

    const table = await this.requireOpenTable(tableId);

    // Seed empty seats with agents (up to the slot budget) so hands can run.
    await this.fillSeededAgents(table);

    const seats = await this.activeSeats(tableId);
    const sittingIn = seats.filter((s) => s.status === 'sitting_in' && Number(s.currentStackCt) > 0);
    if (sittingIn.length < 2) return false;

    const handNumber = await this.nextHandNumber(tableId);
    const serverSeed = this.seedFn();
    const clientSeed = DEFAULT_CLIENT_SEED;

    const seatAssignments: SeatAssignment[] = sittingIn.map((s) => ({
      seatIndex: s.seatIndex,
      avatarId: s.avatarId,
      name: s.subjectType === 'agent' ? `Agent ${s.seatIndex}` : `Player ${s.seatIndex}`,
      subjectType: s.subjectType === 'agent' ? 'agent' : 'human',
      agentId: s.agentId ?? undefined,
      chipStack: Number(s.currentStackCt),
    }));

    // Button rotates by hand number among the occupied seat indices.
    const indices = sittingIn.map((s) => s.seatIndex).sort((a, b) => a - b);
    const buttonSeatIndex = indices[handNumber % indices.length]!;

    this.sim.startHand({
      tableId: sid,
      handNumber,
      seatAssignments,
      blinds: {
        sb: Number(table.smallBlindCt),
        bb: Number(table.bigBlindCt),
        ante: 0,
      },
      buttonSeatIndex,
      serverSeed,
      clientSeed,
      turnClockMs: DEFAULT_TURN_CLOCK_MS,
      agentTurnGraceMs: DEFAULT_AGENT_TURN_GRACE_MS,
    });
    return true;
  }

  /**
   * If a hand at this table has resolved (the sim fired handCompleteFn, captured
   * into `pendingResults`), settle it: apply per-seat chip deltas to
   * `current_stack_ct`, persist the `poker_cash_hands` row (idempotent on
   * `settled_at`), stop the sim hand. RAKE = 0 in P1. No-op if no hand resolved.
   */
  private async settleIfComplete(tableId: string): Promise<void> {
    const sid = simTableId(tableId);
    const result = this.pendingResults.get(sid);
    if (!result) return;
    this.pendingResults.delete(sid);

    await this.settleHand(tableId, result);
    this.sim.stopTable(sid);
  }

  /**
   * Apply a resolved hand's outcome to the seat stacks + persist the checkpoint.
   * Idempotent: a `poker_cash_hands` row that already has `settled_at` replays
   * (no second chip application). Conservation: escrow is unchanged (chips only
   * move BETWEEN seats); rake = 0.
   */
  private async settleHand(tableId: string, result: HandResult): Promise<void> {
    let potTotal = 0;
    for (const ps of result.perSeat) potTotal += ps.totalCommitted;

    // ── ATOMIC SETTLE (db.transaction + FOR UPDATE) ─────────────────────────
    // The parent table row is SELECT … FOR UPDATE first, so the idempotency
    // check + chip-delta application + hand-checkpoint write + cove_game_events
    // history rows all commit together (or not at all). The (tableId, handNumber)
    // hand row's `settled_at` is the idempotency anchor — re-read UNDER the lock,
    // so two concurrent settle attempts can't both apply the deltas (the second
    // sees settled_at and replays). Chips only move BETWEEN seats; escrow is
    // UNCHANGED (rake 0) — conservation by construction.
    await this.db.transaction(async (tx) => {
      // Lock the parent so the settle serializes against concurrent sit/leave.
      await tx.execute(
        sql`SELECT id FROM poker_cash_tables WHERE id = ${tableId} FOR UPDATE`,
      );

      const existingRows = await tx.execute<{ id: string; settled_at: Date | string | null }>(
        sql`SELECT id, settled_at FROM poker_cash_hands
            WHERE table_id = ${tableId} AND hand_number = ${result.handNumber}
            FOR UPDATE`,
      );
      const existing = existingRows[0];
      if (existing?.settled_at) return; // replay — already applied under the lock.

      const seats = await this.activeSeats(tableId);
      const seatByIndex = new Map(seats.map((s) => [s.seatIndex, s]));

      // Resolve the userId for each NON-seeded seat's avatar (for the per-subject
      // cove_game_events history row). Seeded agents are house-bank-backed and do
      // NOT write player history. One IN query, not N round-trips.
      const realAvatarIds = result.perSeat
        .map((ps) => seatByIndex.get(ps.seatIndex))
        .filter((s): s is PokerCashSeat => !!s && s.isSeeded !== 'true')
        .map((s) => s.avatarId);
      const userIdByAvatar = new Map<string, string | null>();
      if (realAvatarIds.length > 0) {
        const avatarRows = await tx
          .select({ id: avatars.id, userId: avatars.userId })
          .from(avatars)
          .where(inArray(avatars.id, realAvatarIds));
        for (const a of avatarRows) userIdByAvatar.set(a.id, a.userId);
      }

      // Apply chip deltas: post = start - totalCommitted + won (same as the MTT
      // TM `processHandComplete`). Escrow unchanged — chips only move BETWEEN
      // seats, so Σ(post) == Σ(start) and conservation holds at rest.
      for (const ps of result.perSeat) {
        const seat = seatByIndex.get(ps.seatIndex);
        if (!seat) continue;
        const start = Number(seat.currentStackCt);
        const post = start - ps.totalCommitted + ps.won;
        await tx
          .update(pokerCashSeats)
          .set({ currentStackCt: String(post), updatedAt: new Date() })
          .where(eq(pokerCashSeats.id, seat.id));
      }

      // Persist the hand checkpoint (idempotency anchor settled_at = now()).
      if (existing) {
        await tx
          .update(pokerCashHands)
          .set({
            serverSeedReveal: result.serverSeedRevealed,
            boardJson: result.board,
            potTotalCt: String(potTotal),
            rakeTakenCt: '0',
            potResultJson: result.perSeat,
            settledAt: new Date(),
          })
          .where(eq(pokerCashHands.id, existing.id));
      } else {
        await tx.insert(pokerCashHands).values({
          tableId,
          handNumber: result.handNumber,
          serverSeedCommit: hashCommit(result.serverSeedRevealed),
          serverSeedReveal: result.serverSeedRevealed,
          clientSeed: DEFAULT_CLIENT_SEED,
          boardJson: result.board,
          potTotalCt: String(potTotal),
          rakeTakenCt: '0',
          potResultJson: result.perSeat,
          settledAt: new Date(),
        });
      }

      // ── Cross-game history (cove_game_events) — one row per REAL (non-seeded)
      // subject per hand. Keyed userId (no guest tier on a CT ring table). This
      // is what makes a cash hand READABLE under /api/cove/history and counted by
      // the economy monitor's GROUP BY game_type — same write+read {user,agent}
      // resolution as the route (subject-keying keystone). Seeded agents skipped.
      //
      // NONCE ENCODING: cove_game_events is unique on (game_type, session_id,
      // nonce) but we write MULTIPLE rows per hand (one per seat), so the bare
      // handNumber would collide. We pack seatIndex into the low digits:
      //   nonce = handNumber * SEAT_NONCE_STRIDE + seatIndex   (seatIndex 0..7).
      // The /verify branch recovers (handNumber, seatIndex) = divmod(nonce,
      // STRIDE). serverSeedReveal is the post-settle reveal (parent hand closed),
      // so the row carries the revealed seed immediately (a cash hand is its own
      // commit-reveal unit — there is no multi-hand shoe to keep open).
      for (const ps of result.perSeat) {
        const seat = seatByIndex.get(ps.seatIndex);
        if (!seat || seat.isSeeded === 'true') continue;
        const userId = userIdByAvatar.get(seat.avatarId) ?? null;
        if (!userId) continue; // a real seat with no owning user — skip (no XOR subject).
        await tx.insert(coveGameEvents).values({
          userId,
          guestFpHash: null,
          gameType: 'poker',
          sessionId: tableId,
          shoeId: tableId,
          betAmount: String(ps.totalCommitted),
          payout: String(ps.won),
          outcomeJson: {
            seatIndex: ps.seatIndex,
            handNumber: result.handNumber,
            totalCommitted: ps.totalCommitted,
            won: ps.won,
            net: ps.net,
            status: ps.status,
            isWinner: ps.isWinner,
            handRankCategory: ps.handRankCategory,
            // Only the OWN seat's hole cards (showdown reveal) — never another
            // seat's. perSeat already nulls holeCards for mucked/folded seats.
            holeCards: ps.holeCards,
            board: result.board,
          },
          serverSeedHash: hashCommit(result.serverSeedRevealed),
          revealedServerSeed: result.serverSeedRevealed,
          clientSeed: DEFAULT_CLIENT_SEED,
          nonce: result.handNumber * SEAT_NONCE_STRIDE + ps.seatIndex,
          txSignature: null,
          engineVersion: `poker-cash-${POKER_CASH_ENGINE_VERSION}`,
        });
      }
    });
  }

  // ── Seeded agents (TRIVIAL STUB policy) ─────────────────────────────────────

  /**
   * Fill empty seats with seeded agents up to the table's `seeded_agent_slots`, but
   * only enough to reach a minimum of 2 occupied funded seats so a single human can
   * play. Seeded agents are subject_type='agent', is_seeded=true. Their chips are
   * REAL-CT-backed by a DEBIT against the house bank (CT-supply conservation —
   * concern g), and returned to the house bank on the seeded agent's leave. A seeded
   * provider WITHOUT a house bank is a faucet and is REFUSED here.
   */
  private async fillSeededAgents(table: PokerCashTable): Promise<void> {
    if (!this.seededAgentProvider || table.seededAgentSlots <= 0) return;
    // A seeded provider with no house bank would mint chips → refuse loudly.
    if (!this.houseBankAvatarProvider) {
      throw new CashTableError(
        'seeded_agent_requires_house_bank',
        'seededAgentProvider is set but no houseBankAvatarProvider — seeded chips would be minted',
        500,
      );
    }
    const seats = await this.activeSeats(table.id);
    const occupied = seats.filter((s) => Number(s.currentStackCt) > 0 || s.status === 'sitting_in');
    const seededCount = seats.filter((s) => s.isSeeded === 'true').length;

    // How many MORE seeded agents to add: enough to reach 2 occupied, capped by the
    // remaining slot budget and the open seats.
    const want = Math.max(0, 2 - occupied.length);
    const budget = table.seededAgentSlots - seededCount;
    const toAdd = Math.min(want, budget, table.maxSeats - occupied.length);
    if (toAdd <= 0) return;

    const houseBankAvatarId = await this.houseBankAvatarProvider(table.id);
    const buyIn = Number(table.buyInCt);
    let live = [...seats];
    for (let i = 0; i < toAdd; i++) {
      const seatIndex = this.firstOpenSeatIndex(live, table.maxSeats);
      if (seatIndex === null) break;
      const a = await this.seededAgentProvider(table.id, seatIndex);
      const subject: CashSubject = {
        kind: 'agent',
        userId: a.avatarId, // seeded agent: its own avatar is its identity anchor
        avatarId: a.avatarId,
        agentId: a.agentId,
        name: a.name,
      };
      await this.seatSubject(
        table,
        subject,
        seatIndex,
        buyIn,
        /* isSeeded */ true,
        /* fundSourceAvatarId */ houseBankAvatarId,
      );
      live = await this.activeSeats(table.id);
    }
  }

  /**
   * Drive every SEEDED agent whose turn it currently is, using the trivial stub
   * policy below, until it is a non-seeded seat's turn or the hand ends. Bounded by
   * a generous step cap (defensive against any pointer bug). Settlement of a hand
   * the agents close is handled by the caller's `settleIfComplete`.
   *
   * // STUB AGENT POLICY (P1 — REPLACE WITH REAL AGENT POKER AI LATER):
   * //   - if nothing is owed (toCall === 0): CHECK.
   * //   - if facing a bet: CALL, UNLESS the call is larger than ~half the stack,
   * //     in which case FOLD. Never bets/raises. Just enough to COMPLETE hands.
   */
  private async driveSeededAgents(tableId: string): Promise<void> {
    const sid = simTableId(tableId);
    const seededAvatarIds = await this.seededAvatarIds(tableId);
    if (seededAvatarIds.size === 0) return;

    let guard = 0;
    while (guard++ < 200) {
      const snap = this.sim.getPublicSnapshot(sid);
      if (!snap || snap.toActSeatIndex === null) return;
      if (this.handIsOver(sid)) return;
      const actingSeat = snap.seats.find((s) => s.seatIndex === snap.toActSeatIndex);
      if (!actingSeat) return;
      if (!seededAvatarIds.has(actingSeat.avatarId)) return; // a human/real agent must act

      const view = this.sim.getSeatViewForAgent(sid, actingSeat.avatarId);
      if (!view || !view.isYourTurn) return;

      const action = this.stubAgentAction(view.toCall, view.chipStack, view.legalActions);
      const seq = guard; // monotonic per-agent step (unique idempotency within the hand)
      const res = this.sim.applyAction(sid, actingSeat.avatarId, action, {
        idempotencyKey: `${view.handNumber}:seed:${guard}:${actingSeat.avatarId}`,
      });
      if (!res.ok) return; // stop on any rejection (defensive)
      if (res.handComplete) return;
    }
  }

  /** The trivial stub decision (labeled in driveSeededAgents). */
  private stubAgentAction(
    toCall: number,
    chipStack: number,
    legalActions: ReadonlyArray<string>,
  ): Action {
    if (toCall === 0) {
      if (legalActions.includes('check')) return { kind: 'check' };
      // Defensive: should always be able to check when nothing owed.
      return { kind: 'fold' };
    }
    // Facing a bet: fold only when it costs more than ~half the stack.
    if (toCall > chipStack / 2) {
      return { kind: 'fold' };
    }
    if (legalActions.includes('call')) return { kind: 'call' };
    return { kind: 'fold' };
  }

  private async seededAvatarIds(tableId: string): Promise<Set<string>> {
    const seats = await this.activeSeats(tableId);
    return new Set(seats.filter((s) => s.isSeeded === 'true').map((s) => s.avatarId));
  }

  // ── Small helpers ───────────────────────────────────────────────────────────

  private async requireOpenTable(tableId: string): Promise<PokerCashTable> {
    const table = await this.getTable(tableId);
    if (!table) throw new CashTableError('no_such_table', 'table not found', 404);
    if (table.status !== 'open') {
      throw new CashTableError('table_closed', 'table is closed', 409);
    }
    return table;
  }

  private firstOpenSeatIndex(
    activeSeats: PokerCashSeat[],
    maxSeats: number,
  ): number | null {
    const taken = new Set(activeSeats.map((s) => s.seatIndex));
    for (let i = 0; i < maxSeats; i++) {
      if (!taken.has(i)) return i;
    }
    return null;
  }

  private async nextHandNumber(tableId: string): Promise<number> {
    const [row] = await this.db
      .select({ handNumber: pokerCashHands.handNumber })
      .from(pokerCashHands)
      .where(eq(pokerCashHands.tableId, tableId))
      .orderBy(desc(pokerCashHands.handNumber))
      .limit(1);
    return (row?.handNumber ?? 0) + 1;
  }

  /** True once the current sim hand has resolved (snapshot at terminal street, no actor). */
  private handIsOver(sid: string): boolean {
    const snap = this.sim.getPublicSnapshot(sid);
    if (!snap) return true;
    // resolveHand sets toActSeatIndex=null + street='showdown' (or terminal). The
    // sim deletes the table only on stopTable, so a finished-but-not-stopped hand
    // shows toActSeatIndex===null. Pending result is the authoritative signal.
    if (this.pendingResults.has(sid)) return true;
    return snap.toActSeatIndex === null && snap.street === 'showdown';
  }

  /**
   * CONSERVATION HELPER (tests + invariant checks): at rest (no hand in flight),
   * table_escrow_ct MUST equal the sum of active seats' current_stack_ct.
   */
  async assertConservation(tableId: string): Promise<{
    escrow: number;
    seatSum: number;
    ok: boolean;
  }> {
    const table = await this.getTable(tableId);
    if (!table) throw new CashTableError('no_such_table', 'table not found', 404);
    const seats = await this.activeSeats(tableId);
    const seatSum = seats.reduce((a, s) => a + Number(s.currentStackCt), 0);
    const escrow = Number(table.tableEscrowCt);
    return { escrow, seatSum, ok: escrow === seatSum };
  }
}

/** sha256 commit of the revealed seed, for the audit row. */
function hashCommit(serverSeed: string): string {
  return sha256Hex(serverSeed);
}
