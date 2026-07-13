import { z } from 'zod';
import type {
  PokerPublicTableSnapshot,
  PokerPrivateSeatView,
  PokerHandResultSeat,
  PokerHandResult,
  PokerCard,
  PokerActionKind,
  PokerStreet,
} from './poker-protocol';

/**
 * Q2 Activity Portals — WebSocket protocol shapes.
 *
 * Single source of truth for the Client ↔ Server frames used on the
 * `wss://api.clawville.world/api/activities/:id/rooms/:roomId/ws`
 * socket. Every frame is MessagePack-encoded over a binary WS in
 * production (`@msgpack/msgpack`), but the logical shape is JSON.
 *
 * **Validation contract:**
 *   - Server ingress validates inbound frames against the Zod schemas
 *     below. Invalid frames → `error` reply, socket stays open for
 *     soft faults; fatal faults close with 4xxx codes (see backend §3.2).
 *   - Server egress is TYPED but NOT re-validated (trusted producer).
 *   - Client consumers should trust egress types but defensively handle
 *     unknown `type` fields for forward compatibility.
 *
 * The TypeScript union types are derived FROM the Zod schemas via
 * `z.infer` so a schema change can't silently drift from the TS types.
 */

// ─── Shared scalar shapes ───────────────────────────────────────────────────

export const vec2Schema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Vec2 = z.infer<typeof vec2Schema>;

/**
 * Reef Race power-up kinds — string-literal union mirroring the server-side
 * `ReefPowerUpKind` in `apps/api/src/services/activity/sim/reef-race-config.ts`.
 * Lives in @clawville/shared so the protocol's `event.power_up_collected.kind`
 * (impl-audit M1) can narrow it to the legitimate set rather than `string`,
 * blocking any future server change from silently writing rogue kinds into
 * the client-side inventory.
 *
 * Phase 2 (impl-audit M1): `event.power_up_collected.kind` is now typed
 * `ReefPowerUpKind` (was `string`).
 *
 * If a new kind is added on the server, ADD IT HERE in the same diff or the
 * type will fail to compile — that's the intended fence.
 */
export type ReefPowerUpKind =
  | 'rr-turbo-bubble'
  | 'rr-ink-slick'
  | 'rr-bubble-shield'
  | 'rr-seeker-jelly'
  | 'rr-tide-wave'
  | 'rr-whirlpool';

// ─── Client → Server ────────────────────────────────────────────────────────

export const clientAuthFrameSchema = z.object({
  type: z.literal('auth'),
  sessionToken: z.string().min(1),
  shortCode: z.string().min(1),
});

export const clientInputFrameSchema = z.object({
  type: z.literal('input'),
  /** Monotonic client counter for input idempotency + replay ordering */
  seq: z.number().int().nonnegative(),
  /** Delta seconds since last input frame */
  dt: z.number().nonnegative(),
  dir: vec2Schema.optional(),
  thrust: z.number().optional(),
  /** Packed 16-bit bitfield of discrete actions (power-up use, brake, ...) */
  actionBits: z.number().int().nonnegative().optional(),
});

export const clientPingFrameSchema = z.object({
  type: z.literal('ping'),
  sentAt: z.number(),
});

export const clientChatFrameSchema = z.object({
  type: z.literal('chat'),
  text: z.string().min(1).max(140),
  /**
   * Chunk #11 (spectator mode) — when `true`, the server should route
   * this chat to spectator-only subscribers (eliminated players watching
   * the round). When omitted/false the chat targets the active-player
   * room channel (existing behavior). Server-side filtering is deferred
   * to a future chunk; the client tags every spectator-channel message
   * with `spectator: true` so the backend can split the channels later.
   */
  spectator: z.boolean().optional(),
});

export const clientEmoteFrameSchema = z.object({
  type: z.literal('emote'),
  emoteId: z.string().min(1).max(64),
  /**
   * Chunk #11 — spectator-originated emotes (cheers / taunts) tagged so
   * the server can later choose to broadcast them above the spectated
   * player's avatar instead of the spectator. 3D rendering of cheers is
   * deferred to chunk #12 polish.
   */
  spectator: z.boolean().optional(),
});

export const clientLeaveFrameSchema = z.object({
  type: z.literal('leave'),
});

