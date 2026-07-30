'use client';

export interface WorldStageNavigationRequest {
  to: '/game' | '/cove' | '/kelp';
  onMidway?: () => void;
  onExpired?: () => void;
}

export interface WorldStageNavigationSnapshot {
  readonly mounted: boolean;
  readonly handlerInstalled: boolean;
  readonly bufferedTo: '/game' | '/cove' | '/kelp' | null;
  readonly bufferedExpiresAt: number | null;
}

type WorldStageNavigationHandler = (
  request: WorldStageNavigationRequest,
) => boolean;

interface BufferedNavigation {
  request: WorldStageNavigationRequest;
  fromPathname: string;
  routeGeneration: number;
  expiresAt: number;
}

const NAVIGATION_BUFFER_TTL_MS = 5_000;

let navigationHandler: WorldStageNavigationHandler | null = null;
let bufferedNavigation: BufferedNavigation | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let installGeneration = 0;
let routeGeneration = 0;
let currentPathname = '';
let worldStageMounted = false;

function clearExpiryTimer() {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

function routeMovedSinceBuffering(entry: BufferedNavigation): boolean {
  return routeGeneration !== entry.routeGeneration;
}

function expireBufferedNavigation(now: number) {
  const entry = bufferedNavigation;
  if (!entry || entry.expiresAt > now) return;
  bufferedNavigation = null;
  clearExpiryTimer();
  if (routeMovedSinceBuffering(entry)) return;
  entry.request.onExpired?.();
}

function scheduleExpiry(entry: BufferedNavigation) {
  clearExpiryTimer();
  expiryTimer = setTimeout(() => {
    if (bufferedNavigation !== entry) return;
    expireBufferedNavigation(Date.now());
  }, Math.max(0, entry.expiresAt - Date.now()));
}

function discardOrReadBufferedNavigation(
  now: number,
): BufferedNavigation | null {
  const entry = bufferedNavigation;
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    expireBufferedNavigation(now);
    return null;
  }
  if (routeMovedSinceBuffering(entry)) {
    bufferedNavigation = null;
    clearExpiryTimer();
    return null;
  }
  return entry;
}

export function markWorldStageMounted(): void {
  worldStageMounted = true;
}

export function markWorldStageUnmounted(): void {
  worldStageMounted = false;
}

export function isWorldStageMounted(): boolean {
  return worldStageMounted;
}

export function readWorldStageNavigationSnapshot(): WorldStageNavigationSnapshot {
  return {
    mounted: worldStageMounted,
    handlerInstalled: navigationHandler !== null,
    bufferedTo: bufferedNavigation?.request.to ?? null,
    bufferedExpiresAt: bufferedNavigation?.expiresAt ?? null,
  };
}

export function advanceWorldStageRoute(
  pathname: string,
): number {
  currentPathname = pathname;
  routeGeneration += 1;
  return routeGeneration;
}

export function installWorldStageNavigationHandler(
  handler: WorldStageNavigationHandler,
): () => void {
  installGeneration += 1;
  const installedGeneration = installGeneration;
  navigationHandler = handler;

  queueMicrotask(() => {
    if (
      navigationHandler !== handler ||
      installGeneration !== installedGeneration
    ) {
      return;
    }
    const entry = discardOrReadBufferedNavigation(Date.now());
    if (!entry) return;
    if (handler(entry.request)) {
      bufferedNavigation = null;
      clearExpiryTimer();
    }
  });

  return () => {
    if (navigationHandler === handler) {
      navigationHandler = null;
    }
  };
}

/**
 * Routes an in-group world crossing through the persistent stage.
 *
 * `true` means the stage durably owns the request: the installed handler
 * accepted it, or the mounted stage buffered it until install/expiry.
 * Outside the `(world)` layout this returns false so legacy callers retain
 * their route-isolated transition fallback.
 */
export function requestWorldStageNavigation(
  request: WorldStageNavigationRequest,
): boolean {
  if (navigationHandler) {
    return navigationHandler(request);
  }
  if (!worldStageMounted) {
    return false;
  }

  const now = Date.now();
  const entry: BufferedNavigation = {
    request,
    fromPathname:
      currentPathname ||
      (typeof window !== 'undefined' ? window.location.pathname : ''),
    routeGeneration,
    expiresAt: now + NAVIGATION_BUFFER_TTL_MS,
  };
  bufferedNavigation = entry;
  scheduleExpiry(entry);
  if (process.env.NODE_ENV !== 'production') {
    console.warn('[world-stage] navigation buffered before handler install', {
      from: entry.fromPathname,
      to: request.to,
    });
  }
  return true;
}

export function resetWorldStageNavigationForTests(): void {
  navigationHandler = null;
  bufferedNavigation = null;
  clearExpiryTimer();
  installGeneration = 0;
  routeGeneration = 0;
  currentPathname = '';
  worldStageMounted = false;
}
