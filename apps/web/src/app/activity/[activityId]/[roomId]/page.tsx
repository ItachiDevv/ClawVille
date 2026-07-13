'use client';

/**
 * Bumper Shells (and future activities) match page.
 *
 * Route: `/activity/[activityId]/[roomId]?shortCode=...`
 *
 * Why a separate top-level route: the open-world `<World3DCanvas>` lives
 * at `/game` and holds a long-lived WebGPU context. Mounting Bumper
 * Shells inside it would force two GPU pipeline sets to share state +
 * draw budget. Splitting onto its own route lets us instantiate a fresh
 * WebGPU context (per `Canvas key={roomId}` in `BumperShellsScene`) and
 * unmount it cleanly when the user leaves the match. Mirrors the
 * 3d-spec §3.1 invariant.
 *
 * Layout: this page rides the root `app/layout.tsx` (no `app/game/layout.tsx`
 * exists today — the game page sets its own full-bleed root). We do the
 * same — full-screen black background + scene + HUD overlay.
 */

import { useCallback, useEffect, useMemo, useState, use } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { isActivityLive, getActivityDefinition } from '@clawville/shared';
import { useAvatar } from '@/hooks/use-avatar';
import { useActivityStore, selectSelfAlive } from '@/stores/activity';
import { useActivityWs } from '@/hooks/useActivityWs';
import { useActivityInput } from '@/hooks/useActivityInput';
import BumperShellsHud from '@/components/game/bumper-shells-hud';
import ReefRaceHud from '@/components/game/reef-race-hud';
import ActivityMobileControls from '@/components/game/activity-mobile-controls';
import LobbyLanding, {
  type LobbySnapshot,
} from '@/components/game/lobby-landing';
import { primeActivitySounds, preloadActivitySounds } from '@/lib/activity-audio';
import type { SpectatorCamMode } from '@/components/game/activity';

// 3da-owned scenes — dynamic-imported so WebGPU context only initializes
// after the page mounts (avoids bundling Three.js WebGPU into the entry
// chunk of every other route).
const BumperShellsScene = dynamic(
  () => import('@/lib/three/activities/bumper-shells/BumperShellsScene'),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0A1628',
          color: '#00E5FF',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          letterSpacing: '0.2em',
          fontSize: 12,
        }}
      >
        ENTERING ARENA…
      </div>
    ),
  },
);

const ReefRaceScene = dynamic(
  () => import('@/lib/three/activities/reef-race/ReefRaceScene'),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#061020',
          color: '#00E5FF',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          letterSpacing: '0.2em',
          fontSize: 12,
        }}
      >
        ENTERING REEF RACE…
      </div>
    ),
  },
);

// ─── Page params (Next 15+ requires unwrapping with React.use()) ────────────

interface ActivityRouteParams {
  activityId: string;
  roomId: string;
}

interface ActivityPageProps {
  params: Promise<ActivityRouteParams>;
}

