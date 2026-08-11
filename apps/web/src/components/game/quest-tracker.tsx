'use client';

import { useState, useEffect, useRef } from 'react';
import {
  useQuestStore,
  retryUnclaimedRewards,
  retryServerClaimsRestore,
} from '@/stores/quest';
import { QUEST_DEFINITIONS, type QuestId, type QuestDefinition } from '@/lib/quests';
import { STATUS_BAR_HUD_ATTR } from '@/lib/hud-anchors';
import { useAvatar } from '@/hooks/use-avatar';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useGameStore } from '@/stores/game';

const TUTORIAL_KEY = 'clawville-tutorial-seen';
const QUEST_INTRO_KEY = 'clawville-quest-intro-seen';

// ---------------------------------------------------------------------------
// Desktop left-column geometry — shared with `avatar-status-bar.tsx`.
//
// The tracker and the avatar status bar are both fixed to the left column and
// both grow, so their collision has to be resolved by ARITHMETIC, not by a
// guessed max-height.
//
// WHICH DEVICES GET WHICH PLACEMENT (2026-08-10). This used to be a Tailwind
// `hidden md:block` / `md:hidden` pair while the status bar gates on TOUCH via
// `useIsMobile()`. So a wide touch device (an iPad Pro in landscape, 1366px)
// got the DESKTOP tracker — including a height reserve for a status bar that is
// not rendered there at all. Both components read the same canonical hook now,
// which is also the project's standing rule: `useIsMobile()` checks
// maxTouchPoints plus a coarse pointer; a bare `md:` query is the exact mistake
// that shipped covered joysticks three times.
//
// WHICH NUMBERS ARE MEASURED. The two that actually drift are read from the
// live DOM rather than assumed: the panel's own top (it sits under the minimap
// stack) and the status bar's occupied band (its height changes with the guest
// caption, the materials chip and the skills row). Only the tracker's own
// header is a constant, because it is fixed markup — see QUEST_HEADER_PX.
// ---------------------------------------------------------------------------

/**
 * The tracker's own collapsed header: `p-3` (12px top + 12px bottom) around a
 * title line and, while collapsed, a hint line plus a progress bar. Measured
 * once off the live panel at 1424x805 and stable because the markup is fixed
 * (see `QuestPanel`'s header `<button>`). If that header gains a row, change
 * this in the same diff.
 */
const QUEST_HEADER_PX = 55;
/** Breathing room between the tracker's list and whatever sits under it. */
const QUEST_STACK_GAP_PX = 9;
/** Never taller than this, however much room there is. */
const QUEST_BODY_MAX_PX = 420;
/**
 * Below this the list is not a list any more, it is a sliver. When the measured
 * band is under it the tracker takes the floor AND stacks ABOVE the status bar
 * (see `overlapsStatusBar`), so the rows it shows are the ones on top and stay
 * hit-testable. That trade only ever happens below roughly a 700px-tall window;
 * at 1424x805 the band is 225px, so the tracker keeps `z-40` and covers
 * nothing — the status bar's materials chip stays reachable with the tracker
 * expanded, which is the pinned live-tested case.
 */
const QUEST_BODY_MIN_PX = 120;

/**
 * The height the desktop tracker's expanded list may actually use.
 *
 *   band = window height
 *        - the panel's measured top          (under the minimap stack)
 *        - the tracker's own header
 *        - the status bar's MEASURED occupied band (0 when it is not rendered)
 *        - a small gap
 *
 * `panelRef` is the fixed desktop wrapper. The status bar is found by its
 * `STATUS_BAR_HUD_ATTR` marker and observed, so a taller bar (guest caption,
 * materials chip, skills row) shrinks this band instead of being overlapped.
 *
 * Returns `null` until the first measurement, so the server render and the
 * first client paint agree (no hydration mismatch) and nothing flashes.
 *
 * `avatarSettled` is a dependency, not a decoration: the status bar returns
 * null while `['avatar']` is loading, so the element only exists to measure
 * once that read lands.
 */