// ─── Texas Hold'em (`poker.*`) client frames — ADDITIVE ─────────────────────
//
// Namespaced sub-union layered onto the activity-portal client protocol. These
// are validated by the SAME `clientFrameSchema.safeParse` ingress as every
// other client frame, then routed by the WS hub's `handlePokerAction` (NOT the
// motion `input` path). `handNumber` + `actionSeq` together form the
// server-side idempotency key (`<handNumber>:<actionSeq>:<avatarId>`), so a
// retransmitted action is a stable no-op.

/**
 * The betting-action payload — "bet/raise to X" TOTAL street-commitment
 * semantics (NOT an increment). `amount` is a non-negative integer chip count.
 * Discriminated by `kind`; `bet`/`raise` require `amount`, the rest omit it.
 */
export const pokerActionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fold') }),
  z.object({ kind: z.literal('check') }),
  z.object({ kind: z.literal('call') }),
  z.object({ kind: z.literal('bet'), amount: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('raise'), amount: z.number().int().nonnegative() }),
]);
export type PokerActionPayload = z.infer<typeof pokerActionPayloadSchema>;

export const clientPokerActionFrameSchema = z.object({
  type: z.literal('poker.action'),
  /** The hand this action targets — part of the idempotency key + a stale-hand guard. */
  handNumber: z.number().int().nonnegative(),
  /** Monotonic per-seat action counter — part of the idempotency key. */
  actionSeq: z.number().int().nonnegative(),
  action: pokerActionPayloadSchema,
});

export const clientPokerSitOutFrameSchema = z.object({
  type: z.literal('poker.sit_out'),
});

export const clientPokerSitInFrameSchema = z.object({
  type: z.literal('poker.sit_in'),
});

export const clientFrameSchema = z.discriminatedUnion('type', [
  clientAuthFrameSchema,
  clientInputFrameSchema,
  clientPingFrameSchema,
  clientChatFrameSchema,
  clientEmoteFrameSchema,
  clientLeaveFrameSchema,
  // Texas Hold'em — additive namespaced frames.
  clientPokerActionFrameSchema,
  clientPokerSitOutFrameSchema,
  clientPokerSitInFrameSchema,
]);

export type ClientAuthFrame = z.infer<typeof clientAuthFrameSchema>;
export type ClientInputFrame = z.infer<typeof clientInputFrameSchema>;
export type ClientPingFrame = z.infer<typeof clientPingFrameSchema>;
export type ClientChatFrame = z.infer<typeof clientChatFrameSchema>;
export type ClientEmoteFrame = z.infer<typeof clientEmoteFrameSchema>;
export type ClientLeaveFrame = z.infer<typeof clientLeaveFrameSchema>;
export type ClientPokerActionFrame = z.infer<typeof clientPokerActionFrameSchema>;
export type ClientPokerSitOutFrame = z.infer<typeof clientPokerSitOutFrameSchema>;
export type ClientPokerSitInFrame = z.infer<typeof clientPokerSitInFrameSchema>;
export type ClientFrame = z.infer<typeof clientFrameSchema>;

// ─── Server → Client — metadata shapes ──────────────────────────────────────

/**
 * Reef Race Phase 4 — single ghost replay sample frame. Captured server-side
 * at 5 Hz during the lap that produced the player's personal best, replayed
 * client-side as a translucent sea-horse on every subsequent run.
 *
 * `t` is lap-relative milliseconds (0 = lap start) so the ghost loops
 * cleanly regardless of when the original PB was set. `x`/`z` are sim-space
 * coordinates (sim-Y → Three-Z); `rot` is the body's heading.
 *
 * Lives in shared so both server (capture) and client (playback +
 * snapshot.init payload) reference the same shape — see
 * `apps/web/src/lib/three/activities/reef-race/reef-race-types.ts` re-export
 * for backward compat with the original client-only declaration.
 */
export interface GhostFrame {
  t: number;
  x: number;
  z: number;
  rot: number;
}

/**
 * Reef Race Phase 4 — PB delta block embedded inside `event.match_ended`'s
 * `RewardPreview` and the authoritative `/results` per-row response when a
 * match set a new personal-best lap. Per-recipient: `newGhostFrames` is
 * ONLY included for the WS recipient that earned the PB (S7 fix).
 */
