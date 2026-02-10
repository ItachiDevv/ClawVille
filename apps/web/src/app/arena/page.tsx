'use client';

import dynamic from 'next/dynamic';
import { useNpcStream } from '@/hooks/use-npc-stream';

const ArenaCanvas = dynamic(() => import('@/components/pixi/ArenaCanvas'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-neopets-bg-dark">
      <p className="font-elizapet text-white text-xl animate-pulse">
        Loading Arena...
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
      <ArenaCanvas />
      <ArenaHUD />

      {/* Arena title banner */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
        <div className="bg-black/60 backdrop-blur-sm rounded-lg px-6 py-2 border border-red-500/30">
          <h1 className="font-elizapet text-xl text-red-400 tracking-wide">
            ElizaPets Arena
          </h1>
          <p className="text-white/50 text-xs text-center">
            WASD to move camera
          </p>
        </div>
      </div>
    </div>
  );
}
