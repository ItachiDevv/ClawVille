'use client';

import { useEffect, useRef } from 'react';
import { jumpState, JUMP_MAX_HOLD_MS } from '@/lib/three/jump-state';

export default function ChargeBar() {
  const rootRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const root = rootRef.current;
      const fill = fillRef.current;
      if (root && fill) {
        if (jumpState.phase === 'charging') {
          root.style.opacity = '1';
          const pct = Math.min(1, jumpState.holdMs / JUMP_MAX_HOLD_MS);
          fill.style.width = `${(pct * 100).toFixed(1)}%`;
          // Color shifts toward yellow/white as charge approaches full
          if (pct >= 0.95) {
            fill.style.background = 'linear-gradient(90deg, #fff6 0%, #fffa 50%, #ffd54f 100%)';
            fill.style.boxShadow = '0 0 14px rgba(255, 213, 79, 0.8)';
          } else if (pct >= 0.7) {
            fill.style.background = 'linear-gradient(90deg, #00e5ff 0%, #60efff 70%, #ffffff 100%)';
            fill.style.boxShadow = '0 0 10px rgba(0, 229, 255, 0.6)';
          } else {
            fill.style.background = 'linear-gradient(90deg, #00a8cc 0%, #00e5ff 100%)';
            fill.style.boxShadow = '0 0 6px rgba(0, 229, 255, 0.4)';
          }
        } else {
          root.style.opacity = '0';
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={rootRef}
      className="fixed left-1/2 -translate-x-1/2 z-50 pointer-events-none"
      style={{
        bottom: '7.5rem', // sits above avatar-chat-bar (which is bottom-4..6)
        opacity: 0,
        transition: 'opacity 80ms ease-out',
      }}
    >
      <div
        style={{
          width: 240,
          height: 10,
          borderRadius: 6,
          background: 'rgba(10, 22, 40, 0.75)',
          border: '1px solid rgba(0, 229, 255, 0.35)',
          padding: 2,
          boxShadow: '0 0 12px rgba(0, 229, 255, 0.15)',
        }}
      >
        <div
          ref={fillRef}
          style={{
            height: '100%',
            width: '0%',
            borderRadius: 4,
            background: 'linear-gradient(90deg, #00a8cc 0%, #00e5ff 100%)',
            transition: 'background 120ms ease-out',
          }}
        />
      </div>
    </div>
  );
}
