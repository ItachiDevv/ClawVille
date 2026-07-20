'use client';

import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react';

import type { PowerUpSlot } from '@/stores/activity';
import { useActivityStore } from '@/stores/activity';

export type ReefRaceSurgeSource =
  | 'boost-pad'
  | 'turbo-bubble'
  | 'launch-boost'
  | 'slipstream';

interface ReefRaceSurgeSnapshot {
  sequence: number;
  source: ReefRaceSurgeSource;
  magnitude: number;
  startedAt: number;
  durationMs: number;
  color: string;
}

const IDLE_SURGE: ReefRaceSurgeSnapshot = {
  sequence: 0,
  source: 'boost-pad',
  magnitude: 0,
  startedAt: 0,
  durationMs: 1,
  color: '#7df9ff',
};

let surgeSnapshot = IDLE_SURGE;
let turboBubbleActiveUntil = 0;
const surgeListeners = new Set<() => void>();

const SOURCE_COLOR: Record<ReefRaceSurgeSource, string> = {
  'boost-pad': '#55eeff',
  'turbo-bubble': '#ffe45e',
  'launch-boost': '#7cffcb',
  slipstream: '#b78cff',
};

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function triggerReefRaceSurge(
  source: ReefRaceSurgeSource,
  magnitude: number,
  durationMs = 700,
): void {
  const now = performance.now();
  const activeStrength = sampleReefRaceSurge(now);
  const nextMagnitude = Math.max(clamp01(magnitude), activeStrength);
  surgeSnapshot = {
    sequence: surgeSnapshot.sequence + 1,
    source,
    magnitude: nextMagnitude,
    startedAt: now,
    durationMs: Math.max(1, durationMs),
    color: SOURCE_COLOR[source],
  };
  surgeListeners.forEach((listener) => listener());
}

export function resetReefRaceSurge(): void {
  if (surgeSnapshot === IDLE_SURGE && turboBubbleActiveUntil === 0) return;
  surgeSnapshot = IDLE_SURGE;
  turboBubbleActiveUntil = 0;
  surgeListeners.forEach((listener) => listener());
}

export function isReefRaceTurboBubbleActive(now: number): boolean {
  return now < turboBubbleActiveUntil;
}

export function getReefRaceSurgeSnapshot(): ReefRaceSurgeSnapshot {
  return surgeSnapshot;
}

export function subscribeReefRaceSurge(listener: () => void): () => void {
  surgeListeners.add(listener);
  return () => surgeListeners.delete(listener);
}

/**
 * Allocation-free visual envelope. The cubic ease-out decay gives the camera
 * an immediate punch and returns it to baseline within the source duration.
 */
export function sampleReefRaceSurge(now: number): number {
  const elapsed = now - surgeSnapshot.startedAt;
  if (elapsed < 0 || elapsed >= surgeSnapshot.durationMs) return 0;
  const remaining = 1 - elapsed / surgeSnapshot.durationMs;
  return surgeSnapshot.magnitude * remaining * remaining * remaining;
}

function chargeTotal(inventory: readonly PowerUpSlot[], kind: string): number {
  let total = 0;
  for (let index = 0; index < inventory.length; index++) {
    const slot = inventory[index];
    if (slot?.kind === kind) total += Math.max(0, slot.charges ?? 0);
  }
  return total;
}

/**
 * Returns the item whose total authoritative charge count decreased. Comparing
 * the whole two-slot inventory is promotion-safe: [bubble, ink] -> [ink, empty]
 * reports bubble, never the queued ink that merely moved into slot zero.
 */
export function findConsumedReefRaceItemKind(
  previous: readonly PowerUpSlot[],
  current: readonly PowerUpSlot[],
): string | null {
  for (let index = 0; index < previous.length; index++) {
    const kind = previous[index]?.kind;
    if (!kind) continue;
    let seenEarlier = false;
    for (let prior = 0; prior < index; prior++) {
      if (previous[prior]?.kind === kind) {
        seenEarlier = true;
        break;
      }
    }
    if (!seenEarlier && chargeTotal(current, kind) < chargeTotal(previous, kind)) {
      return kind;
    }
  }
  return null;
}

export function findCollectedReefRaceItemKind(
  previous: readonly PowerUpSlot[],
  current: readonly PowerUpSlot[],
): string | null {
  for (let index = 0; index < current.length; index++) {
    const kind = current[index]?.kind;
    if (!kind) continue;
    let seenEarlier = false;
    for (let prior = 0; prior < index; prior++) {
      if (current[prior]?.kind === kind) {
        seenEarlier = true;
        break;
      }
    }
    if (!seenEarlier && chargeTotal(current, kind) > chargeTotal(previous, kind)) {
      return kind;
    }
  }
  return null;
}

