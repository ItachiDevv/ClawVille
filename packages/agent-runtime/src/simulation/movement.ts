/**
 * Pure movement + activity transition helpers.
 *
 * These are extracted from the original AvatarAutonomyManager and remain
 * pure functions (no LLM, no DB, no async). Called from the bridge
 * tick every 500ms for all autonomous avatars.
 *
 * Decision-making (what building to walk to next) is the only piece
 * that goes through the LLM — see simulation-runtime.planAvatarAction().
 */

import type { AvatarStateStore, AvatarSimState } from './avatar-state-store';
import type { ActivityEmojis } from './types';

// P0 (2026-07-01): 5120 → 22528 to match the CANONICAL world dimension.
// This is a LIVE path (NOT dead, contra the P0 design-doc's "dead-path" label):
// `stepMovement` below is called every bridge tick for every autonomous avatar
// (`avatar-simulation-bridge.ts` tick → npc-simulation `avatarAutonomyManager.tick()`),
// and it clamps `avatar.x/y` to `MAP_WIDTH-16`. At 5120 that pinned autonomous
// avatars to the top-left [16, 5104] box while pathfinding (`findPath`) routes them
// across the real 22528 world — so any target past ~5104 (incl. the town-center
// buildings at ~11264 game-px) was unreachable: the avatar clamped at the boundary
// and stalled (dist never < arrival threshold). Widening the clamp to the true world
// size unblocks traversal. Canonical dim: `WORLD_PX_WIDTH/HEIGHT` (packages/shared
// world-dimensions.ts) = npc-simulation `MAP_WIDTH` = 22528 (704 tiles × 32px).
const MAP_WIDTH = 22528;
const MAP_HEIGHT = 22528;
const STEP_SIZE = 10;
const IDLE_THRESHOLD_MS = 60_000; // 60s of no user input

/**
 * Activate autonomous mode for any avatar that has been idle past the
 * threshold. Returns the list of avatars that just became autonomous
 * (useful for triggering an initial plan).
 */
export function activateIdleAvatars(stateStore: AvatarStateStore, now: number): AvatarSimState[] {
  const newlyActive: AvatarSimState[] = [];
  for (const avatar of stateStore.all()) {
    if (avatar.isAutonomous) continue;
    if (now - avatar.lastUserInputAt >= IDLE_THRESHOLD_MS) {
      avatar.isAutonomous = true;
      avatar.activity = 'idle';
      avatar.behaviorCooldown = 5;
      avatar.tokensEarned = 0;
      avatar.visitCount = 0;
      newlyActive.push(avatar);
    }
  }
  return newlyActive;
}

/**
 * Advance an avatar one step along its path. Pure — no external state.
 */
export function stepMovement(avatar: AvatarSimState): void {
  if (avatar.activity !== 'walking') return;
  if (avatar.path.length === 0 || avatar.pathIndex >= avatar.path.length) return;

  const wp = avatar.path[avatar.pathIndex];
  const dx = wp.x - avatar.x;
  const dy = wp.y - avatar.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 4) {
    avatar.pathIndex++;
    if (avatar.pathIndex >= avatar.path.length) avatar.direction = 'idle';
  } else {
    const s = Math.min(STEP_SIZE, dist);
    avatar.x += (dx / dist) * s;
    avatar.y += (dy / dist) * s;
    avatar.x = Math.max(16, Math.min(MAP_WIDTH - 16, avatar.x));
    avatar.y = Math.max(16, Math.min(MAP_HEIGHT - 16, avatar.y));
    avatar.direction =
      Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
  }
}

/**
 * Handle activity expiration + post-arrival state transitions.
 *
 * Returns 'arrived' when the avatar just finished walking to a building
 * (caller should dispatch AVATAR_VISIT_BUILDING), 'expired' when an
 * activity timer just ran out (caller should plan next step), or
 * null when nothing notable happened.
 */
export type ActivityTransition = 'arrived' | 'expired' | 'home' | null;

export function handleActivityTransition(
  avatar: AvatarSimState,
  now: number,
  activityEmojis: ActivityEmojis,
): ActivityTransition {
  // Arrived at destination
  if (
    avatar.activity === 'walking' &&
    avatar.path.length > 0 &&
    avatar.pathIndex >= avatar.path.length
  ) {
    if (avatar.destinationBuildingId) {
      // Arrived at a building — caller will dispatch AVATAR_VISIT_BUILDING
      return 'arrived';
    }
    // Arrived at home (destinationBuildingId === null means going home)
    return 'home';
  }

  // Activity timer expired
  if (avatar.activityEndsAt > 0 && now >= avatar.activityEndsAt) {
    avatar.activity = 'idle';
    avatar.activityEmoji = '';
    avatar.activityEndsAt = 0;
    avatar.destinationBuildingId = null;
    avatar.behaviorCooldown = 5;
    avatar.chatMessage = null;
    return 'expired';
  }

  // Suppress TS "unused parameter" warning when emojis aren't needed on a branch
  void activityEmojis;
  return null;
}
