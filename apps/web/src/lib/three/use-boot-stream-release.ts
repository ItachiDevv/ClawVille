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
  isBootBuildingsStreamEligible,
  isBootStreamEligible,
  isStreamMemberDelivered,
  onBootBuildingsStream,
  onBootStreamEligible,
} from '@/lib/three/decorative-release';
import { reportCohortState } from '@/lib/three/boot-stream-cohort';
import { warmSuspenseRead } from '@/lib/three/suspense-cache-warm';

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
export function useBootStreamRelease(
  priority: number,
  memberId?: string,
): boolean {
  // [I1-F5][I2-F2] instant initialization is allowed ONLY for a member whose
  // own stagger tick already delivered (a REMOUNT of released content — the
  // one-shot monotonic contract) while the tab is visible. Every NEW member
  // — even visible, even after global eligibility — enters the epoch queue
  // (priority ordering, one per idle tick, hidden parking).
  const [released, setReleased] = useState(
    () =>
      isBootStreamEligible() &&
      memberId !== undefined &&
      isStreamMemberDelivered(memberId) &&
      (typeof document === 'undefined' || !document.hidden),
  );
  useEffect(() => {
    if (released) return undefined;
    return onBootStreamEligible(() => setReleased(true), priority, memberId);
  }, [released, priority, memberId]);
  return released;
}

/** First-write-wins phase stamp in `window.__W3D_PHASES` (a number write;
 * telemetry never throws). Keeps the FIRST boot's value across remounts. */
function stampBgrPhase(key: string): void {
  try {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __W3D_PHASES?: Record<string, unknown> };
    const phases = (w.__W3D_PHASES = w.__W3D_PHASES ?? {});
    if (phases[key] === undefined) {
      phases[key] = Math.round(
        typeof performance !== 'undefined' ? performance.now() : Date.now(),
      );
    }
  } catch {
    /* telemetry never throws */
  }
}

/** Stamps `bgrMounted:<cohort>` when the member's content tree COMMITS (its
 * passive effect). Render it inside the Suspense subtree, beside the cohort
 * commit probe, so it measures the hidden commit (web-load T7). */
export function BgrMountedStamp({ cohortId }: { cohortId: string }): null {
  useEffect(() => {
    stampBgrPhase(`bgrMounted:${cohortId}`);
  }, [cohortId]);
  return null;
}

/**
 * BGR stage-B consumer hook (buildings + reveal-required members — spec
 * D1): identical contract to useBootStreamRelease but on the BOOT-CRITICAL
 * lane, which becomes eligible at the FIRST boot-core presentation (NOT at
 * overlay dismissal — the overlay now waits for these members, so gating
 * them on it would deadlock into the fuses). Delivered-member remounts
 * initialize released, same as the post-reveal lane.
 *
 * web-load T7: this hook reports the cohort `'loading'` state AT ADMISSION
 * (the consumer must not report it again on `released`). With `warmRead`
 * (the member's own non-hook GLB read; MUST be referentially stable), the
 * admitted member loads + parses OUTSIDE React first (warmSuspenseRead),
 * stamps `bgrParsed:<member>`, and only then flips `released`, so its first
 * render reads a resolved cache entry and commits without a Suspense retry
 * (retry lanes starve under the 5 Hz SyncLane stream renders). Unmount
 * before the warm resolves cancels the flip.
 */
export function useBootBuildingsStreamRelease(
  priority: number,
  memberId: string,
  warmRead?: () => unknown,
): boolean {
  const [released, setReleased] = useState(
    () =>
      isBootBuildingsStreamEligible() &&
      isStreamMemberDelivered(memberId) &&
      (typeof document === 'undefined' || !document.hidden),
  );
  useEffect(() => {
    if (released) return undefined;
    let cancelled = false;
    const unsubscribe = onBootBuildingsStream(
      () => {
        reportCohortState(memberId, 'loading');
        if (warmRead === undefined) {
          setReleased(true);
          return;
        }
        void warmSuspenseRead(warmRead).then(() => {
          stampBgrPhase(`bgrParsed:${memberId}`);
          if (!cancelled) setReleased(true);
        });
      },
      priority,
      memberId,
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [released, priority, memberId, warmRead]);
  return released;
}
