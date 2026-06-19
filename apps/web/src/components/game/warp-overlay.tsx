'use client';

/**
 * warp-overlay.tsx — the FAST-TRAVEL warp transition (town-fast-travel, 2026-06-19).
 *
 * A full-screen DOM/CSS animation that plays when `warpTarget` is set in the
 * game store (`warpTo(x, y, label)` — gated to controlMode==='player'). It masks
 * an INSTANT teleport behind a ~1.4s radial flash + scanline sweep so the world
 * jump is never seen as a violent camera pan across the map.
 *
 * Iris Xe / WebGPU constraint: this is pure DOM/CSS (a fixed div + keyframes),
 * NOT a WebGPU/TSL shader and NOT a drei <Text>/<Billboard>. The integrated GPU
 * is already running the 3D scene; the overlay is GPU-cheap CSS compositing only
 * (opacity + transform), no per-frame React state, no canvas.
 *
 * Lifecycle (single timeline driven by two setTimeouts armed when warpTarget
 * appears, both cleared on unmount/abort):
 *   t=0ms     mount — flash ramps in (CSS keyframes), input is blocked by the
 *             full-screen layer (pointer-events + a key/scroll swallow).
 *   t≈MID     at peak opacity (screen whitest): perform the teleport —
 *               • setAvatarPosition(target.x, target.y)  → moves the body ref
 *               • clearClickPath()                        → cancels any walk
 *               • requestCameraFocus(target.x, target.y)  → snaps the follow
 *                 camera to the destination (FPSFollowCamera drains it and
 *                 re-anchors target+camera in ONE frame, no fly-across). The
 *                 camera-snap is what makes a long warp feel instant rather than
 *                 a slow exponential follow-lerp catching up over ~0.4s.
 *   t=END     clearWarp() — store nulls warpTarget, this component unmounts.
 *
 * Re-arm safety: the timers are keyed off the warpTarget OBJECT identity (a new
 * warpTo() makes a fresh object), so a second warp fired mid-animation re-runs
 * the effect cleanly (old timers cleared, new ones armed against the new target).
 */

import { useEffect, useRef } from 'react';
import { useGameStore } from '@/stores/game';

// ── Timeline (ms). MID is where the teleport fires (peak flash opacity). ──────
const WARP_DURATION_MS = 1400;
const WARP_MIDPOINT_MS = 700;

