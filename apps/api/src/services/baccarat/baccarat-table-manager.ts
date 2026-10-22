/**
 * Shared-table baccarat: `BaccaratTableManager` (2026-10-22 port of the June
 * Slice 1 manager, commit d5ca47db2, with defects D1-D12 fixed).
 *
 * Spec: `~/.clawville-brain/plans/baccarat-shared-table-port-2026-10-22.md`
 * sections 2 (behavior), 3.4 (public state, frozen), 5 (money safety), 6.3
 * (`placeAutonomousBet`, frozen signature).
 *
 * ── WHAT THIS OWNS ───────────────────────────────────────────────────────────
 * The PURE engine (`baccarat-engine.ts`) deals one coup and settles one bet. This
 * manager owns the layer around it: table + seat lifecycle, the round state
 * machine, and the per-seat vCLAW settle of ONE shared coup per round.
 *
 * ── ROUND STATE (persisted on the table row, D1) ─────────────────────────────
 *   idle ──(first real seat)──> betting(endsAt = now + window)
 *   betting ──(now >= endsAt, CAS)──> dealing
 *   dealing ──(settle commits, >=1 settled bet)──> reveal(now + reveal), round_seq + 1
 *   dealing ──(no pending bet: IDLE GATE / all void)──> betting | idle, round_seq + 1
 *   dealing ──(settle throws)──> dealing, settle_attempts + 1, retry after 1,2,4,8 s
 *   dealing ──(5th failure)──> pending bets void('settle_failed'), betting | idle, round_seq + 1
 *   reveal ──(now >= endsAt)──> betting(now + window) | idle
 * There is NO in-memory phase clock. Two API processes (a Coolify flip) are safe:
 * the CAS `UPDATE ... WHERE round_phase='betting' AND round_seq=$seq AND
 * phase_ends_at <= now` lets exactly one process claim the deal; the settle tx
 * locks the table row and re-checks phase, round, deadline and `settle_attempts`;
 * every bet UPDATE carries `AND status='pending'` and must touch exactly one row.
 * The per-table in-process `withTableLock` only reduces contention.
 *
 * ── MONEY MODEL ──────────────────────────────────────────────────────────────
 * No vCLAW moves at bet time. In the settle tx, per settled seat: debit the stake
 * (`cove_baccarat_table_stake`) and credit the gross payout when > 0
 * (`cove_baccarat_table_payout`, SOFT by ledger default), both through
 * `claw-token-ledger.ts` with `actorKind` from the bet row (D6). Avatars are locked
 * FOR UPDATE in id order BEFORE the affordability split (D7), so a debit can not
 * fail after the split; a seat that can not pay is `void` with a reason, moves no
 * vCLAW, writes no event row, and is outside the conservation set (D5).
 * Conservation per round over the SETTLED bets: Σ stake = Σ payout + houseEdge,
 * houseEdge = -Σ net (`assertRoundConservation`). The banker commission stays
 * withheld in the reduced payout; it is not a treasury credit.
 *
 * ── PROVABLY FAIR ────────────────────────────────────────────────────────────
 * Each table owns a commit-reveal shoe (`baccarat_shoes.table_id`). The shoe is
 * opened when the table is created and re-opened INSIDE the settle tx right after
 * the coup that crosses 75% penetration, so every bet is placed against a shoe
 * whose commit hash was public before the window opened. The closed shoe's seed
 * is revealed on every event row of that shoe in the same tx. Coup rows store the
 * placeholder bet 'player' + stake '1' (the engine refuses stake 0, D2); the real
 * money is on the bet rows. Per-seat event rows carry the EXACT
 * `serializeCoupResult` shape for the seat's own bet (no extra keys, D2) with
 * `nonce = coupIndex * BACCARAT_TABLE_SEAT_NONCE_STRIDE + seatIndex`.
 *
 * ── PARITY (E5) ──────────────────────────────────────────────────────────────
 * Every write takes a resolved `BaccaratTableSubject` (Lucia user's active avatar
 * or an agent session's bound avatar). Hosted agents reach the same path through
 * `placeAutonomousBet` (the `[ACTION: play_cove_game(game=baccarat)]` seam). No
 * guest kind exists here.
 *
 * ── SEEDED BOTS ──────────────────────────────────────────────────────────────
 * Visual only. Three guards keep them from ever betting: (1) only `seatHouseBots`
 * inserts a seeded seat; (2) `placeBet` refuses a seeded seat (403
 * `seeded_seat_cannot_bet`); (3) the settle tx aborts (critical alert) on any
 * pending bet whose avatar is a pool bot or holds a seeded seat at the table.
 */

import { randomBytes } from 'crypto';
import {
  db as realDb,
  avatars,
  baccaratCoups,
  baccaratShoes,
  baccaratTableBets,
  baccaratTableSeats,
  baccaratTables,
  coveGameEvents,
  type BaccaratTable,
  type BaccaratTableBet,
  type BaccaratTableSeat,
} from '@clawville/database';
import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import * as ledgerModule from '../claw-token-ledger';
import { alertError, type AlertErrorParams } from '../alert-error';
import { createServerSeed } from '../provable-rng';
import {
  BACCARAT_ENGINE_VERSION,
  RESHUFFLE_CARD_THRESHOLD,
  buildShoe,
  playCoupWithState,
  serializeCoupResult,
  settleBet,
  type Card,
  type SerializedCoupResult,
} from '../baccarat-engine';
import {
  autonomousCoveDailyAdvisoryKey,
  autonomousCoveDailyCapMessage,
  autonomousCoveDailyUsageQuery,
  parseAutonomousCoveDailyUsage,
} from '../autonomous-cove-wager-cap';
import {
  BACCARAT_TABLE_MAX_BET,
  BACCARAT_TABLE_MIN_BET,
  BACCARAT_TABLE_SEAT_NONCE_STRIDE,
  BaccaratTableError,
  baccaratTableActorKind,
  type BaccaratLobbyRow,
  type BaccaratTableActorKind,
  type BaccaratTableBetOrigin,
  type BaccaratTableBetSide,
  type BaccaratTablePhase,
  type BaccaratTablePublicState,
  type BaccaratTableRoundResult,
  type BaccaratTableSeatResult,
  type BaccaratTableSeatView,
  type BaccaratTableSubject,
  type BaccaratTableTier,
  type BaccaratTableVoidReason,
  type PlaceAutonomousBetInput,
  type PlaceAutonomousBetResult,
} from './baccarat-table-types';

// ── Injectable seams ─────────────────────────────────────────────────────────

type DbLike = typeof realDb;
/** The transaction handle passed to `db.transaction(async (tx) => ...)`. */
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];
type Executor = DbLike | TxLike;

type LedgerLike = {
  debitClawTokens: typeof ledgerModule.debitClawTokens;
  creditClawTokens: typeof ledgerModule.creditClawTokens;
};

/** Injected clock (Date.now by default) so tests drive every phase deadline. */
export interface BaccaratClock {
  now(): number;
}
const REAL_CLOCK: BaccaratClock = { now: () => Date.now() };

/** A bot the seeded pool hands to `seatHouseBots`. */
export interface ClaimedBaccaratBot {
  avatarId: string;
  agentId: string;
  name: string;
}

/**
 * The visual-only bot pool (the singleton wires `baccaratHouseSeeder`). The
 * manager never imports the seeder, so tests inject a deterministic pool.
 */
export interface BaccaratSeededBotPool {
  claim(tableId: string, seatIndex: number): ClaimedBaccaratBot | null | Promise<ClaimedBaccaratBot | null>;
  release(tableId: string, seatIndex: number): void;
  isBot(avatarId: string): boolean;
}

/** The live agent binding `placeAutonomousBet` re-resolves (resolveAgentSession shape). */
export interface ResolvedBaccaratAgent {
  userId: string | null;
  avatarId: string | null;
  agentId: string;
  ledgerCapable: boolean;
}

/** One settled seat, emitted AFTER the settle tx commits (spec 3.7). */
export interface BaccaratSettledSeatEvent {
  ownerUserId: string;
  avatarId: string;
  /** Set only when the bet's actor_kind is 'agent'. */
  agentId: string | null;
  actorKind: BaccaratTableActorKind;
  payload: {
    shared: true;
    tableId: string;
    roundSeq: number;
    shoeId: string;
    coupId: string;
    coupIndex: number;
    seatIndex: number;
    bet: BaccaratTableBetSide;
    stake: string;
    payout: string;
    net: string;
    winner: 'player' | 'banker' | 'tie';
    isAgent: boolean;
    origin: BaccaratTableBetOrigin;
  };
}

export interface BaccaratTableManagerDeps {
  db?: DbLike;
  ledger?: LedgerLike;
  clock?: BaccaratClock;
  /** Commit-reveal server-seed factory (64-hex + its sha256). */
  seedFn?: () => { serverSeed: string; serverSeedHash: string };
  /** Per-shoe client-seed factory (hex). */
  clientSeedFn?: () => string;
  /** Betting window (ms). Default 12000. */
  bettingWindowMs?: number;
  /** Reveal pause (ms). Default 4000. */
  revealPauseMs?: number;
  botPool?: BaccaratSeededBotPool;
  /** Alert sink. Default `alertError` (never throws). */
  alert?: (params: AlertErrorParams) => unknown;
  /** After-commit settle events. Default: `logEventReturningId` + `publishCoveSettlement`. */
  emitSettled?: (events: readonly BaccaratSettledSeatEvent[]) => void;
  /** Live agent-session resolver. Default: `resolveAgentSession` (lazy import). */
  resolveAgent?: (sessionId: string) => Promise<ResolvedBaccaratAgent | null>;
  /** House-agent check. Default: `isHouseAgentId` (lazy import). */
  isHouseAgent?: (agentId: string) => Promise<boolean>;
  /** Settle retry backoff after failure n (ms). Default 1000, 2000, 4000, 8000, 16000. */
  settleBackoffMs?: readonly number[];
  /** A real seat with no action for this long and no pending bet is freed. Default 10 min. */
  idleSeatMs?: number;
  /** In-memory TTL of the public part of `getTableState`. Default 500 ms. */
  publicCacheMs?: number;
}

/** Config for a new table (the scaler builds it from `baccarat-house-config.ts`). */
export interface CreateBaccaratTableConfig {
  source: 'house' | 'player-public' | 'private';
  visibility: 'public' | 'private';
  tierKey: BaccaratTableTier | null;
  minBetCt: number;
  maxBetCt: number;
  maxSeats: number;
  seededAgentSlots: number;
}

export const BACCARAT_BETTING_WINDOW_MS_DEFAULT = 12_000;
export const BACCARAT_REVEAL_PAUSE_MS_DEFAULT = 4_000;
/** Backoff after settle failure 1..5 (spec 5.4). */
export const BACCARAT_SETTLE_BACKOFF_MS_DEFAULT: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];
/** The 5th settle failure voids the round's pending bets (spec 5.4). */
export const BACCARAT_MAX_SETTLE_ATTEMPTS = 5;
/** An autonomous bet joins the open window only with at least this much time left (spec 5.2). */
export const BACCARAT_AUTONOMOUS_MIN_WINDOW_LEFT_MS = 1_000;
export const BACCARAT_IDLE_SEAT_MS_DEFAULT = 10 * 60_000;
const PUBLIC_CACHE_MS_DEFAULT = 500;

/** provable-rng requires a hex clientSeed. */
function defaultClientSeed(): string {
  return randomBytes(8).toString('hex');
}

function toDate(ms: number): Date {
  return new Date(ms);
}

function toMs(d: Date | string | null | undefined): number | null {
  if (d === null || d === undefined) return null;
  const v = (d instanceof Date ? d : new Date(d)).getTime();
  return Number.isFinite(v) ? v : null;
}

