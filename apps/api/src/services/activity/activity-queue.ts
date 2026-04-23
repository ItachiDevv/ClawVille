/**
 * Q2 Activity Portals — matchmaker + queue service.
 *
 * Owns:
 *   - In-memory `Map<activityId, QueueEntry[]>` for the matchmaker hot path
 *   - DB persistence to `activity_queue_entries` for pod-restart recovery
 *   - Party CRUD (create, join, kick, leave) backed by `activity_parties`
 *     + `activity_party_members`
 *   - 1Hz matchmaker sweep with party-first FIFO and timeout fallbacks
 *
 * Boot-time hydration (backend §2.2):
 *   On module load, query `activity_queue_entries WHERE left_at IS NULL`
 *   and rebuild the in-memory queues. Liveness is bounded by the queue
 *   TTL (180s default); hydrated entries that no longer have a live WS
 *   are auto-pruned on the first matchmaker tick.
 *
 * Single-pod constraint inherited from the room manager — see backend §1.7.
 *
 * TODOs scattered for later chunks:
 *   - Bot backfill (`subject_type='bot'` controller spawn) → chunk #10
 *   - Per-user 3-concurrent-match Sybil cap → chunk #10
 *   - Agent-only queue filter (?matchType=agent-only) → chunk #3
 *   - WS connection lookup for liveness check → chunk #3
 */

import { v4 as uuidv4 } from 'uuid';
import { eq, and, isNull } from 'drizzle-orm';
import {
  db,
  activityQueueEntries,
  activityParties,
  activityPartyMembers,
} from '@clawville/database';
import type { QueueEntry, Party, QueueStatus } from './types';
import {
  activityRoomManager,
  RoomCapacityError,
  MAX_ROOMS_PER_ACTIVITY,
  MAX_ROOMS_TOTAL,
} from './activity-room-manager';
import { logEvent } from '../event-logger';
import { getActivityDefinition } from '@clawville/shared';

// ─── Constants (backend §2.3) ──────────────────────────────────────────────

/** Drop to minFill if preferredFill not reached by this point */
const QUEUE_TIMEOUT_MS = 20_000;

/** Activate bot backfill if minFill not met by this point */
const EXTENDED_TIMEOUT_MS = 45_000;

/** Hard kill / suggest-other-activity timeout */
const QUEUE_HARD_TIMEOUT_MS = 60_000;

/** Matchmaker sweep cadence */
const MATCH_SWEEP_INTERVAL_MS = 1_000;

/** Party size cap (Q2 plan resolved decisions §2) */
export const MAX_PARTY_SIZE = 4;

/** Party idle GC threshold (no match joined, no chat activity) */
const PARTY_IDLE_GC_MS = 60 * 60_000; // 1h

// Crockford base32 — same alphabet as room short-codes
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PARTY_SHORT_CODE_LENGTH = 6;
const PARTY_SHORT_CODE_RETRY = 16;

// ─── Module state ──────────────────────────────────────────────────────────

class ActivityQueueService {
  /** SINGLE-POD: per-activity queue, FIFO by `queuedAt`. */
  private queues = new Map<string, QueueEntry[]>();

  /** SINGLE-POD: petId → entryId for O(1) leave-queue lookups. */
  private petToEntry = new Map<string, string>();

  /** SINGLE-POD: parties keyed by id. Mirror table is the source of truth. */
  private parties = new Map<string, Party>();

  /** SINGLE-POD: shortCode → partyId index. */
  private partyShortCodeIndex = new Map<string, string>();

