'use client';

import { useEffect, useRef, useState } from 'react';
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

const SLOW_MS = 15_000;
const TIMEOUT_MS = 30_000;

export default function SeaLoadingScreen({ forceReady }: Props) {
  const [visible, setVisible]       = useState(true);
  const [fading, setFading]         = useState(false);
  const [slow, setSlow]             = useState(false);
  const rafRef     = useRef<number | null>(null);
  const mountedRef = useRef(true);

  // Read avatar color from game store (set by game/page.tsx via setAvatarAppearance)
  const avatarColorId = useGameStore((s) => s.avatarColor);
  const lobsterColor = COLOR_MAP[avatarColorId] ?? DEFAULT_COLOR;
  // Derive a slightly darker shade for shading strokes
  const lobsterDark  = lobsterColor === DEFAULT_COLOR ? '#c44820' : lobsterColor + 'cc';

  useEffect(() => {
    mountedRef.current = true;

    // Show "taking longer" hint after 15s
    const slowTimer = setTimeout(() => {
      if (mountedRef.current) setSlow(true);
    }, SLOW_MS);

    // Force-dismiss after 30s so user isn't stuck forever
    const forceTimer = setTimeout(() => {
      if (mountedRef.current) {
        setFading(true);
        setTimeout(() => {
          if (mountedRef.current) setVisible(false);
        }, 420);
      }
    }, TIMEOUT_MS);

    function check() {
      if (!mountedRef.current) return;
      const ready = forceReady || !!(window as any).__W3D;
      if (ready) {
        setFading(true);
        setTimeout(() => {
          if (mountedRef.current) setVisible(false);
        }, 420);
        return;
      }
      rafRef.current = requestAnimationFrame(check);
    }

    rafRef.current = requestAnimationFrame(check);
    return () => {
      mountedRef.current = false;
      clearTimeout(slowTimer);
      clearTimeout(forceTimer);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [forceReady]);

  if (!visible) return null;

  return (
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

        /* ── Avatar drop — gravity fall from off-screen top ───────────── */
        /*  Starts above viewport (-120px), lands at water surface (30vh) */
        @keyframes claw-avatar-drop {
          0%   { transform: translateY(-120px) rotate(-8deg) scale(1);   opacity: 0; }
          5%   { opacity: 1; }
          55%  { transform: translateY(calc(30vh - 40px)) rotate(4deg) scale(1);   opacity: 1; }
          70%  { transform: translateY(calc(30vh - 2px))  rotate(0deg) scale(1.06); opacity: 1; }
          80%  { transform: translateY(calc(30vh + 8px))  rotate(0deg) scale(0.96); opacity: 1; }
          100% { transform: translateY(calc(30vh))        rotate(0deg) scale(1);   opacity: 1; }
        }

        /* ── Avatar sink — continues downward after splash ─────────────── */
        /*  Starts at 30vh (splash point) and sinks toward 90vh           */
        @keyframes claw-avatar-sink {
          0%   { transform: translateY(calc(30vh))  scale(1)    rotate(0deg);  opacity: 1; }
          60%  { transform: translateY(calc(70vh))  scale(0.55) rotate(6deg);  opacity: 0.65; }
          100% { transform: translateY(calc(90vh))  scale(0.35) rotate(12deg); opacity: 0.3; }
        }

        /* ── Splash rings ─────────────────────────────────────────────── */
        @keyframes claw-splash-ring {
          0%   { transform: scale(0.1); opacity: 0.8; }
          100% { transform: scale(1);   opacity: 0; }
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

        /* ── Progress shimmer bar ────────────────────────────────────── */
        @keyframes claw-shimmer {
          0%   { left: -60%; }
          100% { left: 110%; }
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
                // Appear at 800ms (0.8s) + individual ring delay
                animationDelay: `calc(0.8s + ${ring.delay})`,
                animationDuration: '0.55s',
                animationName: 'claw-splash-ring',
                animationTimingFunction: 'ease-out',
                animationFillMode: 'both',
                opacity: 0,
              }}
            />
          ))}
        </div>

        {/* ── Avatar lobster ──────────────────────────────────────────────── */}
        {/* Phase 1: drop (0.3s–1.0s), Phase 2: sink (1.0s onward)        */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            left: '50%',
            marginLeft: '-40px',   // half of 80px SVG width
            width: '80px',
            height: '80px',
            // Phase 1: drop animation — runs once, 700ms, starts at 300ms
            animationName: 'claw-avatar-drop, claw-avatar-sink',
            animationDuration: '0.7s, 4.5s',
            animationDelay: '0.3s, 1.0s',
            animationTimingFunction: 'cubic-bezier(0.55, 0, 1, 0.45), cubic-bezier(0.3, 0, 0.6, 1)',
            animationFillMode: 'both, forwards',
            animationIterationCount: '1, 1',
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

          {/* Progress shimmer bar */}
          <div
            style={{
              width: '140px',
              height: '2px',
              borderRadius: '99px',
              background: 'rgba(45,212,191,0.15)',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: '-60%',
                width: '60%',
                height: '100%',
                borderRadius: '99px',
                background: 'linear-gradient(90deg, transparent 0%, #2dd4bf 50%, transparent 100%)',
                animation: 'claw-shimmer 1.6s linear infinite',
              }}
            />
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
    </>
  );
}
