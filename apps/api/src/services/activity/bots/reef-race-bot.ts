/**
 * Q2 Activity Portals — Reef Race bot controller (chunk #5).
 *
 * Heuristic policy (intentionally beatable — humans should win
 * sometimes; spec §8.4 calls them "simple heuristic controllers"):
 *
 *   1. Aim toward the next checkpoint center, with small per-tick jitter.
 *   2. Hold thrust at 0.85 (high cruise) — boost only via power-ups.
 *   3. If a power-up is held + off cooldown, fire it ~30% of ticks.
 *   4. Don't sprint into a corner blind: when the angle between the
 *      current heading and the next-checkpoint direction is large,
 *      drop thrust to 0.6 to allow the velocity to swing.
 *   5. If somehow off the track (perpendicular distance from centerline
 *      > REEF_TRACK_HALF_WIDTH * 1.5), aim back toward the next
 *      checkpoint center directly with full thrust.
 *
 * Stateless beyond avatarId — chunk #10 pattern.
 */

import type { BotController, BotInput, BotRoomView } from './bot-controller';
import {
  REEF_TRACK_HALF_WIDTH,
  REEF_MAX_SPEED,
  REEF_TICK_HZ,
  REEF_TICK_MS,
  DRIFT_SPARK_TICK_1,
  DRIFT_SPARK_TICK_2,
  DRIFT_SPARK_TICK_3,
  ACTION_BIT_DRIFT,
  ACTION_BIT_LAUNCH,
  ACTION_BIT_POWERUP_0,
  // Phase 2 — bot heuristics
  APEX_HAIRPIN_CHECKPOINT_INDICES,
  APEX_INSIDE_OFFSET,
  SLIPSTREAM_MAX_DISTANCE,
  REEF_POWERUP_RADIUS,
  REEF_RACE_USE_SPLINE,
  type ReefCheckpointAabb,
  type ReefBoostRibbon,
  type ReefHazardPatch,
} from '../sim/reef-race-config';
import { ReefSpline } from '../sim/reef-race-spline';
import { REEF_RACE_DEFAULT_TRACK } from '../sim/reef-race-track-layout';

const POWERUP_USE_CHANCE = 0.3;
const JITTER_MAGNITUDE = 0.08;
/**
 * Opening grace window — bots cruise at low thrust toward the next
 * checkpoint without firing power-ups for the first 2.5s. Mirrors the
 * Bumper Shells grace; gives a human time to read the start line + HUD
 * before the bots accelerate to cruise speed.
 */
const BOT_OPENING_GRACE_MS = 2_500;

/**
 * Phase 1 — bot drift trigger probability per tick once a hairpin is
 * detected (`dot < 0.5 && distToTarget > 200`). Tuned so the bot picks up
 * a drift roughly twice per typical legacy-ellipse lap.
 */
const BOT_DRIFT_TRIGGER_PER_SEC = 0.60;

/**
 * Phase 2 — per-body race-progress projection appended by the sim's
 * `buildBotRoomView`. The bot can compute drafting / placement-fire
 * heuristics without re-deriving the same data on every tick.
 */
interface ReefBotBody {
  avatarId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  alive: boolean;
  inventory: BotRoomView['bodies'][number]['inventory'];
  lap?: number;
  nextCheckpoint?: number;
  currentPlacement?: number | null;
  finishedAt?: number | null;
  dnf?: boolean;
}

/**
 * Extension of the generic `BotRoomView` with Reef-specific fields the
 * sim's `buildBotRoomView` injects. The Bumper bot doesn't read these,
 * and the Reef bot doesn't read Bumper's arenaRadius — both fields are
 * present in the shared shape for forward-compat.
 *
 * Phase 2 — `bodies[].lap`, `nextCheckpoint`, `currentPlacement`, `finishedAt`,
 * `dnf` are appended by the sim's `buildBotRoomView` (audit C1 fix). They
 * are optional in this declaration because the bumper sim doesn't fill them
 * and any future bot harness might not either.
 */
interface ReefBotRoomView extends Omit<BotRoomView, 'bodies'> {
  nextCheckpoint?: number;
  checkpoints?: ReefCheckpointAabb[];
  bodies: ReefBotBody[];
  /**
   * Phase 2 (impl-audit S6, M4) — server-authoritative static zones. Read-only.
   * `ribbons` lets the bot opportunistically steer through boost ribbons
   * (plan §8.2 — previously skipped, see audit S6). `hazards` lets the bot
   * dodge actual urchin centers instead of an APEX-derived approximation
   * that drifts when the placement formula retunes (audit M4).
   */
  ribbons?: ReadonlyArray<Pick<ReefBoostRibbon, 'id' | 'a' | 'b'>>;
  hazards?: ReadonlyArray<Pick<ReefHazardPatch, 'id' | 'center' | 'radius'>>;
}