  /** Last-time the matcher emitted a bot-backfill warning (rate-limit log). */
  private lastBotBackfillWarn = 0;

  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private hydrated = false;

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Enqueue a pet for an activity. Atomic — caller verifies caps + auth
   * before reaching here. Throws on cap-hit or duplicate-queue.
   */
  async enqueue(input: {
    activityId: string;
    petId: string;
    userId: string | null;
    agentId: string | null;
    subjectType: 'human' | 'agent';
    partyId: string | null;
    wsConnectionId?: string | null;
    allowBotBackfill?: boolean;
    agentOnly?: boolean;
  }): Promise<QueueEntry> {
    if (this.petToEntry.has(input.petId)) {
      throw new Error('Pet is already in a queue');
    }

    // TODO chunk #10: enforce per-user concurrent-match cap of 3.
    // The room manager already exposes getPlayerActiveRoom() — once
    // multi-pet support lands (or auxiliary agent pets), enumerate the
    // user's pets here and refuse if 3+ are active.
    const activeRoom = activityRoomManager.getPlayerActiveRoom(input.petId);
    if (activeRoom) {
      throw new Error(
        `Pet is already in an active room (${activeRoom.id}); leave or finish before re-queueing`,
      );
    }

    // Capacity check — short-circuits before DB write so the route can
    // surface 503 + Retry-After cleanly.
    if (activityRoomManager.totalActiveRooms() >= MAX_ROOMS_TOTAL) {
      const err = new Error('Pod-wide room cap hit; try again shortly') as Error & {
        code?: string;
      };
      err.code = 'pod_capacity';
      throw err;
    }
    if (
      activityRoomManager.listActiveRooms(input.activityId).length >=
      MAX_ROOMS_PER_ACTIVITY
    ) {
      const err = new Error(
        'Activity-specific room cap hit; try again shortly',
      ) as Error & { code?: string };
      err.code = 'activity_capacity';
      throw err;
    }

    const entryId = uuidv4();
    const now = Date.now();
    const entry: QueueEntry = {
      id: entryId,
      activityId: input.activityId,
      petId: input.petId,
      userId: input.userId,
      agentId: input.agentId,
      subjectType: input.subjectType,
      partyId: input.partyId,
      queuedAt: now,
      wsConnectionId: input.wsConnectionId ?? null,
      matched: false,
      allowBotBackfill: input.allowBotBackfill ?? true,
      agentOnly: input.agentOnly ?? false,
    };

    await db.insert(activityQueueEntries).values({
      id: entryId,
      activityId: input.activityId,
      petId: input.petId,
      agentId: input.agentId,
      subjectType: input.subjectType,
      partyId: input.partyId,
      queuedAt: new Date(now),
    });

    this.addToMemory(entry);

    void logEvent({
      eventType: 'activity.queue.joined',
      userId: input.userId,
      agentId: input.agentId,
      petId: input.petId,
      payload: {
        activityId: input.activityId,
        partyId: input.partyId,
        subjectType: input.subjectType,
        agentOnly: entry.agentOnly,
      },
    });

    return entry;
  }

  /**
   * Leave the queue. Idempotent — no-op + 200 if pet wasn't queued.
   * `reason` distinguishes voluntary leave from matcher fulfilment for
   * the event payload.
   */
  async leaveQueue(
    petId: string,
    reason: 'voluntary' | 'matched' | 'timeout' | 'pod_restart' = 'voluntary',
  ): Promise<boolean> {
    const entryId = this.petToEntry.get(petId);
    if (!entryId) return false;

    const entry = this.findEntryInMemory(entryId);
    this.removeFromMemory(petId, entryId);

    await db
      .update(activityQueueEntries)
      .set({ leftAt: new Date() })
      .where(and(eq(activityQueueEntries.id, entryId), isNull(activityQueueEntries.leftAt)));

    if (entry) {
      void logEvent({
        eventType: 'activity.queue.left',
        userId: entry.userId,
        agentId: entry.agentId,
        petId: entry.petId,
        payload: {
          activityId: entry.activityId,
          reason,
        },
      });
    }
    return true;
  }

  /**
   * Status snapshot for `GET /api/activities/:id/queue-status`.
   * Position is 1-indexed; null if the pet isn't queued.
   */
  getQueueStatus(activityId: string, petId: string): QueueStatus {
    const queue = this.queues.get(activityId) ?? [];
    const index = queue.findIndex((e) => e.petId === petId);
    const position = index >= 0 ? index + 1 : null;

    // Crude wait estimate — average inter-match time is ~30s for a
    // healthy population; multiply position by that. Refined in chunk #3
    // once we have real telemetry to back it.
    const estimatedWaitSec = position == null ? 0 : Math.max(5, position * 30);

    return {
      position,
      estimatedWaitSec,
      roomsActive: activityRoomManager.listActiveRooms(activityId).length,
      playersInQueue: queue.length,
      serverAtCapacity:
        activityRoomManager.totalActiveRooms() >= MAX_ROOMS_TOTAL,
    };
  }

  /** Length only — for the public `/api/activities` summary cards. */
  queueLength(activityId: string): number {
    return (this.queues.get(activityId) ?? []).length;
  }

  // ─── Party API ─────────────────────────────────────────────────────────

