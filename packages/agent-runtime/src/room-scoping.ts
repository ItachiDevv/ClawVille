/**
 * Room scoping for building-character chat memory.
 *
 * Phase 6 — per-user memory isolation.
 *
 * ElizaOS stores every message in the `memories` table keyed by
 * (agentId, roomId). Before Phase 6, all visitors to a building shared the
 * same roomId (derived from the locationId), so the agent's recollection of
 * "what we talked about last time" leaked across users.
 *
 * This helper produces a deterministic UUID per (locationId, userId) pair so
 * every visitor gets their own private room with the same character. The
 * character itself (and its bio, lore, knowledge, openclaw theme) is shared —
 * only the conversation memory is partitioned.
 *
 * Stable namespace UUID — DO NOT regenerate. It was produced once and lives
 * here so room IDs are reproducible across processes and restarts. Changing
 * this constant orphans every pre-existing chat memory row.
 */

import { v5 as uuidv5 } from 'uuid';
import type { UUID } from '@elizaos/core';

/** Stable v5 namespace for ClawVille building-character rooms. */
export const CHARACTER_ROOM_NAMESPACE = '8f3b1b27-5f2a-4a8d-9c1d-2e7b4d1f6a9c';

/**
 * Deterministic per-user room ID for a building character.
 *
 * @param locationId building / location ID (e.g. `cron-automation`)
 * @param userId     viewer user ID (Lucia user.id)
 * @returns          UUID v5 that both identifies the shared character AND
 *                   isolates that user's chat memory from other users'
 */
export function characterRoomId(locationId: string, userId: string): UUID {
  return uuidv5(`${locationId}:${userId}`, CHARACTER_ROOM_NAMESPACE) as UUID;
}
