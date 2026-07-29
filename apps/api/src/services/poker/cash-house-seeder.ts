/**
 * Poker CASH GAMES — house-bank + bot-pool BOOT SEEDER (idempotent).
 *
 * Provisions, on every API boot (idempotent — like `ensureSystemAgents()` /
 * `ensureDefaultBlindSchedule()`):
 *
 *   1. ONE system HOUSE-BANK avatar — `poker-house-bank@house.clawville.internal`,
 *      avatar name 'Poker House Bank', `isActive=false`. Its CT balance is the
 *      bankroll that REAL-CT-backs every seeded bot chip. On FIRST provision it is
 *      credited ONCE to `CASH_HOUSE_BANK_BANKROLL` (default 100_000) via
 *      `creditClawTokens({ source:'system', reason:'poker_cash_house_bank_seed' })`.
 *      This is the ONLY CT MINT in the whole house-bot system (a deliberate, audited
 *      one-time supply injection — same class as a quest/daily-login credit). It is
 *      GUARDED against re-minting: a restart only tops up a genuine deficit toward
 *      the bankroll target, and only when below the configured low-alarm floor, so
 *      `ensure()` on every boot never re-issues a full bankroll.
 *
 *   2. M BOT-POOL avatars — `poker-bot-NNN@house.clawville.internal`, avatar name
 *      'Felt-Bot-NNN', `isActive=false`, `clawTokens=0`. These hold ZERO CT; their
 *      chips come from the house bank at seat time (a house-bank DEBIT), never from
 *      their own wallet. They exist only so `poker_cash_seats.avatar_id` (FK →
 *      avatars) is valid for a seeded seat. M = `CASH_HOUSE_BOT_POOL_SIZE` (24).
 *
 * After `ensure()` the service exposes:
 *   - `houseBankAvatarId(): string`     — the house-bank provider seam target.
 *   - `claim(tableId, seatIndex)`       — reserve a free bot for a (table,seat).
 *   - `release(tableId, seatIndex)` / `releaseTable(tableId)` — free reservations.
 *   - `isBotAvatar(avatarId): boolean`  — pool membership check (anti-farm / audit).
 *
 * The bot reservation pool mirrors `activity/bots/bot-pool.ts`: process-local,
 * per-(table,seat) uniqueness, recyclable across tables, never two LIVE seats on the
 * same bot uuid concurrently. On pod restart the maps are rehydrated from active
 * seeded `poker_cash_seats` rows before the scaler/tick starts. Those authoritative
 * rows already own their stack/escrow/totals; rehydration only restores reservations
 * and never moves money.
 *
 * MONEY DISCIPLINE: the ONLY write to a CT balance here is the single guarded
 * bankroll `creditClawTokens` (house bank). Bot avatars are NEVER credited. Per-seat
 * and per-hand CT flow is owned by the manager (house-bank debit at seat, credit
 * back at reclaim) — this seeder never touches `avatars.clawTokens` directly.
 */

import { eq, and, inArray, ne, sql } from 'drizzle-orm';
import {
  db,
  users,
  avatars,
  clawTokenTransactions,
  pokerCashSeats,
} from '@clawville/database';
import { creditClawTokens } from '../claw-token-ledger';
import { recordCovenantAction } from '../covenant-action-recorder';
import { houseBankBankroll, houseBankLowAlarm, houseBotPoolSize } from './cash-house-config';

// ── Stable naming (single source of truth — DO NOT change without a re-seed) ──

const HOUSE_DOMAIN = '@house.clawville.internal';
const HOUSE_BANK_EMAIL = `poker-house-bank${HOUSE_DOMAIN}`;
const HOUSE_BANK_AVATAR_NAME = 'Poker House Bank';
const BOT_EMAIL_PREFIX = 'poker-bot-';
const BOT_AVATAR_NAME_PREFIX = 'Felt-Bot-';

/** The audited, one-time bankroll-mint ledger reason. Guarded against re-mint. */
export const HOUSE_BANK_SEED_REASON = 'poker_cash_house_bank_seed';

function botEmail(index: number): string {
  return `${BOT_EMAIL_PREFIX}${String(index).padStart(3, '0')}${HOUSE_DOMAIN}`;
}
function botAvatarName(index: number): string {
  return `${BOT_AVATAR_NAME_PREFIX}${String(index).padStart(3, '0')}`;
}
/** Stable, `hatcher:`-FREE agentId for a seeded bot seat (NOT a reserved namespace). */
function botAgentId(index: number): string {
  return `${BOT_EMAIL_PREFIX}${String(index).padStart(3, '0')}`;
}