// ─── v2 spline-bot constants ────────────────────────────────────────────────
// Reef Race v2 — bot AI for the spline track. Active only when
// REEF_RACE_USE_SPLINE is true. Spec: `.claude/plans/reef-race-v2.md` and
// architecture §5 of `.claude/plans/reef-race-v2-spline-architecture.md`.
//
// The v2 path is fully separate from the legacy ellipse heuristics above —
// flag-gated inside computeInput so production stays bit-identical until the
// flag flips. Drift logic is DROPPED on the v2 path (ACTION_BIT_DRIFT bit is
// reused as ACTION_BIT_JUMP in v2; the sim handles the bit).

/** Lookahead for race-line target in spline t-space (NOT arclength). */
const V2_LOOKAHEAD_T = 0.03;

/**
 * Curvature delta sample distance (t-space). The bot samples the tangent at
 * `t` and at `t + V2_CURVATURE_SAMPLE_DT`, then computes the angular delta to
 * estimate curvature. Spec: §5.
 */
const V2_CURVATURE_SAMPLE_DT = 0.02;

/** Threshold (radians) for "the curve is sharp enough to bias toward inside". */
const V2_CURVATURE_THRESHOLD_RAD = 0.05;

/**
 * Lateral offset magnitude per radian of curvature. Capped against a fraction
 * of widthAt(t) so the bot stays inside the corridor on extreme curvatures.
 */
const V2_OFFSET_PER_RAD = 200;

/** Inside-offset fraction of the corridor halfWidth. */
const V2_OFFSET_FRACTION_OF_HALF_WIDTH = 0.3;

/** Pickup detection radius multiplier. Spec: 3 * REEF_POWERUP_PICKUP_RADIUS. */
const V2_PICKUP_LOOKAHEAD_MULT = 3;

/**
 * Pickup deviation budget. Spec: bot only redirects if pickup is within
 * 40% of widthAt(t) lateral deviation from the racing line.
 */
const V2_PICKUP_DEVIATION_FRACTION = 0.4;

/**
 * Lazy-built spline singleton — same control points as the sim's spline so
 * the math is identical. Built once on first bot tick (boot-time
 * construction would inflate cold-start cost on the API; first-tick lazy
 * mirrors how the sim itself constructs per-room).
 */
let _splineSingleton: ReefSpline | null = null;
function getSpline(): ReefSpline {
  if (!_splineSingleton) {
    // CLOSED-LOOP (2026-06-22): match the server sim's periodic ring so the
    // bot's closestPointOnSpline / lookahead t wraps across the seam (no stall
    // at the start/finish line each lap).
    _splineSingleton = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });
  }
  return _splineSingleton;
}

/**
 * v2 — ramp AABB definitions (XZ corridor zones where the server injects
 * REEF_JUMP_IMPULSE_RAMP). Phase 1 layout has ZERO ramps — Phase 2 places
 * them along the spline. The bot still emits ACTION_BIT_JUMP when its
 * forward-projected position enters a ramp AABB so when ramps land in
 * Phase 2, this path lights up immediately.
 *
 * TODO(reef-race-v2 Phase 2): populate this from the track-layout module
 * once ramp positions are locked. Until then the array stays empty and
 * the bot's ramp-jump code is dead but cheap.
 */
const REEF_RACE_RAMP_ZONES: ReadonlyArray<{
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
}> = [];

// TODO(reef-race-v2 Phase 2): manual obstacle-jump detection. When v2
// adds static obstacle AABBs to the track, scan the lookahead window for
// any obstacle whose top is below REEF_JUMP_IMPULSE_MANUAL apex height
// and emit ACTION_BIT_JUMP one tick before entry. Hooks would land here.

/**
 * Optional v2 fields tacked onto the bot's room view by the spline sim's
 * buildBotRoomView. Phase 1 spline-sim does NOT populate `pickups` (Wave 2
 * follow-up) — the v2 bot's pickup-deviation branch no-ops gracefully when
 * the field is absent. Tests inject `pickups` directly to exercise the
 * branch.
 */
interface ReefV2BotRoomView {
  pickups?: ReadonlyArray<{
    x: number; // protocol X (sim X)
    y: number; // protocol Y (sim Z)
    active: boolean;
  }>;
}

