'use client';

import { useNpcStore } from '@/stores/npc';
import { useShallow } from 'zustand/react/shallow';

export default function ArenaHUD() {
  // Consolidate into a single shallow selector — avoids three separate
  // subscriptions and prevents re-renders when unrelated store fields change.
  // useShallow does element-wise comparison so array identity changes from
  // SSE ticks don't trigger re-renders when the content is unchanged.
  const { npcs, combatLog, connected } = useNpcStore(
    useShallow((s) => ({ npcs: s.npcs, combatLog: s.combatLog, connected: s.connected }))
  );

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
          className={`w-2 h-2 rounded-full ${connected ? 'bg-cyan-400' : 'bg-red-400'}`}
        />
        <span className="text-white/60 font-mono">
          {connected ? 'Live' : 'Connecting...'}
        </span>
      </div>

      {/* Combat Log */}
      <div className="bg-[#0a1628]/80 backdrop-blur-md rounded-lg p-3 border border-cyan-500/20 max-h-40 overflow-y-auto">
        <h3 className="text-xs font-bold text-claw-accent font-mono mb-2 uppercase tracking-wide">
          Agent Combat Log
        </h3>
        {combatLog.length === 0 ? (
          <p className="text-white/40 text-xs font-mono">Waiting for engagements...</p>
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
      <div className="bg-[#0a1628]/80 backdrop-blur-md rounded-lg p-3 border border-cyan-500/20">
        <h3 className="text-xs font-bold text-claw-accent font-mono mb-2 uppercase tracking-wide">
          Agent Leaderboard
        </h3>
        <div className="space-y-1">
          {leaderboard.slice(0, 8).map((npc, i) => (
            <div key={npc.id} className="flex items-center gap-2 text-xs">
              <span className="text-white/40 font-mono w-4 text-right">{i + 1}.</span>
              <span className="text-white font-medium truncate flex-1">
                {npc.name}
              </span>
              <span className="text-cyan-300 font-mono w-8 text-right">
                {npc.hp}/{npc.maxHp}
              </span>
              <span className="text-claw-accent font-mono w-6 text-right">
                {npc.inventory.length}
              </span>
            </div>
          ))}
        </div>
        {deadNpcs.length > 0 && (
          <div className="mt-2 pt-2 border-t border-cyan-500/10">
            <p className="text-white/30 text-xs font-mono">
              {deadNpcs.length} agents defeated (rebooting...)
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