/** Connects authoritative self-only activity edges to the shared controller. */
export function ReefRaceSurgeDriver({ roomId }: { roomId: string }) {
  const selfAvatarId = useActivityStore((state) => state.selfAvatarId);
  const lastBoostPadEvent = useActivityStore((state) => state.lastBoostPadEvent);
  const lastLaunchEvent = useActivityStore((state) => state.lastLaunchEvent);
  const slipstreamActive = useActivityStore((state) => state.slipstreamActive);
  const powerUpInventory = useActivityStore((state) => state.powerUpInventory);
  const selfRacingClass = useActivityStore((state) => state.selfRacingClass);

  const seenBoostPadAt = useRef(0);
  const seenLaunchAt = useRef(0);
  const slipstreamWasActive = useRef(false);
  const previousInventory = useRef<readonly PowerUpSlot[] | null>(null);

  useEffect(() => {
    resetReefRaceSurge();
    seenBoostPadAt.current = 0;
    seenLaunchAt.current = 0;
    slipstreamWasActive.current = false;
    previousInventory.current = null;
    return resetReefRaceSurge;
  }, [roomId]);

  useEffect(() => {
    if (
      !lastBoostPadEvent ||
      lastBoostPadEvent.avatarId !== selfAvatarId ||
      lastBoostPadEvent.at === seenBoostPadAt.current
    ) return;
    seenBoostPadAt.current = lastBoostPadEvent.at;
    // The camera/overlay envelope matches the authoritative 2.2s pad boost.
    // A slightly lower peak keeps the longer FOV tail readable rather than harsh.
    triggerReefRaceSurge('boost-pad', 0.7, 2_200);
  }, [lastBoostPadEvent, selfAvatarId]);

  useEffect(() => {
    if (
      !lastLaunchEvent ||
      lastLaunchEvent.avatarId !== selfAvatarId ||
      lastLaunchEvent.kind !== 'boost' ||
      lastLaunchEvent.at === seenLaunchAt.current
    ) return;
    seenLaunchAt.current = lastLaunchEvent.at;
    triggerReefRaceSurge('launch-boost', 1, 800);
  }, [lastLaunchEvent, selfAvatarId]);

  useEffect(() => {
    if (slipstreamActive && !slipstreamWasActive.current) {
      triggerReefRaceSurge('slipstream', 0.58, 640);
    }
    slipstreamWasActive.current = slipstreamActive;
  }, [slipstreamActive]);

  useEffect(() => {
    const previous = previousInventory.current;
    previousInventory.current = powerUpInventory;
    if (previous === null) return;
    const consumedKind = findConsumedReefRaceItemKind(previous, powerUpInventory);
    if (consumedKind === 'rr-turbo-bubble') {
      // Server class multiplier is 1.2 for Intelligence, neutral for all other
      // profiles. This local deadline drives presentation only; authority and
      // actual speed remain server-owned.
      turboBubbleActiveUntil = performance.now() +
        (selfRacingClass === 'intelligence' ? 3_000 : 2_500);
      triggerReefRaceSurge('turbo-bubble', 0.68, 2_500);
    }
  }, [powerUpInventory, selfRacingClass]);

  return null;
}

export function useReefRaceSurgeSnapshot(): ReefRaceSurgeSnapshot {
  return useSyncExternalStore(
    subscribeReefRaceSurge,
    getReefRaceSurgeSnapshot,
    getReefRaceSurgeSnapshot,
  );
}

/** One cheap DOM layer; RAF runs only while a surge envelope is visible. */
export function ReefRaceSpeedLinesOverlay() {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let reducedMotionTimer = 0;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const tick = (now: number) => {
      frame = 0;
      const element = overlayRef.current;
      if (!element) return;
      const strength = sampleReefRaceSurge(now);
      element.style.opacity = `${Math.min(0.72, strength * 0.72)}`;
      if (!reducedMotion) {
        element.style.transform = `scale(${1 + strength * 0.055})`;
      }
      if (strength > 0.002) frame = requestAnimationFrame(tick);
    };

    const begin = () => {
      const element = overlayRef.current;
      if (element) {
        const snapshot = getReefRaceSurgeSnapshot();
        element.style.setProperty('--reef-surge-color', snapshot.color);
        if (reducedMotion) {
          element.style.opacity = `${Math.min(0.34, snapshot.magnitude * 0.34)}`;
          element.style.transform = 'scale(1)';
          if (reducedMotionTimer !== 0) window.clearTimeout(reducedMotionTimer);
          reducedMotionTimer = window.setTimeout(() => {
            if (overlayRef.current) overlayRef.current.style.opacity = '0';
          }, snapshot.durationMs);
          return;
        }
      }
      if (frame === 0) frame = requestAnimationFrame(tick);
    };

    const unsubscribe = subscribeReefRaceSurge(begin);
    return () => {
      unsubscribe();
      if (frame !== 0) cancelAnimationFrame(frame);
      if (reducedMotionTimer !== 0) window.clearTimeout(reducedMotionTimer);
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      aria-hidden="true"
      style={{
        '--reef-surge-color': '#7df9ff',
        position: 'absolute',
        inset: '-7%',
        zIndex: 1,
        pointerEvents: 'none',
        opacity: 0,
        transform: 'scale(1)',
        transformOrigin: '50% 50%',
        background:
          'repeating-conic-gradient(from 0deg at 50% 50%, transparent 0deg 4.2deg, var(--reef-surge-color) 4.7deg 5.25deg, transparent 5.7deg 9deg)',
        WebkitMaskImage:
          'radial-gradient(circle at center, transparent 0 24%, rgba(0,0,0,.18) 38%, #000 62%, transparent 100%)',
        maskImage:
          'radial-gradient(circle at center, transparent 0 24%, rgba(0,0,0,.18) 38%, #000 62%, transparent 100%)',
        mixBlendMode: 'screen',
        willChange: 'opacity, transform',
      } as CSSProperties}
    />
  );
}
