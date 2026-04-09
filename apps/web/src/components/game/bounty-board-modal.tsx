'use client';

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { usePet } from '@/hooks/use-pet';
import { api } from '@/lib/api';

type BountyTab = 'browse' | 'my-bounties' | 'my-attempts' | 'create';
type DifficultyFilter = 'all' | 'beginner' | 'intermediate' | 'advanced' | 'expert';
type SortMode = 'newest' | 'reward-high' | 'reward-low' | 'expiring-soon';

const DIFFICULTY_STYLES: Record<string, { color: string; bg: string; border: string; label: string }> = {
  beginner:     { color: 'text-green-400',  bg: 'bg-green-500/20',  border: 'border-green-500/40',  label: 'Beginner' },
  intermediate: { color: 'text-blue-400',   bg: 'bg-blue-500/20',   border: 'border-blue-500/40',   label: 'Intermediate' },
  advanced:     { color: 'text-purple-400', bg: 'bg-purple-500/20', border: 'border-purple-500/40', label: 'Advanced' },
  expert:       { color: 'text-red-400',    bg: 'bg-red-500/20',    border: 'border-red-500/40',    label: 'Expert' },
};

const REPUTATION_STYLES: Record<string, { color: string; icon: string; label: string }> = {
  newcomer:    { color: 'text-gray-400',   icon: '\uD83C\uDF31', label: 'Newcomer' },
  apprentice:  { color: 'text-green-400',  icon: '\uD83D\uDD27', label: 'Apprentice' },
  journeyman:  { color: 'text-blue-400',   icon: '\u2693',       label: 'Journeyman' },
  expert:      { color: 'text-purple-400', icon: '\uD83D\uDD31', label: 'Expert' },
  master:      { color: 'text-amber-400',  icon: '\uD83D\uDC51', label: 'Master' },
};

const STATUS_STYLES: Record<string, { color: string; bg: string; border: string; label: string }> = {
  open:         { color: 'text-green-400',   bg: 'bg-green-500/20',  border: 'border-green-500/40',  label: 'Open' },
  in_progress:  { color: 'text-blue-400',    bg: 'bg-blue-500/20',   border: 'border-blue-500/40',   label: 'In Progress' },
  completed:    { color: 'text-amber-400',   bg: 'bg-amber-500/20',  border: 'border-amber-500/40',  label: 'Completed' },
  expired:      { color: 'text-gray-400',    bg: 'bg-gray-500/20',   border: 'border-gray-500/40',   label: 'Expired' },
  cancelled:    { color: 'text-red-400',     bg: 'bg-red-500/20',    border: 'border-red-500/40',    label: 'Cancelled' },
};

const ATTEMPT_STATUS_STYLES: Record<string, { color: string; bg: string; border: string; label: string }> = {
  claimed:      { color: 'text-cyan-400',    bg: 'bg-cyan-500/20',    border: 'border-cyan-500/40',    label: 'Claimed' },
  in_progress:  { color: 'text-blue-400',    bg: 'bg-blue-500/20',    border: 'border-blue-500/40',    label: 'In Progress' },
  submitted:    { color: 'text-purple-400',  bg: 'bg-purple-500/20',  border: 'border-purple-500/40',  label: 'Submitted' },
  approved:     { color: 'text-green-400',   bg: 'bg-green-500/20',   border: 'border-green-500/40',   label: 'Approved' },
  rejected:     { color: 'text-red-400',     bg: 'bg-red-500/20',     border: 'border-red-500/40',     label: 'Rejected' },
  abandoned:    { color: 'text-gray-400',    bg: 'bg-gray-500/20',    border: 'border-gray-500/40',    label: 'Abandoned' },
};

const BONUS_REWARD_ICONS: Record<string, string> = {
  skill: '\uD83D\uDCA1',
  agent_config: '\u2699\uFE0F',
  knowledge_book: '\uD83D\uDCD6',
  custom: '\uD83C\uDF81',
};

function DifficultyBadge({ difficulty }: { difficulty: string }) {
  const config = DIFFICULTY_STYLES[difficulty] || DIFFICULTY_STYLES.beginner;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${config.bg} ${config.border} ${config.color} border`}>
      {config.label}
    </span>
  );
}

function BountyStatusBadge({ status }: { status: string }) {
  const config = STATUS_STYLES[status] || STATUS_STYLES.open;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${config.bg} ${config.border} ${config.color} border`}>
      {config.label}
    </span>
  );
}

function AttemptStatusBadge({ status }: { status: string }) {
  const config = ATTEMPT_STATUS_STYLES[status] || ATTEMPT_STATUS_STYLES.claimed;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${config.bg} ${config.border} ${config.color} border`}>
      {config.label}
    </span>
  );
}

function ReputationBadge({ tier }: { tier: string }) {
  const config = REPUTATION_STYLES[tier] || REPUTATION_STYLES.newcomer;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold ${config.color}`}>
      <span>{config.icon}</span>
      {config.label}
    </span>
  );
}