export interface PbDelta {
  /** The new best lap in ms (the lap just-set). */
  newMs: number;
  /** Previous best in ms; `null` when this is the avatar's first PB ever. */
  oldMs: number | null;
  /**
   * S7 FIX — captured frames for the freshly-set PB. Sent ONLY in the
   * recipient's OWN match-end frame (the player who set the PB receives
   * their frames; rivals receive `pbDelta` WITHOUT `newGhostFrames`). The
   * server emits per-recipient match-end frames via `safeSend(ws, …)`,
   * gating this field on `ws.data.identity.avatarId === <pb-setter-avatarId>`.
   */
  newGhostFrames?: GhostFrame[];
  /**
   * C2 FIX — daily-best-lap rank for the just-set PB (1-100), `null` if
   * off-board. Computed in `maybeUpdatePersonalBest` via single indexed
   * scan against the freshly-written row. NOT sourced from the public
   * 60s daily-leaderboard cache — always reflects the just-written PB.
   */
  dailyRank: number | null;
}

/** Reward preview returned on `event.match_ended` — authoritative from DB */
export interface RewardPreview {
  placement: number;
  tokens: number;
  leaderboardPoints: number;
  isPersonalBest?: boolean;
  firstPlayOfDayBonus?: boolean;
  focusBonus?: boolean;
  /**
   * Reef Race Phase 4 — set when the participant's just-completed match
   * lowered their PB lap (or set the first one). Includes PB delta + daily
   * rank; `newGhostFrames` is per-recipient gated. Absent on Bumper Shells
   * and on Reef Race matches that did NOT improve the PB.
   */
  pbDelta?: PbDelta;
  /**
   * Reef Race Phase 4 — best consecutive clean checkpoint crosses this
   * match. Always present on Reef Race matches (>= 0); absent for other
   * activities. Hitting `TOTAL_CHECKPOINTS_PER_RACE` (= 24) yields the
   * perfect-lap bonus, surfaced via `perfectLapBonus`.
   */
  streakBest?: number;
  /**
   * Reef Race Phase 4 — additional ClawTokens credited for a perfect race
   * (streakBest >= 24). 0 when not earned. Sums into `tokens` already; the
   * field is included so the modal can render the bonus line.
   */
  perfectLapBonus?: number;
}

/** Room-level metadata attached to `snapshot.init` */
export interface RoomMeta {
  roomId: string;
  shortCode: string;
  activityId: string;
  status: 'countdown' | 'live' | 'results';
  startedAt?: number;
  endsAt?: number;
  /**
   * Wall-clock millis when the COUNTDOWN→LIVE timer started. Reef Race
   * Phase 1 — HUD computes seconds-remaining locally from this rather
   * than relying on a single one-shot `event.countdown` (audit S9 fix).
   * Optional so older clients tolerating its absence aren't broken.
   */
  countdownStartedAt?: number;
  /**
   * Phase 2 — server-authoritative Reef Race static-zone positions. `null`
   * for non-reef-race rooms. Sent once in `snapshot.init`; never updated.
   * Client builds visual meshes from these so Phase-3 stat tweaks read
   * from a single source of truth (audit N3).
   */
  reefStaticZones?: {
    ribbons: Array<{ id: string; a: Vec2; b: Vec2 }>;
    apexZones: Array<{
      hairpinIndex: number;
      innerCenter: Vec2;
      outerCenter: Vec2;
    }>;
    hazards: Array<{ id: string; center: Vec2; radius: number }>;
  };
  /**
   * Reef Race v2 (spline sim) — server-authoritative boost-pad + ramp trigger
   * zones so the client can render them. Sent ONCE in `snapshot.init`; never
   * updated. `undefined` for the ellipse sim (which uses `reefStaticZones`
   * instead) and all non-reef-race rooms. `position` = world centerline point
   * of the zone center in the `{ x, y }` (y = scene-Z) convention shared with
   * entity positions; `rot` = atan2(tangent.x, tangent.z) so the client can
   * orient the quad down-track; `halfLength`/`halfWidth` are the AABB extents
   * along / perpendicular to the tangent.
   */
  reefSplineZones?: {
    boostPads: Array<{
      id: string;
      position: Vec2;
      halfLength: number;
      halfWidth: number;
      rot: number;
    }>;
    ramps: Array<{
      id: string;
      position: Vec2;
      halfLength: number;
      halfWidth: number;
      rot: number;
    }>;
  };
  /**
   * Phase 3 — Reef Race per-avatar racing profile. Class is derived from
   * `avatars.archetype` (4-bucket mapping); level is from `avatars.level` (1..50).
   * Sent ONCE in `snapshot.init`; never updated. Bots are included with
   * `class: 'balanced', level: 1` (always neutral, Phase 3 §6).
   *
   * S5 fix: room-wide one-shot map (~50 bytes × ≤8 avatars = ≤400 bytes).
   * Client filters by self avatarId for the HUD's archetype tile. Empty /
   * missing on non-reef-race rooms.
   */
  reefRacingProfiles?: Record<
    string,
    {
      class: 'agility' | 'strength' | 'intelligence' | 'balanced';
      level: number;
    }
  >;
  /**
   * Reef Race Phase 4 — self avatar's PB ghost replay frames. Sent ONCE per
   * snapshot.init for the SELF avatar only (not other racers — too crowded
   * per spec §2). Skipped for non-Reef-Race rooms, guests, bots, and avatars
   * without a PB row.
   *
   * ~3-5 KB at 5 Hz capture × ~30 sec lap. The server emits this via
   * per-recipient `safeSend` (S7 fix) — broadcast machinery never serves
   * one player's ghost to another.
   */
  selfBestLapGhost?: GhostFrame[];
  /**
   * Reef Race SPEC 1 — per-avatar display metadata sent ONCE in `snapshot.init`
   * so the client can render the correct GLB without re-querying the avatars table.
   * Keys are avatarId strings. Bots get `modelKey: 'lobster'` (their DB row
   * `openclaw_bots` uses a fixed species).
   *
   * Only populated for `activityId === 'reef-race'` rooms. Absent on all other
   * activity types so existing clients are unaffected.
   */
  reefParticipantMeta?: Record<string, {
    /** Matches `avatars.model_key` — determines which GLB to render. */
    modelKey: string;
  }>;
}