export default function WarpOverlay() {
  const warpTarget = useGameStore((s) => s.warpTarget);
  const setAvatarPosition = useGameStore((s) => s.setAvatarPosition);
  const clearClickPath = useGameStore((s) => s.clearClickPath);
  const requestCameraFocus = useGameStore((s) => s.requestCameraFocus);
  const clearWarp = useGameStore((s) => s.clearWarp);

  // Guard against the teleport firing twice if the effect re-runs for the SAME
  // target object (it shouldn't — deps are stable store actions + the target —
  // but a StrictMode double-invoke or a parent re-render must never double-jump).
  const teleportedRef = useRef(false);

  useEffect(() => {
    if (!warpTarget) {
      teleportedRef.current = false;
      return;
    }
    teleportedRef.current = false;
    const { x, y } = warpTarget;

    const midTimer = window.setTimeout(() => {
      if (teleportedRef.current) return;
      teleportedRef.current = true;
      // INSTANT teleport at the flash peak — masked by the white-out so the
      // body never visibly streaks across the map.
      clearClickPath();
      setAvatarPosition(x, y);
      // Snap the follow camera to the destination in one frame (FPSFollowCamera
      // consumes this) so a long warp doesn't slow-pan after the flash clears.
      requestCameraFocus(x, y);
    }, WARP_MIDPOINT_MS);

    const endTimer = window.setTimeout(() => {
      clearWarp();
    }, WARP_DURATION_MS);

    return () => {
      window.clearTimeout(midTimer);
      window.clearTimeout(endTimer);
    };
    // Re-arm whenever a NEW warp target object arrives. Store actions are stable
    // (zustand), so the target identity is the real trigger.
  }, [warpTarget, setAvatarPosition, clearClickPath, requestCameraFocus, clearWarp]);

  // Swallow keyboard/scroll while the overlay is up so a held WASD key or a
  // wheel can't drive movement behind the white-out (movement is unfrozen during
  // the animation — warpTo() releases the freeze — so this layer is the gate).
  useEffect(() => {
    if (!warpTarget) return;
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    // Capture phase so we intercept before the 3D controllers' window listeners.
    window.addEventListener('keydown', swallow, { capture: true });
    window.addEventListener('wheel', swallow, { capture: true, passive: false });
    return () => {
      window.removeEventListener('keydown', swallow, { capture: true });
      window.removeEventListener('wheel', swallow, { capture: true } as EventListenerOptions);
    };
  }, [warpTarget]);

  if (!warpTarget) return null;

  const label = warpTarget.label?.trim() || 'Destination';

  return (
    <div
      className="warp-overlay-root"
      aria-live="polite"
      aria-label={`Warping to ${label}`}
      role="status"
    >
      {/* Radial flash — cyan→white core blooming from screen center */}
      <div className="warp-flash" />
      {/* Scanline sweep band travelling top→bottom */}
      <div className="warp-scanlines" />
      {/* Center caption */}
      <div className="warp-caption">
        <span className="warp-caption-title">WARPING</span>
        <span className="warp-caption-dest">{label}</span>
        <span className="warp-caption-sub">re-routing through the reef…</span>
      </div>

      <style jsx>{`
        .warp-overlay-root {
          position: fixed;
          inset: 0;
          z-index: 9998; /* above HUD, below the very top SceneTransition (9999) */
          pointer-events: all; /* block clicks behind the white-out */
          overflow: hidden;
          /* Whole overlay fades in fast, holds, fades out — masks teleport at peak */
          animation: warp-root-fade ${WARP_DURATION_MS}ms ease-in-out forwards;
        }
        .warp-flash {
          position: absolute;
          inset: -20%;
          background: radial-gradient(
            circle at 50% 50%,
            rgba(255, 255, 255, 0.98) 0%,
            rgba(186, 247, 255, 0.92) 16%,
            rgba(34, 211, 238, 0.6) 38%,
            rgba(8, 30, 52, 0.85) 70%,
            rgba(3, 14, 26, 0.96) 100%
          );
          animation: warp-flash-pulse ${WARP_DURATION_MS}ms ease-in-out forwards;
          will-change: opacity, transform;
        }
        .warp-scanlines {
          position: absolute;
          inset: 0;
          background-image: repeating-linear-gradient(
            0deg,
            rgba(0, 0, 0, 0) 0px,
            rgba(0, 0, 0, 0) 2px,
            rgba(34, 211, 238, 0.16) 3px,
            rgba(34, 211, 238, 0.16) 4px
          );
          mix-blend-mode: screen;
          opacity: 0.5;
          animation: warp-scan-sweep ${WARP_DURATION_MS}ms linear forwards;
          will-change: transform, opacity;
        }
        .warp-caption {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.35rem;
          text-align: center;
          padding: 1rem;
          animation: warp-caption-fade ${WARP_DURATION_MS}ms ease-in-out forwards;
          will-change: opacity, transform;
        }
        .warp-caption-title {
          font-family: var(--font-clawville, monospace);
          font-weight: 800;
          letter-spacing: 0.42em;
          font-size: clamp(1.6rem, 6vw, 3rem);
          color: #04111e;
          text-shadow: 0 0 18px rgba(255, 255, 255, 0.9);
        }
        .warp-caption-dest {
          font-family: monospace;
          font-weight: 700;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          font-size: clamp(0.85rem, 3.5vw, 1.25rem);
          color: #062538;
          text-shadow: 0 0 12px rgba(186, 247, 255, 0.9);
        }
        .warp-caption-sub {
          font-family: monospace;
          letter-spacing: 0.12em;
          font-size: clamp(0.6rem, 2.4vw, 0.8rem);
          color: #0a3146;
          opacity: 0.85;
        }
        @keyframes warp-root-fade {
          0% { opacity: 0; }
          14% { opacity: 1; }
          82% { opacity: 1; }
          100% { opacity: 0; }
        }
        @keyframes warp-flash-pulse {
          0% { opacity: 0; transform: scale(1.25); }
          50% { opacity: 1; transform: scale(1); }
          100% { opacity: 0.2; transform: scale(0.92); }
        }
        @keyframes warp-scan-sweep {
          0% { transform: translateY(-100%); opacity: 0; }
          20% { opacity: 0.5; }
          80% { opacity: 0.5; }
          100% { transform: translateY(100%); opacity: 0; }
        }
        @keyframes warp-caption-fade {
          0% { opacity: 0; transform: scale(0.9); }
          50% { opacity: 1; transform: scale(1.02); }
          100% { opacity: 0; transform: scale(1.04); }
        }
        @media (prefers-reduced-motion: reduce) {
          .warp-flash,
          .warp-scanlines,
          .warp-caption,
          .warp-overlay-root {
            animation-duration: ${WARP_DURATION_MS}ms;
            animation-timing-function: linear;
          }
        }
      `}</style>
    </div>
  );
}
