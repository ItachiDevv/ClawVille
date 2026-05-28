'use client';

/**
 * iPad / phone touch controls for the cove interior.
 *
 * Critical fix 2026-05-27: cove had no touch input — user could SEE the
 * scene but not move (no WASD on iPad). Mounts two nipplejs joysticks
 * (left = WASD movement, right = arrow-key camera orbit) plus an INTERACT
 * button (E-key proxy for table entry / slot spin / blackjack open / etc).
 *
 * Writes directly to `_coveTouchVec`, `_coveArrowKeys`, and `coveKeys.e`
 * via setters exported from `cove-interior.tsx`. No keyboard-event
 * synthesis — that path is unreliable in iPad Safari for non-printable
 * keys.
 *
 * Gated on `useIsMobile()` — which now correctly detects iPad-on-Mac-UA
 * via `navigator.maxTouchPoints > 1`.
 */

import { useEffect, useRef } from 'react';
import type { JoystickManager } from 'nipplejs';
import { useIsMobile } from '@/hooks/use-is-mobile';
import {
  setCoveTouchVelocity,
  setCoveTouchArrowKey,
  setCoveTouchInteract,
} from '@/lib/three/cove-interior';

export default function CoveMobileControls() {
  const isMobile = useIsMobile();
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const leftJoystickRef = useRef<JoystickManager | null>(null);
  const rightJoystickRef = useRef<JoystickManager | null>(null);

  // Left joystick — WASD movement
  useEffect(() => {
    if (!isMobile || !leftRef.current) {
      if (leftJoystickRef.current) {
        leftJoystickRef.current.destroy();
        leftJoystickRef.current = null;
        setCoveTouchVelocity(0, 0);
      }
      return;
    }
    let destroyed = false;
    import('nipplejs').then((nipplejs) => {
      if (destroyed || !leftRef.current) return;
      const m = nipplejs.create({
        zone: leftRef.current,
        mode: 'static',
        position: { left: '80px', bottom: '80px' },
        size: 120,
        color: 'rgba(255, 255, 255, 0.5)',
        restOpacity: 0.6,
        fadeTime: 100,
      });
      m.on('move', (_, data) => {
        if (!data.angle || data.force === undefined) return;
        const rad = data.angle.radian;
        const force = Math.min(data.force, 1);
        // nipplejs angle: 0=right, π/2=up, π=left, 3π/2=down
        // map to cove input: x = strafe (+ = right), z = forward (+ = into screen forward)
        const x = Math.cos(rad) * force;
        const z = Math.sin(rad) * force;
        setCoveTouchVelocity(x, z);
      });
      m.on('end', () => setCoveTouchVelocity(0, 0));
      leftJoystickRef.current = m;
    });
    return () => {
      destroyed = true;
      if (leftJoystickRef.current) {
        leftJoystickRef.current.destroy();
        leftJoystickRef.current = null;
        setCoveTouchVelocity(0, 0);
      }
    };
  }, [isMobile]);

  // Right joystick — arrow-key camera orbit (left/right = yaw, up/down = pitch)
  useEffect(() => {
    if (!isMobile || !rightRef.current) {
      if (rightJoystickRef.current) {
        rightJoystickRef.current.destroy();
        rightJoystickRef.current = null;
        setCoveTouchArrowKey('left', false);
        setCoveTouchArrowKey('right', false);
        setCoveTouchArrowKey('up', false);
        setCoveTouchArrowKey('down', false);
      }
      return;
    }
    let destroyed = false;
    import('nipplejs').then((nipplejs) => {
      if (destroyed || !rightRef.current) return;
      const m = nipplejs.create({
        zone: rightRef.current,
        mode: 'static',
        position: { right: '80px', bottom: '80px' },
        size: 120,
        color: 'rgba(255, 200, 100, 0.5)',
        restOpacity: 0.6,
        fadeTime: 100,
      });
      const THRESHOLD = 0.3;
      m.on('move', (_, data) => {
        if (!data.angle || data.force === undefined) return;
        const rad = data.angle.radian;
        const force = Math.min(data.force, 1);
        const x = Math.cos(rad) * force;
        const y = Math.sin(rad) * force;
        setCoveTouchArrowKey('right', x > THRESHOLD);
        setCoveTouchArrowKey('left', x < -THRESHOLD);
        setCoveTouchArrowKey('up', y > THRESHOLD);
        setCoveTouchArrowKey('down', y < -THRESHOLD);
      });
      m.on('end', () => {
        setCoveTouchArrowKey('left', false);
        setCoveTouchArrowKey('right', false);
        setCoveTouchArrowKey('up', false);
        setCoveTouchArrowKey('down', false);
      });
      rightJoystickRef.current = m;
    });
    return () => {
      destroyed = true;
      if (rightJoystickRef.current) {
        rightJoystickRef.current.destroy();
        rightJoystickRef.current = null;
      }
    };
  }, [isMobile]);

  if (!isMobile) return null;

  return (
    <>
      {/* Joystick container — mirrors the working /game MobileControls
          structure EXACTLY: a `position:fixed` lifted OUTER container with
          `position:absolute` inner zones at bottom:0. nipplejs places its
          handle relative to the zone; with per-zone `position:fixed` the
          handle landed 80px lower than /game (cove joysticks at 50px vs
          game's 130px from bottom — under the iPad Safari toolbar). The
          outer-container pattern is the one that positions the nipple
          correctly. Lift via safe-area so it clears Safari chrome on real
          iPads. (Fixed 2026-05-28.) */}
      <div
        style={{
          position: 'fixed',
          left: 0,
          bottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 60px), 80px)',
          width: '100vw',
          height: '220px',
          zIndex: 50,
          pointerEvents: 'none',
        }}
      >
        {/* Left zone — movement */}
        <div
          ref={leftRef}
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            width: '50vw',
            height: '220px',
            pointerEvents: 'auto',
            touchAction: 'none',
          }}
        />
        {/* Right zone — camera */}
        <div
          ref={rightRef}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: '50vw',
            height: '220px',
            pointerEvents: 'auto',
            touchAction: 'none',
          }}
        />
      </div>
      {/* INTERACT button — E-key proxy. Tap-and-hold for E. */}
      <button
        type="button"
        aria-label="Interact (E)"
        onTouchStart={(e) => { e.preventDefault(); setCoveTouchInteract(true); }}
        onTouchEnd={(e) => { e.preventDefault(); setCoveTouchInteract(false); }}
        onTouchCancel={(e) => { e.preventDefault(); setCoveTouchInteract(false); }}
        style={{
          position: 'fixed',
          right: 30,
          // Sit above the lifted joystick zone (zone top ≈ 300px from bottom
          // on a device with safe-area); keep it clear of Safari chrome.
          bottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 240px), 260px)',
          width: 72,
          height: 72,
          borderRadius: '50%',
          background: 'rgba(34, 221, 136, 0.85)',
          color: '#0a1628',
          fontWeight: 800,
          fontSize: 22,
          border: '2px solid rgba(255,255,255,0.6)',
          zIndex: 51,
          touchAction: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        E
      </button>
    </>
  );
}