function isBetSide(v: unknown): v is BaccaratTableBetSide {
  return v === 'player' || v === 'banker' || v === 'tie';
}

function isTier(v: unknown): v is BaccaratTableTier {
  return v === 'low' || v === 'mid' || v === 'high';
}

function asPhase(v: string): BaccaratTablePhase {
  return v === 'betting' || v === 'dealing' || v === 'reveal' ? v : 'idle';
}

function pgUniqueViolation(err: unknown): { constraint: string } | null {
  const e = err as { code?: string; constraint_name?: string; constraint?: string } | undefined;
  if (e?.code !== '23505') return null;
  return { constraint: String(e.constraint_name ?? e.constraint ?? '') };
}

/**
 * Conservation for one resolved round (PURE). Over the SETTLED seats only:
 *   Σ stake === Σ payout + houseEdge, houseEdge === -Σ net, and each net === payout - stake.
 * Throws `conservation_violation` (500) when the identity breaks, so a refactor of the
 * settle loop can never silently mint or burn vCLAW. The edge may be negative in one
 * round (a tie bet pays 8:1); only the identity is asserted.
 */
export function assertRoundConservation(
  settlements: ReadonlyArray<{ stake: bigint; payout: bigint; commission: bigint; net: bigint }>,
): { totalStake: bigint; totalPayout: bigint; houseEdge: bigint } {
  let totalStake = 0n;
  let totalPayout = 0n;
  let totalNet = 0n;
  for (const s of settlements) {
    if (s.stake < 0n || s.payout < 0n || s.commission < 0n) {
      throw new BaccaratTableError(
        'conservation_violation',
        `negative stake/payout/commission in settlement (stake=${s.stake}, payout=${s.payout}, commission=${s.commission})`,
        500,
      );
    }
    if (s.net !== s.payout - s.stake) {
      throw new BaccaratTableError(
        'conservation_violation',
        `seat net ${s.net} != payout-stake ${s.payout - s.stake}`,
        500,
      );
    }
    totalStake += s.stake;
    totalPayout += s.payout;
    totalNet += s.net;
  }
  const houseEdge = totalStake - totalPayout;
  if (houseEdge !== -totalNet) {
    throw new BaccaratTableError(
      'conservation_violation',
      `houseEdge ${houseEdge} != -Σnet ${-totalNet} (Σstake=${totalStake}, Σpayout=${totalPayout})`,
      500,
    );
  }
  return { totalStake, totalPayout, houseEdge };
}

type ShoeRow = typeof baccaratShoes.$inferSelect;

/** Result of one settle tx. */
type SettleOutcome =
  | { kind: 'skipped' }
  | { kind: 'idle_gate' }
  | { kind: 'all_void'; alerts: AlertErrorParams[] }
  | { kind: 'settled'; events: BaccaratSettledSeatEvent[]; alerts: AlertErrorParams[] };

/** What one `tickRound` call did (tests + logs). */
export type BaccaratTickOutcome =
  | 'noop'
  | 'skipped'
  | 'idle_gate'
  | 'all_void'
  | 'settled'
  | 'settle_failed'
  | 'round_voided'
  | 'reveal_ended';

interface PublicPart {
  state: Omit<BaccaratTablePublicState, 'me' | 'serverNow'>;
  roundSeq: number;
}

type BetMode = { kind: 'rest'; roundSeq: number } | { kind: 'autonomous' };

export interface PlaceBetResult {
  roundSeq: number;
  seatIndex: number;
  bet: BaccaratTableBetSide;
  stake: number;
  bettingClosesAt: number | null;
}

export interface SitDownResult {
  seatIndex: number;
  alreadySeated: boolean;
  roundSeq: number;
  bettingClosesAt: number | null;
}

export interface LeaveTableResult {
  left: true;
  lockedBet: { roundSeq: number; bet: BaccaratTableBetSide; stake: number } | null;
}

export class BaccaratTableManager {
  private readonly db: DbLike;
  private readonly ledger: LedgerLike;
  private readonly clock: BaccaratClock;
  private readonly seedFn: () => { serverSeed: string; serverSeedHash: string };
  private readonly clientSeedFn: () => string;
  private readonly bettingWindowMs: number;
  private readonly revealPauseMs: number;
  private readonly botPool: BaccaratSeededBotPool | undefined;
  private readonly alert: (params: AlertErrorParams) => unknown;
  private readonly emitSettledFn: (events: readonly BaccaratSettledSeatEvent[]) => void;
  private readonly resolveAgent: (sessionId: string) => Promise<ResolvedBaccaratAgent | null>;
  private readonly isHouseAgent: (agentId: string) => Promise<boolean>;
  private readonly settleBackoffMs: readonly number[];
  private readonly idleSeatMs: number;
  private readonly publicCacheMs: number;

  /** Per-table async mutex (contention reducer only; the DB row lock is the guard). */
  private tableLocks = new Map<string, Promise<unknown>>();
  /** Public part of the table state, ≤ publicCacheMs old. `me` is never cached. */
  private publicCache = new Map<string, { at: number; part: PublicPart }>();

  constructor(deps: BaccaratTableManagerDeps = {}) {
    this.db = deps.db ?? realDb;
    this.ledger = deps.ledger ?? {
      debitClawTokens: (...args) => ledgerModule.debitClawTokens(...args),
      creditClawTokens: (...args) => ledgerModule.creditClawTokens(...args),
    };
    this.clock = deps.clock ?? REAL_CLOCK;
    this.seedFn = deps.seedFn ?? (() => createServerSeed());
    this.clientSeedFn = deps.clientSeedFn ?? defaultClientSeed;
    this.bettingWindowMs = deps.bettingWindowMs ?? BACCARAT_BETTING_WINDOW_MS_DEFAULT;
    this.revealPauseMs = deps.revealPauseMs ?? BACCARAT_REVEAL_PAUSE_MS_DEFAULT;
    this.botPool = deps.botPool;
    this.alert = deps.alert ?? ((params) => alertError(params));
    this.emitSettledFn = deps.emitSettled ?? defaultEmitSettled;
    this.resolveAgent = deps.resolveAgent ?? defaultResolveAgent;
    this.isHouseAgent = deps.isHouseAgent ?? defaultIsHouseAgent;
    this.settleBackoffMs =
      deps.settleBackoffMs && deps.settleBackoffMs.length > 0
        ? deps.settleBackoffMs
        : BACCARAT_SETTLE_BACKOFF_MS_DEFAULT;
    this.idleSeatMs = deps.idleSeatMs ?? BACCARAT_IDLE_SEAT_MS_DEFAULT;
    this.publicCacheMs = deps.publicCacheMs ?? PUBLIC_CACHE_MS_DEFAULT;
  }

  // ── Per-table serialization (port of cash-table-manager.ts withTableLock) ────

