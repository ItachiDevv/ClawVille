'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useGameStore } from '@/stores/game';

// ---------------------------------------------------------------------------
// SeaLoadingScreen
// ---------------------------------------------------------------------------
// Pure-CSS avatar-drop animation. Shows the user's lobster (tinted by avatar color)
// falling from the sky, hitting a water surface, splashing, then slowly
// sinking into the deep ocean while the 3D scene boots.
//
// Animation timeline:
//   0–300ms   Ocean bg fades in, "ClawVille" logo appears at bottom
//   300–800ms  Lobster drops from above viewport (ease-in gravity)
//   800–1000ms Splash rings expand + lobster pauses at surface
//   1000ms+    Lobster slowly drifts downward, shrinks, bubbles rise behind it
//   scene ready → full overlay fades out (400ms)
// ---------------------------------------------------------------------------

interface Props {
  /** Override ready signal for testing — defaults to polling window.__W3D */
  forceReady?: boolean;
}

// Avatar color id → hex map (mirrors packages/shared/src/constants/avatar-colors.ts)
const COLOR_MAP: Record<string, string> = {
  green:  '#4CAF50',
  red:    '#F44336',
  blue:   '#2196F3',
  yellow: '#FFEB3B',
};
const DEFAULT_COLOR = '#e05a2b'; // coral orange — classic lobster

// 14 trail bubbles — smaller than the ambient ones, clustered center
const TRAIL_BUBBLES = [
  { size: 5,  left: '44%', delay: '1.05s', dur: '2.8s' },
  { size: 3,  left: '48%', delay: '1.30s', dur: '2.4s' },
  { size: 7,  left: '52%', delay: '1.60s', dur: '3.1s' },
  { size: 4,  left: '46%', delay: '1.90s', dur: '2.6s' },
  { size: 6,  left: '50%', delay: '2.20s', dur: '3.3s' },
  { size: 3,  left: '54%', delay: '2.50s', dur: '2.5s' },
  { size: 5,  left: '47%', delay: '2.80s', dur: '2.9s' },
  { size: 4,  left: '51%', delay: '3.10s', dur: '2.7s' },
  { size: 6,  left: '45%', delay: '3.40s', dur: '3.0s' },
  { size: 3,  left: '53%', delay: '3.70s', dur: '2.3s' },
  { size: 5,  left: '49%', delay: '4.00s', dur: '2.8s' },
  { size: 4,  left: '43%', delay: '4.30s', dur: '3.2s' },
  { size: 7,  left: '55%', delay: '4.60s', dur: '2.6s' },
  { size: 3,  left: '48%', delay: '4.90s', dur: '3.0s' },
] as const;

// 4 splash rings — each one a bit larger and slightly delayed
const SPLASH_RINGS = [
  { delay: '0s',    size: 30 },
  { delay: '0.08s', size: 50 },
  { delay: '0.16s', size: 70 },
  { delay: '0.26s', size: 90 },
] as const;

// Adaptive slow-hint threshold (S1, 2026-06-16). Perf round-3 "Change D" hard-coded
// SLOW_MS=8_000 on the assumption that changes B+C would bring the warm load to
// ~5-7s. The real baseline is ~10s warm / ~22s cold to ready (docs/perf-round3/
// baseline-2026-06-15.md), so 8s fired on EVERY cold refresh — noise, not an
// outlier signal. We now self-calibrate to THIS machine: record mount→__W3D_READY
// on each successful load in localStorage and only warn when the current load runs
// 1.8× past the machine's own recent norm (a genuine outlier), with a generous
// floor + a first-load default. No magic fixed constant guessed against unknown
// real-GPU timings.
const LOAD_TIME_KEY = 'cv_last_load_ms';
const SLOW_FLOOR_MS = 12_000;    // never warn before 12s regardless of history
const SLOW_DEFAULT_MS = 22_000;  // first-ever load (no history): cold-load ballpark
const SLOW_MULTIPLIER = 1.8;     // warn at 1.8× the machine's last successful load
const TIMEOUT_MS = 45_000;       // force-dismiss ceiling (was 30s — too low for cold Iris Xe)

