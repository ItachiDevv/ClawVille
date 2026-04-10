'use client';

import { useGameStore } from '@/stores/game';
import { usePet } from '@/hooks/use-pet';
import { PET_SPECIES, PET_COLORS, PET_ARCHETYPES } from '@clawville/shared';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';

export default function PetSettingsModal() {
  const { settingsModalOpen, setSettingsModalOpen } = useGameStore();
  const { data: pet } = usePet();

  if (!pet) return null;

  const species = PET_SPECIES.find((s) => s.id === pet.species);
  const color = PET_COLORS.find((c) => c.id === pet.color);
  const archetype = PET_ARCHETYPES.find((a) => a.id === pet.archetype);

  return (
    <Dialog open={settingsModalOpen} onOpenChange={setSettingsModalOpen}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-xl flex items-center gap-2">
                {species?.emoji} {pet.name}
              </DialogTitle>
              <DialogDescription className="mt-1">
                Your agent profile
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <button
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-black/40 text-white flex items-center justify-center font-bold transition-colors"
                aria-label="Close"
              >
                X
              </button>
            </DialogClose>
          </div>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 p-6 space-y-5">
          {/* Pet sprite placeholder */}
          <div className="flex justify-center">
            <div
              className="w-24 h-24 rounded-full border-4 border-white/50 shadow-lg flex items-center justify-center text-4xl"
              style={{ backgroundColor: color?.hex || '#ccc' }}
            >
              {species?.emoji}
            </div>
          </div>

          {/* Info grid */}
          <div className="grid grid-cols-2 gap-3">
            <InfoCard label="Species" value={species?.name || pet.species} />
            <InfoCard label="Color" value={color?.name || pet.color} />
            <InfoCard
              label="Gender"
              value={pet.gender === 'male' ? 'Male' : 'Female'}
            />
            <InfoCard
              label="Archetype"
              value={archetype?.label || pet.archetype}
            />
          </div>

          {/* Archetype details */}
          {archetype && (
            <div className="bg-white/30 rounded-lg p-3 space-y-2">
              <h3 className="font-bold text-sm text-white">
                {archetype.label}
              </h3>
              <p className="text-xs text-white/70">{archetype.description}</p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {archetype.adjectives.map((adj) => (
                  <span
                    key={adj}
                    className="text-xs bg-yellow-600/20 text-black/80 rounded-full px-2 py-0.5 font-medium"
                  >
                    {adj}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="space-y-2">
            <h3 className="font-bold text-sm text-white">Stats</h3>
            <div className="space-y-1.5">
              <StatBar label="Strength" value={pet.stats?.strength ?? 10} />
              <StatBar label="Defence" value={pet.stats?.defence ?? 10} />
              <StatBar label="Movement" value={pet.stats?.movement ?? 10} />
            </div>
          </div>

          {/* Personality */}
          {pet.personality && (
            <div className="space-y-2">
              <h3 className="font-bold text-sm text-white">Personality</h3>
              <div className="grid grid-cols-3 gap-2">
                <PersonalityItem
                  label="Habitat"
                  value={formatPersonalityValue(pet.personality.habitat)}
                />
                <PersonalityItem
                  label="Hobby"
                  value={formatPersonalityValue(pet.personality.hobby)}
                />
                <PersonalityItem
                  label="Greeting"
                  value={formatPersonalityValue(pet.personality.greeting)}
                />
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/30 rounded-lg px-3 py-2">
      <p className="text-xs text-white/60 font-medium">{label}</p>
      <p className="text-sm text-white font-bold">{value}</p>
    </div>
  );
}

function StatBar({ label, value }: { label: string; value: number }) {
  const maxStat = 20;
  const percentage = Math.min((value / maxStat) * 100, 100);

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-white/70 font-medium w-16">{label}</span>
      <div className="flex-1 h-3 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-yellow-500 to-yellow-600 rounded-full transition-all"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-xs text-white/70 font-bold w-6 text-right">
        {value}
      </span>
    </div>
  );
}

function PersonalityItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/30 rounded-lg px-2 py-1.5 text-center">
      <p className="text-[10px] text-white/60 font-medium">{label}</p>
      <p className="text-xs text-white font-bold truncate">{value}</p>
    </div>
  );
}

function formatPersonalityValue(value: string): string {
  return value
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
