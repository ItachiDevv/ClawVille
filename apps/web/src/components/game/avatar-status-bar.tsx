'use client';

import { useAvatar } from '@/hooks/use-avatar';
import { AVATAR_SPECIES, KNOWLEDGE_BOOKS } from '@clawville/shared';
import { useGameStore } from '@/stores/game';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { buildingZones } from '@/lib/pixi/tilemap-data';
import { useAuthMe } from '@/hooks/use-auth-me';
import { RpgTooltip } from '@/components/rpg';
import { STATUS_BAR_HUD_PROPS } from '@/lib/hud-anchors';
import { useSalvageStore } from '@/stores/salvage';

/**
 * One step ABOVE the rest of the left-column HUD (`z-40`).
 *
 * The quest tracker (`quest-tracker.tsx`, `fixed top-[...] left-4 z-40`) and
 * this bar are both fixed to the left column and both grow. At 1424x805 they
 * overlapped by 186px, and because the tracker renders LATER in the DOM at the
 * same z-index it won — an `elementFromPoint` at the materials chip returned a
 * quest row, so the chip (and its tooltip) could not be reached at all.
 *
 * This bar is small, always-present identity/economy chrome; the tracker is a
 * taller transient list that already collapses. So the bar takes the overlap.
 *
 * The tracker MEASURES the band left above this bar — it finds this element by
 * `STATUS_BAR_HUD_ATTR` (below), reads its real rect and observes it for
 * resizes — and caps its expanded list to what is left, so on a normal window
 * there is no overlap at all and raising this bar covers nothing. Only on a
 * window too short for a readable list does the tracker take the higher layer
 * WHILE EXPANDED, so its own rows never end up visible-but-untouchable;
 * collapsing hands the column straight back to this bar.
 */
const STATUS_BAR_Z = 'z-[41]';

// The marker the quest tracker finds this bar by so it can MEASURE the band
// this bar occupies instead of hard-coding an approximate height. It lives in
// `lib/hud-anchors.ts` rather than here because this component is `dynamic()`
// imported on purpose — see that file.

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
  // tokens are demo-only, so the balance chip must say so. Shares the canonical
  // ['auth-me'] query (hooks/use-auth-me.ts), so this adds no extra network
  // round trip.
  const { data: authData } = useAuthMe();
  const isGuest = !!(authData as any)?.user?.isGuest;
  // Materials (Land gamification, salvage earn loop) — hidden for guests
  // like the rest of the real economy since salvage claiming itself is
  // sign-in-gated (§2.6: guests never earn materials, so their balance is
  // always 0 and the chip would just be clutter).
  const materialBalance = useSalvageStore((s) => s.materialBalance);
  // Today's remaining gathers. Already hydrated by SalvageStateHydrator and,
  // until now, read by NOTHING. `hydratedAt === 0` means the salvage read model
  // has not landed (it never does for a guest), so the count is omitted rather
  // than printed as a fabricated "0 left".
  const salvageHydrated = useSalvageStore((s) => s.hydratedAt !== 0);
  const gathersRemaining = useSalvageStore((s) => s.avatarClaims.remaining);
  const gathersCap = useSalvageStore((s) => s.rules.avatarDailyClaimCap);

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
      <div className={`claw-panel fixed bottom-4 left-4 ${STATUS_BAR_Z} w-56`} {...STATUS_BAR_HUD_PROPS}>
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
    <div className={`claw-panel fixed bottom-4 left-4 ${STATUS_BAR_Z} w-56`} {...STATUS_BAR_HUD_PROPS}>
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
          Demo tokens — sign up to earn real vCLAW.
        </div>
      )}

      {/* Materials balance — seabed salvage earn loop (Land gamification
          P7b/P5b). Non-cashable, sink-only into HOME kit pieces; hidden for
          guests since salvage claiming itself requires a real account.

          The chip used to be a bare number with nothing anywhere in the UI
          connecting salvage -> materials -> building. The tooltip names both
          ends of that loop plus today's remaining gathers. This whole component
          returns null on touch devices (see the isMobile guard above), so the
          tooltip is desktop-only BY CONSTRUCTION. */}
      {!isGuest && (
        <div className="flex items-center gap-1.5 mt-1.5 mb-1.5 md:mb-2">
          <RpgTooltip
            side="top"
            content={
              <span>
                Gather salvage piles on the seabed to earn materials, then spend
                them on pieces in your home yard. Shop yards always pay in
                vCLAW.
                {salvageHydrated ? (
                  <span className="mt-1 block font-bold text-emerald-200">
                    {gathersRemaining} of {gathersCap} gathers left today.
                  </span>
                ) : null}
              </span>
            }
          >
            <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-300 bg-emerald-500/15 border border-emerald-500/20 rounded-full px-2.5 py-0.5">
              <span className="text-xs" aria-hidden>&#x1FAB8;</span>
              {materialBalance} material{materialBalance === 1 ? '' : 's'}
            </span>
          </RpgTooltip>
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