function useDesktopQuestBandPx(
  panelRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  avatarSettled: boolean,
): number | null {
  const [band, setBand] = useState<number | null>(null);
  useEffect(() => {
    if (!active) {
      setBand(null);
      return;
    }
    let observer: ResizeObserver | null = null;
    let observed: Element | null = null;
    const read = () => {
      const panelTop =
        panelRef.current?.getBoundingClientRect().top
        // Matches the wrapper's own `top-[calc(theme(spacing.4)+232px+8px)]`
        // for the frame before the ref is attached.
        ?? 16 + 232 + 8;
      const bar = document.querySelector<HTMLElement>(`[${STATUS_BAR_HUD_ATTR}]`);
      // Everything from the top of the bar to the bottom of the window: its own
      // height plus its `bottom-4` offset, without assuming either.
      const barReserve = bar
        ? Math.max(0, window.innerHeight - bar.getBoundingClientRect().top)
        : 0;
      if (bar !== observed && observer) {
        if (observed) observer.unobserve(observed);
        observed = bar;
        if (bar) observer.observe(bar);
      }
      setBand(
        window.innerHeight
        - panelTop
        - QUEST_HEADER_PX
        - barReserve
        - QUEST_STACK_GAP_PX,
      );
    };
    observer = new ResizeObserver(read);
    read();
    window.addEventListener('resize', read);
    return () => {
      window.removeEventListener('resize', read);
      observer?.disconnect();
      observer = null;
    };
  }, [panelRef, active, avatarSettled]);
  return band;
}

