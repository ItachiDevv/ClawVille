'use client';

import { useAvatar } from '@/hooks/use-avatar';
import { AVATAR_SPECIES, KNOWLEDGE_BOOKS } from '@clawville/shared';
import { useGameStore } from '@/stores/game';
import { buildingZones } from '@/lib/pixi/tilemap-data';

function StatBar({ label, value, max = 20, color = 'bg-emerald-400' }: { label: string; value: number; max?: number; color?: string }) {
  const pct = Math.min(100, Math.round((value / max) * 100));

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-white/50 text-[10px] font-bold w-7 uppercase tracking-wide">{label}</span>
      <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-white/40 text-[10px] w-5 text-right font-mono">{value}</span>
    </div>
  );
}

export default function AvatarStatusBar() {
  const { data: avatar, isLoading } = useAvatar();
  const openInventory = useGameStore((s) => s.openInventory);
  const visitedBuildings = useGameStore((s) => s.visitedBuildings);

  if (isLoading || !avatar) return null;

  const species = AVATAR_SPECIES.find((s) => s.id === avatar.species);
  const emoji = species?.emoji ?? '?';
  // Skills learned = distinct knowledge books the avatar has at least one
  // entry from. The raw `characterConfig.knowledge[]` array stores many
  // chunks per book (1 book → ~6 entries), so its length massively
  // over-reports — the bug behind the "61 skills learned" HUD reading.
  const knowledgeEntries: string[] = (avatar.characterConfig as any)?.knowledge ?? [];
  const knowledgeSet = new Set(knowledgeEntries);
  const skillsLearned = knowledgeSet.size === 0
    ? 0
    : KNOWLEDGE_BOOKS.filter((b) => b.knowledgeEntries.some((e) => knowledgeSet.has(e))).length;
  // Filter visited set against current building IDs — defensive in case the
  // prune in loadVisited() missed a stale entry written during this session.
  const validIds = new Set(buildingZones.map((z) => z.id));
  const validVisitedCount = [...visitedBuildings].filter((id) => validIds.has(id)).length;
  const totalBuildings = buildingZones.length;

  return (
    <div className="claw-panel fixed bottom-4 left-4 z-40 w-auto md:w-56 hidden md:block">
      {/* Avatar identity row */}
      <div className="flex items-center gap-2 md:mb-3">
        <span className="text-xl">{emoji}</span>
        <div className="flex-1 min-w-0">
          <span className="text-white font-bold text-sm truncate block">{avatar.name}</span>
          <span className="text-cyan-400/60 text-[10px] font-mono">Lv {avatar.level ?? 1}</span>
        </div>
        {/* Token balance */}
        <span className="flex items-center gap-1 text-[11px] font-bold text-amber-300 bg-amber-500/15 border border-amber-500/20 rounded-full px-2.5 py-0.5">
          <span className="text-xs">&#x1FA99;</span>
          {avatar.clawTokens ?? 100}
        </span>
      </div>

      {/* Stats */}
      <div className="hidden md:block space-y-1.5">
        <StatBar label="STR" value={avatar.stats.strength} color="bg-red-400" />
        <StatBar label="DEF" value={avatar.stats.defence} color="bg-blue-400" />
        <StatBar label="SPD" value={avatar.stats.movement} color="bg-amber-400" />

        {/* Exploration progress */}
        <div className="flex items-center gap-1.5 pt-2 border-t border-white/5 mt-2">
          <span className="text-white/40 text-[10px] font-bold w-7">MAP</span>
          <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-400 rounded-full transition-all"
              style={{ width: `${Math.min(100, Math.round((validVisitedCount / totalBuildings) * 100))}%` }}
            />
          </div>
          <span className="text-white/40 text-[10px] font-mono">{validVisitedCount}/{totalBuildings}</span>
        </div>

        {/* Knowledge counter */}
        {skillsLearned > 0 && (
          <div className="flex items-center gap-1.5 text-[10px] text-cyan-300/60">
            <span>&#x1F4DA;</span>
            <span className="font-bold">{skillsLearned} skill{skillsLearned === 1 ? '' : 's'} learned</span>
          </div>
        )}

        {/* Inventory button */}
        <button
          onClick={openInventory}
          className="w-full mt-2 text-[11px] font-bold text-cyan-300/80 hover:text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 hover:border-cyan-500/30 rounded-lg px-2 py-1.5 transition-all text-center"
        >
          Open Inventory
        </button>
      </div>
    </div>
  );
}
