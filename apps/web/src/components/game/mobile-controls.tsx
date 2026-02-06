'use client';

import { useEffect, useRef } from 'react';
import type { JoystickManager } from 'nipplejs';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useGameStore } from '@/stores/game';

export default function MobileControls() {
  const isMobile = useIsMobile();
  const joystickContainerRef = useRef<HTMLDivElement>(null);
  const joystickInstanceRef = useRef<JoystickManager | null>(null);

  const movementFrozen = useGameStore((s) => s.movementFrozen);
  const nearLocation = useGameStore((s) => s.nearLocation);

  useEffect(() => {
    if (!isMobile || movementFrozen || !joystickContainerRef.current) {
      // Destroy joystick if conditions no longer met
      if (joystickInstanceRef.current) {
        joystickInstanceRef.current.destroy();
        joystickInstanceRef.current = null;
        useGameStore.getState().setJoystickVelocity(0, 0);
      }
      return;
    }

    let destroyed = false;

    // Dynamic import nipplejs to avoid SSR issues
    import('nipplejs').then((nipplejs) => {
      if (destroyed || !joystickContainerRef.current) return;

      const manager = nipplejs.create({
        zone: joystickContainerRef.current,
        mode: 'static',
        position: { left: '60px', bottom: '60px' },
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

      joystickInstanceRef.current = manager;
    });

    return () => {
      destroyed = true;
      if (joystickInstanceRef.current) {
        joystickInstanceRef.current.destroy();
        joystickInstanceRef.current = null;
        useGameStore.getState().setJoystickVelocity(0, 0);
      }
    };
  }, [isMobile, movementFrozen]);

  if (!isMobile || movementFrozen) return null;

  const handleEnterBuilding = () => {
    const store = useGameStore.getState();
    if (store.nearLocation) {
      store.enterBuilding(store.nearLocation);
    }
  };

  return (
    <div className="fixed bottom-0 left-0 z-40 pointer-events-none" style={{ width: '200px', height: '200px' }}>
      {/* Joystick zone */}
      <div
        ref={joystickContainerRef}
        className="absolute inset-0 pointer-events-auto"
        style={{ touchAction: 'none' }}
      />

      {/* Action button - "E" to enter building */}
      {nearLocation && (
        <button
          onClick={handleEnterBuilding}
          className="pointer-events-auto absolute bottom-4 right-[-60px] w-14 h-14 rounded-full bg-white/30 backdrop-blur-sm border-2 border-white/50 flex items-center justify-center text-white font-bold text-lg shadow-lg active:bg-white/50 transition-colors"
          style={{ touchAction: 'manipulation' }}
          aria-label="Enter building"
        >
          E
        </button>
      )}
    </div>
  );
}
