'use client';

/**
 * use-boot-stream-release.ts — the shared slice-D consumer hook (spec §2e).
 * Boot-deferred content (buildings, town props, town NPCs, land trio) gates
 * its heavy subtree on this instead of the plain decorative release: delivery
 * requires BOOT_CORE_PRESENTED + release + overlay/curtain gone + a visible
 * tab, staggered one consumer per idle tick through the per-epoch stream
 * queue (own 1.5s quiet period; parks while hidden).
 */

import { useEffect, useLayoutEffect, useState } from 'react';
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
 *
 * web-load T10-C: with `warmRead` (the member's own non-hook model read;
 * MUST be referentially stable, its presence static per mount; requires
 * `memberId`, a cohort id), the admitted member reports the cohort
 * `'loading'` state AT ADMISSION and starts the load there; `released` flips
 * only after THIS hook instance saw the read resolve (useInstanceWarm). The
 * release render reads a resolved cache entry and commits without a
 * Suspense retry (retry lanes starve under the SyncLane stream renders).
 * The consumer must then not report `'loading'` again on `released`.
 * Unmount before the warm resolves cancels the flip; a remount of a
 * delivered member waits for its own warm (instant when the entry is
 * resolved). Without `warmRead` the behaviour is unchanged. No `bgr*`
 * phase stamp (boot-critical lane only).
 */
