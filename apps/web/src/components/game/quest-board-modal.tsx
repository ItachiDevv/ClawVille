'use client';

/**
 * QuestBoardModal — Gameify re-skin of the quest board using the shared RPG
 * primitives from `@/components/rpg`. Data flow is preserved verbatim from the
 * previous implementation: every `useQuery` / `useMutation` / store hook lives
 * on in place, only the presentation layer changed.
 *
 * Visual language: parchment-scroll + legendary-drop aesthetic, built from the
 * shared `@/components/rpg` primitives (RuneFrame, RpgButton, RpgModal,
 * ItemCard). Quests are team-posted coding bounties — this file treats the
 * board like an RPG quest log crossed with a PR tracker.
 *
 * Tier → rarity mapping (see Team 3b decision notes):
 *   side_quest  → uncommon (green)   — real, scoped work, legit but small
 *   main_quest  → epic     (purple)  — mid-tier bounties, rare skill drops
 *   legendary   → legendary (gold)   — pulses automatically via rarity tier
 *
 * Submission flow: nested `RpgModal` fired from the Active tab. Escape closes
 * the inner modal first, then the parent (a capture-phase useEffect pattern
 * for dismissing a nested modal before the outer one sees the keypress).
 */

import { useState, useEffect, useCallback, useMemo, type CSSProperties, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { api } from '@/lib/api';
import {
  RpgModal,
  RpgButton,
  RuneSpinner,
  RuneFrame,
  ItemCard,
  RarityBadge,
  RpgTooltip,
  ProgressSteps,
  type ProgressStep,
  type RarityId,
} from '@/components/rpg';

// ---------------------------------------------------------------------------
// Types (unchanged data contract with the API)
// ---------------------------------------------------------------------------

type QuestTab = 'available' | 'active' | 'completed';
type QuestTier = 'side_quest' | 'main_quest' | 'legendary';
type TierFilter = 'all' | QuestTier;
type QuestStatus =
  | 'accepted'
  | 'in_progress'
  | 'submitted'
  | 'in_review'
  | 'approved'
  | 'rejected';

interface Quest {
  id: string;
  title: string;
  description: string;
  tier: QuestTier;
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
  status: QuestStatus;
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

// ---------------------------------------------------------------------------
// Tier → rarity / icon / label mapping
// ---------------------------------------------------------------------------

interface TierMeta {
  rarity: RarityId;
  icon: string;
  label: string;
  tokenRange: string;
}

const TIER_META: Record<QuestTier, TierMeta> = {
  side_quest: { rarity: 'uncommon', icon: '📜', label: 'Side Quest', tokenRange: '10–50' },
  main_quest: { rarity: 'epic', icon: '⚔️', label: 'Main Quest', tokenRange: '100–500' },
  legendary: { rarity: 'legendary', icon: '👑', label: 'Legendary', tokenRange: '1000+' },
};

function tierToRarity(tier: string): RarityId {
  return TIER_META[tier as QuestTier]?.rarity ?? 'common';
}

function tierIcon(tier: string): string {
  return TIER_META[tier as QuestTier]?.icon ?? '📜';
}

function tierLabel(tier: string): string {
  return TIER_META[tier as QuestTier]?.label ?? 'Quest';
}

// ---------------------------------------------------------------------------
// Status machinery
// ---------------------------------------------------------------------------

/** Happy-path quest lifecycle (excludes 'rejected' — it's a failure state). */
type ActiveQuestStep = 'accepted' | 'in_progress' | 'submitted' | 'in_review' | 'approved';

const PROGRESS_STEPS: ReadonlyArray<ActiveQuestStep> = [
  'accepted',
  'in_progress',
  'submitted',
  'in_review',
  'approved',
];

const PROGRESS_STEP_SHORT_LABELS: Record<ActiveQuestStep, string> = {
  accepted: 'Accepted',
  in_progress: 'Active',
  submitted: 'Submitted',
  in_review: 'Review',
  approved: 'Done',
};

/** Shape the progress steps for the shared ProgressSteps primitive. */
const QUEST_PROGRESS_STEPS: ReadonlyArray<ProgressStep> = PROGRESS_STEPS.map((s) => ({
  id: s,
  label: PROGRESS_STEP_SHORT_LABELS[s],
}));

const STATUS_LABEL: Record<QuestStatus, string> = {
  accepted: 'Accepted',
  in_progress: 'In Progress',
  submitted: 'Submitted',
  in_review: 'Under Review',
  approved: 'Completed',
  rejected: 'Rejected',
};

const STATUS_COLOR: Record<QuestStatus, { base: string; bg: string }> = {
  accepted: { base: '#22d3ee', bg: 'rgba(34, 211, 238, 0.12)' },
  in_progress: { base: '#60a5fa', bg: 'rgba(96, 165, 250, 0.12)' },
  submitted: { base: '#c084fc', bg: 'rgba(192, 132, 252, 0.12)' },
  in_review: { base: '#facc15', bg: 'rgba(250, 204, 21, 0.12)' },
  approved: { base: '#4ade80', bg: 'rgba(74, 222, 128, 0.14)' },
  rejected: { base: '#f87171', bg: 'rgba(248, 113, 113, 0.12)' },
};

/** Active-state rarity override: submitted/in_review are dimmed, rejected red. */
function statusStyleOverrides(status: QuestStatus): {
  extraBadge?: ReactNode;
  disabled?: boolean;
  pulse?: boolean;
} {
  switch (status) {
    case 'submitted':
    case 'in_review':
      return { extraBadge: <StatusBadge status={status} />, disabled: true };
    case 'approved':
      return { extraBadge: <StatusBadge status={status} />, pulse: true };
    case 'rejected':
      return { extraBadge: <StatusBadge status={status} /> };
    default:
      return { extraBadge: <StatusBadge status={status} /> };
  }
}

// ---------------------------------------------------------------------------
// Placeholder data (used until the API returns real rows — matches the
// previous file byte-for-byte so local dev stays identical)
// ---------------------------------------------------------------------------

const PLACEHOLDER_QUESTS: Quest[] = [
  {
    id: 'q1',
    title: 'First Steps in the Abyss',
    description:
      'Visit the Downtown Building and speak with the Cron Keeper. Learn how scheduled jobs keep the ocean of automation flowing on time.',
    tier: 'side_quest',
    tokenReward: 25,
    skillReward: 'Cron Basics',
    requirements: ['Visit Downtown Building', 'Talk to the Cron Keeper character'],
    location: 'Downtown Building',
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    completedCount: 12,
    maxCompletions: 100,
  },
  {
    id: 'q2',
    title: 'Ride the Current',
    description:
      'Configure a webhook at the Salty Spitoon to intercept incoming tide signals. The gateway handles thousands of HTTP events per second — master it.',
    tier: 'main_quest',
    tokenReward: 200,
    skillReward: 'Webhook Mastery',
    requirements: [
      'Reach the Salty Spitoon building',
      'Configure one incoming webhook endpoint',
      'Submit a PR with your implementation',
    ],
    location: 'Salty Spitoon',
    expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
    completedCount: 3,
    maxCompletions: 50,
  },
  {
    id: 'q3',
    title: 'Keeper of Forgotten Depths',
    description:
      "Journey to Squidward's House and architect a vector memory system capable of storing 10,000 embeddings. The deep ocean never forgets — neither should your agent. Deliver a full LanceDB integration with semantic search across agent memories.",
    tier: 'legendary',
    tokenReward: 1500,
    skillReward: 'Vector Memory Architect',
    titleReward: 'Depth Keeper',
    requirements: [
      "Reach Squidward's House",
      'Design a LanceDB schema for agent memories',
      'Implement semantic similarity search',
      'Submit PR with benchmarks (10k+ entries)',
      'Write documentation for other agents to use',
    ],
    location: "Squidward's House",
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    completedCount: 0,
    maxCompletions: 5,
  },
  {
    id: 'q4',
    title: 'Signal Relay Protocol',
    description:
      "Set up a multi-channel bridge at Sandy's Treedome. Route messages from Discord to Telegram seamlessly, proving your cross-platform channel mastery.",
    tier: 'main_quest',
    tokenReward: 350,
    skillReward: 'Channel Bridge Expert',
    requirements: [
      "Visit Sandy's Treedome",
      'Implement a Discord → Telegram relay',
      'Handle rate limiting and error recovery',
    ],
    location: "Sandy's Treedome",
  },
  {
    id: 'q5',
    title: 'Fix a Leaking Pipe',
    description:
      'A minor memory leak has been spotted near the Krusty Krab. Track it down and patch it up.',
    tier: 'side_quest',
    tokenReward: 15,
    requirements: ['Visit Krusty Krab', 'Report the bug in the task tracker'],
    location: 'Krusty Krab',
  },
];

const PLACEHOLDER_ACTIVE: QuestSubmission[] = [
  {
    id: 'sub1',
    questId: 'q4',
    status: 'in_progress',
    quest: PLACEHOLDER_QUESTS[3]!,
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

// ---------------------------------------------------------------------------
// Shared presentational helpers
// ---------------------------------------------------------------------------

/** Format a date string for meta rows. Returns '' on failure. */
function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

function daysUntil(value: string | undefined): number | null {
  if (!value) return null;
  try {
    return Math.ceil((new Date(value).getTime() - Date.now()) / 86400000);
  } catch {
    return null;
  }
}

/** Gold-token pill used in reward previews + footers. */
function TokenPill({ amount, prefix }: { amount: number | string; prefix?: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: 'var(--font-orbitron), sans-serif',
        fontSize: 13,
        fontWeight: 700,
        color: '#facc15',
        textShadow: '0 0 10px rgba(250, 204, 21, 0.4)',
      }}
    >
      <span style={{ fontSize: 13 }} aria-hidden>
        ◈
      </span>
      {prefix}
      {amount}
      <span
        style={{
          fontSize: 9,
          color: '#ca8a04',
          letterSpacing: '0.12em',
          textShadow: 'none',
        }}
      >
        NT
      </span>
    </span>
  );
}

/** Status chip shown on active quests — uses a pure CSS dot + label. */
function StatusBadge({ status }: { status: QuestStatus }) {
  const { base, bg } = STATUS_COLOR[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 9px',
        borderRadius: 999,
        fontFamily: 'var(--font-orbitron), sans-serif',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: base,
        background: bg,
        border: `1px solid ${base}66`,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 5,
          height: 5,
          borderRadius: 999,
          background: base,
          boxShadow: `0 0 6px ${base}`,
        }}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Rune-edged progress bar (completions / total). */
function CompletionBar({
  current,
  max,
  rarity,
}: {
  current: number;
  max: number;
  rarity: RarityId;
}) {
  const pct = Math.min(100, Math.max(0, (current / Math.max(1, max)) * 100));
  const colour = rarity === 'legendary' ? '#fb923c' : rarity === 'epic' ? '#c084fc' : '#4ade80';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 10,
        color: '#64748b',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      }}
    >
      <span>
        {current} / {max}
      </span>
      <div
        style={{
          flex: 1,
          height: 4,
          borderRadius: 999,
          background: 'rgba(148, 163, 184, 0.12)',
          border: '1px solid rgba(148, 163, 184, 0.2)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: `linear-gradient(90deg, ${colour}99 0%, ${colour} 100%)`,
            boxShadow: `0 0 8px ${colour}88`,
            transition: 'width 700ms cubic-bezier(0.2, 0.8, 0.25, 1)',
          }}
        />
      </div>
    </div>
  );
}