  private async withTableLock<T>(tableId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tableLocks.get(tableId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const tail = prior.then(() => gate).catch(() => gate);
    this.tableLocks.set(tableId, tail);
    await prior.catch(() => {});
    try {
      return await fn();
    } finally {
      // Any write path may have changed the public state.
      this.publicCache.delete(tableId);
      release();
      if (this.tableLocks.get(tableId) === tail) {
        this.tableLocks.delete(tableId);
      }
    }
  }

  private fireAlert(params: AlertErrorParams): void {
    try {
      void Promise.resolve(this.alert(params)).catch(() => {});
    } catch {
      /* an alert must never affect money or control flow */
    }
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Create a house table and open its first commit-reveal shoe in one tx, so the
   * commit hash is public before the first bet. v1 refuses every source except
   * 'house'. Pass `tx` to compose into the scaler's advisory-locked tx.
   */
  async createTable(
    config: CreateBaccaratTableConfig,
    createdByAvatarId: string | null,
    tx?: TxLike,
  ): Promise<BaccaratTable> {
    this.validateConfig(config);
    const run = async (ex: TxLike): Promise<BaccaratTable> => {
      const now = this.clock.now();
      const [row] = await ex
        .insert(baccaratTables)
        .values({
          source: config.source,
          visibility: config.visibility,
          tierKey: config.tierKey,
          minBetCt: config.minBetCt,
          maxBetCt: config.maxBetCt,
          maxSeats: config.maxSeats,
          seededAgentSlots: config.seededAgentSlots,
          createdBy: createdByAvatarId,
          status: 'open',
          roundPhase: 'idle',
          roundSeq: 0,
          settleAttempts: 0,
          createdAt: toDate(now),
          updatedAt: toDate(now),
        })
        .returning();
      if (!row) throw new BaccaratTableError('create_failed', 'table insert failed', 500);
      const shoe = await this.rollShoeTx(ex, row, null, now);
      return { ...row, activeShoeId: shoe.id };
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  private validateConfig(config: CreateBaccaratTableConfig): void {
    const { minBetCt, maxBetCt, maxSeats, seededAgentSlots } = config;
    if (config.source !== 'house') {
      throw new BaccaratTableError('table_source_not_supported', 'v1 serves house tables only', 400);
    }
    if (!Number.isInteger(minBetCt) || minBetCt <= 0) {
      throw new BaccaratTableError('invalid_min_bet', 'min_bet must be a positive integer', 400);
    }
    if (!Number.isInteger(maxBetCt) || maxBetCt < minBetCt) {
      throw new BaccaratTableError('invalid_max_bet', 'max_bet must be >= min_bet', 400);
    }
    if (minBetCt < BACCARAT_TABLE_MIN_BET || maxBetCt > BACCARAT_TABLE_MAX_BET) {
      throw new BaccaratTableError(
        'invalid_bet_bounds',
        `bet bounds must sit inside ${BACCARAT_TABLE_MIN_BET}..${BACCARAT_TABLE_MAX_BET}`,
        400,
      );
    }
    if (!Number.isInteger(maxSeats) || maxSeats < 2 || maxSeats > 8) {
      throw new BaccaratTableError('invalid_max_seats', 'max_seats must be 2..8', 400);
    }
    if (!Number.isInteger(seededAgentSlots) || seededAgentSlots < 0 || seededAgentSlots > maxSeats) {
      throw new BaccaratTableError('invalid_seeded_slots', 'seeded_agent_slots must be 0..max_seats', 400);
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async getTable(tableId: string): Promise<BaccaratTable | null> {
    const [row] = await this.db
      .select()
      .from(baccaratTables)
      .where(eq(baccaratTables.id, tableId))
      .limit(1);
    return row ?? null;
  }

  /** Open public tables for the lobby, lowest tier first (spec 3.4 `BaccaratLobbyRow`). */
  async listPublicTables(limit = 50): Promise<BaccaratLobbyRow[]> {
    const lim = Math.max(1, Math.min(50, Math.trunc(limit) || 50));
    const rows = await this.db
      .select()
      .from(baccaratTables)
      .where(and(eq(baccaratTables.visibility, 'public'), eq(baccaratTables.status, 'open')))
      .orderBy(asc(baccaratTables.minBetCt), asc(baccaratTables.createdAt))
      .limit(lim);
    const out: BaccaratLobbyRow[] = [];
    for (const t of rows) {
      if (!isTier(t.tierKey)) continue;
      const seats = await this.seatedSeats(this.db, t.id);
      const realSeats = seats.filter((s) => !s.isSeeded).length;
      const seededSeats = seats.length - realSeats;
      let lastWinner: BaccaratLobbyRow['lastWinner'] = null;
      if (t.lastCoupId) {
        const [coup] = await this.db
          .select({ outcomeJson: baccaratCoups.outcomeJson })
          .from(baccaratCoups)
          .where(eq(baccaratCoups.id, t.lastCoupId))
          .limit(1);
        const w = (coup?.outcomeJson as SerializedCoupResult | null | undefined)?.winner;
        lastWinner = isBetSide(w) ? w : null;
      }
      const phase = asPhase(t.roundPhase);
      out.push({
        tableId: t.id,
        tierKey: t.tierKey,
        minBet: t.minBetCt,
        maxBet: t.maxBetCt,
        maxSeats: t.maxSeats,
        realSeats,
        seededSeats,
        openSeats: Math.max(0, t.maxSeats - realSeats),
        phase,
        bettingClosesAt: phase === 'betting' ? toMs(t.phaseEndsAt) : null,
        lastWinner,
      });
    }
    return out;
  }

  /**
   * The table state of spec 3.4. Never the open shoe's serverSeed; never the cards of
   * a round before its settle commits (`lastRound` comes from `last_coup_id`, written
   * by the settle tx). `me` is built per call for the resolved subject.
   */
  async getTableState(
    tableId: string,
    subject?: BaccaratTableSubject | null,
  ): Promise<BaccaratTablePublicState | null> {
    const now = this.clock.now();
    let part: PublicPart | null = null;
    const cached = this.publicCache.get(tableId);
    if (cached && now - cached.at <= this.publicCacheMs) {
      part = cached.part;
    } else {
      part = await this.buildPublicPart(tableId);
      if (!part) return null;
      this.publicCache.set(tableId, { at: now, part });
    }
    const me = subject ? await this.buildMe(tableId, subject, part) : null;
    return { ...part.state, serverNow: now, me };
  }

  private async buildPublicPart(tableId: string): Promise<PublicPart | null> {
    const t = await this.getTable(tableId);
    if (!t || !isTier(t.tierKey)) return null;
    const phase = asPhase(t.roundPhase);
    const seats = await this.seatedSeats(this.db, tableId);
    const currentBets = await this.db
      .select()
      .from(baccaratTableBets)
      .where(
        and(
          eq(baccaratTableBets.tableId, tableId),
          eq(baccaratTableBets.roundSeq, t.roundSeq),
          eq(baccaratTableBets.status, 'pending'),
        ),
      );

    // Last settled round (written only by the committed settle tx).
    let lastRound: BaccaratTableRoundResult | null = null;
    let lastBets: BaccaratTableBet[] = [];
    let lastCoup: typeof baccaratCoups.$inferSelect | undefined;
    if (t.lastCoupId) {
      [lastCoup] = await this.db
        .select()
        .from(baccaratCoups)
        .where(eq(baccaratCoups.id, t.lastCoupId))
        .limit(1);
      if (lastCoup) {
        lastBets = await this.db
          .select()
          .from(baccaratTableBets)
          .where(and(eq(baccaratTableBets.coupId, lastCoup.id), eq(baccaratTableBets.status, 'settled')))
          .orderBy(asc(baccaratTableBets.seatIndex));
      }
    }

    const names = await this.avatarNames([
      ...seats.map((s) => s.avatarId),
      ...lastBets.map((b) => b.avatarId),
    ]);
    const nameOf = (avatarId: string, seatIndex: number): string =>
      names.get(avatarId)?.name || `Seat ${seatIndex + 1}`;

    const seatViews: BaccaratTableSeatView[] = seats.map((s) => {
      const bet = currentBets.find((b) => b.seatIndex === s.seatIndex && b.avatarId === s.avatarId);
      return {
        seatIndex: s.seatIndex,
        avatarId: s.avatarId,
        name: nameOf(s.avatarId, s.seatIndex),
        modelKey: names.get(s.avatarId)?.modelKey || 'lobster',
        subjectType: s.subjectType === 'agent' ? 'agent' : 'human',
        isSeeded: s.isSeeded,
        currentBet: bet && isBetSide(bet.bet) ? { bet: bet.bet, stake: Number(bet.stake) } : null,
      };
    });

    if (lastCoup && lastCoup.outcomeJson) {
      const o = lastCoup.outcomeJson as SerializedCoupResult;
      const seatResults: BaccaratTableSeatResult[] = lastBets
        .filter((b) => isBetSide(b.bet))
        .map((b) => ({
          seatIndex: b.seatIndex,
          avatarId: b.avatarId,
          name: nameOf(b.avatarId, b.seatIndex),
          bet: b.bet as BaccaratTableBetSide,
          stake: Number(b.stake),
          payout: Number(b.payout ?? '0'),
          net: Number(b.net ?? '0'),
        }));
      lastRound = {
        roundSeq: t.lastRoundSeq ?? Math.max(0, t.roundSeq - 1),
        coupId: lastCoup.id,
        shoeId: lastCoup.shoeId,
        coupIndex: lastCoup.coupIndex,
        winner: o.winner,
        player: { cards: o.player.cards, total: o.player.total, isNatural: o.player.isNatural },
        banker: { cards: o.banker.cards, total: o.banker.total, isNatural: o.banker.isNatural },
        dealtAfter: lastCoup.dealtAfter ?? o.dealtAfter,
        settledAt: toMs(lastCoup.settledAt) ?? 0,
        seatResults,
      };
    }

    let shoe: BaccaratTablePublicState['shoe'] = null;
    if (t.activeShoeId) {
      const [s] = await this.db
        .select()
        .from(baccaratShoes)
        .where(eq(baccaratShoes.id, t.activeShoeId))
        .limit(1);
      if (s && s.status === 'open') {
        shoe = {
          id: s.id,
          serverSeedHash: s.serverSeedHash,
          clientSeed: s.clientSeed,
          nextCoupIndex: s.coupCounter,
          dealtCount: s.dealtCount,
        };
      }
    }
    let previousShoe: BaccaratTablePublicState['previousShoe'] = null;
    if (t.previousShoeId) {
      const [p] = await this.db
        .select()
        .from(baccaratShoes)
        .where(eq(baccaratShoes.id, t.previousShoeId))
        .limit(1);
      // The seed is public only once the shoe is closed (commit-reveal).
      if (p && p.status === 'closed') {
        previousShoe = {
          id: p.id,
          serverSeed: p.serverSeed,
          serverSeedHash: p.serverSeedHash,
          clientSeed: p.clientSeed,
        };
      }
    }

    const endsMs = toMs(t.phaseEndsAt);
    return {
      roundSeq: t.roundSeq,
      state: {
        tableId: t.id,
        tierKey: t.tierKey,
        minBet: t.minBetCt,
        maxBet: t.maxBetCt,
        maxSeats: t.maxSeats,
        roundSeq: t.roundSeq,
        phase,
        bettingClosesAt: phase === 'betting' ? endsMs : null,
        nextBettingOpensAt: phase === 'reveal' ? endsMs : null,
        shoe,
        previousShoe,
        seats: seatViews,
        lastRound,
      },
    };
  }

  private async buildMe(
    tableId: string,
    subject: BaccaratTableSubject,
    part: PublicPart,
  ): Promise<NonNullable<BaccaratTablePublicState['me']>> {
    const rs = part.roundSeq;
    const [seat] = await this.db
      .select()
      .from(baccaratTableSeats)
      .where(
        and(
          eq(baccaratTableSeats.tableId, tableId),
          eq(baccaratTableSeats.avatarId, subject.avatarId),
          eq(baccaratTableSeats.status, 'seated'),
        ),
      )
      .limit(1);
    const myBets = await this.db
      .select()
      .from(baccaratTableBets)
      .where(
        and(
          eq(baccaratTableBets.tableId, tableId),
          eq(baccaratTableBets.avatarId, subject.avatarId),
          eq(baccaratTableBets.status, 'pending'),
          inArray(baccaratTableBets.roundSeq, [rs, rs + 1]),
        ),
      );
    const view = (b: BaccaratTableBet | undefined) =>
      b && isBetSide(b.bet) ? { roundSeq: b.roundSeq, bet: b.bet, stake: Number(b.stake) } : null;
    let voidedLastRound: { roundSeq: number; reason: string } | null = null;
    if (rs > 0) {
      const [v] = await this.db
        .select()
        .from(baccaratTableBets)
        .where(
          and(
            eq(baccaratTableBets.tableId, tableId),
            eq(baccaratTableBets.avatarId, subject.avatarId),
            eq(baccaratTableBets.roundSeq, rs - 1),
            eq(baccaratTableBets.status, 'void'),
          ),
        )
        .limit(1);
      if (v) voidedLastRound = { roundSeq: v.roundSeq, reason: v.voidReason ?? 'void' };
    }
    const [av] = await this.db
      .select({ clawTokens: avatars.clawTokens })
      .from(avatars)
      .where(eq(avatars.id, subject.avatarId))
      .limit(1);
    return {
      seated: Boolean(seat),
      seatIndex: seat ? seat.seatIndex : null,
      currentBet: view(myBets.find((b) => b.roundSeq === rs)),
      nextRoundBet: view(myBets.find((b) => b.roundSeq === rs + 1)),
      lastResult: part.state.lastRound?.seatResults.find((r) => r.avatarId === subject.avatarId) ?? null,
      voidedLastRound,
      balance: Number(av?.clawTokens ?? 0),
    };
  }

  private async avatarNames(ids: string[]): Promise<Map<string, { name: string; modelKey: string }>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, { name: string; modelKey: string }>();
    if (unique.length === 0) return out;
    const rows = await this.db
      .select({ id: avatars.id, name: avatars.name, modelKey: avatars.modelKey })
      .from(avatars)
      .where(inArray(avatars.id, unique));
    for (const r of rows) out.set(r.id, { name: r.name ?? '', modelKey: r.modelKey ?? '' });
    return out;
  }

  /** Seated seats at one table, seat-index ascending. */
  private async seatedSeats(ex: Executor, tableId: string): Promise<BaccaratTableSeat[]> {
    return ex
      .select()
      .from(baccaratTableSeats)
      .where(and(eq(baccaratTableSeats.tableId, tableId), eq(baccaratTableSeats.status, 'seated')))
      .orderBy(asc(baccaratTableSeats.seatIndex));
  }

  private async countRealSeats(ex: Executor, tableId: string): Promise<number> {
    const seats = await this.seatedSeats(ex, tableId);
    return seats.filter((s) => !s.isSeeded).length;
  }

  /** Lock the table row for this tx. 404 `table_not_found`; 409 `table_closed` unless allowed. */
  private async lockTable(
    tx: TxLike,
    tableId: string,
    opts: { allowClosed?: boolean } = {},
  ): Promise<BaccaratTable> {
    const [t] = await tx
      .select()
      .from(baccaratTables)
      .where(eq(baccaratTables.id, tableId))
      .for('update');
    if (!t) throw new BaccaratTableError('table_not_found', 'table not found', 404);
    if (!opts.allowClosed && t.status !== 'open') {
      throw new BaccaratTableError('table_closed', 'table is closed', 409);
    }
    return t;
  }

  /** True when the current round's bets are frozen (spec 2.2: locked at bettingClosesAt). */
  private isRoundLocked(t: BaccaratTable, now: number): boolean {
    if (t.roundPhase === 'dealing') return true;
    if (t.roundPhase !== 'betting') return false;
    const ends = toMs(t.phaseEndsAt);
    return ends === null || now >= ends;
  }

  private bettingClosesAt(t: BaccaratTable): number | null {
    return t.roundPhase === 'betting' ? toMs(t.phaseEndsAt) : null;
  }

  // ── Sit / leave ────────────────────────────────────────────────────────────

  /**
   * Seat `subject` (first open seat, or `seatIndex` when given). One shared-baccarat
   * seat per avatar across all tables: same table -> `alreadySeated: true`; another
   * table -> 409 `already_seated_elsewhere` (+ `tableId`). A seeded bot yields its
   * seat when no seat is free. A sit at an `idle` table opens a betting window.
   */
  async sitDown(
    tableId: string,
    subject: BaccaratTableSubject,
    opts: { seatIndex?: number } = {},
  ): Promise<SitDownResult> {
    return this.withTableLock(tableId, async () => {
      const yielded: number[] = [];
      let result: SitDownResult;
      try {
        result = await this.db.transaction(async (tx) => {
          yielded.length = 0;
          const now = this.clock.now();
          const t = await this.lockTable(tx, tableId);
          if (t.source !== 'house') {
            throw new BaccaratTableError('table_closed', 'only house tables are open in v1', 409);
          }
          const [mine] = await tx
            .select()
            .from(baccaratTableSeats)
            .where(
              and(
                eq(baccaratTableSeats.avatarId, subject.avatarId),
                eq(baccaratTableSeats.status, 'seated'),
              ),
            )
            .limit(1);
          if (mine) {
            if (mine.tableId !== tableId) {
              throw new BaccaratTableError(
                'already_seated_elsewhere',
                'this avatar already holds a shared baccarat seat at another table',
                409,
                { tableId: mine.tableId },
              );
            }
            await tx
              .update(baccaratTableSeats)
              .set({ lastActionAt: toDate(now), updatedAt: toDate(now) })
              .where(and(eq(baccaratTableSeats.id, mine.id), eq(baccaratTableSeats.status, 'seated')));
            return {
              seatIndex: mine.seatIndex,
              alreadySeated: true,
              roundSeq: t.roundSeq,
              bettingClosesAt: this.bettingClosesAt(t),
            };
          }

          const seats = await this.seatedSeats(tx, tableId);
          const byIndex = new Map(seats.map((s) => [s.seatIndex, s]));
          let seatIndex: number | null = null;
          let yieldSeat: BaccaratTableSeat | null = null;
          if (opts.seatIndex !== undefined) {
            const want = opts.seatIndex;
            if (!Number.isInteger(want) || want < 0 || want >= t.maxSeats) {
              throw new BaccaratTableError('invalid_sit_body', `seatIndex must be 0..${t.maxSeats - 1}`, 400);
            }
            const occ = byIndex.get(want);
            if (!occ) seatIndex = want;
            else if (occ.isSeeded) {
              seatIndex = want;
              yieldSeat = occ;
            } else {
              throw new BaccaratTableError('seat_taken', `seat ${want} is taken`, 409);
            }
          } else {
            for (let i = 0; i < t.maxSeats; i++) {
              if (!byIndex.has(i)) {
                seatIndex = i;
                break;
              }
            }
            if (seatIndex === null) {
              // Bots yield: the lowest-index seeded seat frees up for the real player.
              const bot = seats.find((s) => s.isSeeded);
              if (bot) {
                seatIndex = bot.seatIndex;
                yieldSeat = bot;
              }
            }
          }
          if (seatIndex === null) {
            throw new BaccaratTableError('table_full', 'no open seat at this table', 409);
          }

          if (yieldSeat) {
            const freed = await tx
              .update(baccaratTableSeats)
              .set({ status: 'left', leftAt: toDate(now), updatedAt: toDate(now) })
              .where(and(eq(baccaratTableSeats.id, yieldSeat.id), eq(baccaratTableSeats.status, 'seated')))
              .returning({ id: baccaratTableSeats.id });
            if (freed.length !== 1) {
              throw new BaccaratTableError('seat_taken', `seat ${seatIndex} changed under the lock`, 409);
            }
            yielded.push(yieldSeat.seatIndex);
          }

          await tx.insert(baccaratTableSeats).values({
            tableId,
            avatarId: subject.avatarId,
            agentId: subject.agentId,
            subjectType: subject.kind === 'agent' ? 'agent' : 'human',
            isSeeded: false,
            seatIndex,
            status: 'seated',
            seatedAt: toDate(now),
            lastActionAt: toDate(now),
            updatedAt: toDate(now),
          });

          let bettingClosesAt = this.bettingClosesAt(t);
          if (t.roundPhase === 'idle') {
            bettingClosesAt = now + this.bettingWindowMs;
            await tx
              .update(baccaratTables)
              .set({
                roundPhase: 'betting',
                phaseEndsAt: toDate(bettingClosesAt),
                updatedAt: toDate(now),
              })
              .where(and(eq(baccaratTables.id, tableId), eq(baccaratTables.roundPhase, 'idle')));
          }
          return { seatIndex, alreadySeated: false, roundSeq: t.roundSeq, bettingClosesAt };
        });
      } catch (err) {
        const dup = pgUniqueViolation(err);
        if (dup) {
          if (dup.constraint.includes('avatar')) {
            const [other] = await this.db
              .select({ tableId: baccaratTableSeats.tableId })
              .from(baccaratTableSeats)
              .where(
                and(
                  eq(baccaratTableSeats.avatarId, subject.avatarId),
                  eq(baccaratTableSeats.status, 'seated'),
                ),
              )
              .limit(1);
            throw new BaccaratTableError(
              'already_seated_elsewhere',
              'this avatar already holds a shared baccarat seat',
              409,
              other ? { tableId: other.tableId } : undefined,
            );
          }
          throw new BaccaratTableError('seat_taken', 'that seat was just taken', 409);
        }
        throw err;
      }
      for (const idx of yielded) this.botPool?.release(tableId, idx);
      return result;
    });
  }

  /**
   * Leave. Inside the open window the pending bet is cancelled; after the window
   * closed the locked bet stays pending, settles this round, and returns as
   * `lockedBet` (D3). A future-round (autonomous) bet is always cancelled. With no
   * real seat and no pending bet left, a `betting` table goes `idle`.
   */
  async leaveTable(tableId: string, subject: BaccaratTableSubject): Promise<LeaveTableResult> {
    return this.withTableLock(tableId, async () =>
      this.db.transaction(async (tx) => {
        const now = this.clock.now();
        const t = await this.lockTable(tx, tableId, { allowClosed: true });
        const seat = await this.mySeatTx(tx, tableId, subject.avatarId);
        if (!seat) throw new BaccaratTableError('not_seated', 'subject is not seated here', 409);

        const mine = await this.myPendingBetsTx(tx, tableId, subject.avatarId);
        const locked = this.isRoundLocked(t, now);
        let lockedBet: LeaveTableResult['lockedBet'] = null;
        for (const b of mine) {
          if (b.roundSeq === t.roundSeq && locked) {
            if (isBetSide(b.bet)) lockedBet = { roundSeq: b.roundSeq, bet: b.bet, stake: Number(b.stake) };
            continue;
          }
          await this.cancelBetRowTx(tx, b.id, now);
        }

        const left = await tx
          .update(baccaratTableSeats)
          .set({ status: 'left', leftAt: toDate(now), updatedAt: toDate(now) })
          .where(and(eq(baccaratTableSeats.id, seat.id), eq(baccaratTableSeats.status, 'seated')))
          .returning({ id: baccaratTableSeats.id });
        if (left.length !== 1) {
          throw new BaccaratTableError('not_seated', 'seat changed under the lock', 409);
        }

        if (t.roundPhase === 'betting') {
          const real = await this.countRealSeats(tx, tableId);
          const anyPending = await tx
            .select({ id: baccaratTableBets.id })
            .from(baccaratTableBets)
            .where(and(eq(baccaratTableBets.tableId, tableId), eq(baccaratTableBets.status, 'pending')))
            .limit(1);
          if (real === 0 && anyPending.length === 0) {
            await tx
              .update(baccaratTables)
              .set({ roundPhase: 'idle', phaseEndsAt: null, updatedAt: toDate(now) })
              .where(and(eq(baccaratTables.id, tableId), eq(baccaratTables.roundPhase, 'betting')));
          }
        }
        return { left: true as const, lockedBet };
      }),
    );
  }

  private async mySeatTx(tx: TxLike, tableId: string, avatarId: string): Promise<BaccaratTableSeat | null> {
    const [seat] = await tx
      .select()
      .from(baccaratTableSeats)
      .where(
        and(
          eq(baccaratTableSeats.tableId, tableId),
          eq(baccaratTableSeats.avatarId, avatarId),
          eq(baccaratTableSeats.status, 'seated'),
        ),
      )
      .limit(1)
      .for('update');
    return seat ?? null;
  }

  private async myPendingBetsTx(tx: TxLike, tableId: string, avatarId: string): Promise<BaccaratTableBet[]> {
    return tx
      .select()
      .from(baccaratTableBets)
      .where(
        and(
          eq(baccaratTableBets.tableId, tableId),
          eq(baccaratTableBets.avatarId, avatarId),
          eq(baccaratTableBets.status, 'pending'),
        ),
      )
      .orderBy(asc(baccaratTableBets.roundSeq))
      .for('update');
  }

  private async cancelBetRowTx(tx: TxLike, betId: string, now: number): Promise<void> {
    const rows = await tx
      .update(baccaratTableBets)
      .set({ status: 'cancelled', updatedAt: toDate(now) })
      .where(and(eq(baccaratTableBets.id, betId), eq(baccaratTableBets.status, 'pending')))
      .returning({ id: baccaratTableBets.id });
    if (rows.length !== 1) {
      throw new BaccaratTableError('bet_conflict', 'bet changed under the lock, retry', 409);
    }
  }

  // ── Bets ───────────────────────────────────────────────────────────────────

  /**
   * Place or replace this seat's bet for `input.roundSeq` (must equal the table's
   * `round_seq`, phase `betting`, `now < bettingClosesAt`). No vCLAW moves here.
   */
  async placeBet(
    tableId: string,
    subject: BaccaratTableSubject,
    input: { roundSeq: number; bet: BaccaratTableBetSide; stake: number },
  ): Promise<PlaceBetResult> {
    return this.withTableLock(tableId, () =>
      this.placeBetTx(tableId, subject, input.bet, input.stake, { kind: 'rest', roundSeq: input.roundSeq }),
    );
  }

  private async placeBetTx(
    tableId: string,
    subject: BaccaratTableSubject,
    bet: BaccaratTableBetSide,
    stake: number,
    mode: BetMode,
  ): Promise<PlaceBetResult> {
    if (!isBetSide(bet)) {
      throw new BaccaratTableError('invalid_bet_body', "bet must be 'player' | 'banker' | 'tie'", 400);
    }
    const origin: BaccaratTableBetOrigin = mode.kind === 'autonomous' ? 'autonomous' : 'rest';
    const actorKind: BaccaratTableActorKind =
      mode.kind === 'autonomous' ? 'agent' : baccaratTableActorKind(subject);
    if (mode.kind === 'autonomous' && subject.kind !== 'agent') {
      throw new BaccaratTableError('autonomous_bet_requires_agent', 'autonomous bets are agent-only', 403);
    }

    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      // 1. Table row lock (serializes with the settle tx and every other write).
      const t = await this.lockTable(tx, tableId);
      const rs = t.roundSeq;
      const ends = toMs(t.phaseEndsAt);

      // 2. Target round.
      let target: number;
      let opened = false;
      if (mode.kind === 'rest') {
        if (mode.roundSeq !== rs) {
          throw new BaccaratTableError('stale_round', `bet roundSeq ${mode.roundSeq} != current ${rs}`, 409, {
            roundSeq: rs,
          });
        }
        if (t.roundPhase !== 'betting' || ends === null || now >= ends) {
          const details: Record<string, unknown> = {};
          if (t.roundPhase === 'reveal' && ends !== null) details.nextBettingOpensAt = ends;
          throw new BaccaratTableError('betting_closed', `betting window closed (phase=${t.roundPhase})`, 409, details);
        }
        target = rs;
      } else if (t.roundPhase === 'betting' && ends !== null && ends - now >= BACCARAT_AUTONOMOUS_MIN_WINDOW_LEFT_MS) {
        target = rs;
      } else if (t.roundPhase === 'betting' || t.roundPhase === 'dealing') {
        target = rs + 1;
      } else if (t.roundPhase === 'reveal') {
        // The settle already advanced round_seq; the next window plays round_seq.
        target = rs;
      } else {
        // idle: open a window for this bet (a seated agent; normally the sit opened it).
        target = rs;
        opened = true;
      }

      // 3. Seat.
      const seat = await this.mySeatTx(tx, tableId, subject.avatarId);
      if (!seat) throw new BaccaratTableError('not_seated', 'sit down before betting', 409);
      if (seat.isSeeded) {
        throw new BaccaratTableError('seeded_seat_cannot_bet', 'seeded seats never bet', 403);
      }

      // 4. Stake bounds.
      if (!Number.isSafeInteger(stake) || stake < t.minBetCt || stake > t.maxBetCt) {
        throw new BaccaratTableError(
          'stake_out_of_bounds',
          `stake must be an integer in [${t.minBetCt}, ${t.maxBetCt}]`,
          400,
        );
      }

      // 5. Pre-flight funds (UX; the settle re-checks under the avatar lock).
      const [av] = await tx
        .select({ clawTokens: avatars.clawTokens })
        .from(avatars)
        .where(eq(avatars.id, subject.avatarId))
        .for('share');
      if (!av) throw new BaccaratTableError('active_avatar_required', 'avatar not found', 403);
      const others = (
        await tx
          .select()
          .from(baccaratTableBets)
          .where(and(eq(baccaratTableBets.avatarId, subject.avatarId), eq(baccaratTableBets.status, 'pending')))
      ).filter((b) => !(b.tableId === tableId && b.roundSeq === target && b.seatIndex === seat.seatIndex));
      const otherSum = others.reduce((sum, b) => sum + Number(b.stake), 0);
      if (av.clawTokens < stake + otherSum) {
        throw new BaccaratTableError(
          'insufficient_clawtokens',
          `need ${stake + otherSum} (this bet ${stake} + pending ${otherSum}), have ${av.clawTokens}`,
          402,
        );
      }

      // 6. Autonomous daily cap: settled autonomous debits today + pending autonomous stakes.
      if (mode.kind === 'autonomous') {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${autonomousCoveDailyAdvisoryKey(subject.avatarId)}))`,
        );
        const usage = parseAutonomousCoveDailyUsage(
          (await tx.execute<{ used_vclaw: string }>(
            autonomousCoveDailyUsageQuery(subject.avatarId),
          )) as unknown as Array<{ used_vclaw: string }>,
        );
        const pendingAuto = others
          .filter((b) => b.origin === 'autonomous')
          .reduce((sum, b) => sum + Number(b.stake), 0);
        const capMessage = autonomousCoveDailyCapMessage(usage + pendingAuto, stake);
        if (capMessage) {
          throw new BaccaratTableError('agent_cove_daily_wager_cap_exceeded', capMessage, 409);
        }
      }

      if (opened) {
        await tx
          .update(baccaratTables)
          .set({
            roundPhase: 'betting',
            phaseEndsAt: toDate(now + this.bettingWindowMs),
            updatedAt: toDate(now),
          })
          .where(and(eq(baccaratTables.id, tableId), eq(baccaratTables.roundPhase, 'idle')));
      }

      // 7. UPSERT the one pending row for (table, round, seat).
      const values = {
        bet,
        stake: String(stake),
        avatarId: subject.avatarId,
        actorKind,
        agentId: subject.agentId,
        origin,
        updatedAt: toDate(now),
      };
      const findPending = async (): Promise<BaccaratTableBet | undefined> => {
        const [row] = await tx
          .select()
          .from(baccaratTableBets)
          .where(
            and(
              eq(baccaratTableBets.tableId, tableId),
              eq(baccaratTableBets.roundSeq, target),
              eq(baccaratTableBets.seatIndex, seat.seatIndex),
              eq(baccaratTableBets.status, 'pending'),
            ),
          )
          .limit(1)
          .for('update');
        return row;
      };
      const replace = async (row: BaccaratTableBet): Promise<void> => {
        const updated = await tx
          .update(baccaratTableBets)
          .set(values)
          .where(and(eq(baccaratTableBets.id, row.id), eq(baccaratTableBets.status, 'pending')))
          .returning({ id: baccaratTableBets.id });
        if (updated.length !== 1) {
          throw new BaccaratTableError('bet_conflict', 'bet changed under the lock, retry', 409);
        }
      };
      const insertOnce = async (): Promise<void> => {
        // Savepoint: a 23505 must not abort the outer tx.
        await tx.transaction(async (sp) => {
          await sp.insert(baccaratTableBets).values({
            tableId,
            roundSeq: target,
            seatIndex: seat.seatIndex,
            status: 'pending',
            createdAt: toDate(now),
            ...values,
          });
        });
      };
      const existing = await findPending();
      if (existing) {
        await replace(existing);
      } else {
        try {
          await insertOnce();
        } catch (err) {
          if (!pgUniqueViolation(err)) throw err;
          // A concurrent writer inserted the pending row first: replace it.
          const raced = await findPending();
          if (!raced) throw new BaccaratTableError('bet_conflict', 'concurrent bet on this seat, retry', 409);
          await replace(raced);
        }
      }

      await tx
        .update(baccaratTableSeats)
        .set({ lastActionAt: toDate(now), updatedAt: toDate(now) })
        .where(eq(baccaratTableSeats.id, seat.id));

      const closes =
        target === rs && (t.roundPhase === 'betting' || opened)
          ? opened
            ? now + this.bettingWindowMs
            : ends
          : null;
      return { roundSeq: target, seatIndex: seat.seatIndex, bet, stake, bettingClosesAt: closes };
    });
  }

  /**
   * Cancel this subject's pending bet(s) at the table (spec 5.3a). The current-round
   * bet is cancellable only inside the open window (else 409 `betting_closed`); a
   * next-round bet is always cancellable. No ledger call: no vCLAW moved at bet time.
   */
  async cancelBet(tableId: string, subject: BaccaratTableSubject): Promise<{ cancelled: boolean }> {
    return this.withTableLock(tableId, async () =>
      this.db.transaction(async (tx) => {
        const now = this.clock.now();
        const t = await this.lockTable(tx, tableId);
        const seat = await this.mySeatTx(tx, tableId, subject.avatarId);
        if (!seat) throw new BaccaratTableError('not_seated', 'subject is not seated here', 409);
        const locked = this.isRoundLocked(t, now);
        let cancelled = 0;
        let blocked = false;
        for (const b of await this.myPendingBetsTx(tx, tableId, subject.avatarId)) {
          if (b.roundSeq === t.roundSeq && locked) {
            blocked = true;
            continue;
          }
          await this.cancelBetRowTx(tx, b.id, now);
          cancelled++;
        }
        if (cancelled === 0 && blocked) {
          throw new BaccaratTableError('betting_closed', 'the bet is locked for this round', 409);
        }
        return { cancelled: cancelled > 0 };
      }),
    );
  }

  /**
   * Hosted-agent bet (`[ACTION: play_cove_game(game=baccarat, bet, wager)]`), spec 6.3.
   * Re-resolves the live session, refuses a changed binding and a house agent, picks
   * the lowest-tier open house table whose bounds admit `wager` (the table where the
   * avatar already sits wins), sits if needed (bots yield), then places an
   * `origin='autonomous'` bet that plays this round or, with < 1 s left, the next.
   */
  async placeAutonomousBet(input: PlaceAutonomousBetInput): Promise<PlaceAutonomousBetResult> {
    if (!isBetSide(input.bet)) {
      throw new BaccaratTableError('invalid_bet_body', "bet must be 'player' | 'banker' | 'tie'", 400);
    }
    if (
      !Number.isSafeInteger(input.wager) ||
      input.wager < BACCARAT_TABLE_MIN_BET ||
      input.wager > BACCARAT_TABLE_MAX_BET
    ) {
      throw new BaccaratTableError(
        'stake_out_of_bounds',
        `wager must be an integer in [${BACCARAT_TABLE_MIN_BET}, ${BACCARAT_TABLE_MAX_BET}]`,
        400,
      );
    }
    const resolved = await this.resolveAgent(input.agentSessionId);
    if (!resolved) {
      throw new BaccaratTableError('invalid_or_expired_agent_session', 'invalid or expired agent session', 401);
    }
    if (!resolved.ledgerCapable) {
      throw new BaccaratTableError('agent_session_not_ledger_authorized', 'agent session is not ledger-authorized', 403);
    }
    if (!resolved.userId || !resolved.avatarId) {
      throw new BaccaratTableError('agent_session_has_no_active_avatar', 'agent has no bound active avatar', 403);
    }
    if (
      resolved.agentId !== input.expectedAgentId ||
      resolved.avatarId !== input.expectedAvatarId ||
      resolved.userId !== input.expectedUserId
    ) {
      throw new BaccaratTableError('live_agent_avatar_binding_changed', 'live agent/avatar binding changed', 403);
    }
    if (await this.isHouseAgent(resolved.agentId)) {
      throw new BaccaratTableError('house_agent_cannot_bet', 'house agents never bet at shared tables', 403);
    }
    if (this.botPool?.isBot(resolved.avatarId)) {
      throw new BaccaratTableError('seeded_seat_cannot_bet', 'seeded bots never bet', 403);
    }
    const subject: BaccaratTableSubject = {
      kind: 'agent',
      userId: resolved.userId,
      avatarId: resolved.avatarId,
      agentId: resolved.agentId,
    };
    const wager = input.wager;

    const [current] = await this.db
      .select()
      .from(baccaratTableSeats)
      .where(and(eq(baccaratTableSeats.avatarId, subject.avatarId), eq(baccaratTableSeats.status, 'seated')))
      .limit(1);
    if (current) {
      const t = await this.getTable(current.tableId);
      if (
        !t ||
        t.status !== 'open' ||
        t.source !== 'house' ||
        wager < t.minBetCt ||
        wager > t.maxBetCt
      ) {
        throw new BaccaratTableError(
          'already_seated_elsewhere',
          'seated at a table whose bounds do not admit this wager; leave it first',
          409,
          { tableId: current.tableId },
        );
      }
      const res = await this.withTableLock(t.id, () =>
        this.placeBetTx(t.id, subject, input.bet, wager, { kind: 'autonomous' }),
      );
      return { tableId: t.id, roundSeq: res.roundSeq, seatIndex: res.seatIndex, seated: false };
    }

    const candidates = await this.db
      .select()
      .from(baccaratTables)
      .where(
        and(
          eq(baccaratTables.source, 'house'),
          eq(baccaratTables.visibility, 'public'),
          eq(baccaratTables.status, 'open'),
          lte(baccaratTables.minBetCt, wager),
          gte(baccaratTables.maxBetCt, wager),
        ),
      )
      .orderBy(asc(baccaratTables.minBetCt), asc(baccaratTables.createdAt));
    if (candidates.length === 0) {
      throw new BaccaratTableError('table_not_found', `no open house table admits a ${wager} vCLAW bet`, 404);
    }
    for (const t of candidates) {
      let sat: SitDownResult;
      try {
        sat = await this.sitDown(t.id, subject);
      } catch (err) {
        if (err instanceof BaccaratTableError && (err.code === 'table_full' || err.code === 'seat_taken')) {
          continue;
        }
        throw err;
      }
      const res = await this.withTableLock(t.id, () =>
        this.placeBetTx(t.id, subject, input.bet, wager, { kind: 'autonomous' }),
      );
      return { tableId: t.id, roundSeq: res.roundSeq, seatIndex: res.seatIndex, seated: !sat.alreadySeated };
    }
    throw new BaccaratTableError('table_full', 'every table that admits this wager is full', 409);
  }

  // ── Round loop ─────────────────────────────────────────────────────────────

  /**
   * Advance one table by one step (the tick calls this per open house table).
   * betting -> CAS deal; dealing -> retry after backoff; reveal -> next window.
   */
  async tickRound(tableId: string): Promise<BaccaratTickOutcome> {
    return this.withTableLock(tableId, async () => {
      const t = await this.getTable(tableId);
      if (!t || t.status !== 'open') return 'noop';
      const now = this.clock.now();
      const ends = toMs(t.phaseEndsAt);
      if (ends !== null && now < ends) return 'noop';
      switch (t.roundPhase) {
        case 'betting': {
          const claimed = await this.casDeal(t.id, t.roundSeq, now);
          if (!claimed) return 'noop';
          return this.runSettle(t.id, t.roundSeq, 0);
        }
        case 'dealing':
          // A retry: no separate claim. The settle tx's row lock re-checks
          // phase, round, deadline and the attempts value read here.
          return this.runSettle(t.id, t.roundSeq, t.settleAttempts);
        case 'reveal':
          await this.endReveal(t.id, t.roundSeq);
          return 'reveal_ended';
        default:
          return 'noop';
      }
    });
  }

  /** The ONE standalone claim (spec 5.1 item 4). Zero rows = another process owns it. */
  private async casDeal(tableId: string, roundSeq: number, now: number): Promise<boolean> {
    const rows = await this.db.transaction(async (tx) =>
      tx
        .update(baccaratTables)
        .set({ roundPhase: 'dealing', settleAttempts: 0, updatedAt: toDate(now) })
        .where(
          and(
            eq(baccaratTables.id, tableId),
            eq(baccaratTables.status, 'open'),
            eq(baccaratTables.roundPhase, 'betting'),
            eq(baccaratTables.roundSeq, roundSeq),
            or(isNull(baccaratTables.phaseEndsAt), lte(baccaratTables.phaseEndsAt, toDate(now))),
          ),
        )
        .returning({ id: baccaratTables.id }),
    );
    return rows.length === 1;
  }

  private async runSettle(
    tableId: string,
    roundSeq: number,
    expectedAttempts: number,
  ): Promise<BaccaratTickOutcome> {
    let outcome: SettleOutcome;
    try {
      outcome = await this.settleRound(tableId, roundSeq, expectedAttempts);
    } catch (err) {
      return this.handleSettleFailure(tableId, roundSeq, expectedAttempts, err);
    }
    // After commit only.
    if (outcome.kind === 'settled' || outcome.kind === 'all_void') {
      for (const a of outcome.alerts) this.fireAlert(a);
    }
    if (outcome.kind === 'settled' && outcome.events.length > 0) {
      try {
        this.emitSettledFn(outcome.events);
      } catch (err) {
        // A failed event write never touches money (the settle already committed).
        console.error('[baccarat-manager] settle event emit failed:', err);
      }
    }
    return outcome.kind;
  }

  /**
   * Settle failure: the tx rolled back (no vCLAW, no coup, bets still pending, table
   * still dealing). Failures 1..4 schedule a retry after 1, 2, 4, 8 s. The 5th voids
   * the round's pending bets ('settle_failed') and opens the next window.
   */
  private async handleSettleFailure(
    tableId: string,
    roundSeq: number,
    expectedAttempts: number,
    err: unknown,
  ): Promise<BaccaratTickOutcome> {
    const attempt = expectedAttempts + 1;
    const lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(
      `[baccarat-manager] settle failed for table ${tableId} round ${roundSeq} (attempt ${attempt}):`,
      err,
    );
    if (err instanceof BaccaratTableError && err.code === 'seeded_seat_cannot_bet') {
      this.fireAlert({
        severity: 'critical',
        source: 'baccarat-table-settle',
        message: `seeded bot bet refused at settle (table ${tableId}, round ${roundSeq})`,
        context: { tableId, roundSeq, lastError },
      });
    }
    if (attempt >= BACCARAT_MAX_SETTLE_ATTEMPTS) {
      const voided = await this.voidRoundAfterFailures(tableId, roundSeq, expectedAttempts);
      if (voided === null) return 'skipped';
      this.fireAlert({
        severity: 'critical',
        source: 'baccarat-table-settle',
        message: `baccarat round voided after ${attempt} settle failures (table ${tableId}, round ${roundSeq}, ${voided} bet(s) void)`,
        context: { tableId, roundSeq, lastError, voidedBets: voided },
      });
      return 'round_voided';
    }
    const now = this.clock.now();
    const backoff =
      this.settleBackoffMs[attempt - 1] ?? this.settleBackoffMs[this.settleBackoffMs.length - 1] ?? 1_000;
    await this.db.transaction(async (tx) =>
      tx
        .update(baccaratTables)
        .set({ settleAttempts: attempt, phaseEndsAt: toDate(now + backoff), updatedAt: toDate(now) })
        .where(
          and(
            eq(baccaratTables.id, tableId),
            eq(baccaratTables.roundPhase, 'dealing'),
            eq(baccaratTables.roundSeq, roundSeq),
            eq(baccaratTables.settleAttempts, expectedAttempts),
          ),
        )
        .returning({ id: baccaratTables.id }),
    );
    return 'settle_failed';
  }

  /** Void tx after the 5th failure. Returns the number of voided bets, or null when skipped. */
  private async voidRoundAfterFailures(
    tableId: string,
    roundSeq: number,
    expectedAttempts: number,
  ): Promise<number | null> {
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const t = await this.lockTable(tx, tableId, { allowClosed: true });
      if (t.roundPhase !== 'dealing' || t.roundSeq !== roundSeq || t.settleAttempts !== expectedAttempts) {
        return null;
      }
      const pending = await tx
        .select()
        .from(baccaratTableBets)
        .where(
          and(
            eq(baccaratTableBets.tableId, tableId),
            eq(baccaratTableBets.roundSeq, roundSeq),
            eq(baccaratTableBets.status, 'pending'),
          ),
        )
        .orderBy(asc(baccaratTableBets.seatIndex))
        .for('update');
      for (const b of pending) await this.voidBetRowTx(tx, b.id, 'settle_failed', now);
      await this.advanceRoundTx(tx, t, now);
      return pending.length;
    });
  }

  /** round_seq + 1, settle_attempts 0, next window (betting with a real seat, else idle). */
  private async advanceRoundTx(tx: TxLike, t: BaccaratTable, now: number): Promise<void> {
    const real = await this.countRealSeats(tx, t.id);
    const rows = await tx
      .update(baccaratTables)
      .set({
        roundSeq: t.roundSeq + 1,
        settleAttempts: 0,
        roundPhase: real > 0 ? 'betting' : 'idle',
        phaseEndsAt: real > 0 ? toDate(now + this.bettingWindowMs) : null,
        updatedAt: toDate(now),
      })
      .where(
        and(
          eq(baccaratTables.id, t.id),
          eq(baccaratTables.roundPhase, 'dealing'),
          eq(baccaratTables.roundSeq, t.roundSeq),
        ),
      )
      .returning({ id: baccaratTables.id });
    if (rows.length !== 1) {
      throw new BaccaratTableError('table_state_conflict', 'table row changed under the lock', 500);
    }
  }

  private async voidBetRowTx(
    tx: TxLike,
    betId: string,
    reason: BaccaratTableVoidReason,
    now: number,
  ): Promise<void> {
    const rows = await tx
      .update(baccaratTableBets)
      .set({ status: 'void', voidReason: reason, settledAt: toDate(now), updatedAt: toDate(now) })
      .where(and(eq(baccaratTableBets.id, betId), eq(baccaratTableBets.status, 'pending')))
      .returning({ id: baccaratTableBets.id });
    if (rows.length !== 1) {
      throw new BaccaratTableError('bet_state_conflict', `bet ${betId} is no longer pending`, 500);
    }
  }

  private async endReveal(tableId: string, roundSeq: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const t = await this.lockTable(tx, tableId, { allowClosed: true });
      const ends = toMs(t.phaseEndsAt);
      if (t.roundPhase !== 'reveal' || t.roundSeq !== roundSeq || (ends !== null && ends > now)) return;
      const real = await this.countRealSeats(tx, tableId);
      await tx
        .update(baccaratTables)
        .set({
          roundPhase: real > 0 ? 'betting' : 'idle',
          phaseEndsAt: real > 0 ? toDate(now + this.bettingWindowMs) : null,
          updatedAt: toDate(now),
        })
        .where(and(eq(baccaratTables.id, tableId), eq(baccaratTables.roundPhase, 'reveal')));
    });
  }

  /**
   * THE settle tx (spec 5.3). Lock order: table row -> shoe row -> bet rows ->
   * avatar rows (id asc) -> advisory daily-cap locks (avatar id asc). Any throw rolls
   * the whole tx back.
   */
  private async settleRound(
    tableId: string,
    roundSeq: number,
    expectedAttempts: number,
  ): Promise<SettleOutcome> {
    return this.db.transaction(async (tx): Promise<SettleOutcome> => {
      const now = this.clock.now();
      const alerts: AlertErrorParams[] = [];

      // 1. Table row lock = the claim for this attempt.
      const [t] = await tx
        .select()
        .from(baccaratTables)
        .where(eq(baccaratTables.id, tableId))
        .for('update');
      if (
        !t ||
        t.status !== 'open' ||
        t.roundPhase !== 'dealing' ||
        t.roundSeq !== roundSeq ||
        t.settleAttempts !== expectedAttempts
      ) {
        return { kind: 'skipped' };
      }
      const ends = toMs(t.phaseEndsAt);
      if (ends !== null && ends > now) return { kind: 'skipped' };

      // 2. Shoe row lock; open / roll a broken or exhausted shoe inside this tx.
      let shoe = await this.lockShoeTx(tx, t.activeShoeId);
      if (!shoe || shoe.status !== 'open' || shoe.dealtCount >= RESHUFFLE_CARD_THRESHOLD) {
        shoe = await this.rollShoeTx(tx, t, shoe, now);
      }

      // 3. This round's pending bets, re-read under lock (D1).
      const pending = await tx
        .select()
        .from(baccaratTableBets)
        .where(
          and(
            eq(baccaratTableBets.tableId, tableId),
            eq(baccaratTableBets.roundSeq, roundSeq),
            eq(baccaratTableBets.status, 'pending'),
          ),
        )
        .orderBy(asc(baccaratTableBets.seatIndex))
        .for('update');

      // 4. IDLE GATE: nothing to deal; the shoe is untouched.
      if (pending.length === 0) {
        await this.advanceRoundTx(tx, t, now);
        return { kind: 'idle_gate' };
      }

      // 5. Bot guard (third barrier): a pool bot or a seeded seat holder never bets.
      const seededHere = new Set(
        (
          await tx
            .select({ avatarId: baccaratTableSeats.avatarId })
            .from(baccaratTableSeats)
            .where(and(eq(baccaratTableSeats.tableId, tableId), eq(baccaratTableSeats.isSeeded, true)))
        ).map((r) => r.avatarId),
      );
      for (const b of pending) {
        if (seededHere.has(b.avatarId) || this.botPool?.isBot(b.avatarId)) {
          throw new BaccaratTableError(
            'seeded_seat_cannot_bet',
            `pending bet ${b.id} belongs to a seeded bot avatar ${b.avatarId}`,
            500,
          );
        }
        if (!isBetSide(b.bet)) {
          throw new BaccaratTableError('bet_state_conflict', `bet ${b.id} has an invalid side`, 500);
        }
      }

      // 6. Avatar rows FOR UPDATE in id order, then the affordability split (D7).
      const avatarIds = [...new Set(pending.map((b) => b.avatarId))].sort();
      const avRows = await tx
        .select({ id: avatars.id, userId: avatars.userId, clawTokens: avatars.clawTokens })
        .from(avatars)
        .where(inArray(avatars.id, avatarIds))
        .orderBy(asc(avatars.id))
        .for('update');
      const avById = new Map(avRows.map((a) => [a.id, a]));
      const voids: Array<{ bet: BaccaratTableBet; reason: BaccaratTableVoidReason }> = [];
      let survivors: Array<{ bet: BaccaratTableBet; ownerUserId: string; stake: bigint }> = [];
      for (const b of pending) {
        const stake = BigInt(b.stake);
        if (stake <= 0n || stake > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new BaccaratTableError('bet_state_conflict', `bet ${b.id} has stake ${b.stake}`, 500);
        }
        const av = avById.get(b.avatarId);
        if (!av || !av.userId) {
          voids.push({ bet: b, reason: 'no_owner' });
          alerts.push({
            severity: 'critical',
            source: 'baccarat-table-settle',
            message: `pending bet ${b.id} has no owning user (avatar ${b.avatarId}); voided`,
            context: { tableId, roundSeq, betId: b.id, avatarId: b.avatarId },
          });
          continue;
        }
        if (BigInt(av.clawTokens) < stake) {
          voids.push({ bet: b, reason: 'insufficient_at_settle' });
          continue;
        }
        survivors.push({ bet: b, ownerUserId: av.userId, stake });
      }
      // Autonomous bets: daily-cap locks in avatar id order, then the re-check.
      const autoIds = [
        ...new Set(survivors.filter((s) => s.bet.origin === 'autonomous').map((s) => s.bet.avatarId)),
      ].sort();
      const overCap = new Set<string>();
      for (const avatarId of autoIds) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${autonomousCoveDailyAdvisoryKey(avatarId)}))`);
      }
      for (const avatarId of autoIds) {
        const usage = parseAutonomousCoveDailyUsage(
          (await tx.execute<{ used_vclaw: string }>(
            autonomousCoveDailyUsageQuery(avatarId),
          )) as unknown as Array<{ used_vclaw: string }>,
        );
        for (const s of survivors) {
          if (s.bet.avatarId !== avatarId || s.bet.origin !== 'autonomous') continue;
          if (autonomousCoveDailyCapMessage(usage, Number(s.stake))) overCap.add(s.bet.id);
        }
      }
      if (overCap.size > 0) {
        for (const s of survivors) {
          if (overCap.has(s.bet.id)) voids.push({ bet: s.bet, reason: 'daily_cap' });
        }
        survivors = survivors.filter((s) => !overCap.has(s.bet.id));
      }

      // All void: no coup dealt, shoe untouched.
      if (survivors.length === 0) {
        for (const v of voids) await this.voidBetRowTx(tx, v.bet.id, v.reason, now);
        await this.advanceRoundTx(tx, t, now);
        return { kind: 'all_void', alerts };
      }

      // 7. Deal ONE coup for the round under the shoe lock.
      const c = shoe.coupCounter;
      const cursorBefore = shoe.cursorCounter;
      const dealtBefore = shoe.dealtCount;
      const state = await this.reconstructShoeStateTx(
        tx,
        { serverSeed: shoe.serverSeed, clientSeed: shoe.clientSeed },
        shoe.id,
        c,
      );
      if (state.cursor !== cursorBefore || state.dealt !== dealtBefore) {
        throw new BaccaratTableError(
          'shoe_counter_drift',
          `reconstructed cursor=${state.cursor}/dealt=${state.dealt} != shoe cursor=${cursorBefore}/dealt=${dealtBefore}`,
          500,
        );
      }
      const stepped = playCoupWithState({
        serverSeed: shoe.serverSeed,
        clientSeed: shoe.clientSeed,
        nonce: c,
        cursor: cursorBefore,
        bet: 'player',
        stake: 1n,
        dealtBefore,
        remainingShoe: state.remaining,
      });
      const coup = stepped.result;
      const winner = coup.winner;
      const coupLevel = serializeCoupResult(coup, { cursorBefore, dealtBefore, nonce: c });

      // 8. Per-seat outcome = exact serializeCoupResult shape for the seat's bet (D2).
      const seats = survivors.map((s) => {
        const side = s.bet.bet as BaccaratTableBetSide;
        const { payout, commission } = settleBet(side, s.stake, winner);
        const net = payout - s.stake;
        const outcome: SerializedCoupResult = {
          ...coupLevel,
          bet: side,
          stake: s.stake.toString(),
          payout: payout.toString(),
          net: net.toString(),
          commission: commission.toString(),
        };
        return { ...s, side, payout, commission, net, outcome };
      });

      // 9. Conservation over the settled set only.
      const totals = assertRoundConservation(seats);

      // 10. The coup row: placeholder bet 'player' + stake '1' (D2).
      let coupId: string;
      try {
        const [row] = await tx
          .insert(baccaratCoups)
          .values({
            shoeId: shoe.id,
            coupIndex: c,
            cursorBefore,
            cursorAfter: coup.cursorAfter,
            dealtBefore,
            dealtAfter: coup.dealtAfter,
            bet: 'player',
            stake: '1',
            status: 'settled',
            outcomeJson: coupLevel,
            payout: '0',
            net: '0',
            createdAt: toDate(now),
            settledAt: toDate(now),
          })
          .returning({ id: baccaratCoups.id });
        if (!row) throw new BaccaratTableError('coup_insert_failed', 'coup insert failed', 500);
        coupId = row.id;
      } catch (err) {
        if (pgUniqueViolation(err)) {
          throw new BaccaratTableError('coup_conflict', `coup ${c} already dealt on shoe ${shoe.id}`, 500);
        }
        throw err;
      }

      // 11. Money + bet flip + fairness row, seat by seat.
      const events: BaccaratSettledSeatEvent[] = [];
      for (const s of seats) {
        const actorKind: BaccaratTableActorKind = s.bet.actorKind === 'agent' ? 'agent' : 'human';
        const meta: Record<string, unknown> = {
          tableId,
          roundSeq,
          shoeId: shoe.id,
          coupIndex: c,
          seatIndex: s.bet.seatIndex,
          bet: s.side,
          ...(s.bet.origin === 'autonomous' ? { autonomousCove: true } : {}),
        };
        // After step 6 an InsufficientTokensError is impossible; if it happens it
        // propagates and the whole tx rolls back (never a silent void).
        await this.ledger.debitClawTokens(
          {
            avatarId: s.bet.avatarId,
            amount: Number(s.stake),
            reason: 'cove_baccarat_table_stake',
            source: 'api',
            actorKind,
            metadata: meta,
          },
          tx,
        );
        if (s.payout > 0n) {
          await this.ledger.creditClawTokens(
            {
              avatarId: s.bet.avatarId,
              amount: Number(s.payout),
              reason: 'cove_baccarat_table_payout',
              source: 'api',
              actorKind,
              metadata: { ...meta, winner },
            },
            tx,
          );
        }
        const flipped = await tx
          .update(baccaratTableBets)
          .set({
            status: 'settled',
            shoeId: shoe.id,
            coupId,
            coupIndex: c,
            payout: s.payout.toString(),
            net: s.net.toString(),
            commission: s.commission.toString(),
            settledAt: toDate(now),
            updatedAt: toDate(now),
          })
          .where(and(eq(baccaratTableBets.id, s.bet.id), eq(baccaratTableBets.status, 'pending')))
          .returning({ id: baccaratTableBets.id });
        if (flipped.length !== 1) {
          throw new BaccaratTableError('bet_state_conflict', `bet ${s.bet.id} is no longer pending`, 500);
        }
        await tx.insert(coveGameEvents).values({
          fixtureRunId: null,
          userId: s.ownerUserId,
          guestFpHash: null,
          gameType: 'baccarat',
          sessionId: shoe.id,
          shoeId: shoe.id,
          betAmount: s.stake.toString(),
          payout: s.payout.toString(),
          outcomeJson: s.outcome,
          serverSeedHash: shoe.serverSeedHash,
          revealedServerSeed: null,
          clientSeed: shoe.clientSeed,
          nonce: c * BACCARAT_TABLE_SEAT_NONCE_STRIDE + s.bet.seatIndex,
          txSignature: null,
          engineVersion: `baccarat-engine-${BACCARAT_ENGINE_VERSION}`,
        });
        events.push({
          ownerUserId: s.ownerUserId,
          avatarId: s.bet.avatarId,
          agentId: actorKind === 'agent' ? s.bet.agentId : null,
          actorKind,
          payload: {
            shared: true,
            tableId,
            roundSeq,
            shoeId: shoe.id,
            coupId,
            coupIndex: c,
            seatIndex: s.bet.seatIndex,
            bet: s.side,
            stake: s.stake.toString(),
            payout: s.payout.toString(),
            net: s.net.toString(),
            winner,
            isAgent: actorKind === 'agent',
            origin: s.bet.origin === 'autonomous' ? 'autonomous' : 'rest',
          },
        });
      }

      // 12. Void bets (no ledger row, no event row).
      for (const v of voids) await this.voidBetRowTx(tx, v.bet.id, v.reason, now);

      // 13. Shoe counters.
      const newTotalBet = BigInt(shoe.totalBet) + totals.totalStake;
      const newTotalPayout = BigInt(shoe.totalPayout) + totals.totalPayout;
      const shoeRows = await tx
        .update(baccaratShoes)
        .set({
          coupCounter: c + 1,
          cursorCounter: coup.cursorAfter,
          dealtCount: coup.dealtAfter,
          totalBet: newTotalBet.toString(),
          totalPayout: newTotalPayout.toString(),
          currentBalance: (newTotalPayout - newTotalBet).toString(),
          coupsPlayed: shoe.coupsPlayed + 1,
          lastCoupAt: toDate(now),
        })
        .where(and(eq(baccaratShoes.id, shoe.id), eq(baccaratShoes.coupCounter, c)))
        .returning({ id: baccaratShoes.id });
      if (shoeRows.length !== 1) {
        throw new BaccaratTableError('shoe_counter_drift', `shoe ${shoe.id} moved under the lock`, 500);
      }
      // Roll right after the coup that crosses 75% penetration, so the NEXT round's
      // shoe commit is public before any bet is placed against it.
      if (coup.dealtAfter >= RESHUFFLE_CARD_THRESHOLD) {
        await this.rollShoeTx(tx, t, { ...shoe, status: 'open' }, now);
      }

      // 14. Table row: reveal + advance the window counter.
      const tableRows = await tx
        .update(baccaratTables)
        .set({
          roundPhase: 'reveal',
          phaseEndsAt: toDate(now + this.revealPauseMs),
          lastCoupId: coupId,
          lastRoundSeq: roundSeq,
          roundSeq: roundSeq + 1,
          settleAttempts: 0,
          updatedAt: toDate(now),
        })
        .where(
          and(
            eq(baccaratTables.id, tableId),
            eq(baccaratTables.roundPhase, 'dealing'),
            eq(baccaratTables.roundSeq, roundSeq),
          ),
        )
        .returning({ id: baccaratTables.id });
      if (tableRows.length !== 1) {
        throw new BaccaratTableError('table_state_conflict', 'table row changed under the lock', 500);
      }
      return { kind: 'settled', events, alerts };
    });
  }

