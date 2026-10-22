/**
 * Shared-table baccarat: VISUAL-ONLY bot pool seeder (idempotent, runs on every API boot).
 *
 * Spec: `~/.clawville-brain/plans/baccarat-shared-table-port-2026-10-22.md` section 2.7.
 *
 * Seeded baccarat bots sit at house tables for ambiance ONLY. They NEVER bet, so
 * this file has NO money path: no house bank, no mint, no ledger call. It provisions
 * M `bac-bot-NNN@house.clawville.internal` users + one zero-vCLAW, inactive avatar
 * each (so a `baccarat_table_seats` row has a valid `avatar_id`), and hands the
 * manager a free `{ avatarId, agentId, name }` per (table, seat).
 *
 * Avatar insert shape = staging `poker/cash-house-seeder.ts` (D-fix vs the June
 * seeder): `softBalance: 0` keeps the `avatars_vclaw_balance_sum` CHECK true
 * (0 = 0 + 0 + 0; the column default is 100), and the `economy.genesis` covenant
 * action records the zero genesis in the same tx.
 *
 * D9 fix: `ensure()` rebuilds the in-memory reservations from
 * `baccarat_table_seats WHERE is_seeded AND status='seated'`, so after a restart a
 * bot already seated at one table is never handed to a second table. The DB unique
 * `(avatar_id) WHERE status='seated'` is the hard backstop.
 *
 * Bots get no hosted runtime (the `@house.clawville.internal` domain, like the
 * poker bots) and the manager refuses any bet from a pool avatar at three points.
 */

import { and, eq } from 'drizzle-orm';
import { db, users, avatars, baccaratTableSeats } from '@clawville/database';
import { recordCovenantAction } from '../covenant-action-recorder';
import { baccaratHouseBotPoolSize } from './baccarat-house-config';
import type { BaccaratSeededBotPool, ClaimedBaccaratBot } from './baccarat-table-manager';

const HOUSE_DOMAIN = '@house.clawville.internal';
const BOT_EMAIL_PREFIX = 'bac-bot-';
const BOT_AVATAR_NAME_PREFIX = 'Bac-Bot-';

function pad(index: number): string {
  return String(index).padStart(3, '0');
}
function botEmail(index: number): string {
  return `${BOT_EMAIL_PREFIX}${pad(index)}${HOUSE_DOMAIN}`;
}
function botAvatarName(index: number): string {
  return `${BOT_AVATAR_NAME_PREFIX}${pad(index)}`;
}
/** Stable agentId for a seeded seat. Not a reserved namespace (no `hatcher:`). */
function botAgentId(index: number): string {
  return `${BOT_EMAIL_PREFIX}${pad(index)}`;
}

// Deterministic per-index traits so seeded seats look different.
const SPECIES = ['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle'] as const;
const COLORS = ['green', 'red', 'blue', 'yellow'] as const;
const GENDERS = ['male', 'female'] as const;
const ARCHETYPE = 'brave-adventurer';
/** The hold'em seat VRM list (`holdem-table-room.tsx`); every key is in `agent-models.ts`. */
const BOT_MODEL_KEYS = [
  'milady_official_2',
  'milady_official_5',
  'hermes_female',
  'milady_official_7',
  'milady_official_4',
] as const;

interface BotSlot {
  index: number;
  agentId: string;
  name: string;
  avatarId: string;
}

function disabledPasswordHash(tag: string): string {
  return `$house$disabled$${tag}-${Buffer.from(tag).toString('base64')}`;
}

class BaccaratHouseSeederService implements BaccaratSeededBotPool {
  private slots: BotSlot[] = [];
  private botIds = new Set<string>();
  private ensured = false;
  private ensuringPromise: Promise<void> | null = null;

  /** avatarId -> 'table:seat' (one live seat per bot). */
  private reservations = new Map<string, string>();
  /** 'table:seat' -> avatarId (a re-claim of the same seat is idempotent). */
  private seatToAvatar = new Map<string, string>();

  private seatKey(tableId: string, seatIndex: number): string {
    return `${tableId}:${seatIndex}`;
  }