/**
 * Quest-lifecycle progress tracker (accepted → … → approved).
 *
 * Thin wrapper around the shared @/components/rpg ProgressSteps primitive.
 * Maps quest-specific statuses onto the rejected / current-index semantics
 * the primitive exposes. If the current status is `rejected`, we anchor the
 * failed marker at whatever step was last reached before rejection — the
 * backend only tells us "rejected" without a historical step, so we land
 * the red flag at the `in_review` dot which is the point a reviewer would
 * have rejected from.
 */
function ProgressTracker({ currentStatus }: { currentStatus: QuestStatus }) {
  const failed = currentStatus === 'rejected';
  // When rejected, the "current" dot in the primitive should sit where
  // the rejection happened — our state machine collapses that into the
  // `in_review` step for visual purposes.
  const primitiveCurrent = failed ? 'in_review' : currentStatus;

  return (
    <ProgressSteps
      steps={QUEST_PROGRESS_STEPS}
      current={primitiveCurrent}
      failed={failed}
      tier="legendary"
      shape="circle"
    />
  );
}

// ---------------------------------------------------------------------------
// Quest list card (Available tab)
// ---------------------------------------------------------------------------

function QuestListCard({
  quest,
  isSelected,
  onSelect,
}: {
  quest: Quest;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const rarity = tierToRarity(quest.tier);
  const days = daysUntil(quest.expiresAt);

  const stats: { label: string; value: ReactNode }[] = [];
  if (quest.location) stats.push({ label: 'Location', value: quest.location });
  if (days != null)
    stats.push({
      label: 'Expires',
      value:
        days > 0 ? (
          <span style={{ color: days <= 3 ? '#f87171' : '#cbd5e1' }}>{days}d left</span>
        ) : (
          <span style={{ color: '#f87171' }}>Expired</span>
        ),
    });
  if (quest.completedCount != null && quest.maxCompletions != null)
    stats.push({
      label: 'Claimed',
      value: `${quest.completedCount}/${quest.maxCompletions}`,
    });

  const rewardChips: ReactNode = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {quest.skillReward && (
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'rgba(168, 85, 247, 0.14)',
            border: '1px solid rgba(168, 85, 247, 0.4)',
            color: '#c084fc',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          + {quest.skillReward}
        </span>
      )}
      {quest.titleReward && (
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'rgba(249, 115, 22, 0.14)',
            border: '1px solid rgba(249, 115, 22, 0.4)',
            color: '#fb923c',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          Title: {quest.titleReward}
        </span>
      )}
    </div>
  );

  return (
    <ItemCard
      rarity={rarity}
      name={quest.title}
      subtitle={tierLabel(quest.tier)}
      icon={<span>{tierIcon(quest.tier)}</span>}
      description={quest.description}
      stats={stats}
      price={quest.tokenReward}
      priceUnit="NT"
      glow={isSelected ? 'strong' : undefined}
      onClick={onSelect}
      interactive
      footer={
        <>
          {rewardChips}
          <RpgButton
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
          >
            {isSelected ? 'Hide Details' : 'View Details'}
          </RpgButton>
        </>
      }
      style={
        isSelected
          ? { outline: '1px solid rgba(56, 189, 248, 0.4)', outlineOffset: 2 }
          : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Quest detail panel (right side of the Available split-pane)
// ---------------------------------------------------------------------------

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
  const rarity = tierToRarity(quest.tier);
  const days = daysUntil(quest.expiresAt);
  const isLegendary = quest.tier === 'legendary';

  return (
    <RuneFrame
      tier={rarity}
      glow={isLegendary ? 'strong' : 'subtle'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          padding: '14px 16px 10px',
          borderBottom: '1px solid rgba(148, 163, 184, 0.15)',
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 24,
            background: 'rgba(10, 22, 40, 0.8)',
            border: '1px solid rgba(148, 163, 184, 0.3)',
            flexShrink: 0,
          }}
        >
          {tierIcon(quest.tier)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              marginBottom: 4,
            }}
          >
            <RarityBadge tier={rarity} label={tierLabel(quest.tier)} />
            {quest.location && (
              <span
                style={{
                  fontSize: 10,
                  color: '#64748b',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                }}
              >
                @ {quest.location}
              </span>
            )}
          </div>
          <h3
            style={{
              fontFamily: 'var(--font-orbitron), sans-serif',
              fontSize: 14,
              fontWeight: 700,
              color: '#f1f5f9',
              letterSpacing: '0.02em',
              margin: 0,
              lineHeight: 1.2,
              textShadow: '0 0 12px rgba(148, 163, 184, 0.2)',
            }}
          >
            {quest.title}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail"
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: 'rgba(15, 31, 58, 0.7)',
            border: '1px solid rgba(148, 163, 184, 0.25)',
            color: '#94a3b8',
            fontSize: 11,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      </div>

      {/* Scroll body */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          minHeight: 0,
        }}
      >
        <section>
          <SectionLabel>Objective</SectionLabel>
          <p
            style={{
              fontSize: 12,
              color: '#cbd5e1',
              lineHeight: 1.55,
              margin: 0,
            }}
          >
            {quest.description}
          </p>
        </section>

        {quest.requirements && quest.requirements.length > 0 && (
          <section>
            <SectionLabel>Requirements</SectionLabel>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {quest.requirements.map((req, i) => (
                <li
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    fontSize: 11,
                    color: '#94a3b8',
                    lineHeight: 1.5,
                    padding: '3px 0',
                  }}
                >
                  <span
                    aria-hidden
                    style={{ color: 'rgba(56, 189, 248, 0.5)', flexShrink: 0 }}
                  >
                    ▸
                  </span>
                  {req}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <SectionLabel>Rewards</SectionLabel>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: '10px 12px',
              background: 'rgba(10, 22, 40, 0.6)',
              border: '1px dashed rgba(148, 163, 184, 0.22)',
              borderRadius: 8,
            }}
          >
            <RewardRow label="Tokens">
              <TokenPill amount={quest.tokenReward} />
            </RewardRow>
            {quest.skillReward && (
              <RewardRow label="Skill Drop">
                <NestedRewardChip
                  rarity={quest.tier === 'legendary' ? 'legendary' : 'rare'}
                  icon="⚗"
                  label={quest.skillReward}
                />
              </RewardRow>
            )}
            {quest.titleReward && (
              <RewardRow label="Title">
                <NestedRewardChip rarity="legendary" icon="👑" label={quest.titleReward} />
              </RewardRow>
            )}
          </div>
        </section>

        {(days != null ||
          (quest.completedCount != null && quest.maxCompletions != null)) && (
          <section>
            <SectionLabel>Availability</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {days != null && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 10,
                    color: '#64748b',
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  }}
                >
                  <span aria-hidden>⏰</span>
                  <span style={days <= 3 ? { color: '#f87171', fontWeight: 700 } : undefined}>
                    {days > 0 ? `${days}d remaining` : 'Expires soon'}
                  </span>
                </div>
              )}
              {quest.completedCount != null && quest.maxCompletions != null && (
                <CompletionBar
                  current={quest.completedCount}
                  max={quest.maxCompletions}
                  rarity={rarity}
                />
              )}
            </div>
          </section>
        )}
      </div>

      {/* Accept CTA */}
      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid rgba(148, 163, 184, 0.15)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {isLegendary && (
          <p
            style={{
              fontSize: 9,
              color: 'rgba(251, 146, 60, 0.8)',
              textAlign: 'center',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              margin: 0,
            }}
          >
            Legendary — accept with care
          </p>
        )}
        <RpgButton
          variant="primary"
          size="md"
          rarity={isLegendary ? 'legendary' : undefined}
          onClick={onAccept}
          loading={accepting}
          style={{ width: '100%' }}
        >
          Accept Quest
        </RpgButton>
      </div>
    </RuneFrame>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        fontSize: 9,
        color: '#64748b',
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        fontWeight: 700,
        fontFamily: 'var(--font-orbitron), sans-serif',
        margin: '0 0 6px',
      }}
    >
      {children}
    </p>
  );
}

function RewardRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span
        style={{
          fontSize: 9,
          color: '#64748b',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontFamily: 'var(--font-orbitron), sans-serif',
          width: 76,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <div>{children}</div>
    </div>
  );
}

function NestedRewardChip({
  rarity,
  icon,
  label,
}: {
  rarity: RarityId;
  icon: string;
  label: string;
}) {
  return (
    <RuneFrame
      tier={rarity}
      glow={rarity === 'legendary' ? 'subtle' : false}
      style={{ display: 'inline-block' }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 10px',
          fontSize: 11,
          fontWeight: 700,
          fontFamily: 'var(--font-orbitron), sans-serif',
          letterSpacing: '0.04em',
          color: 'var(--rpg-base, #e2e8f0)',
        }}
      >
        <span aria-hidden>{icon}</span>
        {label}
      </span>
    </RuneFrame>
  );
}

// ---------------------------------------------------------------------------
// Active quest card
// ---------------------------------------------------------------------------

function ActiveQuestCard({
  submission,
  onStart,
  onOpenSubmit,
  starting,
}: {
  submission: QuestSubmission;
  onStart: () => void;
  onOpenSubmit: () => void;
  starting: boolean;
}) {
  const quest = submission.quest;
  const rarity = tierToRarity(quest.tier);
  const status = submission.status;
  const overrides = statusStyleOverrides(status);
  const isApproved = status === 'approved';
  const isDimmed = status === 'submitted' || status === 'in_review';
  const isRejected = status === 'rejected';

  const stats: { label: string; value: ReactNode }[] = [
    { label: 'Reward', value: <TokenPill amount={quest.tokenReward} prefix="+" /> },
  ];
  if (quest.skillReward) stats.push({ label: 'Skill', value: `+${quest.skillReward}` });
  if (quest.titleReward) stats.push({ label: 'Title', value: `+${quest.titleReward}` });
  if (quest.location) stats.push({ label: 'Location', value: quest.location });

  return (
    <ItemCard
      rarity={rarity}
      name={quest.title}
      subtitle={tierLabel(quest.tier)}
      icon={<span>{tierIcon(quest.tier)}</span>}
      description={quest.description}
      stats={stats}
      glow={isApproved ? 'strong' : overrides.pulse ? 'subtle' : undefined}
      badge={overrides.extraBadge}
      disabled={false}
      interactive={false}
      style={
        isDimmed
          ? { opacity: 0.72 }
          : isRejected
            ? { opacity: 0.85, filter: 'grayscale(0.2)' }
            : undefined
      }
      footer={
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            width: '100%',
          }}
        >
          <ProgressTracker currentStatus={status} />

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              {status === 'submitted' && (
                <span style={{ fontSize: 10, color: '#c084fc', fontStyle: 'italic' }}>
                  Work submitted — awaiting crew review…
                </span>
              )}
              {status === 'in_review' && (
                <span style={{ fontSize: 10, color: '#facc15', fontStyle: 'italic' }}>
                  Under review by the quest masters…
                </span>
              )}
              {isApproved && (
                <span
                  style={{
                    fontSize: 11,
                    color: '#4ade80',
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    textShadow: '0 0 10px rgba(74, 222, 128, 0.45)',
                  }}
                >
                  <span aria-hidden>✓</span>
                  Quest complete — rewards claimed!
                </span>
              )}
              {isRejected && submission.reviewNote && (
                <RpgTooltip content={submission.reviewNote}>
                  <span
                    style={{
                      fontSize: 10,
                      color: '#f87171',
                      fontStyle: 'italic',
                      maxWidth: 220,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'inline-block',
                    }}
                  >
                    Reviewer: {submission.reviewNote}
                  </span>
                </RpgTooltip>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              {status === 'accepted' && (
                <RpgButton
                  variant="secondary"
                  size="sm"
                  onClick={onStart}
                  loading={starting}
                >
                  Start Working
                </RpgButton>
              )}
              {status === 'in_progress' && (
                <RpgButton variant="primary" size="sm" onClick={onOpenSubmit}>
                  Submit Work
                </RpgButton>
              )}
              {status === 'rejected' && (
                <RpgButton variant="danger" size="sm" onClick={onOpenSubmit}>
                  Re-submit
                </RpgButton>
              )}
            </div>
          </div>
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Reward card (Quest Log tab)
// ---------------------------------------------------------------------------

function RewardCard({ reward }: { reward: QuestReward }) {
  const rarity = tierToRarity(reward.quest.tier);
  const isLegendary = rarity === 'legendary';

  const stats: { label: string; value: ReactNode }[] = [
    { label: 'Earned', value: <TokenPill amount={reward.tokensAwarded} prefix="+" /> },
    { label: 'Claimed', value: formatDate(reward.claimedAt) },
  ];
  if (reward.skillName) stats.push({ label: 'Skill', value: `+${reward.skillName}` });
  if (reward.titleAwarded) stats.push({ label: 'Title', value: `+${reward.titleAwarded}` });

  return (
    <ItemCard
      rarity={rarity}
      name={reward.quest.title}
      subtitle={tierLabel(reward.quest.tier)}
      icon={<span>{tierIcon(reward.quest.tier)}</span>}
      description={reward.quest.description || undefined}
      stats={stats}
      glow={isLegendary ? 'strong' : undefined}
      interactive={false}
      badge={
        isLegendary ? (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 999,
              background: 'rgba(249, 115, 22, 0.14)',
              border: '1px solid rgba(249, 115, 22, 0.45)',
              color: '#fb923c',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              animation: 'rpg-pulse-rarity 2.2s ease-in-out infinite',
            }}
          >
            Legendary Drop
          </span>
        ) : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Submission modal (nested)
// ---------------------------------------------------------------------------

function SubmissionModal({
  submission,
  open,
  onClose,
  onSubmit,
  submitting,
}: {
  submission: QuestSubmission | null;
  open: boolean;
  onClose: () => void;
  onSubmit: (data: { prLink?: string; submissionNote: string }) => void;
  submitting: boolean;
}) {
  const [prLink, setPrLink] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) {
      setPrLink('');
      setNote('');
    }
  }, [open]);

  if (!submission) return null;

  const rarity = tierToRarity(submission.quest.tier);
  const minCharsMet = note.trim().length >= 10;

  return (
    <RpgModal
      open={open}
      onClose={onClose}
      title="Submit Work"
      subtitle={submission.quest.title}
      tier={rarity}
      glow="strong"
      headerIcon={<span>📮</span>}
      maxWidth={560}
      closeOnBackdrop={false}
      footer={
        <>
          <RpgButton variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </RpgButton>
          <RpgButton
            variant="primary"
            size="md"
            rarity={rarity === 'legendary' ? 'legendary' : undefined}
            disabled={!minCharsMet}
            loading={submitting}
            onClick={() =>
              onSubmit({
                prLink: prLink.trim() || undefined,
                submissionNote: note.trim(),
              })
            }
          >
            Submit for Review
          </RpgButton>
        </>
      }
    >
      <div
        style={{
          padding: '18px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <RarityBadge tier={rarity} label={tierLabel(submission.quest.tier)} />
          <TokenPill amount={submission.quest.tokenReward} prefix="+" />
        </div>

        <div>
          <SectionLabel>GitHub PR Link (optional)</SectionLabel>
          <input
            type="url"
            placeholder="https://github.com/owner/repo/pull/123"
            value={prLink}
            onChange={(e) => setPrLink(e.target.value)}
            style={FORM_INPUT_STYLE}
          />
          <p style={HINT_STYLE}>Leave blank for non-code deliverables.</p>
        </div>

        <div>
          <SectionLabel>Implementation Notes *</SectionLabel>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Describe what you built, any trade-offs, how reviewers should verify it..."
            rows={5}
            style={{ ...FORM_INPUT_STYLE, resize: 'none', fontFamily: 'inherit' }}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 4,
            }}
          >
            <span style={HINT_STYLE}>Minimum 10 characters.</span>
            <span
              style={{
                fontSize: 9,
                color: minCharsMet ? '#4ade80' : '#64748b',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              }}
            >
              {note.trim().length} chars
            </span>
          </div>
        </div>
      </div>
    </RpgModal>
  );
}

const FORM_INPUT_STYLE: CSSProperties = {
  width: '100%',
  background: 'rgba(10, 22, 40, 0.85)',
  border: '1px solid rgba(56, 189, 248, 0.25)',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 12,
  color: '#e2e8f0',
  outline: 'none',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};

const HINT_STYLE: CSSProperties = {
  fontSize: 9,
  color: '#64748b',
  margin: '4px 0 0',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  letterSpacing: '0.04em',
};

// ---------------------------------------------------------------------------
// Empty + loading helpers
// ---------------------------------------------------------------------------

function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: string;
  title: string;
  hint: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '60px 20px',
        textAlign: 'center',
      }}
    >
      <span
        style={{
          fontSize: 36,
          filter: 'drop-shadow(0 0 16px rgba(56, 189, 248, 0.3))',
        }}
      >
        {icon}
      </span>
      <h3
        style={{
          fontFamily: 'var(--font-orbitron), sans-serif',
          fontSize: 14,
          fontWeight: 700,
          color: '#cbd5e1',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          margin: 0,
        }}
      >
        {title}
      </h3>
      <p style={{ fontSize: 11, color: '#64748b', maxWidth: 360, margin: 0 }}>{hint}</p>
    </div>
  );
}