// Deterministic per-index render traits so seeded seats look distinguishable on
// the felt without leaking any per-bot skill difference (all bots share one policy).
const SPECIES = ['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle'] as const;
const COLORS = ['green', 'red', 'blue', 'yellow'] as const;
const GENDERS = ['male', 'female'] as const;
const ARCHETYPE = 'brave-adventurer'; // benign default; bots never chat / run Eliza

export interface BotSlot {
  /** 1..M */
  index: number;
  /** Stable agentId, e.g. 'poker-bot-001'. */
  agentId: string;
  /** Display name, e.g. 'Felt-Bot-001'. */
  name: string;
  /** avatars.id uuid — what lands in poker_cash_seats.avatar_id. */
  avatarId: string;
}

export interface ActiveSeededBotSeat {
  tableId: string;
  seatIndex: number;
  avatarId: string;
}

/** What `claim()` hands the manager's `seededAgentProvider` seam. */
export interface ClaimedBot {
  avatarId: string;
  agentId: string;
  name: string;
}

/**
 * Thrown by the `seededAgentProvider` closure when the bot pool is exhausted.
 * The manager's per-seat fill loop should treat this as "seat fewer bots" (skip),
 * NOT a fatal error — pool exhaustion must never crash a human's sit. Recognizable
 * by `instanceof` so the runtime fill path can catch it precisely.
 */
export class CashBotPoolExhaustedError extends Error {
  constructor(public readonly tableId: string, public readonly seatIndex: number) {
    super(`cash_bot_pool_exhausted: no free bot for ${tableId} seat ${seatIndex}`);
    this.name = 'CashBotPoolExhaustedError';
  }
}

/**
 * The `users` CHECK `users_has_auth_method` requires (email + password_hash) OR
 * identity_fingerprint. House/bot users never log in, so we give a deterministic,
 * unusable scrypt-shaped placeholder password to satisfy the constraint — obvious
 * at a glance that it is disabled.
 */
function disabledPasswordHash(tag: string): string {
  return `$house$disabled$${tag}-${Buffer.from(tag).toString('base64')}`;
}

class CashHouseSeederService {
  private houseBankId: string | null = null;
  private slots: BotSlot[] = [];
  private ensured = false;
  private ensuringPromise: Promise<void> | null = null;

  /** avatarId → 'table:seat' reservation key (one live seat per bot uuid). */
  private reservations = new Map<string, string>();

  /** (tableId, seatIndex) → avatarId, so a re-claim of the same seat is idempotent. */
  private seatToAvatar = new Map<string, string>();

  private seatKey(tableId: string, seatIndex: number): string {
    return `${tableId}:${seatIndex}`;
  }

  /**
   * Idempotent boot provision. Safe to call on every restart. Concurrent callers
   * await the same in-flight promise (race-safe).
   */
  async ensure(): Promise<void> {
    if (this.ensured) return;
    if (this.ensuringPromise) return this.ensuringPromise;
    this.ensuringPromise = this.runEnsure();
    try {
      await this.ensuringPromise;
    } finally {
      this.ensuringPromise = null;
    }
  }

  private async runEnsure(): Promise<void> {
    // 1. House-bank user + avatar.
    const bankAvatarId = await this.upsertSystemAvatar({
      email: HOUSE_BANK_EMAIL,
      avatarName: HOUSE_BANK_AVATAR_NAME,
      ownerName: 'Poker House',
      index: 0,
    });
    this.houseBankId = bankAvatarId;

    // 2. House-bank bankroll — the ONE guarded, audited CT mint.
    await this.ensureBankroll(bankAvatarId);

    // 3. Bot pool (M avatars, zero CT).
    const M = houseBotPoolSize();
    const slots: BotSlot[] = [];
    for (let i = 1; i <= M; i++) {
      const avatarId = await this.upsertSystemAvatar({
        email: botEmail(i),
        avatarName: botAvatarName(i),
        ownerName: `Poker Bot Owner ${String(i).padStart(3, '0')}`,
        index: i,
      });
      slots.push({ index: i, agentId: botAgentId(i), name: botAvatarName(i), avatarId });
    }
    slots.sort((a, b) => a.index - b.index);
    this.slots = slots;

    // Active cash seats survive a process restart; the reservation maps do not.
    // Restore them before `ensured=true` lets the scaler/tick claim any bot.
    await this.rehydrateReservationsFromDb();
    this.ensured = true;

    console.log(
      `[cash-house-seeder] ensured house bank ${bankAvatarId} + ${slots.length}/${M} bot avatars; ` +
        `${this.reservations.size} active reservations rehydrated`,
    );
  }