  async createParty(leaderPetId: string): Promise<Party> {
    if (this.partyForPet(leaderPetId)) {
      throw new Error('Pet is already in a party');
    }
    const id = uuidv4();
    const shortCode = this.generatePartyShortCode();
    const now = Date.now();

    await db.insert(activityParties).values({
      id,
      shortCode,
      leaderPetId,
      createdAt: new Date(now),
    });
    await db.insert(activityPartyMembers).values({
      partyId: id,
      petId: leaderPetId,
      joinedAt: new Date(now),
    });

    const party: Party = {
      id,
      shortCode,
      leaderPetId,
      members: new Set([leaderPetId]),
      createdAt: now,
      disbandedAt: null,
    };
    this.parties.set(id, party);
    this.partyShortCodeIndex.set(shortCode, id);
    return party;
  }

  async joinParty(shortCode: string, petId: string): Promise<Party> {
    const partyId = this.partyShortCodeIndex.get(shortCode.toUpperCase());
    if (!partyId) throw new Error('Party not found');
    const party = this.parties.get(partyId);
    if (!party || party.disbandedAt !== null) throw new Error('Party not found');
    if (party.members.size >= MAX_PARTY_SIZE) {
      throw new Error(`Party is full (cap ${MAX_PARTY_SIZE})`);
    }
    if (party.members.has(petId)) return party;
    if (this.partyForPet(petId)) {
      throw new Error('Pet is already in another party');
    }

    party.members.add(petId);
    await db.insert(activityPartyMembers).values({
      partyId: party.id,
      petId,
      joinedAt: new Date(),
    });
    return party;
  }

  async kickMember(partyId: string, requesterPetId: string, targetPetId: string): Promise<Party> {
    const party = this.parties.get(partyId);
    if (!party) throw new Error('Party not found');
    if (party.leaderPetId !== requesterPetId) {
      throw new Error('Only the party leader can kick members');
    }
    if (targetPetId === party.leaderPetId) {
      throw new Error('Leader cannot be kicked — leave instead');
    }
    if (!party.members.has(targetPetId)) {
      throw new Error('Member is not in this party');
    }

    party.members.delete(targetPetId);
    await db
      .update(activityPartyMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(activityPartyMembers.partyId, partyId),
          eq(activityPartyMembers.petId, targetPetId),
          isNull(activityPartyMembers.leftAt),
        ),
      );

