'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { usePet } from '@/hooks/use-pet';
import { api } from '@/lib/api';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type QuestTab = 'available' | 'active' | 'completed';
type TierFilter = 'all' | 'side_quest' | 'main_quest' | 'legendary';

interface Quest {
  id: string;
  title: string;
  description: string;
  tier: 'side_quest' | 'main_quest' | 'legendary';
  tokenReward: number;
  skillReward?: string;
  titleReward?: string;
  expiresAt?: string;
  completedCount?: number;
  maxCompletions?: number;
  requirements?: string[];
  location?: string;
}

interface QuestSubmission {
  id: string;
  questId: string;
  status: 'accepted' | 'in_progress' | 'submitted' | 'in_review' | 'approved' | 'rejected';
  reviewNote?: string;
  quest: Quest;
}

interface QuestReward {
  id: string;
  questId: string;
  submissionId: string;
  tokensAwarded: number;
  skillId: string | null;
  skillName: string | null;
  titleAwarded: string | null;
  claimedAt: string;
  quest: {
    title: string;
    tier: string;
    description: string;
  };
}

// ─────────────────────────────────────────────
// Tier Config
// ─────────────────────────────────────────────

const TIER_CONFIG = {
  side_quest: {
    label: 'Side Quest',
    icon: '\uD83D\uDCDC',
    color: 'text-slate-300',
    bg: 'bg-slate-500/15',
    border: 'border-slate-500/40',
    borderHover: 'hover:border-slate-400/60',
    glow: '',
    headerBg: 'bg-slate-600/20',
    tokenRange: '10–50',
    accent: 'text-slate-300',
    buttonFrom: 'from-slate-500',
    buttonTo: 'to-slate-600',
    badgeBg: 'bg-slate-500/20',
    badgeBorder: 'border-slate-400/40',
    badgeText: 'text-slate-300',
  },
  main_quest: {
    label: 'Main Quest',
    icon: '\u2694\uFE0F',
    color: 'text-cyan-300',
    bg: 'bg-cyan-500/10',
    border: 'border-cyan-500/40',
    borderHover: 'hover:border-cyan-400/60',
    glow: 'shadow-[0_0_16px_rgba(0,229,255,0.12)]',
    headerBg: 'bg-cyan-600/15',
    tokenRange: '100–500',
    accent: 'text-cyan-300',
    buttonFrom: 'from-cyan-500',
    buttonTo: 'to-blue-600',
    badgeBg: 'bg-cyan-500/20',
    badgeBorder: 'border-cyan-400/50',
    badgeText: 'text-cyan-300',
  },
  legendary: {
    label: 'Legendary',
    icon: '\uD83D\uDC51',
    color: 'text-amber-300',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/40',
    borderHover: 'hover:border-amber-400/70',
    glow: 'shadow-[0_0_24px_rgba(245,158,11,0.25)]',
    headerBg: 'bg-amber-600/15',
    tokenRange: '1000+',
    accent: 'text-amber-300',
    buttonFrom: 'from-amber-500',
    buttonTo: 'to-orange-600',
    badgeBg: 'bg-amber-500/20',
    badgeBorder: 'border-amber-400/50',
    badgeText: 'text-amber-300',
  },
} as const;

const STATUS_CONFIG = {
  accepted:    { label: 'Accepted',      color: 'text-cyan-400',    bg: 'bg-cyan-500/15',    border: 'border-cyan-500/40' },
  in_progress: { label: 'In Progress',   color: 'text-blue-400',    bg: 'bg-blue-500/15',    border: 'border-blue-500/40' },
  submitted:   { label: 'Submitted',     color: 'text-purple-400',  bg: 'bg-purple-500/15',  border: 'border-purple-500/40' },
  in_review:   { label: 'Under Review',  color: 'text-yellow-400',  bg: 'bg-yellow-500/15',  border: 'border-yellow-500/40' },
  approved:    { label: 'Completed',     color: 'text-green-400',   bg: 'bg-green-500/15',   border: 'border-green-500/40' },
  rejected:    { label: 'Rejected',      color: 'text-red-400',     bg: 'bg-red-500/15',     border: 'border-red-500/40' },
} as const;

const PROGRESS_STEPS: Array<keyof typeof STATUS_CONFIG> = [
  'accepted', 'in_progress', 'submitted', 'in_review', 'approved',
];

// ─────────────────────────────────────────────
// Placeholder Data (replaces live API until wired)
// ─────────────────────────────────────────────