/**
 * Phase 2 (impl-audit S6) — ribbon-aware steering tuning.
 *
 * The bot scans ribbons within `BOT_RIBBON_LOOKAHEAD_WU` of self that lie in
 * its forward cone (cos(angle) ≥ `BOT_RIBBON_FORWARD_COS`). If found, the
 * dir vector blends `BOT_RIBBON_PULL_WEIGHT` toward the nearest ribbon point.
 *
 * Lookahead is 30% of base top speed (390wu at 1300), preserving the bot's
 * reaction horizon as the race-speed tuning changes. It is long enough to
 * commit without locking onto a ribbon halfway across the track.
 * Forward cone cos(60°) = 0.5 — wider than draft cone (cos(30°)) because
 * ribbons are static targets, not moving targets.
 * Pull weight 0.30 = same magnitude as the apex-inside pull, so a hairpin
 * apex still wins when both fire (apex check runs after ribbon — see order
 * in computeInput). Net effect: bots collect ribbons on the long straights
 * but don't sacrifice apex line through hairpins.
 */
const BOT_RIBBON_LOOKAHEAD_WU = REEF_MAX_SPEED * 0.30;
const BOT_RIBBON_FORWARD_COS = 0.5;
const BOT_RIBBON_PULL_WEIGHT = 0.30;

class ReefRaceBot implements BotController {
  readonly activityId = 'reef-race';

  // Phase 1 — drift state.
  private driftActive = false;
  private driftStartedMs = 0;
  private driftTargetTicks: number = DRIFT_SPARK_TICK_1;

  // Phase 1 — launch attempt state. `launchFireMs = -1` is the sentinel
  // meaning "not yet planned"; on first computeInput we plan a one-shot
  // fire time relative to matchStartedAt with ±400ms jitter.
  private launchAttempted = false;
  private launchFireMs = -1;

  // Phase 2 — apex line preference (re-rolled per hairpin entry; sticks
  // through the corner so the bot doesn't oscillate).
  private lineMode: 'inside' | 'mid' = 'mid';
  private lineModeForCheckpoint: number = -1;

  constructor(public readonly avatarId: string) {}

