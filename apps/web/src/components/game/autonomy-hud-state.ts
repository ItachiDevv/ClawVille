import type { AutonomyStatusResponse, AutonomyStatusThought } from '@clawville/shared';

/** Translate the server's compact phase union into the HUD's user-facing copy. */
export function formatAutonomyPhase(
  status: AutonomyStatusResponse | undefined,
  connectionFailed: boolean,
): string {
  // A failed current poll must not leave the HUD confidently narrating the
  // prior successful payload from TanStack's cache.
  if (connectionFailed) return 'Connection interrupted…';
  if (status?.enrolled) {
    if (status.phase === 'deciding') return 'Thinking…';
    if (status.phase === 'walking') return 'Traveling';
    return `At ${status.targetLabel ?? 'destination'}`;
  }
  if (status?.enrolled === false) return 'Reconnecting…';
  return 'Connecting…';
}

/**
 * Reject TanStack data cached before this Autonomous-mode session began. This
 * prevents an earlier enrollment's phase/body from flashing during reconnect.
 */
export function selectCurrentAutonomyStatus(
  status: AutonomyStatusResponse | undefined,
  dataUpdatedAt: number,
  modeStartedAt: number | null,
): AutonomyStatusResponse | undefined {
  return modeStartedAt !== null && dataUpdatedAt >= modeStartedAt ? status : undefined;
}

/** Start elapsed time exactly once, on this session's first live enrollment. */
export function shouldStartAutonomyElapsed(
  status: AutonomyStatusResponse | undefined,
  connectionFailed: boolean,
  sessionStartedAt: number | null,
): boolean {
  return status?.enrolled === true && !connectionFailed && sessionStartedAt === null;
}

/** Arrival count is derived solely from the bounded server thought ring. */
export function countAutonomyArrivals(thoughts: AutonomyStatusThought[]): number {
  return thoughts.reduce(
    (count, thought) => (thought.type === 'arrival' ? count + 1 : count),
    0,
  );
}