/** Per-entity delta — only changed fields are transmitted */
export interface EntityDelta {
  avatarId: string;
  seq: number;
  changed: {
    x?: number;
    y?: number;
    vx?: number;
    vy?: number;
    rot?: number;
    hp?: number;
    state?: string;
    /**
     * Reef Race v2 (spline sim) — body's height above the river bed in wu.
     * Optional, omitted (= ground level 0) for the common case to save bandwidth.
     * Only sent when body.heightOffset !== 0 (jumping or in dive zone).
     */
    height?: number;
    /**
     * Reef Race v2 (spline sim) — body's WITHIN-LAP race progress as a 0..1
     * fraction of one loop of spline arclength (wraps 1→0 at the seam each lap).
     * Optional; ellipse sim does not emit this field. The render/HUD combine
     * this with `lap` (below) for the true race position; `lap + progress` is
     * the monotonic ordering key.
     */
    progress?: number;
    /**
     * Reef Race v2 CLOSED-LOOP sim — completed-lap count (0-based: 0 on lap 1,
     * increments each time the body crosses the start/finish seam forward).
     * Pairs with `progress` (within-lap fraction). Render shows `lap+1 / totalLaps`.
     */
    lap?: number;
    /**
     * Reef Race v2 CLOSED-LOOP sim — live finishing position (1 = leading),
     * ordered by (lap desc, then within-lap progress desc; finishers by time,
     * DNF last). Server-computed each tick; the HUD reads this directly.
     */
    position?: number;
    /**
     * Reef Race v2 CLOSED-LOOP sim — total laps in the race (constant for the
     * room; carried for HUD "lap X / N" rendering without a separate fetch).
     */
    totalLaps?: number;
    /**
     * Reef Race v2 mechanics — surf-carve mini-turbo charge, normalized 0..1
     * against the tier-2 full-charge threshold (HUD meter fill). 0 when not
     * charging. Optional; ellipse sim omits it.
     */
    miniTurboCharge?: number;
    /**
     * Reef Race v2 mechanics — mini-turbo tier the charge has reached so far
     * (0 = none, 1, 2). Drives the HUD meter color. Optional.
     */
    miniTurboLevel?: 0 | 1 | 2;
    /**
     * Reef Race v2 mechanics — true while ANY positive boost is active (boost
     * pad / mini-turbo / launch / slipstream). Drives kart trail/FX. Optional.
     */
    boosting?: boolean;
    [k: string]: unknown;
  };
}

