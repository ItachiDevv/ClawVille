'use client';

/**
 * WinCelebration — 5-tier dispatcher reading from useFX state.
 *
 * Renders nothing on `tier === 'loss'`. Otherwise composes:
 *   - Optional dark vignette (medium+)
 *   - Coin burst layer (CSS keyframe `cv-coin-burst`)
 *   - Confetti burst layer (CSS keyframe `cv-confetti-burst`)
 *   - Win banner (big+ tiers)
 *   - Full-screen flash overlay (mega only)
 *
 * Iris Xe safe: pure CSS variables drive each particle's spread; no
 * Three.js, no Canvas2D, no per-frame allocations. Particles render
 * once, animate once, then auto-clear when `useFX` drops them from
 * state. Count-up uses requestAnimationFrame inside the banner only.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { FXState, FXParticle, WinTier } from '@/lib/cove/useFX';

export interface WinCelebrationProps {
  /** Active FX state from `useFX().state`. */
  fx: FXState;
}

// ---------------------------------------------------------------------------
// Per-tier banner config (label + colors + size)
// ---------------------------------------------------------------------------

interface BannerConfig {
  label: string;
  accent: string;
  fontSize: number;
}

const BANNER_CONFIGS: Record<Exclude<WinTier, 'loss'>, BannerConfig | null> = {
  micro:  null, // no banner — just particles
  small:  null, // no banner — just particles
  medium: { label: 'BIG WIN',   accent: 'var(--pt-amber)',      fontSize: 38 },
  big:    { label: 'SUPER WIN', accent: 'var(--pt-amber-glow)', fontSize: 46 },
  mega:   { label: 'EPIC WIN',  accent: 'var(--pt-amber-glow)', fontSize: 56 },
};

// ---------------------------------------------------------------------------
// Count-up hook (banner amount)
// ---------------------------------------------------------------------------

function useCountUp(target: number, durationMs: number, active: boolean): number {
  const [current, setCurrent] = useState(0);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (!active || target <= 0) {
      setCurrent(0);
      return;
    }
    startRef.current = performance.now();
    const tick = (now: number) => {
      const elapsed = now - startRef.current;
      const t = Math.min(elapsed / durationMs, 1);
      const eased = 1 - (1 - t) * (1 - t); // ease-out quad
      setCurrent(Math.round(eased * target));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, target, durationMs]);

  return current;
}

// ---------------------------------------------------------------------------
// Particle layer
// ---------------------------------------------------------------------------

