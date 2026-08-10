import { z } from 'zod';
import { npcSimulation } from './npc-simulation';
import { roomRegistry } from './room-registry';

/** Server-side per-session position throttle. Value unchanged: 10 Hz. */
export const POSITION_MIN_INTERVAL_MS = 100;

/** Field-for-field schema used by POST /api/world/position. */
export const worldPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  dirZ: z.number().finite(),
  activity: z.string().max(32).default('idle'),
});

export type WorldPositionPatch = z.infer<typeof worldPositionSchema>;

export interface WorldPositionSubject {
  sessionId: string;
  kind: 'human' | 'guest' | 'agent';
  userId: string | null;
}

const positionLastSeen = new Map<string, number>();

roomRegistry.subscribeTick((result) => {
  for (const sessionId of result.staleSessionsRemoved) {
    positionLastSeen.delete(sessionId);
  }
});

/**
 * Consume a shared HTTP/WS position slot. The slot is consumed on admission,
 * before caller-side parsing, preserving the existing HTTP route ordering.
 */
export function admitWorldPositionRate(
  sessionId: string,
  now: number = Date.now(),
): boolean {
  const last = positionLastSeen.get(sessionId) ?? 0;
  if (now - last < POSITION_MIN_INTERVAL_MS) return false;
  positionLastSeen.set(sessionId, now);
  return true;
}

/** Apply an already-validated pose through the existing registry semantics. */
export function applyWorldPosition(
  subject: WorldPositionSubject,
  patch: WorldPositionPatch,
): 'accepted' | 'not_in_room' {
  const player = roomRegistry.updatePosition(subject.sessionId, patch);
  if (!player) return 'not_in_room';

  // Preserve the existing 3,000 ms default by deliberately passing no TTL.
  if (subject.kind === 'human' && subject.userId) {
    npcSimulation.refreshHumanControlledOpenClawForUser(subject.userId);
  }
  return 'accepted';
}

export function forgetWorldPositionThrottle(sessionId: string): void {
  positionLastSeen.delete(sessionId);
}

export function __resetWorldPositionThrottleForTest(): void {
  positionLastSeen.clear();
}
