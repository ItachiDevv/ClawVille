'use client';

/**
 * ActivityLobbyModal — chunk #8 of Q2 Activity Portals.
 *
 * Three sub-states sharing one RpgModal shell:
 *
 *   idle    → activity hero, queue counts, party slots, top-weekly preview,
 *             "Queue Solo" / "Queue with Party" CTAs, focus banner
 *   queuing → big spinner, "you are #N", players-in-queue list, "Leave Queue"
 *   matched → transient — sets store.activeActivityRoomId via navigation; we
 *             route to /activity/:activityId/:roomId immediately
 *
 * Polling cadence (frontend-spec §2.2 / §2.3):
 *   - idle:    poll /queue-status every 5s for live counts
 *   - queuing: poll /queue-status every 2s for matchedRoomId
 *
 * Party UI is rendered with 4 slots (locked Q2 cap = MAX_PARTY_SIZE on
 * the server). Slot 1 is self; slots 2–4 are invite stubs (Friend +
 * Agent variants — both gated as "Coming Soon" for chunk #8 because
 * the server endpoints aren't lit up yet — see InviteSearchPopover).
 *
 * Spec: `.claude/plans/q2-research/frontend-spec.md` §2.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  ACTIVITY_REGISTRY,
  type ActivityDefinition,
} from '@clawville/shared';
import { ensureGuestAvatar } from '@/lib/guest-bootstrap';
import {
  RpgModal,
  RpgButton,
  RuneSpinner,
  StatusChip,
} from '@/components/rpg';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import ActivityThumbnail from '@/components/game/activity/ActivityThumbnail';
import QueueStatusBar from '@/components/game/activity/QueueStatusBar';
import PartySlot, {
  type PartySlotMember,
} from '@/components/game/activity/PartySlot';
import InviteSearchPopover, {
  type InviteFilter,
} from '@/components/game/activity/InviteSearchPopover';
import ActivityTutorialCard, {
  shouldShowActivityTutorial,
  type ActivityTutorialActivityId,
} from '@/components/game/activity/ActivityTutorialCard';
import ReefRaceInstructions from '@/components/game/reef-race-instructions';
import {
  preloadActivitySounds,
  primeActivitySounds,
} from '@/lib/activity-audio';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';
/** Locked Q2 decision — mirrors `MAX_PARTY_SIZE = 4` on the server. */
const PARTY_CAP = 4;
const POLL_IDLE_MS = 5000;
const POLL_QUEUEING_MS = 2000;

type LobbyPhase = 'idle' | 'queuing';

// ─── Server response shapes (kept narrow — lobby only needs these fields) ───

interface QueueStatusResponse {
  inQueue?: number;
  position?: number;
  estimatedWaitSec?: number | null;
  roomsActive?: number;
  matchedRoomId?: string | null;
  matchedRoomShortCode?: string | null;
}

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

// ─── Hook: poll /queue-status with adaptive cadence ─────────────────────────

function useQueueStatus(activityId: string | null, phase: LobbyPhase) {
  const [status, setStatus] = useState<QueueStatusResponse>({});
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    if (!activityId) return;
    aliveRef.current = true;
    const interval = phase === 'queuing' ? POLL_QUEUEING_MS : POLL_IDLE_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/api/activities/${encodeURIComponent(activityId)}/queue-status`,
          { credentials: 'include' },
        );
        if (!aliveRef.current) return;
        if (!res.ok) {
          // 401 / 403 — stay quiet; user just needs auth. Other errors
          // surface to the UI banner.
          if (res.status >= 500) {
            setError(`HTTP ${res.status}`);
          }
        } else {
          const data = (await res.json()) as QueueStatusResponse;
          if (aliveRef.current) {
            setStatus(data);
            setError(null);
          }
        }
      } catch (e) {
        if (aliveRef.current) {
          setError(e instanceof Error ? e.message : 'fetch failed');
        }
      }
      if (aliveRef.current) {
        timer = setTimeout(tick, interval);
      }
    };
    tick();
    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [activityId, phase]);

  return { status, error };
}

// ─── Hook: top-weekly leaderboard preview (top 3) ───────────────────────────

function useTopWeekly(activityId: string | null) {
  const [rows, setRows] = useState<LeaderboardEntry[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!activityId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/api/activities/${encodeURIComponent(activityId)}/leaderboard?window=weekly&limit=3`,
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
  }, [activityId]);
  return { rows, loaded };
}

