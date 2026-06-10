'use client';

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { JoystickManager } from 'nipplejs';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useGameStore } from '@/stores/game';
import { setJumpPressed } from '@/lib/three/jump-state';

export default function MobileControls() {
  const isMobile = useIsMobile();
  const leftContainerRef = useRef<HTMLDivElement>(null);
  const rightContainerRef = useRef<HTMLDivElement>(null);
  const leftJoystickRef = useRef<JoystickManager | null>(null);
  const rightJoystickRef = useRef<JoystickManager | null>(null);

  const movementFrozen = useGameStore((s) => s.movementFrozen);
  const nearLocation = useGameStore((s) => s.nearLocation);
  const controlMode = useGameStore((s) => s.controlMode);
  // When a chat panel is open (building chat or the Nori system-agent
  // overlay) the chat input sits at the bottom of the screen. With the
  // joystick lift (2026-05-28) the nipples now occupy the same band and
  // float over the text input. Suppress BOTH joysticks while any chat is
  // open — you're talking, not walking.
  const buildingChatOpen = useGameStore((s) => s.chatOpen);
  const systemAgentChatOpen = useGameStore((s) => s.guideChatOpen);
  const chatActive = buildingChatOpen || systemAgentChatOpen;

  // Explore mode = pure spectator with no character — no movement joystick, no building entry
  const isExplore = controlMode === 'explore';
  const canJump = controlMode === 'player' || controlMode === 'npc';
  // Joysticks hidden entirely while a chat panel is open.
  const hideControls = chatActive;

  useEffect(() => {
    if (!isMobile || movementFrozen || hideControls || !canJump) {
      setJumpPressed(false);
    }
  }, [canJump, hideControls, isMobile, movementFrozen]);

  const handleJumpPress = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setJumpPressed(true);
  }, []);

  const handleJumpRelease = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setJumpPressed(false);
  }, []);

  // Left joystick — movement/pan. In explore mode it drives the free-roam spectator
  // camera via WASDCameraController (World3DCanvas.tsx) reading joystickVelocity.
  useEffect(() => {
    if (!isMobile || movementFrozen || hideControls || !leftContainerRef.current) {
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
  }, [isMobile, movementFrozen, hideControls]);

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
  }, [isMobile, hideControls]);

  if (!isMobile) return null;
  // Chat open → suppress the whole control layer (joysticks would float over
  // the chat input at the bottom of the screen).
  if (hideControls) return null;

  const handleEnterBuilding = () => {
    const store = useGameStore.getState();
    if (store.nearLocation) {
      store.enterBuilding(store.nearLocation);
    }
  };

  return (
    <div
      className="fixed left-0 z-40 pointer-events-none"
      style={{
        // Lift above iOS Safari bottom toolbar + home-indicator safe area.
        // Without this the nipples render INSIDE the viewport but UNDER
        // Safari's chrome on a real iPad — invisible/untappable.
        // Min 32px so it stays clear even without safe-area (devtools/etc).
        bottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 60px), 80px)',
        width: '100vw',
        height: '220px',
      }}
    >
      {/* Left joystick zone — movement / explore-mode camera pan */}
      {!movementFrozen && (
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

      {/* Building enter is now owned by the bottom-center floating prompt
          in `location-hud.tsx` (single source of truth, bigger tap target). */}
      {!movementFrozen && canJump && (
        <button
          type="button"
          aria-label="Jump. Hold to charge, release to launch."
          onPointerDown={handleJumpPress}
          onPointerUp={handleJumpRelease}
          onPointerCancel={handleJumpRelease}
          onLostPointerCapture={() => setJumpPressed(false)}
          onContextMenu={(event) => event.preventDefault()}
          className="absolute right-5 z-10 flex h-16 w-16 select-none flex-col items-center justify-center rounded-full border border-cyan-200/60 bg-cyan-500/90 text-white shadow-[0_0_24px_rgba(34,211,238,0.45)] backdrop-blur-md active:translate-y-0.5 active:bg-cyan-400"
          style={{
            bottom: 'clamp(7rem, 38vw, 10.5rem)',
            right: 'max(calc(env(safe-area-inset-right, 0px) + 18px), 18px)',
            touchAction: 'none',
            WebkitUserSelect: 'none',
          }}
        >
          <span className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-950/70">
            Hold
          </span>
          <span className="text-sm font-black leading-none">Jump</span>
        </button>
      )}
    </div>
  );
}
