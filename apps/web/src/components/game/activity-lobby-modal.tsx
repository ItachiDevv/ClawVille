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
 * the server). Authenticated players create a party, share its six-character
 * short code, and the leader queues every member into the same room.
 *
 * Spec: `.claude/plans/q2-research/frontend-spec.md` §2.
 */

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { useAuthMe } from '@/hooks/use-auth-me';
import ActivityThumbnail from '@/components/game/activity/ActivityThumbnail';
import QueueStatusBar from '@/components/game/activity/QueueStatusBar';
import PartySlot, {
  type PartySlotMember,
} from '@/components/game/activity/PartySlot';
import {
  type ActivityParty,
  useParty,
} from '@/components/game/activity/use-party';
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
  playersInQueue?: number;
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

  useEffect(() => {
    if (!activityId) {
      setStatus({});
      setError(null);
      return;
    }
    const interval = phase === 'queuing' ? POLL_QUEUEING_MS : POLL_IDLE_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const controller = new AbortController();

    const tick = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/api/activities/${encodeURIComponent(activityId)}/queue-status`,
          { credentials: 'include', signal: controller.signal },
        );
        if (cancelled) return;
        if (!res.ok) {
          // 401 / 403 — stay quiet; user just needs auth. Other errors
          // surface to the UI banner.
          if (res.status >= 500) {
            setError(`HTTP ${res.status}`);
          }
        } else {
          const data = (await res.json()) as QueueStatusResponse;
          if (!cancelled) {
            setStatus(data);
            setError(null);
          }
        }
      } catch (e) {
        if (
          !cancelled &&
          !(e instanceof DOMException && e.name === 'AbortError')
        ) {
          setError(e instanceof Error ? e.message : 'fetch failed');
        }
      }
      if (!cancelled) {
        timer = setTimeout(tick, interval);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      controller.abort();
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
  party,
  partyEligible,
  partyStateReady,
  partyError,
  partyBusy,
  onCreateParty,
  onJoinParty,
  onKickMember,
  onLeaveParty,
  onQueueSolo,
  onQueueParty,
  queueing,
  status,
}: {
  activity: ActivityDefinition;
  selfMember: PartySlotMember | null;
  party: ActivityParty | null;
  partyEligible: boolean;
  partyStateReady: boolean;
  partyError: string | null;
  partyBusy: boolean;
  onCreateParty: () => Promise<ActivityParty | null>;
  onJoinParty: (shortCode: string) => Promise<ActivityParty | null>;
  onKickMember: (avatarId: string) => Promise<ActivityParty | null>;
  onLeaveParty: () => Promise<ActivityParty | null>;
  onQueueSolo: () => void;
  onQueueParty: () => void;
  queueing: boolean;
  status: QueueStatusResponse;
}) {
  const [joinCode, setJoinCode] = useState('');
  const [localPartyError, setLocalPartyError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const codeRef = useRef<HTMLSpanElement>(null);
  // Tutorial card visibility — initialised once per mount so a re-render
  // (after dismiss) doesn't immediately re-show the card.
  const [showTutorial, setShowTutorial] = useState(false);
  useEffect(() => {
    setShowTutorial(shouldShowActivityTutorial(activity.id));
  }, [activity.id]);
  const partySize = party?.members.length ?? (selfMember ? 1 : 0);
  const isLeader = !!(
    party &&
    selfMember &&
    party.leaderAvatarId === selfMember.avatarId
  );
  const partyCanQueue = !!party && partySize >= 2 && isLeader;
  const soloDisabled = !selfMember || (!!party && partySize >= 2);
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

  const copyPartyCode = async () => {
    if (!party) return;
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(party.shortCode);
      setCopyStatus('Copied!');
    } catch {
      const selection = window.getSelection();
      if (selection && codeRef.current) {
        const range = document.createRange();
        range.selectNodeContents(codeRef.current);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopyStatus('Code selected — press Ctrl+C to copy');
    }
  };

  const submitJoin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (joinCode.length !== 6) {
      setLocalPartyError('Enter the full 6-character party code');
      return;
    }
    setLocalPartyError(null);
    const joined = await onJoinParty(joinCode);
    if (joined) setJoinCode('');
  };

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
        inQueue={status.playersInQueue ?? 0}
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

        {!partyEligible ? (
          <PartySlot
            ctaLabel="Sign in to join a party"
            ctaDisabled
            ctaDisabledReason="Connect an avatar first"
          />
        ) : party ? (
          <>
            {party.members.map((member) => (
              <PartySlot
                key={member.avatarId}
                member={{
                  ...member,
                  ready: true,
                  isSelf: member.avatarId === selfMember?.avatarId,
                }}
                footer={
                  member.avatarId === party.leaderAvatarId
                    ? '👑 Party leader'
                    : undefined
                }
                onKick={
                  isLeader &&
                  !partyBusy &&
                  member.avatarId !== selfMember?.avatarId
                    ? () => void onKickMember(member.avatarId)
                    : undefined
                }
              />
            ))}
            {Array.from({ length: Math.max(0, PARTY_CAP - partySize) }).map(
              (_, index) => (
                <div key={index} style={{ opacity: 0.68 }}>
                  <PartySlot
                    ctaLabel="Share code to invite"
                    onClick={() => void copyPartyCode()}
                  />
                </div>
              ),
            )}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
                paddingTop: 4,
              }}
            >
              <div
                style={{
                  color: '#7dd3fc',
                  fontFamily: 'var(--font-space-mono, monospace)',
                  fontSize: 13,
                  fontWeight: 800,
                  letterSpacing: '0.08em',
                }}
              >
                PARTY CODE:{' '}
                <span
                  ref={codeRef}
                  style={{ userSelect: 'text', color: '#e2f2fc' }}
                >
                  {party.shortCode}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <RpgButton
                  variant="ghost"
                  size="sm"
                  onClick={() => void copyPartyCode()}
                >
                  Copy
                </RpgButton>
                <button
                  type="button"
                  disabled={partyBusy}
                  onClick={() => void onLeaveParty()}
                  style={{
                    border: 0,
                    background: 'transparent',
                    color: '#fca5a5',
                    cursor: partyBusy ? 'wait' : 'pointer',
                    fontSize: 11,
                    textDecoration: 'underline',
                  }}
                >
                  Leave Party
                </button>
              </div>
            </div>
            {copyStatus && (
              <div
                role="status"
                style={{ color: 'rgba(125, 211, 252, 0.8)', fontSize: 10 }}
              >
                {copyStatus}
              </div>
            )}
          </>
        ) : (
          <>
            <PartySlot member={selfMember ?? undefined} />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <RpgButton
                variant="secondary"
                size="sm"
                loading={partyBusy}
                disabled={!partyStateReady}
                onClick={() => void onCreateParty()}
              >
                Create Party
              </RpgButton>
              <form
                onSubmit={(event) => void submitJoin(event)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  flex: 1,
                  minWidth: 250,
                }}
              >
                <label
                  htmlFor={`party-code-${activity.id}`}
                  style={{ color: '#cbd5e1', fontSize: 11 }}
                >
                  Have a code?
                </label>
                <input
                  id={`party-code-${activity.id}`}
                  value={joinCode}
                  disabled={!partyStateReady}
                  onChange={(event) => {
                    setJoinCode(
                      event.target.value
                        .toUpperCase()
                        .replace(/[^0-9A-HJKMNP-TV-Z]/g, '')
                        .slice(0, 6),
                    );
                    setLocalPartyError(null);
                  }}
                  inputMode="text"
                  autoComplete="off"
                  minLength={6}
                  maxLength={6}
                  pattern="[0-9A-HJKMNP-TV-Z]{6}"
                  aria-label="Six-character party code"
                  placeholder="ABC123"
                  style={{
                    minWidth: 92,
                    flex: 1,
                    padding: '6px 8px',
                    borderRadius: 4,
                    border: '1px solid rgba(56, 189, 248, 0.35)',
                    background: 'rgba(10, 22, 40, 0.7)',
                    color: '#e2f2fc',
                    fontFamily: 'var(--font-space-mono, monospace)',
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                  }}
                />
                <RpgButton
                  type="submit"
                  variant="ghost"
                  size="sm"
                  disabled={!partyStateReady || joinCode.length !== 6}
                  loading={partyBusy}
                >
                  Join a party
                </RpgButton>
              </form>
            </div>
          </>
        )}
        {(localPartyError || partyError) && (
          <div role="alert" style={{ color: '#fca5a5', fontSize: 11 }}>
            {localPartyError || partyError}
          </div>
        )}
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
          onClick={onQueueSolo}
          disabled={!partyStateReady || soloDisabled}
          title={
            party && partySize >= 2
              ? 'Leave your party to queue solo'
              : undefined
          }
        >
          Queue Solo
        </RpgButton>
        <RpgButton
          variant={partyCanQueue ? 'primary' : 'secondary'}
          loading={queueing}
          onClick={onQueueParty}
          disabled={!partyStateReady || !partyCanQueue}
          title={
            party && !isLeader
              ? 'Only the party leader can start the queue'
              : party && partySize < 2
                ? 'Invite at least one member — or queue solo'
                : !party
                  ? 'Create or join a party first'
                  : undefined
          }
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
  party,
}: {
  activity: ActivityDefinition;
  status: QueueStatusResponse;
  onLeave: () => void;
  selfMember: PartySlotMember | null;
  party: ActivityParty | null;
}) {
  const position = status.position ?? null;
  const inQueue = status.playersInQueue ?? 0;
  const eta = status.estimatedWaitSec ?? null;
  const knownMembers = party?.members ?? (selfMember ? [selfMember] : []);

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

      {/* Known party members are named from /party/me. Unrelated queued
          players remain anonymous until the match exposes its roster. */}
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
        {knownMembers.map((member) => {
          const isSelf = member.avatarId === selfMember?.avatarId;
          return (
            <div
              key={member.avatarId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 6px',
                fontSize: 12,
                color: '#e2f2fc',
                background: isSelf
                  ? 'rgba(56, 189, 248, 0.12)'
                  : 'transparent',
                borderRadius: 4,
              }}
            >
              <span aria-hidden>🦞</span>
              <span style={{ flex: 1, fontWeight: isSelf ? 700 : 600 }}>
                {member.displayName}{isSelf ? ' (you)' : ''}
              </span>
              <StatusChip tone="positive" size="sm" label="Ready ✓" />
            </div>
          );
        })}
        {Array.from({ length: Math.max(0, inQueue - knownMembers.length) }).map(
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
   *  lobby to auto-fire Queue Solo immediately after mount. The modal calls
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
  const { data: authData } = useAuthMe();

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
  // Party UX is fail-closed until auth resolves. A cached guest avatar can
  // outlive the auth query briefly, and party routes accept Lucia sessions,
  // so avatar existence alone is not a sufficient non-guest check.
  const partyEligible = !!avatar && !!authData?.user && !authData.user.isGuest;
  const {
    party,
    error: partyError,
    busy: partyBusy,
    loaded: partyLoaded,
    createParty,
    joinByCode,
    kick,
    leave,
  } = useParty(partyEligible ? activityLobbyId : null);
  const authResolved = authData !== undefined;
  const partyStateReady =
    !avatar ||
    (authResolved &&
      (!partyEligible || (partyLoaded && partyError === null)));

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

  // Party members do not need to click Queue. The leader's atomic enqueue is
  // visible through each member's own status poll; matchedRoomId is included
  // because a fast match can remove the intermediate queue position first.
  useEffect(() => {
    if (phase !== 'idle' || !party) return;
    if (status.position != null || status.matchedRoomId != null) {
      setPhase('queuing');
    }
  }, [party, phase, status.matchedRoomId, status.position]);

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

  const handleQueue = useCallback(async (partyId?: string) => {
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
          body: JSON.stringify(partyId ? { partyId } : {}),
        },
      );
    try {
      let res = await postQueue();

      // Guest avatar auto-create — visitors who hit /queue without going
      // through NPC mode (e.g. deep-link, quick-queue) get an automatic
      // guest avatar here. This mirrors the NPC-mode bootstrap so the
      // visitor never sees the raw 401.
      if (res.status === 401 && !partyId) {
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
    if (avatar && !partyStateReady) return;
    autoQueueFiredRef.current = true;
    onAutoQueueConsumed?.();
    if (party && party.members.length >= 2) {
      addToast('⚠️', 'Leave your party to queue solo.', 3500);
      return;
    }
    void handleQueue();
  }, [
    autoQueue,
    activity,
    avatar,
    party,
    partyEligible,
    partyStateReady,
    handleQueue,
    onAutoQueueConsumed,
    addToast,
  ]);

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
          party={party}
          partyEligible={partyEligible}
          partyStateReady={partyStateReady}
          partyError={partyError}
          partyBusy={partyBusy}
          onCreateParty={createParty}
          onJoinParty={joinByCode}
          onKickMember={kick}
          onLeaveParty={leave}
          onQueueSolo={() => void handleQueue()}
          onQueueParty={() => {
            if (party) void handleQueue(party.id);
          }}
          queueing={queueing}
          status={status}
        />
      ) : (
        <QueuingBody
          activity={activity}
          status={status}
          onLeave={handleLeaveQueue}
          selfMember={selfMember}
          party={party}
        />
      )}
    </RpgModal>
  );
}
