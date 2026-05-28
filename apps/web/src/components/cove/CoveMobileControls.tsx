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
      {/* Left joystick zone — movement.
          `bottom: max(env(safe-area-inset-bottom), 24px)` lifts the nipple
          above iOS Safari's bottom toolbar + home-indicator safe area on
          real iPads (without this the nipple sits IN the viewport but
          UNDER Safari's chrome — invisible/untappable). */}
      <div
        ref={leftRef}
        style={{
          position: 'fixed',
          left: 0,
          bottom: 'max(env(safe-area-inset-bottom, 0px), 24px)',
          width: '50vw',
          height: '240px',
          zIndex: 50,
          pointerEvents: 'auto',
          touchAction: 'none',
        }}
      />
      {/* Right joystick zone — camera */}
      <div
        ref={rightRef}
        style={{
          position: 'fixed',
          right: 0,
          bottom: 'max(env(safe-area-inset-bottom, 0px), 24px)',
          width: '50vw',
          height: '240px',
          zIndex: 50,
          pointerEvents: 'auto',
          touchAction: 'none',
        }}
      />
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
          bottom: 260,
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