// ─── Section: top-weekly mini leaderboard ───────────────────────────────────

function TopWeeklyPreview({ activityId }: { activityId: string }) {
  const { rows, loaded } = useTopWeekly(activityId);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
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
        Top This Week
      </div>
      {!loaded && (
        <div style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 11 }}>
          Loading…
        </div>
      )}
      {loaded && rows && rows.length === 0 && (
        <div
          style={{
            color: 'rgba(148, 163, 184, 0.7)',
            fontSize: 11,
            fontStyle: 'italic',
          }}
        >
          No matches logged this week — be the first.
        </div>
      )}
      {loaded &&
        rows &&
        rows.map((r) => {
          const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : '🥉';
          return (
            <div
              key={r.avatarId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
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
                {r.displayName}
              </span>
              <span
                style={{
                  color: 'rgba(148, 163, 184, 0.85)',
                  fontFamily: 'var(--font-space-mono, monospace)',
                  fontSize: 11,
                }}
              >
                {r.wins} {r.wins === 1 ? 'win' : 'wins'}
              </span>
            </div>
          );
        })}
    </div>
  );
}

// ─── Idle body ──────────────────────────────────────────────────────────────

function IdleBody({
  activity,
  selfMember,
  onQueue,
  queueing,
  status,
}: {
  activity: ActivityDefinition;
  selfMember: PartySlotMember | null;
  onQueue: () => void;
  queueing: boolean;
  status: QueueStatusResponse;
}) {
  const [openInvite, setOpenInvite] = useState<InviteFilter | null>(null);
  // Tutorial card visibility — initialised once per mount so a re-render
  // (after dismiss) doesn't immediately re-show the card.
  const [showTutorial, setShowTutorial] = useState(false);
  useEffect(() => {
    setShowTutorial(shouldShowActivityTutorial(activity.id));
  }, [activity.id]);
  const partySize = selfMember ? 1 : 0;
  const playerRange =
    activity.minPlayers === activity.maxPlayers
      ? `${activity.minPlayers} players`
      : `${activity.minPlayers}–${activity.maxPlayers} players`;

  // Only the two live activities have copy; future activities can be added
  // by extending COPY in ActivityTutorialCard.tsx + the union type below.
  const tutorialId: ActivityTutorialActivityId | null =
    activity.id === 'bumper-shells' || activity.id === 'reef-race'
      ? activity.id
      : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {showTutorial && tutorialId && (
        <ActivityTutorialCard
          activityId={tutorialId}
          onDismiss={() => setShowTutorial(false)}
        />
      )}

      <ActivityThumbnail activity={activity} size="lg" showTitleOverlay />

      <div
        style={{
          color: 'rgba(226, 242, 252, 0.92)',
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {activity.tagline}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          color: 'rgba(148, 163, 184, 0.85)',
          fontSize: 12,
        }}
      >
        <span>⏱ {activity.roundSeconds}s rounds</span>
        <span>·</span>
        <span>{playerRange}</span>
        <span>·</span>
        <span>Match starts at {activity.minPlayers}</span>
      </div>

      <QueueStatusBar
        inQueue={status.inQueue ?? 0}
        estimatedSec={status.estimatedWaitSec ?? null}
        roomsActive={status.roomsActive ?? 0}
      />

      {/* Party panel */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 12,
          background: 'rgba(15, 31, 58, 0.5)',
          border: '1px solid rgba(56, 189, 248, 0.18)',
          borderRadius: 6,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div
            style={{
              color: 'rgba(125, 211, 252, 0.85)',
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
            }}
          >
            Party ({partySize}/{PARTY_CAP})
          </div>
          <StatusChip
            tone="neutral"
            size="sm"
            label="Solo or up to 4"
          />
        </div>

        {/* Slot 1 — self (or sign-in CTA when there's no avatar) */}
        <PartySlot
          member={selfMember ?? undefined}
          ctaLabel="Sign in to join a party"
          ctaDisabled
          ctaDisabledReason="Connect an avatar first"
        />

        {/* Slots 2..PARTY_CAP — Friend + Agent invite stubs.
            Wire each invite to a popover anchor (same row, right-aligned). */}
        {Array.from({ length: PARTY_CAP - 1 }).map((_, i) => {
          // Stagger Friend / Agent — slot 2 = Friend, slot 3 = Agent, slot 4 = Friend
          const filter: InviteFilter = i === 1 ? 'agents' : 'avatars';
          const label =
            filter === 'agents' ? '+ Invite Agent' : '+ Invite Friend';
          return (
            <div key={i} style={{ position: 'relative' }}>
              <PartySlot
                ctaLabel={label}
                onClick={() => setOpenInvite(filter)}
              />
              {openInvite === filter && (
                <InviteSearchPopover
                  filter={filter}
                  onClose={() => setOpenInvite(null)}
                />
              )}
            </div>
          );
        })}
      </div>

      <TopWeeklyPreview activityId={activity.id} />

      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <RpgButton
          variant="primary"
          loading={queueing}
          onClick={onQueue}
          disabled={!selfMember}
        >
          Queue Solo
        </RpgButton>
        <RpgButton
          variant="secondary"
          disabled
          title="Party invites ship after the friends panel"
        >
          Queue with Party
        </RpgButton>
      </div>

      <div
        style={{
          color: 'rgba(148, 163, 184, 0.8)',
          fontSize: 11,
          fontStyle: 'italic',
        }}
      >
        📖 Secretly teaches: {activity.openclawSkill}
      </div>
    </div>
  );
}

