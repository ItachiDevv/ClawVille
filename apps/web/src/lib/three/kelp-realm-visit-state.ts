export const KELP_COLLECTIBLE_CLAIM_SUCCESS =
  'Collectible claimed — its true form will be revealed…';

export interface KelpRealmClaimSnapshot {
  readonly nearCenter: boolean;
  readonly centerToken: string | null;
  readonly visitedCount: number;
  readonly totalCount: number;
  readonly notice: string | null;
}

export interface KelpRealmClaimPrompt {
  readonly message: string;
  readonly canClaim: boolean;
}

const INITIAL_CLAIM_SNAPSHOT: KelpRealmClaimSnapshot = Object.freeze({
  nearCenter: false,
  centerToken: null,
  visitedCount: 0,
  totalCount: 0,
  notice: null,
});

const visited = new Set<string>();
const beaconListeners = new Set<(beaconId: string) => void>();
const claimListeners = new Set<() => void>();
let claimSnapshot = INITIAL_CLAIM_SNAPSHOT;

function replaceClaimSnapshot(next: KelpRealmClaimSnapshot): void {
  if (
    next.nearCenter === claimSnapshot.nearCenter &&
    next.centerToken === claimSnapshot.centerToken &&
    next.visitedCount === claimSnapshot.visitedCount &&
    next.totalCount === claimSnapshot.totalCount &&
    next.notice === claimSnapshot.notice
  ) return;
  claimSnapshot = Object.freeze(next);
  for (const listener of claimListeners) listener();
}

export function getKelpRealmClaimSnapshot(): KelpRealmClaimSnapshot {
  return claimSnapshot;
}

export function subscribeKelpRealmClaimState(listener: () => void): () => void {
  claimListeners.add(listener);
  return () => claimListeners.delete(listener);
}

/** Called from useFrame; allocates/notifies only when the proximity boolean changes. */
export function setKelpRealmCenterProximity(nearCenter: boolean): void {
  if (claimSnapshot.nearCenter === nearCenter) return;
  replaceClaimSnapshot({ ...claimSnapshot, nearCenter });
}

export function publishKelpRealmNotice(notice: string | null): void {
  if (claimSnapshot.notice === notice) return;
  replaceClaimSnapshot({ ...claimSnapshot, notice });
}

export function setKelpRealmBeaconTotalCount(totalCount: number): void {
  const safeTotal = Math.max(0, Math.trunc(totalCount));
  if (claimSnapshot.totalCount === safeTotal) return;
  replaceClaimSnapshot({ ...claimSnapshot, totalCount: safeTotal });
}

export function markKelpRealmBeaconVisited(
  beaconId: string,
  token?: string,
  totalCount = claimSnapshot.totalCount,
): void {
  const isNewVisit = !visited.has(beaconId);
  if (isNewVisit) {
    visited.add(beaconId);
    for (const listener of beaconListeners) listener(beaconId);
  }
  replaceClaimSnapshot({
    ...claimSnapshot,
    centerToken: beaconId === 'center' && token ? token : claimSnapshot.centerToken,
    visitedCount: visited.size,
    totalCount,
    notice: null,
  });
}

export function subscribeKelpRealmBeaconVisits(listener: (beaconId: string) => void): () => void {
  beaconListeners.add(listener);
  for (const beaconId of visited) listener(beaconId);
  return () => beaconListeners.delete(listener);
}

export function resetKelpRealmBeaconVisits(): void {
  visited.clear();
  replaceClaimSnapshot(INITIAL_CLAIM_SNAPSHOT);
}

export function deriveKelpRealmClaimPrompt(
  snapshot: KelpRealmClaimSnapshot,
  isGuest: boolean,
): KelpRealmClaimPrompt | null {
  if (!snapshot.nearCenter) return null;
  if (isGuest) {
    return {
      message: 'Sign in to claim the collectible at the center.',
      canClaim: false,
    };
  }
  if (!snapshot.centerToken) {
    return {
      message: `The pearl resists — light more beacons on the way in (${snapshot.visitedCount}/${snapshot.totalCount} lit)`,
      canClaim: false,
    };
  }
  return { message: 'Claim the collectible [E]', canClaim: true };
}

export function describeKelpVisitFailure(
  status: number,
  code?: string,
  retryAfterMs?: number,
): string {
  if (status === 429 && code === 'too_fast') {
    const seconds = Math.max(1, Math.ceil((retryAfterMs ?? 1000) / 1000));
    return `The current is still carrying you — wait ${seconds}s for the beacon to recognize the journey.`;
  }
  if (status === 401) {
    return 'Beacon progress needs a signed-in or guest session. You can still explore; sign in to claim at the center.';
  }
  if (code === 'prev_token_required') {
    return 'This beacon needs the previous beacon’s light. Return to the last lit beacon.';
  }
  if (code === 'non_adjacent_beacon') {
    return 'That beacon is not connected to your last light. Follow one of the revealed paths.';
  }
  if (code === 'invalid_token' || code === 'expired_token') {
    return 'Your beacon trail faded. Return to the entry beacon and begin the trail again.';
  }
  if (code === 'token_service_unavailable') {
    return 'The beacon lights are temporarily resting. Please try again in a moment.';
  }
  return `The beacon could not be lit (${code ?? `HTTP ${status}`}). Step away and try this path again.`;
}

export function describeKelpClaimFailure(status: number, code?: string): string {
  if (status === 401 || status === 403 || code === 'guest_not_allowed') {
    return 'Sign in to claim the collectible at the center.';
  }
  if (code === 'invalid_token' || code === 'expired_token') {
    return 'The center light faded. Re-light the beacon trail before claiming.';
  }
  if (code === 'center_token_required') {
    return 'The pearl resists — light more beacons on the way in.';
  }
  if (code === 'collectible_sku_unavailable') {
    return 'The collectible is not ready to reveal yet. The team has been alerted.';
  }
  if (code === 'token_service_unavailable') {
    return 'The claim lights are temporarily resting. Please try again in a moment.';
  }
  return `The collectible could not be claimed (${code ?? `HTTP ${status}`}). Please try again.`;
}
