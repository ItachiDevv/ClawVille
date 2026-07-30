'use client';

import { useEffect, useRef } from 'react';
import type { JoystickManager } from 'nipplejs';
import { useIsMobile } from '@/hooks/use-is-mobile';
import {
  setPlayerTouchCamera,
  setPlayerTouchMove,
} from '@/lib/three/player/player-input';

export default function KelpRealmMobileControls() {
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
      movement = module.create({ zone: movementZone.current, mode: 'static', position: { left: '80px', bottom: '80px' }, size: 120, color: '#6fffe1', restOpacity: 0.9, fadeTime: 100 });
      camera = module.create({ zone: cameraZone.current, mode: 'static', position: { right: '80px', bottom: '80px' }, size: 120, color: '#b8ffe9', restOpacity: 0.82, fadeTime: 100 });
      movement.on('move', (_, data) => {
        if (!data.angle || data.force === undefined) return;
        const force = Math.min(1, data.force);
        setPlayerTouchMove(Math.cos(data.angle.radian) * force, Math.sin(data.angle.radian) * force);
      });
      movement.on('end', () => setPlayerTouchMove(0, 0));
      camera.on('move', (_, data) => {
        if (!data.angle || data.force === undefined) return;
        const force = Math.min(1, data.force);
        setPlayerTouchCamera(Math.cos(data.angle.radian) * force, Math.sin(data.angle.radian) * force);
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
  const zoneStyle = { position: 'absolute' as const, bottom: 0, width: '50vw', height: 220, pointerEvents: 'auto' as const, touchAction: 'none' };
  return (
    <div style={{ position: 'fixed', left: 0, bottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 60px), 80px)', width: '100vw', height: 220, zIndex: 50, pointerEvents: 'none' }}>
      <div ref={movementZone} aria-label="Movement joystick" style={{ ...zoneStyle, left: 0 }} />
      <div ref={cameraZone} aria-label="Camera joystick" style={{ ...zoneStyle, right: 0 }} />
    </div>
  );
}
