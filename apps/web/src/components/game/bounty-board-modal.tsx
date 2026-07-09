'use client';

/**
 * BountyBoardModal — Team 3c reskin.
 *
 * Visual re-skin of the community bounty board using the shared RPG
 * primitives from `@/components/rpg`. Data flow is byte-for-byte identical
 * to the previous implementation: every useQuery / useMutation / store hook
 * is preserved, only the presentation layer changed.
 *
 * Bounty-specific UX notes
 * ------------------------
 * - Anyone can post a bounty. Creator escrows `tokenReward` NT on post,
 *   refunded on cancel, transferred on approve.
 * - Bonus rewards (`skill`, `agent_config`, `knowledge_book`, `custom`)
 *   render as inline pill chips in the card footer.
 * - Reputation tier (newcomer → master) maps to rarity:
 *     newcomer=common, apprentice=uncommon, journeyman=rare,
 *     expert=epic, master=legendary.
 *   Rendered as a `<RarityBadge>` with a ladder tooltip. Only shown when the
 *   backend returns `creatorReputation` on the row (detail endpoint does, list
 *   endpoint currently doesn't — we render defensively).
 * - Featured bounties (`isFeatured`) get the legendary gold frame with glow.
 * - Card rarity otherwise derives from difficulty:
 *     beginner=uncommon, intermediate=rare, advanced=epic, expert=mythic.
 *   Expired / cancelled bounties drop to `common` (grey).
 * - Attempt lifecycle (claimed → in_progress → submitted → approved/rejected)
 *   rendered as a horizontal rune-dot progression.
 * - Disputed state reserved for `mythic` tier — backend enum doesn't ship
 *   disputes yet; once it does, the code path is already in place.
 *
 * Post-bounty flow: kept as a `create` tab (the game store already has
 * `bountyBoardTab: 'create'` so changing this would be a store migration).
 * A big legendary "Post New Bounty" CTA also lives in the Browse tab header
 * and just jumps the user to that tab.
 */

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { api, ApiError } from '@/lib/api';
import { useIsGuest } from '@/hooks/use-is-guest';
import { GuestUpsellModal } from '@/components/game/guest-upsell-modal';

// Guests run an all-demo economy (founder ruling 2026-07-06). Bounties escrow
// REAL ClawTokens and can't be safely simulated, so a guest hitting any
// mutating bounty action gets the sign-up upsell — never a raw error toast.
const BOUNTY_UPSELL = {
  headline: 'Real bounties need a real account',
  body: 'Posting, claiming, and completing bounties moves real ClawTokens in and out of escrow. Guests run a demo economy — create a free account to earn and spend for real.',
  ctaLabel: 'Create free account',
} as const;

/** Backstop guard: did this error come back as a guest_not_allowed 403? */
function isGuestBlocked(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'guest_not_allowed';
}
import {
  RpgModal,
  RpgButton,
  RuneSpinner,
  RuneFrame,
  ItemCard,
  RarityBadge,
  RpgTooltip,
  ProgressSteps,
  StatusChip,
  type ProgressStep,
  type RarityId,
  type StatusChipTone,
} from '@/components/rpg';

type BountyTab = 'browse' | 'my-bounties' | 'my-attempts' | 'create';
type DifficultyFilter = 'all' | 'beginner' | 'intermediate' | 'advanced' | 'expert';
type SortMode = 'newest' | 'reward-high' | 'reward-low' | 'expiring-soon';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIFFICULTY_OPTIONS: { value: DifficultyFilter; label: string }[] = [
  { value: 'all', label: 'All Difficulties' },
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'expert', label: 'Expert' },
];

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'reward-high', label: 'Reward ↓' },
  { value: 'reward-low', label: 'Reward ↑' },
  { value: 'expiring-soon', label: 'Expiring' },
];

const DIFFICULTY_LABELS: Record<string, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
  expert: 'Expert',
};

// Reputation tier → rarity id. Ladder: newcomer → apprentice → journeyman →
// expert → master. Backend stores as `reputation_tier` pgEnum; we mirror it.
const REPUTATION_TO_RARITY: Record<string, RarityId> = {
  newcomer: 'common',
  apprentice: 'uncommon',
  journeyman: 'rare',
  expert: 'epic',
  master: 'legendary',
};

const REPUTATION_LABELS: Record<string, string> = {
  newcomer: 'Newcomer',
  apprentice: 'Apprentice',
  journeyman: 'Journeyman',
  expert: 'Expert',
  master: 'Master',
};

const REPUTATION_LADDER = [
  { tier: 'newcomer', threshold: '0 completed', rarity: 'common' as RarityId },
  { tier: 'apprentice', threshold: '3 completed', rarity: 'uncommon' as RarityId },
  { tier: 'journeyman', threshold: '10 completed', rarity: 'rare' as RarityId },
  { tier: 'expert', threshold: '25 completed', rarity: 'epic' as RarityId },
  { tier: 'master', threshold: '50+ completed', rarity: 'legendary' as RarityId },
];

// Attempt lifecycle steps for the progression indicator.
// Shape matches the shared @/components/rpg ProgressSteps primitive.
const ATTEMPT_STEPS: ReadonlyArray<ProgressStep> = [
  { id: 'claimed', label: 'Claimed' },
  { id: 'in_progress', label: 'Working' },
  { id: 'submitted', label: 'Submitted' },
  { id: 'approved', label: 'Approved' },
];

const BONUS_REWARD_ICONS: Record<string, string> = {
  skill: '💡',
  agent_config: '⚙',
  knowledge_book: '📖',
  custom: '🎁',
};