export interface PowerUpDelta {
  spawnId: string;
  kind: string;
  position?: Vec2;
  collectorAvatarId?: string;
  /** Server-owned inventory — client mirrors this for HUD */
  inventory?: Array<{
    kind: string;
    charges: number;
    cooldownUntil?: number;
  }>;
}

export interface ScoreDelta {
  avatarId: string;
  score: number;
  placement?: number;
  /**
   * Reef Race v2 CLOSED-LOOP sim — completed-lap count, mirrored into the
   * keyframe `scores[]` so a fresh keyframe carries lap state without waiting
   * for the next per-entity delta. Optional; other activities omit it.
   */
  lap?: number;
  /** Reef Race v2 CLOSED-LOOP sim — total laps in the race (HUD "lap X / N"). */
  totalLaps?: number;
}

/** Full room state (for snapshot.init and snapshot.keyframe) */
export interface WorldState {
  tick: number;
  entities: Array<{
    avatarId: string;
    position: Vec2;
    velocity: Vec2;
    rotation: number;
    state: string;
    hp?: number;
    /**
     * Reef Race v2 — height above the ribbed water (wu). Omitted (= 0) when
     * grounded. Carried on keyframes so a keyframe doesn't drop a jump's height.
     */
    height?: number;
    /**
     * Reef Race v2 mechanics — surf-carve mini-turbo charge 0..1 (HUD meter),
     * carried on keyframes so the 1 Hz keyframe doesn't blank the meter.
     */
    miniTurboCharge?: number;
    /** Reef Race v2 mechanics — mini-turbo tier reached (0|1|2). */
    miniTurboLevel?: 0 | 1 | 2;
    /** Reef Race v2 mechanics — any positive boost active (kart trail/FX). */
    boosting?: boolean;
  }>;
  powerUps: Array<{
    spawnId: string;
    kind: string;
    position: Vec2;
  }>;
  scores: Array<{
    avatarId: string;
    score: number;
    /** Reef Race v2 CLOSED-LOOP sim — completed-lap count (keyframe lap state). */
    lap?: number;
    /** Reef Race v2 CLOSED-LOOP sim — total laps in the race. */
    totalLaps?: number;
    /** Reef Race v2 CLOSED-LOOP sim — live finishing position (1 = leading). */
    position?: number;
  }>;
}

// ─── Server → Client frame union ────────────────────────────────────────────