  private async rehydrateReservationsFromDb(): Promise<void> {
    if (this.slots.length === 0) {
      this.rehydrateReservations([]);
      return;
    }
    const rows = await db
      .select({
        tableId: pokerCashSeats.tableId,
        seatIndex: pokerCashSeats.seatIndex,
        avatarId: pokerCashSeats.avatarId,
      })
      .from(pokerCashSeats)
      .where(
        and(
          eq(pokerCashSeats.isSeeded, 'true'),
          ne(pokerCashSeats.status, 'left'),
          inArray(
            pokerCashSeats.avatarId,
            this.slots.map((slot) => slot.avatarId),
          ),
        ),
      );
    this.rehydrateReservations(rows);
  }

  /**
   * Restore process-local reservations from authoritative active DB seats.
   * Duplicate active rows for one bot are historical divergence: bind the
   * deterministic first row and warn, but never mutate either seat or money.
   */
  private rehydrateReservations(rows: readonly ActiveSeededBotSeat[]): void {
    this.reservations.clear();
    this.seatToAvatar.clear();

    const ordered = [...rows].sort(
      (a, b) =>
        a.tableId.localeCompare(b.tableId) ||
        a.seatIndex - b.seatIndex ||
        a.avatarId.localeCompare(b.avatarId),
    );
    for (const row of ordered) {
      const sk = this.seatKey(row.tableId, row.seatIndex);
      if (!this.isBotAvatar(row.avatarId)) continue;
      const reservedAt = this.reservations.get(row.avatarId);
      const occupant = this.seatToAvatar.get(sk);
      if (reservedAt || occupant) {
        console.warn(
          `[cash-house-seeder] reservation rehydrate divergence for bot ${row.avatarId} ` +
            `at ${sk}; keeping ${reservedAt ?? occupant}`,
        );
        continue;
      }
      this.reservations.set(row.avatarId, sk);
      this.seatToAvatar.set(sk, row.avatarId);
    }
  }

