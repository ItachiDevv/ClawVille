'use client';

/**
 * use-boot-stream-release.ts — the shared slice-D consumer hook (spec §2e).
 * Boot-deferred content (buildings, town props, town NPCs, land trio) gates
 * its heavy subtree on this instead of the plain decorative release: delivery
 * requires BOOT_CORE_PRESENTED + release + overlay/curtain gone + a visible
 * tab, staggered one consumer per idle tick through the per-epoch stream
 * queue (own 1.5s quiet period; parks while hidden).
 */

import { useEffect, useState } from 'react';
import {
  BOOT_CAMERA_POSITION,
  isBootStreamEligible,
  onBootStreamEligible,
} from '@/lib/three/decorative-release';

/** Compose a stream priority: TIER + squared distance from the static boot
 * camera to the consumer's static world position. Never read per-frame. */
export function bootStreamPriority(
  tier: number,
  x: number,
  z: number,
  y = 0,
): number {
  const dx = x - BOOT_CAMERA_POSITION[0];
  const dy = y - BOOT_CAMERA_POSITION[1];
  const dz = z - BOOT_CAMERA_POSITION[2];
  return tier + dx * dx + dy * dy + dz * dz;
}

/**
 * Returns true once this consumer's stagger tick delivers. Subscribes on
 * LOCAL state only (the UnderwaterDecorations lesson — re-checking the
 * global in the effect can lose an eligibility fired between render and
 * effect); a post-eligibility subscribe still delivers via the queue, so
 * this is correct in every interleaving. One-shot monotonic per mount;
 * post-eligibility remounts initialize released.
 */
export function useBootStreamRelease(priority: number): boolean {
  // [I1-F5] a post-eligibility remount initializes released ONLY while the
  // tab is visible — a hidden late consumer must go through the queue
  // (which parks while hidden) instead of bypassing §2e parking entirely.
  const [released, setReleased] = useState(
    () =>
      isBootStreamEligible() &&
      (typeof document === 'undefined' || !document.hidden),
  );
  useEffect(() => {
    if (released) return undefined;
    return onBootStreamEligible(() => setReleased(true), priority);
  }, [released, priority]);
  return released;
}