function Particle({ particle }: { particle: FXParticle }) {
  // CSS custom properties aren't in the React CSSProperties type, so we
  // build the style as a plain record and cast at the React boundary.
  const style: Record<string, string | number> = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: particle.kind === 'coin' ? 26 : 12,
    height: particle.kind === 'coin' ? 26 : 4,
    borderRadius: particle.kind === 'coin' ? '50%' : 2,
    background: particle.kind === 'coin'
      ? 'radial-gradient(circle at 35% 30%, #ffe089 0%, #ffae00 50%, #6b4400 100%)'
      : (particle.color ?? '#ffae00'),
    boxShadow: particle.kind === 'coin'
      ? '0 0 12px rgba(255,174,0,0.7), inset 0 0 4px rgba(255,233,200,0.8)'
      : `0 0 6px ${particle.color ?? '#ffae00'}aa`,
    transform: 'translate(-50%, -50%)',
    animation:
      particle.kind === 'coin'
        ? 'cv-coin-burst 1100ms var(--cv-ease-standard) forwards'
        : 'cv-confetti-burst 1300ms var(--cv-ease-standard) forwards',
    animationDelay: `${particle.idx * 18}ms`,
    pointerEvents: 'none',
    '--cv-idx': particle.idx,
    '--cv-count': particle.count,
  };
  return <div style={style as CSSProperties} aria-hidden />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function WinCelebration({ fx }: WinCelebrationProps) {
  const showAny = fx.tier !== 'loss';
  const banner = fx.tier !== 'loss' ? BANNER_CONFIGS[fx.tier] : null;

  // Count-up driven by particles still being on screen — gives us a
  // banner that stays in sync with the celebration rhythm.
  const countActive = showAny && banner !== null;
  const counted = useCountUp(fx.winAmount, 900, countActive);

  if (!showAny) return null;

  return (
    <>
      {/* Full-screen flash (mega only) */}
      {fx.isHugeWinFlashActive && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            pointerEvents: 'none',
            background:
              'radial-gradient(circle at 50% 45%, rgba(255,233,200,0.95) 0%, rgba(255,204,68,0.55) 30%, rgba(200,154,77,0.22) 70%, transparent 100%)',
            animation: 'cv-screen-flash 600ms var(--cv-ease-standard) forwards',
            mixBlendMode: 'screen',
          }}
        />
      )}

      {/* Vignette for medium+ tiers */}
      {(fx.tier === 'medium' || fx.tier === 'big' || fx.tier === 'mega') && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9994,
            pointerEvents: 'none',
            background:
              'radial-gradient(circle at 50% 50%, transparent 35%, rgba(0,0,0,0.6) 100%)',
            transition: 'opacity var(--cv-motion-base) var(--cv-ease-standard)',
          }}
        />
      )}

      {/* Particle layer */}
      <div
        aria-hidden
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          width: 0,
          height: 0,
          zIndex: 9996,
          pointerEvents: 'none',
        }}
      >
        {fx.particles.map(p => <Particle key={p.id} particle={p} />)}
      </div>

      {/* Banner (medium+ tiers) */}
      {banner && (
        <div
          role="status"
          aria-live="assertive"
          style={{
            position: 'fixed',
            left: '50%',
            top: '42%',
            zIndex: 9997,
            pointerEvents: 'none',
            transform: 'translate(-50%, -50%)',
            animation: 'cv-mega-banner-in 700ms var(--cv-ease-bounce)',
          }}
        >
          <div
            style={{
              background: 'linear-gradient(180deg, var(--pt-velvet-soft) 0%, var(--pt-velvet) 100%)',
              border: `2px solid ${banner.accent}`,
              padding: '22px 48px',
              textAlign: 'center',
              boxShadow: `0 0 36px ${banner.accent}66, 0 0 72px ${banner.accent}33, inset 0 1px 0 rgba(244,233,212,0.08)`,
              minWidth: 260,
            }}
          >
            <div
              style={{
                color: banner.accent,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: 'var(--pt-label-letter)',
                fontFamily: 'var(--pt-data)',
                marginBottom: 8,
              }}
            >
              {banner.label}
            </div>
            <div
              style={{
                color: 'var(--pt-cream)',
                fontSize: banner.fontSize,
                fontWeight: 600,
                fontFamily: 'var(--pt-display)',
                letterSpacing: '0.04em',
                lineHeight: 1,
                textShadow: `0 0 24px ${banner.accent}`,
                marginBottom: 6,
              }}
            >
              +{counted.toLocaleString()}
            </div>
            <div
              style={{
                color: 'var(--pt-mute)',
                fontSize: 10,
                fontFamily: 'var(--pt-data)',
                letterSpacing: 'var(--pt-label-letter)',
              }}
            >
              CLAW TOKENS
            </div>
          </div>
        </div>
      )}

      {/* Micro/small tier toast — small floating label */}
      {(fx.tier === 'micro' || fx.tier === 'small') && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            left: '50%',
            top: '46%',
            zIndex: 9997,
            pointerEvents: 'none',
            transform: 'translate(-50%, -50%)',
            animation: 'cv-mega-banner-in 500ms var(--cv-ease-bounce)',
          }}
        >
          <div
            style={{
              background: 'var(--pt-velvet)',
              border: '1px solid var(--pt-brass)',
              padding: '8px 22px',
              color: 'var(--pt-amber-glow)',
              fontFamily: 'var(--pt-data)',
              fontSize: 14,
              fontWeight: 500,
              letterSpacing: '0.12em',
            }}
          >
            +{fx.winAmount.toLocaleString()} vCLAW
          </div>
        </div>
      )}
    </>
  );
}
