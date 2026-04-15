'use client';

import { useEffect, useRef } from 'react';
import type { JoystickManager } from 'nipplejs';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useGameStore } from '@/stores/game';

export default function MobileControls() {
  const isMobile = useIsMobile();
  const leftContainerRef = useRef<HTMLDivElement>(null);
  const rightContainerRef = useRef<HTMLDivElement>(null);
  const leftJoystickRef = useRef<JoystickManager | null>(null);
  const rightJoystickRef = useRef<JoystickManager | null>(null);

  const movementFrozen = useGameStore((s) => s.movementFrozen);
  const nearLocation = useGameStore((s) => s.nearLocation);
  const controlMode = useGameStore((s) => s.controlMode);

  // Explore mode = pure spectator with no character — no movement joystick, no building entry
  const isExplore = controlMode === 'explore';

  // Left joystick — movement (WASD equivalent). Hidden in explore mode (camera-only spectator).
  useEffect(() => {
    if (!isMobile || movementFrozen || isExplore || !leftContainerRef.current) {
      if (leftJoystickRef.current) {
        leftJoystickRef.current.destroy();
        leftJoystickRef.current = null;
        useGameStore.getState().setJoystickVelocity(0, 0);
      }
      return;
    }

    let destroyed = false;

    import('nipplejs').then((nipplejs) => {
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
  }, [isMobile, movementFrozen, isExplore]);

  // Right joystick — camera orbit (arrow key equivalent)
  useEffect(() => {
    if (!isMobile || !rightContainerRef.current) {
      if (rightJoystickRef.current) {
        rightJoystickRef.current.destroy();
        rightJoystickRef.current = null;
        useGameStore.getState().setCameraJoystickVelocity(0, 0);
      }
      return;
    }

    let destroyed = false;

    import('nipplejs').then((nipplejs) => {
      if (destroyed || !rightContainerRef.current) return;

      const manager = nipplejs.create({
        zone: rightContainerRef.current,
        mode: 'static',
        position: { right: '80px', bottom: '80px' },
        size: 120,
        color: 'rgba(100, 200, 255, 0.5)',
        restOpacity: 0.6,
        fadeTime: 100,
      });

      manager.on('move', (_, data) => {
        if (!data.angle || data.force === undefined) return;
        const rad = data.angle.radian;
        const force = Math.min(data.force, 1);
        const vx = Math.cos(rad) * force;
        const vy = -Math.sin(rad) * force; // nipplejs Y is inverted
        useGameStore.getState().setCameraJoystickVelocity(vx, vy);
      });

      manager.on('end', () => {
        useGameStore.getState().setCameraJoystickVelocity(0, 0);
      });

      rightJoystickRef.current = manager;
    });

    return () => {
      destroyed = true;
      if (rightJoystickRef.current) {
        rightJoystickRef.current.destroy();
        rightJoystickRef.current = null;
        useGameStore.getState().setCameraJoystickVelocity(0, 0);
      }
    };
  }, [isMobile]);

  if (!isMobile) return null;

  const handleEnterBuilding = () => {
    const store = useGameStore.getState();
    if (store.nearLocation) {
      store.enterBuilding(store.nearLocation);
    }
  };

  return (
    <div
      className="fixed bottom-0 left-0 z-40 pointer-events-none"
      style={{ width: '100vw', height: '220px' }}
    >
      {/* Left joystick zone — movement (hidden in explore mode: camera-only spectator) */}
      {!movementFrozen && !isExplore && (
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
      )}

      {/* Right joystick zone — camera orbit */}
      <div
        ref={rightContainerRef}
        className="absolute pointer-events-auto"
        style={{
          right: 0,
          bottom: 0,
          width: '220px',
          height: '220px',
          touchAction: 'none',
        }}
      />

      {/* Enter building button — centered between joysticks (hidden in explore mode) */}
      {!movementFrozen && !isExplore && nearLocation && (
        <button
          onClick={handleEnterBuilding}
          className="pointer-events-auto absolute"
          style={{
            left: '50%',
            bottom: '70px',
            transform: 'translateX(-50%)',
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.3)',
            backdropFilter: 'blur(4px)',
            border: '2px solid rgba(255,255,255,0.5)',
            color: 'white',
            fontWeight: 'bold',
            fontSize: '18px',
            touchAction: 'manipulation',
            boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
          }}
          aria-label="Enter building"
        >
          E
        </button>
      )}
    </div>
  );
}
