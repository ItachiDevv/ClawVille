/**
 * Q2 Activity Portals — Reef Race bot controller (chunk #5).
 *
 * Competitive rubber-band controllers; humans win through pads, items, and
 * clean lines. The legacy ellipse path remains byte-identical; spline policy:
 *
 *   1. Track a stable spline lane and bias toward nearby boost pads.
 *   2. Rubber-band cruise thrust against the whole-race leader.
 *   3. Spread the pack with stable per-avatar skill tiers.
 *   4. Spend banked items more aggressively while trailing.
 *   5. Preserve the centerline recovery safety net for a wedged bot.
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
  ACTION_BIT_JUMP,
  ACTION_BIT_LAUNCH,
  ACTION_BIT_POWERUP_0,
  // Phase 2 — bot heuristics
  APEX_HAIRPIN_CHECKPOINT_INDICES,
  APEX_INSIDE_OFFSET,
  SLIPSTREAM_MAX_DISTANCE,
  REEF_POWERUP_RADIUS,
  REEF_RACE_USE_SPLINE,
  buildSplineBoostPads,
  type ReefCheckpointAabb,
  type ReefBoostRibbon,
  type ReefHazardPatch,
} from '../sim/reef-race-config';
import {
  ReefSpline,
  REEF_RACE_DEFAULT_TRACK,
  reefRaceCreatureMotionAt,
  type ReefRaceCreatureMotion,
  type ReefRaceObstacleLayout,
  type ReefRaceRipCurrentLayout,
} from '@clawville/shared';

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
  /** Authoritative within-lap ARCLENGTH fraction (not raw spline t). */
  progress?: number;
  /** Spline vertical state, used only for the two-tick trick pulse. */
  airborne?: boolean;
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
// flag flips. Spline v2 keeps jump on bit 2 and ignores retired bit 4.

/** Speed-scaled lookahead in normalized arclength, never raw spline t. */
const V2_LOOKAHEAD_PROGRESS_MIN = 0.010;
const V2_LOOKAHEAD_PROGRESS_MAX = 0.020;

/**
 * Curvature sample distance in normalized arclength. The bot converts both
 * samples to raw t before reading their tangents, then computes angular delta to
 * estimate curvature. Spec: §5.
 */
const V2_MAX_LATERAL_OFFSET_WU = 120;

/** Threshold (radians) for "the curve is sharp enough to bias toward inside". */
const V2_MAX_LATERAL_FRACTION = 0.25;
const V2_CURVATURE_SAMPLE_PROGRESS = 0.008;
const V2_CURVATURE_THRESHOLD_RAD = 0.05;
const V2_CURVE_OFFSET_PER_RAD = 100;

/** Pickup detection radius multiplier. Spec: 3 * REEF_POWERUP_PICKUP_RADIUS. */
const V2_PICKUP_LOOKAHEAD_MULT = 3;

/**
 * Pickup deviation budget. Spec: bot only redirects if pickup is within
 * 40% of widthAt(t) lateral deviation from the racing line.
 */
const V2_PICKUP_DEVIATION_FRACTION = 0.4;

/** Module-scope spline built from the exact same shared v7 track as the sim. */
const BOT_SPLINE = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });
const BOT_SPLINE_BOOST_PADS = buildSplineBoostPads().map((pad) => ({
  lateralOffset: pad.lateralOffset,
  progress: BOT_SPLINE.arclengthFromT(pad.t) / BOT_SPLINE.totalArcLength,
}));

const V2_SKILL_TIERS = [
  { name: 'low', cruiseMin: .90, cruiseMax: .97, catchupMax: 1.00, obstacleSuccess: .70 },
  { name: 'mid', cruiseMin: .94, cruiseMax: 1.00, catchupMax: 1.03, obstacleSuccess: .80 },
  { name: 'top', cruiseMin: .97, cruiseMax: 1.03, catchupMax: 1.05, obstacleSuccess: .90 },
] as const;
type V2SkillTier = (typeof V2_SKILL_TIERS)[number];