  /** Idempotent boot provision. Concurrent callers share one in-flight promise. */
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
    const M = baccaratHouseBotPoolSize();
    const slots: BotSlot[] = [];
    for (let i = 1; i <= M; i++) {
      const avatarId = await this.upsertSystemAvatar(i);
      slots.push({ index: i, agentId: botAgentId(i), name: botAvatarName(i), avatarId });
    }
    slots.sort((a, b) => a.index - b.index);
    this.slots = slots;
    this.botIds = new Set(slots.map((s) => s.avatarId));
    await this.rebuildReservations();
    this.ensured = true;
    console.log(
      `[baccarat-house-seeder] ensured ${slots.length}/${M} visual-only bot avatars, ${this.reservations.size} seated`,
    );
  }

  /** D9: re-adopt every bot seat the DB says is still seated. */
  private async rebuildReservations(): Promise<void> {
    this.reservations.clear();
    this.seatToAvatar.clear();
    const rows = await db
      .select({
        tableId: baccaratTableSeats.tableId,
        seatIndex: baccaratTableSeats.seatIndex,
        avatarId: baccaratTableSeats.avatarId,
      })
      .from(baccaratTableSeats)
      .where(and(eq(baccaratTableSeats.isSeeded, true), eq(baccaratTableSeats.status, 'seated')));
    for (const r of rows) {
      const sk = this.seatKey(r.tableId, r.seatIndex);
      this.reservations.set(r.avatarId, sk);
      this.seatToAvatar.set(sk, r.avatarId);
    }
  }

  /** Upsert one system user + its single avatar (zero vCLAW, inactive). Idempotent. */
  private async upsertSystemAvatar(index: number): Promise<string> {
    const email = botEmail(index);
    let userId: string;
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existingUser) {
      userId = existingUser.id;
    } else {
      const [created] = await db
        .insert(users)
        .values({
          email,
          passwordHash: disabledPasswordHash(`${index}-${email}`),
          name: `Baccarat Bot Owner ${pad(index)}`,
          emailVerified: true,
        })
        .returning({ id: users.id });
      if (!created) throw new Error(`[baccarat-house-seeder] user insert failed for ${email}`);
      userId = created.id;
    }

    // One avatar per user (avatars.userId is unique).
    const [existingAvatar] = await db
      .select({ id: avatars.id })
      .from(avatars)
      .where(eq(avatars.userId, userId))
      .limit(1);
    if (existingAvatar) return existingAvatar.id;

    const avatar = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(avatars)
        .values({
          userId,
          name: botAvatarName(index),
          species: SPECIES[index % SPECIES.length],
          color: COLORS[index % COLORS.length],
          gender: GENDERS[index % GENDERS.length],
          archetype: ARCHETYPE,
          personality: { habitat: 'The Cove', hobby: 'Watching baccarat', greeting: 'Place your bets.' },
          stats: { strength: 5, defence: 5, movement: 5 },
          clawTokens: 0, // visual-only; never bets, never credited
          // Mirror clawTokens (0) into softBalance so avatars_vclaw_balance_sum holds
          // (the column default is 100; a bare insert would break 0 = 100).
          softBalance: 0,
          isActive: false, // not in the NPC simulation
          agentCategory: 'milady',
          modelKey: BOT_MODEL_KEYS[(index - 1) % BOT_MODEL_KEYS.length],
          harness: 'milady',
        })
        .returning({ id: avatars.id, clawTokens: avatars.clawTokens });
      if (!inserted) throw new Error(`[baccarat-house-seeder] avatar insert failed for ${email}`);
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
   * Reserve a free bot for (tableId, seatIndex). Idempotent per seat. Returns null when
   * the pool is exhausted (the table seats fewer bots; never an error).
   */
  claim(tableId: string, seatIndex: number): ClaimedBaccaratBot | null {
    if (!this.ensured || this.slots.length === 0) {
      console.warn('[baccarat-house-seeder] claim() before ensure() finished; no bot available');
      return null;
    }
    const sk = this.seatKey(tableId, seatIndex);
    const existing = this.seatToAvatar.get(sk);
    if (existing) {
      const slot = this.slots.find((s) => s.avatarId === existing);
      if (slot) return { avatarId: slot.avatarId, agentId: slot.agentId, name: slot.name };
      this.seatToAvatar.delete(sk);
      this.reservations.delete(existing);
    }
    for (const slot of this.slots) {
      if (this.reservations.has(slot.avatarId)) continue;
      this.reservations.set(slot.avatarId, sk);
      this.seatToAvatar.set(sk, slot.avatarId);
      return { avatarId: slot.avatarId, agentId: slot.agentId, name: slot.name };
    }
    console.warn(`[baccarat-house-seeder] bot pool exhausted (M=${this.slots.length}) at ${tableId}`);
    return null;
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

  /** Release every bot reserved at `tableId` (table close). Idempotent. */
  releaseTable(tableId: string): void {
    const prefix = `${tableId}:`;
    for (const [sk, avatarId] of [...this.seatToAvatar.entries()]) {
      if (sk.startsWith(prefix)) {
        this.reservations.delete(avatarId);
        this.seatToAvatar.delete(sk);
      }
    }
  }

  /** Pool membership (the manager's bet guards + anti-farm). */
  isBot(avatarId: string): boolean {
    return this.botIds.has(avatarId);
  }

  /** Alias kept for callers of the June name. */
  isBotAvatar(avatarId: string): boolean {
    return this.isBot(avatarId);
  }

  botAvatarIds(): string[] {
    return this.slots.map((s) => s.avatarId);
  }

  /** Test hook: wipe in-memory state (optionally preload slots). */
  __resetForTest(opts?: { slots?: BotSlot[] }): void {
    this.slots = opts?.slots ?? [];
    this.botIds = new Set(this.slots.map((s) => s.avatarId));
    this.ensured = !!opts;
    this.ensuringPromise = null;
    this.reservations.clear();
    this.seatToAvatar.clear();
  }
}

export const baccaratHouseSeeder = new BaccaratHouseSeederService();

export { botEmail, botAvatarName, botAgentId, BOT_MODEL_KEYS };