export function useBootStreamRelease(
  priority: number,
  memberId?: string,
  warmRead?: () => unknown,
): boolean {
  // [I1-F5][I2-F2] instant initialization is allowed ONLY for a member whose
  // own stagger tick already delivered (a REMOUNT of released content — the
  // one-shot monotonic contract) while the tab is visible. Every NEW member
  // — even visible, even after global eligibility — enters the epoch queue
  // (priority ordering, one per idle tick, hidden parking).
  const [admitted, setAdmitted] = useState(
    () =>
      isBootStreamEligible() &&
      memberId !== undefined &&
      isStreamMemberDelivered(memberId) &&
      (typeof document === 'undefined' || !document.hidden),
  );
  // The warm needs a cohort id (the 'loading' report); without one the
  // member releases unwarmed, as before.
  const read = memberId === undefined ? undefined : warmRead;
  const warmed = useInstanceWarm(admitted, read);
  useEffect(() => {
    if (admitted) return undefined;
    return onBootStreamEligible(
      () => {
        if (read !== undefined && memberId !== undefined) {
          reportCohortState(memberId, 'loading');
          startCacheRead(read);
        }
        setAdmitted(true);
      },
      priority,
      memberId,
    );
  }, [admitted, priority, memberId, read]);
  return admitted && warmed;
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Start (or join) the cache entry's load at admission, outside render, so
 * the load starts on the admission tick and not one render later. The
 * release is NOT tied to this warm: useInstanceWarm awaits the same entry
 * in the hook instance (warmSuspenseRead never rejects). */
function startCacheRead(read: () => unknown): void {
  void warmSuspenseRead(read);
}

type CachePeek = 'resolved' | 'failed' | 'pending';

/** Non-suspending read of the cache entry: 'resolved'; 'failed' (a cached
 * failure: the render rethrows it into the member's boundary, as in
 * warmSuspenseRead's contract); 'pending' (the read threw a thenable: the
 * entry is loading, or was missing and this read started its load). Calls
 * no hook, so it is safe in render and outside it. */
function peekCacheEntry(read: () => unknown): CachePeek {
  try {
    read();
    return 'resolved';
  } catch (thrown) {
    return isThenable(thrown) ? 'pending' : 'failed';
  }
}

/** Warm rounds per hook instance: the first warm plus 2 re-warms after the
 * gate found the entry missing or loading again (Codex E3 re-check). */
const INSTANCE_WARM_MAX_ROUNDS = 3;

/**
 * The release gate of a member with a warm read (Codex E3, T10 batch,
 * 2026-10-06). Rules:
 * - The warm result belongs to THIS hook instance, never to the queue (the
 *   queue marks a member delivered at admission, before its warm resolves,
 *   and a delivered member's remount starts admitted).
 * - Readiness is checked DURING the gate's render with a non-suspending
 *   peek, so no clear or eviction between a warm and the release render can
 *   make the content's own read suspend: the peek and the content read run
 *   in the same synchronous render. 'resolved' or 'failed' -> release;
 *   'pending' -> render nothing and warm again (an effect; the peek already
 *   started or joined the load), at most INSTANCE_WARM_MAX_ROUNDS; after
 *   the cap the content renders as without the warm (it may suspend).
 * - A fresh member peeks only after a completed warm round (so the release
 *   peek normally hits a resolved entry); a member admitted at mount (a
 *   remount) peeks from its first render: instant reveal when resolved.
 * - Once released and committed, the gate latches (layout effect, before
 *   paint): a later clear of a failed entry never hides the boundary and
 *   never retries the model.
 * - `parsedStampKey` (boot-critical lane) is stamped first-write-wins ONLY
 *   when the release peek saw a resolved entry: never on a cached failure,
 *   never after exhausted rounds.
 * - An unmount before a warm resolves cancels its round.
 */
function useInstanceWarm(
  admitted: boolean,
  read: (() => unknown) | undefined,
  parsedStampKey?: string,
): boolean {
  const [admittedAtMount] = useState(admitted);
  const [rounds, setRounds] = useState(0);
  const [latched, setLatched] = useState(false);
  const exhausted = rounds >= INSTANCE_WARM_MAX_ROUNDS;
  const peek: CachePeek | null =
    read !== undefined && admitted && !latched && (rounds > 0 || admittedAtMount)
      ? peekCacheEntry(read)
      : null;
  const ready =
    read === undefined ||
    latched ||
    (peek !== null && (peek !== 'pending' || exhausted));

  useEffect(() => {
    if (read === undefined || !admitted || ready || exhausted) return undefined;
    let cancelled = false;
    void warmSuspenseRead(read).then(() => {
      if (!cancelled) setRounds((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [read, admitted, ready, exhausted, rounds]);

  useLayoutEffect(() => {
    if (read === undefined || latched || !ready) return;
    if (peek === 'resolved' && parsedStampKey !== undefined) {
      stampBgrPhase(parsedStampKey);
    }
    setLatched(true);
  }, [read, latched, ready, peek, parsedStampKey]);

  return ready;
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
 * and only then flips `released`, so its first render reads a resolved
 * cache entry and commits without a Suspense retry (retry lanes starve
 * under the 5 Hz SyncLane stream renders). Unmount before the warm
 * resolves cancels the flip. The release gate is useInstanceWarm (Codex E3
 * T10): per-instance warm, render-time non-suspending peek, re-warm when the
 * entry went missing, latch after release; `bgrParsed:<member>` is stamped
 * only when the release peek saw a resolved entry.
 */
export function useBootBuildingsStreamRelease(
  priority: number,
  memberId: string,
  warmRead?: () => unknown,
): boolean {
  const [admitted, setAdmitted] = useState(
    () =>
      isBootBuildingsStreamEligible() &&
      isStreamMemberDelivered(memberId) &&
      (typeof document === 'undefined' || !document.hidden),
  );
  // No phase for an instance that unmounted before its warm resolved.
  const warmed = useInstanceWarm(admitted, warmRead, `bgrParsed:${memberId}`);
  useEffect(() => {
    if (admitted) return undefined;
    return onBootBuildingsStream(
      () => {
        reportCohortState(memberId, 'loading');
        if (warmRead !== undefined) startCacheRead(warmRead);
        setAdmitted(true);
      },
      priority,
      memberId,
    );
  }, [admitted, priority, memberId, warmRead]);
  return admitted && warmed;
}
