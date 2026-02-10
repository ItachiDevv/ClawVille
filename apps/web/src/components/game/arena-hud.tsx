'use client';

import { useNpcStore } from '@/stores/npc';

export default function ArenaHUD() {
  const npcs = useNpcStore((s) => s.npcs);
  const combatLog = useNpcStore((s) => s.combatLog);
  const connected = useNpcStore((s) => s.connected);

  // Leaderboard: sort by inventory size (loot), then HP
  const leaderboard = [...npcs]
    .filter((n) => !n.isDead)
    .sort((a, b) => b.inventory.length - a.inventory.length || b.hp - a.hp);

  const deadNpcs = npcs.filter((n) => n.isDead);

  return (
    <div className="absolute bottom-4 left-4 z-20 flex flex-col gap-3 pointer-events-auto max-w-xs">
      {/* Connection status */}
      <div className="flex items-center gap-2 text-xs">
        <span
          className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`}
        />
        <span className="text-white/60 font-mono">
          {connected ? 'Live' : 'Connecting...'}
        </span>
      </div>

      {/* Combat Log */}
      <div className="bg-black/60 backdrop-blur-sm rounded-lg p-3 border border-white/10 max-h-40 overflow-y-auto">
        <h3 className="text-xs font-bold text-neopets-yellow mb-2 uppercase tracking-wide">
          Combat Log
        </h3>
        {combatLog.length === 0 ? (
          <p className="text-white/40 text-xs">Waiting for battles...</p>
        ) : (
          <div className="space-y-1">
            {combatLog.slice(-5).reverse().map((entry, i) => (
              <p key={i} className="text-white/80 text-xs leading-tight">
                {entry}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Leaderboard */}
      <div className="bg-black/60 backdrop-blur-sm rounded-lg p-3 border border-white/10">
        <h3 className="text-xs font-bold text-neopets-yellow mb-2 uppercase tracking-wide">
          Leaderboard
        </h3>
        <div className="space-y-1">
          {leaderboard.slice(0, 8).map((npc, i) => (
            <div key={npc.id} className="flex items-center gap-2 text-xs">
              <span className="text-white/40 w-4 text-right">{i + 1}.</span>
              <span className="text-white font-medium truncate flex-1">
                {npc.name}
              </span>
              <span className="text-red-300 w-8 text-right">
                {npc.hp}/{npc.maxHp}
              </span>
              <span className="text-yellow-300 w-6 text-right">
                {npc.inventory.length}
              </span>
            </div>
          ))}
        </div>
        {deadNpcs.length > 0 && (
          <div className="mt-2 pt-2 border-t border-white/10">
            <p className="text-white/30 text-xs">
              {deadNpcs.length} defeated (respawning...)
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
