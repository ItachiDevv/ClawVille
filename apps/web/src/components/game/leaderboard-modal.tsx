'use client';

/**
 * LeaderboardModal — P4's "single ClawVille-owned leaderboard that ranks
 * agents, humans, and projects" (see CLAUDE.md top priorities).
 *
 * Pulls live aggregate data from `/api/leaderboard` (composed in memory from
 * avatars + claw_token_transactions + quest_rewards + bounty_reputation) and
 * renders a tabbed board with five sort modes ('skills-sold' /
 * 'skills-authored' were removed 2026-07-02 alongside peer skill commerce —
 * see the SortMode comment below). Top-3 rows get podium styling.
 *
 * RpgModal shell, RpgButton for tab chrome, useQuery for data fetching.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { api } from '@/lib/api';
import {
  RpgModal,
  RpgButton,
  RuneSpinner,
  RuneFrame,
  StatusChip,
  type RarityId,
} from '@/components/rpg';

// ---------------------------------------------------------------------------
// Types + tab metadata
// ---------------------------------------------------------------------------

// 'skills-sold' / 'skills-authored' sort modes were removed 2026-07-02
// alongside peer skill commerce (bazaar/auctions/marketplace) — the backend
// legacy board (apps/api/src/routes/leaderboard.ts) never carried these
// fields on its own SortMode/LeaderboardEntry, so selecting either tab
// crashed this modal (`undefined.toLocaleString()` in formatMetric below).
type SortMode = 'composite' | 'gold' | 'earned' | 'quests' | 'bounties';

interface TabMeta {
  value: SortMode;
  label: string;
  icon: string;
  /** Metric key on a leaderboard entry that this tab ranks by. */
  metric: 'compositeScore' | 'gold' | 'earned' | 'questsCompleted' | 'bountiesCompleted';
  /** Unit label next to the metric value in each row. */
  unit: string;
  /** One-line explanation shown in the tab strip subtitle. */
  description: string;
}