// ─── Queuing body ───────────────────────────────────────────────────────────

function QueuingBody({
  activity,
  status,
  onLeave,
  selfMember,
}: {
  activity: ActivityDefinition;
  status: QueueStatusResponse;
  onLeave: () => void;
  selfMember: PartySlotMember | null;
}) {
  const position = status.position ?? null;
  const inQueue = status.inQueue ?? 0;
  const eta = status.estimatedWaitSec ?? null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18,
        padding: '12px 0',
      }}
    >
      <RuneSpinner size={64} tier="epic" label="Searching for a match…" />

      {activity.id === 'reef-race' && (
        <ReefRaceInstructions variant="lobby" />
      )}

      <div
        style={{
          textAlign: 'center',
          color: '#e2f2fc',
          fontSize: 18,
          fontWeight: 700,
        }}
      >
        {position !== null
          ? `You are #${position} in queue`
          : 'Waiting to be slotted…'}
      </div>

      <div
        style={{
          color: 'rgba(226, 242, 252, 0.85)',
          fontSize: 13,
          textAlign: 'center',
        }}
      >
        Match starts at {activity.minPlayers} players · {inQueue} of{' '}
        {activity.minPlayers} ready
      </div>

      <div
        style={{
          color: 'rgba(148, 163, 184, 0.8)',
          fontSize: 12,
        }}
      >
        Estimated wait:{' '}
        {eta === null
          ? '—'
          : eta < 60
            ? `~${Math.max(1, Math.round(eta))}s`
            : `~${Math.floor(eta / 60)}m ${eta % 60}s`}
      </div>

      {/* Players-in-queue list — only the local player is identifiable to us;
          the rest stay anonymous (server doesn't expose roster pre-match by
          design — the lobby is queue-only, not the match). */}
      <div
        style={{
          width: '100%',
          maxWidth: 360,
          padding: 10,
          background: 'rgba(15, 31, 58, 0.55)',
          border: '1px solid rgba(56, 189, 248, 0.18)',
          borderRadius: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
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
          Players in Queue
        </div>
        {selfMember && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 6px',
              fontSize: 12,
              color: '#e2f2fc',
              background: 'rgba(56, 189, 248, 0.12)',
              borderRadius: 4,
            }}
          >
            <span aria-hidden>🦞</span>
            <span style={{ flex: 1, fontWeight: 700 }}>
              {selfMember.displayName} (you)
            </span>
            <StatusChip tone="positive" size="sm" label="Ready ✓" />
          </div>
        )}
        {Array.from({ length: Math.max(0, inQueue - (selfMember ? 1 : 0)) }).map(
          (_, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 6px',
                fontSize: 12,
                color: 'rgba(148, 163, 184, 0.85)',
              }}
            >
              <span aria-hidden>🌊</span>
              <span style={{ flex: 1, fontStyle: 'italic' }}>
                Anonymous player
              </span>
              <StatusChip tone="neutral" size="sm" label="Queued" />
            </div>
          ),
        )}
      </div>

      <RpgButton variant="danger" size="sm" onClick={onLeave}>
        Leave Queue
      </RpgButton>
    </div>
  );
}