  private async lockShoeTx(tx: TxLike, shoeId: string | null): Promise<ShoeRow | null> {
    if (!shoeId) return null;
    const [shoe] = await tx
      .select()
      .from(baccaratShoes)
      .where(eq(baccaratShoes.id, shoeId))
      .for('update');
    return shoe ?? null;
  }

  /**
   * Close `oldShoe` (reveal its seed on every baccarat event row of the shoe) and open
   * a fresh table-owned shoe, all inside `tx`. Points the table at the new shoe.
   */
  private async rollShoeTx(
    tx: TxLike,
    t: BaccaratTable,
    oldShoe: ShoeRow | null,
    now: number,
  ): Promise<ShoeRow> {
    if (oldShoe && oldShoe.status === 'open') {
      await tx
        .update(baccaratShoes)
        .set({ status: 'closed', closedAt: toDate(now) })
        .where(and(eq(baccaratShoes.id, oldShoe.id), eq(baccaratShoes.status, 'open')));
      await tx
        .update(coveGameEvents)
        .set({ revealedServerSeed: oldShoe.serverSeed })
        .where(and(eq(coveGameEvents.sessionId, oldShoe.id), eq(coveGameEvents.gameType, 'baccarat')));
    }
    const { serverSeed, serverSeedHash } = this.seedFn();
    const clientSeed = this.clientSeedFn();
    const [fresh] = await tx
      .insert(baccaratShoes)
      .values({
        userId: null,
        guestFpHash: null,
        fixtureRunId: null,
        fixtureInitialDealtCount: 0,
        tableId: t.id,
        currency: 'clawtoken',
        serverSeed,
        serverSeedHash,
        clientSeed,
        startingBalance: '0',
        engineVersion: BACCARAT_ENGINE_VERSION,
        createdAt: toDate(now),
      })
      .returning();
    if (!fresh) throw new BaccaratTableError('shoe_open_failed', 'shoe insert failed', 500);
    await tx
      .update(baccaratTables)
      .set({
        activeShoeId: fresh.id,
        previousShoeId: oldShoe ? oldShoe.id : t.previousShoeId,
        updatedAt: toDate(now),
      })
      .where(eq(baccaratTables.id, t.id));
    return fresh;
  }

