'use client';

import { useEffect, useRef } from 'react';
import type { JoystickManager } from 'nipplejs';
import { useIsMobile } from '@/hooks/use-is-mobile';
import {
  setPlayerTouchCamera,
  setPlayerTouchMove,
} from '@/lib/three/player/player-input';
import { activateTradingFloorUse } from '@/lib/three/trading-floor/trading-floor-interior';
import {
  BAND_BOTTOM_CSS,
  BAND_HEIGHT_CSS,
  TOUCH_LAYOUT,
  USE_BUTTON_BOTTOM_CSS,
} from './trading-floor-touch-layout';

/**
 * Touch controls for the Trading Floor interior.
 *
 * Same two-joystick rig as the kelp realm (the slot's input policy reads the
 * SHARED touch state, not the world store joystick), plus an INTERACT button —
 * phones have no E key, and without it the monitor and the door are desktop-
 * only. Gating is `useIsMobile()` (maxTouchPoints + coarse pointer), never a
 * Tailwind breakpoint: a `md:` query misses iPad Air/Pro and every landscape
 * tablet.
 *
 * ALL the vertical geometry lives in `trading-floor-touch-layout.ts`, because
 * it depends on `env(safe-area-inset-bottom)` and Playwright does not implement
 * that — the browser sweep can only ever see the zero-inset case. The resolver
 * there is swept by a unit test over the inset values a real notched phone
 * produces.
 */

export default function TradingFloorMobileControls() {
  const isMobile = useIsMobile();
  const movementZone = useRef<HTMLDivElement>(null);
  const cameraZone = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMobile || !movementZone.current || !cameraZone.current) return;
    let cancelled = false;
    let movement: JoystickManager | null = null;
    let camera: JoystickManager | null = null;
    void import('nipplejs').then((module) => {
      if (cancelled || !movementZone.current || !cameraZone.current) return;
      movement = module.create({
        zone: movementZone.current,
        mode: 'static',
        position: { left: '80px', bottom: '80px' },
        size: 120,
        color: '#5ae2ff',
        restOpacity: 0.9,
        fadeTime: 100,
      });
      camera = module.create({
        zone: cameraZone.current,
        mode: 'static',
        position: { right: '80px', bottom: '80px' },
        size: 120,
        color: '#bff4ff',
        restOpacity: 0.82,
        fadeTime: 100,
      });
      movement.on('move', (_, data) => {
        if (!data.angle || data.force === undefined) return;
        const force = Math.min(1, data.force);
        setPlayerTouchMove(
          Math.cos(data.angle.radian) * force,
          Math.sin(data.angle.radian) * force,
        );
      });
      movement.on('end', () => setPlayerTouchMove(0, 0));
      camera.on('move', (_, data) => {
        if (!data.angle || data.force === undefined) return;
        const force = Math.min(1, data.force);
        setPlayerTouchCamera(
          Math.cos(data.angle.radian) * force,
          Math.sin(data.angle.radian) * force,
        );
      });
      camera.on('end', () => setPlayerTouchCamera(0, 0));
    });
    return () => {
      cancelled = true;
      movement?.destroy();
      camera?.destroy();
      setPlayerTouchMove(0, 0);
      setPlayerTouchCamera(0, 0);
    };
  }, [isMobile]);

  if (!isMobile) return null;

  const zoneStyle = {
    position: 'absolute' as const,
    bottom: 0,
    width: '50vw',
    // The zones shrink WITH the band on a short viewport, or the touch area
    // would reach above the band's own top edge and back into the USE button.
    height: BAND_HEIGHT_CSS,
    pointerEvents: 'auto' as const,
    touchAction: 'none',
  };

  return (
    <>
      {/* Interact — the touch equivalent of E. Anchored to the TOP of the
          joystick band so it can never overlap a zone, then clamped so its own
          top stays on screen. */}
      <button
        type="button"
        aria-label="Interact"
        // The SAME action the keyboard E edge runs, not a re-implementation of
        // its ladder. The v2 pass that added the desk seats first left the sit
        // toggle inside the keyboard-only handler and this button kept a
        // two-case copy, which made the founder's "go up and sit at" request
        // unreachable on every phone and iPad.
        onClick={() => {
          activateTradingFloorUse();
        }}
        style={{
          position: 'fixed',
          right: 24,
          bottom: USE_BUTTON_BOTTOM_CSS,
          zIndex: 51,
          width: TOUCH_LAYOUT.useSize,
          height: TOUCH_LAYOUT.useSize,
          borderRadius: '50%',
          border: '1.5px solid rgba(90,226,255,0.6)',
          background: 'rgba(6,18,30,0.86)',
          color: '#bff4ff',
          font: '700 15px monospace',
          letterSpacing: '0.05em',
          touchAction: 'manipulation',
        }}
      >
        USE
      </button>
      <div
        style={{
          position: 'fixed',
          left: 0,
          bottom: BAND_BOTTOM_CSS,
          width: '100vw',
          height: BAND_HEIGHT_CSS,
          zIndex: 50,
          pointerEvents: 'none',
        }}
      >
        <div
          ref={movementZone}
          aria-label="Movement joystick"
          style={{ ...zoneStyle, left: 0 }}
        />
        <div
          ref={cameraZone}
          aria-label="Camera joystick"
          style={{ ...zoneStyle, right: 0 }}
        />
      </div>
    </>
  );
}
