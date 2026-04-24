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
import { REEF_TRACK_HALF_WIDTH, type ReefCheckpointAabb } from '../sim/reef-race-config';

const POWERUP_USE_CHANCE = 0.3;
const JITTER_MAGNITUDE = 0.08;

/**
 * Extension of the generic `BotRoomView` with Reef-specific fields the
 * sim's `buildBotRoomView` injects. The Bumper bot doesn't read these,
 * and the Reef bot doesn't read Bumper's arenaRadius — both fields are
 * present in the shared shape for forward-compat.
 */
interface ReefBotRoomView extends BotRoomView {
  nextCheckpoint?: number;
  checkpoints?: ReefCheckpointAabb[];
}

class ReefRaceBot implements BotController {
  readonly activityId = 'reef-race';

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
    const speed = Math.hypot(self.vx, self.vy);
    if (speed > 1) {
      const headingX = self.vx / speed;
      const headingY = self.vy / speed;
      const dot = dx * headingX + dy * headingY;
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

    // Power-up usage — fire any off-cooldown slot at the configured probability.
    let actionBits = 0;
    const inv = self.inventory;
    for (let i = 0; i < inv.length; i++) {
      const slot = inv[i];
      if (slot.kind === null) continue;
      if (slot.cooldownUntil > view.now) continue;
      if (Math.random() < POWERUP_USE_CHANCE) {
        actionBits |= 1 << i;
        break;
      }
    }

    return {
      dir: { x: dx, y: dy },
      thrust,
      actionBits,
    };
  }
}

export function createReefRaceBot(petId: string): BotController {
  return new ReefRaceBot(petId);
}