  computeInput(roomState: BotRoomView, dt: number): BotInput {
    const view = roomState as ReefBotRoomView;
    const self = view.bodies.find((b) => b.avatarId === this.avatarId);
    if (!self || !self.alive) {
      return { dir: { x: 0, y: 0 }, thrust: 0, actionBits: 0 };
    }

    // ─── v2 spline path — fully separate from ellipse heuristics ─────────
    // Active when REEF_RACE_USE_SPLINE is true. Drift logic is dropped on
    // this path; ACTION_BIT_DRIFT bit is reused as ACTION_BIT_JUMP server-
    // side. Bot only emits jump when entering a ramp AABB (v2 layout has
    // zero ramps in Phase 1 so this is dead code by design — Phase 2
    // populates REEF_RACE_RAMP_ZONES).
    if (REEF_RACE_USE_SPLINE) {
      return this.computeInputSpline(view, self, dt);
    }

    // Without the Reef-specific fields the bot can't navigate. Return a
    // safe coast so the test harness can still exercise it without
    // hooking up the full sim view.
    if (!view.checkpoints || view.checkpoints.length === 0) {
      return { dir: { x: 1, y: 0 }, thrust: 0.3, actionBits: 0 };
    }

    const targetIndex = (view.nextCheckpoint ?? 1) % view.checkpoints.length;
    const target = view.checkpoints[targetIndex];

    // ── LAUNCH ATTEMPT — EARLY RETURN, before the grace branch (audit C5) ──
    // Bypasses the `thrust: inGrace ? 0.4 : thrust` final return that would
    // otherwise overwrite our thrust=1.0 launch press. The hub captures the
    // thrust=1.0 frame in its COUNTDOWN preLaunchBuffer branch, and the room
    // manager's computeLaunchVerdicts() resolves the verdict at LIVE.
    if (this.launchFireMs < 0) {
      // Jitter ±400ms relative to matchStartedAt:
      //   [-150, +150]ms → boost window     (~37.5% of range)
      //   [-350, -150]ms → stall zone       (~25%   of range)
      //   remainder      → no verdict       (~37.5% of range)
      const jitter = Math.random() * 800 - 400;
      this.launchFireMs = view.matchStartedAt + jitter;
    }
    if (!this.launchAttempted && view.now >= this.launchFireMs) {
      this.launchAttempted = true;
      // Aim toward the next checkpoint; direction is irrelevant for the
      // launch-detection itself (the room manager only inspects thrust+ts)
      // but we keep it sane so the body doesn't lurch sideways on the
      // first integration tick.
      let lx = target.center.x - self.x;
      let ly = target.center.y - self.y;
      const llen = Math.hypot(lx, ly) || 1;
      lx /= llen;
      ly /= llen;
      return {
        dir: { x: lx, y: ly },
        thrust: 1.0,
        actionBits: ACTION_BIT_LAUNCH,
      };
    }

    let dx = target.center.x - self.x;
    let dy = target.center.y - self.y;
    const distToTarget = Math.hypot(dx, dy);
    if (distToTarget > 0) {
      dx /= distToTarget;
      dy /= distToTarget;
    } else {
      dx = target.tangent.x;
      dy = target.tangent.y;
    }

    // Apply jitter — small per-tick noise so the bot doesn't track perfectly.
    dx += (Math.random() - 0.5) * 2 * JITTER_MAGNITUDE;
    dy += (Math.random() - 0.5) * 2 * JITTER_MAGNITUDE;
    const mag = Math.hypot(dx, dy);
    if (mag > 0) {
      dx /= mag;
      dy /= mag;
    }

    // Thrust: lower if heading is far off velocity direction (let the
    // body swing).
    let thrust = 0.85;
    let dot = 1;
    const speed = Math.hypot(self.vx, self.vy);
    if (speed > 1) {
      const headingX = self.vx / speed;
      const headingY = self.vy / speed;
      dot = dx * headingX + dy * headingY;
      if (dot < 0.3) thrust = 0.6;
    }

    // Off-track recovery — perpendicular distance from centerline of
    // the next checkpoint. If far, boost back toward target.
    //
    // NOTE (2026-04-26): the wall-clamp safety pass added to the sim
    // (enforceWallClamp post-resolveProximity, reflectVelocity=false) pins
    // bodies at perp = REEF_TRACK_HALF_WIDTH, so this 1.5× recovery branch
    // is now reachable only in the very narrow window between the position
    // mutation in resolveProximity and the next tick's clamp. In practice
    // the branch will rarely fire — bots get clamped before they can reach
    // 1.5×. Leaving it as a defensive fallback in case a future sim change
    // bypasses the safety pass.
    const along = (self.x - target.center.x) * target.tangent.x + (self.y - target.center.y) * target.tangent.y;
    const perpX = self.x - target.center.x - along * target.tangent.x;
    const perpY = self.y - target.center.y - along * target.tangent.y;
    const perp = Math.hypot(perpX, perpY);
    if (perp > REEF_TRACK_HALF_WIDTH * 1.5) {
      thrust = 1.0;
    }

    // Phase 1 — drift release check. If we held drift long enough to hit
    // the target tier, drop the bit so the sim fires the boost on this tick.
    if (this.driftActive) {
      const chargedTicks = Math.round(
        (view.now - this.driftStartedMs) / REEF_TICK_MS,
      );
      if (chargedTicks >= this.driftTargetTicks) {
        this.driftActive = false;
      }
    }

    // Opening grace — coast toward the checkpoint at low thrust + no
    // power-ups so the human has 2.5s to orient. This branch overrides
    // the cruise/cornering thrust calculations above with a steady 0.4.
    //
    // Phase 2 (audit N12 fix) — ALL new heuristics (drafting, apex line,
    // hazard avoidance, ribbons, placement-weighted item firing) are
    // gated on `!inGrace`. Bots respect Phase 1's grace.
    const matchAge = view.now - view.matchStartedAt;
    const inGrace = matchAge < BOT_OPENING_GRACE_MS;

    // ── Phase 2 — drafting bias toward a leader within slipstream range ──
    if (!inGrace) {
      const draftTarget = this.pickDraftTarget(view, self);
      if (draftTarget) {
        // Bias dir 25% toward draftTarget's position over the
        // checkpoint dir.
        const tdx = draftTarget.x - self.x;
        const tdy = draftTarget.y - self.y;
        const tlen = Math.hypot(tdx, tdy) || 1;
        const tnx = tdx / tlen;
        const tny = tdy / tlen;
        dx = dx * 0.75 + tnx * 0.25;
        dy = dy * 0.75 + tny * 0.25;
        const m2 = Math.hypot(dx, dy) || 1;
        dx /= m2;
        dy /= m2;
      }
    }

    // ── Phase 2 — apex line preference on hairpin checkpoints ──
    const isHairpinTarget =
      APEX_HAIRPIN_CHECKPOINT_INDICES.includes(
        targetIndex as 3 | 9,
      );
    if (!inGrace && isHairpinTarget) {
      // Re-roll line mode each time we approach a fresh hairpin (different
      // checkpoint than last). 70% inside, 30% mid.
      if (this.lineModeForCheckpoint !== targetIndex) {
        this.lineModeForCheckpoint = targetIndex;
        this.lineMode = Math.random() < 0.70 ? 'inside' : 'mid';
      }
      if (this.lineMode === 'inside') {
        const apexX = target.center.x + target.normal.x * APEX_INSIDE_OFFSET;
        const apexY = target.center.y + target.normal.y * APEX_INSIDE_OFFSET;
        const adx = apexX - self.x;
        const ady = apexY - self.y;
        const alen = Math.hypot(adx, ady) || 1;
        dx = dx * 0.70 + (adx / alen) * 0.30;
        dy = dy * 0.70 + (ady / alen) * 0.30;
        const m3 = Math.hypot(dx, dy) || 1;
        dx /= m3;
        dy /= m3;
      }
    } else if (!isHairpinTarget) {
      // Reset line mode when we leave the hairpin.
      this.lineModeForCheckpoint = -1;
      this.lineMode = 'mid';
    }

    // ── Phase 2 (impl-audit S6) — ribbon-aware steering ──
    //    Opportunistically blend the dir vector toward the nearest boost ribbon
    //    that lies in the bot's forward cone within BOT_RIBBON_LOOKAHEAD_WU.
    //    Bots run after grace + after apex so a hairpin apex pull ALWAYS beats
    //    a ribbon pull; ribbons live on the long straights so the two zones
    //    don't overlap in practice. Without this, plan §8.2 was unimplemented
    //    and bots collected ribbons only by accident on the centerline path.
    if (!inGrace) {
      const ribbon = this.pickRibbonTarget(view, self, dx, dy);
      if (ribbon) {
        const rdx = ribbon.x - self.x;
        const rdy = ribbon.y - self.y;
        const rlen = Math.hypot(rdx, rdy) || 1;
        dx = dx * (1 - BOT_RIBBON_PULL_WEIGHT) + (rdx / rlen) * BOT_RIBBON_PULL_WEIGHT;
        dy = dy * (1 - BOT_RIBBON_PULL_WEIGHT) + (rdy / rlen) * BOT_RIBBON_PULL_WEIGHT;
        const mr = Math.hypot(dx, dy) || 1;
        dx /= mr;
        dy /= mr;
      }
    }

    // ── Phase 2 — hazard avoidance: bias AWAY from hazard centers ahead.
    //    Hazards are colocated near hairpin apex inside lines, so bots that
    //    take the inside line will naturally clip them — opt out via this
    //    cheap proximity check.
    //
    //    impl-audit M4 fix: read ACTUAL hazards from the projected view rather
    //    than approximating with `APEX_INSIDE_OFFSET * 0.73`. Old approximation
    //    silently drifted off the actual hazard center if HAZARD_INSIDE_OFFSET
    //    retuned. Falls back to the approximation if `view.hazards` is absent
    //    (test harnesses that don't fill the field).
    if (!inGrace) {
      const hazardCenters = view.hazards;
      if (hazardCenters && hazardCenters.length > 0) {
        // Nearest-hazard check — typically only 2 hazards on the track so
        // O(N) is fine. Bias away if within (radius + 30wu) reaction band.
        for (const haz of hazardCenters) {
          const hdx = haz.center.x - self.x;
          const hdy = haz.center.y - self.y;
          const hdist = Math.hypot(hdx, hdy);
          if (hdist <= 0) continue;
          const reactionRange = haz.radius + 30;
          if (hdist >= reactionRange) continue;
          // Ahead-of-self check.
          const refX = speed > 1 ? self.vx : dx;
          const refY = speed > 1 ? self.vy : dy;
          const refMag = Math.hypot(refX, refY) || 1;
          const ahead = (hdx * refX + hdy * refY) / refMag;
          if (ahead <= 0) continue;
          dx -= (hdx / hdist) * 0.10;
          dy -= (hdy / hdist) * 0.10;
          const m4 = Math.hypot(dx, dy) || 1;
          dx /= m4;
          dy /= m4;
        }
      } else if (isHairpinTarget) {
        // Legacy approximation path — only fires when view.hazards is absent
        // (test harnesses). Same numbers as before the M4 fix.
        const hzX = target.center.x + target.normal.x * APEX_INSIDE_OFFSET * 0.73;
        const hzY = target.center.y + target.normal.y * APEX_INSIDE_OFFSET * 0.73;
        const hdx = hzX - self.x;
        const hdy = hzY - self.y;
        const hdist = Math.hypot(hdx, hdy);
        if (hdist > 0 && hdist < 60) {
          const refX = speed > 1 ? self.vx : dx;
          const refY = speed > 1 ? self.vy : dy;
          const refMag = Math.hypot(refX, refY) || 1;
          const ahead = (hdx * refX + hdy * refY) / refMag;
          if (ahead > 0) {
            dx -= (hdx / hdist) * 0.10;
            dy -= (hdy / hdist) * 0.10;
            const m4 = Math.hypot(dx, dy) || 1;
            dx /= m4;
            dy /= m4;
          }
        }
      }
    }

    // Power-up usage + drift attempts — both skipped during grace.
    let actionBits = 0;
    if (!inGrace) {
      // Phase 1 — drift decision. Only attempt to start a fresh drift on
      // hairpin entries (heading misaligned + still far from the apex).
      if (!this.driftActive && dot < 0.5 && distToTarget > 200) {
        if (Math.random() < BOT_DRIFT_TRIGGER_PER_SEC / REEF_TICK_HZ) {
          this.driftActive    = true;
          this.driftStartedMs = view.now;
          // Pick a target spark tier — heavier weight on tier 1 / 2 so
          // the bot doesn't always commit to a full hairpin.
          const r = Math.random();
          this.driftTargetTicks =
            r < 0.5
              ? DRIFT_SPARK_TICK_1
              : r < 0.85
                ? DRIFT_SPARK_TICK_2
                : DRIFT_SPARK_TICK_3;
        }
      }
      if (this.driftActive) actionBits |= ACTION_BIT_DRIFT;

      // Phase 2 — placement-aware power-up fire chance. 1st = defensive
      // (hold), 8th = aggressive (fire fast). Mid = linear interp from 0.30
      // (1st) to 0.45 (8th). Falls back to POWERUP_USE_CHANCE when placement
      // is unknown (very first tick of fresh room).
      const ownPlacement = this.getOwnPlacement(view);
      const useChance =
        ownPlacement === null
          ? POWERUP_USE_CHANCE
          : ownPlacement <= 1
            ? 0.30
            : ownPlacement >= 8
              ? 0.45
              : 0.30 + (ownPlacement - 1) * (0.15 / 7);

      const queuedItem = self.inventory[0];
      if (
        queuedItem?.kind !== null &&
        queuedItem.cooldownUntil <= view.now &&
        Math.random() < useChance
      ) {
        actionBits |= ACTION_BIT_POWERUP_0;
      }
    }

    return {
      dir: { x: dx, y: dy },
      thrust: inGrace ? 0.4 : thrust,
      actionBits,
    };
  }