export default function QuestTracker({ forceVisible = false }: { forceVisible?: boolean } = {}) {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const progress = useQuestStore((s) => s.progress);
  const getProgress = useQuestStore((s) => s.getProgress);
  const shownIntro = useRef(false);
  const desktopPanelRef = useRef<HTMLDivElement>(null);
  // TOUCH, not viewport width — the same hook the avatar status bar gates on,
  // so the two components always agree about which device they are on.
  const isMobile = useIsMobile();
  const { isLoading: avatarLoading } = useAvatar();
  const desktopBandPx = useDesktopQuestBandPx(
    desktopPanelRef,
    visible && !isMobile,
    !avatarLoading,
  );

  // Q3 plan §2.6 + audit-fix 2026-04-29 — settle any locally-completed
  // tutorial quests whose server-side credit didn't land due to a one-time
  // network failure. Server is idempotent (409 = already_claimed = no-op).
  // Also probes serverOnly quests once their prereqs land.
  useEffect(() => {
    // Quest-board restore belt (2026-07-29): server-known completions land
    // BEFORE the local claim sweep, so the sweep doesn't 409-spam the claim
    // endpoint for quests the server already recorded. No-op when unstamped
    // or already synced.
    void (async () => {
      await retryServerClaimsRestore();
      await retryUnclaimedRewards();
    })();
  }, []);

  // Only show after tutorial dismissed
  useEffect(() => {
    if (forceVisible) {
      setVisible(true);
      return;
    }
    const check = () => {
      const tutorialSeen = localStorage.getItem(TUTORIAL_KEY) === 'true';
      if (tutorialSeen && !visible) {
        setVisible(true);
        const introSeen = localStorage.getItem(QUEST_INTRO_KEY);
        if (!introSeen && !shownIntro.current) {
          shownIntro.current = true;
          // Auto-expand on the DESKTOP placement only, decided by the same
          // touch check the placement itself uses. A bare `innerWidth < 768`
          // auto-expanded the tracker on every iPad.
          if (!isMobile) setExpanded(true);
          setIsNew(true);
          localStorage.setItem(QUEST_INTRO_KEY, 'true');
          useGameStore.getState().addToast('📋', 'Complete quests to learn the ropes!', 5000);
          setTimeout(() => setIsNew(false), 8000);
        }
      }
    };
    check();
    const interval = setInterval(check, 1500);
    return () => clearInterval(interval);
  }, [forceVisible, visible, isMobile]);

  if (!visible) return null;

  const completedCount = QUEST_DEFINITIONS.filter(
    (q) => progress[q.id]?.status === 'completed'
  ).length;
  const totalCount = QUEST_DEFINITIONS.length;
  const allDone = completedCount === totalCount;

  // Headline quest = first non-pending active quest. Pending quests show
  // in the list as "soon" but never headline since you can't progress them.
  const activeQuest = QUEST_DEFINITIONS.find(
    (q) => progress[q.id]?.status === 'active' && !q.isPending
  );

  // Measured band, clamped to something a player can actually read. Before the
  // first measurement assume the full height: that is the no-overlap case, so
  // the first paint can never start out stacked over the status bar.
  const desktopBodyMaxPx = Math.min(
    QUEST_BODY_MAX_PX,
    Math.max(QUEST_BODY_MIN_PX, desktopBandPx ?? QUEST_BODY_MAX_PX),
  );
  // The band is too small for the floor to fit above the status bar, so the two
  // WILL overlap. The bar renders later at `z-[41]` and would win the hit test,
  // which is how the previous `max(120px, …)` floor left quest rows visible but
  // untouchable. Expanding is an explicit, reversible player action, so while
  // it is expanded the tracker takes the higher layer and its own rows stay
  // usable; collapsing hands the column straight back to the bar.
  const overlapsStatusBar = desktopBandPx !== null && desktopBandPx < QUEST_BODY_MIN_PX;
  const desktopZ = expanded && overlapsStatusBar ? 'z-[42]' : 'z-40';

  // EXACTLY ONE placement renders, chosen by TOUCH. It used to render both and
  // let CSS hide one, which is how an iPad Pro in landscape got the desktop
  // geometry (and its status-bar height reserve) while the status bar itself
  // was not rendered at all.
  if (isMobile) {
    return (
      // Mobile: floating pill top-center. The status bar returns null on every
      // touch device, so the desktop left-column reserve does not apply here;
      // this keeps the height rule the mobile pill has always had.
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-40">
        <QuestPanel
          expanded={expanded}
          onToggle={() => setExpanded((e) => !e)}
          activeQuest={activeQuest}
          completedCount={completedCount}
          totalCount={totalCount}
          allDone={allDone}
          progress={progress}
          getProgress={getProgress}
          isNew={isNew}
          bodyMaxHeight={`min(${QUEST_BODY_MAX_PX}px, max(${QUEST_BODY_MIN_PX}px, calc(100dvh - 180px)))`}
          mobile
        />
      </div>
    );
  }

  return (
    // Desktop: top-left below minimap. Width must match QuestPanel's
    // inner shell (w-60) — they were w-60/w-80 before, which produced the
    // "child wider than parent" overflow seen in the HUD audit.
    <div
      ref={desktopPanelRef}
      className={`fixed top-[calc(theme(spacing.4)+232px+8px)] left-4 ${desktopZ} w-60`}
    >
      <QuestPanel
        expanded={expanded}
        onToggle={() => setExpanded((e) => !e)}
        activeQuest={activeQuest}
        completedCount={completedCount}
        totalCount={totalCount}
        allDone={allDone}
        progress={progress}
        getProgress={getProgress}
        isNew={isNew}
        bodyMaxHeight={`${desktopBodyMaxPx}px`}
      />
    </div>
  );
}

interface QuestPanelProps {
  expanded: boolean;
  onToggle: () => void;
  activeQuest: QuestDefinition | undefined;
  completedCount: number;
  totalCount: number;
  allDone: boolean;
  progress: Record<QuestId, { status: string; completedAt?: number }>;
  getProgress: (id: QuestId) => number;
  isNew?: boolean;
  /**
   * CSS max-height for the expanded scroll region, decided by the caller
   * because the two placements have different neighbours: the desktop column
   * shares its space with the avatar status bar (measured), the mobile pill
   * does not (the bar is hidden on touch).
   */
  bodyMaxHeight: string;
  mobile?: boolean;
}

