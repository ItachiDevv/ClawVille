/**
 * Q2 Activity Portals — Bumper Shells bot controller (chunk #10).
 *
 * Heuristic policy (intentionally "barely competent" — humans should win
 * sometimes; spec §8.4 calls them out as `simple heuristic controllers`):
 *
 *   1. Find the nearest alive opponent.
 *   2. Steer toward the opponent. Within ramming distance (< 80wu) AND
 *      moving toward them, push thrust to 1.0.
 *   3. If close to the arena edge (within 100wu of `arenaRadius`),
 *      override the target with a vector pointing to origin so we don't
 *      ring-out ourselves.
 *   4. If a power-up is held + off cooldown, fire it with low probability
 *      per tick (~30%) so usage is visible without being spammy.
 *   5. Apply a small random jitter to the dir vector to feel less robotic.
 *
 * No persistent per-tick state — controllers are stateless beyond the
 * avatarId so a single instance can be safely reused if the matcher ever
 * reschedules the same bot id (today: 1 controller per room, dropped
 * with `stopRoom`).
 *
 * The controller does NOT touch DB state, does NOT call applyInput
 * directly — it returns a `BotInput` and the sim's bot scheduler feeds
 * it through the same `applyInput()` validators that humans use.
 */

import type { BotController, BotInput, BotRoomView } from './bot-controller';

/** Distance under which the bot leans into the ram (wu). */
const RAM_DISTANCE = 80;
/** Buffer from arena edge — within this distance, bot turns toward origin (wu). */
const EDGE_BUFFER = 100;
/** Per-tick probability the bot fires an off-cooldown power-up (0..1). */
const POWERUP_USE_CHANCE = 0.3;
/** Magnitude of random direction jitter — small enough to look intentional. */
const JITTER_MAGNITUDE = 0.15;

class BumperShellsBot implements BotController {
  readonly activityId = 'bumper-shells';

  constructor(public readonly avatarId: string) {}

  computeInput(roomState: BotRoomView, _dt: number): BotInput {
    const self = roomState.bodies.find((b) => b.avatarId === this.avatarId);
    if (!self || !self.alive) {
      return { dir: { x: 0, y: 0 }, thrust: 0, actionBits: 0 };
    }

    // 1. Find nearest alive opponent.
    let nearest: BotRoomView['bodies'][number] | null = null;
    let nearestDistSq = Infinity;
    for (const body of roomState.bodies) {
      if (body.avatarId === this.avatarId || !body.alive) continue;
      const dx = body.x - self.x;
      const dy = body.y - self.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < nearestDistSq) {
        nearestDistSq = d2;
        nearest = body;
      }
    }

    // 2. Edge-avoidance — checked BEFORE target selection so a bot near
    //    the boundary always pulls back to center, even if the nearest
    //    opponent is also at the edge.
    const distFromOrigin = Math.hypot(self.x, self.y);
    const distToEdge = roomState.arenaRadius - distFromOrigin;

    let targetVec: { x: number; y: number };
    if (distToEdge < EDGE_BUFFER) {
      // Override — head toward origin.
      const mag = Math.max(distFromOrigin, 0.0001);
      targetVec = { x: -self.x / mag, y: -self.y / mag };
    } else if (nearest) {
      const dx = nearest.x - self.x;
      const dy = nearest.y - self.y;
      const mag = Math.max(Math.hypot(dx, dy), 0.0001);
      targetVec = { x: dx / mag, y: dy / mag };
    } else {
      // No opponents — coast toward origin to stay safe.
      const mag = Math.max(distFromOrigin, 0.0001);
      targetVec = distFromOrigin > 0 ? { x: -self.x / mag, y: -self.y / mag } : { x: 0, y: 0 };
    }

    // 3. Apply jitter — small per-tick noise so the bot doesn't track
    //    perfectly. Bias-free: ±JITTER per axis.
    targetVec = {
      x: targetVec.x + (Math.random() - 0.5) * 2 * JITTER_MAGNITUDE,
      y: targetVec.y + (Math.random() - 0.5) * 2 * JITTER_MAGNITUDE,
    };
    // Renormalize — applyInput's validator will magnitude-clamp anyway,
    // but a clean unit vector keeps the intent readable in replay logs.
    const finalMag = Math.hypot(targetVec.x, targetVec.y);
    if (finalMag > 0) {
      targetVec = { x: targetVec.x / finalMag, y: targetVec.y / finalMag };
    }

    // 4. Decide thrust. Lean in when ramming; otherwise modest cruise.
    let thrust = 0.6;
    if (nearest && distToEdge >= EDGE_BUFFER) {
      const distToTarget = Math.sqrt(nearestDistSq);
      if (distToTarget <= RAM_DISTANCE) {
        // Closing — full ram.
        thrust = 1.0;
      } else {
        thrust = 0.7;
      }
    }
    if (distToEdge < EDGE_BUFFER) {
      // Edge recovery — full pull-back.
      thrust = 1.0;
    }

    // 5. Power-up usage. Use slot 0 first, then slot 1. Honor cooldown.
    let actionBits = 0;
    const inv = self.inventory;
    for (let i = 0; i < inv.length; i++) {
      const slot = inv[i];
      if (slot.kind === null) continue;
      if (slot.cooldownUntil > roomState.now) continue;
      if (Math.random() < POWERUP_USE_CHANCE) {
        actionBits |= 1 << i;
        // Only fire one slot per tick — anti-cheat doesn't care but it
        // keeps power-up activations distinguishable in replay logs.
        break;
      }
    }

    return {
      dir: targetVec,
      thrust,
      actionBits,
    };
  }
}

export function createBumperShellsBot(avatarId: string): BotController {
  return new BumperShellsBot(avatarId);
}
