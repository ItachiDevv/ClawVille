'use client';

/**
 * BuildingPortalModal — the "Learn or Play?" decision modal.
 *
 * Shown when the player clicks a building that hosts at least one `live`
 * activity in `ACTIVITY_REGISTRY` (at Q2 launch: Salty Spitoon / Bumper
 * Shells, Boating School / Reef Race). Buildings without a live activity
 * skip this modal entirely — `enterBuilding()` falls through to the chat
 * path unchanged. See `apps/web/src/stores/game.ts#enterBuilding`.
 *
 * Layout (per frontend-spec §1.4):
 *
 *   ┌─ LEARN  |  PLAY ────────────┐
 *   │ chat    |  activity cards    │
 *   │         |  (top-today preview)
 *   └────────────────────────────┘
 *     bottom banner: focus-aligned bonus indicator (when activity has one)
 *
 * On mobile the two columns stack vertically (Learn first, Play second).
 *
 * The Learn card calls the existing chat-open action (currentLocation +
 * chatOpen + movementFrozen). The Play card opens the ActivityLobbyModal
 * for that activity. Coming-soon activities render greyed + disabled.
 *
 * Spec: `.claude/plans/q2-research/frontend-spec.md` §1.4.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ACTIVITY_REGISTRY,
  BUILDING_OPENCLAW_THEMES,
  NPC_DEFINITIONS,
  type ActivityDefinition,
} from '@clawville/shared';
import {
  RpgModal,
  RpgButton,
  RuneFrame,
  StatusChip,
} from '@/components/rpg';
import { useGameStore } from '@/stores/game';
import ActivityThumbnail from '@/components/game/activity/ActivityThumbnail';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

interface LeaderboardEntry {
  rank: number;
  avatarId: string;
  displayName: string;
  totalPoints: number;
  wins: number;
}

interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
}

/** Tiny top-3 preview for a single activity. 60s cache handled server-side. */
function useTopToday(activityId: string, enabled: boolean) {
  const [rows, setRows] = useState<LeaderboardEntry[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/api/activities/${encodeURIComponent(activityId)}/leaderboard?window=daily&limit=3`,
          { credentials: 'include' },
        );
        if (!res.ok) {
          if (!cancelled) {
            setRows([]);
            setLoaded(true);
          }
          return;
        }
        const data = (await res.json()) as LeaderboardResponse;
        if (!cancelled) {
          setRows(data.leaderboard.slice(0, 3));
          setLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setRows([]);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activityId, enabled]);
  return { rows, loaded };
}

function TopTodayRow({ rank, name, wins }: { rank: number; name: string; wins: number }) {
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        color: 'rgba(226, 242, 252, 0.85)',
      }}
    >
      <span aria-hidden>{medal}</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontWeight: 600,
        }}
      >
        {name}
      </span>
      <span style={{ color: 'rgba(148, 163, 184, 0.85)', fontFamily: 'var(--font-space-mono, monospace)' }}>
        {wins} {wins === 1 ? 'win' : 'wins'}
      </span>
    </div>
  );
}

// ─── Play card (one per registered activity) ────────────────────────────────

function PlayCard({
  activity,
  onPlay,
}: {
  activity: ActivityDefinition;
  onPlay: (activityId: string) => void;
}) {
  const isLive = activity.status === 'live';
  const { rows, loaded } = useTopToday(activity.id, isLive);

  const playerRange =
    activity.minPlayers === activity.maxPlayers
      ? `${activity.minPlayers} players`
      : `${activity.minPlayers}–${activity.maxPlayers} players`;

  return (
    <RuneFrame
      tier={isLive ? 'rare' : 'common'}
      glow={isLive ? 'subtle' : false}
      style={{
        flex: '1 1 0',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: 16,
        gap: 12,
        opacity: isLive ? 1 : 0.72,
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
            color: '#facc15',
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
          }}
        >
          ⚔ Play
        </div>
        {!isLive && <StatusChip tone="warning" size="sm" label="Coming Soon" />}
      </div>

      <ActivityThumbnail activity={activity} size="sm" showTitleOverlay />

      <div
        style={{
          color: 'rgba(226, 242, 252, 0.9)',
          fontSize: 13,
          lineHeight: 1.45,
        }}
      >
        {activity.tagline}
      </div>
      <div
        style={{
          color: 'rgba(148, 163, 184, 0.85)',
          fontSize: 11,
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span>⏱ {activity.roundSeconds}s rounds</span>
        <span>·</span>
        <span>{playerRange}</span>
      </div>

      {/* Top today mini-leaderboard */}
      {isLive && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '8px 10px',
            background: 'rgba(15, 31, 58, 0.55)',
            border: '1px solid rgba(56, 189, 248, 0.18)',
            borderRadius: 6,
          }}
        >
          <div
            style={{
              color: 'rgba(125, 211, 252, 0.75)',
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
            }}
          >
            Top Today
          </div>
          {loaded && rows && rows.length > 0 ? (
            rows.map((r) => (
              <TopTodayRow
                key={r.avatarId}
                rank={r.rank}
                name={r.displayName}
                wins={r.wins}
              />
            ))
          ) : (
            <div
              style={{
                color: 'rgba(148, 163, 184, 0.7)',
                fontSize: 11,
                fontStyle: 'italic',
              }}
            >
              {loaded ? 'No matches logged today — be the first.' : 'Loading…'}
            </div>
          )}
        </div>
      )}

      <div style={{ flex: 1 }} />

      <RpgButton
        variant="primary"
        disabled={!isLive}
        onClick={isLive ? () => onPlay(activity.id) : undefined}
      >
        {isLive ? 'Play Now' : 'Coming Soon'}
      </RpgButton>
    </RuneFrame>
  );
}

// ─── Learn card (always present, routes to existing chat flow) ──────────────

function LearnCard({
  characterName,
  buildingLabel,
  focus,
  onChat,
}: {
  characterName: string | null;
  buildingLabel: string;
  focus: string;
  onChat: () => void;
}) {
  return (
    <RuneFrame
      tier="uncommon"
      glow="subtle"
      style={{
        flex: '1 1 0',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: 16,
        gap: 12,
      }}
    >
      <div
        style={{
          color: '#4ade80',
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
        }}
      >
        📖 Learn
      </div>
      <div
        style={{
          color: '#e2f2fc',
          fontSize: 15,
          fontWeight: 700,
        }}
      >
        {characterName ? `Chat with ${characterName}` : `Chat at ${buildingLabel}`}
      </div>
      <div
        style={{
          color: 'rgba(226, 242, 252, 0.85)',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Study {focus.split(',').slice(0, 3).join(', ')}. Earn vCLAW per
        message.
      </div>

      <div style={{ flex: 1 }} />

      <RpgButton variant="secondary" onClick={onChat}>
        Chat
      </RpgButton>
    </RuneFrame>
  );
}

// ─── Modal shell ────────────────────────────────────────────────────────────

export default function BuildingPortalModal() {
  const currentPortalBuildingId = useGameStore((s) => s.currentPortalBuildingId);
  const closeBuildingPortal = useGameStore((s) => s.closeBuildingPortal);
  const openActivityLobby = useGameStore((s) => s.openActivityLobby);
  const nearCharacter = useGameStore((s) => s.nearCharacter);

  const activities = useMemo(
    () =>
      currentPortalBuildingId
        ? ACTIVITY_REGISTRY.filter((a) => a.buildingId === currentPortalBuildingId)
        : [],
    [currentPortalBuildingId],
  );

  if (!currentPortalBuildingId) return null;

  const theme = BUILDING_OPENCLAW_THEMES[currentPortalBuildingId];
  const buildingLabel = theme?.label ?? currentPortalBuildingId;
  const buildingCategory = theme?.category ?? '';
  const focus = theme?.focus ?? '';

  // Resolve character — prefer nearCharacter (proximity pass), fall back
  // to NPC_DEFINITIONS for the building.
  const buildingNpc = NPC_DEFINITIONS.find(
    (n) => n.buildingId === currentPortalBuildingId,
  );
  const characterName = nearCharacter ?? buildingNpc?.name ?? null;

  const liveActivities = activities.filter((a) => a.status === 'live');
  const comingSoon = activities.filter((a) => a.status === 'coming-soon');

  // Focus-aligned bonus — use the highest focusBonusPct among live
  // activities whose skillBuildingMatches include this building.
  const focusBonusPct = Math.max(
    0,
    ...liveActivities
      .filter((a) => a.skillBuildingMatches.includes(currentPortalBuildingId))
      .map((a) => a.rewardConfig?.focusBonusPct ?? 0),
  );

  const handleLearn = () => {
    // Close portal without releasing movementFrozen, then fall into the
    // chat path directly. We bypass `enterBuilding` here (which would
    // re-route us back into the portal) by writing the chat fields
    // directly.
    useGameStore.setState((s) => ({
      ...s,
      currentPortalBuildingId: null,
      currentLocation: currentPortalBuildingId,
      currentCharacter: characterName,
      chatOpen: true,
      movementFrozen: true,
    }));
  };

  const handlePlay = (activityId: string) => {
    openActivityLobby(activityId);
  };

  return (
    <RpgModal
      open
      onClose={closeBuildingPortal}
      title={buildingLabel.toUpperCase()}
      subtitle={buildingCategory || 'ClawVille Activity Portal'}
      tier="rare"
      glow="subtle"
      headerIcon={<span>🎮</span>}
      maxWidth={780}
    >
      <div
        style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        }}
      >
        <LearnCard
          characterName={characterName}
          buildingLabel={buildingLabel}
          focus={focus}
          onChat={handleLearn}
        />
        {liveActivities.map((a) => (
          <PlayCard key={a.id} activity={a} onPlay={handlePlay} />
        ))}
        {liveActivities.length === 0 &&
          comingSoon.map((a) => (
            <PlayCard key={a.id} activity={a} onPlay={handlePlay} />
          ))}
      </div>

      {/* Coming-soon stubs when there's at least one live activity */}
      {liveActivities.length > 0 && comingSoon.length > 0 && (
        <div
          style={{
            marginTop: 16,
            padding: '10px 12px',
            background: 'rgba(15, 31, 58, 0.5)',
            border: '1px dashed rgba(148, 163, 184, 0.3)',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            color: 'rgba(148, 163, 184, 0.8)',
            fontSize: 12,
          }}
        >
          <span style={{ fontWeight: 700 }}>Also coming here:</span>
          {comingSoon.map((a) => (
            <StatusChip key={a.id} tone="neutral" size="sm" label={a.title} />
          ))}
        </div>
      )}

      {/* Focus-aligned bonus banner */}
      {focusBonusPct > 0 && liveActivities.length > 0 && (
        <div
          style={{
            marginTop: 16,
            padding: '10px 14px',
            background: 'rgba(250, 204, 21, 0.10)',
            border: '1px solid rgba(250, 204, 21, 0.4)',
            borderRadius: 6,
            color: '#facc15',
            fontSize: 12,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span aria-hidden>💡</span>
          Focus-aligned with {theme?.category ?? 'this building'} — +
          {focusBonusPct}% tokens awarded here.
        </div>
      )}
    </RpgModal>
  );
}
