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
import { botPool } from './bots/bot-pool';

// ─── Constants (backend §2.3) ──────────────────────────────────────────────
//
// Demo-mode tuning (2026-04-24): we are publicly demoing with low concurrent
// traffic. Solo humans queue + nobody else shows up. The original 20s/45s
// timeouts were sized for a busy production lobby where waiting longer
// improves match quality (more humans, fewer bot fillers); in demo mode they
// just turn the queue into a 45-second loading screen and people leave.
//
// New values: ~3s grace for any other humans, ~6s before bot backfill kicks
// in. With the matchmaker sweep at 1s, a solo player sees their match start
// inside 7 seconds — fast enough to feel responsive, slow enough that a
// near-simultaneous second human still gets joined to the same room.
//
// Revisit when concurrent-queue counts climb. The original 20s/45s comment
// block lives in git for reference (commit before this one).

/** Drop to minFill if preferredFill not reached by this point */
const QUEUE_TIMEOUT_MS = 3_000;

/** Activate bot backfill if minFill not met by this point */
const EXTENDED_TIMEOUT_MS = 6_000;

/** Hard kill / suggest-other-activity timeout */
const QUEUE_HARD_TIMEOUT_MS = 30_000;

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

type EnqueueInput = {
    activityId: string;
    avatarId: string;
    userId: string | null;
    agentId: string | null;
    subjectType: 'human' | 'agent';
    partyId: string | null;
    wsConnectionId?: string | null;
    allowBotBackfill?: boolean;
    agentOnly?: boolean;
};
type PendingQueueLeave = { id: string; entry: QueueEntry | null; batch?: PendingQueueLeave[] };
type AdmissionToken = { cancelled: boolean; entryId?: string; settled: Promise<void>; finish: () => void };

class ActivityQueueService {
  /**
   * SINGLE-POD: per-activity queue, FIFO by `queuedAt`.
   *
   * Each activity has TWO logical queues — standard (mixed humans +
   * agents) and agent-only — keyed as `${activityId}` and
   * `${activityId}::agent-only`. Chunk #3 added the agent-only variant
   * via the `?matchType=agent-only` queue param; each entry's
   * `agentOnly: boolean` determines which bucket it lands in.
   */
  private queues = new Map<string, QueueEntry[]>();

  /** SINGLE-POD: avatarId → entryId for O(1) leave-queue lookups. */
  private avatarToEntry = new Map<string, string>();
  private pendingQueueLeaves = new Map<string, PendingQueueLeave>();
  private pendingPartyLeaves = new Set<string>();
  private partyDepartureVersions = new Map<string, number>();
  private inFlightEnqueues = new Map<string, AdmissionToken>();

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
   * Enqueue an avatar for an activity. Atomic — caller verifies caps + auth
   * before reaching here. Throws on cap-hit or duplicate-queue.
   */
  async enqueue(input: EnqueueInput): Promise<QueueEntry> {
    return (await this.enqueueBatch([input]))[0]!;
  }

  async enqueueParty(inputs: EnqueueInput[]): Promise<QueueEntry[]> {
    const partyId = inputs[0]?.partyId;
    const party = partyId ? this.parties.get(partyId) : null;
    if (!party || inputs.length !== party.members.size || inputs.some(input => input.partyId !== partyId || !party.members.has(input.avatarId))) {
      throw new Error('Party membership changed before queue admission');
    }
    return this.enqueueBatch(inputs, party);
  }