  /**
   * Remaining-shoe state at the START of `targetCoupIndex`: replay every prior settled
   * coup of the shoe. Port of `d5ca47db2:...baccarat-table-manager.ts:1177-1214` (the
   * route's `reconstructShoeState` must not be imported from a service). The placeholder
   * 'player' / 1n matches the stored coup rows; the cards are bet-agnostic.
   */
  private async reconstructShoeStateTx(
    tx: Executor,
    shoe: { serverSeed: string; clientSeed: string },
    shoeId: string,
    targetCoupIndex: number,
  ): Promise<{ remaining: Card[]; cursor: number; dealt: number }> {
    let remaining = buildShoe();
    let cursor = 0;
    let dealt = 0;
    if (targetCoupIndex === 0) return { remaining, cursor, dealt };
    const priorCoups = await tx
      .select()
      .from(baccaratCoups)
      .where(and(eq(baccaratCoups.shoeId, shoeId), eq(baccaratCoups.status, 'settled')))
      .orderBy(asc(baccaratCoups.coupIndex));
    let expected = 0;
    for (const coup of priorCoups) {
      if (coup.coupIndex >= targetCoupIndex) break;
      if (coup.coupIndex !== expected) {
        throw new BaccaratTableError(
          'shoe_counter_drift',
          `shoe ${shoeId} coup history has a gap at ${expected} (found ${coup.coupIndex})`,
          500,
        );
      }
      expected++;
      const stepped = playCoupWithState({
        serverSeed: shoe.serverSeed,
        clientSeed: shoe.clientSeed,
        nonce: coup.coupIndex,
        cursor,
        bet: 'player',
        stake: 1n,
        dealtBefore: dealt,
        remainingShoe: remaining,
      });
      remaining = stepped.remainingAfter;
      cursor = stepped.cursorAfter;
      dealt = stepped.dealtAfter;
    }
    return { remaining, cursor, dealt };
  }