const BONUS_REWARD_LABELS: Record<string, string> = {
  skill: 'Skill',
  agent_config: 'Agent Config',
  knowledge_book: 'Knowledge Book',
  custom: 'Custom',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a card's visual rarity from bounty metadata.
 *
 * Priority:
 *   1. Featured bounty → legendary (team-promoted gold glow)
 *   2. Disputed (future state) → mythic (crimson)
 *   3. Cancelled / expired → common (grey)
 *   4. Completed → uncommon (soft green seal)
 *   5. Otherwise difficulty-scaled (beginner→uncommon … expert→mythic)
 */
function deriveBountyRarity(bounty: {
  isFeatured?: boolean;
  status?: string;
  difficulty?: string;
}): RarityId {
  if (bounty.isFeatured) return 'legendary';
  if (bounty.status === 'disputed') return 'mythic';
  if (bounty.status === 'cancelled' || bounty.status === 'expired') return 'common';
  if (bounty.status === 'completed') return 'uncommon';

  switch (bounty.difficulty) {
    case 'expert':
      return 'mythic';
    case 'advanced':
      return 'epic';
    case 'intermediate':
      return 'rare';
    case 'beginner':
    default:
      return 'uncommon';
  }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return '';
  }
}

function normaliseReputationTier(value: unknown): string {
  if (typeof value !== 'string') return 'newcomer';
  if (value in REPUTATION_TO_RARITY) return value;
  return 'newcomer';
}

// ---------------------------------------------------------------------------
// Reputation badge (with ladder tooltip)
// ---------------------------------------------------------------------------

function ReputationPill({
  tier,
  role,
}: {
  tier: string;
  role: 'Poster' | 'Hunter';
}) {
  const rarity = REPUTATION_TO_RARITY[tier] ?? 'common';
  const label = REPUTATION_LABELS[tier] ?? 'Newcomer';

  return (
    <RpgTooltip
      content={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#facc15',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              marginBottom: 2,
            }}
          >
            {role} Reputation
          </div>
          {REPUTATION_LADDER.map((step) => {
            const active = step.tier === tier;
            return (
              <div
                key={step.tier}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  fontSize: 10,
                  color: active ? '#e2e8f0' : '#64748b',
                  fontWeight: active ? 700 : 400,
                }}
              >
                <span>
                  {active ? '▸ ' : '  '}
                  {REPUTATION_LABELS[step.tier]}
                </span>
                <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>
                  {step.threshold}
                </span>
              </div>
            );
          })}
        </div>
      }
    >
      <RarityBadge tier={rarity} label={label} />
    </RpgTooltip>
  );
}

// ---------------------------------------------------------------------------
// Status helpers — StatusChip itself now lives in @/components/rpg
// ---------------------------------------------------------------------------