function QuestPanel({
  expanded,
  onToggle,
  activeQuest,
  completedCount,
  totalCount,
  allDone,
  progress,
  getProgress,
  isNew,
  bodyMaxHeight,
  mobile,
}: QuestPanelProps) {
  const isCompactMobile = mobile && !expanded;

  // Tier-group the quests (excluding the headline active quest).
  const tieredList = (() => {
    const visible = QUEST_DEFINITIONS.filter((q) => q.id !== activeQuest?.id);
    const byTier = new Map<number, QuestDefinition[]>();
    for (const q of visible) {
      const arr = byTier.get(q.tier) ?? [];
      arr.push(q);
      byTier.set(q.tier, arr);
    }
    return Array.from(byTier.keys())
      .sort((a, b) => a - b)
      .map((tier) => ({ tier, list: byTier.get(tier) ?? [] }));
  })();

  return (
    <div className={mobile ? 'w-[220px] max-w-[75vw]' : 'w-full'}>
      {/* S6 — ONE claw-panel: unframed header on top, scroll body under a
          divider. Was two stacked rounded panels that read as "duplicate boxes",
          and the active quest rendered both in the header AND the list. Now the
          header is SLIM while expanded (the active card in the body owns the
          progress/hint) and rich only while collapsed. */}
      <div
        className={`claw-panel !p-0 overflow-hidden ${isCompactMobile ? '!rounded-lg' : '!rounded-xl'} ${
          isNew ? 'animate-pulse ring-4 ring-claw-green ring-offset-2' : ''
        }`}
      >
        {/* Header — unframed top section */}
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          className={`w-full ${isCompactMobile ? 'p-2' : 'p-3'} flex items-center gap-2 hover:brightness-105 transition-all group text-left`}
        >
          <span className={isCompactMobile ? 'text-lg' : 'text-xl'}>
            {allDone ? '🏆' : activeQuest ? activeQuest.icon : '📋'}
          </span>

          <div className="flex-1 min-w-0 text-left">
            <div className={`text-white font-black truncate ${isCompactMobile ? 'text-xs' : 'text-sm'}`}>
              {allDone ? 'Tutorial Complete!' : activeQuest ? activeQuest.title : 'Tutorial'}
            </div>
            {/* Rich details ONLY while collapsed — avoids duplicating the active
                quest card that the expanded body shows. */}
            {!isCompactMobile && !allDone && activeQuest && !expanded && (
              <>
                <div className="text-xs text-white/75 truncate mt-0.5 font-medium">
                  {activeQuest.hint}
                </div>
                <div className="h-2 w-full bg-black/15 rounded-full mt-1.5 overflow-hidden border border-black/5">
                  <div
                    className="h-full bg-claw-green rounded-full transition-all duration-500"
                    style={{ width: `${getProgress(activeQuest.id) * 100}%` }}
                  />
                </div>
              </>
            )}
          </div>

          <span className={`font-black text-white/60 whitespace-nowrap ${isCompactMobile ? 'text-[10px] ml-1' : 'text-xs ml-2'}`}>
            {completedCount}/{totalCount}
          </span>

          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-white/50 transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {/* Expanded body — same panel, divider + scroll region + bottom fade.

            HEIGHT IS THE CALLER'S CALL (`bodyMaxHeight`). The old
            `max-h-[320px]` let this list run 186px INTO the avatar status bar
            at 1424x805 and cover its materials chip; the `max(120px, …)` floor
            that replaced it still overlapped below roughly a 700px-tall window,
            and the bar's new `z-[41]` meant the covered rows were visible but
            untouchable. The desktop wrapper now MEASURES the real band and, on
            the short windows where the floor cannot fit, raises the whole
            tracker above the bar so its own rows stay hit-testable. See
            `useDesktopQuestBandPx`, which MEASURES the bar rather than
            assuming a height for it. */}
        {expanded && (
          <div className="relative border-t border-white/10 animate-in fade-in slide-in-from-top-1 duration-150">
            <div
              className="cv-quest-scroll space-y-1.5 p-2.5 overflow-y-auto"
              style={{ maxHeight: bodyMaxHeight }}
            >
              {/* Active quest highlight (its only render while expanded) */}
              {activeQuest && (
                <div className="bg-claw-green/15 rounded-lg px-2.5 py-2 border border-claw-green/50">
                  <div className="flex items-center gap-2.5">
                    <span className="text-xl">{activeQuest.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-black text-white truncate">{activeQuest.title}</div>
                      <div className="text-xs text-white/85 font-medium mt-0.5 leading-snug">
                        {activeQuest.hint}
                      </div>
                      <div className="h-2 w-full bg-black/30 rounded-full mt-1.5 overflow-hidden border border-white/10">
                        <div
                          className="h-full bg-claw-green rounded-full transition-all duration-500"
                          style={{ width: `${getProgress(activeQuest.id) * 100}%` }}
                        />
                      </div>
                    </div>
                    <span className="font-mono text-[10px] text-amber-300/80">
                      +{activeQuest.rewardTokens}
                    </span>
                  </div>
                </div>
              )}

              {/* Tier-grouped quests */}
              {tieredList.map(({ tier, list }) => (
                <div key={`tier-${tier}`} className="space-y-1">
                  <div className="px-1.5 pt-1.5 pb-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
                    Tier {tier}
                  </div>
                  {list.map((quest) => {
                    const status = progress[quest.id]?.status ?? 'locked';
                    const prog = getProgress(quest.id);
                    const isCompleted = status === 'completed';
                    const isLocked = status === 'locked';
                    const isActive = status === 'active';
                    const isPending = quest.isPending;
                    return (
                      <div
                        key={quest.id}
                        className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg transition-all ${
                          isCompleted
                            ? 'bg-claw-green/20'
                            : isPending
                            ? 'bg-amber-500/[0.05] border border-amber-500/15'
                            : isLocked
                            ? 'bg-white/[0.03]'
                            : 'bg-white/[0.06]'
                        }`}
                      >
                        <span className="text-lg flex-shrink-0">
                          {isCompleted ? '✅' : isPending ? '🚧' : isLocked ? '🔒' : quest.icon}
                        </span>

                        <div className="flex-1 min-w-0">
                          <div
                            className={`text-xs font-bold truncate flex items-center gap-2 ${
                              isCompleted
                                ? 'text-white/50 line-through'
                                : isPending
                                ? 'text-amber-200/80'
                                : isLocked
                                ? 'text-white/40'
                                : 'text-white'
                            }`}
                          >
                            <span className="truncate">{quest.title}</span>
                            {isPending && (
                              <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-amber-300/80 flex-shrink-0">
                                soon
                              </span>
                            )}
                          </div>
                          {isActive && !isPending && (
                            <div className="text-[11px] text-white/70 truncate font-medium">
                              {quest.description}
                            </div>
                          )}
                          {isActive && !isPending && (
                            <div className="h-1.5 w-full bg-black/30 rounded-full mt-1 overflow-hidden">
                              <div
                                className="h-full bg-claw-green rounded-full transition-all duration-500"
                                style={{ width: `${prog * 100}%` }}
                              />
                            </div>
                          )}
                        </div>

                        <span className="ml-1 font-mono text-[10px] text-amber-300/80 whitespace-nowrap">
                          +{quest.rewardTokens}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {/* Scroll affordance — bottom fade tells a new user there's more.
                Matches the .claw-panel navy bg; pointer-events-none. */}
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-6"
              style={{
                background:
                  'linear-gradient(to top, rgba(10,22,40,0.92) 0%, rgba(10,22,40,0) 100%)',
              }}
            />
          </div>
        )}
      </div>

      {/* Thin scrollbar so the scroll region reads as scrollable. */}
      <style jsx>{`
        :global(.cv-quest-scroll)::-webkit-scrollbar {
          width: 6px;
        }
        :global(.cv-quest-scroll)::-webkit-scrollbar-thumb {
          background: rgba(56, 189, 248, 0.35);
          border-radius: 3px;
        }
        :global(.cv-quest-scroll) {
          scrollbar-width: thin;
          scrollbar-color: rgba(56, 189, 248, 0.35) transparent;
        }
      `}</style>
    </div>
  );
}