const PLACEHOLDER_QUESTS: Quest[] = [
  {
    id: 'q1',
    title: 'First Steps in the Abyss',
    description: 'Visit the Tide Clock Grotto and speak with the Cron Keeper. Learn how scheduled jobs keep the ocean of automation flowing on time.',
    tier: 'side_quest',
    tokenReward: 25,
    skillReward: 'Cron Basics',
    requirements: ['Visit Tide Clock Grotto', 'Talk to the Cron Keeper NPC'],
    location: 'Tide Clock Grotto',
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    completedCount: 12,
    maxCompletions: 100,
  },
  {
    id: 'q2',
    title: 'Ride the Current',
    description: 'Configure a webhook at the Current Gateway to intercept incoming tide signals. The gateway handles thousands of HTTP events per second — master it.',
    tier: 'main_quest',
    tokenReward: 200,
    skillReward: 'Webhook Mastery',
    requirements: [
      'Reach the Current Gateway building',
      'Configure one incoming webhook endpoint',
      'Submit a PR with your implementation',
    ],
    location: 'Current Gateway',
    expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
    completedCount: 3,
    maxCompletions: 50,
  },
  {
    id: 'q3',
    title: 'Keeper of Forgotten Depths',
    description: 'Journey to the Abyssal Vault and architect a vector memory system capable of storing 10,000 embeddings. The deep ocean never forgets — neither should your agent. Deliver a full LanceDB integration with semantic search across agent memories.',
    tier: 'legendary',
    tokenReward: 1500,
    skillReward: 'Vector Memory Architect',
    titleReward: 'Depth Keeper',
    requirements: [
      'Reach Abyssal Vault',
      'Design a LanceDB schema for agent memories',
      'Implement semantic similarity search',
      'Submit PR with benchmarks (10k+ entries)',
      'Write documentation for other agents to use',
    ],
    location: 'Abyssal Vault',
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    completedCount: 0,
    maxCompletions: 5,
  },
  {
    id: 'q4',
    title: 'Signal Relay Protocol',
    description: 'Set up a multi-channel bridge at the Coral Bridge. Route messages from Discord to Telegram seamlessly, proving your cross-platform channel mastery.',
    tier: 'main_quest',
    tokenReward: 350,
    skillReward: 'Channel Bridge Expert',
    requirements: [
      'Visit the Coral Bridge',
      'Implement a Discord → Telegram relay',
      'Handle rate limiting and error recovery',
    ],
    location: 'Coral Bridge',
  },
  {
    id: 'q5',
    title: 'Fix a Leaking Pipe',
    description: 'A minor memory leak has been spotted near the Salvage Workshop. Track it down and patch it up.',
    tier: 'side_quest',
    tokenReward: 15,
    requirements: ['Visit Salvage Workshop', 'Report the bug in the task tracker'],
    location: 'Salvage Workshop',
  },
];

const PLACEHOLDER_ACTIVE: QuestSubmission[] = [
  {
    id: 'sub1',
    questId: 'q4',
    status: 'in_progress',
    quest: PLACEHOLDER_QUESTS[3],
  },
];

const PLACEHOLDER_REWARDS: QuestReward[] = [
  {
    id: 'r1',
    questId: 'q1',
    submissionId: 'sub0',
    tokensAwarded: 25,
    skillId: null,
    skillName: 'Cron Basics',
    titleAwarded: null,
    claimedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    quest: { title: 'First Steps in the Abyss', tier: 'side_quest', description: '' },
  },
];

// ─────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────

function TierBadge({ tier }: { tier: string }) {
  const cfg = TIER_CONFIG[tier as keyof typeof TIER_CONFIG] ?? TIER_CONFIG.side_quest;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border ${cfg.badgeBg} ${cfg.badgeBorder} ${cfg.badgeText}`}
    >
      <span aria-hidden="true">{cfg.icon}</span>
      {cfg.label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.accepted;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border ${cfg.bg} ${cfg.border} ${cfg.color}`}
    >
      {cfg.label}
    </span>
  );
}

function TokenPill({ amount }: { amount: number | string }) {
  return (
    <span className="inline-flex items-center gap-1 font-bold text-amber-300">
      {amount}
      <span className="text-xs" aria-label="tokens">&#x1FA99;</span>
    </span>
  );
}

function LegendaryShimmer() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 rounded-lg overflow-hidden pointer-events-none"
    >
      <div className="absolute -inset-full h-full w-1/3 bg-gradient-to-r from-transparent via-amber-300/10 to-transparent skew-x-[-20deg] animate-[shimmer_3s_ease-in-out_infinite]" />
    </div>
  );
}