function bountyStatusTone(status: string): StatusChipTone {
  switch (status) {
    case 'open':
      return 'positive';
    case 'in_progress':
      return 'info';
    case 'completed':
      return 'warning';
    case 'cancelled':
      return 'danger';
    case 'expired':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function attemptStatusTone(status: string): StatusChipTone {
  switch (status) {
    case 'claimed':
      return 'info';
    case 'in_progress':
      return 'info';
    case 'submitted':
      return 'warning';
    case 'approved':
      return 'positive';
    case 'rejected':
      return 'danger';
    case 'abandoned':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function bountyStatusLabel(status: string): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'in_progress':
      return 'In Progress';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    case 'disputed':
      return 'Disputed';
    default:
      return status;
  }
}

function attemptStatusLabel(status: string): string {
  switch (status) {
    case 'claimed':
      return 'Claimed';
    case 'in_progress':
      return 'Working';
    case 'submitted':
      return 'Submitted';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'abandoned':
      return 'Abandoned';
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Bonus reward pill row
// ---------------------------------------------------------------------------

function BonusRewardPills({ rewards }: { rewards: any[] }) {
  if (!rewards || rewards.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        paddingTop: 2,
      }}
    >
      {rewards.map((r: any, i: number) => {
        const type = r.rewardType || r.type || 'custom';
        const icon = BONUS_REWARD_ICONS[type] || '🎁';
        const label =
          r.label ||
          r.customDescription ||
          BONUS_REWARD_LABELS[type] ||
          type;
        return (
          <span
            key={i}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 8px',
              borderRadius: 6,
              fontSize: 10,
              fontWeight: 600,
              background: 'rgba(249, 115, 22, 0.1)',
              border: '1px solid rgba(249, 115, 22, 0.35)',
              color: '#fb923c',
              letterSpacing: '0.02em',
            }}
          >
            <span aria-hidden>{icon}</span>
            <span>{label}</span>
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attempt progression indicator — thin wrapper around the shared
// @/components/rpg ProgressSteps primitive in diamond shape.
// ---------------------------------------------------------------------------

function AttemptProgression({ status }: { status: string }) {
  const failed = status === 'rejected';
  // When rejected, anchor the failed marker at `submitted` (the review
  // gate) since the backend doesn't tell us exactly where it failed.
  const primitiveCurrent = failed ? 'submitted' : status;

  return (
    <ProgressSteps
      steps={ATTEMPT_STEPS}
      current={primitiveCurrent}
      failed={failed}
      shape="diamond"
      tier="rare"
      style={{ padding: '8px 2px 4px', margin: 0 }}
    />
  );
}

// ---------------------------------------------------------------------------
// Browse tab: Bounty card
// ---------------------------------------------------------------------------

function BrowseBountyCard({
  bounty,
  onClaim,
  claiming,
}: {
  bounty: any;
  onClaim: () => void;
  claiming: boolean;
}) {
  const difficulty = bounty.difficulty || 'beginner';
  const rarity = deriveBountyRarity(bounty);
  const claimedCount = bounty.currentAttempts ?? 0;
  const maxAttempts = bounty.maxAttempts ?? 1;
  const isFull = claimedCount >= maxAttempts;
  const title = bounty.title || 'Untitled Bounty';
  const creatorName = bounty.creatorAvatarName || 'Unknown';
  const creatorRepTier = normaliseReputationTier(bounty.creatorReputation?.tier);

  const stats: { label: string; value: React.ReactNode }[] = [
    { label: 'Reward', value: `${bounty.tokenReward ?? 0} NT` },
    { label: 'Difficulty', value: DIFFICULTY_LABELS[difficulty] ?? difficulty },
    { label: 'Attempts', value: `${claimedCount} / ${maxAttempts}` },
  ];
  if (bounty.expiresAt) {
    stats.push({ label: 'Expires', value: formatDate(bounty.expiresAt) });
  }

  const subtitle = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
      }}
    >
      <span>by {creatorName}</span>
      {bounty.creatorReputation && (
        <ReputationPill tier={creatorRepTier} role="Poster" />
      )}
    </span>
  );

  return (
    <ItemCard
      rarity={rarity}
      glow={bounty.isFeatured ? 'strong' : undefined}
      name={title}
      subtitle={subtitle}
      icon={<span>📌</span>}
      description={bounty.description}
      stats={stats}
      price={bounty.tokenReward ?? 0}
      priceUnit="NT"
      badge={
        <StatusChip
          label={bountyStatusLabel(bounty.status || 'open')}
          tone={bountyStatusTone(bounty.status || 'open')}
        />
      }
      footer={
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            width: '100%',
          }}
        >
          {bounty.bonusRewards && bounty.bonusRewards.length > 0 && (
            <BonusRewardPills rewards={bounty.bonusRewards} />
          )}
          {bounty.tags && bounty.tags.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 4,
              }}
            >
              {bounty.tags.map((tag: string) => (
                <span
                  key={tag}
                  style={{
                    padding: '1px 6px',
                    borderRadius: 4,
                    fontSize: 9,
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(148, 163, 184, 0.2)',
                    color: '#64748b',
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
              }}
            >
              {bounty.isFeatured ? 'Featured' : `${maxAttempts - claimedCount} slot${maxAttempts - claimedCount === 1 ? '' : 's'} left`}
            </span>
            <RpgButton
              variant="primary"
              size="sm"
              rarity={bounty.isFeatured ? 'legendary' : undefined}
              disabled={isFull}
              loading={claiming}
              onClick={(e) => {
                e.stopPropagation();
                onClaim();
              }}
            >
              {isFull ? 'Fully Claimed' : 'Claim Bounty'}
            </RpgButton>
          </div>
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// My Attempts tab: Attempt card
// ---------------------------------------------------------------------------

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
  const rarity = deriveBountyRarity({
    difficulty,
    status: bounty.status,
    isFeatured: false,
  });

  const canSubmit = status === 'claimed' || status === 'in_progress';
  const canAbandon = status === 'claimed' || status === 'in_progress';

  const handleSubmit = () => {
    if (note.length < 10) return;
    onSubmit({ prLink: prLink || undefined, submissionNote: note });
    setShowSubmitForm(false);
    setPrLink('');
    setNote('');
  };

  const stats: { label: string; value: React.ReactNode }[] = [
    { label: 'Reward', value: `${bounty.tokenReward ?? '?'} NT` },
    { label: 'Difficulty', value: DIFFICULTY_LABELS[difficulty] ?? difficulty },
    { label: 'Status', value: attemptStatusLabel(status) },
  ];

  return (
    <ItemCard
      rarity={rarity}
      name={bounty.title || attempt.bountyTitle || 'Bounty'}
      subtitle="Your attempt"
      icon={<span>🎯</span>}
      description={bounty.description}
      stats={stats}
      badge={
        <StatusChip
          label={attemptStatusLabel(status)}
          tone={attemptStatusTone(status)}
        />
      }
      footer={
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            width: '100%',
          }}
        >
          <AttemptProgression status={status} />

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            {canSubmit && (
              <>
                <RpgButton
                  variant="danger"
                  size="sm"
                  loading={abandoning}
                  disabled={!canAbandon}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAbandon();
                  }}
                >
                  Abandon
                </RpgButton>
                <RpgButton
                  variant="primary"
                  size="sm"
                  rarity="epic"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowSubmitForm((v) => !v);
                  }}
                >
                  {showSubmitForm ? 'Close' : 'Submit Work'}
                </RpgButton>
              </>
            )}
            {status === 'submitted' && (
              <span
                style={{
                  fontSize: 10,
                  fontStyle: 'italic',
                  color: '#94a3b8',
                  padding: '6px 8px',
                }}
              >
                Awaiting review...
              </span>
            )}
            {status === 'approved' && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#4ade80',
                  padding: '4px 8px',
                }}
              >
                ✓ Approved
              </span>
            )}
            {status === 'rejected' && (
              <>
                {attempt.reviewNote && (
                  <RpgTooltip content={attempt.reviewNote}>
                    <span
                      style={{
                        fontSize: 10,
                        fontStyle: 'italic',
                        color: '#f87171',
                        maxWidth: 180,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {attempt.reviewNote}
                    </span>
                  </RpgTooltip>
                )}
                <RpgButton
                  variant="danger"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowSubmitForm((v) => !v);
                  }}
                >
                  Re-submit
                </RpgButton>
              </>
            )}
          </div>

          {showSubmitForm && (canSubmit || status === 'rejected') && (
            <RuneFrame tier="epic" glow="subtle" style={{ marginTop: 4 }}>
              <div
                style={{
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <input
                  type="url"
                  placeholder="GitHub PR link (optional)"
                  value={prLink}
                  onChange={(e) => setPrLink(e.target.value)}
                  style={INPUT_STYLE}
                />
                <textarea
                  placeholder="Describe what you did (min 10 chars)..."
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={4}
                  style={{ ...INPUT_STYLE, resize: 'none' }}
                />
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 10, color: '#64748b' }}>
                    {note.length}/10 min chars
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <RpgButton
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowSubmitForm(false);
                      }}
                    >
                      Cancel
                    </RpgButton>
                    <RpgButton
                      variant="primary"
                      size="sm"
                      disabled={note.length < 10}
                      loading={submitting}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSubmit();
                      }}
                    >
                      Submit for Review
                    </RpgButton>
                  </div>
                </div>
              </div>
            </RuneFrame>
          )}
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// My Bounties tab: Creator bounty card (with submissions review)
// ---------------------------------------------------------------------------

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
  const [reviewingAttemptId, setReviewingAttemptId] = useState<string | null>(
    null
  );
  const [reviewNote, setReviewNote] = useState('');

  const rarity = deriveBountyRarity(bounty);
  const status = bounty.status || 'open';
  const difficulty = bounty.difficulty || 'beginner';
  const attempts = bounty.attempts || [];
  const hasActiveAttempts = attempts.some((a: any) =>
    ['claimed', 'in_progress', 'submitted'].includes(a.status)
  );

  const handleReviewDecision = (attemptId: string, decision: string) => {
    onReview(attemptId, decision, reviewNote || undefined);
    setReviewingAttemptId(null);
    setReviewNote('');
  };

  const stats: { label: string; value: React.ReactNode }[] = [
    { label: 'Escrow', value: `${bounty.tokenReward ?? 0} NT` },
    { label: 'Difficulty', value: DIFFICULTY_LABELS[difficulty] ?? difficulty },
    {
      label: 'Attempts',
      value: `${bounty.currentAttempts ?? 0} / ${bounty.maxAttempts ?? 1}`,
    },
    { label: 'Submissions', value: attempts.length },
  ];

  return (
    <ItemCard
      rarity={rarity}
      glow={bounty.isFeatured ? 'strong' : undefined}
      name={bounty.title}
      subtitle={
        bounty.isFeatured ? 'Featured · Community promoted' : 'Your bounty'
      }
      icon={<span>📜</span>}
      description={bounty.description}
      stats={stats}
      badge={
        <StatusChip
          label={bountyStatusLabel(status)}
          tone={bountyStatusTone(status)}
        />
      }
      footer={
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            width: '100%',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <RpgButton
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
            >
              {expanded ? 'Hide' : 'View'} Submissions ({attempts.length})
            </RpgButton>
            {status === 'open' && !hasActiveAttempts && (
              <RpgButton
                variant="danger"
                size="sm"
                loading={cancelling}
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel();
                }}
              >
                Cancel Bounty
              </RpgButton>
            )}
          </div>

          {expanded && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                paddingTop: 8,
                borderTop: '1px dashed rgba(148, 163, 184, 0.2)',
              }}
            >
              {attempts.length === 0 ? (
                <p
                  style={{
                    fontSize: 11,
                    color: '#64748b',
                    fontStyle: 'italic',
                    margin: 0,
                  }}
                >
                  No submissions yet.
                </p>
              ) : (
                attempts.map((attempt: any) => (
                  <RuneFrame
                    key={attempt.id}
                    tier="common"
                    glow={false}
                    style={{ padding: 0 }}
                  >
                    <div
                      style={{
                        padding: 10,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            minWidth: 0,
                          }}
                        >
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: '#e2e8f0',
                            }}
                          >
                            {attempt.hunterName || 'Hunter'}
                          </span>
                          <StatusChip
                            label={attemptStatusLabel(attempt.status)}
                            tone={attemptStatusTone(attempt.status)}
                          />
                        </div>
                        <span style={{ fontSize: 9, color: '#64748b' }}>
                          {attempt.submittedAt
                            ? formatDate(attempt.submittedAt)
                            : ''}
                        </span>
                      </div>
                      {attempt.submissionNote && (
                        <p
                          style={{
                            fontSize: 11,
                            color: '#cbd5e1',
                            margin: 0,
                            lineHeight: 1.45,
                          }}
                        >
                          {attempt.submissionNote}
                        </p>
                      )}
                      {attempt.prLink && (
                        <a
                          href={attempt.prLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            fontSize: 10,
                            color: '#7dd3fc',
                            textDecoration: 'underline',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            display: 'block',
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {attempt.prLink}
                        </a>
                      )}

                      {attempt.status === 'submitted' && (
                        <div style={{ marginTop: 4 }}>
                          {reviewingAttemptId === attempt.id ? (
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 6,
                              }}
                            >
                              <textarea
                                placeholder="Review note (optional)..."
                                value={reviewNote}
                                onChange={(e) => setReviewNote(e.target.value)}
                                rows={3}
                                style={{ ...INPUT_STYLE, resize: 'none' }}
                              />
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  justifyContent: 'flex-end',
                                }}
                              >
                                <RpgButton
                                  variant="ghost"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setReviewingAttemptId(null);
                                    setReviewNote('');
                                  }}
                                >
                                  Cancel
                                </RpgButton>
                                <RpgButton
                                  variant="danger"
                                  size="sm"
                                  loading={reviewing}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleReviewDecision(attempt.id, 'rejected');
                                  }}
                                >
                                  Reject
                                </RpgButton>
                                <RpgButton
                                  variant="primary"
                                  size="sm"
                                  rarity="uncommon"
                                  loading={reviewing}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleReviewDecision(attempt.id, 'approved');
                                  }}
                                >
                                  Approve
                                </RpgButton>
                              </div>
                            </div>
                          ) : (
                            <RpgButton
                              variant="primary"
                              size="sm"
                              rarity="legendary"
                              onClick={(e) => {
                                e.stopPropagation();
                                setReviewingAttemptId(attempt.id);
                              }}
                            >
                              Review
                            </RpgButton>
                          )}
                        </div>
                      )}
                    </div>
                  </RuneFrame>
                ))
              )}
            </div>
          )}
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Create tab: Bounty form
// ---------------------------------------------------------------------------

