/**
 * Pure movement + activity transition helpers.
 *
 * These are extracted from the original PetAutonomyManager and remain
 * pure functions (no LLM, no DB, no async). Called from the bridge
 * tick every 500ms for all autonomous pets.
 *
 * Decision-making (what building to walk to next) is the only piece
 * that goes through the LLM — see simulation-runtime.planPetAction().
 */

import type { PetStateStore, PetSimState } from './pet-state-store';
import type { ActivityEmojis } from './types';

const MAP_WIDTH = 2560;
const MAP_HEIGHT = 2560;
const STEP_SIZE = 10;
const IDLE_THRESHOLD_MS = 60_000; // 60s of no user input

/**
 * Activate autonomous mode for any pet that has been idle past the
 * threshold. Returns the list of pets that just became autonomous
 * (useful for triggering an initial plan).
 */
export function activateIdlePets(stateStore: PetStateStore, now: number): PetSimState[] {
  const newlyActive: PetSimState[] = [];
  for (const pet of stateStore.all()) {
    if (pet.isAutonomous) continue;
    if (now - pet.lastUserInputAt >= IDLE_THRESHOLD_MS) {
      pet.isAutonomous = true;
      pet.activity = 'idle';
      pet.behaviorCooldown = 5;
      pet.tokensEarned = 0;
      pet.visitCount = 0;
      newlyActive.push(pet);
    }
  }
  return newlyActive;
}

/**
 * Advance a pet one step along its path. Pure — no external state.
 */
export function stepMovement(pet: PetSimState): void {
  if (pet.activity !== 'walking') return;
  if (pet.path.length === 0 || pet.pathIndex >= pet.path.length) return;

  const wp = pet.path[pet.pathIndex];
  const dx = wp.x - pet.x;
  const dy = wp.y - pet.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 4) {
    pet.pathIndex++;
    if (pet.pathIndex >= pet.path.length) pet.direction = 'idle';
  } else {
    const s = Math.min(STEP_SIZE, dist);
    pet.x += (dx / dist) * s;
    pet.y += (dy / dist) * s;
    pet.x = Math.max(16, Math.min(MAP_WIDTH - 16, pet.x));
    pet.y = Math.max(16, Math.min(MAP_HEIGHT - 16, pet.y));
    pet.direction =
      Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
  }
}

/**
 * Handle activity expiration + post-arrival state transitions.
 *
 * Returns 'arrived' when the pet just finished walking to a building
 * (caller should dispatch PET_VISIT_BUILDING), 'expired' when an
 * activity timer just ran out (caller should plan next step), or
 * null when nothing notable happened.
 */
export type ActivityTransition = 'arrived' | 'expired' | 'home' | null;

export function handleActivityTransition(
  pet: PetSimState,
  now: number,
  activityEmojis: ActivityEmojis,
): ActivityTransition {
  // Arrived at destination
  if (
    pet.activity === 'walking' &&
    pet.path.length > 0 &&
    pet.pathIndex >= pet.path.length
  ) {
    if (pet.destinationBuildingId) {
      // Arrived at a building — caller will dispatch PET_VISIT_BUILDING
      return 'arrived';
    }
    // Arrived at home (destinationBuildingId === null means going home)
    return 'home';
  }

  // Activity timer expired
  if (pet.activityEndsAt > 0 && now >= pet.activityEndsAt) {
    pet.activity = 'idle';
    pet.activityEmoji = '';
    pet.activityEndsAt = 0;
    pet.destinationBuildingId = null;
    pet.behaviorCooldown = 5;
    pet.chatMessage = null;
    return 'expired';
  }

  // Suppress TS "unused parameter" warning when emojis aren't needed on a branch
  void activityEmojis;
  return null;
}
