'use client';

import { useQuery } from '@tanstack/react-query';
import { useAvatar } from '@/hooks/use-avatar';
import { AVATAR_SPECIES, KNOWLEDGE_BOOKS } from '@clawville/shared';
import { useGameStore } from '@/stores/game';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { buildingZones } from '@/lib/pixi/tilemap-data';
import { api } from '@/lib/api';

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
  const openWalletLink = useGameStore((s) => s.openWalletLink);
  const visitedBuildings = useGameStore((s) => s.visitedBuildings);
  const controlMode = useGameStore((s) => s.controlMode);
  const isMobile = useIsMobile();
  // Guest accounts run an ALL-DEMO economy (founder ruling 2026-07-06): their
  // tokens are demo-only, so the balance chip must say so. Shares the SAME
  // react-query cache key as game/page.tsx (['auth-me'] + api.me()), so this
  // adds no extra network round trip.
  const { data: authData } = useQuery({
    queryKey: ['auth-me'],
    queryFn: async () => {
      try {
        return await api.me();
      } catch {
        return null;
      }
    },
    retry: false,
  });
  const isGuest = !!(authData as any)?.user?.isGuest;

  if (isLoading) return null;
  // Hide on ALL touch devices (incl. iPad Air/Pro which exceed Tailwind's
  // md: breakpoint) so it never covers the mobile-controls left joystick.
  if (isMobile) return null;

  if (!avatar) {
    const validIds = new Set(buildingZones.map((z) => z.id));
    const validVisitedCount = [...visitedBuildings].filter((id) => validIds.has(id)).length;
    const totalBuildings = buildingZones.length;
    const modeLabel = controlMode === 'npc' ? 'NPC Mode' : 'Explore';

    return (
      <div className="claw-panel fixed bottom-4 left-4 z-40 w-56">
        <div className="flex items-center gap-2 md:mb-3">
          <span className="text-xl">&#x1F9ED;</span>
          <div className="flex-1 min-w-0">
            <span className="text-white font-bold text-sm truncate block">Demo Player</span>
            <span className="text-cyan-400/60 text-[10px] font-mono">{modeLabel}</span>
          </div>
          <span className="flex items-center gap-1 text-[11px] font-bold text-amber-300 bg-amber-500/15 border border-amber-500/20 rounded-full px-2.5 py-0.5">
            <span className="text-xs">&#x1FA99;</span>
            100 demo
          </span>
        </div>

        <div className="hidden md:block space-y-1.5">
          <StatBar label="STR" value={8} color="bg-red-400" />
          <StatBar label="DEF" value={8} color="bg-blue-400" />
          <StatBar label="SPD" value={10} color="bg-amber-400" />

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

          <div className="pt-2 text-[10px] text-cyan-300/60 border-t border-white/5">
            Create or connect an agent to save progression.
          </div>
        </div>
      </div>
    );
  }

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
    <div className="claw-panel fixed bottom-4 left-4 z-40 w-56">
      {/* Avatar identity row */}
      <div className={`flex items-center gap-2 ${isGuest ? '' : 'md:mb-3'}`}>
        <span className="text-xl">{emoji}</span>
        <div className="flex-1 min-w-0">
          <span className="text-white font-bold text-sm truncate block">{avatar.name}</span>
          <span className="text-cyan-400/60 text-[10px] font-mono">Lv {avatar.level ?? 1}</span>
        </div>
        {/* Token balance — guests run an all-demo economy, so their balance is
            labeled DEMO (they never earn real CT). */}
        <span className="flex items-center gap-1 text-[11px] font-bold text-amber-300 bg-amber-500/15 border border-amber-500/20 rounded-full px-2.5 py-0.5">
          <span className="text-xs">&#x1FA99;</span>
          {avatar.clawTokens ?? 100}{isGuest ? ' DEMO' : ''}
        </span>
        {/* Wallet chip — opens the wallet-visibility modal (custodial address +
            linked wallet). Only for real accounts with a provisioned custodial
            wallet; guests (demo economy) have none. */}
        {!isGuest && (avatar as { walletAddress?: string | null }).walletAddress && (
          <button
            type="button"
            onClick={openWalletLink}
            title="View your wallet"
            aria-label="Open wallet"
            className="flex items-center justify-center w-6 h-6 rounded-full bg-cyan-500/15 hover:bg-cyan-500/30 border border-cyan-500/25 hover:border-cyan-400/40 text-cyan-200 text-xs transition-colors shrink-0"
          >
            &#x1F45B;
          </button>
        )}
      </div>

      {/* Guest demo-economy caption (light text on dark panel). */}
      {isGuest && (
        <div className="text-[10px] text-amber-200/80 mt-1 md:mb-3">
          Demo tokens — sign up to earn real CT.
        </div>
      )}

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