function CreateBountyForm({
  tokens,
  onCreated,
  onGuestBlocked,
}: {
  tokens: number;
  onCreated: () => void;
  onGuestBlocked: () => void;
}) {
  const { addToast } = useGameStore();
  const queryClient = useQueryClient();
  const isGuest = useIsGuest();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [requirements, setRequirements] = useState('');
  const [difficulty, setDifficulty] = useState<string>('beginner');
  const [tokenReward, setTokenReward] = useState<number>(50);
  const [maxAttempts, setMaxAttempts] = useState<number>(3);
  const [tagsInput, setTagsInput] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [bonusRewards, setBonusRewards] = useState<
    Array<{ type: string; label: string; value: string }>
  >([]);

  const createMutation = useMutation({
    mutationFn: (data: any) => api.createBounty(data),
    onSuccess: () => {
      addToast('📌', 'Bounty posted!');
      queryClient.invalidateQueries({ queryKey: ['bounties'] });
      queryClient.invalidateQueries({ queryKey: ['my-bounties'] });
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
      onCreated();
    },
    onError: (err: Error) => {
      // Backstop: a guest slipped past the preemptive gate (auth-me not yet
      // resolved) — show the upsell, never the raw server string.
      if (isGuestBlocked(err)) {
        onGuestBlocked();
        return;
      }
      addToast('❌', err.message || 'Failed to post bounty');
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
    // Preemptive gate — guests never hit the escrow write path; they see the
    // sign-up upsell instead of a server round-trip + error toast.
    if (isGuest) {
      onGuestBlocked();
      return;
    }

    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    // Preserve exact payload shape of prior implementation.
    createMutation.mutate({
      title: title.trim(),
      description: description.trim(),
      requirements: requirements.trim() || undefined,
      difficulty,
      tokenReward,
      maxAttempts,
      tags: tags.length > 0 ? tags : undefined,
      expiresAt: expiresAt || undefined,
      bonusRewards:
        bonusRewards.length > 0
          ? bonusRewards.filter((b) => b.label.trim())
          : undefined,
    });
  };

  const canSubmit =
    !createMutation.isPending &&
    !!title.trim() &&
    !!description.trim() &&
    tokenReward >= 1 &&
    tokenReward <= tokens;

  return (
    <div
      style={{
        padding: '14px 22px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        maxHeight: '60vh',
        overflowY: 'auto',
      }}
    >
      <RuneFrame tier="legendary" glow="subtle">
        <div
          style={{
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div>
            <h3
              style={{
                fontFamily: 'var(--font-orbitron), sans-serif',
                fontSize: 13,
                fontWeight: 700,
                color: '#fb923c',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                margin: 0,
              }}
            >
              Post New Bounty
            </h3>
            <p style={{ fontSize: 10, color: '#94a3b8', margin: '3px 0 0' }}>
              Escrow ClawTokens and let the community (or AI agents) take the
              task.
            </p>
          </div>
          <RarityBadge tier="legendary" label="Open Call" />
        </div>
      </RuneFrame>

      {/* Title */}
      <Field label="Title *">
        <input
          type="text"
          placeholder="e.g. Build a cron job scheduler plugin"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          style={INPUT_STYLE}
        />
      </Field>

      {/* Description */}
      <Field label="Description *">
        <textarea
          placeholder="Detailed description of what needs to be done..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          style={{ ...INPUT_STYLE, resize: 'none' }}
        />
      </Field>

      {/* Requirements */}
      <Field label="Requirements (optional)">
        <textarea
          placeholder="Specific requirements or acceptance criteria..."
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
          rows={3}
          style={{ ...INPUT_STYLE, resize: 'none' }}
        />
      </Field>

      {/* Row: Difficulty + Token Reward + Max Attempts */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 10,
        }}
      >
        <Field label="Difficulty">
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            style={INPUT_STYLE}
          >
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
            <option value="expert">Expert</option>
          </select>
        </Field>
        <Field label={`Reward (bal: ${tokens} NT)`}>
          <input
            type="number"
            min={1}
            max={tokens}
            value={tokenReward}
            onChange={(e) => setTokenReward(Number(e.target.value))}
            style={INPUT_STYLE}
          />
        </Field>
        <Field label="Max Attempts">
          <input
            type="number"
            min={1}
            max={20}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(Number(e.target.value))}
            style={INPUT_STYLE}
          />
        </Field>
      </div>

      {/* Tags */}
      <Field label="Tags (comma-separated)">
        <input
          type="text"
          placeholder="e.g. plugin, cron, scheduling"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          style={INPUT_STYLE}
        />
      </Field>

      {/* Expiry */}
      <Field label="Expiry Date (optional)">
        <input
          type="date"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          style={INPUT_STYLE}
        />
      </Field>

      {/* Bonus Rewards */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 6,
          }}
        >
          <label
            style={{
              fontSize: 10,
              color: '#94a3b8',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              fontWeight: 700,
            }}
          >
            Bonus Rewards
          </label>
          <RpgButton variant="ghost" size="sm" onClick={handleAddBonus}>
            + Add Bonus
          </RpgButton>
        </div>
        {bonusRewards.length === 0 ? (
          <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>
            Optional. Layer in a skill, agent config, knowledge book, or
            anything custom.
          </p>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {bonusRewards.map((bonus, i) => (
              <RuneFrame key={i} tier="legendary" glow={false}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: 8,
                  }}
                >
                  <span aria-hidden style={{ fontSize: 16 }}>
                    {BONUS_REWARD_ICONS[bonus.type] || '🎁'}
                  </span>
                  <select
                    value={bonus.type}
                    onChange={(e) =>
                      handleBonusChange(i, 'type', e.target.value)
                    }
                    style={{ ...INPUT_STYLE, width: 130 }}
                  >
                    <option value="skill">Skill</option>
                    <option value="agent_config">Agent Config</option>
                    <option value="knowledge_book">Knowledge Book</option>
                    <option value="custom">Custom</option>
                  </select>
                  <input
                    type="text"
                    placeholder="Label"
                    value={bonus.label}
                    onChange={(e) =>
                      handleBonusChange(i, 'label', e.target.value)
                    }
                    style={{ ...INPUT_STYLE, flex: 1 }}
                  />
                  <input
                    type="text"
                    placeholder="Value / ID"
                    value={bonus.value}
                    onChange={(e) =>
                      handleBonusChange(i, 'value', e.target.value)
                    }
                    style={{ ...INPUT_STYLE, flex: 1 }}
                  />
                  <RpgButton
                    variant="danger"
                    size="sm"
                    onClick={() => handleRemoveBonus(i)}
                  >
                    ✕
                  </RpgButton>
                </div>
              </RuneFrame>
            ))}
          </div>
        )}
      </div>

      {/* Escrow notice */}
      <RuneFrame tier="legendary" glow={false}>
        <div style={{ padding: 12 }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: '#fb923c',
              margin: 0,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            }}
          >
            Escrow Notice
          </p>
          <p
            style={{
              fontSize: 10,
              color: '#fcd34d',
              margin: '6px 0 0',
              lineHeight: 1.5,
            }}
          >
            {tokenReward} NT will be held in escrow the moment you post. Tokens
            release to the hunter on approval, refund to you on cancel (while
            no attempts are active).
          </p>
        </div>
      </RuneFrame>

      {/* Submit */}
      <RpgButton
        variant="primary"
        size="lg"
        rarity="legendary"
        disabled={!canSubmit}
        loading={createMutation.isPending}
        onClick={handleSubmit}
      >
        {`Post Bounty · ${tokenReward} NT escrow`}
      </RpgButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared input / field primitives
