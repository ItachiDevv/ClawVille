'use client';

/**
 * ActivityMobileControls — chunk #12 mobile parity layer for the activity
 * route (`/activity/[activityId]/[roomId]`).
 *
 * Why a separate component from `mobile-controls.tsx`:
 *   - The open-world `MobileControls` mounts a left joystick (movement) +
 *     right joystick (camera orbit) + an "E" enter-building button. Those
 *     wirings (writing into `useGameStore.joystickVelocity`, gating on
 *     `nearLocation` etc.) are open-world concepts that don't apply mid-
 *     match.
 *   - The activity route uses left-joystick movement (same `joystickVelocity`
 *     plumbing — `useActivityInput` already subscribes to it) and replaces
 *     the right joystick + E button with two thumb action buttons:
 *
 *         Bumper Shells: A = boost, B = use power-up.
 *         Reef Race: A = jump, B = use queued item.
 *
 *     The shared event carries Bumper's bit values. `useActivityInput`
 *     translates those semantics at the Reef activity boundary.
 *
 *   - Touch targets ≥ 44px (WCAG 2.1 AA — frontend-spec §11.1).
 *   - `navigator.vibrate(20)` haptic feedback on press if available.
 *
 * Spec: `.claude/plans/q2-research/frontend-spec.md` §11.1.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JoystickManager } from 'nipplejs';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useGameStore } from '@/stores/game';
import { registerInputReset } from '@/lib/three/input-reset';
import {
  ACTION_BIT_BOOST,
  ACTION_BIT_USE_POWERUP,
} from '@/hooks/useActivityInput';

const HAPTIC_PRESS_MS = 18;

function vibrate(ms: number) {
  if (typeof navigator === 'undefined') return;
  // Type guard — `vibrate` is widely supported on Android Chrome but missing
  // on iOS Safari. The DOM lib types vibrate's parameter as `Iterable<number>`
  // (newer DOM lib) — passing an array satisfies both the new and old shapes.
  const v = (
    navigator as Navigator & {
      vibrate?: (p: number | number[] | Iterable<number>) => boolean;
    }
  ).vibrate;
  if (typeof v === 'function') {
    try {
      v.call(navigator, [ms]);
    } catch {
      /* silent — some browsers throw on user-engagement requirements */
    }
  }
}

function dispatchActionBit(bit: number) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('clawville:activity-action', {
      detail: { bit },
    }),
  );
}

export interface ActivityMobileControlsProps {
  /** When false, the buttons render but no longer dispatch actions (paused
   *  / pre-match / post-match). Joystick stays alive throughout because
   *  the input hook gates the actual send loop on `enabled`. */
  active: boolean;
  activityId: string;
}

