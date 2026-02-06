'use client';

import { useAvatar } from '@/hooks/use-avatar';
import { AVATAR_SPECIES } from '@legacyapp/shared';

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

export default function AvatarStatusBar() {
  const { data: avatar, isLoading } = useAvatar();

  if (isLoading || !avatar) return null;

  const species = AVATAR_SPECIES.find((s) => s.id === avatar.species);
  const emoji = species?.emoji ?? '?';

  return (
    <div className="legacytheme-panel fixed bottom-4 left-4 z-40 w-auto md:w-48">
      <div className="flex items-center gap-2 md:mb-2">
        <span className="text-xl">{emoji}</span>
        <span className="text-black font-bold text-sm truncate">{avatar.name}</span>
      </div>
      <div className="hidden md:block space-y-1">
        <StatBar label="S" value={avatar.stats.strength} />
        <StatBar label="D" value={avatar.stats.defence} />
        <StatBar label="M" value={avatar.stats.movement} />
      </div>
    </div>
  );
}
