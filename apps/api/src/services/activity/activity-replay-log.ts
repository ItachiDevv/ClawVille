/**
 * Q2 Activity Portals — input replay log service (chunk #3).
 *
 * Per backend §4.8: every LIVE match writes input frames to an in-memory
 * ring buffer. On LIVE→RESULTS the buffer is flushed to the
 * `activity_replays.frames` JSONB column; the buffer is then dropped.
 *
 * Sizing target (worst case, 8 player Bumper Shells, 60Hz inputs, 60s):
 *   8 × 60 × 60 = 28 800 frames per match. Per-frame payload kept tight
 *   (numbers + a tiny `input` object) so each frame ≈ 60 bytes JSON ⇒
 *   ~1.7 MB per finished match in jsonb. Well under the row size limit.
 *
 * The buffer is intentionally bounded by `MAX_FRAMES_PER_ROOM`. If the
 * sim somehow keeps appending past 90s × 60Hz × 8p (~43 200 frames), the
 * oldest frames get evicted — guarantees we never balloon RAM, at worst
 * the replay loses its head. Flagged via console.warn so we notice.
 *
 * `flushToDb` is the single DB write point — invoked by the room manager
 * at LIVE→RESULTS via the `replayFlushFn` callback (registered at API
 * boot to avoid a cycle, same pattern as the WS hub).
 *
 * 14-day retention pruning lives in a separate cron — `// TODO chunk #12
 * prune-activity-replays.ts script`.
 */

import {
  db,
  activityReplays,
  type ActivityReplayParticipantsJson,
} from '@clawville/database';

/**
 * Hard ceiling per room. 8 players × 60Hz × 90s = 43 200; we round up
 * to 60 000 to leave headroom for clock-skew spikes without truncating
 * legitimate traffic. Hitting the cap means something is wrong upstream
 * (sim ran past the plan-locked round timer) — still safe to clip.
 */
const MAX_FRAMES_PER_ROOM = 60_000;

/**
 * Per-frame on-disk shape. Compact intentionally — this is the dominant
 * jsonb payload size driver.
 *
 *   ts:  Sim tick offset in ms since match started (uint, ≤ 90 000)
 *   pid: avatarId (uuid string) — duplicated per frame for filter-by-avatar
 *        post-hoc analysis without re-walking the participants snapshot
 *   seq: Client monotonic input counter
 *   dt:  Client-reported delta seconds (server-clamped before recording)
 *   inp: The input intent (dir/thrust/actionBits) — only fields present
 */
export interface ReplayFrame {
  ts: number;
  pid: string;
  seq: number;
  dt: number;
  inp: {
    dir?: { x: number; y: number };
    thrust?: number;
    actionBits?: number;
  };
}

class ActivityReplayLog {
  /** Per-room append-only ring buffer. Cleared on flushToDb / dropRoom. */
  private buffers = new Map<string, ReplayFrame[]>();

  /**
   * Per-room replay row id, populated AFTER flushToDb succeeds. Chunk #7
   * (reward pipeline) reads this to write the FK on `activity_results`.
   * Cleared by `dropRoom` on RESULTS→GC eviction.
   */
  private replayIds = new Map<string, string>();

  /** Per-room "we already warned about hitting the cap" flag */
  private capWarned = new Set<string>();

  /**
   * Append a single validated input frame. Caller (the sim) is
   * responsible for clamping `dt` and bound-checking `inp` BEFORE this
   * point — the replay log records what actually happened, not raw
   * client claims.
   */
  appendInputFrame(
    roomId: string,
    avatarId: string,
    seq: number,
    dt: number,
    input: ReplayFrame['inp'],
    matchStartedAt: number,
  ): void {
    let buf = this.buffers.get(roomId);
    if (!buf) {
      buf = [];
      this.buffers.set(roomId, buf);
    }
    if (buf.length >= MAX_FRAMES_PER_ROOM) {
      if (!this.capWarned.has(roomId)) {
        this.capWarned.add(roomId);
        console.warn(
          `[activity-replay-log] room ${roomId} hit MAX_FRAMES_PER_ROOM cap; oldest frames will be dropped`,
        );
      }
      // Drop the oldest 5% of frames in one shot — cheaper than per-call
      // shift() and keeps the buffer length bounded around the cap.
      buf.splice(0, Math.floor(MAX_FRAMES_PER_ROOM * 0.05));
    }
    buf.push({
      ts: Math.max(0, Date.now() - matchStartedAt),
      pid: avatarId,
      seq,
      dt,
      inp: input,
    });
  }

  /**
   * Flush the per-room buffer to `activity_replays`. Returns the new row
   * id. Idempotent on a flushed room (returns the cached id without
   * re-inserting). On failure: error is logged, buffer is preserved so
   * a retry can succeed.
   *
   * `participants` carries the per-avatar display snapshot (color/species/
   * model) so the eventual replay viewer (chunk #5) can render without
   * re-reading the live `avatars` row, which may have changed.
   */
  async flushToDb(
    roomId: string,
    activityId: string,
    participantsSnapshot: ActivityReplayParticipantsJson,
  ): Promise<string | null> {
    const cached = this.replayIds.get(roomId);
    if (cached) return cached;

    const buf = this.buffers.get(roomId);
    if (!buf) {
      // Sim never produced any frames (instant abort or zero-input race).
      // Still write an empty replay row so chunk #7's FK doesn't break.
    }
    const frames = buf ?? [];

    try {
      const inserted = await db
        .insert(activityReplays)
        .values({
          roomId,
          activityId,
          frames,
          participants: participantsSnapshot,
        })
        .returning({ id: activityReplays.id });

      const id = inserted[0]?.id;
      if (id) {
        this.replayIds.set(roomId, id);
      }
      // Drop the in-memory buffer once we have a durable copy. Keep the
      // replayIds entry so chunk #7 can fetch it during settlement; the
      // room manager calls `dropRoom` on RESULTS→GC to clear that map.
      this.buffers.delete(roomId);
      this.capWarned.delete(roomId);
      return id ?? null;
    } catch (err) {
      console.error(
        `[activity-replay-log] flush failed for room ${roomId}:`,
        err,
      );
      // Preserve the buffer so a retry can succeed; the room manager
      // catches this rejection and decides whether to alert.
      throw err;
    }
  }

  /**
   * Get the replay id previously written for a room — chunk #7 calls
   * this during reward settlement to attach the FK on `activity_results`.
   * Returns undefined if `flushToDb` hasn't been called yet.
   */
  getReplayId(roomId: string): string | undefined {
    return this.replayIds.get(roomId);
  }

  /**
   * Called by the room manager on RESULTS→GC eviction. Drops both the
   * in-memory buffer (defensive — should already be empty) and the
   * cached replay id since chunk #7 has already consumed it by then.
   */
  dropRoom(roomId: string): void {
    this.buffers.delete(roomId);
    this.replayIds.delete(roomId);
    this.capWarned.delete(roomId);
  }

  /** Number of frames currently buffered for a room (test/diagnostics) */
  bufferLength(roomId: string): number {
    return this.buffers.get(roomId)?.length ?? 0;
  }

  /** Test hook — wipe all in-memory state. */
  __resetForTest(): void {
    this.buffers.clear();
    this.replayIds.clear();
    this.capWarned.clear();
  }
}

export const activityReplayLog = new ActivityReplayLog();