  /** Test seam for the route-parity test (spec 5.3 step 7). */
  async __reconstructShoeStateForTest(
    shoe: { serverSeed: string; clientSeed: string },
    shoeId: string,
    targetCoupIndex: number,
  ): Promise<{ remaining: Card[]; cursor: number; dealt: number }> {
    return this.reconstructShoeStateTx(this.db, shoe, shoeId, targetCoupIndex);
  }

  // ── Maintenance (the tick runs it every 60 s) ──────────────────────────────

  /**
   * Orphan guard (spec 5.5): void any pending bet with `round_seq < table.round_seq`
   * (reason 'orphaned', warn alert; it should never fire). Idle-seat sweep (spec 2.6):
   * free a real seat with no action for `idleSeatMs` and no pending bet. Bots stay.
   */
  async maintainTable(tableId: string): Promise<{ orphaned: number; freedSeats: number }> {
    return this.withTableLock(tableId, async () => {
      const result = await this.db.transaction(async (tx) => {
        const now = this.clock.now();
        const t = await this.lockTable(tx, tableId, { allowClosed: true });
        const orphans = await tx
          .select()
          .from(baccaratTableBets)
          .where(
            and(
              eq(baccaratTableBets.tableId, tableId),
              eq(baccaratTableBets.status, 'pending'),
              lt(baccaratTableBets.roundSeq, t.roundSeq),
            ),
          )
          .for('update');
        for (const b of orphans) await this.voidBetRowTx(tx, b.id, 'orphaned', now);

        const cutoff = toDate(now - this.idleSeatMs);
        const stale = await tx
          .select()
          .from(baccaratTableSeats)
          .where(
            and(
              eq(baccaratTableSeats.tableId, tableId),
              eq(baccaratTableSeats.status, 'seated'),
              eq(baccaratTableSeats.isSeeded, false),
              lt(baccaratTableSeats.lastActionAt, cutoff),
            ),
          )
          .for('update');
        let freedSeats = 0;
        for (const s of stale) {
          const pendingMine = await tx
            .select({ id: baccaratTableBets.id })
            .from(baccaratTableBets)
            .where(
              and(
                eq(baccaratTableBets.tableId, tableId),
                eq(baccaratTableBets.avatarId, s.avatarId),
                eq(baccaratTableBets.status, 'pending'),
              ),
            )
            .limit(1);
          if (pendingMine.length > 0) continue;
          const freed = await tx
            .update(baccaratTableSeats)
            .set({ status: 'left', leftAt: toDate(now), updatedAt: toDate(now) })
            .where(and(eq(baccaratTableSeats.id, s.id), eq(baccaratTableSeats.status, 'seated')))
            .returning({ id: baccaratTableSeats.id });
          freedSeats += freed.length;
        }
        if (freedSeats > 0 && t.roundPhase === 'betting' && t.status === 'open') {
          const real = await this.countRealSeats(tx, tableId);
          const anyPending = await tx
            .select({ id: baccaratTableBets.id })
            .from(baccaratTableBets)
            .where(and(eq(baccaratTableBets.tableId, tableId), eq(baccaratTableBets.status, 'pending')))
            .limit(1);
          if (real === 0 && anyPending.length === 0) {
            await tx
              .update(baccaratTables)
              .set({ roundPhase: 'idle', phaseEndsAt: null, updatedAt: toDate(now) })
              .where(and(eq(baccaratTables.id, tableId), eq(baccaratTables.roundPhase, 'betting')));
          }
        }
        return { orphaned: orphans.length, freedSeats, orphanIds: orphans.map((o) => o.id), roundSeq: t.roundSeq };
      });
      if (result.orphaned > 0) {
        this.fireAlert({
          severity: 'warning',
          source: 'baccarat-table-orphan-guard',
          message: `voided ${result.orphaned} orphaned pending baccarat bet(s) at table ${tableId}`,
          context: { tableId, roundSeq: result.roundSeq, betIds: result.orphanIds },
        });
      }
      return { orphaned: result.orphaned, freedSeats: result.freedSeats };
    });
  }