  private async enqueueBatch(inputs: EnqueueInput[], expectedParty?: Party): Promise<QueueEntry[]> {
    const reservations: Array<{ input: EnqueueInput; token: AdmissionToken; valid: () => boolean }> = [];
    const inserted: QueueEntry[] = [];
    try {
      // Reserve every avatar before the first await. No partial party is matchable.
      for (const input of inputs) {
        if (this.inFlightEnqueues.has(input.avatarId)) throw new Error('Queue admission already in progress');
        const party = input.partyId ? this.parties.get(input.partyId) : null;
        const key = `${input.partyId}:${input.avatarId}`;
        const version = this.partyDepartureVersions.get(key) ?? 0;
        const valid = () => !input.partyId || (
          !!party && this.parties.get(input.partyId) === party && party.disbandedAt === null &&
          party.members.has(input.avatarId) && !this.pendingPartyLeaves.has(key) &&
          (this.partyDepartureVersions.get(key) ?? 0) === version
        );
        if (!valid()) throw new Error('Party membership changed before queue admission');
        let finish!: () => void;
        const settled = new Promise<void>(resolve => { finish = resolve; });
        const token: AdmissionToken = { cancelled: false, settled, finish };
        this.inFlightEnqueues.set(input.avatarId, token);
        reservations.push({ input, token, valid });
      }
      for (const { input, token, valid } of reservations) {
        const pending = this.pendingQueueLeaves.get(input.avatarId);
        if (pending) await this.persistQueueLeave(input.avatarId, pending, 'voluntary');
        if (token.cancelled) throw new Error('Queue admission cancelled');
        if (!valid()) throw new Error('Party membership changed before queue admission');
        this.assertQueueAdmission(input);
      }
      const assertBatchValid = () => {
        if (expectedParty && expectedParty.members.size !== inputs.length) throw new Error('Party membership changed during queue admission');
        for (const { token, valid } of reservations) {
          if (token.cancelled) throw new Error('Queue admission cancelled');
          if (!valid()) throw new Error('Party membership changed during queue admission');
        }
      };
      const insertBatch = async (writer: Pick<typeof db, 'insert'>) => {
        for (const { input, token } of reservations) {
          assertBatchValid();
          const entry: QueueEntry = {
            id: uuidv4(), activityId: input.activityId, avatarId: input.avatarId,
            userId: input.userId, agentId: input.agentId, subjectType: input.subjectType,
            partyId: input.partyId, queuedAt: Date.now(), wsConnectionId: input.wsConnectionId ?? null,
            matched: false, allowBotBackfill: input.allowBotBackfill ?? true, agentOnly: input.agentOnly ?? false,
          };
          // Exact IDs survive an ambiguous insert or transaction commit response.
          token.entryId = entry.id;
          inserted.push(entry);
          await writer.insert(activityQueueEntries).values({
            id: entry.id, activityId: entry.activityId, avatarId: entry.avatarId,
            agentId: entry.agentId, subjectType: entry.subjectType, partyId: entry.partyId,
            queuedAt: new Date(entry.queuedAt),
          });
        }
        assertBatchValid();
      };
      if (inputs[0]?.partyId) await db.transaction(async tx => insertBatch(tx));
      else await insertBatch(db);
      // Cancellation can arrive while COMMIT waits. Never publish it afterward.
      assertBatchValid();
      // Synchronous publication: the matcher never sees only part of this batch.
      for (const entry of inserted) this.addToMemory(entry);
      for (const entry of inserted) void logEvent({
        eventType: 'activity.queue.joined', userId: entry.userId, agentId: entry.agentId,
        avatarId: entry.avatarId,
        payload: { activityId: entry.activityId, partyId: entry.partyId, subjectType: entry.subjectType, agentOnly: entry.agentOnly },
      });
      return inserted;
    } catch (error) {
      const departures: PendingQueueLeave[] = inserted.map(entry => ({ id: entry.id, entry }));
      for (const departure of departures) {
        if (inputs[0]?.partyId) departure.batch = departures;
        this.pendingQueueLeaves.set(departure.entry!.avatarId, departure);
      }
      if (departures.length) await this.persistQueueLeave(departures[0]!.entry!.avatarId, departures[0]!, 'voluntary');
      throw error;
    } finally {
      for (const { input, token } of reservations) {
        if (this.inFlightEnqueues.get(input.avatarId) === token) this.inFlightEnqueues.delete(input.avatarId);
        token.finish();
        this.pruneDepartureVersion(input.partyId, input.avatarId);
      }
    }
  }