export default function ActivityMobileControls({
  active,
  activityId,
}: ActivityMobileControlsProps) {
  const isMobile = useIsMobile();
  const leftContainerRef = useRef<HTMLDivElement>(null);
  const leftJoystickRef = useRef<JoystickManager | null>(null);

  // Per-button "just pressed" flash — drives the expanding glow ring via CSS.
  // Cleared after FEEDBACK_MS so repeated rapid presses re-trigger the anim.
  const [boostFlash, setBoostFlash] = useState(0);
  const [powerupFlash, setPowerupFlash] = useState(0);
  const FEEDBACK_MS = 280;

  // S7 — zero the joystick on window focus loss/regain. A touch can be
  // interrupted without a nipplejs 'end' when a window steals focus, stranding
  // the velocity (the avatar keeps driving). Shared with all input vectors.
  useEffect(() => registerInputReset(() => useGameStore.getState().setJoystickVelocity(0, 0)), []);

  // Left joystick — same plumbing as `mobile-controls.tsx`. We write into
  // the same `joystickVelocity` slot so `useActivityInput` picks it up
  // through its existing subscribe (no second wire path).
  useEffect(() => {
    if (!isMobile || !leftContainerRef.current) {
      if (leftJoystickRef.current) {
        leftJoystickRef.current.destroy();
        leftJoystickRef.current = null;
        useGameStore.getState().setJoystickVelocity(0, 0);
      }
      return;
    }

    let destroyed = false;
    void import('nipplejs').then((nipplejs) => {
      if (destroyed || !leftContainerRef.current) return;
      const manager = nipplejs.create({
        zone: leftContainerRef.current,
        mode: 'static',
        position: { left: '80px', bottom: '80px' },
        size: 120,
        color: 'rgba(255, 255, 255, 0.5)',
        restOpacity: 0.6,
        fadeTime: 100,
      });
      manager.on('move', (_, data) => {
        if (!data.angle || data.force === undefined) return;
        const rad = data.angle.radian;
        const force = Math.min(data.force, 1);
        const vx = Math.cos(rad) * force;
        const vy = -Math.sin(rad) * force; // nipplejs Y is inverted
        useGameStore.getState().setJoystickVelocity(vx, vy);
      });
      manager.on('end', () => {
        useGameStore.getState().setJoystickVelocity(0, 0);
      });
      leftJoystickRef.current = manager;
    });

    return () => {
      destroyed = true;
      if (leftJoystickRef.current) {
        leftJoystickRef.current.destroy();
        leftJoystickRef.current = null;
        useGameStore.getState().setJoystickVelocity(0, 0);
      }
    };
  }, [isMobile]);

  // Shared A semantic: one-shot Bumper boost or one-shot Reef jump. The input
  // hook translates the same event bit at the per-activity boundary.
  const handleBoostPress = useCallback(() => {
    if (!active) return;
    vibrate(HAPTIC_PRESS_MS);
    dispatchActionBit(ACTION_BIT_BOOST);
    // Monotonic counter flips the glow-ring key so the CSS anim restarts
    // even on rapid repeat taps.
    setBoostFlash((n) => n + 1);
  }, [active]);

  const handlePowerUpPress = useCallback(() => {
    if (!active) return;
    vibrate(HAPTIC_PRESS_MS);
    dispatchActionBit(ACTION_BIT_USE_POWERUP);
    setPowerupFlash((n) => n + 1);
  }, [active]);

  if (!isMobile) return null;

  return (
    <div
      className="fixed bottom-0 left-0 z-40 pointer-events-none"
      style={{ width: '100vw', height: '220px' }}
    >
      {/* Left joystick zone — movement */}
      <div
        ref={leftContainerRef}
        className="absolute pointer-events-auto"
        style={{
          left: 0,
          bottom: 0,
          width: '220px',
          height: '220px',
          touchAction: 'none',
        }}
      />

      {/* Right thumb cluster — A (boost) + B (power-up) */}
      <style>{`
        @keyframes cv-btn-pulse {
          0%   { transform: translate(-50%, -50%) scale(1);   opacity: 0.9; }
          100% { transform: translate(-50%, -50%) scale(1.9); opacity: 0;   }
        }
        @keyframes cv-btn-press {
          0%   { transform: scale(1); }
          30%  { transform: scale(0.88); }
          100% { transform: scale(1); }
        }
      `}</style>
      <div
        className="absolute pointer-events-auto"
        data-hud-interactive="true"
        style={{
          right: 24,
          bottom: 60,
          display: 'flex',
          gap: 14,
          alignItems: 'flex-end',
        }}
      >
        <div style={{ position: 'relative', width: 64, height: 64 }}>
          {boostFlash > 0 && (
            <span
              key={`boost-flash-${boostFlash}`}
              aria-hidden
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: 64,
                height: 64,
                borderRadius: '50%',
                border: '3px solid rgba(125, 211, 252, 0.95)',
                pointerEvents: 'none',
                animation: `cv-btn-pulse ${FEEDBACK_MS}ms ease-out forwards`,
              }}
            />
          )}
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              handleBoostPress();
            }}
            aria-label={activityId === 'reef-race' ? 'Jump' : 'Boost'}
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background:
                'radial-gradient(circle at 35% 30%, rgba(125, 211, 252, 0.95), rgba(56, 189, 248, 0.65) 60%, rgba(15, 31, 58, 0.95) 100%)',
              border: '2px solid rgba(186, 230, 253, 0.85)',
              color: '#0c1830',
              fontWeight: 900,
              fontSize: 22,
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              letterSpacing: '0.05em',
              boxShadow: '0 4px 18px rgba(56, 189, 248, 0.45)',
              cursor: 'pointer',
              touchAction: 'manipulation',
              opacity: active ? 1 : 0.5,
              animation: boostFlash > 0 ? `cv-btn-press ${FEEDBACK_MS}ms ease-out` : undefined,
            }}
          >
            A
          </button>
        </div>
        <div style={{ position: 'relative', width: 64, height: 64 }}>
          {powerupFlash > 0 && (
            <span
              key={`powerup-flash-${powerupFlash}`}
              aria-hidden
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: 64,
                height: 64,
                borderRadius: '50%',
                border: '3px solid rgba(252, 211, 77, 0.95)',
                pointerEvents: 'none',
                animation: `cv-btn-pulse ${FEEDBACK_MS}ms ease-out forwards`,
              }}
            />
          )}
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              handlePowerUpPress();
            }}
            aria-label="Use power-up"
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background:
                'radial-gradient(circle at 35% 30%, rgba(252, 211, 77, 0.95), rgba(245, 158, 11, 0.7) 60%, rgba(58, 31, 6, 0.95) 100%)',
              border: '2px solid rgba(254, 243, 199, 0.9)',
              color: '#1f1503',
              fontWeight: 900,
              fontSize: 22,
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              letterSpacing: '0.05em',
              boxShadow: '0 4px 18px rgba(245, 158, 11, 0.5)',
              cursor: 'pointer',
              touchAction: 'manipulation',
              animation: powerupFlash > 0 ? `cv-btn-press ${FEEDBACK_MS}ms ease-out` : undefined,
              opacity: active ? 1 : 0.5,
            }}
          >
            B
          </button>
        </div>
      </div>
    </div>
  );
}