// ─── Modal shell ────────────────────────────────────────────────────────────

export interface ActivityLobbyModalProps {
  /** When set, an external trigger (e.g. quickQueue deep-link) wants the
   *  lobby to auto-fire Queue Solo as soon as it mounts. The modal calls
   *  `onAutoQueueConsumed` once it has fired (idempotent guard). */
  autoQueue?: boolean;
  onAutoQueueConsumed?: () => void;
}

export default function ActivityLobbyModal({
  autoQueue = false,
  onAutoQueueConsumed,
}: ActivityLobbyModalProps = {}) {
  const router = useRouter();
  const activityLobbyId = useGameStore((s) => s.activityLobbyId);
  const closeActivityLobby = useGameStore((s) => s.closeActivityLobby);
  const addToast = useGameStore((s) => s.addToast);
  const queryClient = useQueryClient();
  const { data: avatar } = useAvatar();

  const [phase, setPhase] = useState<LobbyPhase>('idle');
  const [queueing, setQueueing] = useState(false);
  const autoQueueFiredRef = useRef(false);

  const activity: ActivityDefinition | null = useMemo(
    () =>
      activityLobbyId
        ? ACTIVITY_REGISTRY.find((a) => a.id === activityLobbyId) ?? null
        : null,
    [activityLobbyId],
  );

  // Reset phase whenever the lobby is opened on a new activity.
  useEffect(() => {
    if (activityLobbyId) {
      setPhase('idle');
      autoQueueFiredRef.current = false;
      // Best-effort preload — actual decode is deferred until the
      // AudioContext is unlocked by a user gesture (Queue Solo click).
      preloadActivitySounds();
    }
  }, [activityLobbyId]);

  const { status, error: statusError } = useQueueStatus(activityLobbyId, phase);

  // Match-found navigation — fires only while queuing.
  useEffect(() => {
    if (phase !== 'queuing') return;
    if (!activityLobbyId) return;
    if (status.matchedRoomId && status.matchedRoomShortCode) {
      const url = `/activity/${encodeURIComponent(activityLobbyId)}/${encodeURIComponent(status.matchedRoomId)}?shortCode=${encodeURIComponent(status.matchedRoomShortCode)}`;
      addToast('✨', 'Match found — entering arena!', 2500);
      // Close the lobby + clear the freeze BEFORE navigating so the
      // /activity route mounts cleanly without our modal still on top.
      closeActivityLobby();
      router.push(url);
    }
  }, [
    phase,
    activityLobbyId,
    status.matchedRoomId,
    status.matchedRoomShortCode,
    addToast,
    closeActivityLobby,
    router,
  ]);

  const handleQueue = useCallback(async () => {
    if (!activityLobbyId || queueing) return;
    // The click that triggers `handleQueue` is the AudioContext unlock
    // gesture — prime the audio bus here so SFX work in the match.
    primeActivitySounds();
    setQueueing(true);
    /**
     * Inner closure so we can retry once after a 401 → guest-bootstrap
     * flow. Returns the Response so the caller can branch on status.
     */
    const postQueue = async (): Promise<Response> =>
      fetch(
        `${API_BASE}/api/activities/${encodeURIComponent(activityLobbyId)}/queue`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
    try {
      let res = await postQueue();

      // Guest avatar auto-create — visitors who hit /queue without going
      // through NPC mode (e.g. deep-link, quick-queue) get an automatic
      // guest avatar here. This mirrors the NPC-mode bootstrap so the
      // visitor never sees the raw 401.
      if (res.status === 401) {
        const guest = await ensureGuestAvatar();
        if (guest) {
          await queryClient.invalidateQueries({ queryKey: ['avatar'] });
          if (!guest.reused && guest.user.isGuest) {
            addToast('🎮', 'Welcome! Playing as a guest — no signup needed.', 4000);
          }
          res = await postQueue();
        }
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        addToast(
          '⚠️',
          err?.message ?? err?.error ?? `Queue failed (${res.status})`,
          4500,
        );
      } else {
        addToast('🎮', 'Queued — finding match…', 2500);
        setPhase('queuing');
      }
    } catch (e) {
      addToast('⚠️', e instanceof Error ? e.message : 'Queue request failed', 4500);
    } finally {
      setQueueing(false);
    }
  }, [activityLobbyId, queueing, addToast, queryClient]);

  const handleLeaveQueue = useCallback(async () => {
    if (!activityLobbyId) return;
    try {
      await fetch(
        `${API_BASE}/api/activities/${encodeURIComponent(activityLobbyId)}/leave-queue`,
        { method: 'POST', credentials: 'include' },
      );
    } catch {
      /* best-effort */
    }
    setPhase('idle');
  }, [activityLobbyId]);

  const handleClose = useCallback(() => {
    // If the user closes the lobby while queued, fire-and-forget a
    // leave-queue so they don't ghost-occupy a slot.
    if (phase === 'queuing') {
      void handleLeaveQueue();
    }
    closeActivityLobby();
  }, [phase, handleLeaveQueue, closeActivityLobby]);

  // Auto-queue trigger from quickQueue deep-link.
  useEffect(() => {
    if (!autoQueue) return;
    if (autoQueueFiredRef.current) return;
    if (!activity || !avatar) return;
    autoQueueFiredRef.current = true;
    onAutoQueueConsumed?.();
    void handleQueue();
  }, [autoQueue, activity, avatar, handleQueue, onAutoQueueConsumed]);

  if (!activity) return null;

  const selfMember: PartySlotMember | null = avatar
    ? {
        avatarId: avatar.id,
        displayName: avatar.name || 'You',
        ready: true,
        isSelf: true,
      }
    : null;

  return (
    <RpgModal
      open
      onClose={handleClose}
      title={
        phase === 'queuing'
          ? 'QUEUEING…'
          : activity.title.toUpperCase()
      }
      subtitle={
        phase === 'queuing'
          ? `${activity.title} · waiting for opponents`
          : `Powered by ${activity.openclawSkill}`
      }
      tier="epic"
      glow="subtle"
      headerIcon={<span>{phase === 'queuing' ? '⏳' : '⚔'}</span>}
      maxWidth={680}
    >
      {statusError && (
        <div
          style={{
            marginBottom: 12,
            padding: '6px 10px',
            background: 'rgba(248, 113, 113, 0.10)',
            border: '1px solid rgba(248, 113, 113, 0.4)',
            borderRadius: 4,
            color: '#fca5a5',
            fontSize: 11,
          }}
        >
          Queue status sync error: {statusError}
        </div>
      )}
      {phase === 'idle' ? (
        <IdleBody
          activity={activity}
          selfMember={selfMember}
          onQueue={handleQueue}
          queueing={queueing}
          status={status}
        />
      ) : (
        <QueuingBody
          activity={activity}
          status={status}
          onLeave={handleLeaveQueue}
          selfMember={selfMember}
        />
      )}
    </RpgModal>
  );
}