export default function ActivityRoomPage({ params }: ActivityPageProps) {
  // Next.js 15+ async params — use React.use() inside a Client Component.
  const { activityId, roomId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();

  const [shortCode, setShortCode] = useState<string | null>(
    searchParams?.get('shortCode') ?? null,
  );
  const [shortCodeError, setShortCodeError] = useState<string | null>(null);

  // Wager-lobby gate. The 3D scene only mounts once `lobbyState === 'in-game'`.
  // Default is `in-lobby` so <LobbyLanding> renders first and the user must
  // either create / join / pay before the scene boots. The `?invite=...`
  // URL param feeds the lobby's invite_code so a friend link skips the form.
  // See apps/web/src/components/game/lobby-landing.tsx for full state graph.
  //
  // v2 spline Reef Race is a matchmaking activity (activity-ws-hub room), NOT
  // a wager lobby: the server room auto-starts its countdown the moment the
  // matchmaker creates it (activity-room-manager.createRoom → PENDING→COUNTDOWN),
  // independent of any wager lobby. So when the spline build is on we must NOT
  // interpose the legacy `<LobbyLanding>` create/join/SOL-wager screen — the
  // client should mount the race scene immediately and connect to the already
  // counting-down room. Flag OFF (and every other activity, incl. bumper-shells)
  // keeps the exact production wager-lobby gate. The v1 wager flow is untouched.
  const useSplineReef =
    activityId === 'reef-race' &&
    process.env.NEXT_PUBLIC_REEF_RACE_USE_SPLINE === 'true';
  type LobbyGate = 'in-lobby' | 'in-game' | 'cancelled';
  const [lobbyGate, setLobbyGate] = useState<LobbyGate>(
    useSplineReef ? 'in-game' : 'in-lobby',
  );
  const inviteCodeFromUrl = searchParams?.get('invite') ?? null;

  const handleLobbyLocked = useCallback((lobby: LobbySnapshot) => {
    void lobby;
    setLobbyGate('in-game');
  }, []);
  const handleLobbyCancelled = useCallback(
    (lobby: LobbySnapshot) => {
      void lobby;
      setLobbyGate('cancelled');
      router.push('/game');
    },
    [router],
  );

  const { data: avatar, isLoading: avatarLoading } = useAvatar();
  const avatarId = avatar?.id ?? null;

  // Reset store on mount and whenever roomId changes (room teardown safety).
  useEffect(() => {
    useActivityStore.getState().reset(roomId);
    if (avatarId) useActivityStore.getState().setSelfAvatarId(avatarId);
    return () => {
      useActivityStore.getState().reset(null);
    };
  }, [roomId, avatarId]);

  // Push selfAvatarId into the store the moment we know it (might land after
  // the WS opens; the store re-renders the scene then for self-highlight).
  useEffect(() => {
    if (avatarId) useActivityStore.getState().setSelfAvatarId(avatarId);
  }, [avatarId]);

  // If the lobby didn't pass shortCode, fetch room state to recover it.
  // This also acts as the participant gate — `/state` returns 403 if the
  // avatar isn't in `room.participants`.
  useEffect(() => {
    if (shortCode || !avatarId || !activityId || !roomId) return;
    let aborted = false;
    (async () => {
      try {
        const apiBase = process.env.NEXT_PUBLIC_API_URL || '';
        const res = await fetch(`${apiBase}/api/activities/${activityId}/rooms/${roomId}/state`, {
          credentials: 'include',
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          if (!aborted) setShortCodeError(err?.error || `HTTP ${res.status}`);
          return;
        }
        const json = (await res.json()) as { room: { shortCode: string } };
        if (!aborted) setShortCode(json.room.shortCode);
      } catch (err) {
        if (!aborted)
          setShortCodeError(err instanceof Error ? err.message : 'Failed to fetch room state');
      }
    })();
    return () => {
      aborted = true;
    };
  }, [shortCode, avatarId, activityId, roomId]);

  // Activity gate — bumper-shells and reef-race are wired.
  const activityIsLive = useMemo(() => isActivityLive(activityId), [activityId]);
  const activityDef = useMemo(() => getActivityDefinition(activityId), [activityId]);

  const isSupportedActivity = activityId === 'bumper-shells' || activityId === 'reef-race';

  // Open WS as soon as we have everything.
  const wsEnabled = !!avatarId && !!shortCode && activityIsLive && isSupportedActivity;
  const { send, ping, status } = useActivityWs({
    activityId,
    roomId,
    shortCode: shortCode ?? '',
    enabled: wsEnabled,
  });

  // Gate input: only when scene is in play AND self is alive AND WS is open.
  const matchPhase = useActivityStore((s) => s.matchPhase);
  const selfAlive = useActivityStore(selectSelfAlive);
  const inputEnabled =
    wsEnabled && status === 'connected' && matchPhase === 'live' && selfAlive;

  useActivityInput({ send, enabled: inputEnabled });

  // ── Chunk #12 — spectator camera state lifted from HUD to page ─────────
  // The HUD owns the *picker* + *target cycle*; the page owns the *scene
  // prop bridge*. We only feed the props to the scene when the player is
  // actually spectating (selfAlive === false during a live match), so
  // active players keep the static OrthographicCamera (Iris Xe perf
  // invariant — see BumperShellsScene.tsx §31).
  const [spectatorCamMode, setSpectatorCamMode] =
    useState<SpectatorCamMode>('action');
  const [spectatorTargetAvatarId, setSpectatorTargetAvatarId] = useState<string | null>(
    null,
  );
  const handleSpectatorStateChange = useCallback(
    (next: { camMode: SpectatorCamMode; targetAvatarId: string | null }) => {
      setSpectatorCamMode(next.camMode);
      setSpectatorTargetAvatarId(next.targetAvatarId);
    },
    [],
  );
  const isSpectating = matchPhase === 'live' && !selfAlive;
  const sceneSpectatorCamMode = isSpectating ? spectatorCamMode : undefined;
  const sceneSpectatorTargetAvatarId = isSpectating ? spectatorTargetAvatarId : null;

  // ── Chunk #12 — prime SFX bus on first user interaction ────────────────
  // The route mount itself isn't a user gesture, so AudioContext.resume()
  // would be denied. We prime on the first pointer/key event instead.
  useEffect(() => {
    function unlock() {
      primeActivitySounds();
      preloadActivitySounds();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    }
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
  }, []);

  // Surface ping into local state already — no extra wiring needed
  // (BumperShellsHud reads from the store).
  void ping;

  // Chunk #11 — wire spectator chat + emote sends to the WS hook. The HUD
  // owns the rate-limit + local-echo; we just bridge the frame to the wire.
  const handleSendChat = useCallback(
    (text: string, opts: { spectator: boolean }): boolean => {
      return send({ type: 'chat', text, spectator: opts.spectator });
    },
    [send],
  );

  const handleSendEmote = useCallback(
    (emoteId: string, opts: { spectator: boolean }): boolean => {
      return send({ type: 'emote', emoteId, spectator: opts.spectator });
    },
    [send],
  );

  function handleLeave() {
    // Best-effort `leave` frame goes out via the WS hook's unmount cleanup.
    router.push('/game');
  }

  /**
   * Chunk #9 — Play Again. Until chunk #8 ships the full lobby, deep-link
   * back to /game with `?quickQueue=bumper-shells`. The sidebar reads that
   * param and auto-fires its existing Quick Queue button (one-shot — strips
   * the param after firing).
   */
  function handlePlayAgain() {
    router.push('/game?quickQueue=bumper-shells');
  }

  // ── Render ────────────────────────────────────────────────────────────

  if (avatarLoading) {
    return <FullScreenStatus message="LOADING AVATAR…" tone="neutral" />;
  }

  if (!avatar) {
    return (
      <FullScreenStatus
        message="No avatar found — return to ClawVille and create one"
        tone="warning"
        action={{ label: 'BACK TO LOBBY', onClick: () => router.push('/game') }}
      />
    );
  }

  if (!activityIsLive || !activityDef) {
    return (
      <FullScreenStatus
        message={`Activity "${activityId}" is not live yet`}
        tone="warning"
        action={{ label: 'BACK TO LOBBY', onClick: () => router.push('/game') }}
      />
    );
  }

  if (!isSupportedActivity) {
    return (
      <FullScreenStatus
        message={`${activityDef.title} ships in a later chunk`}
        tone="warning"
        action={{ label: 'BACK TO LOBBY', onClick: () => router.push('/game') }}
      />
    );
  }

  if (shortCodeError) {
    return (
      <FullScreenStatus
        message={`Couldn't load room: ${shortCodeError}`}
        tone="danger"
        action={{ label: 'BACK TO LOBBY', onClick: () => router.push('/game') }}
      />
    );
  }

  if (!shortCode) {
    return <FullScreenStatus message="RESOLVING ROOM…" tone="neutral" />;
  }

  // Wager-lobby gate — render <LobbyLanding> first. Until the user creates
  // / joins / locks a lobby, the 3D scene stays unmounted to keep the WebGPU
  // context off and the pipeline-compile cost deferred.
  if (lobbyGate !== 'in-game') {
    const accent = activityId === 'reef-race' ? '#7CFFCB' : '#00E5FF';
    return (
      <LobbyLanding
        activityId={activityId}
        roomId={roomId}
        inviteCode={inviteCodeFromUrl}
        onLobbyLocked={handleLobbyLocked}
        onLobbyCancelled={handleLobbyCancelled}
        activityTitle={activityDef.title}
        activityAccentColor={accent}
      />
    );
  }

  // Reef Race
  if (activityId === 'reef-race') {
    return (
      <main
        style={{
          position: 'fixed',
          inset: 0,
          background: '#061020',
          overflow: 'hidden',
        }}
      >
        <div style={{ position: 'absolute', inset: 0 }}>
          <ReefRaceScene roomId={roomId} selfAvatarId={avatarId} />
        </div>
        <ReefRaceHud
          onLeave={handleLeave}
          onPlayAgain={() => router.push('/game?quickQueue=reef-race')}
          activityId={activityId}
          roomId={roomId}
        />
        {/* Mobile A (boost) + B (power-up) thumb buttons — same component
            Bumper Shells uses; reef-race input also uses dir + actionBits. */}
        <ActivityMobileControls active={inputEnabled} />
      </main>
    );
  }

  // Bumper Shells (default)
  return (
    <main
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0A1628',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        <BumperShellsScene
          roomId={roomId}
          selfAvatarId={avatarId}
          spectatorCamMode={sceneSpectatorCamMode}
          spectatorTargetAvatarId={sceneSpectatorTargetAvatarId}
        />
      </div>
      <BumperShellsHud
        onLeave={handleLeave}
        onPlayAgain={handlePlayAgain}
        activityId={activityId}
        roomId={roomId}
        sendChat={handleSendChat}
        sendEmote={handleSendEmote}
        onSpectatorStateChange={handleSpectatorStateChange}
      />
      {/* Chunk #12 — mobile A (boost) + B (power-up) thumb buttons.
          Only renders on touch devices; replaces the open-world E button
          while we're on the activity route. */}
      <ActivityMobileControls active={inputEnabled} />
    </main>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function FullScreenStatus({
  message,
  tone = 'neutral',
  action,
}: {
  message: string;
  tone?: 'neutral' | 'warning' | 'danger';
  action?: { label: string; onClick: () => void };
}) {
  const accent =
    tone === 'danger' ? '#fca5a5' : tone === 'warning' ? '#fde68a' : '#00E5FF';
  return (
    <main
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0A1628',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        color: accent,
        fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        letterSpacing: '0.16em',
        fontSize: 14,
        textShadow: `0 0 12px ${accent}`,
      }}
    >
      <div>{message}</div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={{
            padding: '10px 24px',
            background: 'transparent',
            border: `1px solid ${accent}`,
            borderRadius: 6,
            color: accent,
            fontFamily: 'inherit',
            fontWeight: 700,
            letterSpacing: '0.12em',
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          {action.label}
        </button>
      )}
    </main>
  );
}
