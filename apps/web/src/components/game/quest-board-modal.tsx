'use client';

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { usePet } from '@/hooks/use-pet';
import { api } from '@/lib/api';

type QuestTab = 'available' | 'active' | 'completed';
type TierFilter = 'all' | 'side_quest' | 'main_quest' | 'legendary';

const TIER_STYLES: Record<string, { color: string; bg: string; border: string; label: string; icon: string; tokenRange: string; glow?: string }> = {
  side_quest:  { color: 'text-green-400',  bg: 'bg-green-500/20',  border: 'border-green-500/40',  label: 'Side Quest',  icon: '\uD83D\uDCDC', tokenRange: '10-50' },
  main_quest:  { color: 'text-blue-400',   bg: 'bg-blue-500/20',   border: 'border-blue-500/40',   label: 'Main Quest',  icon: '\u2694\uFE0F', tokenRange: '100-500' },
  legendary:   { color: 'text-amber-400',  bg: 'bg-amber-500/20',  border: 'border-amber-500/40',  label: 'Legendary',   icon: '\uD83D\uDC51', tokenRange: '1000+', glow: 'shadow-[0_0_12px_rgba(245,158,11,0.4)]' },
};

const STATUS_STYLES: Record<string, { color: string; bg: string; border: string; label: string }> = {
  accepted:    { color: 'text-cyan-400',    bg: 'bg-cyan-500/20',    border: 'border-cyan-500/40',    label: 'Accepted' },
  in_progress: { color: 'text-blue-400',    bg: 'bg-blue-500/20',    border: 'border-blue-500/40',    label: 'In Progress' },
  submitted:   { color: 'text-purple-400',  bg: 'bg-purple-500/20',  border: 'border-purple-500/40',  label: 'Submitted' },
  in_review:   { color: 'text-yellow-400',  bg: 'bg-yellow-500/20',  border: 'border-yellow-500/40',  label: 'Under Review' },
  approved:    { color: 'text-green-400',   bg: 'bg-green-500/20',   border: 'border-green-500/40',   label: 'Completed' },
  rejected:    { color: 'text-red-400',     bg: 'bg-red-500/20',     border: 'border-red-500/40',     label: 'Rejected' },
};

const PROGRESS_STEPS = ['accepted', 'in_progress', 'submitted', 'in_review', 'approved'];

function TierBadge({ tier }: { tier: string }) {
  const config = TIER_STYLES[tier] || TIER_STYLES.side_quest;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${config.bg} ${config.border} ${config.color} border`}>
      <span>{config.icon}</span>
      {config.label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_STYLES[status] || STATUS_STYLES.accepted;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${config.bg} ${config.border} ${config.color} border`}>
      {config.label}
    </span>
  );
}

