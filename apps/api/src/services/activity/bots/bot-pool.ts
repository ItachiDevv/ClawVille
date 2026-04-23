/**
 * Q2 Activity Portals — bot petId reservation pool (chunk #10).
 *
 * Why a pool:
 *   - `activity_room_participants.pet_id` is a `uuid NOT NULL REFERENCES
 *     pets(id)` — see `packages/database/src/schema/activity-room-participants.ts`
 *     ("pet_id MUST exist in pets even for bots").
 *   - The matcher needs a stable, recyclable set of valid bot petIds it
 *     can hand the room manager. A run of `seed-bot-pets.ts` pre-creates
 *     64 pet rows owned by per-bot system users; this pool service
 *     hydrates the petIds at boot and hands them out under a per-room
 *     reservation lock.
 *
 * Allocation contract:
 *   - Per-room uniqueness only — recycle across rooms. A given bot uuid
 *     may participate in any number of distinct rooms over time, just
 *     never two LIVE rooms concurrently.
 *   - Allocation is in-memory only; if the pod crashes the reservations
 *     are dropped and the next boot starts clean. Acceptable since the
 *     room manager's `recoverOrphanedRooms()` would mark any in-flight
 *     bot-bearing rooms as `aborted_crash` anyway.
 *
 * Naming:
 *   - The pool stores both the database `pets.id` (uuid) AND a stable
 *     "slot id" (`bot-001` … `bot-064`) for log ergonomics. `slotId` is
 *     stable across pod restarts because `seed-bot-pets.ts` always
 *     allocates slot N to a deterministic name (`Bot-Crab-001`).
 *   - Wire-side, only `petId` (uuid) is used — clients never see slotId.
 */

import { eq, and, inArray, asc } from 'drizzle-orm';
import { db, pets, users } from '@clawville/database';

/**
 * Capacity must match `seed-bot-pets.ts` exactly. Bumping this requires
 * a re-seed.
 */
export const BOT_POOL_CAPACITY = 64;

/** Email pattern used by seed-bot-pets.ts. Single source of truth — DO NOT change without re-seeding. */
export const BOT_USER_EMAIL_PREFIX = 'bot-';
export const BOT_USER_EMAIL_DOMAIN = '@bots.clawville.internal';
/** Stable display name pattern — `Bot-Crab-001` … `Bot-Crab-064`. */
export const BOT_PET_NAME_PREFIX = 'Bot-Crab-';

interface BotSlot {
  /** 1..BOT_POOL_CAPACITY */
  index: number;
  /** Stable label e.g. 'bot-001' for logs */
  slotId: string;
  /** UUID from pets.id — what gets persisted in activity_room_participants */
  petId: string;
}

class BotPoolService {
  /** Hydrated at first use from the DB. */
  private slots: BotSlot[] | null = null;

  /** Hydration in-flight promise for race-safe lazy load. */
  private hydratingPromise: Promise<void> | null = null;

  /** SINGLE-POD: petId → roomId of CURRENT reservation, if any. */
  private reservations = new Map<string, string>();