// ────────────────────── Browse Tab: Bounty Card ──────────────────────

function BountyCard({
  bounty,
  onClaim,
  claiming,
}: {
  bounty: any;
  onClaim: () => void;
  claiming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const difficulty = bounty.difficulty || 'beginner';
  const diffConfig = DIFFICULTY_STYLES[difficulty] || DIFFICULTY_STYLES.beginner;
  const claimedCount = bounty.currentAttempts ?? 0;
  const maxAttempts = bounty.maxAttempts ?? 1;
  const isFull = claimedCount >= maxAttempts;

  return (
    <div className={`relative rounded-lg border p-3 transition-all hover:scale-[1.005] ${diffConfig.border} ${diffConfig.bg}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{bounty.title || 'Untitled Bounty'}</span>
            <DifficultyBadge difficulty={difficulty} />
          </div>
          {bounty.description && (
            <p
              className={`text-xs text-gray-400 mt-1 ${!expanded ? 'line-clamp-2' : ''} cursor-pointer`}
              onClick={() => setExpanded(!expanded)}
            >
              {bounty.description}
            </p>
          )}
          {!expanded && bounty.description && bounty.description.length > 100 && (
            <button onClick={() => setExpanded(true)} className="text-[10px] text-cyan-400 hover:text-cyan-300 mt-0.5">
              Show more
            </button>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span className="flex items-center gap-1 text-sm font-bold text-amber-300">
            {bounty.tokenReward ?? 0} <span className="text-xs">&#x1FA99;</span>
          </span>
        </div>
      </div>

      {/* Bonus rewards + metadata */}
      <div className="flex flex-wrap items-center gap-2 mt-2">
        {bounty.bonusRewards?.map((r: any, i: number) => (
          <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 border border-amber-500/40 text-amber-300">
            {BONUS_REWARD_ICONS[r.type] || '\uD83C\uDF81'} {r.label || r.type}
          </span>
        ))}
        {bounty.tags?.map((tag: string) => (
          <span key={tag} className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-white/5 border border-white/10 text-gray-500">
            {tag}
          </span>
        ))}
      </div>

      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-3">
          {bounty.creatorPetName && (
            <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
              by <span className="text-gray-300 font-medium">{bounty.creatorPetName}</span>
            </span>
          )}
          <span className="text-[10px] text-gray-500">
            {claimedCount}/{maxAttempts} claimed
          </span>
          {bounty.expiresAt && (
            <span className="text-[10px] text-gray-500">
              Expires: {new Date(bounty.expiresAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <button
          onClick={onClaim}
          disabled={claiming || isFull}
          className="text-xs font-bold px-4 py-1.5 rounded-lg bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {claiming ? 'Claiming...' : isFull ? 'Fully Claimed' : 'Claim Bounty'}
        </button>
      </div>
    </div>
  );
}

// ────────────────────── My Attempts Tab: Attempt Card ──────────────────────

function AttemptCard({
  attempt,
  onSubmit,
  onAbandon,
  submitting,
  abandoning,
}: {
  attempt: any;
  onSubmit: (data: { prLink?: string; submissionNote: string }) => void;
  onAbandon: () => void;
  submitting: boolean;
  abandoning: boolean;
}) {
  const [showSubmitForm, setShowSubmitForm] = useState(false);
  const [prLink, setPrLink] = useState('');
  const [note, setNote] = useState('');
  const bounty = attempt.bounty || {};
  const status = attempt.status || 'claimed';
  const difficulty = bounty.difficulty || 'beginner';
  const diffConfig = DIFFICULTY_STYLES[difficulty] || DIFFICULTY_STYLES.beginner;

  const handleSubmit = () => {
    if (note.length < 10) return;
    onSubmit({ prLink: prLink || undefined, submissionNote: note });
    setShowSubmitForm(false);
    setPrLink('');
    setNote('');
  };

  const canSubmit = status === 'claimed' || status === 'in_progress';
  const canAbandon = status === 'claimed' || status === 'in_progress';

  return (
    <div className={`rounded-lg border p-3 ${diffConfig.border} ${diffConfig.bg}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{bounty.title || attempt.bountyTitle || 'Bounty'}</span>
            <DifficultyBadge difficulty={difficulty} />
            <AttemptStatusBadge status={status} />
          </div>
          {bounty.description && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">{bounty.description}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span className="flex items-center gap-1 text-sm font-bold text-amber-300">
            {bounty.tokenReward ?? '?'} <span className="text-xs">&#x1FA99;</span>
          </span>
        </div>
      </div>

      {/* Status progression bar */}
      <div className="flex items-center gap-0 my-3">
        {(['claimed', 'in_progress', 'submitted', 'approved'] as const).map((step, i, arr) => {
          const stepConfig = ATTEMPT_STATUS_STYLES[step];
          const steps = arr;
          const currentIndex = steps.indexOf(status as any);
          const isRejected = status === 'rejected';
          const isActive = i <= currentIndex && !isRejected;
          const isCurrent = step === status;
          const isLast = i === steps.length - 1;

          return (
            <div key={step} className="flex items-center flex-1 last:flex-none">
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
              {!isLast && (
                <div className={`flex-1 h-0.5 mx-1 ${i < currentIndex && !isRejected ? 'bg-cyan-500/40' : 'bg-white/10'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 mt-1">
        {canSubmit && (
          <>
            <button
              onClick={onAbandon}
              disabled={abandoning}
              className="text-xs px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 transition-all disabled:opacity-40"
            >
              {abandoning ? 'Abandoning...' : 'Abandon'}
            </button>
            <button
              onClick={() => setShowSubmitForm(!showSubmitForm)}
              className="text-xs font-bold px-4 py-1.5 rounded-lg bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-400 hover:to-pink-500 text-white transition-all"
            >
              Submit Work
            </button>
          </>
        )}
        {status === 'submitted' && (
          <span className="text-xs text-gray-400 italic px-3 py-1.5">Awaiting Review...</span>
        )}
        {status === 'approved' && (
          <span className="flex items-center gap-1.5 text-xs text-green-400 font-bold px-3 py-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            Approved!
          </span>
        )}
        {status === 'rejected' && (
          <div className="flex items-center gap-2">
            {attempt.reviewNote && (
              <span className="text-[10px] text-red-400/70 italic max-w-[200px] truncate">{attempt.reviewNote}</span>
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
      {showSubmitForm && (canSubmit || status === 'rejected') && (
        <div className="mt-4 space-y-3 border-t border-white/10 pt-4">
          <input
            type="url"
            placeholder="GitHub PR link (optional)"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/50"
            value={prLink}
            onChange={(e) => setPrLink(e.target.value)}
          />
          <textarea
            placeholder="Describe what you did (min 10 chars)..."
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 h-24 resize-none focus:outline-none focus:border-amber-500/50"
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
                className="text-xs font-bold px-4 py-2 rounded bg-amber-600 hover:bg-amber-500 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
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

// ────────────────────── My Bounties Tab: Creator Bounty Card ──────────────────────

function CreatorBountyCard({
  bounty,
  onCancel,
  onReview,
  cancelling,
  reviewing,
}: {
  bounty: any;
  onCancel: () => void;
  onReview: (attemptId: string, decision: string, reviewNote?: string) => void;
  cancelling: boolean;
  reviewing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [reviewingAttemptId, setReviewingAttemptId] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const difficulty = bounty.difficulty || 'beginner';
  const diffConfig = DIFFICULTY_STYLES[difficulty] || DIFFICULTY_STYLES.beginner;
  const status = bounty.status || 'open';
  const attempts = bounty.attempts || [];
  const hasActiveAttempts = attempts.some((a: any) => ['claimed', 'in_progress', 'submitted'].includes(a.status));

  const handleReview = (attemptId: string, decision: string) => {
    onReview(attemptId, decision, reviewNote || undefined);
    setReviewingAttemptId(null);
    setReviewNote('');
  };

  return (
    <div className={`rounded-lg border p-3 ${diffConfig.border} ${diffConfig.bg}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{bounty.title}</span>
            <DifficultyBadge difficulty={difficulty} />
            <BountyStatusBadge status={status} />
          </div>
          <p className="text-xs text-gray-500 mt-1 line-clamp-1">{bounty.description}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span className="flex items-center gap-1 text-sm font-bold text-amber-300">
            {bounty.tokenReward ?? 0} <span className="text-xs">&#x1FA99;</span>
          </span>
          <span className="text-[10px] text-gray-500">
            {bounty.currentAttempts ?? 0}/{bounty.maxAttempts ?? 1} claimed
          </span>
        </div>
      </div>

      {/* Submissions toggle */}
      <div className="flex items-center justify-between mt-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-cyan-400 hover:text-cyan-300 font-bold"
        >
          {expanded ? 'Hide' : 'View'} Submissions ({attempts.length})
        </button>
        <div className="flex items-center gap-2">
          {status === 'open' && !hasActiveAttempts && (
            <button
              onClick={onCancel}
              disabled={cancelling}
              className="text-xs px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 transition-all disabled:opacity-40"
            >
              {cancelling ? 'Cancelling...' : 'Cancel Bounty'}
            </button>
          )}
        </div>
      </div>

      {/* Expanded submissions list */}
      {expanded && (
        <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
          {attempts.length === 0 ? (
            <p className="text-xs text-gray-500 italic">No submissions yet.</p>
          ) : (
            attempts.map((attempt: any) => (
              <div key={attempt.id} className="rounded border border-white/10 bg-white/5 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-white font-medium">{attempt.hunterName || 'Hunter'}</span>
                    <AttemptStatusBadge status={attempt.status} />
                  </div>
                  <span className="text-[10px] text-gray-500">
                    {attempt.submittedAt ? new Date(attempt.submittedAt).toLocaleDateString() : ''}
                  </span>
                </div>
                {attempt.submissionNote && (
                  <p className="text-xs text-gray-400 mt-1.5">{attempt.submissionNote}</p>
                )}
                {attempt.prLink && (
                  <a href={attempt.prLink} target="_blank" rel="noopener noreferrer" className="text-[10px] text-cyan-400 hover:text-cyan-300 mt-1 block truncate">
                    {attempt.prLink}
                  </a>
                )}

                {/* Review actions for submitted attempts */}
                {attempt.status === 'submitted' && (
                  <div className="mt-2">
                    {reviewingAttemptId === attempt.id ? (
                      <div className="space-y-2">
                        <textarea
                          placeholder="Review note (optional)..."
                          className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 h-16 resize-none focus:outline-none focus:border-amber-500/50"
                          value={reviewNote}
                          onChange={(e) => setReviewNote(e.target.value)}
                        />
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleReview(attempt.id, 'approve')}
                            disabled={reviewing}
                            className="text-xs font-bold px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white transition-all disabled:opacity-40"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => handleReview(attempt.id, 'reject')}
                            disabled={reviewing}
                            className="text-xs font-bold px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white transition-all disabled:opacity-40"
                          >
                            Reject
                          </button>
                          <button
                            onClick={() => { setReviewingAttemptId(null); setReviewNote(''); }}
                            className="text-xs text-gray-400 hover:text-gray-300 px-2"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setReviewingAttemptId(attempt.id)}
                        className="text-xs font-bold px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 transition-all"
                      >
                        Review
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────── Create Tab: Bounty Form ──────────────────────

function CreateBountyForm({
  tokens,
  onCreated,
}: {
  tokens: number;
  onCreated: () => void;
}) {
  const { addToast } = useGameStore();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [requirements, setRequirements] = useState('');
  const [difficulty, setDifficulty] = useState<string>('beginner');
  const [tokenReward, setTokenReward] = useState<number>(50);
  const [maxAttempts, setMaxAttempts] = useState<number>(3);
  const [tagsInput, setTagsInput] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [bonusRewards, setBonusRewards] = useState<Array<{ type: string; label: string; value: string }>>([]);

  const createMutation = useMutation({
    mutationFn: (data: any) => api.createBounty(data),
    onSuccess: () => {
      addToast('\uD83D\uDCCC', 'Bounty posted!');
      queryClient.invalidateQueries({ queryKey: ['bounties'] });
      queryClient.invalidateQueries({ queryKey: ['my-bounties'] });
      queryClient.invalidateQueries({ queryKey: ['pet'] });
      onCreated();
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Failed to post bounty');
    },
  });

  const handleAddBonus = () => {
    setBonusRewards([...bonusRewards, { type: 'custom', label: '', value: '' }]);
  };

  const handleRemoveBonus = (index: number) => {
    setBonusRewards(bonusRewards.filter((_, i) => i !== index));
  };

  const handleBonusChange = (index: number, field: string, value: string) => {
    const updated = [...bonusRewards];
    (updated[index] as any)[field] = value;
    setBonusRewards(updated);
  };

  const handleSubmit = () => {
    if (!title.trim() || !description.trim()) return;
    if (tokenReward < 1) return;
    if (tokenReward > tokens) return;

    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    createMutation.mutate({
      title: title.trim(),
      description: description.trim(),
      requirements: requirements.trim() || undefined,
      difficulty,
      tokenReward,
      maxAttempts,
      tags: tags.length > 0 ? tags : undefined,
      expiresAt: expiresAt || undefined,
      bonusRewards: bonusRewards.length > 0 ? bonusRewards.filter((b) => b.label.trim()) : undefined,
    });
  };

  return (
    <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
      {/* Title */}
      <div>
        <label className="block text-[10px] text-gray-400 uppercase tracking-wider font-bold mb-1">Title *</label>
        <input
          type="text"
          placeholder="e.g. Build a cron job scheduler plugin"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/50"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-[10px] text-gray-400 uppercase tracking-wider font-bold mb-1">Description *</label>
        <textarea
          placeholder="Detailed description of what needs to be done..."
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 h-28 resize-none focus:outline-none focus:border-amber-500/50"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {/* Requirements */}
      <div>
        <label className="block text-[10px] text-gray-400 uppercase tracking-wider font-bold mb-1">Requirements (optional)</label>
        <textarea
          placeholder="Specific requirements or acceptance criteria..."
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 h-20 resize-none focus:outline-none focus:border-amber-500/50"
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
        />
      </div>

      {/* Row: Difficulty + Token Reward + Max Attempts */}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-[10px] text-gray-400 uppercase tracking-wider font-bold mb-1">Difficulty</label>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-2 text-sm text-gray-300 focus:outline-none focus:border-amber-500/50"
          >
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
            <option value="expert">Expert</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-gray-400 uppercase tracking-wider font-bold mb-1">
            Token Reward
            <span className="text-amber-300 ml-1">(bal: {tokens})</span>
          </label>
          <input
            type="number"
            min={1}
            max={tokens}
            value={tokenReward}
            onChange={(e) => setTokenReward(Number(e.target.value))}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-amber-500/50"
          />
        </div>
        <div>
          <label className="block text-[10px] text-gray-400 uppercase tracking-wider font-bold mb-1">Max Attempts</label>
          <input
            type="number"
            min={1}
            max={20}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(Number(e.target.value))}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-amber-500/50"
          />
        </div>
      </div>

      {/* Tags */}
      <div>
        <label className="block text-[10px] text-gray-400 uppercase tracking-wider font-bold mb-1">Tags (comma-separated)</label>
        <input
          type="text"
          placeholder="e.g. plugin, cron, scheduling"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/50"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
        />
      </div>

      {/* Expiry */}
      <div>
        <label className="block text-[10px] text-gray-400 uppercase tracking-wider font-bold mb-1">Expiry Date (optional)</label>
        <input
          type="date"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500/50"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
        />
      </div>

      {/* Bonus Rewards */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] text-gray-400 uppercase tracking-wider font-bold">Bonus Rewards</label>
          <button
            onClick={handleAddBonus}
            className="text-[10px] font-bold text-amber-400 hover:text-amber-300 transition-colors"
          >
            + Add Bonus Reward
          </button>
        </div>
        {bonusRewards.map((bonus, i) => (
          <div key={i} className="flex items-center gap-2 mb-2">
            <select
              value={bonus.type}
              onChange={(e) => handleBonusChange(i, 'type', e.target.value)}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-amber-500/50"
            >
              <option value="skill">Skill</option>
              <option value="agent_config">Agent Config</option>
              <option value="knowledge_book">Knowledge Book</option>
              <option value="custom">Custom</option>
            </select>
            <input
              type="text"
              placeholder="Label"
              className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/50"
              value={bonus.label}
              onChange={(e) => handleBonusChange(i, 'label', e.target.value)}
            />
            <input
              type="text"
              placeholder="Value / ID"
              className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/50"
              value={bonus.value}
              onChange={(e) => handleBonusChange(i, 'value', e.target.value)}
            />
            <button
              onClick={() => handleRemoveBonus(i)}
              className="text-red-400 hover:text-red-300 text-xs px-1"
            >
              {'\u2715'}
            </button>
          </div>
        ))}
      </div>

      {/* Escrow warning */}
      <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3">
        <p className="text-xs text-amber-300 font-bold">Escrow Notice</p>
        <p className="text-[10px] text-amber-200/70 mt-1">
          {tokenReward} tokens will be held in escrow when you post this bounty. Tokens are released to the hunter upon approval, or returned to you if cancelled (with no active attempts).
        </p>
      </div>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={createMutation.isPending || !title.trim() || !description.trim() || tokenReward < 1 || tokenReward > tokens}
        className="w-full text-sm font-bold py-3 rounded-lg bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {createMutation.isPending ? 'Posting...' : `Post Bounty (${tokenReward} tokens escrowed)`}
      </button>
    </div>
  );
}

// ────────────────────── Main Modal ──────────────────────

export default function BountyBoardModal() {
  const { bountyBoardOpen, closeBountyBoard, bountyBoardTab, setBountyBoardTab, addToast } = useGameStore();
  const { data: pet } = usePet();
  const queryClient = useQueryClient();

  // Filters
  const [difficultyFilter, setDifficultyFilter] = useState<DifficultyFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [page, setPage] = useState(1);

  // Local state
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [abandoningId, setAbandoningId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  // Reset page on filter/tab change
  useEffect(() => {
    setPage(1);
  }, [bountyBoardTab, difficultyFilter, sortMode]);

  // Build query params
  const queryParams = {
    page,
    difficulty: difficultyFilter !== 'all' ? difficultyFilter : undefined,
    status: 'open' as string | undefined,
    sort: sortMode,
  };

  // Browse bounties query
  const { data: bountiesData, isLoading: bountiesLoading } = useQuery({
    queryKey: ['bounties', queryParams],
    queryFn: () => api.getBounties(queryParams),
    enabled: bountyBoardOpen && bountyBoardTab === 'browse',
  });

  // My bounties query (creator)
  const { data: myBountiesData, isLoading: myBountiesLoading } = useQuery({
    queryKey: ['my-bounties'],
    queryFn: () => api.getMyBounties(),
    enabled: bountyBoardOpen && bountyBoardTab === 'my-bounties',
  });

  // My attempts query (hunter)
  const { data: myAttemptsData, isLoading: myAttemptsLoading } = useQuery({
    queryKey: ['my-bounty-attempts'],
    queryFn: () => api.getMyBountyAttempts(),
    enabled: bountyBoardOpen && bountyBoardTab === 'my-attempts',
  });

  // Claim mutation
  const claimMutation = useMutation({
    mutationFn: (bountyId: string) => api.claimBounty(bountyId),
    onSuccess: () => {
      addToast('\uD83C\uDFAF', 'Bounty claimed! Get to work!');
      queryClient.invalidateQueries({ queryKey: ['bounties'] });
      queryClient.invalidateQueries({ queryKey: ['my-bounty-attempts'] });
      setClaimingId(null);
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Failed to claim bounty');
      setClaimingId(null);
    },
  });

  // Submit mutation
  const submitMutation = useMutation({
    mutationFn: ({ bountyId, data }: { bountyId: string; data: { prLink?: string; submissionNote: string } }) =>
      api.submitBountyAttempt(bountyId, data),
    onSuccess: () => {
      addToast('\u2705', 'Work submitted for review!');
      queryClient.invalidateQueries({ queryKey: ['my-bounty-attempts'] });
      setSubmittingId(null);
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Submission failed');
      setSubmittingId(null);
    },
  });

  // Abandon mutation
  const abandonMutation = useMutation({
    mutationFn: (bountyId: string) => api.abandonBounty(bountyId),
    onSuccess: () => {
      addToast('\uD83D\uDEAA', 'Bounty abandoned');
      queryClient.invalidateQueries({ queryKey: ['my-bounty-attempts'] });
      queryClient.invalidateQueries({ queryKey: ['bounties'] });
      setAbandoningId(null);
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Failed to abandon');
      setAbandoningId(null);
    },
  });

  // Cancel mutation (creator)
  const cancelMutation = useMutation({
    mutationFn: (bountyId: string) => api.cancelBounty(bountyId),
    onSuccess: () => {
      addToast('\uD83D\uDDD1\uFE0F', 'Bounty cancelled. Tokens refunded.');
      queryClient.invalidateQueries({ queryKey: ['my-bounties'] });
      queryClient.invalidateQueries({ queryKey: ['bounties'] });
      queryClient.invalidateQueries({ queryKey: ['pet'] });
      setCancellingId(null);
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Failed to cancel');
      setCancellingId(null);
    },
  });

  // Review mutation
  const reviewMutation = useMutation({
    mutationFn: ({ attemptId, data }: { attemptId: string; data: { decision: string; reviewNote?: string } }) =>
      api.reviewBountyAttempt(attemptId, data),
    onSuccess: () => {
      addToast('\u2705', 'Review submitted!');
      queryClient.invalidateQueries({ queryKey: ['my-bounties'] });
      queryClient.invalidateQueries({ queryKey: ['my-bounty-attempts'] });
      queryClient.invalidateQueries({ queryKey: ['bounties'] });
      queryClient.invalidateQueries({ queryKey: ['pet'] });
      setReviewingId(null);
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Review failed');
      setReviewingId(null);
    },
  });

  const handleClaim = useCallback((bountyId: string) => {
    setClaimingId(bountyId);
    claimMutation.mutate(bountyId);
  }, [claimMutation]);

  const handleSubmit = useCallback((bountyId: string, data: { prLink?: string; submissionNote: string }) => {
    setSubmittingId(bountyId);
    submitMutation.mutate({ bountyId, data });
  }, [submitMutation]);

  const handleAbandon = useCallback((bountyId: string) => {
    setAbandoningId(bountyId);
    abandonMutation.mutate(bountyId);
  }, [abandonMutation]);

  const handleCancel = useCallback((bountyId: string) => {
    setCancellingId(bountyId);
    cancelMutation.mutate(bountyId);
  }, [cancelMutation]);

  const handleReview = useCallback((attemptId: string, decision: string, reviewNote?: string) => {
    setReviewingId(attemptId);
    reviewMutation.mutate({ attemptId, data: { decision, reviewNote } });
  }, [reviewMutation]);

  // Close on Escape
  useEffect(() => {
    if (!bountyBoardOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeBountyBoard();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [bountyBoardOpen, closeBountyBoard]);

  if (!bountyBoardOpen) return null;

  const bounties = bountiesData?.bounties ?? [];
  const total = bountiesData?.total ?? 0;
  const pageSize = bountiesData?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const myBounties = myBountiesData?.bounties ?? [];
  const myAttempts = myAttemptsData?.attempts ?? [];
  const tokens = pet?.clawTokens ?? pet?.clawTokens ?? 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-gradient-to-b from-[#1a1208]/90 via-[#0f1a2e]/90 to-[#1a1208]/90 backdrop-blur-sm"
        onClick={closeBountyBoard}
      />

      {/* Modal */}
      <div className="relative w-full max-w-4xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="claw-panel flex flex-col overflow-hidden bg-gradient-to-b from-[#1a1208] to-[#0f1a2e] border-2 border-amber-500/30">
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{'\uD83D\uDCCC'}</span>
              <div>
                <h2 className="font-bold text-lg text-white tracking-wide">Bounty Board</h2>
                <p className="text-[10px] text-amber-400/60 uppercase tracking-widest">Community Bounties &middot; Escrow &middot; Reputation</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-sm font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-3 py-1">
                <span className="text-base">&#x1FA99;</span>
                {tokens}
              </span>
              <button
                onClick={closeBountyBoard}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white font-bold text-sm transition-colors border border-white/10"
              >
                {'\u2715'}
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-amber-500/20 px-5">
            {([
              { key: 'browse', label: 'Browse' },
              { key: 'my-bounties', label: 'My Bounties' },
              { key: 'my-attempts', label: 'My Attempts' },
              { key: 'create', label: 'Post Bounty' },
            ] as { key: BountyTab; label: string }[]).map((t) => (
              <button
                key={t.key}
                onClick={() => setBountyBoardTab(t.key)}
                className={`px-4 py-2.5 text-sm font-bold transition-colors border-b-2 ${
                  bountyBoardTab === t.key
                    ? 'text-amber-300 border-amber-400'
                    : 'text-gray-500 border-transparent hover:text-gray-300'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto">
            {/* ===== BROWSE TAB ===== */}
            {bountyBoardTab === 'browse' && (
              <div className="flex flex-col">
                {/* Filters bar */}
                <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-white/5">
                  <select
                    value={difficultyFilter}
                    onChange={(e) => setDifficultyFilter(e.target.value as DifficultyFilter)}
                    className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-amber-500/50"
                  >
                    <option value="all">All Difficulties</option>
                    <option value="beginner">Beginner</option>
                    <option value="intermediate">Intermediate</option>
                    <option value="advanced">Advanced</option>
                    <option value="expert">Expert</option>
                  </select>
                  <select
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as SortMode)}
                    className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-amber-500/50"
                  >
                    <option value="newest">Newest First</option>
                    <option value="reward-high">Highest Reward</option>
                    <option value="reward-low">Lowest Reward</option>
                    <option value="expiring-soon">Expiring Soon</option>
                  </select>
                  <span className="ml-auto text-[10px] text-gray-500">
                    {total} bount{total !== 1 ? 'ies' : 'y'} available
                  </span>
                </div>

                {/* Bounty list */}
                <div className="px-5 py-3 space-y-2 min-h-[200px] max-h-[55vh]">
                  {bountiesLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin w-6 h-6 border-2 border-amber-300 border-t-transparent rounded-full" />
                    </div>
                  ) : bounties.length === 0 ? (
                    <div className="text-center py-12">
                      <span className="text-3xl block mb-2">{'\uD83D\uDCCC'}</span>
                      <p className="text-gray-500 text-sm">No bounties available right now.</p>
                      <p className="text-gray-600 text-xs mt-1">Post one from the &quot;Post Bounty&quot; tab!</p>
                    </div>
                  ) : (
                    <>
                      {bounties.map((bounty: any) => (
                        <BountyCard
                          key={bounty.id}
                          bounty={bounty}
                          onClaim={() => handleClaim(bounty.id)}
                          claiming={claimingId === bounty.id}
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

            {/* ===== MY BOUNTIES TAB (CREATOR) ===== */}
            {bountyBoardTab === 'my-bounties' && (
              <div className="px-5 py-3 space-y-2 min-h-[200px] max-h-[55vh]">
                {myBountiesLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin w-6 h-6 border-2 border-amber-300 border-t-transparent rounded-full" />
                  </div>
                ) : myBounties.length === 0 ? (
                  <div className="text-center py-12">
                    <span className="text-3xl block mb-2">{'\uD83D\uDCCC'}</span>
                    <p className="text-gray-500 text-sm">You haven&apos;t posted any bounties.</p>
                    <p className="text-gray-600 text-xs mt-1">Switch to the &quot;Post Bounty&quot; tab to create one!</p>
                  </div>
                ) : (
                  <>
                    {/* Summary */}
                    <div className="flex items-center gap-4 mb-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <div>
                        <p className="text-[10px] text-amber-400/70 uppercase tracking-wider font-bold">Active</p>
                        <p className="text-lg font-bold text-amber-400">
                          {myBounties.filter((b: any) => b.status === 'open' || b.status === 'in_progress').length}
                        </p>
                      </div>
                      <div className="h-8 w-px bg-amber-500/20" />
                      <div>
                        <p className="text-[10px] text-amber-400/70 uppercase tracking-wider font-bold">Completed</p>
                        <p className="text-lg font-bold text-green-400">
                          {myBounties.filter((b: any) => b.status === 'completed').length}
                        </p>
                      </div>
                      <div className="h-8 w-px bg-amber-500/20" />
                      <div>
                        <p className="text-[10px] text-amber-400/70 uppercase tracking-wider font-bold">Total Escrowed</p>
                        <p className="text-lg font-bold text-amber-300">
                          {myBounties.filter((b: any) => b.status === 'open' || b.status === 'in_progress').reduce((sum: number, b: any) => sum + (b.tokenReward || 0), 0)} &#x1FA99;
                        </p>
                      </div>
                    </div>

                    {myBounties.map((bounty: any) => (
                      <CreatorBountyCard
                        key={bounty.id}
                        bounty={bounty}
                        onCancel={() => handleCancel(bounty.id)}
                        onReview={(attemptId, decision, reviewNote) => handleReview(attemptId, decision, reviewNote)}
                        cancelling={cancellingId === bounty.id}
                        reviewing={reviewMutation.isPending}
                      />
                    ))}
                  </>
                )}
              </div>
            )}

            {/* ===== MY ATTEMPTS TAB (HUNTER) ===== */}
            {bountyBoardTab === 'my-attempts' && (
              <div className="px-5 py-3 space-y-2 min-h-[200px] max-h-[55vh]">
                {myAttemptsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin w-6 h-6 border-2 border-amber-300 border-t-transparent rounded-full" />
                  </div>
                ) : myAttempts.length === 0 ? (
                  <div className="text-center py-12">
                    <span className="text-3xl block mb-2">{'\uD83C\uDFAF'}</span>
                    <p className="text-gray-500 text-sm">No bounty attempts yet.</p>
                    <p className="text-gray-600 text-xs mt-1">Claim a bounty from the Browse tab to get started!</p>
                  </div>
                ) : (
                  <>
                    {/* Summary */}
                    <div className="flex items-center gap-4 mb-3 p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
                      <div>
                        <p className="text-[10px] text-cyan-400/70 uppercase tracking-wider font-bold">In Progress</p>
                        <p className="text-lg font-bold text-cyan-400">
                          {myAttempts.filter((a: any) => ['claimed', 'in_progress'].includes(a.status)).length}
                        </p>
                      </div>
                      <div className="h-8 w-px bg-cyan-500/20" />
                      <div>
                        <p className="text-[10px] text-cyan-400/70 uppercase tracking-wider font-bold">Awaiting Review</p>
                        <p className="text-lg font-bold text-yellow-400">
                          {myAttempts.filter((a: any) => a.status === 'submitted').length}
                        </p>
                      </div>
                      <div className="h-8 w-px bg-cyan-500/20" />
                      <div>
                        <p className="text-[10px] text-cyan-400/70 uppercase tracking-wider font-bold">Approved</p>
                        <p className="text-lg font-bold text-green-400">
                          {myAttempts.filter((a: any) => a.status === 'approved').length}
                        </p>
                      </div>
                    </div>

                    {myAttempts.map((attempt: any) => (
                      <AttemptCard
                        key={attempt.id}
                        attempt={attempt}
                        onSubmit={(data) => handleSubmit(attempt.bountyId || attempt.id, data)}
                        onAbandon={() => handleAbandon(attempt.bountyId || attempt.id)}
                        submitting={submittingId === (attempt.bountyId || attempt.id)}
                        abandoning={abandoningId === (attempt.bountyId || attempt.id)}
                      />
                    ))}
                  </>
                )}
              </div>
            )}

            {/* ===== CREATE TAB ===== */}
            {bountyBoardTab === 'create' && (
              <CreateBountyForm
                tokens={tokens}
                onCreated={() => setBountyBoardTab('my-bounties')}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