function ProgressTracker({ currentStatus }: { currentStatus: string }) {
  const currentIndex = PROGRESS_STEPS.indexOf(currentStatus);
  const isRejected = currentStatus === 'rejected';

  return (
    <div className="flex items-center gap-0 my-3">
      {PROGRESS_STEPS.map((step, i) => {
        const isActive = i <= currentIndex && !isRejected;
        const isCurrent = step === currentStatus;
        const stepConfig = STATUS_STYLES[step];
        const isLast = i === PROGRESS_STEPS.length - 1;

        return (
          <div key={step} className="flex items-center flex-1 last:flex-none">
            {/* Dot */}
            <div className="flex flex-col items-center">
              <div
                className={`w-3.5 h-3.5 rounded-full border-2 transition-all ${
                  isRejected && i === currentIndex
                    ? 'bg-red-500 border-red-400 shadow-[0_0_6px_rgba(239,68,68,0.5)]'
                    : isCurrent
                    ? `${stepConfig.bg} ${stepConfig.border} shadow-[0_0_6px_rgba(0,200,255,0.3)]`
                    : isActive
                    ? 'bg-cyan-500/60 border-cyan-400/60'
                    : 'bg-white/5 border-white/20'
                }`}
              />
              <span className={`text-[8px] mt-1 whitespace-nowrap ${isActive || isCurrent ? 'text-gray-300' : 'text-gray-600'}`}>
                {stepConfig.label}
              </span>
            </div>
            {/* Line */}
            {!isLast && (
              <div className={`flex-1 h-0.5 mx-1 ${i < currentIndex && !isRejected ? 'bg-cyan-500/40' : 'bg-white/10'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function QuestCard({
  quest,
  onAccept,
  accepting,
}: {
  quest: any;
  onAccept: () => void;
  accepting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const tier = quest.tier || 'side_quest';
  const tierConfig = TIER_STYLES[tier] || TIER_STYLES.side_quest;
  const isLegendary = tier === 'legendary';

  return (
    <div
      className={`relative rounded-lg border p-3 transition-all hover:scale-[1.005] ${tierConfig.border} ${tierConfig.bg} ${isLegendary ? tierConfig.glow : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{quest.title || 'Untitled Quest'}</span>
            <TierBadge tier={tier} />
          </div>
          {quest.description && (
            <p
              className={`text-xs text-gray-400 mt-1 ${!expanded ? 'line-clamp-2' : ''} cursor-pointer`}
              onClick={() => setExpanded(!expanded)}
            >
              {quest.description}
            </p>
          )}
          {!expanded && quest.description && quest.description.length > 100 && (
            <button onClick={() => setExpanded(true)} className="text-[10px] text-cyan-400 hover:text-cyan-300 mt-0.5">
              Show more
            </button>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span className="flex items-center gap-1 text-sm font-bold text-amber-300">
            {quest.tokenReward ?? tierConfig.tokenRange} <span className="text-xs">&#x1FA99;</span>
          </span>
        </div>
      </div>

      {/* Rewards section */}
      <div className="flex flex-wrap items-center gap-2 mt-2">
        {quest.skillReward && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-500/20 border border-purple-500/40 text-purple-300">
            + Skill: {quest.skillReward}
          </span>
        )}
        {quest.titleReward && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 border border-amber-500/40 text-amber-300">
            + Title: {quest.titleReward}
          </span>
        )}
        {quest.completedCount != null && quest.maxCompletions != null && (
          <span className="text-[10px] text-gray-500">
            {quest.completedCount}/{quest.maxCompletions} completed
          </span>
        )}
        {quest.expiresAt && (
          <span className="text-[10px] text-gray-500">
            Expires: {new Date(quest.expiresAt).toLocaleDateString()}
          </span>
        )}
      </div>

      <div className="flex items-center justify-end mt-2">
        <button
          onClick={onAccept}
          disabled={accepting}
          className="text-xs font-bold px-4 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {accepting ? 'Accepting...' : 'Accept Quest'}
        </button>
      </div>
    </div>
  );
}

function ActiveQuestCard({
  submission,
  onStart,
  onSubmit,
  starting,
  submitting,
}: {
  submission: any;
  onStart: () => void;
  onSubmit: (data: { prLink?: string; submissionNote: string }) => void;
  starting: boolean;
  submitting: boolean;
}) {
  const [showSubmitForm, setShowSubmitForm] = useState(false);
  const [prLink, setPrLink] = useState('');
  const [note, setNote] = useState('');
  const quest = submission.quest || {};
  const tier = quest.tier || 'side_quest';
  const tierConfig = TIER_STYLES[tier] || TIER_STYLES.side_quest;
  const status = submission.status || 'accepted';

  const handleSubmit = () => {
    if (note.length < 10) return;
    onSubmit({ prLink: prLink || undefined, submissionNote: note });
    setShowSubmitForm(false);
    setPrLink('');
    setNote('');
  };

  return (
    <div className={`rounded-lg border p-3 ${tierConfig.border} ${tierConfig.bg}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{quest.title || submission.questTitle || 'Quest'}</span>
            <TierBadge tier={tier} />
            <StatusBadge status={status} />
          </div>
          {quest.description && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">{quest.description}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span className="flex items-center gap-1 text-sm font-bold text-amber-300">
            {quest.tokenReward ?? '?'} <span className="text-xs">&#x1FA99;</span>
          </span>
        </div>
      </div>

      {/* Progress tracker */}
      <ProgressTracker currentStatus={status} />

      {/* Actions by status */}
      <div className="flex items-center justify-end gap-2 mt-1">
        {status === 'accepted' && (
          <button
            onClick={onStart}
            disabled={starting}
            className="text-xs font-bold px-4 py-1.5 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-400 hover:to-indigo-500 text-white transition-all disabled:opacity-40"
          >
            {starting ? 'Starting...' : 'Start Working'}
          </button>
        )}
        {status === 'in_progress' && (
          <button
            onClick={() => setShowSubmitForm(!showSubmitForm)}
            className="text-xs font-bold px-4 py-1.5 rounded-lg bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-400 hover:to-pink-500 text-white transition-all"
          >
            Submit Work
          </button>
        )}
        {status === 'submitted' && (
          <span className="text-xs text-gray-400 italic px-3 py-1.5">Awaiting Review...</span>
        )}
        {status === 'in_review' && (
          <span className="text-xs text-yellow-400 italic px-3 py-1.5">Under Review...</span>
        )}
        {status === 'approved' && (
          <span className="flex items-center gap-1.5 text-xs text-green-400 font-bold px-3 py-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            Completed!
          </span>
        )}
        {status === 'rejected' && (
          <div className="flex items-center gap-2">
            {submission.reviewNote && (
              <span className="text-[10px] text-red-400/70 italic max-w-[200px] truncate">{submission.reviewNote}</span>
            )}
            <button
              onClick={() => setShowSubmitForm(!showSubmitForm)}
              className="text-xs font-bold px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/40 transition-all"
            >
              Re-submit
            </button>
          </div>
        )}
      </div>

      {/* Submit form */}
      {showSubmitForm && (status === 'in_progress' || status === 'rejected') && (
        <div className="mt-4 space-y-3 border-t border-white/10 pt-4">
          <input
            type="url"
            placeholder="GitHub PR link (optional)"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500/50"
            value={prLink}
            onChange={(e) => setPrLink(e.target.value)}
          />
          <textarea
            placeholder="Describe what you did (min 10 chars)..."
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 h-24 resize-none focus:outline-none focus:border-cyan-500/50"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-gray-500">{note.length}/10 min chars</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSubmitForm(false)}
                className="text-xs text-gray-400 hover:text-gray-300 px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || note.length < 10}
                className="text-xs font-bold px-4 py-2 rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? 'Submitting...' : 'Submit for Review'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RewardCard({ reward }: { reward: any }) {
  const tier = reward.questTier || 'side_quest';
  const tierConfig = TIER_STYLES[tier] || TIER_STYLES.side_quest;

  return (
    <div className={`rounded-lg border p-3 ${tierConfig.border} ${tierConfig.bg}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{reward.questTitle || 'Quest'}</span>
            <TierBadge tier={tier} />
          </div>
          <p className="text-[10px] text-gray-500 mt-0.5">
            Completed {reward.completedAt ? new Date(reward.completedAt).toLocaleDateString() : 'recently'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <span className="flex items-center gap-1 text-sm font-bold text-amber-300">
            +{reward.tokensEarned ?? 0} <span className="text-xs">&#x1FA99;</span>
          </span>
          {reward.skillEarned && (
            <span className="text-[10px] text-purple-300 font-bold">+{reward.skillEarned}</span>
          )}
          {reward.titleEarned && (
            <span className="text-[10px] text-amber-300 font-bold">+{reward.titleEarned}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function QuestBoardModal() {
  const { questBoardOpen, closeQuestBoard, questBoardTab, setQuestBoardTab, addToast } = useGameStore();
  const { data: pet } = usePet();
  const queryClient = useQueryClient();

  // Filters
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [page, setPage] = useState(1);

  // Local state
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  // Reset page on filter/tab change
  useEffect(() => {
    setPage(1);
  }, [questBoardTab, tierFilter]);

  // Build query params for available quests
  const queryParams = {
    page,
    tier: tierFilter !== 'all' ? tierFilter : undefined,
    status: 'active' as string | undefined,
  };

  // Available quests query
  const { data: questsData, isLoading: questsLoading } = useQuery({
    queryKey: ['quests-available', queryParams],
    queryFn: () => api.getQuests(queryParams),
    enabled: questBoardOpen && questBoardTab === 'available',
  });

  // My quests query (active submissions)
  const { data: myQuestsData, isLoading: myQuestsLoading } = useQuery({
    queryKey: ['quests-my-quests'],
    queryFn: () => api.getMyQuests(),
    enabled: questBoardOpen && questBoardTab === 'active',
  });

  // Quest log (completed/rewards)
  const { data: questLogData, isLoading: questLogLoading } = useQuery({
    queryKey: ['quests-quest-log'],
    queryFn: () => api.getQuestLog(),
    enabled: questBoardOpen && questBoardTab === 'completed',
  });

  // Accept mutation
  const acceptMutation = useMutation({
    mutationFn: (questId: string) => api.acceptQuest(questId),
    onSuccess: () => {
      addToast('\uD83D\uDCDC', 'Quest accepted!');
      queryClient.invalidateQueries({ queryKey: ['quests-available'] });
      queryClient.invalidateQueries({ queryKey: ['quests-my-quests'] });
      setAcceptingId(null);
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Failed to accept quest');
      setAcceptingId(null);
    },
  });

  // Start mutation
  const startMutation = useMutation({
    mutationFn: (questId: string) => api.startQuest(questId),
    onSuccess: () => {
      addToast('\uD83D\uDE80', 'Quest started! Get to work!');
      queryClient.invalidateQueries({ queryKey: ['quests-my-quests'] });
      setStartingId(null);
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Failed to start quest');
      setStartingId(null);
    },
  });

  // Submit mutation
  const submitMutation = useMutation({
    mutationFn: ({ questId, data }: { questId: string; data: { prLink?: string; submissionNote: string } }) =>
      api.submitQuest(questId, data),
    onSuccess: () => {
      addToast('\u2705', 'Work submitted for review!');
      queryClient.invalidateQueries({ queryKey: ['quests-my-quests'] });
      setSubmittingId(null);
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Submission failed');
      setSubmittingId(null);
    },
  });

  const handleAccept = useCallback((questId: string) => {
    setAcceptingId(questId);
    acceptMutation.mutate(questId);
  }, [acceptMutation]);

  const handleStart = useCallback((questId: string) => {
    setStartingId(questId);
    startMutation.mutate(questId);
  }, [startMutation]);

  const handleSubmit = useCallback((questId: string, data: { prLink?: string; submissionNote: string }) => {
    setSubmittingId(questId);
    submitMutation.mutate({ questId, data });
  }, [submitMutation]);

  // Close on Escape
  useEffect(() => {
    if (!questBoardOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeQuestBoard();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [questBoardOpen, closeQuestBoard]);

  if (!questBoardOpen) return null;

  const quests = questsData?.quests ?? [];
  const total = questsData?.total ?? 0;
  const pageSize = questsData?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const myQuests = myQuestsData?.submissions ?? [];
  const rewards = questLogData?.rewards ?? [];
  const tokens = pet?.clawTokens ?? pet?.clawTokens ?? 0;

  // Quest log summary
  const totalTokensEarned = rewards.reduce((sum: number, r: any) => sum + (r.tokensEarned || 0), 0);
  const skillsCollected = rewards.filter((r: any) => r.skillEarned).map((r: any) => r.skillEarned);
  const titlesCollected = rewards.filter((r: any) => r.titleEarned).map((r: any) => r.titleEarned);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-gradient-to-b from-[#1a1508]/90 via-[#0f1a2e]/90 to-[#1a1508]/90 backdrop-blur-sm"
        onClick={closeQuestBoard}
      />

      {/* Modal */}
      <div className="relative w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="claw-panel flex flex-col overflow-hidden bg-gradient-to-b from-[#1a1508] to-[#0f1a2e] border-2 border-amber-500/30">
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{'\uD83D\uDCDC'}</span>
              <div>
                <h2 className="font-bold text-lg text-white tracking-wide">Quest Board</h2>
                <p className="text-[10px] text-amber-400/60 uppercase tracking-widest">Bounties &middot; Quests &middot; Rewards</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-sm font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-3 py-1">
                <span className="text-base">&#x1FA99;</span>
                {tokens}
              </span>
              <button
                onClick={closeQuestBoard}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white font-bold text-sm transition-colors border border-white/10"
              >
                {'\u2715'}
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-amber-500/20 px-5">
            {(['available', 'active', 'completed'] as QuestTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setQuestBoardTab(t)}
                className={`px-4 py-2.5 text-sm font-bold transition-colors border-b-2 ${
                  questBoardTab === t
                    ? 'text-amber-300 border-amber-400'
                    : 'text-gray-500 border-transparent hover:text-gray-300'
                }`}
              >
                {t === 'available' ? 'Available Quests' : t === 'active' ? 'Active Quests' : 'Quest Log'}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto">
            {/* ===== AVAILABLE QUESTS TAB ===== */}
            {questBoardTab === 'available' && (
              <div className="flex flex-col">
                {/* Filters bar */}
                <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-white/5">
                  <select
                    value={tierFilter}
                    onChange={(e) => setTierFilter(e.target.value as TierFilter)}
                    className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-amber-500/50"
                  >
                    <option value="all">All Tiers</option>
                    <option value="side_quest">Side Quest (10-50 tokens)</option>
                    <option value="main_quest">Main Quest (100-500 tokens)</option>
                    <option value="legendary">Legendary (1000+ tokens)</option>
                  </select>
                  <span className="ml-auto text-[10px] text-gray-500">
                    {total} quest{total !== 1 ? 's' : ''} available
                  </span>
                </div>

                {/* Quest list */}
                <div className="px-5 py-3 space-y-2 min-h-[200px] max-h-[55vh]">
                  {questsLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin w-6 h-6 border-2 border-amber-300 border-t-transparent rounded-full" />
                    </div>
                  ) : quests.length === 0 ? (
                    <div className="text-center py-12">
                      <span className="text-3xl block mb-2">{'\uD83D\uDCDC'}</span>
                      <p className="text-gray-500 text-sm">No quests available right now.</p>
                      <p className="text-gray-600 text-xs mt-1">Check back later for new bounties!</p>
                    </div>
                  ) : (
                    <>
                      {quests.map((quest: any) => (
                        <QuestCard
                          key={quest.id}
                          quest={quest}
                          onAccept={() => handleAccept(quest.id)}
                          accepting={acceptingId === quest.id}
                        />
                      ))}

                      {/* Pagination */}
                      {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 pt-3">
                          <button
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            disabled={page <= 1}
                            className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:bg-white/10 disabled:opacity-30 transition-colors"
                          >
                            Prev
                          </button>
                          <span className="text-xs text-gray-500">
                            Page {page} of {totalPages}
                          </span>
                          <button
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            disabled={page >= totalPages}
                            className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:bg-white/10 disabled:opacity-30 transition-colors"
                          >
                            Next
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ===== ACTIVE QUESTS TAB ===== */}
            {questBoardTab === 'active' && (
              <div className="px-5 py-3 space-y-2 min-h-[200px] max-h-[55vh]">
                {myQuestsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin w-6 h-6 border-2 border-amber-300 border-t-transparent rounded-full" />
                  </div>
                ) : myQuests.length === 0 ? (
                  <div className="text-center py-12">
                    <span className="text-3xl block mb-2">{'\u2694\uFE0F'}</span>
                    <p className="text-gray-500 text-sm">No active quests.</p>
                    <p className="text-gray-600 text-xs mt-1">Accept a quest from the Available tab to get started!</p>
                  </div>
                ) : (
                  <>
                    {/* Active summary */}
                    <div className="flex items-center gap-4 mb-3 p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
                      <div>
                        <p className="text-[10px] text-cyan-400/70 uppercase tracking-wider font-bold">In Progress</p>
                        <p className="text-lg font-bold text-cyan-400">
                          {myQuests.filter((s: any) => ['accepted', 'in_progress'].includes(s.status)).length}
                        </p>
                      </div>
                      <div className="h-8 w-px bg-cyan-500/20" />
                      <div>
                        <p className="text-[10px] text-cyan-400/70 uppercase tracking-wider font-bold">Awaiting Review</p>
                        <p className="text-lg font-bold text-yellow-400">
                          {myQuests.filter((s: any) => ['submitted', 'in_review'].includes(s.status)).length}
                        </p>
                      </div>
                    </div>

                    {myQuests.map((submission: any) => (
                      <ActiveQuestCard
                        key={submission.id}
                        submission={submission}
                        onStart={() => handleStart(submission.questId || submission.id)}
                        onSubmit={(data) => handleSubmit(submission.questId || submission.id, data)}
                        starting={startingId === (submission.questId || submission.id)}
                        submitting={submittingId === (submission.questId || submission.id)}
                      />
                    ))}
                  </>
                )}
              </div>
            )}

            {/* ===== QUEST LOG TAB ===== */}
            {questBoardTab === 'completed' && (
              <div className="px-5 py-3 space-y-2 min-h-[200px] max-h-[55vh]">
                {questLogLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin w-6 h-6 border-2 border-amber-300 border-t-transparent rounded-full" />
                  </div>
                ) : rewards.length === 0 ? (
                  <div className="text-center py-12">
                    <span className="text-3xl block mb-2">{'\uD83C\uDFC6'}</span>
                    <p className="text-gray-500 text-sm">No completed quests yet.</p>
                    <p className="text-gray-600 text-xs mt-1">Complete quests to earn tokens, skills, and titles!</p>
                  </div>
                ) : (
                  <>
                    {/* Rewards summary */}
                    <div className="flex items-center gap-4 mb-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <div>
                        <p className="text-[10px] text-amber-400/70 uppercase tracking-wider font-bold">Quests Completed</p>
                        <p className="text-lg font-bold text-amber-400">{rewards.length}</p>
                      </div>
                      <div className="h-8 w-px bg-amber-500/20" />
                      <div>
                        <p className="text-[10px] text-amber-400/70 uppercase tracking-wider font-bold">Total Earned</p>
                        <p className="text-lg font-bold text-amber-300">
                          {totalTokensEarned} &#x1FA99;
                        </p>
                      </div>
                      {skillsCollected.length > 0 && (
                        <>
                          <div className="h-8 w-px bg-amber-500/20" />
                          <div>
                            <p className="text-[10px] text-purple-400/70 uppercase tracking-wider font-bold">Skills Earned</p>
                            <p className="text-lg font-bold text-purple-300">{skillsCollected.length}</p>
                          </div>
                        </>
                      )}
                      {titlesCollected.length > 0 && (
                        <>
                          <div className="h-8 w-px bg-amber-500/20" />
                          <div>
                            <p className="text-[10px] text-amber-400/70 uppercase tracking-wider font-bold">Titles</p>
                            <p className="text-lg font-bold text-amber-200">{titlesCollected.length}</p>
                          </div>
                        </>
                      )}
                    </div>

                    {rewards.map((reward: any, i: number) => (
                      <RewardCard key={reward.id || i} reward={reward} />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