function ProgressTracker({ currentStatus }: { currentStatus: string }) {
  const isRejected = currentStatus === 'rejected';
  const currentIndex = PROGRESS_STEPS.indexOf(currentStatus as keyof typeof STATUS_CONFIG);

  return (
    <div className="flex items-start gap-0 my-3">
      {PROGRESS_STEPS.map((step, i) => {
        const isCompleted = i < currentIndex && !isRejected;
        const isCurrent = step === currentStatus;
        const isFuture = i > currentIndex;
        const cfg = STATUS_CONFIG[step];
        const isLast = i === PROGRESS_STEPS.length - 1;

        return (
          <div key={step} className="flex items-start flex-1 last:flex-none">
            <div className="flex flex-col items-center">
              <div
                className={`w-3 h-3 rounded-full border-2 transition-all duration-300 ${
                  isRejected && isCurrent
                    ? 'bg-red-500 border-red-400 shadow-[0_0_6px_rgba(239,68,68,0.6)]'
                    : isCurrent
                    ? `${cfg.bg} ${cfg.border} shadow-[0_0_8px_rgba(0,200,255,0.35)] scale-110`
                    : isCompleted
                    ? 'bg-cyan-500/50 border-cyan-400/50'
                    : 'bg-white/5 border-white/15'
                }`}
              />
              <span
                className={`text-[8px] mt-1.5 whitespace-nowrap font-mono ${
                  isCompleted || isCurrent ? 'text-gray-300' : 'text-gray-600'
                }`}
              >
                {cfg.label}
              </span>
            </div>
            {!isLast && (
              <div
                className={`flex-1 h-px mx-0.5 mt-1.5 transition-all duration-500 ${
                  isCompleted ? 'bg-cyan-500/40' : 'bg-white/8'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// Quest Detail Panel
// ─────────────────────────────────────────────

function QuestDetailPanel({
  quest,
  onAccept,
  accepting,
  onClose,
}: {
  quest: Quest;
  onAccept: () => void;
  accepting: boolean;
  onClose: () => void;
}) {
  const cfg = TIER_CONFIG[quest.tier] ?? TIER_CONFIG.side_quest;
  const isLegendary = quest.tier === 'legendary';

  const daysLeft = quest.expiresAt
    ? Math.ceil((new Date(quest.expiresAt).getTime() - Date.now()) / 86400000)
    : null;

  return (
    <div
      className={`relative flex flex-col h-full rounded-r-lg border-l ${cfg.border} bg-gradient-to-b from-[rgba(10,22,40,0.98)] to-[rgba(6,14,28,0.98)] overflow-hidden`}
    >
      {isLegendary && <LegendaryShimmer />}

      {/* Detail header */}
      <div className={`relative px-5 pt-4 pb-3 border-b border-white/8 ${cfg.headerBg}`}>
        <button
          onClick={onClose}
          className="absolute top-3 right-3 w-6 h-6 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 text-gray-500 hover:text-gray-300 text-xs transition-colors"
          aria-label="Close detail"
        >
          &#x2715;
        </button>
        <div className="flex items-start gap-2 pr-8">
          <span className="text-2xl leading-none mt-0.5" aria-hidden="true">{cfg.icon}</span>
          <div>
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              <TierBadge tier={quest.tier} />
              {quest.location && (
                <span className="text-[10px] text-gray-500 font-mono">
                  @ {quest.location}
                </span>
              )}
            </div>
            <h3 className={`text-sm font-bold leading-snug ${cfg.color}`}>{quest.title}</h3>
          </div>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="relative flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* Description */}
        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1.5">Objective</p>
          <p className="text-xs text-gray-300 leading-relaxed">{quest.description}</p>
        </div>

        {/* Requirements */}
        {quest.requirements && quest.requirements.length > 0 && (
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1.5">Requirements</p>
            <ul className="space-y-1.5">
              {quest.requirements.map((req, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-gray-400">
                  <span className="text-cyan-500/50 mt-px font-mono shrink-0">&#x25B8;</span>
                  {req}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Rewards */}
        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1.5">Rewards</p>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[10px] text-gray-500 w-20 shrink-0">Tokens</span>
              <TokenPill amount={quest.tokenReward} />
            </div>
            {quest.skillReward && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[10px] text-gray-500 w-20 shrink-0">Skill</span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-500/20 border border-purple-500/40 text-purple-300">
                  + {quest.skillReward}
                </span>
              </div>
            )}
            {quest.titleReward && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[10px] text-gray-500 w-20 shrink-0">Title</span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 border border-amber-500/40 text-amber-300">
                  + {quest.titleReward}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Meta */}
        <div className="space-y-1.5 text-[10px] text-gray-600 font-mono">
          {daysLeft !== null && (
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500">&#x23F0;</span>
              <span className={daysLeft <= 3 ? 'text-red-400 font-bold' : ''}>
                {daysLeft > 0 ? `${daysLeft}d remaining` : 'Expires soon'}
              </span>
            </div>
          )}
          {quest.completedCount != null && quest.maxCompletions != null && (
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500">&#x1F465;</span>
              <span>
                {quest.completedCount} / {quest.maxCompletions} completions
              </span>
              {/* Completion bar */}
              <div className="flex-1 h-1 rounded-full bg-white/8 overflow-hidden ml-1">
                <div
                  className={`h-full rounded-full ${cfg.bg} transition-all duration-700`}
                  style={{
                    width: `${Math.min(100, (quest.completedCount / quest.maxCompletions) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Accept CTA */}
      <div className={`relative px-5 py-4 border-t border-white/8 ${cfg.headerBg}`}>
        {isLegendary && (
          <p className="text-[10px] text-amber-400/70 text-center mb-2 font-mono uppercase tracking-widest">
            Legendary — accept with care
          </p>
        )}
        <button
          onClick={onAccept}
          disabled={accepting}
          className={`w-full py-2.5 rounded-lg text-sm font-bold text-white transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed bg-gradient-to-r ${cfg.buttonFrom} ${cfg.buttonTo} hover:brightness-110 ${isLegendary ? 'shadow-[0_0_20px_rgba(245,158,11,0.3)]' : ''}`}
        >
          {accepting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-4 h-4 border-2 border-white/50 border-t-white rounded-full animate-spin" />
              Accepting...
            </span>
          ) : (
            `Accept Quest`
          )}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Quest List Card (Available Tab)
// ─────────────────────────────────────────────

function QuestCard({
  quest,
  isSelected,
  onSelect,
}: {
  quest: Quest;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const cfg = TIER_CONFIG[quest.tier] ?? TIER_CONFIG.side_quest;
  const isLegendary = quest.tier === 'legendary';

  const daysLeft = quest.expiresAt
    ? Math.ceil((new Date(quest.expiresAt).getTime() - Date.now()) / 86400000)
    : null;

  return (
    <button
      onClick={onSelect}
      className={`relative w-full text-left rounded-lg border p-3.5 transition-all duration-200 cursor-pointer group ${cfg.border} ${cfg.borderHover} ${cfg.bg} ${isLegendary ? cfg.glow : ''} ${
        isSelected
          ? `ring-1 ${isLegendary ? 'ring-amber-400/60' : 'ring-cyan-400/50'} brightness-110`
          : 'hover:brightness-105'
      }`}
    >
      {isLegendary && <LegendaryShimmer />}

      <div className="relative flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {/* Title row */}
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-sm font-bold truncate ${isLegendary ? 'text-amber-200' : 'text-white'}`}>
              {quest.title}
            </span>
          </div>
          <TierBadge tier={quest.tier} />
          {/* Description preview */}
          <p className="text-[11px] text-gray-500 mt-1.5 line-clamp-2 leading-relaxed">
            {quest.description}
          </p>
        </div>

        {/* Right column */}
        <div className="flex flex-col items-end gap-1.5 shrink-0 ml-2">
          <TokenPill amount={quest.tokenReward} />
          {daysLeft !== null && daysLeft <= 7 && (
            <span className={`text-[9px] font-mono ${daysLeft <= 3 ? 'text-red-400' : 'text-gray-500'}`}>
              {daysLeft}d left
            </span>
          )}
        </div>
      </div>

      {/* Footer chips */}
      <div className="relative flex items-center gap-2 mt-2 flex-wrap">
        {quest.skillReward && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
            +{quest.skillReward}
          </span>
        )}
        {quest.titleReward && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
            +{quest.titleReward}
          </span>
        )}
        {quest.location && (
          <span className="text-[9px] text-gray-600 font-mono ml-auto">
            {quest.location}
          </span>
        )}
      </div>

      {/* Selected indicator */}
      {isSelected && (
        <div
          aria-hidden="true"
          className={`absolute right-0 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-l-full ${isLegendary ? 'bg-amber-400' : 'bg-cyan-400'}`}
        />
      )}
    </button>
  );
}

// ─────────────────────────────────────────────
// Active Quest Card (Active Tab)
// ─────────────────────────────────────────────

function ActiveQuestCard({
  submission,
  onStart,
  onSubmit,
  starting,
  submitting,
}: {
  submission: QuestSubmission;
  onStart: () => void;
  onSubmit: (data: { prLink?: string; submissionNote: string }) => void;
  starting: boolean;
  submitting: boolean;
}) {
  const [showForm, setShowForm] = useState(false);
  const [prLink, setPrLink] = useState('');
  const [note, setNote] = useState('');

  const quest = submission.quest;
  const cfg = TIER_CONFIG[quest.tier] ?? TIER_CONFIG.side_quest;
  const status = submission.status;

  const handleSubmit = () => {
    if (note.trim().length < 10) return;
    onSubmit({ prLink: prLink.trim() || undefined, submissionNote: note.trim() });
    setShowForm(false);
    setPrLink('');
    setNote('');
  };

  return (
    <div className={`rounded-lg border p-4 ${cfg.border} ${cfg.bg} ${cfg.glow}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-bold text-white truncate">{quest.title}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <TierBadge tier={quest.tier} />
            <StatusBadge status={status} />
          </div>
        </div>
        <TokenPill amount={quest.tokenReward} />
      </div>

      {/* Progress tracker */}
      <ProgressTracker currentStatus={status} />

      {/* Action row */}
      <div className="flex items-center justify-between mt-2">
        <div className="flex-1 min-w-0">
          {status === 'submitted' && (
            <span className="text-xs text-purple-400/70 italic">Work submitted — awaiting crew review...</span>
          )}
          {status === 'in_review' && (
            <span className="text-xs text-yellow-400/70 italic">Under review by the quest masters...</span>
          )}
          {status === 'approved' && (
            <span className="flex items-center gap-1.5 text-xs text-green-400 font-bold">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
              Quest complete — rewards claimed!
            </span>
          )}
          {status === 'rejected' && submission.reviewNote && (
            <span className="text-[10px] text-red-400/70 italic truncate max-w-[200px]">
              {submission.reviewNote}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 ml-2">
          {status === 'accepted' && (
            <button
              onClick={onStart}
              disabled={starting}
              className="text-xs font-bold px-4 py-1.5 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 hover:brightness-110 text-white transition-all disabled:opacity-40"
            >
              {starting ? 'Starting...' : 'Start Working'}
            </button>
          )}
          {status === 'in_progress' && (
            <button
              onClick={() => setShowForm(!showForm)}
              className="text-xs font-bold px-4 py-1.5 rounded-lg bg-gradient-to-r from-purple-500 to-pink-600 hover:brightness-110 text-white transition-all"
            >
              Submit Work
            </button>
          )}
          {status === 'rejected' && (
            <button
              onClick={() => setShowForm(!showForm)}
              className="text-xs font-bold px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/40 transition-all"
            >
              Re-submit
            </button>
          )}
        </div>
      </div>

      {/* Submission form */}
      {showForm && (status === 'in_progress' || status === 'rejected') && (
        <div className="mt-4 pt-4 border-t border-white/8 space-y-3">
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">
              GitHub PR Link (optional)
            </label>
            <input
              type="url"
              placeholder="https://github.com/..."
              value={prLink}
              onChange={(e) => setPrLink(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500/40 transition-colors"
            />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">
              What Did You Do? <span className="text-gray-600 normal-case">(min 10 chars)</span>
            </label>
            <textarea
              placeholder="Describe your implementation..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 resize-none focus:outline-none focus:border-cyan-500/40 transition-colors"
            />
            <div className="flex items-center justify-between mt-1">
              <span className={`text-[9px] font-mono ${note.trim().length < 10 ? 'text-gray-600' : 'text-green-500/70'}`}>
                {note.trim().length} / 10 min chars
              </span>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setShowForm(false)}
              className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1.5 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting || note.trim().length < 10}
              className="text-xs font-bold px-5 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:brightness-110 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 border border-white/50 border-t-white rounded-full animate-spin" />
                  Submitting...
                </span>
              ) : 'Submit for Review'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Completed Reward Card
// ─────────────────────────────────────────────

function RewardCard({ reward }: { reward: QuestReward }) {
  const cfg = TIER_CONFIG[reward.quest.tier as keyof typeof TIER_CONFIG] ?? TIER_CONFIG.side_quest;

  return (
    <div className={`rounded-lg border p-3.5 ${cfg.border} ${cfg.bg}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-bold text-white truncate">{reward.quest.title}</span>
            <TierBadge tier={reward.quest.tier} />
          </div>
          <p className="text-[10px] text-gray-600 font-mono">
            Completed {new Date(reward.claimedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-sm font-bold text-amber-300 flex items-center gap-1">
            +{reward.tokensAwarded}
            <span className="text-xs" aria-label="tokens">&#x1FA99;</span>
          </span>
          {reward.skillName && (
            <span className="text-[10px] font-bold text-purple-300">+{reward.skillName}</span>
          )}
          {reward.titleAwarded && (
            <span className="text-[10px] font-bold text-amber-300">+{reward.titleAwarded}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Empty States
// ─────────────────────────────────────────────

function EmptyState({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-4xl mb-3 opacity-50">{icon}</div>
      <p className="text-gray-400 text-sm font-bold mb-1">{title}</p>
      <p className="text-gray-600 text-xs max-w-xs">{subtitle}</p>
    </div>
  );
}

function LoadingSpinner({ color = 'border-cyan-300' }: { color?: string }) {
  return (
    <div className="flex items-center justify-center py-16">
      <div className={`w-7 h-7 border-2 ${color} border-t-transparent rounded-full animate-spin`} />
    </div>
  );
}

// ─────────────────────────────────────────────
// Main Modal
// ─────────────────────────────────────────────

export default function QuestBoardModal() {
  const { questBoardOpen, closeQuestBoard, questBoardTab, setQuestBoardTab, addToast } =
    useGameStore();
  const { data: pet } = usePet();
  const queryClient = useQueryClient();

  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [page, setPage] = useState(1);
  const [selectedQuestId, setSelectedQuestId] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);

  // Reset page on filter/tab change
  useEffect(() => {
    setPage(1);
    setSelectedQuestId(null);
  }, [questBoardTab, tierFilter]);

  // Close on Escape
  useEffect(() => {
    if (!questBoardOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedQuestId) setSelectedQuestId(null);
        else closeQuestBoard();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [questBoardOpen, closeQuestBoard, selectedQuestId]);

  // ── Queries ──

  const queryParams = {
    page,
    tier: tierFilter !== 'all' ? tierFilter : undefined,
    status: 'active' as string,
  };

  const { data: questsData, isLoading: questsLoading } = useQuery({
    queryKey: ['quests-available', queryParams],
    queryFn: () => api.getQuests(queryParams),
    enabled: questBoardOpen && questBoardTab === 'available',
  });

  const { data: myQuestsData, isLoading: myQuestsLoading } = useQuery({
    queryKey: ['quests-my-quests'],
    queryFn: () => api.getMyQuests(),
    enabled: questBoardOpen && questBoardTab === 'active',
  });

  const { data: questLogData, isLoading: questLogLoading } = useQuery({
    queryKey: ['quests-quest-log'],
    queryFn: () => api.getQuestLog(),
    enabled: questBoardOpen && questBoardTab === 'completed',
  });

  // ── Mutations ──

  const acceptMutation = useMutation({
    mutationFn: (questId: string) => api.acceptQuest(questId),
    onSuccess: () => {
      addToast('\uD83D\uDCDC', 'Quest accepted! Check your Active Quests.');
      queryClient.invalidateQueries({ queryKey: ['quests-available'] });
      queryClient.invalidateQueries({ queryKey: ['quests-my-quests'] });
      setAcceptingId(null);
      setSelectedQuestId(null);
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Failed to accept quest');
      setAcceptingId(null);
    },
  });

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

  const submitMutation = useMutation({
    mutationFn: ({
      questId,
      data,
    }: {
      questId: string;
      data: { prLink?: string; submissionNote: string };
    }) => api.submitQuest(questId, data),
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

  const handleAccept = useCallback(
    (questId: string) => {
      setAcceptingId(questId);
      acceptMutation.mutate(questId);
    },
    [acceptMutation],
  );

  const handleStart = useCallback(
    (questId: string) => {
      setStartingId(questId);
      startMutation.mutate(questId);
    },
    [startMutation],
  );

  const handleSubmit = useCallback(
    (questId: string, data: { prLink?: string; submissionNote: string }) => {
      setSubmittingId(questId);
      submitMutation.mutate({ questId, data });
    },
    [submitMutation],
  );

  if (!questBoardOpen) return null;

  // ── Derived data ──

  // Use live data if available, fall back to placeholder
  const rawQuests: Quest[] = questsData?.quests ?? PLACEHOLDER_QUESTS;
  const quests: Quest[] = tierFilter === 'all'
    ? rawQuests
    : rawQuests.filter((q) => q.tier === tierFilter);
  const total = questsData?.total ?? quests.length;
  const pageSize = questsData?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const myQuests: QuestSubmission[] = myQuestsData?.submissions ?? PLACEHOLDER_ACTIVE;
  const rewards: QuestReward[] = questLogData?.rewards ?? PLACEHOLDER_REWARDS;

  const tokens = pet?.clawTokens ?? (pet as any)?.neoTokens ?? 0;

  const totalTokensEarned = rewards.reduce((s, r) => s + (r.tokensAwarded || 0), 0);
  const skillsEarned = rewards.filter((r) => r.skillName);
  const titlesEarned = rewards.filter((r) => r.titleAwarded);

  const selectedQuest = quests.find((q) => q.id === selectedQuestId) ?? null;

  const TAB_LABELS: Record<QuestTab, string> = {
    available: 'Available',
    active: 'Active',
    completed: 'Quest Log',
  };

  const TAB_COUNT: Record<QuestTab, number | null> = {
    available: total,
    active: myQuests.length,
    completed: rewards.length,
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-gradient-to-b from-[#050e1f]/95 via-[#071525]/90 to-[#050e1f]/95 backdrop-blur-sm"
        onClick={() => {
          if (selectedQuestId) setSelectedQuestId(null);
          else closeQuestBoard();
        }}
      />

      {/* Modal shell */}
      <div
        className="relative w-full max-w-5xl flex flex-col"
        style={{ maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Outer border glow */}
        <div className="absolute -inset-px rounded-xl bg-gradient-to-b from-cyan-500/20 via-transparent to-amber-500/10 pointer-events-none" aria-hidden="true" />

        <div className="relative rounded-xl bg-gradient-to-b from-[#0b1e38] to-[#070f1e] border border-cyan-500/20 shadow-[0_0_60px_rgba(0,200,255,0.06),0_32px_64px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col">

          {/* ── Header ── */}
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/6">
            <div className="flex items-center gap-4">
              {/* Icon cluster */}
              <div className="relative">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-600/20 border border-cyan-500/30 flex items-center justify-center text-xl shadow-[0_0_12px_rgba(0,200,255,0.15)]">
                  &#x1F4DC;
                </div>
              </div>
              <div>
                <h2 className="text-base font-bold text-white tracking-wide">Quest Board</h2>
                <p className="text-[10px] text-cyan-400/50 uppercase tracking-[0.2em] font-mono mt-0.5">
                  Explore &middot; Accept &middot; Conquer
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Token balance */}
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/8 border border-amber-500/25">
                <span className="text-base leading-none" aria-hidden="true">&#x1FA99;</span>
                <span className="text-sm font-bold text-amber-300 font-mono">{tokens}</span>
              </div>
              {/* Close */}
              <button
                onClick={closeQuestBoard}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors border border-white/8"
                aria-label="Close quest board"
              >
                &#x2715;
              </button>
            </div>
          </div>

          {/* ── Tabs ── */}
          <div className="flex items-center gap-0 px-6 border-b border-white/6">
            {(['available', 'active', 'completed'] as QuestTab[]).map((tab) => {
              const count = TAB_COUNT[tab];
              const isActive = questBoardTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => setQuestBoardTab(tab)}
                  className={`relative flex items-center gap-2 px-4 py-3 text-xs font-bold tracking-wide transition-colors border-b-2 ${
                    isActive
                      ? 'text-cyan-300 border-cyan-400'
                      : 'text-gray-500 border-transparent hover:text-gray-300'
                  }`}
                >
                  {TAB_LABELS[tab]}
                  {count != null && count > 0 && (
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${
                        isActive
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                          : 'bg-white/5 text-gray-500 border border-white/8'
                      }`}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}

            {/* Tier filter — only on Available tab */}
            {questBoardTab === 'available' && (
              <div className="ml-auto flex items-center gap-1.5 pb-2.5 pt-1.5">
                {(['all', 'side_quest', 'main_quest', 'legendary'] as TierFilter[]).map((t) => {
                  const label =
                    t === 'all'
                      ? 'All'
                      : TIER_CONFIG[t as keyof typeof TIER_CONFIG]?.label ?? t;
                  const isActive = tierFilter === t;
                  return (
                    <button
                      key={t}
                      onClick={() => setTierFilter(t)}
                      className={`text-[10px] font-bold px-2 py-1 rounded-md transition-colors border ${
                        isActive
                          ? t === 'legendary'
                            ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                            : t === 'main_quest'
                            ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300'
                            : t === 'side_quest'
                            ? 'bg-slate-500/20 border-slate-500/40 text-slate-300'
                            : 'bg-white/10 border-white/20 text-white'
                          : 'border-transparent text-gray-500 hover:bg-white/5 hover:text-gray-300'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Content area ── */}
          <div className="flex flex-1 overflow-hidden" style={{ minHeight: 0, maxHeight: 'calc(90vh - 130px)' }}>

            {/* ════════ AVAILABLE TAB ════════ */}
            {questBoardTab === 'available' && (
              <>
                {/* Quest list */}
                <div
                  ref={listRef}
                  className={`overflow-y-auto p-4 space-y-2 transition-all duration-200 ${
                    selectedQuest ? 'w-[55%] border-r border-white/6' : 'w-full'
                  }`}
                >
                  {questsLoading ? (
                    <LoadingSpinner color="border-cyan-300 border-t-transparent" />
                  ) : quests.length === 0 ? (
                    <EmptyState
                      icon="\uD83D\uDCDC"
                      title="No quests available"
                      subtitle="The board is bare — check back later for new challenges from the deep."
                    />
                  ) : (
                    <>
                      {quests.map((quest) => (
                        <QuestCard
                          key={quest.id}
                          quest={quest}
                          isSelected={selectedQuestId === quest.id}
                          onSelect={() =>
                            setSelectedQuestId(selectedQuestId === quest.id ? null : quest.id)
                          }
                        />
                      ))}

                      {/* Pagination */}
                      {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 pt-3 pb-1">
                          <button
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            disabled={page <= 1}
                            className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:bg-white/8 disabled:opacity-30 transition-colors"
                          >
                            Prev
                          </button>
                          <span className="text-xs text-gray-600 font-mono">
                            {page} / {totalPages}
                          </span>
                          <button
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            disabled={page >= totalPages}
                            className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:bg-white/8 disabled:opacity-30 transition-colors"
                          >
                            Next
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Quest detail panel */}
                {selectedQuest && (
                  <div className="w-[45%] flex-shrink-0 overflow-hidden">
                    <QuestDetailPanel
                      quest={selectedQuest}
                      onAccept={() => handleAccept(selectedQuest.id)}
                      accepting={acceptingId === selectedQuest.id}
                      onClose={() => setSelectedQuestId(null)}
                    />
                  </div>
                )}

                {/* Empty right pane hint when no quest selected */}
                {!selectedQuest && quests.length > 0 && (
                  <div className="hidden md:flex items-center justify-center w-0 overflow-hidden" />
                )}
              </>
            )}

            {/* ════════ ACTIVE TAB ════════ */}
            {questBoardTab === 'active' && (
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {myQuestsLoading ? (
                  <LoadingSpinner color="border-cyan-300 border-t-transparent" />
                ) : myQuests.length === 0 ? (
                  <EmptyState
                    icon="\u2694\uFE0F"
                    title="No active quests"
                    subtitle="Accept a quest from the Available tab to begin your journey."
                  />
                ) : (
                  <>
                    {/* Stats bar */}
                    <div className="flex items-center gap-5 p-3 rounded-lg bg-cyan-500/8 border border-cyan-500/20 mb-1">
                      <div>
                        <p className="text-[9px] text-cyan-400/60 uppercase tracking-widest font-bold">In Progress</p>
                        <p className="text-xl font-bold text-cyan-300 leading-tight">
                          {myQuests.filter((s) => ['accepted', 'in_progress'].includes(s.status)).length}
                        </p>
                      </div>
                      <div className="h-8 w-px bg-cyan-500/20" />
                      <div>
                        <p className="text-[9px] text-yellow-400/60 uppercase tracking-widest font-bold">Awaiting Review</p>
                        <p className="text-xl font-bold text-yellow-300 leading-tight">
                          {myQuests.filter((s) => ['submitted', 'in_review'].includes(s.status)).length}
                        </p>
                      </div>
                      <div className="h-8 w-px bg-cyan-500/20" />
                      <div>
                        <p className="text-[9px] text-green-400/60 uppercase tracking-widest font-bold">Completed</p>
                        <p className="text-xl font-bold text-green-300 leading-tight">
                          {myQuests.filter((s) => s.status === 'approved').length}
                        </p>
                      </div>
                    </div>

                    {myQuests.map((submission) => (
                      <ActiveQuestCard
                        key={submission.id}
                        submission={submission}
                        onStart={() => handleStart(submission.questId)}
                        onSubmit={(data) => handleSubmit(submission.questId, data)}
                        starting={startingId === submission.questId}
                        submitting={submittingId === submission.questId}
                      />
                    ))}
                  </>
                )}
              </div>
            )}

            {/* ════════ COMPLETED (QUEST LOG) TAB ════════ */}
            {questBoardTab === 'completed' && (
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {questLogLoading ? (
                  <LoadingSpinner color="border-amber-300 border-t-transparent" />
                ) : rewards.length === 0 ? (
                  <EmptyState
                    icon="\uD83C\uDFC6"
                    title="No completed quests yet"
                    subtitle="Complete quests to earn tokens, skills, and legendary titles."
                  />
                ) : (
                  <>
                    {/* Achievement summary */}
                    <div className="flex items-stretch gap-3 p-4 rounded-lg bg-gradient-to-r from-amber-500/8 to-transparent border border-amber-500/20 mb-1">
                      <div>
                        <p className="text-[9px] text-amber-400/60 uppercase tracking-widest font-bold mb-0.5">Quests Done</p>
                        <p className="text-2xl font-bold text-amber-300 leading-tight">{rewards.length}</p>
                      </div>
                      <div className="w-px bg-amber-500/20 mx-1" />
                      <div>
                        <p className="text-[9px] text-amber-400/60 uppercase tracking-widest font-bold mb-0.5">Total Earned</p>
                        <p className="text-2xl font-bold text-amber-300 leading-tight flex items-center gap-1">
                          {totalTokensEarned}
                          <span className="text-sm" aria-label="tokens">&#x1FA99;</span>
                        </p>
                      </div>
                      {skillsEarned.length > 0 && (
                        <>
                          <div className="w-px bg-amber-500/20 mx-1" />
                          <div>
                            <p className="text-[9px] text-purple-400/60 uppercase tracking-widest font-bold mb-0.5">Skills</p>
                            <p className="text-2xl font-bold text-purple-300 leading-tight">{skillsEarned.length}</p>
                          </div>
                        </>
                      )}
                      {titlesEarned.length > 0 && (
                        <>
                          <div className="w-px bg-amber-500/20 mx-1" />
                          <div>
                            <p className="text-[9px] text-amber-400/60 uppercase tracking-widest font-bold mb-0.5">Titles</p>
                            <p className="text-2xl font-bold text-amber-200 leading-tight">{titlesEarned.length}</p>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Earned skills row */}
                    {skillsEarned.length > 0 && (
                      <div className="flex flex-wrap gap-2 px-1">
                        {skillsEarned.map((r, i) => (
                          <span
                            key={i}
                            className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-purple-500/15 border border-purple-500/35 text-purple-300"
                          >
                            {r.skillName}
                          </span>
                        ))}
                      </div>
                    )}

                    {rewards.map((reward, i) => (
                      <RewardCard key={reward.id || i} reward={reward} />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>

          {/* ── Footer ── */}
          <div className="flex items-center justify-between px-6 py-2.5 border-t border-white/6 bg-black/20">
            <span className="text-[9px] text-gray-600 font-mono uppercase tracking-widest">
              ClawVille Quest Board v1.0
            </span>
            <span className="text-[9px] text-gray-600 font-mono">
              {quests.length > 0 && questBoardTab === 'available'
                ? `${total} quest${total !== 1 ? 's' : ''} in the deep`
                : questBoardTab === 'active'
                ? `${myQuests.length} quest${myQuests.length !== 1 ? 's' : ''} in progress`
                : `${rewards.length} conquest${rewards.length !== 1 ? 's' : ''} on record`}
            </span>
          </div>
        </div>
      </div>

      {/* Shimmer keyframes — injected inline to avoid Tailwind plugin dependency */}
      <style>{`
        @keyframes shimmer {
          0%   { transform: translateX(-150%) skewX(-20deg); }
          100% { transform: translateX(350%) skewX(-20deg); }
        }
        .animate-\\[shimmer_3s_ease-in-out_infinite\\] {
          animation: shimmer 3s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