  /**
   * Phase 2 — find the best draft target: nearest body within
   * SLIPSTREAM_MAX_DISTANCE * 1.5 of self that is AHEAD on velocity vector
   * (or on the dir vector if speed is too small) and within ±30° of the
   * heading. Returns null if no valid target.
   */
  private pickDraftTarget(
    view: ReefBotRoomView,
    self: ReefBotBody,
  ): ReefBotBody | null {
    const speed = Math.hypot(self.vx, self.vy);
    let refX = self.vx;
    let refY = self.vy;
    let refMag = speed;
    if (speed < 1) {
      // No usable velocity — fall back to "in front" along self.rot.
      refX = Math.cos(self.rot);
      refY = Math.sin(self.rot);
      refMag = 1;
    }
    const maxDist = SLIPSTREAM_MAX_DISTANCE * 1.5; // 75 wu
    let best: ReefBotBody | null = null;
    let bestDist = Infinity;
    for (const other of view.bodies) {
      if (other.avatarId === self.avatarId) continue;
      if (!other.alive) continue;
      if (other.dnf === true) continue;
      if (other.finishedAt != null) continue;
      const dx = other.x - self.x;
      const dy = other.y - self.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= 0 || dist > maxDist) continue;
      // Ahead check: cos(angle) ≥ cos(30°) = 0.866.
      const cosAngle = (dx * refX + dy * refY) / (dist * refMag);
      if (cosAngle < 0.866) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = other;
      }
    }
    return best;
  }

  /**
   * Phase 2 — own placement projection from the per-body view. Returns null
   * when the placement cache hasn't been populated yet (very first tick of
   * a fresh room). One-liner via the projected `currentPlacement` field
   * added by `buildBotRoomView` (audit C1 + S10 fix).
   */
  private getOwnPlacement(view: ReefBotRoomView): number | null {
    const self = view.bodies.find((b) => b.avatarId === this.avatarId);
    return self?.currentPlacement ?? null;
  }

  /**
   * Phase 2 (impl-audit S6) — find the nearest boost ribbon worth steering
   * toward. A ribbon counts when its closest segment-point is:
   *
   *   1. within `BOT_RIBBON_LOOKAHEAD_WU` of self,
   *   2. in the bot's forward cone (cos(angle) ≥ `BOT_RIBBON_FORWARD_COS`),
   *      where forward is the current dir vector (post-draft, post-apex —
   *      already biased toward the next checkpoint),
   *   3. on the same side as forward motion (positive dot vs ref vector).
   *
   * Returns `{x, y}` of the closest segment-point on the chosen ribbon, or
   * `null` if no ribbon qualifies. We intentionally aim at the segment-
   * closest-point, not the segment midpoint, so a bot already centered on
   * a ribbon doesn't oscillate left-right toward a fixed midpoint.
   */
  private pickRibbonTarget(
    view: ReefBotRoomView,
    self: ReefBotBody,
    forwardDx: number,
    forwardDy: number,
  ): { x: number; y: number } | null {
    if (!view.ribbons || view.ribbons.length === 0) return null;
    const fmag = Math.hypot(forwardDx, forwardDy) || 1;
    let best: { x: number; y: number; dist: number } | null = null;
    for (const r of view.ribbons) {
      // Project self onto segment a→b, clamp t to [0, 1] for closest-point.
      const sx = r.b.x - r.a.x;
      const sy = r.b.y - r.a.y;
      const segLenSq = sx * sx + sy * sy;
      if (segLenSq <= 0) continue;
      const px = self.x - r.a.x;
      const py = self.y - r.a.y;
      let t = (px * sx + py * sy) / segLenSq;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cx = r.a.x + sx * t;
      const cy = r.a.y + sy * t;
      const ddx = cx - self.x;
      const ddy = cy - self.y;
      const dist = Math.hypot(ddx, ddy);
      if (dist <= 0 || dist > BOT_RIBBON_LOOKAHEAD_WU) continue;
      // Forward-cone check vs current dir (already biased toward checkpoint).
      const cosAngle = (ddx * forwardDx + ddy * forwardDy) / (dist * fmag);
      if (cosAngle < BOT_RIBBON_FORWARD_COS) continue;
      if (!best || dist < best.dist) {
        best = { x: cx, y: cy, dist };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  // ─── v2 spline-bot path ──────────────────────────────────────────────────
  // Activated when REEF_RACE_USE_SPLINE is true. Architecture §5:
  //   - Race-line: lookahead at t+0.03 with curvature-based inside offset
  //   - Pickup deviation: only if pickup within budget
  //   - Always emit ACTION_BIT_JUMP on ramp AABB entry (Phase 2 placeholder)
  //   - DROP all drift logic; bit 2 is now ACTION_BIT_JUMP server-side
  //
  // The bot reads `self.x` (sim X) + `self.y` (sim Z, mapped from body.z by
  // the sim's buildBotRoomView). It builds a Vec2 {x, z} for the spline math.

  private computeInputSpline(
    view: ReefBotRoomView & ReefV2BotRoomView,
    self: ReefBotBody,
    _dt: number,
  ): BotInput {
    const spline = getSpline();

    // ── Find current t on the spline ──────────────────────────────────────
    // self.x is sim X; self.y is sim Z (per buildBotRoomView's protocol map).
    const closest = spline.closestPointOnSpline({ x: self.x, z: self.y });
    const tSelf = closest.t;

    // ── Lookahead target on centerline + curvature-based inside offset ────
    // CLOSED-LOOP (2026-06-22): the lookahead t WRAPS modulo 1 (was clamped to
    // 1, which collapsed the lookahead onto the seam at t≈0.99 and stalled the
    // bot at the start/finish line every lap). `% 1` keeps the target a true
    // V2_LOOKAHEAD_T ahead around the ring.
    const tLook = (tSelf + V2_LOOKAHEAD_T) % 1;
    const lookCenter = spline.centerlineAt(tLook);
    const tg0 = spline.tangentAt(tSelf);
    const tg1 = spline.tangentAt(
      (tSelf + V2_CURVATURE_SAMPLE_DT) % 1,
    );
    // Signed angular delta in XZ: positive = curve LEFT (CCW), negative = curve RIGHT.
    // dot = tg0·tg1, cross = tg0.x*tg1.z - tg0.z*tg1.x (2D cross product in XZ).
    const dotT = tg0.x * tg1.x + tg0.z * tg1.z;
    const crossT = tg0.x * tg1.z - tg0.z * tg1.x;
    const delta = Math.atan2(crossT, dotT);

    const halfW = spline.widthAt(tLook);
    let lateralOffset = 0;
    if (Math.abs(delta) > V2_CURVATURE_THRESHOLD_RAD) {
      // Magnitude bound: min(0.3 * halfW, |delta| * 200 wu)
      const mag = Math.min(
        halfW * V2_OFFSET_FRACTION_OF_HALF_WIDTH,
        Math.abs(delta) * V2_OFFSET_PER_RAD,
      );
      // Sign: positive delta = curve LEFT → offset toward LEFT (+normal),
      // negative = curve RIGHT → offset toward RIGHT (-normal). normalAt is
      // 90° CCW of tangent (= LEFT of travel).
      lateralOffset = delta > 0 ? mag : -mag;
    }

    const normalLook = spline.normalAt(tLook);
    let targetX = lookCenter.x + normalLook.x * lateralOffset;
    let targetZ = lookCenter.z + normalLook.z * lateralOffset;

    // ── Pickup deviation: scan within 3 * REEF_POWERUP_RADIUS of lookahead ─
    // Only redirect if pickup's lateral deviation from the racing line is
    // within 40% of widthAt(t). When `view.pickups` is absent (Wave 2 sim
    // hasn't populated it yet), this branch no-ops gracefully.
    const pickups = view.pickups;
    if (pickups && pickups.length > 0) {
      const lookRadius = REEF_POWERUP_RADIUS * V2_PICKUP_LOOKAHEAD_MULT;
      const lookRadiusSq = lookRadius * lookRadius;
      const deviationBudget = halfW * V2_PICKUP_DEVIATION_FRACTION;
      let bestPickup: { x: number; z: number; distSq: number } | null = null;
      for (const pk of pickups) {
        if (!pk.active) continue;
        // pk.x = sim X; pk.y = sim Z (protocol convention from sim view).
        const dx = pk.x - lookCenter.x;
        const dz = pk.y - lookCenter.z;
        const distSq = dx * dx + dz * dz;
        if (distSq > lookRadiusSq) continue;
        // Lateral deviation from racing line = |dot(offsetVec, normal)|.
        const lateral = Math.abs(dx * normalLook.x + dz * normalLook.z);
        if (lateral > deviationBudget) continue;
        if (!bestPickup || distSq < bestPickup.distSq) {
          bestPickup = { x: pk.x, z: pk.y, distSq };
        }
      }
      if (bestPickup) {
        targetX = bestPickup.x;
        targetZ = bestPickup.z;
      }
    }

    // ── Steering: dir vector from self → target ──────────────────────────
    let dx = targetX - self.x;
    let dz = targetZ - self.y; // self.y is sim Z
    const distToTarget = Math.hypot(dx, dz);
    if (distToTarget > 0) {
      dx /= distToTarget;
      dz /= distToTarget;
    } else {
      // Degenerate — face down-track tangent.
      dx = tg0.x;
      dz = tg0.z;
    }

    // Per-tick jitter for human-feeling tracking error.
    dx += (Math.random() - 0.5) * 2 * JITTER_MAGNITUDE;
    dz += (Math.random() - 0.5) * 2 * JITTER_MAGNITUDE;
    const dmag = Math.hypot(dx, dz);
    if (dmag > 0) {
      dx /= dmag;
      dz /= dmag;
    }

    // Thrust — drop on big heading mismatch (let the body swing).
    let thrust = 0.85;
    let dot = 1;
    const speed = Math.hypot(self.vx, self.vy);
    if (speed > 1) {
      const headingX = self.vx / speed;
      const headingZ = self.vy / speed;
      dot = dx * headingX + dz * headingZ;
      if (dot < 0.3) thrust = 0.6;
    }
    void dot; // currently informational; reserved for tighter cornering tuning

    // Off-track recovery — perpendicular distance from spline centerline.
    if (closest.distance > halfW * 1.5) {
      thrust = 1.0;
    }

    // Opening-grace gate (mirrors v1 behavior).
    const matchAge = view.now - view.matchStartedAt;
    const inGrace = matchAge < BOT_OPENING_GRACE_MS;

    // ── Action bits: jump + powerups (no drift) ──────────────────────────
    let actionBits = 0;

    // Ramp jump — emit ACTION_BIT_JUMP (= ACTION_BIT_DRIFT bit, semantically
    // re-purposed in v2) when forward-projected lookahead position is
    // inside any ramp AABB. Phase 1: REEF_RACE_RAMP_ZONES is empty, so this
    // branch is a no-op until Phase 2 lands ramp definitions.
    if (REEF_RACE_RAMP_ZONES.length > 0) {
      // Use the lookahead point so the bot triggers a tick before entry.
      for (const zone of REEF_RACE_RAMP_ZONES) {
        const adx = lookCenter.x - zone.centerX;
        const adz = lookCenter.z - zone.centerZ;
        if (Math.abs(adx) <= zone.halfX && Math.abs(adz) <= zone.halfZ) {
          actionBits |= ACTION_BIT_DRIFT; // = ACTION_BIT_JUMP in v2 sim
          break;
        }
      }
    }

    // Power-up usage — same probabilistic policy as v1, gated past grace.
    if (!inGrace) {
      const ownPlacement = this.getOwnPlacement(view);
      const useChance =
        ownPlacement === null
          ? POWERUP_USE_CHANCE
          : ownPlacement <= 1
            ? 0.30
            : ownPlacement >= 8
              ? 0.45
              : 0.30 + (ownPlacement - 1) * (0.15 / 7);
      const queuedItem = self.inventory[0];
      if (
        queuedItem?.kind !== null &&
        queuedItem.cooldownUntil <= view.now &&
        Math.random() < useChance
      ) {
        actionBits |= ACTION_BIT_POWERUP_0;
      }
    }

    return {
      dir: { x: dx, y: dz }, // protocol y = sim z
      thrust: inGrace ? 0.4 : thrust,
      actionBits,
    };
  }
}

export function createReefRaceBot(avatarId: string): BotController {
  return new ReefRaceBot(avatarId);
}
