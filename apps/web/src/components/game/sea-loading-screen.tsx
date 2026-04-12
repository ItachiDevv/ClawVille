'use client';

import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// SeaLoadingScreen
// ---------------------------------------------------------------------------
// Renders immediately (pure CSS, no assets) as a full-screen overlay while
// the Three.js / WebGPU scene bootstraps. Polls window.__W3D (set by
// World3DCanvas.kickRenderLoop) once per rAF. When the flag appears it:
//   1. Starts a 400ms CSS opacity fade-out
//   2. Removes the DOM node after the transition completes
// ---------------------------------------------------------------------------

interface Props {
  /** Override ready signal for testing — defaults to polling window.__W3D */
  forceReady?: boolean;
}

// 18 bubbles — varied sizes & speeds so they never look mechanical
const BUBBLES = [
  { size: 6,  left: '8%',  delay: '0s',    dur: '4.2s' },
  { size: 10, left: '15%', delay: '0.6s',  dur: '5.8s' },
  { size: 4,  left: '22%', delay: '1.1s',  dur: '3.9s' },
  { size: 8,  left: '30%', delay: '0.2s',  dur: '5.1s' },
  { size: 14, left: '38%', delay: '1.7s',  dur: '6.4s' },
  { size: 5,  left: '45%', delay: '0.9s',  dur: '4.6s' },
  { size: 11, left: '52%', delay: '2.3s',  dur: '5.3s' },
  { size: 7,  left: '60%', delay: '0.4s',  dur: '4.0s' },
  { size: 9,  left: '67%', delay: '1.5s',  dur: '5.7s' },
  { size: 13, left: '74%', delay: '0.8s',  dur: '6.1s' },
  { size: 5,  left: '80%', delay: '2.0s',  dur: '3.7s' },
  { size: 7,  left: '86%', delay: '1.2s',  dur: '4.8s' },
  { size: 10, left: '92%', delay: '0.3s',  dur: '5.5s' },
  { size: 4,  left: '5%',  delay: '3.0s',  dur: '4.3s' },
  { size: 12, left: '25%', delay: '2.7s',  dur: '5.9s' },
  { size: 6,  left: '55%', delay: '3.4s',  dur: '4.1s' },
  { size: 9,  left: '70%', delay: '2.1s',  dur: '5.2s' },
  { size: 15, left: '88%', delay: '3.8s',  dur: '6.7s' },
] as const;

