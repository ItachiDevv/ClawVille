/**
 * Phase 3 — Reef Race racing-profile loader.
 *
 * Fetches `avatars.level + avatars.archetype` for human/agent participants of a
 * room so the sim can stamp per-body multipliers at startRoom. Bots are
 * always neutral by design (Phase 3 §6) — they short-circuit with
 * `isBot: true` so `buildBodyMultipliers` returns a neutral clone.
 *
 * Called from `liveTransitionFn` (now async after audit C2 fix) BEFORE
 * `reefRaceSim.startRoom(...)` so the sim's first tick has correct mults
 * — no async IIFE, no tick-0 race condition.
 *
 * Performance: 1 query × ≤8 avatarIds × ~5 matches/min/region = trivial.
 * Wrapped in try/catch — DB outage falls back to all-neutral so the race
 * still runs (no black-hole start).
 *
 * Spec: `.claude/plans/reef-race-phase3-detailed.md` §3a.
 */

import { db, avatars } from '@clawville/database';
import { inArray } from 'drizzle-orm';
import type { AvatarRacingProfile } from './sim/reef-race-config';

/**
 * Fetch racing profiles for the human/agent participants of a room.
 *
 * - `humanAvatarIds` — avatar ids whose `avatars.level + avatars.archetype` we read.
 * - `botAvatarIds`   — avatar ids that ALWAYS get a neutral profile (no DB read).
 *
 * Returns a Map keyed by avatarId. Any humanAvatarId not returned by the SELECT
 * gets a neutral fallback (a missing row at LIVE-time is a bug elsewhere
 * but the sim must not fail because of it).
 *
 * On DB error: every passed avatarId gets a neutral profile so the race
 * still proceeds. The error is logged so the on-call surfaces it.
 */
export async function loadRacingProfiles(
  humanAvatarIds: string[],
  botAvatarIds: string[],
): Promise<Map<string, AvatarRacingProfile>> {
  const out = new Map<string, AvatarRacingProfile>();

  // Bots — always neutral.
  for (const avatarId of botAvatarIds) {
    out.set(avatarId, { avatarId, level: 1, archetype: null, isBot: true });
  }

  if (humanAvatarIds.length === 0) return out;

  try {
    const rows = await db
      .select({
        id: avatars.id,
        level: avatars.level,
        archetype: avatars.archetype,
      })
      .from(avatars)
      .where(inArray(avatars.id, humanAvatarIds));

    for (const row of rows) {
      out.set(row.id, {
        avatarId: row.id,
        level: typeof row.level === 'number' ? row.level : 1,
        archetype: row.archetype ?? null,
        isBot: false,
      });
    }

    // Any humanAvatarId NOT returned → neutral fallback.
    for (const avatarId of humanAvatarIds) {
      if (!out.has(avatarId)) {
        out.set(avatarId, { avatarId, level: 1, archetype: null, isBot: false });
      }
    }
  } catch (err) {
    console.error(
      '[avatar-profile-loader] DB fetch failed, defaulting all humans to neutral:',
      err,
    );
    for (const avatarId of humanAvatarIds) {
      out.set(avatarId, { avatarId, level: 1, archetype: null, isBot: false });
    }
  }

  return out;
}

/**
 * SPEC 1 — Fetch per-avatar display metadata (modelKey) for Reef Race rooms.
 *
 * - humanAvatarIds: real avatars; read from DB.
 * - botAvatarIds: synthetic bots; always get { modelKey: 'lobster' }.
 *
 * Any avatarId not returned by the SELECT gets { modelKey: 'lobster' } as a
 * safe fallback. DB failure falls back all avatarIds to 'lobster' so the race
 * still renders (wrong model is better than a broken page).
 */
export async function loadParticipantMeta(
  humanAvatarIds: string[],
  botAvatarIds: string[],
): Promise<Record<string, { modelKey: string }>> {
  const out: Record<string, { modelKey: string }> = {};

  // Bots always render as lobster.
  for (const avatarId of botAvatarIds) {
    out[avatarId] = { modelKey: 'lobster' };
  }

  if (humanAvatarIds.length === 0) return out;

  try {
    const rows = await db
      .select({ id: avatars.id, modelKey: avatars.modelKey })
      .from(avatars)
      .where(inArray(avatars.id, humanAvatarIds));

    for (const row of rows) {
      out[row.id] = { modelKey: row.modelKey ?? 'lobster' };
    }

    // Fill any avatarId the DB didn't return (deleted avatar, edge case).
    for (const avatarId of humanAvatarIds) {
      if (!out[avatarId]) out[avatarId] = { modelKey: 'lobster' };
    }
  } catch (err) {
    console.error('[loadParticipantMeta] DB error, falling back to lobster:', err);
    for (const avatarId of humanAvatarIds) {
      out[avatarId] = { modelKey: 'lobster' };
    }
  }

  return out;
}