function fnv1a(avatarId: string, salt = ''): number {
  let hash = 0x811c9dc5;
  const value = avatarId + salt;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function stableLaneOffset(avatarId: string): number {
  return fnv1a(avatarId) % (V2_MAX_LATERAL_OFFSET_WU * 2 + 1) - V2_MAX_LATERAL_OFFSET_WU;
}

function stableSkillTier(avatarId: string): V2SkillTier {
  return V2_SKILL_TIERS[
    fnv1a(avatarId, '#reef-skill') % V2_SKILL_TIERS.length
  ];
}

const BOT_CREATURE_MOTION: ReefRaceCreatureMotion = {
  position: { x: 0, y: 0 },
  telegraph: false,
  crossing: false,
  crossingProgress: 0,
};

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
  obstacles?: ReadonlyArray<ReefRaceObstacleLayout>;
  ripCurrents?: ReadonlyArray<ReefRaceRipCurrentLayout>;
  creatureNowMs?: number;
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

  private readonly splineLaneOffset: number;
  private readonly skillTier: V2SkillTier;
  private readonly cruiseThrust: number;
  private readonly itemUseDelayMs: number;
  private bankedItemKind: string | null = null;
  private bankedItemAtMs = 0;
  private splineWasAirborne = false;
  private splineTrickPhase: 0 | 1 | 2 | 3 = 0;
  private splineLaunchCount = 0;
  private splineTrickSide: -1 | 1 = 1;

  constructor(public readonly avatarId: string) {
    this.splineLaneOffset = stableLaneOffset(avatarId);
    this.skillTier = stableSkillTier(avatarId);
    const cruiseRoll = (fnv1a(avatarId, '#reef-cruise') % 10_001) / 10_000;
    this.cruiseThrust = this.skillTier.cruiseMin +
      (this.skillTier.cruiseMax - this.skillTier.cruiseMin) * cruiseRoll;
    this.itemUseDelayMs = 2_000 + Math.abs(this.splineLaneOffset) * 12;
  }

  computeInput(roomState: BotRoomView, dt: number): BotInput {
    const view = roomState as ReefBotRoomView;
    const self = view.bodies.find((b) => b.avatarId === this.avatarId);
    if (!self || !self.alive) {
      return { dir: { x: 0, y: 0 }, thrust: 0, actionBits: 0 };
    }

    // ─── v2 spline path — fully separate from ellipse heuristics ─────────
    // Active when REEF_RACE_USE_SPLINE is true. Bit 2 remains jump.
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
  //
  // The bot reads `self.x` (sim X) + `self.y` (sim Z, mapped from body.z by
  // the sim's buildBotRoomView). It builds a Vec2 {x, z} for the spline math.

  private computeInputSpline(
    view: ReefBotRoomView & ReefV2BotRoomView,
    self: ReefBotBody,
    _dt: number,
  ): BotInput {
    const spline = BOT_SPLINE;
    const airborne = self.airborne === true;
    if (airborne && !this.splineWasAirborne) {
      this.splineLaunchCount += 1;
      const roll = fnv1a(this.avatarId, `#reef-trick-${this.splineLaunchCount}`);
      // 60% of launches: neutral for one tick, then emit a deliberate steer
      // edge. The sim still decides whether the later landing earns a surge.
      this.splineTrickPhase = roll % 100 < 60 ? 1 : 0;
      this.splineTrickSide = (roll >>> 8) % 2 === 0 ? 1 : -1;
    } else if (!airborne) {
      this.splineTrickPhase = 0;
    }
    this.splineWasAirborne = airborne;

    // ── Find current t on the spline ──────────────────────────────────────
    // self.x is sim X; self.y is sim Z (per buildBotRoomView's protocol map).
    const fallbackClosest = self.progress === undefined
      ? spline.closestPointOnSpline({ x: self.x, z: self.y })
      : null;
    const progress = self.progress ??
      spline.arclengthFromT(fallbackClosest!.t) / spline.totalArcLength;
    const tSelf = spline.tFromArclength(progress * spline.totalArcLength);

    // ── Lookahead target on centerline + curvature-based inside offset ────
    // Wrap normalized arclength modulo one before inverse-LUT conversion.
    const speedRatio = Math.max(
      0,
      Math.min(1, Math.hypot(self.vx, self.vy) / REEF_MAX_SPEED),
    );
    const lookaheadProgress =
      V2_LOOKAHEAD_PROGRESS_MIN +
      (V2_LOOKAHEAD_PROGRESS_MAX - V2_LOOKAHEAD_PROGRESS_MIN) * speedRatio;
    const progressLook = (progress + lookaheadProgress) % 1;
    const tLook = spline.tFromArclength(progressLook * spline.totalArcLength);
    const lookCenter = spline.centerlineAt(tLook);
    const tg0 = spline.tangentAt(tSelf);
    const curveProgress = (progress + V2_CURVATURE_SAMPLE_PROGRESS) % 1;
    const tg1 = spline.tangentAt(
      spline.tFromArclength(curveProgress * spline.totalArcLength),
    );
    // Signed angular delta in XZ: positive = curve LEFT (CCW), negative = curve RIGHT.
    // dot = tg0·tg1, cross = tg0.x*tg1.z - tg0.z*tg1.x (2D cross product in XZ).
    const dotT = tg0.x * tg1.x + tg0.z * tg1.z;
    const crossT = tg0.x * tg1.z - tg0.z * tg1.x;
    const delta = Math.atan2(crossT, dotT);

    const halfW = spline.widthAt(tLook);
    let curveOffset = 0;
    if (Math.abs(delta) > V2_CURVATURE_THRESHOLD_RAD) {
      const mag = Math.min(
        V2_MAX_LATERAL_OFFSET_WU,
        Math.abs(delta) * V2_CURVE_OFFSET_PER_RAD,
      );
      // Sign: positive delta = curve LEFT → offset toward LEFT (+normal),
      // negative = curve RIGHT → offset toward RIGHT (-normal). normalAt is
      // 90° CCW of tangent (= LEFT of travel).
      curveOffset = delta > 0 ? mag : -mag;
    }
    const lateralLimit = Math.min(
      V2_MAX_LATERAL_OFFSET_WU,
      halfW * V2_MAX_LATERAL_FRACTION,
    );
    let lateralOffset = Math.max(
      -lateralLimit,
      Math.min(lateralLimit, this.splineLaneOffset + curveOffset),
    );

    let jumpForObstacle = false;
    let furnitureTarget: { x: number; z: number } | null = null;
    let nearestObstacleProgress = Number.POSITIVE_INFINITY;
    for (const obstacle of view.obstacles ?? []) {
      const forwardProgress = (obstacle.progress - progress + 1) % 1;
      if (forwardProgress < .0015 || forwardProgress > .009) continue;
      if (forwardProgress >= nearestObstacleProgress) continue;
      if (obstacle.kind === 'creature') {
        const motion = reefRaceCreatureMotionAt(
          obstacle,
          view.creatureNowMs ?? view.now,
          BOT_CREATURE_MOTION,
        );
        if (!motion.telegraph && !motion.crossing) continue;
      }
      const successRoll = (
        fnv1a(this.avatarId, `#reef-obstacle-${obstacle.id}-${self.lap ?? 0}`) % 10_000
      ) / 10_000;
      if (successRoll >= this.skillTier.obstacleSuccess) continue;
      nearestObstacleProgress = forwardProgress;
      if (obstacle.kind !== 'kelp') {
        jumpForObstacle = true;
        furnitureTarget = null;
        continue;
      }
      const obstacleT = spline.tFromArclength(obstacle.progress * spline.totalArcLength);
      const obstacleCenter = spline.centerlineAt(obstacleT);
      const obstacleNormal = spline.normalAt(obstacleT);
      const obstacleLateral =
        (obstacle.position.x - obstacleCenter.x) * obstacleNormal.x +
        (obstacle.position.y - obstacleCenter.z) * obstacleNormal.z;
      const clearance = obstacle.params.radius + 150;
      const avoidOffset = obstacleLateral >= 0
        ? obstacleLateral - clearance
        : obstacleLateral + clearance;
      furnitureTarget = {
        x: obstacleCenter.x + obstacleNormal.x * avoidOffset,
        z: obstacleCenter.z + obstacleNormal.z * avoidOffset,
      };
    }

    // Mid/top tiers commit to favorable off-line rip lanes; low tier holds the
    // shorter conventional line. Obstacle plans always take priority.
    if (!furnitureTarget && !jumpForObstacle && this.skillTier.name !== 'low') {
      let nearestRip = Number.POSITIVE_INFINITY;
      for (const rip of view.ripCurrents ?? []) {
        if (this.skillTier.name === 'mid' && rip.speedBonus < .21) continue;
        const forwardProgress = (rip.progress - progress + 1) % 1;
        if (forwardProgress < .004 || forwardProgress > .035 || forwardProgress >= nearestRip) continue;
        const entry = rip.segments[0];
        if (!entry) continue;
        nearestRip = forwardProgress;
        furnitureTarget = { x: entry.position.x, z: entry.position.y };
      }
    }

    // Pads expose raw spline t; compare only after the module-scope arclength
    // conversion, using a seam-safe forward progress delta. Full snap
    // guarantees line-up through the 170wu-half-width catch zone regardless
    // of lane.
    let seekingBoostPad = false;
    for (const pad of BOT_SPLINE_BOOST_PADS) {
      const forwardProgress = (pad.progress - progress + 1) % 1;
      if (forwardProgress < 0.004 || forwardProgress > lookaheadProgress) continue;
      lateralOffset = Math.max(
        -lateralLimit,
        Math.min(lateralLimit, pad.lateralOffset),
      );
      seekingBoostPad = true;
      break;
    }

    const normalLook = spline.normalAt(tLook);
    let targetX = lookCenter.x + normalLook.x * lateralOffset;
    let targetZ = lookCenter.z + normalLook.z * lateralOffset;
    if (furnitureTarget) {
      targetX = furnitureTarget.x;
      targetZ = furnitureTarget.z;
    }

    // ── Pickup deviation: scan within 3 * REEF_POWERUP_RADIUS of lookahead ─
    // Only redirect if pickup's lateral deviation from the racing line is
    // within 40% of widthAt(t). When `view.pickups` is absent (Wave 2 sim
    // hasn't populated it yet), this branch no-ops gracefully.
    const pickups = view.pickups;
    if (!seekingBoostPad && !furnitureTarget && pickups && pickups.length > 0) {
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

    const selfTotalProgress = (self.lap ?? 0) + progress;
    const liveProgress = view.bodies
      .filter((body) => body.alive)
      .map((body) => (body.lap ?? 0) + (body.progress ?? 0))
      .sort((a, b) => b - a);
    const leaderProgress = liveProgress[0] ?? selfTotalProgress;
    const secondProgress = liveProgress[1] ?? leaderProgress;
    const behindGap = Math.max(0, leaderProgress - selfTotalProgress);

    // Tiered cruise + rubber band. Values above 1.00 are reachable only while
    // genuinely behind; a tied/leading top bot is clamped to 1.00.
    const catchupBlend = behindGap > .004
      ? Math.min(1, (behindGap - .004) / .026)
      : 0;
    let thrust = Math.min(1, this.cruiseThrust) +
      (this.skillTier.catchupMax - Math.min(1, this.cruiseThrust)) * catchupBlend;
    if (
      selfTotalProgress >= leaderProgress &&
      leaderProgress - secondProgress > 0.020
    ) {
      thrust = 0.86;
    }
    let dot = 1;
    const speed = Math.hypot(self.vx, self.vy);
    if (speed > 1) {
      const headingX = self.vx / speed;
      const headingZ = self.vy / speed;
      dot = dx * headingX + dz * headingZ;
      if (dot < 0.3) thrust = 0.76;
    }
    void dot; // currently informational; reserved for tighter cornering tuning

    // Off-track recovery — perpendicular distance from spline centerline.
    const distanceFromCenterline = fallbackClosest?.distance ??
      spline.closestPointOnSpline({ x: self.x, z: self.y }).distance;
    if (distanceFromCenterline > halfW * 1.5) {
      thrust = 1.0;
    }

    // Opening-grace gate (mirrors v1 behavior).
    const matchAge = view.now - view.matchStartedAt;
    const inGrace = matchAge < BOT_OPENING_GRACE_MS;

    // Existing analog steering is the trick input. A neutral tick guarantees
    // a real press edge even if the bot was already carving onto the ramp.
    if (this.splineTrickPhase === 1) {
      dx = Math.sin(self.rot);
      dz = Math.cos(self.rot);
      this.splineTrickPhase = 2;
    } else if (this.splineTrickPhase === 2) {
      const trickHeading = self.rot + this.splineTrickSide * 0.24;
      dx = Math.sin(trickHeading);
      dz = Math.cos(trickHeading);
      this.splineTrickPhase = 3;
    }

    // ── Action bits: jump + powerups (no drift) ──────────────────────────
    let actionBits = 0;

    if (jumpForObstacle) actionBits |= ACTION_BIT_JUMP;

    // Ramp jump — bit 2 remains the stable jump verb.
    if (REEF_RACE_RAMP_ZONES.length > 0) {
      // Use the lookahead point so the bot triggers a tick before entry.
      for (const zone of REEF_RACE_RAMP_ZONES) {
        const adx = lookCenter.x - zone.centerX;
        const adz = lookCenter.z - zone.centerZ;
        if (Math.abs(adx) <= zone.halfX && Math.abs(adz) <= zone.halfZ) {
          actionBits |= ACTION_BIT_JUMP;
          break;
        }
      }
    }

    // Banked items remain visible for a few deterministic sim-seconds first.
    const queuedItem = self.inventory[0];
    if (queuedItem?.kind == null) {
      this.bankedItemKind = null;
      this.bankedItemAtMs = 0;
    } else if (queuedItem.kind !== this.bankedItemKind) {
      this.bankedItemKind = queuedItem.kind;
      this.bankedItemAtMs = view.now;
    } else if (!inGrace && queuedItem.cooldownUntil <= view.now) {
      const targetInRange = this.hasAggressiveItemTarget(view, self, queuedItem.kind);
      const requiredBankMs = targetInRange ? 350 : this.itemUseDelayMs;
      if (view.now - this.bankedItemAtMs < requiredBankMs) {
        // Keep the item visible very briefly even on an immediate tactical use.
      } else {
      const ownPlacement = this.getOwnPlacement(view);
      const placementUseChance =
        ownPlacement === null
          ? POWERUP_USE_CHANCE
          : ownPlacement <= 1
            ? 0.30
            : ownPlacement >= 8
              ? 0.45
              : 0.30 + (ownPlacement - 1) * (0.15 / 7);
      const useChance = Math.min(
        1,
        placementUseChance + (behindGap > 0.015 ? 0.30 : 0),
      );
      const aggressiveTurbo =
        behindGap > 0.015 && queuedItem.kind === 'rr-turbo-bubble';
      if (targetInRange || aggressiveTurbo || Math.random() < useChance) {
        actionBits |= ACTION_BIT_POWERUP_0;
        this.bankedItemAtMs = view.now;
      }
      }
    }

    return {
      dir: { x: dx, y: dz }, // protocol y = sim z
      thrust: inGrace
        ? 0.4
        : Math.max(0, Math.min(this.skillTier.catchupMax, thrust)),
      actionBits,
    };
  }

  private hasAggressiveItemTarget(
    view: ReefBotRoomView,
    self: ReefBotBody,
    kind: string,
  ): boolean {
    if (
      kind !== 'rr-seeker-jelly' && kind !== 'rr-tide-wave' &&
      kind !== 'rr-whirlpool' && kind !== 'rr-ink-slick'
    ) return false;
    const forwardX = Math.sin(self.rot);
    const forwardY = Math.cos(self.rot);
    for (const target of view.bodies) {
      if (
        target.avatarId === self.avatarId || !target.alive || target.dnf === true ||
        target.finishedAt != null
      ) continue;
      const dx = target.x - self.x;
      const dy = target.y - self.y;
      const distance = Math.hypot(dx, dy);
      const ahead = dx * forwardX + dy * forwardY;
      if (kind === 'rr-seeker-jelly' && ahead > 0 && distance <= 1_200) return true;
      if (kind === 'rr-tide-wave' && distance <= 250) return true;
      if (kind === 'rr-whirlpool' && distance <= 300) return true;
      if (kind === 'rr-ink-slick' && ahead < 0 && distance <= 260) return true;
    }
    return false;
  }
}

export function createReefRaceBot(avatarId: string): BotController {
  return new ReefRaceBot(avatarId);
}
