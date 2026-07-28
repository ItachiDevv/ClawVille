import type { StageRequest } from './stage-store';

export interface ParkedStageNavigation<T> {
  requestId: number;
  navigation: T;
}

export function rekeyParkedNavigationForRetry<T>(
  parked: ParkedStageNavigation<T> | null,
  request: StageRequest | null,
): ParkedStageNavigation<T> | null {
  if (
    !parked ||
    !request ||
    request.retryOfRequestId === undefined ||
    parked.requestId !== request.retryOfRequestId
  ) {
    return parked;
  }
  return {
    requestId: request.requestId,
    navigation: parked.navigation,
  };
}

export function takeParkedNavigationForOpaque<T>(
  parked: ParkedStageNavigation<T> | null,
  request: StageRequest,
): {
  remaining: ParkedStageNavigation<T> | null;
  navigation: T | null;
} {
  if (
    !parked ||
    (parked.requestId !== request.requestId &&
      parked.requestId !== request.retryOfRequestId)
  ) {
    return { remaining: parked, navigation: null };
  }
  return {
    remaining: null,
    navigation: parked.navigation,
  };
}