function computeSlowThresholdMs(): number {
  if (typeof window === 'undefined') return SLOW_DEFAULT_MS;
  try {
    const raw = window.localStorage.getItem(LOAD_TIME_KEY);
    const last = raw ? parseFloat(raw) : NaN;
    if (Number.isFinite(last) && last > 0) {
      return Math.max(SLOW_FLOOR_MS, Math.round(last * SLOW_MULTIPLIER));
    }
  } catch {
    /* localStorage blocked (private mode / disabled) — fall through to default */
  }
  return SLOW_DEFAULT_MS;
}

export default function SeaLoadingScreen({ forceReady }: Props) {
  const [visible, setVisible]       = useState(true);
  const [fading, setFading]         = useState(false);
  const [slow, setSlow]             = useState(false);
  /**
   * Progress in [0, 1]. Composite signal so the bar tracks the user's
   * actual wait, not just network downloads. Rewritten 2026-05-31, bands
   * rebalanced 2026-06-16 (S1). `__W3D_PROGRESS` is `loaded/total` from
   * THREE.DefaultLoadingManager, which ONLY tracks GLBs (VRMs use raw
   * fetch — invisible to it). When the GLB batch drains, loaded/total
   * spikes to ~1.0 and the old 0.60 download band credited instantly via
   * the ratchet → the bar snapped to 60% while VRM-parse + the dominant
   * 10-17s texture-upload + compile still lay ahead. Fix: shrink the
   * download band, give the incrementally-tracked upload phase the biggest
   * slice, and time-ease the download band so a total-drain spike can't
   * snap it to the ceiling. Phases:
   *   0    – 0.30   `__W3D_PROGRESS` (GLB download via
   *                  THREE.DefaultLoadingManager — fast, often cached),
   *                  capped by a time-ease so it climbs from 0 instead of
   *                  jumping when the LoadingManager total drains.
   *   0.30 – 0.85   `__W3D_TEXTURE_UPLOAD_DONE / __W3D_TEXTURE_UPLOAD_TOTAL`
   *                  (GPU texture upload via StaggeredTextureUpload —
   *                   slow on Iris Xe; the band the user spends most time in)
   *   0.85 – 0.97   `__W3D_CANVAS_READY` (first frame compile + paint;
   *                  pipeline compile hitch lives here)
   *   1.00          `__W3D_READY` (canvas + textures both done — bar
   *                  snaps + fade)
   * Ratcheted forward so the bar never moves backward.
   */
  const [progress, setProgress]     = useState(0);
  /**
   * Current phase shown under the bar. Communicates WHY the user is
   * waiting at each step — "Downloading assets…" vs "Uploading to GPU…"
   * — instead of a single misleading percentage. `preparing` covers the
   * gap after GLBs finish but before the GPU texture-upload counter starts
   * ticking (VRM parse + scene assembly + compileAsync kick).
   */
  const [phase, setPhase] = useState<'downloading' | 'preparing' | 'uploading' | 'compiling' | 'ready'>('downloading');
  const rafRef     = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const startedAtRef = useRef<number>(0);
  const readyRef = useRef(false);

  // Read avatar color from game store (set by game/page.tsx via setAvatarAppearance)
  const avatarColorId = useGameStore((s) => s.avatarColor);
  const lobsterColor = COLOR_MAP[avatarColorId] ?? DEFAULT_COLOR;
  // Derive a slightly darker shade for shading strokes
  const lobsterDark  = lobsterColor === DEFAULT_COLOR ? '#c44820' : lobsterColor + 'cc';

  useEffect(() => {
    mountedRef.current = true;
    startedAtRef.current = performance.now();
    // Clear any progress ratio left over from a prior SPA visit so the bar
    // starts honest at 0% rather than inheriting the previous session's
    // high-water-mark. World3DCanvas's onProgress hook will re-fill this as
    // the next batch of assets loads.
    // 2026-05-26: re-zero ALL readiness bridge values so a re-mounted loader
    // (SPA route swap, fast refresh) cannot dismiss on stale flags from a
    // previous session. `__W3D_READY` is the two-gate dismissal signal —
    // World3DCanvas sets `__W3D_CANVAS_READY` after the first canvas frame
    // and `__W3D_TEXTURES_READY` after StaggeredTextureUpload completes;
    // `__W3D_READY` only flips when BOTH are true.
    if (typeof window !== 'undefined') {
      const bridge = window as unknown as {
        __W3D_CANVAS_READY?: boolean;
        __W3D_PROGRESS?: number;
        __W3D_READY?: boolean;
        __W3D_TEXTURES_READY?: boolean;
        __W3D_TEXTURE_UPLOAD_TOTAL?: number;
        __W3D_TEXTURE_UPLOAD_DONE?: number;
      };
      bridge.__W3D_CANVAS_READY = false;
      bridge.__W3D_PROGRESS = 0;
      bridge.__W3D_READY = false;
      bridge.__W3D_TEXTURES_READY = false;
      bridge.__W3D_TEXTURE_UPLOAD_TOTAL = 0;
      bridge.__W3D_TEXTURE_UPLOAD_DONE = 0;
    }

    // Show "taking longer" hint only when this load runs past the machine's
    // self-calibrated outlier threshold (see computeSlowThresholdMs).
    const slowMs = computeSlowThresholdMs();
    const slowTimer = setTimeout(() => {
      if (mountedRef.current) setSlow(true);
    }, slowMs);

    // Force-dismiss after 30s so user isn't stuck forever
    const forceTimer = setTimeout(() => {
      if (mountedRef.current) {
        readyRef.current = true;
        setProgress(1);
        setFading(true);
        setTimeout(() => {
          if (mountedRef.current) setVisible(false);
        }, 420);
      }
    }, TIMEOUT_MS);

    // Composite bar formula (2026-05-31). Three phases stitched into
    // [0, 1] so the bar's velocity reflects the user's actual wait, not
    // just network downloads. Old bar: pure `__W3D_PROGRESS` capped at
    // 0.99 — hit 99% the moment THREE.DefaultLoadingManager drained and
    // then sat there for the full StaggeredTextureUpload window. New
    // bar: maps each phase to a band and shows a phase label so the
    // user can SEE which step is running.
    const DOWNLOAD_BAND_END = 0.30;
    const UPLOAD_BAND_END = 0.85;
    const COMPILE_BAND_END = 0.97;
    // Time-ease for the download band: the GLB-only LoadingManager ratio spikes
    // to ~1.0 the instant the registered GLB batch drains, which would snap the
    // bar to the band ceiling. Capping the displayed download fill by an
    // elapsed-time ramp makes it climb from 0 over ~DOWNLOAD_EASE_MS instead.
    // Real progress still wins: when downloadFrac is the slower of the two,
    // it's the limiter, so a genuinely slow download is shown honestly.
    const DOWNLOAD_EASE_MS = 4_000;
    let highWaterMark = 0;
    function tick() {
      if (!mountedRef.current) return;
      // Dismiss only when both canvas AND textures are ready (keeps the
      // blue-flash fix from 2026-05-26).
      const ready = forceReady || !!(window as any).__W3D_READY;
      if (ready) {
        // Record this machine's real mount→ready time so the slow-hint
        // threshold self-calibrates on the next load. Only on a genuine
        // __W3D_READY (not the forceReady test override, not the force-dismiss
        // timeout) so a failure/timeout never poisons the baseline upward.
        if (!forceReady && typeof window !== 'undefined') {
          try {
            const dur = performance.now() - startedAtRef.current;
            if (dur > 0 && dur < TIMEOUT_MS) {
              window.localStorage.setItem(LOAD_TIME_KEY, String(Math.round(dur)));
            }
          } catch {
            /* localStorage blocked — skip recording */
          }
        }
        readyRef.current = true;
        setPhase('ready');
        setProgress(1);
        setFading(true);
        setTimeout(() => {
          if (mountedRef.current) setVisible(false);
        }, 420);
        return;
      }

      const bridge = window as unknown as {
        __W3D_PROGRESS?: number;
        __W3D_TEXTURE_UPLOAD_TOTAL?: number;
        __W3D_TEXTURE_UPLOAD_DONE?: number;
        __W3D_CANVAS_READY?: boolean;
        __W3D_TEXTURES_READY?: boolean;
      };

      // Phase 1 — asset download (THREE.DefaultLoadingManager loaded/total).
      const downloadFrac = Math.max(0, Math.min(1, bridge.__W3D_PROGRESS ?? 0));
      const elapsed = performance.now() - startedAtRef.current;
      const downloadEase = Math.min(1, elapsed / DOWNLOAD_EASE_MS);
      // Displayed download fill = the slower of real progress vs the time-ease
      // cap. Caps the LoadingManager spike without ever inflating a genuinely
      // slow download.
      const downloadShown = Math.min(downloadFrac, downloadEase);

      // Phase 2 — GPU texture upload (StaggeredTextureUpload counter).
      // Only counts once asset downloads are essentially complete AND
      // upload has actually started (TOTAL > 0). Stays at 0 until then.
      const uploadTotal = bridge.__W3D_TEXTURE_UPLOAD_TOTAL ?? 0;
      const uploadDone = bridge.__W3D_TEXTURE_UPLOAD_DONE ?? 0;
      const uploadFrac = uploadTotal > 0
        ? Math.max(0, Math.min(1, uploadDone / uploadTotal))
        : 0;

      // Phase 3 — first-canvas-frame paint + pipeline compile.
      const canvasReady = !!bridge.__W3D_CANVAS_READY;
      const texturesReady = !!bridge.__W3D_TEXTURES_READY;

      // Determine the current phase + composite value. Each real signal owns a
      // band; we pick the furthest-along signal present. Ordered latest→earliest.
      let composite: number;
      let currentPhase: typeof phase;
      if (texturesReady) {
        // GPU uploads done — sit at COMPILE_BAND_END once the canvas first frame
        // paints, else hold at the top of the upload band.
        composite = canvasReady ? COMPILE_BAND_END : UPLOAD_BAND_END;
        currentPhase = 'compiling';
      } else if (uploadTotal > 0) {
        // Real GPU-upload signal — fill the (dominant) upload band incrementally.
        composite = DOWNLOAD_BAND_END + uploadFrac * (UPLOAD_BAND_END - DOWNLOAD_BAND_END);
        currentPhase = 'uploading';
      } else {
        // Still downloading, OR GLBs drained but the GPU-upload counter hasn't
        // started yet. Use the time-eased download fill so a LoadingManager
        // total-drain spike can't snap the bar to the band ceiling.
        composite = downloadShown * DOWNLOAD_BAND_END;
        currentPhase = downloadFrac >= 0.999 ? 'preparing' : 'downloading';
      }

      // Ratchet — never move backward (asset retries / late re-registers
      // could otherwise rewind the bar).
      highWaterMark = Math.max(highWaterMark, composite);
      setProgress(Math.min(COMPILE_BAND_END, highWaterMark));
      setPhase(currentPhase);

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      mountedRef.current = false;
      clearTimeout(slowTimer);
      clearTimeout(forceTimer);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [forceReady]);

  if (!visible) return null;

  // Portal to <body>: inside the (world) route group the page-children layer
  // is `absolute z-10` (WorldStageRoot), a stacking context that traps this
  // overlay's zIndex 9999 BELOW the sibling StageTransition cover (real
  // z-[9999]) — users saw the stage handoff copy on black instead of the progress
  // bar for the whole first boot (field incident 2026-07-28; pre-existing
  // since the P1a cutover). Rendering into <body> (appended AFTER the stage
  // root) restores a true top-level 9999 that wins by DOM order.
  return createPortal(
    <>
      {/* All keyframes inline — component is fully self-contained */}
      <style>{`
        /* ── Ocean bg ──────────────────────────────────────────────── */
        @keyframes claw-bg-reveal {
          0%   { opacity: 0; }
          100% { opacity: 1; }
        }

        /* ── Logo fade up ──────────────────────────────────────────── */
        @keyframes claw-logo-enter {
          0%   { opacity: 0; transform: translateY(12px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes claw-logo-breathe {
          0%, 100% { text-shadow: 0 0 18px rgba(45,212,191,0.5); }
          50%       { text-shadow: 0 0 38px rgba(45,212,191,0.85), 0 0 60px rgba(45,212,191,0.35); }
        }

        /* ── Avatar loop — single keyframe covers drop + splash + sink + reset ── */
        /*  Period = 7s (set on .style.animationDuration below). Loops infinite     */
        /*  so the user always sees motion while assets stream. Splash percentages  */
        /*  align with the splash-ring keyframe below so each loop iteration the    */
        /*  rings expand exactly when the lobster hits the surface.                 */
        @keyframes claw-avatar-loop {
          0%   { transform: translateY(-120px) rotate(-8deg) scale(1);      opacity: 0; }
          3%   { opacity: 1; }
          10%  { transform: translateY(calc(30vh - 40px)) rotate(4deg) scale(1);     opacity: 1; }
          12%  { transform: translateY(calc(30vh - 2px))  rotate(0deg) scale(1.06);  opacity: 1; }
          14%  { transform: translateY(calc(30vh + 8px))  rotate(0deg) scale(0.96);  opacity: 1; }
          17%  { transform: translateY(calc(30vh))        rotate(0deg) scale(1);     opacity: 1; }
          60%  { transform: translateY(calc(70vh))        rotate(6deg) scale(0.55);  opacity: 0.65; }
          88%  { transform: translateY(calc(95vh))        rotate(12deg) scale(0.32); opacity: 0.22; }
          94%  { transform: translateY(calc(110vh))       rotate(14deg) scale(0.28); opacity: 0; }
          100% { transform: translateY(-120px) rotate(-8deg) scale(1);      opacity: 0; }
        }

        /* ── Splash rings ───────────────────────────────────────────────────── */
        /* Same 7s period as the avatar loop. Rings fade in around the 12-13%   */
        /* mark (when lobster pierces the surface) and expand+fade out by 18%.  */
        @keyframes claw-splash-ring-loop {
          0%, 10%   { transform: scale(0.1); opacity: 0; }
          12%       { transform: scale(0.15); opacity: 0.8; }
          18%       { transform: scale(1);    opacity: 0; }
          100%      { transform: scale(1);    opacity: 0; }
        }

        /* ── Bubble rise — trail bubbles from sinking avatar ────────────── */
        @keyframes claw-bubble-rise {
          0%   { transform: translateY(0) scale(1);    opacity: 0; }
          8%   { opacity: 0.65; }
          80%  { opacity: 0.4; }
          100% { transform: translateY(-55vh) scale(1.1); opacity: 0; }
        }
        @keyframes claw-bubble-wobble {
          0%, 100% { margin-left: 0; }
          30%       { margin-left: 5px; }
          70%       { margin-left: -5px; }
        }

        /* ── Ambient light rays ─────────────────────────────────────── */
        @keyframes claw-ray-pulse {
          0%, 100% { opacity: 0.12; }
          50%       { opacity: 0.22; }
        }

        /* ── Water surface ripple ───────────────────────────────────── */
        @keyframes claw-surface-wave {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }

        /* ── Overlay fade-out ─────────────────────────────────────────── */
        .claw-loading-overlay {
          transition: opacity 400ms ease-out;
        }
        .claw-loading-overlay.fading {
          opacity: 0 !important;
        }
      `}</style>

      <div
        className={`claw-loading-overlay${fading ? ' fading' : ''}`}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          pointerEvents: fading ? 'none' : 'all',
          overflow: 'hidden',
          background: 'linear-gradient(180deg, #060e1f 0%, #0a1628 30%, #0d2137 65%, #0e2d45 100%)',
          animation: 'claw-bg-reveal 0.3s ease-out forwards',
          opacity: 0,
        }}
      >
        {/* ── Depth light shafts ─────────────────────────────────────── */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            animation: 'claw-ray-pulse 4s ease-in-out infinite',
            background:
              'radial-gradient(ellipse 60% 45% at 28% 0%, rgba(29,78,120,0.4) 0%, transparent 70%),' +
              'radial-gradient(ellipse 35% 28% at 72% 0%, rgba(45,212,191,0.12) 0%, transparent 65%)',
          }}
        />

        {/* ── Water surface line at 30vh ─────────────────────────────── */}
        {/* Provides visual reference for where the avatar hits the water */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '30vh',
            left: 0,
            width: '200%',
            height: '48px',
            opacity: 0.3,
            animation: 'claw-surface-wave 8s linear infinite',
          }}
        >
          <svg
            viewBox="0 0 1440 48"
            preserveAspectRatio="none"
            style={{ width: '50%', height: '100%', display: 'inline-block' }}
            aria-hidden="true"
          >
            <path
              d="M0,24 C180,4 360,44 540,24 C720,4 900,44 1080,24 C1260,4 1380,44 1440,24 L1440,48 L0,48 Z"
              fill="#1d4a6e"
            />
          </svg>
          <svg
            viewBox="0 0 1440 48"
            preserveAspectRatio="none"
            style={{ width: '50%', height: '100%', display: 'inline-block' }}
            aria-hidden="true"
          >
            <path
              d="M0,24 C180,4 360,44 540,24 C720,4 900,44 1080,24 C1260,4 1380,44 1440,24 L1440,48 L0,48 Z"
              fill="#1d4a6e"
            />
          </svg>
        </div>

        {/* ── Splash rings — centered horizontally at 30vh ────────────── */}
        {/* Only visible ~800–1200ms (delay + short duration + forwards fill) */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '30vh',
            left: '50%',
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
          }}
        >
          {SPLASH_RINGS.map((ring, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: ring.size,
                height: ring.size / 3,
                marginLeft: -(ring.size / 2),
                marginTop: -(ring.size / 6),
                borderRadius: '50%',
                border: '2px solid rgba(45,212,191,0.7)',
                // Loop-aware: each ring shares the 7s avatar period; the per-ring
                // delay staggers them inside the splash window. Infinite iteration
                // so rings re-expand every time the lobster hits the surface.
                animationDelay: ring.delay,
                animationDuration: '7s',
                animationName: 'claw-splash-ring-loop',
                animationTimingFunction: 'ease-out',
                animationFillMode: 'both',
                animationIterationCount: 'infinite',
                opacity: 0,
              }}
            />
          ))}
        </div>

        {/* ── Avatar lobster ──────────────────────────────────────────────── */}
        {/* Single 7s looping keyframe combining drop + splash + sink + reset.  */}
        {/* Loops infinitely until window.__W3D fires and the overlay fades.    */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            left: '50%',
            marginLeft: '-40px',   // half of 80px SVG width
            width: '80px',
            height: '80px',
            animationName: 'claw-avatar-loop',
            animationDuration: '7s',
            animationTimingFunction: 'cubic-bezier(0.4, 0, 0.6, 1)',
            animationIterationCount: 'infinite',
            animationFillMode: 'both',
            filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.6))',
          }}
        >
          <svg
            width="80"
            height="80"
            viewBox="0 0 64 64"
            fill="none"
            aria-label="Your agent lobster"
          >
            {/* Body */}
            <ellipse cx="32" cy="36" rx="13" ry="16" fill={lobsterColor} />
            {/* Body sheen */}
            <ellipse cx="29" cy="31" rx="5" ry="7" fill="rgba(255,255,255,0.12)" />
            {/* Head */}
            <ellipse cx="32" cy="22" rx="10" ry="9" fill={lobsterColor} />
            {/* Eyes */}
            <circle cx="27" cy="19" r="2.5" fill="#fff" />
            <circle cx="37" cy="19" r="2.5" fill="#fff" />
            <circle cx="27.8" cy="19.5" r="1.2" fill="#1a1a2e" />
            <circle cx="37.8" cy="19.5" r="1.2" fill="#1a1a2e" />
            {/* Eye shine */}
            <circle cx="28.3" cy="19" r="0.4" fill="#fff" />
            <circle cx="38.3" cy="19" r="0.4" fill="#fff" />
            {/* Left claw */}
            <path
              d="M19 28 C12 24 8 30 11 35 C14 40 20 38 22 34"
              stroke={lobsterColor} strokeWidth="5" strokeLinecap="round" fill="none"
            />
            <path
              d="M14 32 C10 28 7 22 12 20"
              stroke={lobsterDark} strokeWidth="3.5" strokeLinecap="round" fill="none"
            />
            {/* Right claw */}
            <path
              d="M45 28 C52 24 56 30 53 35 C50 40 44 38 42 34"
              stroke={lobsterColor} strokeWidth="5" strokeLinecap="round" fill="none"
            />
            <path
              d="M50 32 C54 28 57 22 52 20"
              stroke={lobsterDark} strokeWidth="3.5" strokeLinecap="round" fill="none"
            />
            {/* Tail segments */}
            <path d="M26 50 Q32 56 38 50" stroke={lobsterDark} strokeWidth="4" strokeLinecap="round" fill="none" />
            <path d="M28 54 Q32 61 36 54" stroke={lobsterDark} strokeWidth="3" strokeLinecap="round" fill="none" />
            {/* Antennae */}
            <line x1="28" y1="14" x2="18" y2="4" stroke={lobsterDark} strokeWidth="1.5" strokeLinecap="round" />
            <line x1="36" y1="14" x2="46" y2="4" stroke={lobsterDark} strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>

        {/* ── Trail bubbles — rise from ~30vh upward, start at 1s ──────── */}
        {TRAIL_BUBBLES.map((b, i) => (
          <div
            key={i}
            aria-hidden="true"
            style={{
              position: 'absolute',
              // Start bubbles near the surface where avatar enters water
              top: '30vh',
              left: b.left,
              width: b.size,
              height: b.size,
              borderRadius: '50%',
              border: '1.5px solid rgba(45,212,191,0.55)',
              background:
                'radial-gradient(circle at 35% 35%, rgba(255,255,255,0.25) 0%, rgba(45,212,191,0.08) 60%, transparent 100%)',
              animationName: 'claw-bubble-rise, claw-bubble-wobble',
              animationDuration: `${b.dur}, ${b.dur}`,
              animationDelay: `${b.delay}, ${b.delay}`,
              animationTimingFunction: 'linear, ease-in-out',
              animationIterationCount: 'infinite, infinite',
            }}
          />
        ))}

        {/* ── Bottom UI: logo + tagline + progress ─────────────────────── */}
        <div
          style={{
            position: 'absolute',
            bottom: '10vh',
            left: 0,
            right: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '14px',
            // Fade up into view at 300ms
            animation: 'claw-logo-enter 0.5s 0.3s ease-out both',
            opacity: 0,
          }}
        >
          {/* Logo */}
          <h1
            style={{
              fontFamily: 'var(--font-orbitron), sans-serif',
              fontSize: 'clamp(2rem, 6vw, 3.5rem)',
              fontWeight: 900,
              letterSpacing: '0.08em',
              color: '#e0f2fe',
              margin: 0,
              animation: 'claw-logo-breathe 2.4s 0.8s ease-in-out infinite',
            }}
          >
            ClawVille
          </h1>

          {/* Tagline */}
          <p
            style={{
              fontFamily: 'var(--font-oxanium), sans-serif',
              fontSize: 'clamp(0.7rem, 1.8vw, 0.9rem)',
              color: 'rgba(125,211,252,0.65)',
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              margin: 0,
            }}
          >
            Dropping in...
          </p>

          {/* Progress bar — composite signal stitching three phases
              (asset download → texture upload → pipeline compile).
              See the `tick()` doc-block at the top of the component for
              the band split. */}
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label="Loading ClawVille"
            style={{
              width: '180px',
              height: '4px',
              borderRadius: '99px',
              background: 'rgba(45,212,191,0.12)',
              border: '1px solid rgba(45,212,191,0.18)',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <div
              style={{
                width: `${progress * 100}%`,
                height: '100%',
                borderRadius: '99px',
                background: 'linear-gradient(90deg, #2dd4bf 0%, #67e8f9 60%, #a5f3fc 100%)',
                boxShadow: '0 0 10px rgba(45,212,191,0.55)',
                transition: 'width 280ms cubic-bezier(0.2, 0, 0.2, 1)',
              }}
            />
          </div>
          <div
            style={{
              fontFamily: 'var(--font-oxanium), sans-serif',
              fontSize: '10px',
              color: 'rgba(125,211,252,0.55)',
              letterSpacing: '0.18em',
              textAlign: 'center',
              lineHeight: 1.45,
            }}
            aria-hidden="true"
          >
            {Math.round(progress * 100)}%
            <div style={{ fontSize: '9px', opacity: 0.7, marginTop: 2 }}>
              {phase === 'downloading' && 'Downloading assets…'}
              {phase === 'preparing' && 'Preparing scene…'}
              {phase === 'uploading' && 'Uploading to GPU…'}
              {phase === 'compiling' && 'Compiling shaders…'}
              {phase === 'ready' && 'Ready'}
            </div>
          </div>

          {/* Three pulsing dots */}
          <div style={{ display: 'flex', gap: '6px' }}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  display: 'inline-block',
                  width: '5px',
                  height: '5px',
                  borderRadius: '50%',
                  background: '#2dd4bf',
                  animation: `claw-logo-breathe 1.1s ${i * 0.18}s ease-in-out infinite`,
                  opacity: 0.35,
                }}
              />
            ))}
          </div>

          {/* Slow-load hint */}
          {slow && (
            <p
              style={{
                fontFamily: 'var(--font-oxanium), sans-serif',
                fontSize: 'clamp(0.65rem, 1.4vw, 0.8rem)',
                color: 'rgba(251,191,36,0.7)',
                margin: 0,
              }}
            >
              Taking longer than expected...
            </p>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
