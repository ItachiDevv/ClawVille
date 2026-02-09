'use client';

import { usePet } from '@/hooks/use-pet';
import { PET_SPECIES } from '@legacyapp/shared';
import { useGameStore } from '@/stores/game';

function StatBar({ label, value, max = 20 }: { label: string; value: number; max?: number }) {
  const pct = Math.min(100, Math.round((value / max) * 100));

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-black/70 text-xs font-bold w-4">{label}</span>
      <div className="flex-1 h-2 bg-black/20 rounded-full overflow-hidden">
        <div
          className="h-full bg-green-600 rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-black/60 text-[10px] w-5 text-right">{value}</span>
    </div>
  );
}

export default function PetStatusBar() {
  const { data: pet, isLoading } = usePet();
  const openInventory = useGameStore((s) => s.openInventory);

  if (isLoading || !pet) return null;

  const species = PET_SPECIES.find((s) => s.id === pet.species);
  const emoji = species?.emoji ?? '?';
  const visitedCount = useGameStore((s) => s.visitedBuildings.size);
  const knowledgeCount = (pet.characterConfig as any)?.knowledge?.length ?? 0;

  return (
    <div className="legacytheme-panel fixed bottom-4 left-4 z-40 w-auto md:w-52">
      <div className="flex items-center gap-2 md:mb-2">
        <span className="text-xl">{emoji}</span>
        <span className="text-black font-bold text-sm truncate">{pet.name}</span>
        {/* ClawToken balance */}
        <span className="ml-auto flex items-center gap-1 text-xs font-bold text-yellow-700 bg-yellow-200/60 rounded-full px-2 py-0.5">
          <span className="text-sm">&#x1FA99;</span>
          {pet.clawTokens ?? 100}
        </span>
      </div>
      <div className="hidden md:block space-y-1">
        <StatBar label="S" value={pet.stats.strength} />
        <StatBar label="D" value={pet.stats.defence} />
        <StatBar label="M" value={pet.stats.movement} />
        <div className="flex items-center gap-1.5 pt-1 border-t border-black/10 mt-1">
          <span className="text-black/70 text-[10px] font-bold">Explored</span>
          <div className="flex-1 h-2 bg-black/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all"
              style={{ width: `${Math.round((visitedCount / 15) * 100)}%` }}
            />
          </div>
          <span className="text-black/60 text-[10px] font-bold">{visitedCount}/15</span>
        </div>
        {knowledgeCount > 0 && (
          <div className="flex items-center gap-1.5 text-[10px] text-black/60">
            <span className="font-bold">Learned:</span>
            <span>{knowledgeCount} topics</span>
          </div>
        )}
        <button
          onClick={openInventory}
          className="w-full mt-1 text-[11px] font-bold text-black/70 hover:text-black bg-black/5 hover:bg-black/10 rounded px-2 py-1 transition-colors text-center"
        >
          Inventory
        </button>
      </div>
    </div>
  );
}