export default function SeaLoadingScreen({ forceReady }: Props) {
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);
  const rafRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    function check() {
      if (!mountedRef.current) return;

      const ready = forceReady || !!(window as any).__W3D;
      if (ready) {
        // Scene is up — start fade-out
        setFading(true);
        // Remove from DOM after transition completes (400ms)
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
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [forceReady]);

  if (!visible) return null;

  return (
    <>
      {/* Keyframes injected inline — keeps this component self-contained */}
      <style>{`
        @keyframes claw-bubble-rise {
          0%   { transform: translateY(0) scale(1);   opacity: 0; }
          10%  { opacity: 0.6; }
          80%  { opacity: 0.4; }
          100% { transform: translateY(-110vh) scale(1.15); opacity: 0; }
        }
        @keyframes claw-bubble-wobble {
          0%, 100% { margin-left: 0; }
          25%       { margin-left: 4px; }
          75%       { margin-left: -4px; }
        }
        @keyframes claw-wave-roll {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @keyframes claw-logo-breathe {
          0%, 100% { opacity: 0.92; text-shadow: 0 0 18px rgba(45,212,191,0.5); }
          50%       { opacity: 1;    text-shadow: 0 0 38px rgba(45,212,191,0.85), 0 0 60px rgba(45,212,191,0.35); }
        }
        @keyframes claw-dots {
          0%   { content: ''; }
          33%  { content: '.'; }
          66%  { content: '..'; }
          100% { content: '...'; }
        }
        @keyframes claw-depth-drift {
          0%, 100% { transform: translateY(0px); }
          50%       { transform: translateY(6px); }
        }
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
          // Deep ocean gradient — darker at top, lighter toward bottom (light from above)
          background: 'linear-gradient(180deg, #060e1f 0%, #0a1628 30%, #0d2137 65%, #0e2d45 100%)',
        }}
      >
        {/* ── Depth light shafts ─────────────────────────────────────── */}
        {/* Subtle rays of light bleeding in from the "surface" above */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(ellipse 60% 40% at 30% 0%, rgba(29,78,120,0.3) 0%, transparent 70%),' +
              'radial-gradient(ellipse 40% 30% at 70% 0%, rgba(45,212,191,0.1) 0%, transparent 60%)',
            pointerEvents: 'none',
          }}
        />

        {/* ── Bubbles ───────────────────────────────────────────────── */}
        {BUBBLES.map((b, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              bottom: '-20px',
              left: b.left,
              width: b.size,
              height: b.size,
              borderRadius: '50%',
              border: '1.5px solid rgba(45,212,191,0.5)',
              background:
                'radial-gradient(circle at 35% 35%, rgba(255,255,255,0.25) 0%, rgba(45,212,191,0.08) 60%, transparent 100%)',
              animation: `claw-bubble-rise ${b.dur} ${b.delay} linear infinite, claw-bubble-wobble ${b.dur} ${b.delay} ease-in-out infinite`,
            }}
          />
        ))}

        {/* ── Wave band at bottom ───────────────────────────────────── */}
        {/* Two tiled SVG waves scrolling at different speeds for parallax */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '200%',
            height: '80px',
            animation: 'claw-wave-roll 6s linear infinite',
            opacity: 0.35,
          }}
        >
          <svg
            viewBox="0 0 1440 80"
            preserveAspectRatio="none"
            style={{ width: '50%', height: '100%', display: 'inline-block' }}
            aria-hidden="true"
          >
            <path
              d="M0,40 C120,10 240,70 360,40 C480,10 600,70 720,40 C840,10 960,70 1080,40 C1200,10 1320,70 1440,40 L1440,80 L0,80 Z"
              fill="#1a4a6e"
            />
          </svg>
          <svg
            viewBox="0 0 1440 80"
            preserveAspectRatio="none"
            style={{ width: '50%', height: '100%', display: 'inline-block' }}
            aria-hidden="true"
          >
            <path
              d="M0,40 C120,10 240,70 360,40 C480,10 600,70 720,40 C840,10 960,70 1080,40 C1200,10 1320,70 1440,40 L1440,80 L0,80 Z"
              fill="#1a4a6e"
            />
          </svg>
        </div>

        {/* Slower, lighter wave layer for depth */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '200%',
            height: '52px',
            animation: 'claw-wave-roll 10s linear infinite',
            opacity: 0.2,
          }}
        >
          <svg
            viewBox="0 0 1440 52"
            preserveAspectRatio="none"
            style={{ width: '50%', height: '100%', display: 'inline-block' }}
            aria-hidden="true"
          >
            <path
              d="M0,26 C180,5 360,47 540,26 C720,5 900,47 1080,26 C1260,5 1380,47 1440,26 L1440,52 L0,52 Z"
              fill="#2dd4bf"
            />
          </svg>
          <svg
            viewBox="0 0 1440 52"
            preserveAspectRatio="none"
            style={{ width: '50%', height: '100%', display: 'inline-block' }}
            aria-hidden="true"
          >
            <path
              d="M0,26 C180,5 360,47 540,26 C720,5 900,47 1080,26 C1260,5 1380,47 1440,26 L1440,52 L0,52 Z"
              fill="#2dd4bf"
            />
          </svg>
        </div>

        {/* ── Center content ────────────────────────────────────────── */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '20px',
            animation: 'claw-depth-drift 4s ease-in-out infinite',
          }}
        >
          {/* Lobster claw SVG icon */}
          <svg
            width="64"
            height="64"
            viewBox="0 0 64 64"
            fill="none"
            aria-hidden="true"
            style={{ opacity: 0.9, filter: 'drop-shadow(0 0 14px rgba(45,212,191,0.5))' }}
          >
            {/* Body */}
            <ellipse cx="32" cy="36" rx="13" ry="16" fill="#e05a2b" />
            {/* Head */}
            <ellipse cx="32" cy="22" rx="10" ry="9" fill="#d94e22" />
            {/* Eyes */}
            <circle cx="27" cy="19" r="2.5" fill="#fff" />
            <circle cx="37" cy="19" r="2.5" fill="#fff" />
            <circle cx="27.8" cy="19.5" r="1.2" fill="#1a1a2e" />
            <circle cx="37.8" cy="19.5" r="1.2" fill="#1a1a2e" />
            {/* Left claw */}
            <path
              d="M19 28 C12 24 8 30 11 35 C14 40 20 38 22 34"
              stroke="#e05a2b" strokeWidth="5" strokeLinecap="round" fill="none"
            />
            <path
              d="M14 32 C10 28 7 22 12 20"
              stroke="#c44820" strokeWidth="3.5" strokeLinecap="round" fill="none"
            />
            {/* Right claw */}
            <path
              d="M45 28 C52 24 56 30 53 35 C50 40 44 38 42 34"
              stroke="#e05a2b" strokeWidth="5" strokeLinecap="round" fill="none"
            />
            <path
              d="M50 32 C54 28 57 22 52 20"
              stroke="#c44820" strokeWidth="3.5" strokeLinecap="round" fill="none"
            />
            {/* Tail segments */}
            <path d="M26 50 Q32 56 38 50" stroke="#c44820" strokeWidth="4" strokeLinecap="round" fill="none" />
            <path d="M28 54 Q32 61 36 54" stroke="#b03c18" strokeWidth="3" strokeLinecap="round" fill="none" />
            {/* Antennae */}
            <line x1="28" y1="14" x2="18" y2="4" stroke="#c44820" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="36" y1="14" x2="46" y2="4" stroke="#c44820" strokeWidth="1.5" strokeLinecap="round" />
          </svg>

          {/* Logo text */}
          <h1
            style={{
              fontFamily: 'var(--font-orbitron), sans-serif',
              fontSize: 'clamp(2rem, 6vw, 3.5rem)',
              fontWeight: 900,
              letterSpacing: '0.08em',
              color: '#e0f2fe',
              margin: 0,
              animation: 'claw-logo-breathe 2.4s ease-in-out infinite',
            }}
          >
            ClawVille
          </h1>

          {/* Tagline */}
          <p
            style={{
              fontFamily: 'var(--font-oxanium), sans-serif',
              fontSize: 'clamp(0.75rem, 2vw, 0.95rem)',
              color: 'rgba(125,211,252,0.7)',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              margin: 0,
            }}
          >
            Diving into the deep
          </p>

          {/* Progress indicator — three animated dots + teal bar */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
            {/* Pulsing teal bar */}
            <div
              style={{
                width: '160px',
                height: '3px',
                borderRadius: '99px',
                background: 'rgba(45,212,191,0.15)',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: '-60%',
                  top: 0,
                  width: '60%',
                  height: '100%',
                  borderRadius: '99px',
                  background: 'linear-gradient(90deg, transparent 0%, #2dd4bf 50%, transparent 100%)',
                  animation: 'claw-wave-roll 1.6s linear infinite',
                }}
              />
            </div>

            {/* Dot trail */}
            <div style={{ display: 'flex', gap: '6px' }}>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    display: 'inline-block',
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: '#2dd4bf',
                    opacity: 0.3,
                    animation: `claw-logo-breathe 1.2s ${i * 0.2}s ease-in-out infinite`,
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