// ---------------------------------------------------------------------------

const INPUT_STYLE: React.CSSProperties = {
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

const FILTER_INPUT_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  padding: '6px 10px',
  fontSize: 11,
  width: 'auto',
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        style={{
          display: 'block',
          fontSize: 10,
          color: '#94a3b8',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          fontWeight: 700,
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary banner (stats strip shown on My Bounties / My Attempts tabs)
// ---------------------------------------------------------------------------

function SummaryBanner({
  tier,
  items,
}: {
  tier: RarityId;
  items: { label: string; value: string | number; accent: string }[];
}) {
  return (
    <RuneFrame tier={tier} glow={false}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 22,
          padding: '12px 18px',
          flexWrap: 'wrap',
        }}
      >
        {items.map((it, idx) => (
          <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
            <div>
              <p
                style={{
                  fontSize: 9,
                  color: 'rgba(148, 163, 184, 0.75)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.14em',
                  margin: 0,
                  fontWeight: 700,
                }}
              >
                {it.label}
              </p>
              <p
                style={{
                  fontFamily: 'var(--font-orbitron), sans-serif',
                  fontSize: 20,
                  fontWeight: 700,
                  color: it.accent,
                  margin: '2px 0 0',
                }}
              >
                {it.value}
              </p>
            </div>
            {idx < items.length - 1 && (
              <div
                style={{
                  height: 36,
                  width: 1,
                  background: 'rgba(148, 163, 184, 0.25)',
                }}
              />
            )}
          </div>
        ))}
      </div>
    </RuneFrame>
  );
}

// ---------------------------------------------------------------------------
// Empty state
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
          filter: 'drop-shadow(0 0 16px rgba(249, 115, 22, 0.3))',
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
      <p
        style={{
          fontSize: 11,
          color: '#64748b',
          maxWidth: 360,
          margin: 0,
        }}
      >
        {hint}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

export default function BountyBoardModal() {
  const {
    bountyBoardOpen,
    closeBountyBoard,
    bountyBoardTab,
    setBountyBoardTab,
    addToast,
  } = useGameStore();
  const { data: avatar } = useAvatar();
  const queryClient = useQueryClient();
  const isGuest = useIsGuest();

  // Guest sign-up upsell (shown instead of any real-CT bounty action / any
  // guest_not_allowed 403). One instance for the whole board.
  const [guestUpsellOpen, setGuestUpsellOpen] = useState(false);

  // Filters
  const [difficultyFilter, setDifficultyFilter] =
    useState<DifficultyFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [page, setPage] = useState(1);

  // Local action state (per-row loading flags)
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [abandoningId, setAbandoningId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  // Reset page on filter/tab change
  useEffect(() => {
    setPage(1);
  }, [bountyBoardTab, difficultyFilter, sortMode]);

  // Build query params (preserved byte-for-byte from prior impl so cache keys
  // line up across the visual rewrite).
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
      addToast('🎯', 'Bounty claimed! Get to work!');
      queryClient.invalidateQueries({ queryKey: ['bounties'] });
      queryClient.invalidateQueries({ queryKey: ['my-bounty-attempts'] });
      setClaimingId(null);
    },
    onError: (err: Error) => {
      setClaimingId(null);
      if (isGuestBlocked(err)) {
        setGuestUpsellOpen(true);
        return;
      }
      addToast('❌', err.message || 'Failed to claim bounty');
    },
  });

  // Submit mutation
  const submitMutation = useMutation({
    mutationFn: ({
      bountyId,
      data,
    }: {
      bountyId: string;
      data: { prLink?: string; submissionNote: string };
    }) => api.submitBountyAttempt(bountyId, data),
    onSuccess: () => {
      addToast('✅', 'Work submitted for review!');
      queryClient.invalidateQueries({ queryKey: ['my-bounty-attempts'] });
      setSubmittingId(null);
    },
    onError: (err: Error) => {
      setSubmittingId(null);
      if (isGuestBlocked(err)) {
        setGuestUpsellOpen(true);
        return;
      }
      addToast('❌', err.message || 'Submission failed');
    },
  });

  // Abandon mutation
  const abandonMutation = useMutation({
    mutationFn: (bountyId: string) => api.abandonBounty(bountyId),
    onSuccess: () => {
      addToast('🚪', 'Bounty abandoned');
      queryClient.invalidateQueries({ queryKey: ['my-bounty-attempts'] });
      queryClient.invalidateQueries({ queryKey: ['bounties'] });
      setAbandoningId(null);
    },
    onError: (err: Error) => {
      setAbandoningId(null);
      if (isGuestBlocked(err)) {
        setGuestUpsellOpen(true);
        return;
      }
      addToast('❌', err.message || 'Failed to abandon');
    },
  });

  // Cancel mutation (creator)
  const cancelMutation = useMutation({
    mutationFn: (bountyId: string) => api.cancelBounty(bountyId),
    onSuccess: () => {
      addToast('🗑️', 'Bounty cancelled. Tokens refunded.');
      queryClient.invalidateQueries({ queryKey: ['my-bounties'] });
      queryClient.invalidateQueries({ queryKey: ['bounties'] });
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
      setCancellingId(null);
    },
    onError: (err: Error) => {
      setCancellingId(null);
      if (isGuestBlocked(err)) {
        setGuestUpsellOpen(true);
        return;
      }
      addToast('❌', err.message || 'Failed to cancel');
    },
  });

  // Review mutation
  const reviewMutation = useMutation({
    mutationFn: ({
      attemptId,
      data,
    }: {
      attemptId: string;
      data: { decision: string; reviewNote?: string };
    }) => api.reviewBountyAttempt(attemptId, data),
    onSuccess: () => {
      addToast('✅', 'Review submitted!');
      queryClient.invalidateQueries({ queryKey: ['my-bounties'] });
      queryClient.invalidateQueries({ queryKey: ['my-bounty-attempts'] });
      queryClient.invalidateQueries({ queryKey: ['bounties'] });
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
      setReviewingId(null);
    },
    onError: (err: Error) => {
      setReviewingId(null);
      if (isGuestBlocked(err)) {
        setGuestUpsellOpen(true);
        return;
      }
      addToast('❌', err.message || 'Review failed');
    },
  });

  // Preemptive guest gate — a guest never reaches the escrow write path; the
  // action opens the sign-up upsell instead of a server round-trip.
  const handleClaim = useCallback(
    (bountyId: string) => {
      if (isGuest) {
        setGuestUpsellOpen(true);
        return;
      }
      setClaimingId(bountyId);
      claimMutation.mutate(bountyId);
    },
    [claimMutation, isGuest]
  );

  const handleSubmit = useCallback(
    (bountyId: string, data: { prLink?: string; submissionNote: string }) => {
      if (isGuest) {
        setGuestUpsellOpen(true);
        return;
      }
      setSubmittingId(bountyId);
      submitMutation.mutate({ bountyId, data });
    },
    [submitMutation, isGuest]
  );

  const handleAbandon = useCallback(
    (bountyId: string) => {
      if (isGuest) {
        setGuestUpsellOpen(true);
        return;
      }
      setAbandoningId(bountyId);
      abandonMutation.mutate(bountyId);
    },
    [abandonMutation, isGuest]
  );

  const handleCancel = useCallback(
    (bountyId: string) => {
      if (isGuest) {
        setGuestUpsellOpen(true);
        return;
      }
      setCancellingId(bountyId);
      cancelMutation.mutate(bountyId);
    },
    [cancelMutation, isGuest]
  );

  const handleReview = useCallback(
    (attemptId: string, decision: string, reviewNote?: string) => {
      if (isGuest) {
        setGuestUpsellOpen(true);
        return;
      }
      setReviewingId(attemptId);
      reviewMutation.mutate({ attemptId, data: { decision, reviewNote } });
    },
    [reviewMutation, isGuest]
  );

  if (!bountyBoardOpen) return null;

  const bounties = bountiesData?.bounties ?? [];
  const total = bountiesData?.total ?? 0;
  const pageSize = bountiesData?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const myBounties = myBountiesData?.bounties ?? [];
  const myAttempts = myAttemptsData?.attempts ?? [];
  const tokens = avatar?.clawTokens ?? 0;

  const totalEscrowed = myBounties
    .filter((b: any) => b.status === 'open' || b.status === 'in_progress')
    .reduce((sum: number, b: any) => sum + (b.tokenReward || 0), 0);
  const activeCreatorCount = myBounties.filter(
    (b: any) => b.status === 'open' || b.status === 'in_progress'
  ).length;
  const completedCreatorCount = myBounties.filter(
    (b: any) => b.status === 'completed'
  ).length;

  const hunterInProgress = myAttempts.filter((a: any) =>
    ['claimed', 'in_progress'].includes(a.status)
  ).length;
  const hunterAwaiting = myAttempts.filter(
    (a: any) => a.status === 'submitted'
  ).length;
  const hunterApproved = myAttempts.filter(
    (a: any) => a.status === 'approved'
  ).length;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <>
    <RpgModal
      open={bountyBoardOpen}
      onClose={closeBountyBoard}
      title="Bounty Board"
      subtitle="Community Bounties · Escrow · Reputation"
      tier="rare"
      glow="subtle"
      headerIcon={<span>📌</span>}
      maxWidth={1040}
      tokenBadge={
        <RpgTooltip content="Your ClawToken balance — escrowed on post, released on approval.">
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 14px',
              borderRadius: 999,
              background: 'rgba(249, 115, 22, 0.08)',
              border: '1px solid rgba(249, 115, 22, 0.35)',
              color: '#fb923c',
              fontFamily: 'var(--font-orbitron), sans-serif',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.05em',
              textShadow: '0 0 8px rgba(249, 115, 22, 0.35)',
            }}
          >
            <span style={{ fontSize: 13 }}>◈</span>
            {tokens} NT
          </span>
        </RpgTooltip>
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
        {(
          [
            { key: 'browse', label: 'Browse' },
            { key: 'my-bounties', label: 'My Bounties' },
            { key: 'my-attempts', label: 'My Attempts' },
            { key: 'create', label: 'Post Bounty' },
          ] as { key: BountyTab; label: string }[]
        ).map((t) => {
          const isActive = bountyBoardTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setBountyBoardTab(t.key)}
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
                color: isActive ? '#7dd3fc' : '#64748b',
                cursor: 'pointer',
                transition: 'color 180ms ease',
              }}
            >
              {t.label}
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 12,
                  right: 12,
                  bottom: -1,
                  height: 2,
                  background: isActive
                    ? 'linear-gradient(90deg, transparent 0%, #38bdf8 50%, transparent 100%)'
                    : 'transparent',
                  boxShadow: isActive
                    ? '0 0 10px rgba(56, 189, 248, 0.55)'
                    : 'none',
                  transition: 'background 200ms ease',
                }}
              />
            </button>
          );
        })}
      </div>

      {/* ============================== BROWSE TAB ============================== */}
      {bountyBoardTab === 'browse' && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Filters */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 8,
              padding: '12px 22px',
              borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
            }}
          >
            <select
              value={difficultyFilter}
              onChange={(e) =>
                setDifficultyFilter(e.target.value as DifficultyFilter)
              }
              style={FILTER_INPUT_STYLE}
            >
              {DIFFICULTY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  fontWeight: 700,
                }}
              >
                Sort
              </span>
              {SORT_OPTIONS.map((s) => (
                <RpgButton
                  key={s.value}
                  variant="ghost"
                  size="sm"
                  onClick={() => setSortMode(s.value)}
                  style={{
                    fontSize: 9,
                    padding: '4px 10px',
                    background:
                      sortMode === s.value
                        ? 'rgba(56, 189, 248, 0.15)'
                        : 'rgba(10, 22, 40, 0.4)',
                    color: sortMode === s.value ? '#7dd3fc' : '#94a3b8',
                    border: `1px solid ${sortMode === s.value ? 'rgba(56, 189, 248, 0.5)' : 'rgba(148, 163, 184, 0.2)'}`,
                  }}
                >
                  {s.label}
                </RpgButton>
              ))}
            </div>

            <span
              style={{
                marginLeft: 'auto',
                fontSize: 10,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}
            >
              {total} bount{total !== 1 ? 'ies' : 'y'} pinned
            </span>

            <RpgButton
              variant="primary"
              size="sm"
              rarity="legendary"
              onClick={() => setBountyBoardTab('create')}
            >
              + Post New Bounty
            </RpgButton>
          </div>

          {/* Bounty list */}
          <div
            style={{
              padding: '14px 22px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              minHeight: 240,
              maxHeight: '58vh',
              overflowY: 'auto',
            }}
          >
            {bountiesLoading ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
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
                  Unfurling the notice board
                </span>
              </div>
            ) : bounties.length === 0 ? (
              <EmptyState
                icon="📌"
                title="The board is empty"
                hint='No bounties match your filters. Try widening the difficulty or jump to "Post Bounty" to pin your own.'
              />
            ) : (
              <>
                {bounties.map((bounty: any) => (
                  <BrowseBountyCard
                    key={bounty.id}
                    bounty={bounty}
                    onClaim={() => handleClaim(bounty.id)}
                    claiming={claimingId === bounty.id}
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
                      onClick={() =>
                        setPage((p) => Math.min(totalPages, p + 1))
                      }
                    >
                      Next →
                    </RpgButton>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ============================== MY BOUNTIES TAB ============================== */}
      {bountyBoardTab === 'my-bounties' && (
        <div
          style={{
            padding: '14px 22px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            minHeight: 240,
            maxHeight: '58vh',
            overflowY: 'auto',
          }}
        >
          {myBountiesLoading ? (
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
                Rolling up your scrolls
              </span>
            </div>
          ) : myBounties.length === 0 ? (
            <EmptyState
              icon="📜"
              title="No bounties posted"
              hint='Switch to "Post Bounty" to pin your first community task.'
            />
          ) : (
            <>
              <SummaryBanner
                tier="legendary"
                items={[
                  {
                    label: 'Active',
                    value: activeCreatorCount,
                    accent: '#fb923c',
                  },
                  {
                    label: 'Completed',
                    value: completedCreatorCount,
                    accent: '#4ade80',
                  },
                  {
                    label: 'Total Escrowed',
                    value: `${totalEscrowed} NT`,
                    accent: '#facc15',
                  },
                ]}
              />

              {myBounties.map((bounty: any) => (
                <CreatorBountyCard
                  key={bounty.id}
                  bounty={bounty}
                  onCancel={() => handleCancel(bounty.id)}
                  onReview={(attemptId, decision, reviewNote) =>
                    handleReview(attemptId, decision, reviewNote)
                  }
                  cancelling={cancellingId === bounty.id}
                  reviewing={reviewMutation.isPending}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* ============================== MY ATTEMPTS TAB ============================== */}
      {bountyBoardTab === 'my-attempts' && (
        <div
          style={{
            padding: '14px 22px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            minHeight: 240,
            maxHeight: '58vh',
            overflowY: 'auto',
          }}
        >
          {myAttemptsLoading ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                padding: '60px 0',
              }}
            >
              <RuneSpinner size={44} tier="rare" />
              <span
                style={{
                  fontSize: 10,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  letterSpacing: '0.2em',
                }}
              >
                Tracking your quarry
              </span>
            </div>
          ) : myAttempts.length === 0 ? (
            <EmptyState
              icon="🎯"
              title="No active hunts"
              hint="Claim a bounty from the Browse tab and pin the quest to your ledger."
            />
          ) : (
            <>
              <SummaryBanner
                tier="rare"
                items={[
                  {
                    label: 'In Progress',
                    value: hunterInProgress,
                    accent: '#7dd3fc',
                  },
                  {
                    label: 'Awaiting Review',
                    value: hunterAwaiting,
                    accent: '#facc15',
                  },
                  {
                    label: 'Approved',
                    value: hunterApproved,
                    accent: '#4ade80',
                  },
                ]}
              />

              {myAttempts.map((attempt: any) => (
                <AttemptCard
                  key={attempt.id}
                  attempt={attempt}
                  onSubmit={(data) =>
                    handleSubmit(attempt.bountyId || attempt.id, data)
                  }
                  onAbandon={() =>
                    handleAbandon(attempt.bountyId || attempt.id)
                  }
                  submitting={
                    submittingId === (attempt.bountyId || attempt.id)
                  }
                  abandoning={
                    abandoningId === (attempt.bountyId || attempt.id)
                  }
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* ============================== CREATE TAB ============================== */}
      {bountyBoardTab === 'create' && (
        <CreateBountyForm
          tokens={tokens}
          onCreated={() => setBountyBoardTab('my-bounties')}
          onGuestBlocked={() => setGuestUpsellOpen(true)}
        />
      )}
    </RpgModal>

    <GuestUpsellModal
      open={guestUpsellOpen}
      onClose={() => setGuestUpsellOpen(false)}
      headline={BOUNTY_UPSELL.headline}
      body={BOUNTY_UPSELL.body}
      ctaLabel={BOUNTY_UPSELL.ctaLabel}
    />
    </>
  );
}
