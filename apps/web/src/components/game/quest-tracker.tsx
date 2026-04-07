'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuestStore } from '@/stores/quest';
import { QUEST_DEFINITIONS, type QuestId } from '@/lib/quests';
import { useGameStore } from '@/stores/game';

const TUTORIAL_KEY = 'clawville-tutorial-seen';
const QUEST_INTRO_KEY = 'clawville-quest-intro-seen';

export default function QuestTracker() {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const progress = useQuestStore((s) => s.progress);
  const getProgress = useQuestStore((s) => s.getProgress);
  const shownIntro = useRef(false);

  // Only show after tutorial dismissed
  useEffect(() => {
    const check = () => {
      const tutorialSeen = localStorage.getItem(TUTORIAL_KEY) === 'true';
      if (tutorialSeen && !visible) {
        setVisible(true);
        // Auto-expand and pulse on first ever appearance
        const introSeen = localStorage.getItem(QUEST_INTRO_KEY);
        if (!introSeen && !shownIntro.current) {
          shownIntro.current = true;
          setExpanded(true);
          setIsNew(true);
          localStorage.setItem(QUEST_INTRO_KEY, 'true');
          // Show welcome toast
          useGameStore.getState().addToast('📋', 'Complete quests to learn the ropes!', 5000);
          // Stop pulsing after 8s
          setTimeout(() => setIsNew(false), 8000);
        }
      }
    };
    check();
    const interval = setInterval(check, 1500);
    return () => clearInterval(interval);
  }, [visible]);

  if (!visible) return null;

  const completedCount = QUEST_DEFINITIONS.filter(
    (q) => progress[q.id]?.status === 'completed'
  ).length;
  const totalCount = QUEST_DEFINITIONS.length;
  const allDone = completedCount === totalCount;

  // Find current active quest (first active one)
  const activeQuest = QUEST_DEFINITIONS.find(
    (q) => progress[q.id]?.status === 'active'
  );

  return (
    <>
      {/* Desktop: top-left below minimap */}
      <div className="fixed top-[calc(theme(spacing.4)+120px+8px)] left-4 z-40 hidden md:block w-60">
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
  activeQuest: (typeof QUEST_DEFINITIONS)[number] | undefined;
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
  return (
    <div className={mobile ? 'w-96' : 'w-80'}>
      {/* Collapsed header — always visible */}
      <button
        onClick={onToggle}
        className={`w-full claw-panel !p-4 !rounded-xl flex items-center gap-3 hover:brightness-105 transition-all group ${
          isNew ? 'animate-pulse ring-4 ring-claw-green ring-offset-2' : ''
        }`}
      >
        {allDone ? (
          <span className="text-2xl">🏆</span>
        ) : activeQuest ? (
          <span className="text-2xl">{activeQuest.icon}</span>
        ) : (
          <span className="text-2xl">📋</span>
        )}

        <div className="flex-1 min-w-0 text-left">
          <div className="text-white font-black text-base truncate">
            {allDone
              ? 'All Quests Complete!'
              : activeQuest
              ? activeQuest.title
              : 'Quests'}
          </div>
          {/* Active hint shown in collapsed view */}
          {!allDone && activeQuest && !expanded && (
            <div className="text-sm text-black/80 truncate mt-1 font-medium">
              {activeQuest.hint}
            </div>
          )}
          {/* Mini progress bar */}
          {!allDone && activeQuest && (
            <div className="h-2.5 w-full bg-black/15 rounded-full mt-2 overflow-hidden border border-black/5">
              <div
                className="h-full bg-claw-green rounded-full transition-all duration-500"
                style={{ width: `${getProgress(activeQuest.id) * 100}%` }}
              />
            </div>
          )}
        </div>

        <span className="text-sm font-black text-white/60 whitespace-nowrap ml-2">
          {completedCount}/{totalCount}
        </span>

        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-white/50 transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* Expanded quest list */}
      {expanded && (
        <div className="mt-2 claw-panel !p-3 !rounded-xl space-y-2 max-h-96 overflow-y-auto animate-in fade-in slide-in-from-top-2 duration-150 shadow-xl">
          {/* Active quest highlight */}
          {activeQuest && (
            <div className="bg-white/50 rounded-lg px-3 py-3 mb-2 border-2 border-claw-green/40 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{activeQuest.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-base font-black text-white">
                    {activeQuest.title}
                  </div>
                  <div className="text-sm text-black/90 font-medium mt-0.5 leading-snug">
                    {activeQuest.hint}
                  </div>
                  <div className="h-3 w-full bg-white/10 rounded-full mt-2 overflow-hidden border border-black/5">
                    <div
                      className="h-full bg-claw-green rounded-full transition-all duration-500"
                      style={{ width: `${getProgress(activeQuest.id) * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* All quests */}
          {QUEST_DEFINITIONS.map((quest) => {
            const status = progress[quest.id]?.status ?? 'locked';
            const prog = getProgress(quest.id);
            const isCompleted = status === 'completed';
            const isLocked = status === 'locked';
            const isActive = status === 'active' && quest.id !== activeQuest?.id;

            // Skip the active quest since it's shown above
            if (quest.id === activeQuest?.id) return null;

            return (
              <div
                key={quest.id}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
                  isCompleted
                    ? 'bg-claw-green/20'
                    : isLocked
                    ? 'opacity-50'
                    : 'bg-white/30'
                }`}
              >
                <span className="text-xl flex-shrink-0">
                  {isCompleted ? '✅' : isLocked ? '🔒' : quest.icon}
                </span>

                <div className="flex-1 min-w-0">
                  <div
                    className={`text-sm font-bold truncate ${
                      isCompleted ? 'text-white/50 line-through' : 'text-black'
                    }`}
                  >
                    {quest.title}
                  </div>
                  {isActive && (
                    <div className="text-xs text-white/70 truncate font-medium">
                      {quest.description}
                    </div>
                  )}
                  {isActive && (
                    <div className="h-2 w-full bg-white/10 rounded-full mt-1 overflow-hidden">
                      <div
                        className="h-full bg-claw-green rounded-full transition-all duration-500"
                        style={{ width: `${prog * 100}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
