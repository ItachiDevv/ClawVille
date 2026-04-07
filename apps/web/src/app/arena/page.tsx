'use client';

import dynamic from 'next/dynamic';
import { useNpcStream } from '@/hooks/use-npc-stream';

const Arena3DCanvas = dynamic(() => import('@/components/three/Arena3DCanvas'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-[#061520]">
      <p className="font-clawville text-cyan-400 text-xl animate-pulse">
        Loading 3D Arena...
      </p>
    </div>
  ),
});

const ArenaHUD = dynamic(() => import('@/components/game/arena-hud'), {
  ssr: false,
});

export default function ArenaPage() {
  // Connect to NPC simulation stream
  useNpcStream();

  return (
    <div className="game-container">
      <Arena3DCanvas />
      <ArenaHUD />

      {/* Arena title banner */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
        <div className="bg-[#0a1628]/80 backdrop-blur-md rounded-lg px-6 py-2 border border-cyan-500/20">
          <h1 className="font-clawville text-xl text-claw-accent tracking-wide">
            ClawVille Agent Arena
          </h1>
          <p className="font-mono text-white/50 text-xs text-center">
            WASD to pan | Mouse drag to rotate | Scroll to zoom
          </p>
        </div>
      </div>
    </div>
  );
}
