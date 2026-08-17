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
  coveTestFixtureRuns,
  avatars,
  type PokerCashTable,
  type PokerCashSeat,
} from '@clawville/database';
import { and, eq, asc, desc, gt, ne, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import type {
  CashSettledHandSnapshot,
  CashSettledSeat,
  HoldemCard,
  SettledPotResult,
} from '@clawville/shared';
import * as ledgerModule from '../claw-token-ledger';
import { createServerSeed, sha256Hex } from '../provable-rng';
import { shuffleDeck } from '../holdem-engine';
import { PokerTableSim } from './poker-table-sim';
import { cashTableSim } from './cash-table-sim-singleton';
import { houseFillTargetSeats } from './cash-house-config';
import { cashHouseSeeder, CashBotPoolExhaustedError } from './cash-house-seeder';
import { REAL_CLOCK } from './poker-table-types';
import {
  chargeFixtureExposure,
  consumeFixtureArm,
  fixtureEnabled,
  hasPendingHoldemCashFixtureArm,
  resolveCashFixtureServerSeed,
} from '../cove-test-fixture';
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

export interface CashFixtureAuth {
  header: string;
  ownerAvatarId: string;
}

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
  /**
   * Process-local reservation coordinator. Production defaults to
   * `cashHouseSeeder`; tests may inject a deterministic pool.
   */
  seededAgentReservationController?: {
    bindReservation(tableId: string, seatIndex: number, avatarId: string): boolean;
    release(tableId: string, seatIndex: number): void;
  };
  /** W-F FIX-D2 staging-only organic-tick yield seams. */
  fixtureEnabled?: () => boolean;
  hasPendingHoldemCashFixtureArm?: (
    ownerAvatarIds: readonly string[],
    now?: Date,
  ) => Promise<boolean>;
  /** Existing fixture consumer, injectable only so the headered binding path is unit-testable. */
  consumeFixtureArm?: typeof consumeFixtureArm;
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

const DEFAULT_TURN_CLOCK_MS = 20_000;
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
/** Settled-result presentation window; the next hand still starts immediately. */
export const CASH_SETTLED_DISPLAY_WINDOW_MS = 8_000;

type PersistedCashSettledSeat = Omit<CashSettledSeat, 'shown'>;

interface PersistedCashSettledHand {
  tableId: string;
  handNumber: number;
  board: HoldemCard[];
  endedAt: CashSettledHandSnapshot['endedAt'];
  pots: SettledPotResult[];
  seats: PersistedCashSettledSeat[];
  serverSeed: string;
  clientSeed: string;
  settledAt: Date;
}

/**
 * Rebuild the exact terminal wire object from durable, non-requester-masked
 * state. Hole cards are deterministically re-dealt from the revealed seed and
 * historical seat indices, then the frozen entitlement policy is applied.
 */
export function buildCashSettledHandSnapshot(
  hand: PersistedCashSettledHand,
): CashSettledHandSnapshot {
  const orderedSeatIndices = hand.seats
    .map((seat) => seat.seatIndex)
    .sort((a, b) => a - b);
  const deck = shuffleDeck({
    serverSeed: hand.serverSeed,
    clientSeed: hand.clientSeed,
    nonce: hand.handNumber,
  });
  const holeBySeat = new Map<number, [HoldemCard, HoldemCard]>();
  let top = 0;
  for (let round = 0; round < 2; round++) {
    for (const seatIndex of orderedSeatIndices) {
      const current = holeBySeat.get(seatIndex) ?? [deck[top]!, deck[top]!] as [
        HoldemCard,
        HoldemCard,
      ];
      current[round] = deck[top++]!;
      holeBySeat.set(seatIndex, current);
    }
  }

  const settledAtMs = hand.settledAt.getTime();
  return {
    handId: `${hand.tableId}:${hand.handNumber}`,
    handNumber: hand.handNumber,
    tableId: hand.tableId,
    board: hand.board,
    endedAt: hand.endedAt,
    pots: hand.pots,
    seats: hand.seats.map((seat) => ({
      ...seat,
      shown:
        hand.endedAt === 'showdown' && seat.status !== 'folded'
          ? holeBySeat.get(seat.seatIndex) ?? null
          : null,
    })),
    settledAtMs,
    displayExpiresAtMs: settledAtMs + CASH_SETTLED_DISPLAY_WINDOW_MS,
  };
}

/** Historical-hand authorization; deliberately independent of current seating. */
export function assertCashSettledHandEntitlement(
  seats: readonly PersistedCashSettledSeat[],
  requesterAvatarId: string,
): void {
  if (!seats.some((seat) => seat.avatarId === requesterAvatarId)) {
    throw new CashTableError(
      'not_historical_participant',
      'requester did not participate in this settled hand',
      403,
    );
  }
}

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

class SeededSeatCollisionError extends Error {
  constructor(public readonly avatarId: string) {
    super(`seeded avatar ${avatarId} already has an active cash seat`);
    this.name = 'SeededSeatCollisionError';
  }
}

function isPgUniqueViolation(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth++) {
    const record = cursor as { code?: unknown; cause?: unknown };
    if (record.code === '23505') return true;
    cursor = record.cause;
  }
  return false;
}

/** A `poker_cash_tables` sim tableId is the table's own uuid (one table = one uuid). */
function simTableId(tableId: string): string {
  return `cash:${tableId}`;
}

/**
 * Inverse of `simTableId`: recover the table uuid from a `cash:<uuid>` sim id.
 * Returns null if the id is not in the cash namespace (the turn-timeout hook is
 * registered on the dedicated cash sim, so every fired id is `cash:`-prefixed, but
 * we guard defensively so a foreign id is ignored rather than mis-locked).
 */
function unwrapSimTableId(simTid: string): string | null {
  return simTid.startsWith('cash:') ? simTid.slice('cash:'.length) : null;
}

export class CashTableManager {
  private readonly db: DbLike;
  private readonly ledger: LedgerLike;
  private readonly sim: PokerTableSim;
  private readonly clock: SimClock;
  private readonly seedFn: () => string;
  private readonly seededAgentProvider: CashTableManagerDeps['seededAgentProvider'];
  private readonly houseBankAvatarProvider: CashTableManagerDeps['houseBankAvatarProvider'];
  private readonly seededAgentReservationController: NonNullable<
    CashTableManagerDeps['seededAgentReservationController']
  >;
  private readonly fixtureEnabled: NonNullable<CashTableManagerDeps['fixtureEnabled']>;
  private readonly hasPendingHoldemCashFixtureArm: NonNullable<
    CashTableManagerDeps['hasPendingHoldemCashFixtureArm']
  >;
  private readonly consumeFixtureArm: NonNullable<CashTableManagerDeps['consumeFixtureArm']>;

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
    this.seededAgentReservationController =
      deps.seededAgentReservationController ?? cashHouseSeeder;
    this.fixtureEnabled = deps.fixtureEnabled ?? fixtureEnabled;
    this.hasPendingHoldemCashFixtureArm =
      deps.hasPendingHoldemCashFixtureArm ?? hasPendingHoldemCashFixtureArm;
    this.consumeFixtureArm = deps.consumeFixtureArm ?? consumeFixtureArm;