  /**
   * Upsert one system user + its single avatar (avatars.userId + name are unique).
   * Returns the avatarId. Idempotent: re-finds existing rows, never duplicates.
   */
  private async upsertSystemAvatar(opts: {
    email: string;
    avatarName: string;
    ownerName: string;
    index: number;
  }): Promise<string> {
    const { email, avatarName, ownerName, index } = opts;

    // User.
    let userId: string;
    const existingUser = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (existingUser) {
      userId = existingUser.id;
    } else {
      const [created] = await db
        .insert(users)
        .values({
          email,
          passwordHash: disabledPasswordHash(`${index}-${email}`),
          name: ownerName,
          emailVerified: true,
        })
        .returning({ id: users.id });
      userId = created.id;
    }

    // Avatar (one per user — avatars.userId is unique).
    const existingAvatar = await db.query.avatars.findFirst({
      where: eq(avatars.userId, userId),
    });
    if (existingAvatar) return existingAvatar.id;

    const species = SPECIES[index % SPECIES.length];
    const color = COLORS[index % COLORS.length];
    const gender = GENDERS[index % GENDERS.length];

    const avatar = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(avatars)
        .values({
          userId,
          name: avatarName,
          species,
          color,
          gender,
          archetype: ARCHETYPE,
          personality: {
            habitat: 'The Cove',
            hobby: 'Dealing cash poker',
            greeting: 'Seat open.',
          },
          stats: { strength: 5, defence: 5, movement: 5 },
          clawTokens: 0, // bots hold 0; the house bank is credited separately below
          // F1 vCLAW provenance: mirror clawTokens (0) into softBalance so the
          // avatars_vclaw_balance_sum CHECK holds (0 = 0+0+0). CRITICAL: without this
          // the column DEFAULT 100 would make a bare insert 100, breaking 0 = 100.
          softBalance: 0,
          isActive: false, // not visible in the NPC simulation
          agentCategory: 'openclaw',
          modelKey: 'lobster',
          harness: 'milady',
        })
        .returning({ id: avatars.id, clawTokens: avatars.clawTokens });
      await recordCovenantAction(
        {
          action: 'economy.genesis',
          subjectType: 'avatar',
          subjectId: inserted.id,
          actorKind: 'system',
          dedupeKey: `avatar:${inserted.id}:genesis`,
          payload: { amount: inserted.clawTokens, provenance: 'soft', reason: 'avatar_genesis' },
        },
        tx,
      );
      return inserted;
    });
    return avatar.id;
  }

  /**
   * Credit the house-bank avatar to the bankroll target ONCE, guarded against
   * re-minting on restart:
   *   - If a `poker_cash_house_bank_seed` ledger row already exists AND the current
   *     balance is at/above the low-alarm floor → no-op (the common restart path).
   *   - Otherwise top up only the DEFICIT to the bankroll target (covers first
   *     provision AND a genuine drained-below-floor refill), never a full re-mint.
   * The credit's `source:'system'` makes it auditable in claw_token_transactions.
   */
  private async ensureBankroll(bankAvatarId: string): Promise<void> {
    const target = houseBankBankroll();
    const floor = houseBankLowAlarm();
    if (target <= 0) return;

    // The bankroll credit is the ONLY CT injection in the cash-poker economy, so
    // it must happen EXACTLY ONCE, ever — a SINGLE guarded mint, never repeated.
    // Two failure modes this must rule out:
    //   (1) auto-re-mint on drain — if the bank were topped up whenever its balance
    //       dipped below the alarm floor, a skilled player draining it would mint
    //       fresh CT on the next boot = a slow faucet. So once seeded we NEVER mint
    //       again; a drain warns LOUDLY and requires a DELIBERATE manual refill.
    //   (2) concurrent-boot double-mint — two pods booting at once both observing
    //       "never seeded" and both crediting. A pg advisory lock serializes the
    //       check+credit so the seed is globally exactly-once.
    const SEED_LOCK_KEY = 920_614_001; // distinct fixed advisory-lock id for the house-bank seed
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`);

      // Re-read UNDER the lock: has this bank ever been seeded?
      const priorSeed = await tx
        .select({ id: clawTokenTransactions.id })
        .from(clawTokenTransactions)
        .where(
          and(
            eq(clawTokenTransactions.avatarId, bankAvatarId),
            eq(clawTokenTransactions.reason, HOUSE_BANK_SEED_REASON),
          ),
        )
        .limit(1);

      if (priorSeed.length > 0) {
        // Already seeded — single-mint invariant: NEVER re-mint. Alarm if drained.
        const bankRow = await tx
          .select({ clawTokens: avatars.clawTokens })
          .from(avatars)
          .where(eq(avatars.id, bankAvatarId))
          .limit(1);
        const balance = bankRow[0]?.clawTokens ?? 0;
        if (balance < floor) {
          console.warn(
            `[cash-house-seeder] house bank balance ${balance} below low-alarm ${floor} — ` +
              `NOT auto-refilling (single-mint invariant); a deliberate manual refill is required.`,
          );
        }
        return;
      }

      // First and ONLY provision: mint the full bankroll inside this locked tx.
      await creditClawTokens(
        {
          avatarId: bankAvatarId,
          amount: target,
          reason: HOUSE_BANK_SEED_REASON,
          source: 'system',
          metadata: {
            bankroll_target: target,
            note: 'house-bank one-time bankroll seed (single-mint; never auto-refilled)',
          },
          actorKind: 'system',
        },
        tx,
      );
      console.log(`[cash-house-seeder] house bank seeded ${target} CT (one-time, advisory-locked)`);
    });
  }

  // ── Provider seams ─────────────────────────────────────────────────────────

  /** The house-bank avatarId. Throws if `ensure()` has not run. */
  houseBankAvatarId(): string {
    if (!this.houseBankId) {
      throw new Error('[cash-house-seeder] houseBankAvatarId() before ensure() — boot ordering bug');
    }
    return this.houseBankId;
  }

  /**
   * Reserve a free bot for (tableId, seatIndex). Idempotent per seat: re-claiming
   * the SAME (table,seat) returns the SAME bot. Picks the first pool bot not
   * currently reserved to a live seat. Returns null if the pool is exhausted (the
   * manager then simply seats fewer bots — never mints, never errors).
   */
  claim(tableId: string, seatIndex: number): ClaimedBot | null {
    if (!this.ensured || this.slots.length === 0) {
      console.warn('[cash-house-seeder] claim() before ensure() finished — no bot available');
      return null;
    }
    const sk = this.seatKey(tableId, seatIndex);

    // Idempotent re-claim of the same seat.
    const existing = this.seatToAvatar.get(sk);
    if (existing) {
      const slot = this.slots.find((s) => s.avatarId === existing);
      if (slot) return { avatarId: slot.avatarId, agentId: slot.agentId, name: slot.name };
      // Stale mapping (shouldn't happen) — fall through to a fresh claim.
      this.seatToAvatar.delete(sk);
    }

    for (const slot of this.slots) {
      if (this.reservations.has(slot.avatarId)) continue;
      this.reservations.set(slot.avatarId, sk);
      this.seatToAvatar.set(sk, slot.avatarId);
      return { avatarId: slot.avatarId, agentId: slot.agentId, name: slot.name };
    }
    console.warn(
      `[cash-house-seeder] bot pool exhausted (M=${this.slots.length}) — seating fewer bots at ${tableId}`,
    );
    return null;
  }

  /**
   * Bind a reservation to an already-active authoritative DB seat. This is the
   * same-table reconciliation path: maps only, zero seat/stack/escrow/ledger writes.
   */
  bindReservation(tableId: string, seatIndex: number, avatarId: string): boolean {
    if (!this.isBotAvatar(avatarId)) return false;
    const sk = this.seatKey(tableId, seatIndex);

    const previousSeat = this.reservations.get(avatarId);
    if (previousSeat && previousSeat !== sk) {
      this.seatToAvatar.delete(previousSeat);
    }
    const previousAvatar = this.seatToAvatar.get(sk);
    if (previousAvatar && previousAvatar !== avatarId) {
      this.reservations.delete(previousAvatar);
    }
    this.reservations.set(avatarId, sk);
    this.seatToAvatar.set(sk, avatarId);
    return true;
  }

  /** Release the bot reserved to (tableId, seatIndex). Idempotent. */
  release(tableId: string, seatIndex: number): void {
    const sk = this.seatKey(tableId, seatIndex);
    const avatarId = this.seatToAvatar.get(sk);
    if (avatarId) {
      this.reservations.delete(avatarId);
      this.seatToAvatar.delete(sk);
    }
  }

  /** Release every bot reserved to any seat of `tableId` (table close). Idempotent. */
  releaseTable(tableId: string): void {
    const prefix = `${tableId}:`;
    for (const [sk, avatarId] of this.seatToAvatar.entries()) {
      if (sk.startsWith(prefix)) {
        this.reservations.delete(avatarId);
        this.seatToAvatar.delete(sk);
      }
    }
  }

  /** Pool-membership check (anti-farm / leaderboard exclusion / audit). */
  isBotAvatar(avatarId: string): boolean {
    return this.slots.some((s) => s.avatarId === avatarId);
  }

  /** All bot avatarIds (anti-farm / leaderboard exclusion query). */
  botAvatarIds(): string[] {
    return this.slots.map((s) => s.avatarId);
  }

  /** Diagnostic — live reservation count. */
  reservedCount(): number {
    return this.reservations.size;
  }

  /** Test hook — wipe in-memory state. */
  __resetForTest(opts?: { houseBankId?: string; slots?: BotSlot[] }): void {
    this.houseBankId = opts?.houseBankId ?? null;
    this.slots = opts?.slots ?? [];
    this.ensured = !!opts;
    this.ensuringPromise = null;
    this.reservations.clear();
    this.seatToAvatar.clear();
  }

  /** Test hook: model a process restart from authoritative active seat rows. */
  __rehydrateForTest(rows: readonly ActiveSeededBotSeat[]): void {
    this.rehydrateReservations(rows);
  }
}

export const cashHouseSeeder = new CashHouseSeederService();

/** Re-export the bot-id helpers for tests / the offline seed script. */
export { botEmail, botAvatarName, botAgentId, HOUSE_BANK_EMAIL, HOUSE_BANK_AVATAR_NAME };
