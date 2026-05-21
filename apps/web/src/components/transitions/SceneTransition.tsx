'use client';

/**
 * SceneTransition — generic fixed-position black overlay for scene swaps.
 *
 * Usage:
 *   const { triggerTransition } = useSceneTransition();
 *   triggerTransition({ to: '/cove', onMidway: () => { ... } });
 *
 * The component must be mounted persistently above the canvas layer (e.g.
 * in the root layout or the game page wrapper). It reads from a Zustand slice
 * so any caller in the tree can fire a transition without prop-drilling.
 *
 * Timing:
 *   0ms       → fade starts (overlay opacity 0 → 1)
 *   HALF_MS   → onMidway fires (route push / scene swap happens here)
 *   HALF_MS   → fade reverses (opacity 1 → 0)
 *   TOTAL_MS  → overlay hidden, transition complete
 *
 * Phase 6.0.3 — Concern 6.0.3 (walk-in animation for cove + future buildings).
 * zIndex 9999 sits above sidebar (z-index ~40) but below critical system modals.
 * pointerEvents 'none' while transparent so HUD inputs are never blocked.
 */

import { useEffect, useRef, useCallback } from 'react';
import { create } from 'zustand';
import { useRouter } from 'next/navigation';

// ---------------------------------------------------------------------------
// Transition store — module-scoped singleton so any caller can trigger.
// ---------------------------------------------------------------------------

export const TRANSITION_FADE_MS = 500; // each half (fade-in + fade-out)
export const TRANSITION_TOTAL_MS = TRANSITION_FADE_MS * 2;

interface TransitionRequest {
  to: string;
  onMidway?: () => void;
}

interface TransitionStoreState {
  pending: TransitionRequest | null;
  active: boolean;
  triggerTransition: (req: TransitionRequest) => void;
  _consume: () => TransitionRequest | null;
  _setActive: (v: boolean) => void;
}

export const useTransitionStore = create<TransitionStoreState>((set, get) => ({
  pending: null,
  active: false,

  triggerTransition: (req) => {
    // Ignore if already transitioning
    if (get().active) return;
    set({ pending: req });
  },

  _consume: () => {
    const req = get().pending;
    set({ pending: null });
    return req;
  },

  _setActive: (v) => set({ active: v }),
}));

/**
 * Convenience hook for callers — exposes only the trigger.
 */
export function useSceneTransition() {
  const triggerTransition = useTransitionStore((s) => s.triggerTransition);
  return { triggerTransition };
}

// ---------------------------------------------------------------------------
// SceneTransition — the actual overlay. Mount once in the page that needs it.
// ---------------------------------------------------------------------------

interface SceneTransitionProps {
  /**
   * Called when a fade-IN from black is desired on initial mount
   * (e.g. the cove page fading in after route push).
   * Pass `true` to trigger an immediate fade-from-black on mount.
   */
  fadeInOnMount?: boolean;
}

export default function SceneTransition({ fadeInOnMount = false }: SceneTransitionProps) {
  const router = useRouter();
  const overlayRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);

  const consume = useTransitionStore((s) => s._consume);
  const setActive = useTransitionStore((s) => s._setActive);
  const pending = useTransitionStore((s) => s.pending);

  // Animate a single eased opacity step per rAF
  const animateFade = useCallback(
    (
      fromOpacity: number,
      toOpacity: number,
      durationMs: number,
      onComplete: () => void,
    ) => {
      const overlay = overlayRef.current;
      if (!overlay) { onComplete(); return; }

      startTimeRef.current = performance.now();
      overlay.style.opacity = String(fromOpacity);
      overlay.style.pointerEvents = 'auto'; // block clicks during fade

      const tick = (now: number) => {
        const elapsed = now - startTimeRef.current;
        const t = Math.min(elapsed / durationMs, 1);
        // Smooth ease in-out
        const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        const opacity = fromOpacity + (toOpacity - fromOpacity) * eased;
        overlay.style.opacity = String(opacity);

        if (t < 1) {
          animFrameRef.current = requestAnimationFrame(tick);
        } else {
          overlay.style.opacity = String(toOpacity);
          if (toOpacity === 0) overlay.style.pointerEvents = 'none';
          onComplete();
        }
      };

      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = requestAnimationFrame(tick);
    },
    [],
  );

  // Run the full transition: fade-to-black → onMidway → route push → fade-from-black
  const runTransition = useCallback(
    (req: TransitionRequest) => {
      setActive(true);
      animateFade(0, 1, TRANSITION_FADE_MS, () => {
        // Midway — fire optional callback (scene state changes, etc.)
        req.onMidway?.();
        // Route push — Next.js router.push is non-blocking; overlay stays black
        // until the new page mounts its own SceneTransition with fadeInOnMount.
        router.push(req.to);
        // We do NOT fade back here — the destination page owns the fade-in.
        // (If destination has no SceneTransition, overlay stays until cleared by
        // the next mount of any SceneTransition with fadeInOnMount=true.)
        setActive(false);
      });
    },
    [animateFade, router, setActive],
  );

  // Watch for pending transitions
  useEffect(() => {
    if (!pending) return;
    const req = consume();
    if (!req) return;
    runTransition(req);
  }, [pending, consume, runTransition]);

  // Fade-in on mount (for destination pages)
  useEffect(() => {
    if (!fadeInOnMount) return;
    const overlay = overlayRef.current;
    if (!overlay) return;

    // Start fully black, fade to transparent
    overlay.style.opacity = '1';
    overlay.style.pointerEvents = 'auto';

    // Small delay so the page has painted at least one frame
    const raf = requestAnimationFrame(() => {
      animateFade(1, 0, TRANSITION_FADE_MS, () => {
        // Fade complete — overlay is transparent, inputs unblocked
      });
    });

    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000000',
        opacity: fadeInOnMount ? 1 : 0,
        pointerEvents: fadeInOnMount ? 'auto' : 'none',
        zIndex: 9999,
        // No transition property — we drive opacity manually via rAF for
        // frame-perfect midway callback timing.
      }}
      aria-hidden="true"
    />
  );
}
