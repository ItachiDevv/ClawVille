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
 * Stateless beyond petId — chunk #10 pattern.
 */

import type { BotController, BotInput, BotRoomView } from './bot-controller';
import {
  REEF_TRACK_HALF_WIDTH,
  REEF_TICK_HZ,
  REEF_TICK_MS,
  DRIFT_SPARK_TICK_1,
  DRIFT_SPARK_TICK_2,
  DRIFT_SPARK_TICK_3,
  ACTION_BIT_DRIFT,
  ACTION_BIT_LAUNCH,
  // Phase 2 — bot heuristics
  APEX_HAIRPIN_CHECKPOINT_INDICES,
  APEX_INSIDE_OFFSET,
  SLIPSTREAM_MAX_DISTANCE,
  type ReefCheckpointAabb,
} from '../sim/reef-race-config';

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
 * a drift roughly twice per typical 36s lap.
 */
const BOT_DRIFT_TRIGGER_PER_SEC = 0.60;

/**
 * Phase 2 — per-body race-progress projection appended by the sim's
 * `buildBotRoomView`. The bot can compute drafting / placement-fire
 * heuristics without re-deriving the same data on every tick.
 */
interface ReefBotBody {
  petId: string;
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
}

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

  constructor(public readonly petId: string) {}

  computeInput(roomState: BotRoomView, _dt: number): BotInput {
    const view = roomState as ReefBotRoomView;
    const self = view.bodies.find((b) => b.petId === this.petId);
    if (!self || !self.alive) {
      return { dir: { x: 0, y: 0 }, thrust: 0, actionBits: 0 };
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

    // ── Phase 2 — hazard avoidance: bias AWAY from hazard centers ahead.
    //    Hazards are colocated near hairpin apex inside lines, so bots that
    //    take the inside line will naturally clip them — opt out via this
    //    cheap proximity check. We can't see hazards through the view today
    //    (server doesn't project them onto BotRoomView), so we approximate
    //    by treating the hairpin "inside line" itself as the hazard center
    //    when the target is a hairpin. Same heuristic as resolveHazards.
    if (!inGrace && isHairpinTarget) {
      const hzX = target.center.x + target.normal.x * APEX_INSIDE_OFFSET * 0.73; // ~60wu inside
      const hzY = target.center.y + target.normal.y * APEX_INSIDE_OFFSET * 0.73;
      const hdx = hzX - self.x;
      const hdy = hzY - self.y;
      const hdist = Math.hypot(hdx, hdy);
      if (hdist > 0 && hdist < 60) {
        // Ahead-of-self check: positive dot vs self velocity (or vs dir if
        // velocity is too small).
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

      const inv = self.inventory;
      for (let i = 0; i < inv.length; i++) {
        const slot = inv[i];
        if (slot.kind === null) continue;
        if (slot.cooldownUntil > view.now) continue;
        if (Math.random() < useChance) {
          actionBits |= 1 << i;
          break;
        }
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
      if (other.petId === self.petId) continue;
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
    const self = view.bodies.find((b) => b.petId === this.petId);
    return self?.currentPlacement ?? null;
  }
}

export function createReefRaceBot(petId: string): BotController {
  return new ReefRaceBot(petId);
}
