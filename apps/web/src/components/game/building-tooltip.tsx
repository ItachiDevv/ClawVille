'use client';

import { useGameStore, type GameState } from '@/stores/game';
import { BUILDING_OPENCLAW_THEMES } from '@legacyapp/shared';
import { NPC_DEFINITIONS } from '@legacyapp/shared';

export default function BuildingTooltip() {
  const hoveredBuilding = useGameStore((s: GameState) => s.hoveredBuilding);
  const mousePosition = useGameStore((s: GameState) => s.mousePosition);

  if (!hoveredBuilding) return null;

  const theme = BUILDING_OPENCLAW_THEMES[hoveredBuilding];
  const npc = NPC_DEFINITIONS.find((n) => n.buildingId === hoveredBuilding);
  if (!theme) return null;

  const focusAreas = theme.focus.split(',').slice(0, 3).map((s) => s.trim());

  return (
    <div
      className="fixed z-50 pointer-events-none"
      style={{
        left: mousePosition.x + 16,
        top: mousePosition.y - 8,
      }}
    >
      <div className="bg-[#0a1628]/95 backdrop-blur-md rounded-lg border border-cyan-500/30 px-3 py-2.5 shadow-[0_0_20px_rgba(0,229,255,0.1)] max-w-[240px]">
        <div className="text-cyan-300 font-bold text-sm">{theme.label}</div>
        <div className="text-cyan-500/60 text-[10px] font-mono uppercase tracking-wider mt-0.5">
          {theme.category}
        </div>
        {npc && (
          <div className="text-white/50 text-xs mt-1.5 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400/60" />
            {npc.name} (NPC)
          </div>
        )}
        <div className="text-white/40 text-[10px] mt-1.5 leading-relaxed">
          {focusAreas.join(' · ')}
        </div>
      </div>
    </div>
  );
}