export type ServerFrame =
  | {
      type: 'snapshot.init';
      /** Epoch ms when the authoritative pose sample was captured. */
      serverTimeMs?: number;
      room: RoomMeta;
      world: WorldState;
      seed: number;
    }
  | {
      type: 'snapshot.delta';
      /** Epoch ms when the authoritative pose sample was captured. */
      serverTimeMs?: number;
      baseSeq: number;
      seq: number;
      entities: EntityDelta[];
      powerUps: PowerUpDelta[];
      scores?: ScoreDelta[];
    }
  | {
      type: 'snapshot.keyframe';
      /** Epoch ms when the authoritative pose sample was captured. */
      serverTimeMs?: number;
      seq: number;
      world: WorldState;
    }
  | { type: 'event.countdown'; secondsRemaining: number }
  | { type: 'event.match_started'; startedAt: number }
  | {
      type: 'event.match_ended';
      reason: 'complete' | 'forfeit' | 'aborted';
      winners: Array<{ avatarId: string; placement: number }>;
      rewardPreview: RewardPreview;
    }
  | { type: 'event.player_joined'; avatarId: string; displayName: string }
  | {
      type: 'event.player_left';
      avatarId: string;
      reason: 'voluntary' | 'timeout' | 'integrity';
    }
  | { type: 'event.eliminated'; avatarId: string; by?: string }
  | {
      type: 'event.hit';
      srcAvatarId: string;
      dstAvatarId: string;
      position: Vec2;
      power: number;
    }
  | {
      /**
       * Lap completed. Emitted by BOTH sims now:
       *   - Ellipse sim (live): per-checkpoint-loop lap.
       *   - v2 CLOSED-LOOP spline sim (2026-06-22): one per forward start/finish
       *     seam crossing that completes a NON-final lap (the final lap fires
       *     `event.crossed_finish` instead). It stamps real `splitMs` (time since
       *     the previous lap line) + `totalMs` (since match start), and adds
       *     `totalLaps` for "lap X / N" HUD rendering.
       */
      type: 'event.lap_completed';
      avatarId: string;
      lap: number;
      splitMs: number;
      totalMs: number;
      /** v2 CLOSED-LOOP sim: total laps in the race (HUD "lap X / N"). Optional for the ellipse sim. */
      totalLaps?: number;
    }
  | {
      /**
       * Reef Race v2 — first racer to cross the finish line. Server-stamped
       * totalMs + placement. Triggers the wait-at-finish countdown for the
       * remaining racers (see event.finish_wait_started).
       */
      type: 'event.crossed_finish';
      avatarId: string;
      totalMs: number;
      placement: number;
    }
  | {
      /**
       * Reef Race v2 — first finisher just crossed; remaining racers have
       * msRemaining to also finish before the match force-ends.
       * Per .claude/plans/reef-race-v2.md "End condition" decision.
       */
      type: 'event.finish_wait_started';
      msRemaining: number;
    }
  | {
      type: 'event.power_up_spawned';
      spawnId: string;
      kind: string;
      position: Vec2;
    }
  | {
      type: 'event.power_up_collected';
      spawnId: string;
      collectorAvatarId: string;
      /**
       * Phase 2 — kind of the item placed into inventory. May differ from the
       * spawn-time kind when the placement-aware re-roll fires (audit C2 fix).
       * Old clients silently drop this field. `undefined` on Phase 1 servers.
       *
       * impl-audit M1: narrowed from `string` to `ReefPowerUpKind` so a
       * rogue server can't slip an unknown string into the client inventory
       * slot. Old Phase 1 servers omit this field — `?` keeps backward
       * compat with the Phase 1 broadcast shape.
       */
      kind?: ReefPowerUpKind;
    }
  | {
      /**
       * Phase 2 — slipstream verdict START. Fired once when `dstAvatarId` first
       * enters `srcAvatarId`'s wake AND completes SLIPSTREAM_REQUIRED_TICKS hold.
       * Edge-triggered. NOT broadcast on every tick of being in-wake.
       */
      type: 'event.slipstream';
      srcAvatarId: string;
      dstAvatarId: string;
    }
  | {
      /**
       * Phase 2 — slipstream verdict END. Fired once when the body's grace
       * counter runs out and the activeBoosts entry is cleared. Edge-triggered.
       * Eliminates client-side timer polling (audit S4 fix).
       */
      type: 'event.slipstream_end';
      dstAvatarId: string;
    }
  | {
      /**
       * Phase 2 — apex verdict. `kind: 'clean'` = inside line +5%,
       * `'wide'` = outside line -5%. Fired at most once per (avatarId, lap,
       * hairpinIndex). Renamed from event.apex_bonus (audit S1 fix).
       */
      type: 'event.apex_verdict';
      avatarId: string;
      hairpinIndex: number;
      kind: 'clean' | 'wide';
    }
  | {
      /**
       * Phase 2 — boost ribbon collection. `ribbonId` is 'rib-top' or
       * 'rib-bot'. HUD may flash; scene fires a sparkle particle burst.
       */
      type: 'event.ribbon_collected';
      avatarId: string;
      ribbonId: string;
    }
  | {
      /**
       * Phase 2 — sea-urchin field clip. Fired once per (avatarId, lap,
       * hazardId). activeBoosts handles per-tick speed penalty refresh.
       */
      type: 'event.hazard_hit';
      avatarId: string;
      hazardId: string;
    }
  | {
      /**
       * Reef Race Phase 1 — drift boost fired at release. `sparks` ∈ {1,2,3}
       * indicates the tier reached during the charge. Phase 1 clients drive
       * HUD off `EntityDelta.changed.driftSparks` (already 0 by the time this
       * event lands); event reserved for future scene VFX (boost flash, audio
       * sting). Backwards compat: old clients hit `default: never` → no-op.
       */
      type: 'event.drift_boost';
      avatarId: string;
      sparks: 1 | 2 | 3;
    }
  | {
      /**
       * Reef Race Phase 1 — launch verdict at COUNTDOWN→LIVE. `kind: 'boost'`
       * means the player pressed within ±LAUNCH_WINDOW_MS of green; `'stall'`
       * means they pressed earlier (in the [-(WINDOW+STALL_WINDOW), -WINDOW)
       * range) and incurred a 1s thrust cap. Phase 1 HUD glow ring is local-
       * countdown-driven; event reserved for future per-player VFX.
       */
      type: 'event.launch';
      avatarId: string;
      kind: 'boost' | 'stall';
    }
  | {
      /**
       * Reef Race Phase 4 — streak milestone (5/10/16/20/24 clean checkpoint
       * crosses in a row). Edge-triggered, NOT broadcast per checkpoint — the
       * per-tick streak count rides `EntityDelta.changed.streak` instead.
       *
       * `kind` maps to the HUD glow tier — single source of truth at
       * `@clawville/shared/activities/reef-race-streak#streakMilestoneKind`.
       *
       * S2 FIX — milestones compressed from 7 to 5 to match the 5-tier union.
       */
      type: 'event.streak_milestone';
      avatarId: string;
      streak: number;
      kind: 'tier-1' | 'tier-2' | 'tier-3' | 'tier-4' | 'perfect';
    }
  | {
      type: 'chat';
      avatarId: string;
      text: string;
      /**
       * Chunk #11 — when `true`, indicates the chat originated on the
       * spectator channel. Clients route to the spectator chat panel
       * instead of the active-player chat. Backwards-compatible (legacy
       * server emissions omit the field, treated as active-player chat).
       */
      spectator?: boolean;
      /**
       * Chunk #11 — emote channel marker. When set, the chat is the
       * server's broadcast of an `emote` frame (cheer/taunt). Clients
       * may render with an emote icon instead of a chat bubble.
       */
      emote?: { emoteId: string };
    }
  | { type: 'pong'; sentAt: number; serverTime: number }
  | { type: 'error'; code: string; message: string }
  | {
      /**
       * Reef Race SPEC 3 — ramp launch event. Fired by the server when a body
       * enters a ramp AABB on the spline track. Client uses this to:
       *   - Extend nose-up tilt to 16° for RAMP_TILT_HOLD_S (0.35s)
       *   - Trigger screen shake for self-player only
       *   - Trigger particle burst for self-player only
       * Old clients silently ignore this event (switch/case default → no-op).
       */
      type: 'event.ramp_launch';
      avatarId: string;
      rampId: string;
      launchVel: number;
    }
  | {
      /**
       * Reef Race v2 mechanics — a body entered a boost-pad AABB on the spline
       * track. Fired for self, rivals, and bots. Client flashes the pad,
       * screen-shakes + particle-bursts for the SELF player only (like
       * event.ramp_launch). Old clients ignore it (switch default → no-op).
       */
      type: 'event.boost_pad';
      avatarId: string;
      padId: string;
    }
  | {
      /**
       * Reef Race v2 mechanics — a sustained surf-carve discharged into a
       * mini-turbo. `level` is the tier reached (1 = small, 2 = big). Fired on
       * release for self, rivals, and bots. Client plays a spark/whoosh FX.
       * Old clients ignore it (switch default → no-op).
       */
      type: 'event.mini_turbo_fire';
      avatarId: string;
      level: 1 | 2;
    }
  // ─── Texas Hold'em (`poker.*`) server frames — ADDITIVE ───────────────────
  //
  // PUBLIC frames (delivered via `broadcastEvent` — keyframe-safe, NEVER via
  // `broadcastSnapshot` which drops under backpressure). None of these carry a
  // hole card: `PokerPublicTableSnapshot` has no such field, and the showdown /
  // hand-ended reveals only post-resolution public results.
  | {
      /**
       * Full public table state — the poker counterpart to `snapshot.keyframe`,
       * but for turn-based play it rides `broadcastEvent` (every seat must get
       * every turn transition; a dropped frame desyncs the betting UI). Carries
       * NO hole cards by type.
       */
      type: 'poker.table_state';
      snapshot: PokerPublicTableSnapshot;
    }
  | {
      /**
       * A new community street was dealt (flop/turn/river). `board` is the
       * cumulative public board for the new street (length === street count).
       * Lets the client animate the deal without diffing two `table_state`
       * frames. `table_state` is ALSO broadcast for the new actor.
       */
      type: 'poker.street_dealt';
      handNumber: number;
      street: PokerStreet;
      board: PokerCard[];
    }
  | {
      /**
       * One seat's action was accepted + applied. Pure UI/animation signal —
       * the authoritative state still rides `poker.table_state`. `amount` is the
       * resulting TOTAL street commitment for bet/raise, else omitted.
       */
      type: 'poker.action_applied';
      handNumber: number;
      seatIndex: number;
      avatarId: string;
      action: PokerActionKind;
      amount?: number;
    }
  | {
      /**
       * Showdown reveal — fired when a hand reaches showdown (≥2 live seats to
       * the river) OR ends early. Carries the final public board + per-seat
       * results. Folded seats muck (`holeCards: null`); only seats that reached
       * showdown reveal cards. This is the ONLY public frame that reveals any
       * hole cards, and ONLY after the hand is resolved.
       */
      type: 'poker.showdown';
      handNumber: number;
      board: PokerCard[];
      seats: PokerHandResultSeat[];
    }
  | {
      /**
       * The hand is fully resolved + the table is idle. Carries the complete
       * `PokerHandResult` including `serverSeedRevealed` (the commit-reveal seed,
       * present ONLY here — never mid-hand) so the deal can be verified.
       */
      type: 'poker.hand_ended';
      result: PokerHandResult;
    }
  // PRIVATE frames (delivered via `sendToAvatar` ONLY — one seat). These DO
  // carry hole cards and MUST NEVER be broadcast.
  | {
      /**
       * The seat's own two hole cards, delivered once on deal (and re-sendable
       * on reconnect). PRIVATE — `sendToAvatar` only.
       */
      type: 'poker.hole_cards';
      handNumber: number;
      seatIndex: number;
      holeCards: [PokerCard, PokerCard];
    }
  | {
      /**
       * It is this seat's turn — carries its private view (hole cards + legal
       * actions + bet bounds + deadline). PRIVATE — `sendToAvatar` only.
       */
      type: 'poker.your_turn';
      handNumber: number;
      view: PokerPrivateSeatView;
    }
  // ─── Multi-table MTT (P4) — ADDITIVE rebalance frames ─────────────────────
  | {
      /**
       * The MTT engine MOVED this player to another tournament table between
       * hands (rebalance / table-break / final-table consolidation). Carries the
       * NEW room id + short code + the player's seat index + chip stack at the
       * destination (chips are conserved across the move). The client re-opens
       * its WS to `toRoomId` on receipt. PRIVATE — `sendToAvatar` only (delivered
       * on the OLD room's connection while it is still authed there). `chipStack`
       * is the stack carried across; `reason` documents the trigger.
       */
      type: 'poker.moved';
      toRoomId: string;
      toShortCode: string;
      seatIndex: number;
      chipStack: number;
      reason: 'rebalance' | 'table_break' | 'final_table';
    }
  | {
      /**
       * A tournament table's seat roster changed because a player was moved
       * to/from it (rebalance / table-break / final-table). PUBLIC signal so
       * connected clients refresh their seat list. `direction` is from THIS
       * room's perspective: the player `left` this table or `joined` it.
       */
      type: 'poker.table_rebalanced';
      avatarId: string;
      direction: 'left' | 'joined';
      reason: 'rebalance' | 'table_break' | 'final_table';
    };

// ─── Close codes ────────────────────────────────────────────────────────────

/**
 * WebSocket close codes used by the activity WS hub. Values in the
 * 4000-4999 range are application-private (per RFC 6455).
 */
export const ACTIVITY_WS_CLOSE_CODES = {
  /** auth frame missing, malformed, or sessionToken invalid */
  UNAUTHORIZED: 4001,
  /** client failed to drain send buffer for >8s */
  SLOW_READ: 4002,
  /** anti-cheat flag threshold exceeded (5 flags/match) */
  INTEGRITY: 4003,
  /** Sybil guard tripped (concurrent-room cap) */
  CONCURRENCY_CAP: 4004,
} as const;

export type ActivityWsCloseCode =
  (typeof ACTIVITY_WS_CLOSE_CODES)[keyof typeof ACTIVITY_WS_CLOSE_CODES];