    if (party.members.size === 0) {
      await this.disbandParty(party);
    }
    return party;
  }

  async leaveParty(partyId: string, petId: string): Promise<void> {
    const party = this.parties.get(partyId);
    if (!party) return; // idempotent
    if (!party.members.has(petId)) return;

    party.members.delete(petId);
    await db
      .update(activityPartyMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(activityPartyMembers.partyId, partyId),
          eq(activityPartyMembers.petId, petId),
          isNull(activityPartyMembers.leftAt),
        ),
      );

    if (party.leaderPetId === petId) {
      // Promote the next member to leader (insertion order — oldest member).
      const next = party.members.values().next().value;
      if (next) {
        party.leaderPetId = next;
        await db
          .update(activityParties)
          .set({ leaderPetId: next })
          .where(eq(activityParties.id, party.id));
      }
    }
    if (party.members.size === 0) {
      await this.disbandParty(party);
    }
  }

  getParty(partyId: string): Party | undefined {
    return this.parties.get(partyId);
  }

  partyForPet(petId: string): Party | undefined {
    for (const p of this.parties.values()) {
      if (p.disbandedAt === null && p.members.has(petId)) return p;
    }
    return undefined;
  }

  // ─── Matchmaker ────────────────────────────────────────────────────────

  /**
   * One sweep across every queue. Public so tests can drive a single
   * tick deterministically. Caught/logged so a single-activity bug
   * doesn't kill the cron.
   */
  async runMatchmakerSweep(): Promise<void> {
    for (const [activityId, queue] of this.queues.entries()) {
      try {
        await this.matchActivity(activityId, queue);
      } catch (err) {
        console.error(
          `[activity-queue] sweep failed for ${activityId}:`,
          err,
        );
      }
    }
  }

  /**
   * Boot-time hydration — repopulate queues from `activity_queue_entries`
   * rows where `left_at IS NULL`. Liveness pruning happens on the first
   * matchmaker tick once chunk #3's WS hub provides connection-status.
   */
  async hydrateFromDb(): Promise<void> {
    if (this.hydrated) return;
    try {
      const rows = await db
        .select()
        .from(activityQueueEntries)
        .where(isNull(activityQueueEntries.leftAt));
      for (const row of rows) {
        const entry: QueueEntry = {
          id: row.id,
          activityId: row.activityId,
          petId: row.petId,
          userId: null, // not stored in queue_entries; recovered on first WS auth
          agentId: row.agentId ?? null,
          subjectType: row.subjectType as 'human' | 'agent',
          partyId: row.partyId ?? null,
          queuedAt: (row.queuedAt as Date).getTime(),
          wsConnectionId: null, // never persisted; reattached on WS reconnect
          matched: false,
          allowBotBackfill: true,
          agentOnly: false,
        };
        this.addToMemory(entry);
      }
      this.hydrated = true;
      if (rows.length > 0) {
        console.log(
          `[activity-queue] hydrated ${rows.length} queue entries from DB`,
        );
      }
    } catch (err) {
      console.error('[activity-queue] hydration failed:', err);
    }
  }

  /** Boot the recurring sweeper. Safe to call multiple times. */
  startMatchmaker(): void {
    if (this.sweepHandle) return;
    this.sweepHandle = setInterval(() => {
      void this.runMatchmakerSweep();
    }, MATCH_SWEEP_INTERVAL_MS);
  }

  stopMatchmaker(): void {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
  }

  /** Test hook — wipe all in-memory state. */
  __resetForTest(): void {
    this.queues.clear();
    this.petToEntry.clear();
    this.parties.clear();
    this.partyShortCodeIndex.clear();
    this.hydrated = false;
  }

  // ─── Internal: matcher core ────────────────────────────────────────────

  private async matchActivity(activityId: string, queue: QueueEntry[]): Promise<void> {
    if (queue.length === 0) return;

    const def = getActivityDefinition(activityId);
    if (!def) return; // unknown activity (e.g. coming-soon stub queued via dev tool)
    if (def.status !== 'live') return; // never match stubs

    const minFill = def.queueMinPlayers ?? def.minPlayers;
    // preferredFill defaults to 6 for 4–8 activities (backend §2.3) but caps
    // at maxPlayers so 1-1 / 2-2 activities don't ask for an impossible fill.
    const preferredFill = Math.min(
      def.maxPlayers,
      Math.max(minFill, def.maxPlayers >= 6 ? 6 : def.minPlayers),
    );
    const maxFill = def.maxPlayers;

    // First-pass: pull entries in FIFO order, group by partyId so parties
    // fit atomically. Solo entries each form a unit of size 1.
    const units = this.groupIntoFillUnits(queue);

    // Score each entry's eligibility for forced start (oldest first)
    const oldest = queue[0];
    const oldestAge = Date.now() - oldest.queuedAt;

    // Determine fill target. preferredFill if reachable; minFill at QUEUE_TIMEOUT;
    // bot backfill warning at EXTENDED_TIMEOUT.
    let targetFill = preferredFill;
    let allowBots = false;
    if (oldestAge > EXTENDED_TIMEOUT_MS) {
      targetFill = minFill;
      allowBots = true;
    } else if (oldestAge > QUEUE_TIMEOUT_MS) {
      targetFill = minFill;
    }

    // Try to assemble a room. Fill greedily — take units in FIFO order
    // up to `maxFill`. Atomic: parties either fit entirely or are skipped.
    // We pull as many eligible players as possible so a burst of 8 humans
    // becomes one 8-player match instead of a 6-player + 2 stuck-in-queue.
    const selected: QueueEntry[] = [];
    let count = 0;
    for (const unit of units) {
      if (count >= maxFill) break;
      if (count + unit.length > maxFill) continue; // party too big for remainder
      for (const e of unit) {
        selected.push(e);
        count++;
      }
    }

    // Before the timeout, hold out for preferredFill — otherwise a 4-
    // player room snaps while the 5th and 6th are still mid-click. After
    // the timeout, any count ≥ minFill graduates.
    const beforeTimeout = oldestAge <= QUEUE_TIMEOUT_MS;
    if (beforeTimeout && count < preferredFill) {
      return;
    }

    if (count < minFill) {
      if (allowBots && selected.length > 0) {
        // TODO chunk #10: spawn bot controllers via apps/api/src/services/activity/bots/
        // to top up `selected` to minFill with `subject_type='bot'` participants.
        // For chunk #2 we just emit a one-line warn + skip — humans keep waiting.
        const now = Date.now();
        if (now - this.lastBotBackfillWarn > 30_000) {
          this.lastBotBackfillWarn = now;
          console.warn(
            `[activity-queue] bot backfill needed for ${activityId} (have ${count}/${minFill}); spawn deferred to chunk #10`,
          );
        }
      }
      return;
    }

    // We have enough — allocate the room.
    try {
      const participants = selected.map((e) => ({
        petId: e.petId,
        userId: e.userId,
        agentId: e.agentId,
        subjectType: e.subjectType as 'human' | 'agent',
        partyId: e.partyId,
      }));
      const room = await activityRoomManager.createRoom(
        activityId,
        participants,
        {
          minPlayers: def.minPlayers,
          maxPlayers: def.maxPlayers,
          preferredPlayers: def.queueMinPlayers ?? def.minPlayers,
        },
      );

      // Mark each selected entry as matched + write the room linkage to DB.
      for (const e of selected) {
        e.matched = true;
        await db
          .update(activityQueueEntries)
          .set({ leftAt: new Date(), matchedRoomId: room.id })
          .where(eq(activityQueueEntries.id, e.id));
        this.removeFromMemory(e.petId, e.id);
        void logEvent({
          eventType: 'activity.queue.left',
          userId: e.userId,
          agentId: e.agentId,
          petId: e.petId,
          payload: {
            activityId,
            reason: 'matched',
            roomId: room.id,
          },
        });
      }
    } catch (err) {
      if (err instanceof RoomCapacityError) {
        // Capacity hit between cap-check above and createRoom call —
        // back off, leave entries in queue, retry next sweep.
        console.warn('[activity-queue] capacity raced, backing off:', err.kind);
        return;
      }
      throw err;
    }
  }

  /**
   * Group a FIFO-ordered queue into "fill units" so parties stay atomic.
   * Returns units in the same order their first member appeared in the
   * queue (preserves FIFO across mixed solo + party traffic).
   */
  private groupIntoFillUnits(queue: QueueEntry[]): QueueEntry[][] {
    const seenParties = new Set<string>();
    const units: QueueEntry[][] = [];
    for (const e of queue) {
      if (e.partyId == null) {
        units.push([e]);
        continue;
      }
      if (seenParties.has(e.partyId)) continue;
      seenParties.add(e.partyId);
      const partyMembers = queue.filter((q) => q.partyId === e.partyId);
      units.push(partyMembers);
    }
    return units;
  }

  // ─── Memory bookkeeping ────────────────────────────────────────────────

  private addToMemory(entry: QueueEntry): void {
    let queue = this.queues.get(entry.activityId);
    if (!queue) {
      queue = [];
      this.queues.set(entry.activityId, queue);
    }
    queue.push(entry);
    this.petToEntry.set(entry.petId, entry.id);
  }

  private removeFromMemory(petId: string, entryId: string): void {
    const knownEntryId = this.petToEntry.get(petId);
    if (knownEntryId === entryId) this.petToEntry.delete(petId);
    for (const [activityId, queue] of this.queues.entries()) {
      const idx = queue.findIndex((e) => e.id === entryId);
      if (idx >= 0) {
        queue.splice(idx, 1);
        if (queue.length === 0) this.queues.delete(activityId);
        return;
      }
    }
  }

  private findEntryInMemory(entryId: string): QueueEntry | undefined {
    for (const queue of this.queues.values()) {
      const found = queue.find((e) => e.id === entryId);
      if (found) return found;
    }
    return undefined;
  }

  private async disbandParty(party: Party): Promise<void> {
    party.disbandedAt = Date.now();
    this.parties.delete(party.id);
    this.partyShortCodeIndex.delete(party.shortCode);
    await db
      .update(activityParties)
      .set({ disbandedAt: new Date() })
      .where(eq(activityParties.id, party.id));
  }

  private generatePartyShortCode(): string {
    for (let attempt = 0; attempt < PARTY_SHORT_CODE_RETRY; attempt++) {
      const bytes = new Uint8Array(PARTY_SHORT_CODE_LENGTH);
      crypto.getRandomValues(bytes);
      let code = '';
      for (let i = 0; i < PARTY_SHORT_CODE_LENGTH; i++) {
        code += CROCKFORD_BASE32[bytes[i] % CROCKFORD_BASE32.length];
      }
      if (!this.partyShortCodeIndex.has(code)) return code;
    }
    throw new Error('Party short-code generation exhausted retries');
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────

export const activityQueueService = new ActivityQueueService();
