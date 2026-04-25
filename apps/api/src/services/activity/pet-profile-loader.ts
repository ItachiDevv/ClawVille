/**
 * Phase 3 — Reef Race racing-profile loader.
 *
 * Fetches `pets.level + pets.archetype` for human/agent participants of a
 * room so the sim can stamp per-body multipliers at startRoom. Bots are
 * always neutral by design (Phase 3 §6) — they short-circuit with
 * `isBot: true` so `buildBodyMultipliers` returns a neutral clone.
 *
 * Called from `liveTransitionFn` (now async after audit C2 fix) BEFORE
 * `reefRaceSim.startRoom(...)` so the sim's first tick has correct mults
 * — no async IIFE, no tick-0 race condition.
 *
 * Performance: 1 query × ≤8 petIds × ~5 matches/min/region = trivial.
 * Wrapped in try/catch — DB outage falls back to all-neutral so the race
 * still runs (no black-hole start).
 *
 * Spec: `.claude/plans/reef-race-phase3-detailed.md` §3a.
 */

import { db, pets } from '@clawville/database';
import { inArray } from 'drizzle-orm';
import type { PetRacingProfile } from './sim/reef-race-config';

/**
 * Fetch racing profiles for the human/agent participants of a room.
 *
 * - `humanPetIds` — pet ids whose `pets.level + pets.archetype` we read.
 * - `botPetIds`   — pet ids that ALWAYS get a neutral profile (no DB read).
 *
 * Returns a Map keyed by petId. Any humanPetId not returned by the SELECT
 * gets a neutral fallback (a missing row at LIVE-time is a bug elsewhere
 * but the sim must not fail because of it).
 *
 * On DB error: every passed petId gets a neutral profile so the race
 * still proceeds. The error is logged so the on-call surfaces it.
 */
export async function loadRacingProfiles(
  humanPetIds: string[],
  botPetIds: string[],
): Promise<Map<string, PetRacingProfile>> {
  const out = new Map<string, PetRacingProfile>();

  // Bots — always neutral.
  for (const petId of botPetIds) {
    out.set(petId, { petId, level: 1, archetype: null, isBot: true });
  }

  if (humanPetIds.length === 0) return out;

  try {
    const rows = await db
      .select({
        id: pets.id,
        level: pets.level,
        archetype: pets.archetype,
      })
      .from(pets)
      .where(inArray(pets.id, humanPetIds));

    for (const row of rows) {
      out.set(row.id, {
        petId: row.id,
        level: typeof row.level === 'number' ? row.level : 1,
        archetype: row.archetype ?? null,
        isBot: false,
      });
    }

    // Any humanPetId NOT returned → neutral fallback.
    for (const petId of humanPetIds) {
      if (!out.has(petId)) {
        out.set(petId, { petId, level: 1, archetype: null, isBot: false });
      }
    }
  } catch (err) {
    console.error(
      '[pet-profile-loader] DB fetch failed, defaulting all humans to neutral:',
      err,
    );
    for (const petId of humanPetIds) {
      out.set(petId, { petId, level: 1, archetype: null, isBot: false });
    }
  }

  return out;
}
