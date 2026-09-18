import { describe, expect, test } from 'bun:test';
import {
  COVE_AUTO_ENTER_MAX_X,
  COVE_EXIT_WORLD_X,
  COVE_EXIT_WORLD_Z,
  isCoveProximate,
  isInsideCoveTunnel,
} from './character-positions';

// Regression (founder-reported 2026-09-18): leaving the cove dropped the avatar
// "in the middle of the building", and any movement re-entered the cove.
//
// Mechanism: the exit was a hand-set world X of -3760, set on 2026-06-15 before
// the tunnel, collision wall and auto-enter band existed. It sat 40 wu WEST of
// the auto-enter band [-3720, -3450]. cove-entrance.tsx re-arms its auto-enter
// guard the moment the avatar is outside the band, and walking to town means
// walking EAST, so the first step toward town crossed the band and fired the
// walk-in again. Every exit, every time.

/** The value this test replaced. Kept only to prove the test catches the bug. */
const LEGACY_EXIT_WORLD_X = -3760;

/** Does walking east (toward town) from `startX` ever enter the auto-enter band? */
function eastwardWalkEntersTunnel(startX: number, z: number): boolean {
  for (let x = startX; x <= startX + 2000; x += 5) {
    if (isInsideCoveTunnel(x, z)) return true;
  }
  return false;
}

describe('cove exit spawn', () => {
  test('lands outside the auto-enter band', () => {
    expect(isInsideCoveTunnel(COVE_EXIT_WORLD_X, COVE_EXIT_WORLD_Z)).toBe(false);
  });

  test('lands outside the entry prompt, so arrival is not nagged', () => {
    expect(isCoveProximate(COVE_EXIT_WORLD_X, COVE_EXIT_WORLD_Z)).toBe(false);
  });

  test('sits east of the auto-enter band with a real margin', () => {
    // A few wu would let a camera nudge or a stray key re-enter the cove.
    expect(COVE_EXIT_WORLD_X - COVE_AUTO_ENTER_MAX_X).toBeGreaterThanOrEqual(200);
  });

  test('walking toward town from the exit never re-enters the cove', () => {
    expect(eastwardWalkEntersTunnel(COVE_EXIT_WORLD_X, COVE_EXIT_WORLD_Z)).toBe(false);
  });

  // Proves the band-crossing check bites on the old value. It does NOT model
  // collision: the old point was ALSO inside the cove's solid AABB (east edge
  // -3586, -3561 once expanded by the player's half-width), so the real first
  // step was pushed straight to -3561, inside the band. Either way: re-entry.
  test('the legacy -3760 exit crosses the auto-enter band walking toward town', () => {
    expect(isInsideCoveTunnel(LEGACY_EXIT_WORLD_X, 0)).toBe(false); // lands just outside...
    expect(eastwardWalkEntersTunnel(LEGACY_EXIT_WORLD_X, 0)).toBe(true); // ...then walks into it
  });
});