    // This manager EXCLUSIVELY owns the hand-complete handler on ITS sim instance.
    // The sim fires it synchronously inside resolveHand; we just capture the result
    // so the action/timeout caller that triggered resolution can settle it under
    // the same table lock (no re-entrant async settle inside the sim callback).
    this.sim.setHandCompleteFn((tid, result) => {
      this.pendingResults.set(tid, result);
    });

    // TURN-CLOCK OWNERSHIP: route the sim's expired-turn auto-fold/auto-check
    // through THIS manager so it runs UNDER the per-table lock and SETTLES the
    // hand it resolves in the same critical section. Without this, the sim's
    // armed `setTimeout` fired `onTurnTimeout` directly — mutating the SimTable +
    // advancing + resolving the hand OUTSIDE `withTableLock` (racing a concurrent
    // human action mid-suspension-point) and leaving an undrained `pendingResults`
    // entry that no tick drains on a no-tick (player-public/private) table (CT
    // stranded in escrow forever). `handleTurnTimeout` closes both holes.
    // The sim hands us only the sim tableId (`cash:<uuid>`); recover the table uuid.
    this.sim.setTurnTimeoutHook((simTid) => {
      const tableId = unwrapSimTableId(simTid);
      if (!tableId) return;
      void this.handleTurnTimeout(tableId);
    });
  }

  /**
   * Resolve an EXPIRED turn clock UNDER the per-table lock and settle in the same
   * pass. The sim's armed timer fires this (via `setTurnTimeoutHook`) instead of
   * calling `onTurnTimeout` directly. We acquire `withTableLock(tableId)` — the
   * SAME mutex the REST sit/leave/action + tick path uses — so the auto-fold/auto-
   * check can NEVER interleave with a human action mid-suspension-point, then:
   *   1. `sim.onTurnTimeout` — auto-check (nothing owed) or auto-fold the to-act
   *      seat and advance; if that closes the hand the sim fires `handCompleteFn`
   *      → `pendingResults`.
   *   2. `driveSeededAgents` — if the timeout handed action to a bot, it acts now
   *      (advisor) rather than waiting for its own clock to expire.
   *   3. `settleIfComplete` — apply the chip deltas + persist the checkpoint +
   *      stop the sim hand for the hand the timeout (or the bots) resolved, so NO
   *      undrained `pendingResults` is ever left on ANY table (house OR no-tick
   *      player-public/private) — escrow can never stay inflated vs Σ stacks.
   *   4. if no live hand remains → `startAndAdvance` for the next one.
   *
   * Errors are swallowed (logged): a timer callback has no caller to surface to,
   * and the per-table lock + the sim's defensive guards keep one stuck table from
   * spinning. Idempotent-by-construction: if the lock-holder already resolved the
   * turn, `onTurnTimeout` is a no-op (no seat to act) and `settleIfComplete` finds
   * no pending result.
   */
  async handleTurnTimeout(tableId: string): Promise<void> {
    try {
      await this.withTableLock(tableId, async () => {
        const sid = simTableId(tableId);
        // The lock-holder we waited on may have already acted for this seat (the
        // human beat the clock). onTurnTimeout is a no-op then (toActSeatIndex
        // changed / hand ended), so this is safe to call unconditionally.
        this.sim.onTurnTimeout(sid);
        await this.settleIfComplete(tableId);
        await this.driveSeededAgents(tableId);
        await this.settleIfComplete(tableId);
        if (!this.sim.getPublicSnapshot(sid)) {
          await this.startAndAdvance(tableId);
        }
      });
    } catch (err) {
      console.error(`[cash-manager] handleTurnTimeout failed for ${tableId}:`, err);
    }
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

    // ── HOUSE-TABLE SCOPE GUARD (defense-in-depth, 2026-06-22) ───────────────
    // `source='house'` tables fill with house-bank-debited bots and are
    // self-driven by the boot tick. They may ONLY be created by the house
    // auto-scaler, which constructs its creator subject from the house-bank
    // avatar (`houseBankAvatarProvider`). A normal user/agent must NEVER be able
    // to stand one up — that would hand any caller a house-bank-funded bot table
    // on demand (a house-bank exposure/drain vector). The route already drops
    // 'house' from its create enum (the primary gate); this is the belt-and-
    // braces gate at the manager so a future caller/refactor can't bypass it.
    // Resolve the house-bank avatar and require the creator to BE it. If no house
    // bank is wired at all (bots disabled), no house table can be created.
    if (config.source === 'house') {
      const houseBankAvatarId = this.houseBankAvatarProvider
        ? await this.houseBankAvatarProvider('')
        : null;
      if (!houseBankAvatarId || creator.avatarId !== houseBankAvatarId) {
        throw new CashTableError(
          'house_table_creation_forbidden',
          "source='house' tables may only be created by the house auto-scaler",
          403,
        );
      }
    }

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

  /**
   * EAGER LOBBY SEAT (OPTION B, founder-approved 2026-06-22) — seat the house bots
   * at a `source='house'` table WITHOUT dealing a hand, so the lobby shows the
   * "always populated" ~`seededAgentSlots` bots per table even with no human/agent
   * yet. The scaler calls this right after `createTable` (and the boot tick re-runs
   * it as a self-heal). It tops up bots toward the lobby/fill target (idempotent —
   * re-running never double-seats, only fills the deficit), debiting the HOUSE BANK
   * for each seeded buy-in exactly as the normal fill does (treasury-banked, the
   * existing no-faucet guard unchanged). This locks a BOUNDED amount of CT in escrow
   * (≈ Σ houseTables × seededAgentSlots × buyIn) — NOT an unbounded drain, because
   * idle bots never re-buy (the deal-gate keeps a bot-only table from playing, and
   * `rebuyBustedBots` is real-player-gated).
   *
   * Crucially it does NOT start a hand: `maybeStartHand` only deals once a real
   * player sits, so these seated bots sit idle (stacks frozen) until then. Runs
   * under the per-table lock (same mutex as sit/leave/action) so it can't interleave
   * with a concurrent human sit. A no-op for non-house tables / no seeded provider.
   */
  async seatHouseBots(tableId: string): Promise<void> {
    return this.withTableLock(tableId, async () => {
      const table = await this.getTable(tableId);
      if (!table || table.status !== 'open') return;
      if (table.source !== 'house') return;
      if (!this.seededAgentProvider || table.seededAgentSlots <= 0) return;
      // Seat bots toward the lobby target WITHOUT re-buying or dealing.
      await this.fillSeededAgents(table, { lobbyOnly: true });
    });
  }

  /**
   * Retire one obsolete open house table when it is safe to do so.
   *
   * The live-hand and human-seat guards run under the same per-table mutex as
   * sit/leave. Busted human seats and seeded stacks are released exclusively
   * through `cashOutSeat`; the final close is allowed only after a fresh FOR UPDATE
   * read proves escrow reached zero. Returns true only when this call closed the
   * table.
   */
  async retireHouseTable(tableId: string): Promise<boolean> {
    return this.withTableLock(tableId, async () => {
      const table = await this.getTable(tableId);
      if (!table || table.source !== 'house' || table.status !== 'open') return false;

      const sid = simTableId(tableId);
      const handLive = !!this.sim.getPublicSnapshot(sid) && !this.handIsOver(sid);
      if (handLive) return false;

      const seats = await this.activeSeats(tableId);
      if (
        seats.some(
          (seat) => seat.isSeeded === 'false' && Number(seat.currentStackCt) !== 0,
        )
      ) {
        console.log(`[cash-manager] keeping obsolete house table ${tableId}: active human seat`);
        return false;
      }

      for (const seat of seats) {
        if (seat.isSeeded === 'true' || Number(seat.currentStackCt) === 0) {
          await this.cashOutSeat(table, seat);
        }
      }

      return this.db.transaction(async (tx) => {
        const rows = await tx.execute<{
          source: string;
          status: string;
          table_escrow_ct: string;
        }>(
          sql`SELECT source, status, table_escrow_ct
              FROM poker_cash_tables WHERE id = ${tableId} FOR UPDATE`,
        );
        const lockedTable = rows[0];
        if (!lockedTable || lockedTable.source !== 'house' || lockedTable.status !== 'open') {
          return false;
        }

        const escrow = Number(lockedTable.table_escrow_ct);
        if (!Number.isFinite(escrow) || escrow !== 0) {
          console.error(
            `[cash-manager] refusing to close obsolete house table ${tableId}: escrow ${escrow} CT remains`,
          );
          return false;
        }

        await tx
          .update(pokerCashTables)
          .set({ status: 'closed', updatedAt: new Date() })
          .where(eq(pokerCashTables.id, tableId));
        return true;
      });
    });
  }

  /**
   * Release one abandoned busted human/agent seat after the scaler discovers it.
   * The scaler owns the ten-minute age filter; this lock-held path re-checks the
   * money and hand-safety predicates immediately before the idempotent zero-credit
   * cash-out. Applies to every cash-table source.
   */
  async releaseBustedSeat(tableId: string, seatId: string): Promise<boolean> {
    return this.withTableLock(tableId, async () => {
      const table = await this.getTable(tableId);
      if (!table) return false;

      const sid = simTableId(tableId);
      const handLive = !!this.sim.getPublicSnapshot(sid) && !this.handIsOver(sid);
      if (handLive) return false;

      const seat = (await this.activeSeats(tableId)).find((candidate) => candidate.id === seatId);
      if (!seat || seat.isSeeded !== 'false' || Number(seat.currentStackCt) !== 0) {
        return false;
      }

      await this.cashOutSeat(table, seat);
      return true;
    });
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

  /**
   * Latest durable BA-1 snapshot newer than `afterHandNumber`.
   *
   * Authorization is intentionally evaluated against the hand's persisted seat
   * accounting, never live seating: a participant may leave immediately after
   * settlement and still recover the hand, while a never-seated subject gets 403.
   */
  async getLastSettledHand(
    tableId: string,
    requesterAvatarId: string,
    afterHandNumber: number,
  ): Promise<CashSettledHandSnapshot | null> {
    const table = await this.getTable(tableId);
    if (!table) {
      throw new CashTableError('no_such_table', 'table not found', 404);
    }

    const [row] = await this.db
      .select()
      .from(pokerCashHands)
      .where(
        and(
          eq(pokerCashHands.tableId, tableId),
          gt(pokerCashHands.handNumber, afterHandNumber),
          isNotNull(pokerCashHands.settledAt),
          isNotNull(pokerCashHands.seatResultJson),
          isNotNull(pokerCashHands.endedAt),
        ),
      )
      .orderBy(desc(pokerCashHands.handNumber))
      .limit(1);

    if (!row) return null;
    const seats = row.seatResultJson ?? [];
    assertCashSettledHandEntitlement(seats, requesterAvatarId);
    if (
      !row.settledAt ||
      !row.serverSeedReveal ||
      !row.boardJson ||
      !row.potResultJson ||
      !row.endedAt
    ) {
      throw new CashTableError(
        'settled_snapshot_incomplete',
        'settled hand is missing BA-1 persistence fields',
        500,
      );
    }

    return buildCashSettledHandSnapshot({
      tableId,
      handNumber: row.handNumber,
      board: row.boardJson as HoldemCard[],
      endedAt: row.endedAt as CashSettledHandSnapshot['endedAt'],
      pots: row.potResultJson,
      seats,
      serverSeed: row.serverSeedReveal,
      clientSeed: row.clientSeed,
      settledAt: row.settledAt,
    });
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

  private async latestLedgerTxnId(
    tableId: string,
    seatId: string,
    kind: 'buy_in' | 'cash_out',
  ): Promise<string | null> {
    const [event] = await this.db
      .select({ ledgerTxnId: pokerCashLedgerEvents.ledgerTxnId })
      .from(pokerCashLedgerEvents)
      .where(
        and(
          eq(pokerCashLedgerEvents.tableId, tableId),
          eq(pokerCashLedgerEvents.seatId, seatId),
          eq(pokerCashLedgerEvents.kind, kind),
        ),
      )
      .orderBy(desc(pokerCashLedgerEvents.createdAt))
      .limit(1);
    return event?.ledgerTxnId ?? null;
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
    // LAZY SETTLE-ON-READ (belt-and-braces, 2026-06-22): if a hand resolved but is
    // not yet settled (a `pendingResults` entry survives — e.g. a timeout-resolved
    // hand on a no-tick player-public/private table where the timeout hook somehow
    // could not complete), drain it UNDER the lock BEFORE reading so a public read
    // never reports an escrow inflated vs Σ seat stacks. No-op (cheap lock acquire)
    // when nothing is pending — the common case. The settle is idempotent.
    if (this.pendingResults.has(simTableId(tableId))) {
      await this.withTableLock(tableId, async () => {
        await this.settleIfComplete(tableId);
      });
    }
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
    fixtureAuth?: CashFixtureAuth,
  ): Promise<{
    seatIndex: number;
    stackCt: string;
    alreadySeated: boolean;
    buyInLedgerTxnId: string | null;
  }> {
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
          `buy_in must equal the table buy-in (${buyIn} vCLAW)`,
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
          buyInLedgerTxnId: await this.latestLedgerTxnId(
            tableId,
            existing.id,
            'buy_in',
          ),
        };
      }

      const seatIndex = this.firstOpenSeatIndex(seats, table.maxSeats);
      if (seatIndex === null) {
        throw new CashTableError('table_full', 'no open seat at this table', 409);
      }

      const buyInLedgerTxnId = await this.seatSubject(
        table,
        subject,
        seatIndex,
        buyIn,
        /* isSeeded */ false,
        undefined,
        fixtureAuth,
        seats,
      );

      await this.startAndAdvance(tableId, fixtureAuth);

      return {
        seatIndex,
        stackCt: String(buyIn),
        alreadySeated: false,
        buyInLedgerTxnId,
      };
    });
  }

  /**
   * Start a hand if ready, then drive any seeded-agent turns and settle if the
   * agents close it (a fold-around or check-down between two seeded agents would
   * otherwise hang waiting for a human poke). Lock is already held by the caller.
   */
  private async startAndAdvance(
    tableId: string,
    fixtureAuth?: CashFixtureAuth,
    yieldToPendingFixtureArm = false,
  ): Promise<void> {
    const started = await this.maybeStartHand(
      tableId,
      fixtureAuth,
      yieldToPendingFixtureArm,
    );
    if (!started) return;
    // BOT-YIELD: if real players grew at this house table, queue seeded bots to
    // stand up at the NEXT between-hands boundary (keeping ≥2 players), so real
    // players are prioritized for the seats. Queues only — never disrupts the hand
    // that just started; processPendingLeaves cashes them back to the bank.
    await this.queueBotYield(tableId);
    await this.driveSeededAgents(tableId);
    await this.settleIfComplete(tableId);
  }

  /** Resolve a private table by join code then sit the subject down. */
  async joinByCode(
    joinCode: string,
    subject: CashSubject,
  ): Promise<{
    tableId: string;
    seatIndex: number;
    stackCt: string;
    alreadySeated: boolean;
    buyInLedgerTxnId: string | null;
  }> {
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
    fixtureAuth?: CashFixtureAuth,
    fixtureSeats?: PokerCashSeat[],
  ): Promise<string | null> {
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
    const seatResult = await this.db.transaction(async (tx) => {
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
      if (isSeeded) {
        // FIX-D: reservations are process-local while seat rows are durable. Reconcile
        // any active seeded row BEFORE the house-bank debit. This read-only collision
        // signal deliberately touches no stack, escrow, totals, status, or ledger.
        const activeRows = await tx
          .select({ id: pokerCashSeats.id })
          .from(pokerCashSeats)
          .where(
            and(
              eq(pokerCashSeats.avatarId, subject.avatarId),
              ne(pokerCashSeats.status, 'left'),
            ),
          )
          .limit(1);
        if (activeRows.length > 0) {
          throw new SeededSeatCollisionError(subject.avatarId);
        }
      }
      if (fixtureAuth && !isSeeded) {
        const charge = await chargeFixtureExposure(tx, {
          header: fixtureAuth.header,
          ownerAvatarId: fixtureAuth.ownerAvatarId,
          arm: 'holdem-cash',
          legStakeCt: buyIn,
        });
        if (!charge?.ok) return { kind: 'fixture-exhausted' as const };
        const competitors = fixtureSeats ?? [];
        if (competitors.some((seat) => seat.isSeeded !== 'true')) {
          throw new CashTableError(
            'fixture_cash_requires_isolated_table',
            'fixture_cash_requires_isolated_table',
            409,
          );
        }
        const fundedSittingIn = competitors.filter(
          (seat) =>
            seat.isSeeded === 'true' &&
            seat.status === 'sitting_in' &&
            BigInt(seat.currentStackCt) > 0n,
        );
        const requiredCompetitors =
          charge.fixture.name === 'holdem-multiway-showdown' ? 2 : 1;
        if (fundedSittingIn.length < requiredCompetitors) {
          throw new CashTableError(
            charge.fixture.name === 'holdem-multiway-showdown'
              ? 'fixture_cash_requires_three_seats'
              : 'fixture_cash_requires_funded_opponents',
            charge.fixture.name === 'holdem-multiway-showdown'
              ? 'fixture_cash_requires_three_seats'
              : 'fixture_cash_requires_funded_opponents',
            409,
          );
        }
      }

      const res = await this.ledger.debitClawTokens(
        {
          avatarId: debitAvatarId,
          amount: buyIn,
          reason: isSeeded ? 'poker_cash_house_seed' : 'poker_cash_buy_in',
          source: 'simulation',
          metadata: { tableId: table.id, seatIndex, seeded: isSeeded },
          actorKind: isSeeded ? 'system' : subject.kind === 'agent' ? 'agent' : 'human',
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

      return { kind: 'seated' as const, escrowAfter, ledgerTxnId };
    });
    if (seatResult.kind === 'fixture-exhausted') {
      throw new CashTableError('fixture_budget_exhausted', 'fixture_budget_exhausted', 402);
    }
    const { escrowAfter: newEscrow, ledgerTxnId } = seatResult;

    // Keep the caller's in-memory table view consistent after the committed tx.
    table.tableEscrowCt = String(newEscrow);
    return ledgerTxnId;
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
  ): Promise<{
    cashedOutCt: number;
    queued: boolean;
    cashOutLedgerTxnId: string | null;
  }> {
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
        return { cashedOutCt: 0, queued: true, cashOutLedgerTxnId: null };
      }

      const cashOut = await this.cashOutSeat(table, seat);
      return { ...cashOut, queued: false };
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
  private async cashOutSeat(
    table: PokerCashTable,
    seat: PokerCashSeat,
  ): Promise<{ cashedOutCt: number; cashOutLedgerTxnId: string | null }> {
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
    const { stack, newEscrow, ledgerTxnId } = await this.db.transaction(async (tx) => {
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
      if (!lockedSeat) {
        return {
          stack: 0,
          newEscrow: Number(table.tableEscrowCt),
          ledgerTxnId: null,
        };
      }
      // Already cashed out (idempotent replay) — do NOT credit again.
      if (lockedSeat.status === 'left') {
        return {
          stack: 0,
          newEscrow: Number(table.tableEscrowCt),
          ledgerTxnId: null,
        };
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
            amount: lockedStack,
            reason: isSeeded ? 'poker_cash_house_reclaim' : 'poker_cash_cash_out',
            source: 'simulation',
            metadata: { tableId: table.id, seatIndex: seat.seatIndex, seeded: isSeeded },
            actorKind: isSeeded ? 'system' : seat.subjectType === 'agent' ? 'agent' : 'human',
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

      return { stack: lockedStack, newEscrow: escrowAfter, ledgerTxnId };
    });

    // A SEEDED seat that just left frees its bot pool reservation so the same bot
    // uuid can recycle to a new (table,seat). Harmless no-op for an injected/test
    // bot that was never tracked by the seeder (release of an unmapped seat is a
    // no-op), so this keeps the manager test-injectable while the production pool
    // recycles promptly. Done OUTSIDE the tx (pure in-memory).
    if (isSeeded) {
      cashHouseSeeder.release(table.id, seat.seatIndex);
    }

    // Keep the caller's in-memory table view consistent after the committed tx.
    table.tableEscrowCt = String(newEscrow);
    return { cashedOutCt: stack, cashOutLedgerTxnId: ledgerTxnId };
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
      const current = this.sim.getPublicSnapshot(sid);
      if (!current || current.handNumber !== input.handNumber) {
        return { ok: false, reason: 'stale_hand_number' };
      }
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

  // ── Autonomous self-drive (the boot TICK's entry point) ─────────────────────

  /**
   * Advance ONE house table by one tick, WITHOUT any human poke. This is the
   * entry point the boot `cash-table-tick` calls on every open `source='house'`
   * table on its ~1.5s cadence so a table that HAS A REAL PLAYER keeps dealing: a
   * bot on the button acts via the advisor policy, a closed hand settles, and the
   * next hand auto-starts. Everything runs under the SAME `withTableLock(tableId)`
   * the REST sit/leave/action path uses, so the tick can never interleave with a
   * human action — it adds NO new money path, only re-uses
   * `driveSeededAgents` / `settleIfComplete` / `startAndAdvance` / `seatHouseBots`.
   *
   * OPTION B (founder-approved 2026-06-22): for a BOT-ONLY table (every sitting-in
   * seat is a seeded bot, no human/agent) this is a NO-OP for dealing — it deals NO
   * new hand and re-buys NO busted bot (both gated on a real player downstream), so
   * the bots sit idle with FROZEN stacks and the bankroll never churns. It DOES keep
   * the lobby populated: it eagerly tops up the seated bots toward the lobby target
   * (`seatHouseBots`, idempotent, bounded house-bank debit) so a freshly-scaled or
   * partially-emptied house table always shows ~`seededAgentSlots` bots ready for a
   * player to sit into.
   *
   * Ordering (all lock-held):
   *   1. driveSeededAgents — a seeded seat whose turn it is in a LIVE hand acts now
   *      (advisor). A bot-only table has no live hand, so this is a no-op there.
   *   2. settleIfComplete  — if the bots (or a prior human action) closed the hand,
   *      apply the chip deltas + persist the checkpoint + stop the sim hand.
   *   3. if no live sim snapshot remains → startAndAdvance → maybeStartHand. That
   *      DEALS only when ≥1 real player is sitting in (the Option B gate); a
   *      bot-only table returns false and stays idle.
   *   4. lobby self-heal — eagerly seat bots toward the lobby target (no deal) so an
   *      under-populated house table refills its seated bots for the lobby look.
   *
   * A no-op for dealing/money on an idle bot-only table; never throws (the tick
   * loop's per-table try/catch is the backstop, and the lock + the sim's defensive
   * guards keep a single stuck table from spinning).
   */
  async advanceTable(tableId: string): Promise<void> {
    await this.withTableLock(tableId, async () => {
      const sid = simTableId(tableId);
      // 1+2: progress any live hand the bots can move, settle if they closed it.
      await this.driveSeededAgents(tableId);
      await this.settleIfComplete(tableId);
      // 3: no live hand left → try to start + advance the next one. maybeStartHand
      // DEALS only when a real player is present (Option B gate); a bot-only table
      // returns false here and stays idle (no deal, no re-buy, no bank churn).
      if (!this.sim.getPublicSnapshot(sid)) {
        await this.startAndAdvance(tableId, undefined, true);
      }
    });
    // 4: lobby self-heal — keep the seated-bot count topped up toward the lobby
    // target so the "always populated" look survives a table that lost bots (e.g.
    // bots that busted during real play and were not re-bought after the player
    // left). Idempotent + bounded; its own lock acquire is cheap. Done AFTER the
    // deal pass so we never seat a bot mid-deal. No-op once at target.
    await this.seatHouseBots(tableId);
  }

  // ── Hand lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start a hand when the table has ≥2 sitting-in seats AND ≥1 REAL player, and
   * no live hand. Fills empty seats with seeded agents up to `seeded_agent_slots`
   * first (so a single human can play). The button rotates by hand number (P1
   * keeps it simple).
   */
  async startHandWhenReady(tableId: string): Promise<boolean> {
    return this.withTableLock(tableId, async () => this.maybeStartHand(tableId));
  }

  /**
   * OPTION B GATE (founder-approved 2026-06-22) — a house table deals a hand ONLY
   * when ≥1 REAL player is sitting in. A "REAL player" is any sitting-in seat with
   * `isSeeded === false` — this INCLUDES a connected/hosted agent (subject_type
   * 'agent' but NOT seeded), so E5 human/agent parity holds: an agent sitting also
   * triggers dealing. A table whose only sitting-in seats are seeded bots stays
   * IDLE — no new hand deals, no bankroll churn — which is what stops the 24/7
   * bot-vs-bot bankroll drain while KEEPING the bots seated for the populated-lobby
   * look. Tested against the LIVE seat shape (sitting-in + not seeded).
   */
  private tableHasRealPlayer(seats: PokerCashSeat[]): boolean {
    return seats.some(
      (s) =>
        s.status === 'sitting_in' &&
        Number(s.currentStackCt) > 0 &&
        s.isSeeded !== 'true',
    );
  }

  /** INTERNAL (lock already held): try to start a hand. Returns whether one started. */
  private async maybeStartHand(
    tableId: string,
    fixtureAuth?: CashFixtureAuth,
    yieldToPendingFixtureArm = false,
  ): Promise<boolean> {
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

    // OPTION B SHORT-CIRCUIT — no REAL player sitting in ⇒ do NOT deal AND do NOT
    // fill/re-buy bots. A bot-only house table stays idle: its already-seated bots
    // keep their (constant) stacks, the autonomous tick is a no-op for it, and the
    // house bank is NEVER debited for an idle re-buy. We read the CURRENT seats
    // (the eager-seated bots are already here from the scaler) WITHOUT filling, so
    // an idle table never crosses the ledger. Only once a real player sits does
    // fillSeededAgents run (below) + a hand deal.
    const currentSeats = await this.activeSeats(tableId);
    if (!this.tableHasRealPlayer(currentSeats)) return false;

    // W-F FIX-D2: on staging with the deterministic fixture enabled, the
    // autonomous organic tick yields while any SITTING-IN REAL player's avatar
    // owns an unconsumed, unexpired holdem-cash arm. The fixture-headered request
    // bypasses this read-only guard and remains the sole authoritative consumer.
    // Production never executes the query because fixtureEnabled() is false.
    if (yieldToPendingFixtureArm && !fixtureAuth && this.fixtureEnabled()) {
      const realPlayerAvatarIds = currentSeats
        .filter(
          (seat) =>
            seat.status === 'sitting_in' &&
            Number(seat.currentStackCt) > 0 &&
            seat.isSeeded !== 'true',
        )
        .map((seat) => seat.avatarId);
      if (await this.hasPendingHoldemCashFixtureArm(realPlayerAvatarIds)) return false;
    }

    // A real player is present → top up / re-buy bots toward the fill target, then
    // deal. fillSeededAgents itself re-checks the real-player gate before any
    // re-buy (no idle re-buy), but we have already confirmed a real player here.
    await this.fillSeededAgents(table);

    const seats = await this.activeSeats(tableId);
    const sittingIn = seats.filter((s) => s.status === 'sitting_in' && Number(s.currentStackCt) > 0);
    if (sittingIn.length < 2) return false;

    const handNumber = await this.nextHandNumber(tableId);
    const seatAssignments: SeatAssignment[] = sittingIn.map((s) => ({
      seatIndex: s.seatIndex,
      avatarId: s.avatarId,
      name: s.subjectType === 'agent' ? `Agent ${s.seatIndex}` : `Player ${s.seatIndex}`,
      subjectType: s.subjectType === 'agent' ? 'agent' : 'human',
      agentId: s.agentId ?? undefined,
      chipStack: Number(s.currentStackCt),
    }));
    const indices = sittingIn.map((s) => s.seatIndex).sort((a, b) => a - b);
    const buttonSeatIndex = indices[handNumber % indices.length]!;
    const blinds = {
      sb: Number(table.smallBlindCt),
      bb: Number(table.bigBlindCt),
      ante: 0,
    };
    let serverSeed = this.seedFn();
    let clientSeed = DEFAULT_CLIENT_SEED;
    let fixtureRunId: string | null = null;
    if (fixtureAuth) {
      const fixtureResult = await this.db.transaction(async (tx) => {
        const consumption = await this.consumeFixtureArm(tx, {
          header: fixtureAuth.header,
          ownerAvatarId: fixtureAuth.ownerAvatarId,
          arm: 'holdem-cash',
        });
        if (!consumption) {
          throw new CashTableError('fixture_not_armed', 'fixture header did not arm a hand', 409);
        }
        if (!consumption.ok) return { kind: 'fixture-exhausted' as const };
        const armed = consumption.fixture;
        const fixtureServerSeed = resolveCashFixtureServerSeed({
          scenario: armed,
          handNumber,
          buttonSeatIndex,
          ownerAvatarId: fixtureAuth.ownerAvatarId,
          seats: seatAssignments.map((seat) => ({
            ...seat,
            isSeeded:
              sittingIn.find((row) => row.avatarId === seat.avatarId)?.isSeeded === 'true',
          })),
          blinds,
        });
        await tx.insert(pokerCashHands).values({
          fixtureRunId: armed.runId,
          tableId,
          handNumber,
          serverSeedCommit: hashCommit(fixtureServerSeed),
          // Fixture seeds are deterministic catalog values. Persist their reveal
          // on the private placeholder so hard-death recovery can tombstone the
          // commitment without erasing its audit trail.
          serverSeedReveal: fixtureServerSeed,
          clientSeed: armed.clientSeed,
        });
        return {
          kind: 'armed' as const,
          fixture: { ...armed, serverSeed: fixtureServerSeed },
        };
      });
      if (fixtureResult.kind === 'fixture-exhausted') {
        throw new CashTableError(
          'fixture_budget_exhausted',
          'fixture budget exhausted',
          402,
        );
      }
      const fixture = fixtureResult.fixture;
      serverSeed = fixture.serverSeed;
      clientSeed = fixture.clientSeed;
      fixtureRunId = fixture.runId;
    }

    try {
      this.sim.startHand({
        tableId: sid,
        handNumber,
        seatAssignments,
        blinds,
        buttonSeatIndex,
        serverSeed,
        clientSeed,
        turnClockMs: DEFAULT_TURN_CLOCK_MS,
        agentTurnGraceMs: DEFAULT_AGENT_TURN_GRACE_MS,
      });
    } catch (error) {
      if (fixtureRunId) {
        // Compensate the durable reservation if the in-memory sim refused to
        // start. This restores the one-shot so a retry can arm; no settled BA-1
        // row or history event can observe the placeholder.
        await this.db.transaction(async (tx) => {
          await tx
            .delete(pokerCashHands)
            .where(
              and(
                eq(pokerCashHands.tableId, tableId),
                eq(pokerCashHands.handNumber, handNumber),
                eq(pokerCashHands.fixtureRunId, fixtureRunId),
                isNull(pokerCashHands.settledAt),
              ),
            );
          await tx
            .update(coveTestFixtureRuns)
            .set({ consumedAt: null })
            .where(
              and(
                eq(coveTestFixtureRuns.runId, fixtureRunId),
                eq(coveTestFixtureRuns.status, 'active'),
              ),
            );
        });
      }
      throw error;
    }
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

      const existingRows = await tx.execute<{
        id: string;
        settled_at: Date | string | null;
        fixture_run_id: string | null;
        client_seed: string;
      }>(
        sql`SELECT id, settled_at, fixture_run_id, client_seed FROM poker_cash_hands
            WHERE table_id = ${tableId} AND hand_number = ${result.handNumber}
            FOR UPDATE`,
      );
      const existing = existingRows[0];
      if (existing?.settled_at) return; // replay — already applied under the lock.

      const seats = await this.activeSeats(tableId);
      const seatByIndex = new Map(seats.map((s) => [s.seatIndex, s]));
      const settledSeats: PersistedCashSettledSeat[] = result.perSeat.map((ps) => {
        const seat = seatByIndex.get(ps.seatIndex);
        if (!seat) {
          throw new CashTableError(
            'settlement_seat_missing',
            `seat ${ps.seatIndex} disappeared before settlement`,
            500,
          );
        }
        const start = Number(seat.currentStackCt);
        const end = start - ps.totalCommitted + ps.won;
        const net = ps.won - ps.totalCommitted;
        return {
          seatIndex: ps.seatIndex,
          avatarId: ps.avatarId,
          startStack: String(start),
          endStack: String(end),
          totalCommitted: String(ps.totalCommitted),
          grossWon: String(ps.won),
          rakeAttributed: '0',
          net: String(net),
          stackDelta: String(end - start),
          status: ps.status,
          mucked: ps.status === 'folded',
        };
      });

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
      for (const settledSeat of settledSeats) {
        const seat = seatByIndex.get(settledSeat.seatIndex)!;
        await tx
          .update(pokerCashSeats)
          .set({ currentStackCt: settledSeat.endStack, updatedAt: new Date() })
          .where(eq(pokerCashSeats.id, seat.id));
      }

      // Persist the hand checkpoint (idempotency anchor settled_at = now()).
      const settledAt = new Date(this.clock.now());
      if (existing) {
        await tx
          .update(pokerCashHands)
          .set({
            serverSeedReveal: result.serverSeedRevealed,
            boardJson: result.board,
            potTotalCt: String(potTotal),
            rakeTakenCt: '0',
            potResultJson: result.settledPots,
            seatResultJson: settledSeats,
            endedAt: result.endedAt,
            settledAt,
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
          potResultJson: result.settledPots,
          seatResultJson: settledSeats,
          endedAt: result.endedAt,
          settledAt,
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
          fixtureRunId: existing?.fixture_run_id ?? null,
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
          clientSeed: existing?.client_seed ?? DEFAULT_CLIENT_SEED,
          nonce: result.handNumber * SEAT_NONCE_STRIDE + ps.seatIndex,
          txSignature: null,
          engineVersion: `poker-cash-${POKER_CASH_ENGINE_VERSION}`,
        });
      }
    });
  }

  // ── Seeded agents (TRIVIAL STUB policy) ─────────────────────────────────────

  private async reconcileSeededReservation(
    tableId: string,
    claimedSeatIndex: number,
    avatarId: string,
  ): Promise<'free' | 'same-table' | 'other-table'> {
    const activeRows = await this.db
      .select()
      .from(pokerCashSeats)
      .where(
        and(
          eq(pokerCashSeats.avatarId, avatarId),
          ne(pokerCashSeats.status, 'left'),
        ),
      )
      .orderBy(asc(pokerCashSeats.seatIndex));

    const sameTable = activeRows.find((seat) => seat.tableId === tableId);
    if (sameTable) {
      this.seededAgentReservationController.bindReservation(
        tableId,
        sameTable.seatIndex,
        avatarId,
      );
      console.warn(
        `[cash-table-manager] reconciled seeded bot ${avatarId} to existing ` +
          `${tableId} seat ${sameTable.seatIndex} (claimed seat ${claimedSeatIndex}); zero money effects`,
      );
      return 'same-table';
    }
    if (activeRows.length > 0) {
      this.seededAgentReservationController.bindReservation(
        activeRows[0]!.tableId,
        activeRows[0]!.seatIndex,
        avatarId,
      );
      console.warn(
        `[cash-table-manager] skipped seeded bot ${avatarId}: active at ` +
          `${activeRows[0]!.tableId} seat ${activeRows[0]!.seatIndex}; zero money effects`,
      );
      return 'other-table';
    }
    return 'free';
  }

  /**
   * Fill empty seats with seeded agents toward `CASH_HOUSE_FILL_TARGET_SEATS`
   * (default 3 — a solo human + up to ~2 bots, a small live game, NOT a packed
   * 6-max felt), capped by the table's `seeded_agent_slots`, the open seats, and
   * (the bot-yield rule) the number of REAL occupied seats so real players are
   * always prioritized. Seeded agents are subject_type='agent', is_seeded=true.
   * Their chips are REAL-CT-backed by a DEBIT against the house bank (CT-supply
   * conservation — concern g), returned to the house bank on the seeded agent's
   * leave. A seeded provider WITHOUT a house bank is a faucet and is REFUSED here.
   *
   * SCOPE (locked): seeding is gated to `source='house'` tables ONLY. A
   * player-public or private table NEVER fills with bots even if its
   * `seededAgentSlots` were somehow > 0 — the seeded provider must only ever be
   * exercised for house tables.
   *
   * POOL EXHAUSTION: the per-seat provider call is wrapped so a
   * `CashBotPoolExhaustedError` (the singleton's seam throws it when the bot pool is
   * fully reserved) simply stops the fill (seats fewer bots) rather than aborting a
   * human's sit. M=24 ≫ 15 concurrent so this is a defensive belt-and-braces.
   *
   * BOT RE-BUY (OPTION B — real-player-gated): a seeded seat that busted to 0 chips
   * is re-bought via the SAME house-bank-debited path at this between-hands boundary
   * ONLY while ≥1 REAL player is present, so a populated table doesn't bleed bots
   * during real play while the bank's exposure stays bounded. A bot busting with NO
   * real player present is simply freed (no idle re-buy) — that re-buy-on-bust loop
   * was the 24/7 bankroll drain.
   *
   * EAGER LOBBY SEAT (OPTION B): when the scaler calls this with `lobbyOnly=true`
   * right after `createTable`, it seats bots toward the lobby target WITHOUT any
   * re-buy (a fresh table has no busted bots) so the table shows ~`seededAgentSlots`
   * seated bots in the lobby — but NO hand deals until a real player sits (that gate
   * is in `maybeStartHand`). Idempotent: re-running the scaler tops up only to the
   * target, never double-seats.
   */
  private async fillSeededAgents(
    table: PokerCashTable,
    opts: { lobbyOnly?: boolean } = {},
  ): Promise<void> {
    if (!this.seededAgentProvider || table.seededAgentSlots <= 0) return;
    // SCOPE GUARD: bots seed HOUSE tables only — never player-public / private.
    if (table.source !== 'house') return;
    // A seeded provider with no house bank would mint chips → refuse loudly.
    if (!this.houseBankAvatarProvider) {
      throw new CashTableError(
        'seeded_agent_requires_house_bank',
        'seededAgentProvider is set but no houseBankAvatarProvider — seeded chips would be minted',
        500,
      );
    }

    const houseBankAvatarId = await this.houseBankAvatarProvider(table.id);
    const buyIn = Number(table.buyInCt);

    // ── Step 1: re-buy busted bots (seeded seats at 0 chips) so the table stays
    // populated DURING REAL PLAY. OPTION B: gated on a REAL player being present —
    // an idle (bot-only) table NEVER re-buys a busted bot (that was the drain).
    // `rebuyBustedBots` re-checks the gate internally; we skip it entirely in the
    // eager lobby-seat path (a fresh table has no busted bots to recycle anyway).
    if (!opts.lobbyOnly) {
      await this.rebuyBustedBots(table, houseBankAvatarId, buyIn);
    }

    // ── Step 2: top up toward the fill target.
    const seats = await this.activeSeats(table.id);
    // "occupied" = any seat still in play (funded or sitting-in waiting for the
    // next deal). Used both for the fill target and the bot-yield cap.
    const occupied = seats.filter((s) => Number(s.currentStackCt) > 0 || s.status === 'sitting_in');
    const realOccupied = occupied.filter((s) => s.isSeeded !== 'true').length;
    const seededCount = seats.filter((s) => s.isSeeded === 'true').length;

    // Target TOTAL occupied seats (human + bots), clamped so we never exceed the
    // bot cap or the felt. The bot-yield rule lives in `queueBotYield` (below); here
    // we only ADD up to the target — never above it.
    const target = Math.min(houseFillTargetSeats(), table.seededAgentSlots + realOccupied, table.maxSeats);
    const want = Math.max(0, target - occupied.length);
    const budget = table.seededAgentSlots - seededCount;
    const toAdd = Math.min(want, budget, table.maxSeats - occupied.length);
    if (toAdd <= 0) return;

    let live = await this.activeSeats(table.id);
    // A stale process-local pool may have to skip several bots that are active on
    // other tables. Bound the repair loop so a broken custom provider cannot spin.
    const maxAttempts = 64;
    let attempts = 0;
    while (attempts++ < maxAttempts) {
      const occupiedNow = live.filter(
        (s) => Number(s.currentStackCt) > 0 || s.status === 'sitting_in',
      );
      const realNow = occupiedNow.filter((s) => s.isSeeded !== 'true').length;
      const seededNow = live.filter((s) => s.isSeeded === 'true').length;
      const targetNow = Math.min(
        houseFillTargetSeats(),
        table.seededAgentSlots + realNow,
        table.maxSeats,
      );
      if (
        occupiedNow.length >= targetNow ||
        seededNow >= table.seededAgentSlots ||
        occupiedNow.length >= table.maxSeats
      ) {
        break;
      }

      const seatIndex = this.firstOpenSeatIndex(live, table.maxSeats);
      if (seatIndex === null) break;
      let a: { avatarId: string; agentId: string; name: string };
      try {
        a = await this.seededAgentProvider(table.id, seatIndex);
      } catch (err) {
        // Pool exhausted (M=24 ≫ concurrent need) — seat fewer bots, never crash a
        // human's sit. Any other provider error is a real fault → rethrow.
        if (err instanceof CashBotPoolExhaustedError) break;
        throw err;
      }
      const beforeDebit = await this.reconcileSeededReservation(
        table.id,
        seatIndex,
        a.avatarId,
      );
      if (beforeDebit !== 'free') {
        live = await this.activeSeats(table.id);
        continue;
      }
      const subject: CashSubject = {
        kind: 'agent',
        userId: a.avatarId, // seeded agent: its own avatar is its identity anchor
        avatarId: a.avatarId,
        agentId: a.agentId,
        name: a.name,
      };
      try {
        await this.seatSubject(
          table,
          subject,
          seatIndex,
          buyIn,
          /* isSeeded */ true,
          /* fundSourceAvatarId */ houseBankAvatarId,
        );
      } catch (err) {
        // The pre-debit read closes restart divergence. A concurrent process can
        // still win after that read; the DB unique constraint rolls our whole tx
        // back (including the debit). Re-read, bind/skip, and retry with zero money
        // effects from the losing attempt.
        if (err instanceof SeededSeatCollisionError || isPgUniqueViolation(err)) {
          const reconciled = await this.reconcileSeededReservation(
            table.id,
            seatIndex,
            a.avatarId,
          );
          if (reconciled === 'free') {
            // A seat-index race can produce 23505 without the claimed avatar winning.
            // Drop this stale target reservation, refresh the roster, and retry.
            this.seededAgentReservationController.release(table.id, seatIndex);
          }
          live = await this.activeSeats(table.id);
          continue;
        }
        throw err;
      }
      live = await this.activeSeats(table.id);
    }
  }

  /**
   * Re-seat seeded bots that busted to 0 chips at the between-hands boundary, so a
   * populated house table stays populated over many hands DURING REAL PLAY. The
   * busted bot's seat is cashed out first (0 stack ⇒ no credit, just freed + bot
   * reservation released) and the top-up loop re-seats toward the target with a
   * fresh house-bank-debited bot — conservation holds (the seed debit is the only
   * money move; the 0-stack reclaim is a no-op credit).
   *
   * OPTION B GATE (founder-approved 2026-06-22): re-buy fires ONLY when ≥1 REAL
   * player is present. With NO human/agent at the table a busted bot is NOT
   * re-bought — it simply stays busted/idle — because the idle re-buy-on-bust loop
   * (a busted bot re-buying from the bank 24/7 with no human) was THE bankroll
   * drain. During real play, re-buy is fine: those chips were won by the
   * human/agent, so CT is conserved. Note: with the `maybeStartHand` deal-gate, a
   * bot-only table never deals, so its bots never bust — this gate is the
   * belt-and-braces that also covers the post-real-player-leave window (a bot left
   * short-stacked after the human leaves is not re-funded).
   */
  private async rebuyBustedBots(
    table: PokerCashTable,
    houseBankAvatarId: string,
    buyIn: number,
  ): Promise<void> {
    const seats = await this.activeSeats(table.id);
    // OPTION B: no idle re-buy. Only recycle busted bots while a real player is here.
    if (!this.tableHasRealPlayer(seats)) return;
    const busted = seats.filter((s) => s.isSeeded === 'true' && Number(s.currentStackCt) <= 0);
    if (busted.length === 0) return;

    for (const seat of busted) {
      // Free the busted seat (0 stack ⇒ cashOutSeat credits nothing). cashOutSeat
      // releases the bot pool reservation for the seeded seat, so the same bot uuid
      // can recycle to a new (table,seat) on the next fill claim.
      await this.cashOutSeat(table, seat);
    }
    // The top-up loop in fillSeededAgents re-seats toward the target using fresh
    // claims, so we don't re-seat here — just freeing the busted seats is enough.
  }

  /**
   * BOT-YIELD: when REAL (non-seeded) players GROW at a house table past the small-
   * game fill target, stand the EXCESS seeded bots up between hands so real players
   * get the seats — ALWAYS keeping ≥2 total players so the table never dies. This
   * does NOT thrash against the fill: it only ever yields bots that are SURPLUS to
   * `max(fillTarget, 2)` total seats. Steady state for a solo human is human + bots
   * up to the fill target (no yield); when reals join and push total occupancy above
   * the target, the matching number of bots stand up so the felt isn't bots crowding
   * out real players, while the floor of 2 keeps a lone human with an opponent.
   *
   * Queued via the existing `pendingLeaves` path (the seeded seat flips to
   * 'sitting_out' for the next deal and is cashed back to the house bank at the
   * between-hands boundary by `processPendingLeaves`). Called from `startAndAdvance`
   * after a hand starts so a human who just sat reclaims a bot seat next hand. Lock
   * is held by the caller.
   */
  private async queueBotYield(tableId: string): Promise<void> {
    const seats = await this.activeSeats(tableId);
    const inPlay = seats.filter((s) => s.status === 'sitting_in' && Number(s.currentStackCt) > 0);
    const realInPlay = inPlay.filter((s) => s.isSeeded !== 'true').length;
    const seededInPlay = inPlay.filter((s) => s.isSeeded === 'true');
    if (seededInPlay.length === 0 || realInPlay === 0) return;

    // The table should carry at most `max(fillTarget, 2)` total players (the small-
    // game target, never below the 2-player floor). Bots surplus to that — once real
    // players occupy seats — yield. We also never drop below 2 total players.
    const cap = Math.max(houseFillTargetSeats(), 2);
    const totalInPlay = inPlay.length;
    // Surplus seats above the small-game cap (only positive once reals pushed the
    // table over the target). Bounded so we keep ≥2 total players.
    const surplus = Math.max(0, totalInPlay - cap);
    const floorRoom = Math.max(0, totalInPlay - 2);
    const toYield = Math.min(seededInPlay.length, surplus, floorRoom);
    if (toYield <= 0) return;

    let set = this.pendingLeaves.get(tableId);
    if (!set) {
      set = new Set<string>();
      this.pendingLeaves.set(tableId, set);
    }
    // Yield the HIGHEST-indexed bots first (stable, deterministic) so freed seats are
    // predictable. Flip them to sitting_out now so they're excluded from the next
    // deal; processPendingLeaves cashes them back to the bank at the boundary.
    const yieldSeats = [...seededInPlay].sort((a, b) => b.seatIndex - a.seatIndex).slice(0, toYield);
    for (const seat of yieldSeats) {
      if (set.has(seat.avatarId)) continue;
      await this.db
        .update(pokerCashSeats)
        .set({ status: 'sitting_out', updatedAt: new Date() })
        .where(eq(pokerCashSeats.id, seat.id));
      set.add(seat.avatarId);
    }
  }

  /**
   * Drive every SEEDED agent whose turn it currently is, until it is a non-seeded
   * seat's turn or the hand ends. Bounded by a generous step cap (defensive against
   * any pointer bug). Settlement of a hand the agents close is handled by the
   * caller's `settleIfComplete`.
   *
   * POLICY (P1): the sim's already-built, already-tested advisor
   * `getActionAdvice(sid, avatarId).recommended` — a hand-strength + pot-odds +
   * position heuristic that value-bets strong hands, calls price-justified medium
   * hands, and folds trash to bets (roughly break-even, NOT a CT faucet/sink). The
   * advisor's `recommended` is guaranteed to be a LEGAL action with raise/bet
   * `amount` pre-clamped into `[minRaiseTo, maxRaiseTo]`, so `applyAction` never
   * bounces. The trivial `stubAgentAction` survives ONLY as a null-fallback for the
   * (shouldn't-happen on-turn) case where the advisor returns `recommended===null`,
   * so a bot never stalls a hand.
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

      // Advisor-driven decision (hand strength + pot odds + position). The advice's
      // recommended action is already legal + amount-clamped; fall back to the
      // trivial stub ONLY if the advisor declines to recommend (recommended null).
      const advice = this.sim.getActionAdvice(sid, actingSeat.avatarId);
      const action: Action =
        advice?.recommended ??
        this.stubAgentAction(view.toCall, view.chipStack, view.legalActions);

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