  private assertQueueAdmission(input: EnqueueInput): void {
    if (this.avatarToEntry.has(input.avatarId)) {
      throw new Error('Avatar is already in a queue');
    }

    // TODO chunk #10: enforce per-user concurrent-match cap of 3.
    // The room manager already exposes getPlayerActiveRoom() — once
    // multi-avatar support lands (or auxiliary agent avatars), enumerate the
    // user's avatars here and refuse if 3+ are active.
    const activeRoom = activityRoomManager.getPlayerActiveRoom(input.avatarId);
    if (activeRoom) {
      throw new Error(
        `Avatar is already in an active room (${activeRoom.id}); leave or finish before re-queueing`,
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

  }

  /**
   * Leave the queue. Idempotent — no-op + 200 if avatar wasn't queued.
   * `reason` distinguishes voluntary leave from matcher fulfilment for
   * the event payload.
   */
  async leaveQueue(
    avatarId: string,
    reason: 'voluntary' | 'matched' | 'timeout' | 'pod_restart' = 'voluntary',
  ): Promise<boolean> {
    const admission = this.inFlightEnqueues.get(avatarId);
    if (admission) {
      const previousPendingId = this.pendingQueueLeaves.get(avatarId)?.id;
      admission.cancelled = true;
      await admission.settled;
      const pending = this.pendingQueueLeaves.get(avatarId);
      if (pending && (pending.id === admission.entryId || pending.id === previousPendingId)) {
        await this.persistQueueLeave(avatarId, pending, reason);
      }
      // Never inspect a newer admission after this token's await.
      return true;
    }
    const pending = this.pendingQueueLeaves.get(avatarId);
    const entryId = pending?.id ?? this.avatarToEntry.get(avatarId);
    if (!entryId) return !!admission;
    const entry = pending?.entry ?? this.findEntryInMemory(entryId) ?? null;
    const departure = pending ?? { id: entryId, entry };
    this.pendingQueueLeaves.set(avatarId, departure);
    return this.persistQueueLeave(avatarId, departure, reason);
  }

  private async persistQueueLeave(
    avatarId: string,
    departure: PendingQueueLeave,
    reason: 'voluntary' | 'matched' | 'timeout' | 'pod_restart',
  ): Promise<boolean> {
    const { id: entryId, entry } = departure;
    if (departure.batch) {
      const batch = departure.batch;
      // All IDs were staged by one failed admission and were never published.
      await db.transaction(async tx => {
        for (const member of batch) await tx.update(activityQueueEntries).set({ leftAt: new Date() })
          .where(and(eq(activityQueueEntries.id, member.id), eq(activityQueueEntries.avatarId, member.entry!.avatarId), isNull(activityQueueEntries.leftAt)));
      });
      for (const member of batch) {
        if (this.pendingQueueLeaves.get(member.entry!.avatarId) === member) this.pendingQueueLeaves.delete(member.entry!.avatarId);
      }
    } else {
      this.removeFromMemory(avatarId, entryId);
      await db.update(activityQueueEntries).set({ leftAt: new Date() })
        .where(and(eq(activityQueueEntries.id, entryId), eq(activityQueueEntries.avatarId, avatarId), isNull(activityQueueEntries.leftAt)));
      if (this.pendingQueueLeaves.get(avatarId) === departure) this.pendingQueueLeaves.delete(avatarId);
    }
    if (entry) {
      void logEvent({
        eventType: 'activity.queue.left',
        userId: entry.userId,
        agentId: entry.agentId,
        avatarId: entry.avatarId,
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
   * Position is 1-indexed; null if the avatar isn't queued.
   *
   * Searches BOTH the standard + agent-only queues so a caller doesn't
   * need to know which bucket their entry landed in — the server is the
   * source of truth.
   */
  getQueueStatus(activityId: string, avatarId: string): QueueStatus {
    const standard = this.queues.get(this.queueKey(activityId, false)) ?? [];
    const agentOnly = this.queues.get(this.queueKey(activityId, true)) ?? [];
    let position: number | null = null;
    let playersInQueue = standard.length + agentOnly.length;
    const sIdx = standard.findIndex((e) => e.avatarId === avatarId);
    if (sIdx >= 0) position = sIdx + 1;
    else {
      const aIdx = agentOnly.findIndex((e) => e.avatarId === avatarId);
      if (aIdx >= 0) position = aIdx + 1;
    }
    void playersInQueue;

    const estimatedWaitSec = position == null ? 0 : Math.max(5, position * 30);
    return {
      position,
      estimatedWaitSec,
      roomsActive: activityRoomManager.listActiveRooms(activityId).length,
      playersInQueue: standard.length + agentOnly.length,
      serverAtCapacity:
        activityRoomManager.totalActiveRooms() >= MAX_ROOMS_TOTAL,
    };
  }

  /**
   * Idempotency helper for REST queue joins. A retry/double-click should not
   * strand the lobby with "Avatar is already in a queue" when the existing entry
   * is exactly the same activity bucket.
   */
  getQueuedEntry(avatarId: string): QueueEntry | null {
    for (const queue of this.queues.values()) {
      const entry = queue.find((e) => e.avatarId === avatarId);
      if (entry) return entry;
    }
    return null;
  }

  /**
   * Look up the room a freshly-matched avatar was routed into — used by
   * the queue-status polling path so a client can pick up `matchedRoomId`
   * without a separate WS control channel. (Chunk #3 match.found
   * delivery choice (b) per plan — polling for now.)
   */
  getMatchedRoomId(avatarId: string): string | null {
    const roomId = this.matchedRooms.get(avatarId);
    if (!roomId) return null;
    // Auto-expire entries so an avatar can re-queue later without carrying
    // a stale matchedRoomId forward. The room must still be the avatar's
    // ACTIVE room: a room in results/gc/aborted, or one the avatar already
    // left, still exists in the manager for a while, and routing a fresh
    // queue into it showed "MATCH EXPIRED" (2026-09-18, staging repro).
    // Read-only checks: this runs on every status poll and must never mutate
    // the room manager's bindings.
    //   • Room gone, or the avatar left / was rebound → the match is over for
    //     good: forget it.
    //   • Room not playing (results / gc / aborted, or a transition whose DB
    //     write may still roll back) → answer null but KEEP the entry, so a
    //     rolled-back transition is found again on the next poll (Codex r2).
    if (
      !activityRoomManager.getRoom(roomId) ||
      !activityRoomManager.isAvatarBoundToRoom(avatarId, roomId)
    ) {
      this.matchedRooms.delete(avatarId);
      return null;
    }
    if (!activityRoomManager.isAvatarInLiveRoom(avatarId, roomId)) return null;
    return roomId;
  }

  /**
   * Map of avatarId → roomId, populated by the matcher so a client polling
   * `/queue-status` can pick up their room assignment without a pre-match
   * WS. An entry is dropped when the avatar's poll finds the match over
   * (`getMatchedRoomId`), when the avatar queues again (`addToMemory`), or
   * by the matchmaker sweep once the room has left the manager
   * (`pruneMatchedRooms`) — so an avatar that never polls again cannot pin
   * an entry forever. (The old comment promised a 5-minute lifetime that no
   * timer enforced; Codex, 2026-09-18.)
   */
  private matchedRooms = new Map<string, string>();

  /** Drop matches whose room the manager has already evicted (GC). */
  pruneMatchedRooms(): void {
    for (const [avatarId, roomId] of this.matchedRooms) {
      if (!activityRoomManager.getRoom(roomId)) this.matchedRooms.delete(avatarId);
    }
  }

  /**
   * Length only — for the public `/api/activities` summary cards.
   *
   * Aggregates BOTH the standard and agent-only queues unless an
   * explicit `agentOnly` filter is passed. Public surface shows the
   * combined total by default.
   */
  queueLength(activityId: string, agentOnly: boolean | null = null): number {
    if (agentOnly === true) {
      return (this.queues.get(this.queueKey(activityId, true)) ?? []).length;
    }
    if (agentOnly === false) {
      return (this.queues.get(this.queueKey(activityId, false)) ?? []).length;
    }
    return (
      (this.queues.get(this.queueKey(activityId, false)) ?? []).length +
      (this.queues.get(this.queueKey(activityId, true)) ?? []).length
    );
  }

  private queueKey(activityId: string, agentOnly: boolean): string {
    return agentOnly ? `${activityId}::agent-only` : activityId;
  }

  // ─── Party API ─────────────────────────────────────────────────────────

  async createParty(leaderAvatarId: string): Promise<Party> {
    if (this.partyForAvatar(leaderAvatarId)) {
      throw new Error('Avatar is already in a party');
    }
    const id = uuidv4();
    const shortCode = this.generatePartyShortCode();
    const now = Date.now();

    await db.insert(activityParties).values({
      id,
      shortCode,
      leaderAvatarId,
      createdAt: new Date(now),
    });
    await db.insert(activityPartyMembers).values({
      partyId: id,
      avatarId: leaderAvatarId,
      joinedAt: new Date(now),
    });

    const party: Party = {
      id,
      shortCode,
      leaderAvatarId,
      members: new Set([leaderAvatarId]),
      createdAt: now,
      disbandedAt: null,
    };
    this.parties.set(id, party);
    this.partyShortCodeIndex.set(shortCode, id);
    return party;
  }

  async joinParty(shortCode: string, avatarId: string): Promise<Party> {
    const partyId = this.partyShortCodeIndex.get(shortCode.toUpperCase());
    if (!partyId) throw new Error('Party not found');
    const party = this.parties.get(partyId);
    if (!party || party.disbandedAt !== null) throw new Error('Party not found');
    if (party.members.size >= MAX_PARTY_SIZE) {
      throw new Error(`Party is full (cap ${MAX_PARTY_SIZE})`);
    }
    if (this.pendingPartyLeaves.has(`${party.id}:${avatarId}`)) throw new Error('Party departure is still saving; retry leave');
    if (party.members.has(avatarId)) return party;
    if (this.partyForAvatar(avatarId)) {
      throw new Error('Avatar is already in another party');
    }

    const joinedAt = new Date();
    await db
      .insert(activityPartyMembers)
      .values({
        partyId: party.id,
        avatarId,
        joinedAt,
      })
      .onConflictDoUpdate({
        target: [activityPartyMembers.partyId, activityPartyMembers.avatarId],
        set: { joinedAt, leftAt: null },
      });
    // Commit memory only after persistence succeeds. A failed DB reactivation
    // must not leave a phantom member in the matchmaker's authoritative roster.
    party.members.add(avatarId);
    return party;
  }

  async kickMember(partyId: string, requesterAvatarId: string, targetAvatarId: string): Promise<Party> {
    const party = this.parties.get(partyId);
    if (!party) throw new Error('Party not found');
    if (party.leaderAvatarId !== requesterAvatarId) {
      throw new Error('Only the party leader can kick members');
    }
    if (targetAvatarId === party.leaderAvatarId) {
      throw new Error('Leader cannot be kicked — leave instead');
    }
    if (!party.members.has(targetAvatarId)) {
      throw new Error('Member is not in this party');
    }

    // Rejoin must not revive an admission captured before this kick.
    const departureKey = `${partyId}:${targetAvatarId}`;
    this.partyDepartureVersions.set(departureKey, (this.partyDepartureVersions.get(departureKey) ?? 0) + 1);
    party.members.delete(targetAvatarId);
    // Keep the version until any old admission finishes; kick never waits on it.
    this.pruneDepartureVersion(partyId, targetAvatarId);
    await db
      .update(activityPartyMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(activityPartyMembers.partyId, partyId),
          eq(activityPartyMembers.avatarId, targetAvatarId),
          isNull(activityPartyMembers.leftAt),
        ),
      );

    if (party.members.size === 0) {
      await this.disbandParty(party);
    }
    return party;
  }

  async leaveParty(partyId: string, avatarId: string): Promise<void> {
    const party = this.parties.get(partyId);
    if (!party) return; // idempotent
    if (!party.members.has(avatarId)) return;

    const departureKey = `${partyId}:${avatarId}`;
    if (!this.pendingPartyLeaves.has(departureKey)) {
      this.partyDepartureVersions.set(departureKey, (this.partyDepartureVersions.get(departureKey) ?? 0) + 1);
    }
    this.pendingPartyLeaves.add(departureKey);
    // Keep membership visible for retries until both persistence writes succeed.
    // leaveQueue removes the entry synchronously before its persistence await.
    // Matched rooms remain owned by the room manager and are never erased here.
    await this.leaveQueue(avatarId, 'voluntary');
    await db
      .update(activityPartyMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(activityPartyMembers.partyId, partyId),
          eq(activityPartyMembers.avatarId, avatarId),
          isNull(activityPartyMembers.leftAt),
        ),
      );

    party.members.delete(avatarId);
    this.pendingPartyLeaves.delete(departureKey);
    this.pruneDepartureVersion(partyId, avatarId);
    if (party.leaderAvatarId === avatarId) {
      // Promote the next member to leader (insertion order — oldest member).
      const next = party.members.values().next().value;
      if (next) {
        party.leaderAvatarId = next;
        await db
          .update(activityParties)
          .set({ leaderAvatarId: next })
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

  partyForAvatar(avatarId: string): Party | undefined {
    for (const p of this.parties.values()) {
      if (p.disbandedAt === null && p.members.has(avatarId)) return p;
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
    this.pruneMatchedRooms();
    for (const [queueKey, queue] of this.queues.entries()) {
      try {
        // Decode the queue key — `${activityId}::agent-only` or bare
        // `${activityId}`. matchActivity accepts the activityId + flag
        // separately so it can look up ACTIVITY_REGISTRY without parsing.
        const [activityId, suffix] = queueKey.split('::');
        const agentOnly = suffix === 'agent-only';
        await this.matchActivity(activityId, queue, agentOnly);
      } catch (err) {
        console.error(
          `[activity-queue] sweep failed for ${queueKey}:`,
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
          avatarId: row.avatarId,
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
    this.avatarToEntry.clear();
    this.pendingQueueLeaves.clear();
    this.pendingPartyLeaves.clear();
    this.partyDepartureVersions.clear();
    this.inFlightEnqueues.clear();
    this.parties.clear();
    this.partyShortCodeIndex.clear();
    this.matchedRooms.clear();
    this.hydrated = false;
  }

  // ─── Internal: matcher core ────────────────────────────────────────────

  private async matchActivity(activityId: string, queue: QueueEntry[], agentOnly: boolean): Promise<void> {
    if (queue.length === 0) return;

    const def = getActivityDefinition(activityId);
    if (!def) return; // unknown activity (e.g. coming-soon stub queued via dev tool)
    if (def.status !== 'live') return; // never match stubs

    // Agent-only bucket: defensive filter — reject any entry whose
    // subjectType somehow landed in the wrong bucket. Chunk #3 enqueue
    // routes the entry by `agentOnly`, but an agent-only queue should
    // never contain a human — so skip the whole sweep if any
    // contradictions exist rather than match a mixed group.
    if (agentOnly) {
      for (const e of queue) {
        if (e.subjectType !== 'agent') return;
      }
    }

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
    // bot backfill at EXTENDED_TIMEOUT unless the activity opts into earlyBotFill.
    let targetFill = preferredFill;
    let allowBots = false;
    if (
      oldestAge > EXTENDED_TIMEOUT_MS ||
      (def.earlyBotFill && oldestAge > QUEUE_TIMEOUT_MS)
    ) {
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

    // Compute bot backfill if needed. Bots are reserved per-room from
    // the seeded pool (`scripts/seed-bot-avatars.ts`). Reservation is
    // released when the room manager evicts the room (see `releaseRoom`
    // wiring in `apps/api/src/index.ts`).
    //
    // Eligibility: the queue must contain at least one human/agent AND
    // every entry must individually allow bot backfill. A single
    // `allowBotBackfill=false` entry blocks the whole match — that's
    // the conservative read of "PvP-ranked slots" per backend §8.4.
    let botAvatarIds: string[] = [];
    if (count < minFill) {
      const allConsentToBots = selected.every((e) => e.allowBotBackfill);
      if (allowBots && selected.length > 0 && allConsentToBots) {
        const need = minFill - count;
        botAvatarIds = botPool.reserve('pending-room', need);
        if (botAvatarIds.length < need) {
          // Pool exhausted — wait for next sweep (a room finishing will
          // free slots). Rate-limit the warning.
          const now = Date.now();
          if (now - this.lastBotBackfillWarn > 30_000) {
            this.lastBotBackfillWarn = now;
            console.warn(
              `[activity-queue] bot pool exhausted for ${activityId} (need ${need}, capacity ${botPool.capacity()}, in-use ${botPool.inUseCount()})`,
            );
          }
          // Release whatever we did grab — partial reserves leak slots.
          if (botAvatarIds.length > 0) botPool.releaseRoom('pending-room');
          botAvatarIds = [];
          return;
        }
      } else {
        if (allowBots && selected.length > 0 && !allConsentToBots) {
          console.warn(
            `[activity-queue] bot backfill blocked for ${activityId}: at least one entry has allowBotBackfill=false`,
          );
        }
        return;
      }
    }

    // We have enough — allocate the room.
    try {
      const participants: Array<{
        avatarId: string;
        userId: string | null;
        agentId: string | null;
        subjectType: 'human' | 'agent' | 'bot';
        partyId: string | null;
      }> = selected.map((e) => ({
        avatarId: e.avatarId,
        userId: e.userId,
        agentId: e.agentId,
        subjectType: e.subjectType as 'human' | 'agent',
        partyId: e.partyId,
      }));
      for (const botAvatarId of botAvatarIds) {
        participants.push({
          avatarId: botAvatarId,
          userId: null,
          agentId: null,
          subjectType: 'bot',
          partyId: null,
        });
      }
      const room = await activityRoomManager.createRoom(
        activityId,
        participants,
        {
          minPlayers: def.minPlayers,
          maxPlayers: def.maxPlayers,
          preferredPlayers: def.queueMinPlayers ?? def.minPlayers,
        },
      );

      // Re-bind bot reservations from the placeholder room id to the
      // actual roomId so `releaseRoom(actualId)` cleans them up later.
      if (botAvatarIds.length > 0) {
        try {
          botPool.rebindReservation(botAvatarIds, 'pending-room', room.id);
        } catch (err) {
          console.error('[activity-queue] bot reservation rebind failed:', err);
        }
      }

      // Mark each selected entry as matched + write the room linkage to DB.
      for (const e of selected) {
        e.matched = true;
        await db
          .update(activityQueueEntries)
          .set({ leftAt: new Date(), matchedRoomId: room.id })
          .where(eq(activityQueueEntries.id, e.id));
        this.removeFromMemory(e.avatarId, e.id);
        // Populate the avatarId → roomId map used by queue-status polling
        // so clients can pick up `matchedRoomId` without a WS. Chunk #3
        // match.found delivery option (b) per plan.
        this.matchedRooms.set(e.avatarId, room.id);
        void logEvent({
          eventType: 'activity.queue.left',
          userId: e.userId,
          agentId: e.agentId,
          avatarId: e.avatarId,
          payload: {
            activityId,
            reason: 'matched',
            roomId: room.id,
          },
        });
      }
    } catch (err) {
      // Release any pending bot reservations so the next sweep can
      // re-grab them — leaks here would silently shrink the pool.
      if (botAvatarIds.length > 0) botPool.releaseRoom('pending-room');
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
    const key = this.queueKey(entry.activityId, entry.agentOnly);
    let queue = this.queues.get(key);
    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }
    queue.push(entry);
    this.avatarToEntry.set(entry.avatarId, entry.id);
    // A new queue entry means any earlier match is over; never hand the
    // queue-status poll the previous room (2026-09-18: a second Reef Race
    // queue routed straight into the last, finished room → "MATCH EXPIRED").
    this.matchedRooms.delete(entry.avatarId);
  }

  private removeFromMemory(avatarId: string, entryId: string): void {
    const knownEntryId = this.avatarToEntry.get(avatarId);
    if (knownEntryId === entryId) this.avatarToEntry.delete(avatarId);
    for (const [key, queue] of this.queues.entries()) {
      const idx = queue.findIndex((e) => e.id === entryId);
      if (idx >= 0) {
        queue.splice(idx, 1);
        if (queue.length === 0) this.queues.delete(key);
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

  private pruneDepartureVersion(partyId: string | null, avatarId: string): void {
    if (!partyId || this.inFlightEnqueues.has(avatarId) || this.pendingPartyLeaves.has(`${partyId}:${avatarId}`)) return;
    this.partyDepartureVersions.delete(`${partyId}:${avatarId}`);
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