  /**
   * Hydrate the slot list from the DB. Idempotent — safe to call
   * repeatedly. The first call wins; concurrent callers await the same
   * promise.
   */
  async hydrate(): Promise<void> {
    if (this.slots) return;
    if (this.hydratingPromise) return this.hydratingPromise;
    this.hydratingPromise = (async () => {
      const rows = await db
        .select({ id: pets.id, name: pets.name })
        .from(pets)
        .innerJoin(users, eq(users.id, pets.userId))
        .where(
          and(
            inArray(
              users.email,
              Array.from({ length: BOT_POOL_CAPACITY }, (_, i) => botUserEmail(i + 1)),
            ),
          ),
        )
        .orderBy(asc(pets.name));
      const slots: BotSlot[] = rows.map((r) => {
        // Parse "Bot-Crab-NNN" → index. If it doesn't match the pattern
        // we still include the row (don't lose a seed) but log loudly.
        const match = r.name.match(/^Bot-Crab-(\d{3})$/);
        if (!match) {
          console.warn(
            `[bot-pool] Unexpected bot pet name "${r.name}" — re-run seed-bot-pets.ts to fix`,
          );
        }
        const index = match ? Number(match[1]) : 0;
        return {
          index,
          slotId: `bot-${String(index || 0).padStart(3, '0')}`,
          petId: r.id,
        };
      });
      // Sort by index so slot[0] = bot-001.
      slots.sort((a, b) => a.index - b.index);
      this.slots = slots;
      if (slots.length === 0) {
        console.warn(
          '[bot-pool] No seeded bot pets found — solo Bumper queues will sit forever. Run `bun run scripts/seed-bot-pets.ts`.',
        );
      } else if (slots.length < BOT_POOL_CAPACITY) {
        console.warn(
          `[bot-pool] Hydrated ${slots.length}/${BOT_POOL_CAPACITY} bot slots — partial seed. Re-run seed-bot-pets.ts.`,
        );
      } else {
        console.log(`[bot-pool] Hydrated ${slots.length} bot slots`);
      }
    })();
    try {
      await this.hydratingPromise;
    } finally {
      this.hydratingPromise = null;
    }
  }

  /**
   * Reserve `count` bot petIds for a single room. Returns the empty
   * array if not enough free slots are available right now (caller
   * should fall back to "wait longer" instead of half-filling).
   *
   * Reservations are released by `releaseRoom(roomId)`.
   */
  reserve(roomId: string, count: number): string[] {
    if (!this.slots) {
      console.warn(
        '[bot-pool] reserve() called before hydrate() finished — returning empty',
      );
      return [];
    }
    if (count <= 0) return [];
    const out: string[] = [];
    for (const slot of this.slots) {
      if (out.length === count) break;
      if (this.reservations.has(slot.petId)) continue;
      out.push(slot.petId);
    }
    if (out.length < count) return [];
    for (const petId of out) this.reservations.set(petId, roomId);
    return out;
  }

  /** Release all reservations for `roomId`. Idempotent. */
  releaseRoom(roomId: string): void {
    for (const [petId, reservedRoom] of this.reservations.entries()) {
      if (reservedRoom === roomId) this.reservations.delete(petId);
    }
  }

  /**
   * Re-bind an existing reservation from one room id to another. Used by
   * the matcher to atomically swap the placeholder `pending-room` key
   * for the freshly-allocated room uuid AFTER `createRoom` succeeds —
   * keeps reservation lookups consistent without a release/re-reserve
   * race.
   *
   * Throws if any of the supplied petIds isn't currently reserved by
   * `fromRoomId` — defensive against double-rebinds.
   */
  rebindReservation(petIds: string[], fromRoomId: string, toRoomId: string): void {
    for (const petId of petIds) {
      const current = this.reservations.get(petId);
      if (current !== fromRoomId) {
        throw new Error(
          `[bot-pool] rebind failed: ${petId} is reserved by ${current ?? '<none>'} not ${fromRoomId}`,
        );
      }
      this.reservations.set(petId, toRoomId);
    }
  }

  /** Lookup helper — returns true if petId belongs to the pool (any state). */
  isBot(petId: string): boolean {
    if (!this.slots) return false;
    return this.slots.some((s) => s.petId === petId);
  }

  /** Diagnostic — total seeded slots in the pool. */
  capacity(): number {
    return this.slots?.length ?? 0;
  }

  /** Diagnostic — slots currently reserved. */
  inUseCount(): number {
    return this.reservations.size;
  }

  /** Test hook — wipe in-memory state. */
  __resetForTest(slots?: BotSlot[]): void {
    this.slots = slots ?? null;
    this.reservations.clear();
    this.hydratingPromise = null;
  }
}

export function botUserEmail(index: number): string {
  return `${BOT_USER_EMAIL_PREFIX}${String(index).padStart(3, '0')}${BOT_USER_EMAIL_DOMAIN}`;
}

export function botPetName(index: number): string {
  return `${BOT_PET_NAME_PREFIX}${String(index).padStart(3, '0')}`;
}

export const botPool = new BotPoolService();