const TABS: readonly TabMeta[] = [
  {
    value: 'composite',
    label: 'Overall',
    icon: '👑',
    metric: 'compositeScore',
    unit: 'pts',
    description: 'Weighted score across every economic activity.',
  },
  {
    value: 'gold',
    label: 'Gold',
    icon: '💰',
    metric: 'gold',
    unit: 'NT',
    description: 'Current ClawToken balance.',
  },
  {
    value: 'earned',
    label: 'Earned',
    icon: '📈',
    metric: 'earned',
    unit: 'NT',
    description: 'Lifetime ClawTokens earned (all sources).',
  },
  {
    value: 'quests',
    label: 'Quests',
    icon: '📜',
    metric: 'questsCompleted',
    unit: 'done',
    description: 'Approved quest completions.',
  },
  {
    value: 'bounties',
    label: 'Bounties',
    icon: '📌',
    metric: 'bountiesCompleted',
    unit: 'done',
    description: 'Approved bounty completions.',
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMetric(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

function rankBadge(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

function rankTier(rank: number): RarityId {
  if (rank === 1) return 'legendary';
  if (rank === 2) return 'epic';
  if (rank === 3) return 'rare';
  if (rank <= 10) return 'uncommon';
  return 'common';
}

function colorCssFromStored(color: unknown): string {
  if (typeof color === 'string') return color;
  if (typeof color === 'number') return '#' + color.toString(16).padStart(6, '0');
  return '#6ba6ff';
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function TabStrip({
  active,
  onChange,
}: {
  active: SortMode;
  onChange: (mode: SortMode) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        marginBottom: 14,
      }}
    >
      {TABS.map((tab) => (
        <RpgButton
          key={tab.value}
          size="sm"
          variant={active === tab.value ? 'primary' : 'ghost'}
          onClick={() => onChange(tab.value)}
          leadingIcon={<span>{tab.icon}</span>}
        >
          {tab.label}
        </RpgButton>
      ))}
    </div>
  );
}

function StatPill({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 8,
        background: 'rgba(15, 31, 58, 0.65)',
        border: '1px solid rgba(56, 189, 248, 0.25)',
        fontFamily: 'var(--font-orbitron, sans-serif)',
        fontSize: 11,
        letterSpacing: 1,
        textTransform: 'uppercase',
        color: 'rgba(186, 219, 255, 0.9)',
      }}
    >
      <span>{icon}</span>
      <span style={{ color: 'rgba(186, 219, 255, 0.65)' }}>{label}</span>
      <span style={{ color: '#fff', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function StatsBar() {
  const { data } = useQuery({
    queryKey: ['leaderboard-stats'],
    queryFn: () => api.getLeaderboardStats(),
    staleTime: 30_000,
  });

  if (!data) return null;

  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        flexWrap: 'wrap',
        marginBottom: 14,
      }}
    >
      <StatPill icon="🐾" label="Avatars" value={data.totalAvatars.toLocaleString()} />
      <StatPill
        icon="💰"
        label="Gold in circ"
        value={formatMetric(data.totalGold)}
      />
      <StatPill
        icon="📜"
        label="Quests"
        value={data.totalQuestsCompleted.toLocaleString()}
      />
      <StatPill
        icon="📌"
        label="Bounties"
        value={data.totalBountiesCompleted.toLocaleString()}
      />
    </div>
  );
}

interface Entry {
  rank: number;
  avatarId: string;
  avatarName: string;
  species: string;
  color: string | number | null;
  archetype: string | null;
  gold: number;
  earned: number;
  questsCompleted: number;
  bountiesCompleted: number;
  compositeScore: number;
}

function EntryRow({
  entry,
  metric,
  unit,
  highlight,
}: {
  entry: Entry;
  metric: TabMeta['metric'];
  unit: string;
  highlight?: boolean;
}) {
  const tier = rankTier(entry.rank);
  const value = entry[metric];
  const displayValue = formatMetric(value);
  const color = colorCssFromStored(entry.color);

  return (
    <RuneFrame
      tier={tier}
      glow={entry.rank <= 3 ? 'strong' : 'subtle'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '10px 14px',
        background: highlight
          ? 'linear-gradient(90deg, rgba(255, 223, 100, 0.12), transparent)'
          : undefined,
      }}
    >
      {/* Rank */}
      <div
        style={{
          flexShrink: 0,
          width: 56,
          fontFamily: 'var(--font-orbitron, sans-serif)',
          fontSize: entry.rank <= 3 ? 28 : 18,
          fontWeight: 700,
          color: entry.rank <= 3 ? '#ffde80' : '#bed9ff',
          textAlign: 'center',
        }}
      >
        {rankBadge(entry.rank)}
      </div>

      {/* Avatar color chip + name */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: color,
            border: '1px solid rgba(255, 255, 255, 0.4)',
            boxShadow: `0 0 10px ${color}`,
            flexShrink: 0,
          }}
          aria-hidden
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'var(--font-orbitron, sans-serif)',
              fontSize: 14,
              color: '#fff',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {entry.avatarName}
            {highlight && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 10,
                  color: '#ffde80',
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                }}
              >
                ← you
              </span>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 6,
              marginTop: 3,
              fontSize: 10,
              color: 'rgba(186, 219, 255, 0.65)',
              textTransform: 'uppercase',
              letterSpacing: 1,
            }}
          >
            <span>{entry.species}</span>
            {entry.archetype && (
              <>
                <span>·</span>
                <span>{entry.archetype}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Primary metric */}
      <div
        style={{
          flexShrink: 0,
          textAlign: 'right',
          minWidth: 80,
          fontFamily: 'var(--font-orbitron, sans-serif)',
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 700, color: '#ffde80' }}>{displayValue}</div>
        <div
          style={{
            fontSize: 9,
            color: 'rgba(186, 219, 255, 0.65)',
            textTransform: 'uppercase',
            letterSpacing: 1,
          }}
        >
          {unit}
        </div>
      </div>

      {/* Secondary stats — stacked, only when it adds info beyond the primary */}
      {metric !== 'gold' && (
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            minWidth: 100,
            fontSize: 10,
            color: 'rgba(186, 219, 255, 0.7)',
          }}
        >
          <div>💰 {formatMetric(entry.gold)}</div>
          <div>
            📜 {entry.questsCompleted} · 📌 {entry.bountiesCompleted}
          </div>
        </div>
      )}
    </RuneFrame>
  );
}

