'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuestStore, retryUnclaimedRewards } from '@/stores/quest';
import { QUEST_DEFINITIONS, type QuestId, type QuestDefinition } from '@/lib/quests';
import { useGameStore } from '@/stores/game';

const TUTORIAL_KEY = 'clawville-tutorial-seen';
const QUEST_INTRO_KEY = 'clawville-quest-intro-seen';

export default function QuestTracker({ forceVisible = false }: { forceVisible?: boolean } = {}) {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const progress = useQuestStore((s) => s.progress);
  const getProgress = useQuestStore((s) => s.getProgress);
  const shownIntro = useRef(false);

  // Q3 plan §2.6 + audit-fix 2026-04-29 — settle any locally-completed
  // tutorial quests whose server-side credit didn't land due to a one-time
  // network failure. Server is idempotent (409 = already_claimed = no-op).
  // Also probes serverOnly quests once their prereqs land.
  useEffect(() => {
    void retryUnclaimedRewards();
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
          const isMobile =
            typeof window !== 'undefined' && window.innerWidth < 768;
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
  }, [forceVisible, visible]);

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

  return (
    <>
      {/* Desktop: top-left below minimap. Width must match QuestPanel's
          inner shell (w-60) — they were w-60/w-80 before, which produced the
          "child wider than parent" overflow seen in the HUD audit. */}
      <div className="fixed top-[calc(theme(spacing.4)+232px+8px)] left-4 z-40 hidden md:block w-60">
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
        />
      </div>

      {/* Mobile: floating pill top-center */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-40 md:hidden">
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
          mobile
        />
      </div>
    </>
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

        {/* Expanded body — same panel, divider + scroll region + bottom fade */}
        {expanded && (
          <div className="relative border-t border-white/10 animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="cv-quest-scroll space-y-1.5 p-2.5 overflow-y-auto max-h-[min(420px,calc(100vh-320px))]">
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