  // ── Seeded (visual-only) bots ──────────────────────────────────────────────

  /**
   * Fill a house table toward `seeded_agent_slots` visual-only bots. Idempotent; the
   * ONLY path that inserts a seeded seat. No ledger write. A no-op without a pool.
   */
  async seatHouseBots(tableId: string): Promise<number> {
    const pool = this.botPool;
    if (!pool) return 0;
    return this.withTableLock(tableId, async () => {
      const claimed: number[] = [];
      try {
        return await this.db.transaction(async (tx) => {
          claimed.length = 0;
          const now = this.clock.now();
          const t = await this.lockTable(tx, tableId, { allowClosed: true });
          if (t.status !== 'open' || t.source !== 'house' || t.seededAgentSlots <= 0) return 0;
          const seats = await this.seatedSeats(tx, tableId);
          const seeded = seats.filter((s) => s.isSeeded).length;
          const deficit = Math.min(t.seededAgentSlots - seeded, t.maxSeats - seats.length);
          if (deficit <= 0) return 0;
          const occupied = new Set(seats.map((s) => s.seatIndex));
          let placed = 0;
          for (let seatIndex = 0; seatIndex < t.maxSeats && placed < deficit; seatIndex++) {
            if (occupied.has(seatIndex)) continue;
            const bot = await pool.claim(tableId, seatIndex);
            if (!bot) break; // pool exhausted: seat fewer bots, never error
            claimed.push(seatIndex);
            try {
              await tx.transaction(async (sp) => {
                await sp.insert(baccaratTableSeats).values({
                  tableId,
                  avatarId: bot.avatarId,
                  agentId: bot.agentId,
                  subjectType: 'agent',
                  isSeeded: true,
                  seatIndex,
                  status: 'seated',
                  seatedAt: toDate(now),
                  lastActionAt: toDate(now),
                  updatedAt: toDate(now),
                });
              });
            } catch (err) {
              if (!pgUniqueViolation(err)) throw err;
              pool.release(tableId, seatIndex);
              claimed.pop();
              continue;
            }
            occupied.add(seatIndex);
            placed++;
          }
          return placed;
        });
      } catch (err) {
        for (const idx of claimed) pool.release(tableId, idx);
        throw err;
      }
    });
  }
}