// ---------------------------------------------------------------------------
// Top-level modal
// ---------------------------------------------------------------------------

export default function LeaderboardModal() {
  const {
    leaderboardOpen,
    leaderboardSort,
    closeLeaderboard,
    setLeaderboardSort,
  } = useGameStore();
  const { data: myAvatar } = useAvatar();

  const tabMeta = useMemo(
    () => TABS.find((t) => t.value === leaderboardSort) ?? TABS[0],
    [leaderboardSort]
  );

  const { data, isLoading, isError } = useQuery({
    queryKey: ['leaderboard', leaderboardSort],
    queryFn: () =>
      api.getLeaderboard({ sort: leaderboardSort, limit: 100, me: true }),
    enabled: leaderboardOpen,
    staleTime: 30_000,
  });

  const entries = data?.entries ?? [];
  const me = data?.me;

  return (
    <RpgModal
      open={leaderboardOpen}
      onClose={closeLeaderboard}
      title="Leaderboard"
      subtitle="Single source of truth for every ClawVille avatar"
      tier="legendary"
      glow="strong"
      headerIcon={<span>🏆</span>}
      maxWidth={1040}
      tokenBadge={
        myAvatar ? (
          <StatusChip
            tone="warning"
            size="sm"
            label={`${myAvatar.clawTokens?.toLocaleString() ?? 0} CT`}
          />
        ) : undefined
      }
    >
      <StatsBar />

      <TabStrip
        active={leaderboardSort}
        onChange={(mode) => setLeaderboardSort(mode)}
      />

      <div
        style={{
          marginBottom: 14,
          padding: '8px 14px',
          borderRadius: 6,
          background: 'rgba(15, 31, 58, 0.45)',
          border: '1px solid rgba(56, 189, 248, 0.2)',
          fontSize: 11,
          color: 'rgba(186, 219, 255, 0.75)',
        }}
      >
        <strong style={{ color: '#ffde80' }}>{tabMeta.label}</strong> — {tabMeta.description}
      </div>

      {isLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <RuneSpinner />
        </div>
      )}

      {isError && (
        <div
          style={{
            padding: 20,
            textAlign: 'center',
            color: '#ff9a9a',
            fontSize: 12,
          }}
        >
          Failed to load leaderboard. Try reopening the panel.
        </div>
      )}

      {!isLoading && !isError && entries.length === 0 && (
        <div
          style={{
            padding: 40,
            textAlign: 'center',
            color: 'rgba(186, 219, 255, 0.6)',
            fontSize: 12,
          }}
        >
          No avatars ranked yet — be the first to earn a spot by buying, selling,
          questing, or bounty hunting.
        </div>
      )}

      {!isLoading && entries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {entries.map((entry) => (
            <EntryRow
              key={entry.avatarId}
              entry={entry}
              metric={tabMeta.metric}
              unit={tabMeta.unit}
              highlight={entry.avatarId === me?.avatarId}
            />
          ))}

          {/* "You are here" fallback row when user is outside the top N */}
          {me && !entries.some((e) => e.avatarId === me.avatarId) && (
            <>
              <div
                style={{
                  textAlign: 'center',
                  fontSize: 10,
                  color: 'rgba(186, 219, 255, 0.4)',
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  marginTop: 6,
                }}
              >
                · · ·
              </div>
              <EntryRow
                entry={{
                  ...me,
                  color: null,
                  archetype: null,
                }}
                metric={tabMeta.metric}
                unit={tabMeta.unit}
                highlight
              />
            </>
          )}
        </div>
      )}

      {data && (
        <div
          style={{
            marginTop: 16,
            fontSize: 9,
            color: 'rgba(186, 219, 255, 0.4)',
            textAlign: 'center',
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          {data.rankedCount} of {data.totalAvatars} avatars · refreshed every 30s
        </div>
      )}
    </RpgModal>
  );
}
