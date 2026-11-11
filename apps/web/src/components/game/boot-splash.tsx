'use client';

import { usePathname } from 'next/navigation';

/**
 * Server-rendered /game boot splash (perf/game-load step 1, 2026-11-11).
 *
 * Problem: the /game page renders `null` on the server and on the first
 * client render (hydration mount gate), and `WorldStageRoot` only renders
 * route children once `stageReady`. The HTML a phone receives is an empty
 * stage, so it paints nothing until the ~3 MiB HUD bundle has downloaded,
 * parsed and hydrated (probe: first paint 9.1 s on the 4x CPU / slow 4G
 * profile).
 *
 * Fix: this component is part of the (world) route-group layout, so its
 * markup is in the server HTML. It draws the same static frame as
 * `SeaLoadingScreen` (ocean gradient, banner, "Dropping in...", empty bar).
 * It holds no state and runs no effects. It sits above the stage
 * transition cover until the handoff. It hides through CSS when
 * `releaseBootSplash()` sets `data-cv-boot-splash="done"` on <html>:
 *   - `SeaLoadingScreen` calls it in a layout effect, so the live loader
 *     replaces the splash in the same frame (the live loader skips its
 *     fade-in entrance when it takes over from the splash);
 *   - the /game page calls it on mount, which covers a return visit where
 *     the world scene already ran and no loader mounts.
 * React never removes or mutates the splash node itself, so reconciliation
 * stays safe. The attribute stays set for the life of the document, so a
 * later client-side visit to /game never shows the splash again.
 */
export const BOOT_SPLASH_ID = 'cv-boot-splash';
const DONE_ATTR = 'data-cv-boot-splash';

export function isBootSplashShowing(): boolean {
  if (typeof document === 'undefined') return false;
  return (
    document.documentElement.getAttribute(DONE_ATTR) !== 'done' &&
    document.getElementById(BOOT_SPLASH_ID) !== null
  );
}

export function releaseBootSplash(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute(DONE_ATTR, 'done');
}

export function BootSplash() {
  const pathname = usePathname();
  if (pathname !== '/game') return null;
  return (
    <div
      id={BOOT_SPLASH_ID}
      role="status"
      aria-label="Loading ClawVille"
      style={{
        position: 'fixed',
        inset: 0,
        // Above the stage transition cover (z 9999), which can hydrate before
        // the /game page bundle. Failure UIs release the splash (see
        // WorldStageRoot), so this never hides an error control.
        zIndex: 10000,
        pointerEvents: 'none',
        background: 'linear-gradient(180deg, #060e1f 0%, #0a1628 30%, #0d2137 65%, #0e2d45 100%)',
      }}
    >
      <style>{`html[${DONE_ATTR}="done"] #${BOOT_SPLASH_ID}{display:none}`}</style>
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
        }}
      >
        {/* Same pre-sized brand asset as SeaLoadingScreen; no image optimizer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/clawville-banner-v2-1x.webp"
          srcSet="/brand/clawville-banner-v2-1x.webp 1x, /brand/clawville-banner-v2-2x.webp 2x"
          width={294}
          height={88}
          alt=""
          fetchPriority="high"
          style={{ width: 'auto', height: 'clamp(32px, 6vw, 56px)' }}
        />
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
        <div
          aria-hidden="true"
          style={{
            width: '180px',
            height: '4px',
            borderRadius: '99px',
            background: 'rgba(45,212,191,0.12)',
            border: '1px solid rgba(45,212,191,0.18)',
          }}
        />
        {/* Same rows as SeaLoadingScreen's first state, so the logo block keeps
            its height and does not jump at the handoff. */}
        <div
          aria-hidden="true"
          style={{
            fontFamily: 'var(--font-oxanium), sans-serif',
            fontSize: '10px',
            color: 'rgba(125,211,252,0.55)',
            letterSpacing: '0.18em',
            textAlign: 'center',
            lineHeight: 1.45,
          }}
        >
          0%
          <div style={{ fontSize: '9px', opacity: 0.7, marginTop: 2 }}>Downloading assets…</div>
        </div>
        <div aria-hidden="true" style={{ display: 'flex', gap: '6px' }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                display: 'inline-block',
                width: '5px',
                height: '5px',
                borderRadius: '50%',
                background: '#2dd4bf',
                opacity: 0.35,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