// ── Default seams (lazy imports keep the test free of npc-simulation / middleware) ──

function defaultEmitSettled(events: readonly BaccaratSettledSeatEvent[]): void {
  for (const ev of events) {
    const eventIdPromise: Promise<bigint | null> = import('../event-logger')
      .then(({ logEventReturningId }) =>
        logEventReturningId({
          eventType: 'cove.baccarat.coup.settled',
          userId: ev.ownerUserId,
          avatarId: ev.avatarId,
          agentId: ev.agentId,
          payload: { ...ev.payload },
        }),
      )
      .catch((err: unknown) => {
        console.error('[baccarat-manager] settle event write failed:', err);
        return null;
      });
    if (ev.actorKind === 'agent' && ev.agentId) {
      const agentId = ev.agentId;
      void import('../agent-settlement-publish')
        .then(({ publishCoveSettlement }) =>
          publishCoveSettlement({
            agentId,
            game: 'baccarat',
            eventIdPromise,
            payload: { ...ev.payload },
          }),
        )
        .catch(() => {
          /* delivery only */
        });
    } else {
      void eventIdPromise;
    }
  }
}

async function defaultResolveAgent(sessionId: string): Promise<ResolvedBaccaratAgent | null> {
  const { resolveAgentSession } = await import('../../middleware/require-auth-or-agent');
  return resolveAgentSession(sessionId);
}

async function defaultIsHouseAgent(agentId: string): Promise<boolean> {
  const { isHouseAgentId } = await import('../autonomous-cove-agent-binding');
  return isHouseAgentId(agentId);
}