function LoadingBlock({ label }: { label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        padding: '60px 0',
      }}
    >
      <RuneSpinner size={44} tier="legendary" />
      <span
        style={{
          fontSize: 10,
          color: '#64748b',
          textTransform: 'uppercase',
          letterSpacing: '0.2em',
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

export default function QuestBoardModal() {
  const { questBoardOpen, closeQuestBoard, questBoardTab, setQuestBoardTab, addToast } =
    useGameStore();
  const { data: avatar } = useAvatar();
  const queryClient = useQueryClient();

  // Filters / local state
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [page, setPage] = useState(1);
  const [selectedQuestId, setSelectedQuestId] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [submissionTargetId, setSubmissionTargetId] = useState<string | null>(null);

  // Reset page + selection on tab/filter change
  useEffect(() => {
    setPage(1);
    setSelectedQuestId(null);
  }, [questBoardTab, tierFilter]);

  // Nested escape: if the submission modal is open, escape closes it first;
  // if a quest detail is open, escape closes that; otherwise escape closes the
  // whole board. Capture-phase so we beat RpgModal's own listener.
  useEffect(() => {
    if (!questBoardOpen) return;
    if (!submissionTargetId && !selectedQuestId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (submissionTargetId) {
        setSubmissionTargetId(null);
        e.stopPropagation();
      } else if (selectedQuestId) {
        setSelectedQuestId(null);
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [questBoardOpen, submissionTargetId, selectedQuestId]);

  // ── Queries (preserved verbatim) ────────────────────────────────────────

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

  // ── Mutations (preserved verbatim) ──────────────────────────────────────

  const acceptMutation = useMutation({
    mutationFn: (questId: string) => api.acceptQuest(questId),
    onSuccess: () => {
      addToast('📜', 'Quest accepted! Check your Active Quests.');
      queryClient.invalidateQueries({ queryKey: ['quests-available'] });
      queryClient.invalidateQueries({ queryKey: ['quests-my-quests'] });
      setAcceptingId(null);
      setSelectedQuestId(null);
    },
    onError: (err: Error) => {
      addToast('❌', err.message || 'Failed to accept quest');
      setAcceptingId(null);
    },
  });

  const startMutation = useMutation({
    mutationFn: (questId: string) => api.startQuest(questId),
    onSuccess: () => {
      addToast('🚀', 'Quest started! Get to work!');
      queryClient.invalidateQueries({ queryKey: ['quests-my-quests'] });
      setStartingId(null);
    },
    onError: (err: Error) => {
      addToast('❌', err.message || 'Failed to start quest');
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
      addToast('✅', 'Work submitted for review!');
      queryClient.invalidateQueries({ queryKey: ['quests-my-quests'] });
      setSubmittingId(null);
      setSubmissionTargetId(null);
    },
    onError: (err: Error) => {
      addToast('❌', err.message || 'Submission failed');
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

  // ── Derived data ────────────────────────────────────────────────────────

  const rawQuests: Quest[] = questsData?.quests ?? PLACEHOLDER_QUESTS;
  const quests: Quest[] = useMemo(
    () =>
      tierFilter === 'all'
        ? rawQuests
        : rawQuests.filter((q) => q.tier === tierFilter),
    [rawQuests, tierFilter],
  );
  const total = questsData?.total ?? quests.length;
  const pageSize = questsData?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const myQuests: QuestSubmission[] = myQuestsData?.submissions ?? PLACEHOLDER_ACTIVE;
  const rewards: QuestReward[] = questLogData?.rewards ?? PLACEHOLDER_REWARDS;

  const tokens = avatar?.clawTokens ?? 0;

  const totalTokensEarned = rewards.reduce((s, r) => s + (r.tokensAwarded || 0), 0);
  const skillsEarned = rewards.filter((r) => r.skillName);
  const titlesEarned = rewards.filter((r) => r.titleAwarded);

  const selectedQuest = quests.find((q) => q.id === selectedQuestId) ?? null;
  const submissionTarget =
    myQuests.find((s) => s.questId === submissionTargetId) ?? null;

  const inProgressCount = myQuests.filter((s) =>
    ['accepted', 'in_progress'].includes(s.status),
  ).length;
  const awaitingReviewCount = myQuests.filter((s) =>
    ['submitted', 'in_review'].includes(s.status),
  ).length;
  const approvedCount = myQuests.filter((s) => s.status === 'approved').length;

  const TAB_LABELS: Record<QuestTab, string> = {
    available: 'Available',
    active: 'Active',
    completed: 'Quest Log',
  };

  const TAB_COUNT: Record<QuestTab, number> = {
    available: total,
    active: myQuests.length,
    completed: rewards.length,
  };

  if (!questBoardOpen) return null;

  const TIER_FILTER_OPTIONS: { value: TierFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'side_quest', label: 'Side' },
    { value: 'main_quest', label: 'Main' },
    { value: 'legendary', label: 'Legendary' },
  ];

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <>
      <RpgModal
        open={questBoardOpen}
        onClose={closeQuestBoard}
        title="Quest Board"
        subtitle="Explore · Accept · Conquer"
        tier="legendary"
        glow="subtle"
        headerIcon={<span>📜</span>}
        maxWidth={1060}
        tokenBadge={
          <RpgTooltip content="Your ClawToken balance — spent on bounties, earned from quest completions.">
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                borderRadius: 999,
                background: 'rgba(250, 204, 21, 0.08)',
                border: '1px solid rgba(250, 204, 21, 0.35)',
                color: '#facc15',
                fontFamily: 'var(--font-orbitron), sans-serif',
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: '0.05em',
                textShadow: '0 0 8px rgba(250, 204, 21, 0.35)',
              }}
            >
              <span style={{ fontSize: 13 }}>◈</span>
              {tokens} NT
            </span>
          </RpgTooltip>
        }
        footer={
          <>
            <span
              style={{
                fontSize: 9,
                color: '#475569',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                marginRight: 'auto',
              }}
            >
              ClawVille Quest Board v1.0
            </span>
            <span
              style={{
                fontSize: 9,
                color: '#64748b',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              }}
            >
              {questBoardTab === 'available'
                ? `${total} quest${total !== 1 ? 's' : ''} in the deep`
                : questBoardTab === 'active'
                  ? `${myQuests.length} quest${myQuests.length !== 1 ? 's' : ''} in progress`
                  : `${rewards.length} conquest${rewards.length !== 1 ? 's' : ''} on record`}
            </span>
          </>
        }
      >
        {/* Tabs */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: '10px 22px 0',
            borderBottom: '1px solid rgba(56, 189, 248, 0.15)',
          }}
        >
          {(['available', 'active', 'completed'] as QuestTab[]).map((t) => {
            const isActive = questBoardTab === t;
            const count = TAB_COUNT[t];
            return (
              <button
                key={t}
                type="button"
                onClick={() => setQuestBoardTab(t)}
                style={{
                  position: 'relative',
                  padding: '10px 18px',
                  background: 'transparent',
                  border: 'none',
                  fontFamily: 'var(--font-orbitron), sans-serif',
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  color: isActive ? '#fb923c' : '#64748b',
                  cursor: 'pointer',
                  transition: 'color 180ms ease',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {TAB_LABELS[t]}
                {count > 0 && (
                  <span
                    style={{
                      fontSize: 9,
                      padding: '1px 7px',
                      borderRadius: 999,
                      background: isActive
                        ? 'rgba(249, 115, 22, 0.16)'
                        : 'rgba(148, 163, 184, 0.08)',
                      border: `1px solid ${isActive ? 'rgba(249, 115, 22, 0.4)' : 'rgba(148, 163, 184, 0.2)'}`,
                      color: isActive ? '#fb923c' : '#64748b',
                    }}
                  >
                    {count}
                  </span>
                )}
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    left: 12,
                    right: 12,
                    bottom: -1,
                    height: 2,
                    background: isActive
                      ? 'linear-gradient(90deg, transparent 0%, #fb923c 50%, transparent 100%)'
                      : 'transparent',
                    boxShadow: isActive ? '0 0 10px rgba(249, 115, 22, 0.55)' : 'none',
                    transition: 'background 200ms ease',
                  }}
                />
              </button>
            );
          })}
        </div>

        {/* ============================== AVAILABLE TAB ============================== */}
        {questBoardTab === 'available' && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {/* Tier filter row */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '12px 22px',
                borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  fontWeight: 700,
                  fontFamily: 'var(--font-orbitron), sans-serif',
                  marginRight: 4,
                }}
              >
                Tier
              </span>
              {TIER_FILTER_OPTIONS.map((opt) => {
                const isActive = tierFilter === opt.value;
                const activeRarity =
                  opt.value === 'legendary'
                    ? 'legendary'
                    : opt.value === 'main_quest'
                      ? 'epic'
                      : opt.value === 'side_quest'
                        ? 'uncommon'
                        : null;
                return (
                  <RpgButton
                    key={opt.value}
                    variant="ghost"
                    size="sm"
                    onClick={() => setTierFilter(opt.value)}
                    rarity={isActive && activeRarity ? activeRarity : undefined}
                    style={{
                      fontSize: 9,
                      padding: '4px 12px',
                      background: isActive
                        ? 'rgba(56, 189, 248, 0.15)'
                        : 'rgba(10, 22, 40, 0.4)',
                      color: isActive ? '#7dd3fc' : '#94a3b8',
                      border: `1px solid ${isActive ? 'rgba(56, 189, 248, 0.5)' : 'rgba(148, 163, 184, 0.2)'}`,
                    }}
                  >
                    {opt.label}
                  </RpgButton>
                );
              })}
            </div>

            {/* Split pane: list + detail */}
            <div
              style={{
                display: 'flex',
                gap: 14,
                padding: '14px 22px 18px',
                minHeight: 260,
                maxHeight: '60vh',
              }}
            >
              {/* Quest list */}
              <div
                style={{
                  flex: selectedQuest ? '1 1 58%' : '1 1 100%',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  overflowY: 'auto',
                  paddingRight: 6,
                  transition: 'flex-basis 220ms ease',
                }}
              >
                {questsLoading ? (
                  <LoadingBlock label="Unfurling the quest board" />
                ) : quests.length === 0 ? (
                  <EmptyState
                    icon="📜"
                    title="No quests available"
                    hint="The board is bare — check back later for new challenges from the deep."
                  />
                ) : (
                  <>
                    {quests.map((quest) => (
                      <QuestListCard
                        key={quest.id}
                        quest={quest}
                        isSelected={selectedQuestId === quest.id}
                        onSelect={() =>
                          setSelectedQuestId(
                            selectedQuestId === quest.id ? null : quest.id,
                          )
                        }
                      />
                    ))}

                    {totalPages > 1 && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 10,
                          paddingTop: 10,
                        }}
                      >
                        <RpgButton
                          variant="ghost"
                          size="sm"
                          disabled={page <= 1}
                          onClick={() => setPage((p) => Math.max(1, p - 1))}
                        >
                          ← Prev
                        </RpgButton>
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>
                          Page {page} of {totalPages}
                        </span>
                        <RpgButton
                          variant="ghost"
                          size="sm"
                          disabled={page >= totalPages}
                          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        >
                          Next →
                        </RpgButton>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Detail pane */}
              {selectedQuest && (
                <div
                  style={{
                    flex: '1 1 42%',
                    minWidth: 300,
                    display: 'flex',
                  }}
                >
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <QuestDetailPanel
                      quest={selectedQuest}
                      onAccept={() => handleAccept(selectedQuest.id)}
                      accepting={acceptingId === selectedQuest.id}
                      onClose={() => setSelectedQuestId(null)}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============================== ACTIVE TAB ============================== */}
        {questBoardTab === 'active' && (
          <div
            style={{
              padding: '14px 22px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              minHeight: 260,
              maxHeight: '60vh',
              overflowY: 'auto',
            }}
          >
            {myQuestsLoading ? (
              <LoadingBlock label="Rallying your active quests" />
            ) : myQuests.length === 0 ? (
              <EmptyState
                icon="⚔️"
                title="No active quests"
                hint="Accept a quest from the Available tab to begin your journey."
              />
            ) : (
              <>
                {/* Stats bar */}
                <RuneFrame tier="rare" glow={false}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 24,
                      padding: '12px 18px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <StatBlock
                      label="In Progress"
                      value={inProgressCount}
                      color="#22d3ee"
                    />
                    <StatDivider />
                    <StatBlock
                      label="Awaiting Review"
                      value={awaitingReviewCount}
                      color="#facc15"
                    />
                    <StatDivider />
                    <StatBlock label="Completed" value={approvedCount} color="#4ade80" />
                  </div>
                </RuneFrame>

                {myQuests.map((submission) => (
                  <ActiveQuestCard
                    key={submission.id}
                    submission={submission}
                    onStart={() => handleStart(submission.questId)}
                    onOpenSubmit={() => setSubmissionTargetId(submission.questId)}
                    starting={startingId === submission.questId}
                  />
                ))}
              </>
            )}
          </div>
        )}

        {/* ============================== COMPLETED / QUEST LOG TAB ============================== */}
        {questBoardTab === 'completed' && (
          <div
            style={{
              padding: '14px 22px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              minHeight: 260,
              maxHeight: '60vh',
              overflowY: 'auto',
            }}
          >
            {questLogLoading ? (
              <LoadingBlock label="Gathering your conquests" />
            ) : rewards.length === 0 ? (
              <EmptyState
                icon="🏆"
                title="No completed quests yet"
                hint="Complete quests to earn tokens, skills, and legendary titles."
              />
            ) : (
              <>
                <RuneFrame tier="legendary" glow="subtle">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 22,
                      padding: '14px 20px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <StatBlock
                      label="Quests Done"
                      value={rewards.length}
                      color="#fb923c"
                      large
                    />
                    <StatDivider />
                    <StatBlock
                      label="Total Earned"
                      value={
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          {totalTokensEarned}
                          <span
                            style={{
                              fontSize: 11,
                              color: '#ca8a04',
                              letterSpacing: '0.1em',
                            }}
                          >
                            NT
                          </span>
                        </span>
                      }
                      color="#facc15"
                      large
                    />
                    {skillsEarned.length > 0 && (
                      <>
                        <StatDivider />
                        <StatBlock
                          label="Skills"
                          value={skillsEarned.length}
                          color="#c084fc"
                          large
                        />
                      </>
                    )}
                    {titlesEarned.length > 0 && (
                      <>
                        <StatDivider />
                        <StatBlock
                          label="Titles"
                          value={titlesEarned.length}
                          color="#fde68a"
                          large
                        />
                      </>
                    )}
                  </div>
                </RuneFrame>

                {/* Earned skills row */}
                {skillsEarned.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      padding: '4px 4px 0',
                    }}
                  >
                    {skillsEarned.map((r, i) => (
                      <RarityBadge
                        key={i}
                        tier="epic"
                        size="md"
                        label={r.skillName ?? 'Skill'}
                      />
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
      </RpgModal>

      {/* Nested submission modal */}
      <SubmissionModal
        open={!!submissionTargetId && !!submissionTarget}
        submission={submissionTarget}
        onClose={() => setSubmissionTargetId(null)}
        onSubmit={(data) => {
          if (!submissionTarget) return;
          handleSubmit(submissionTarget.questId, data);
        }}
        submitting={submittingId === submissionTargetId}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Stat block helpers (for Active + Quest Log summary rows)
// ---------------------------------------------------------------------------

function StatBlock({
  label,
  value,
  color,
  large,
}: {
  label: string;
  value: ReactNode;
  color: string;
  large?: boolean;
}) {
  return (
    <div>
      <p
        style={{
          fontSize: 9,
          color: `${color}b3`,
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          margin: 0,
          fontWeight: 700,
          fontFamily: 'var(--font-orbitron), sans-serif',
        }}
      >
        {label}
      </p>
      <p
        style={{
          fontFamily: 'var(--font-orbitron), sans-serif',
          fontSize: large ? 22 : 20,
          fontWeight: 700,
          color,
          margin: '2px 0 0',
          textShadow: `0 0 10px ${color}55`,
          lineHeight: 1.1,
        }}
      >
        {value}
      </p>
    </div>
  );
}

function StatDivider() {
  return (
    <div
      aria-hidden
      style={{
        height: 36,
        width: 1,
        background: 'rgba(148, 163, 184, 0.25)',
      }}
    />
  );
}
