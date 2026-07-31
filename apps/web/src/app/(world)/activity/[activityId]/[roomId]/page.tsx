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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  use,
  type ComponentType,
  type MutableRefObject,
} from 'react';
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
import {
  ReefRaceSpeedLinesOverlay,
  ReefRaceSurgeDriver,
} from '@/lib/three/activities/reef-race/reef-race-speed-surge';
import {
  requestWorldStageNavigation,
  type WorldStageHref,
} from '@/components/three/world-stage/stage-navigation';
import {
  ACTIVITY_SCENE_ID,
  sceneIdForPathname,
} from '@/components/three/world-stage/stage-scene-id';
import { useStageStore } from '@/components/three/world-stage/stage-store';
import {
  decideActivityReadiness,
  type ActivityTerminalBranch,
} from '@/lib/three/activities/activity-readiness';
import { ActivitySceneErrorBoundary } from '@/components/three/world-stage/ActivitySceneErrorBoundary';

// 3da-owned scenes — dynamic-imported so WebGPU context only initializes
// after the page mounts (avoids bundling Three.js WebGPU into the entry
// chunk of every other route).
interface ActivityRouteParams {
  activityId: string;
  roomId: string;
}

interface ActivityPageProps {
  params: Promise<ActivityRouteParams>;
}

interface ActivitySceneProps {
  roomId: string;
  selfAvatarId?: string | null;
  roomKey: string;
  onPainted: (roomKey: string) => void;
  onCanvas: (element: HTMLCanvasElement | null) => void;
  spectatorCamMode?: SpectatorCamMode;
  spectatorTargetAvatarId?: string | null;
}

export default function ActivityRoomPage({ params }: ActivityPageProps) {
  const { activityId, roomId } = use(params);
  const leaveRef = useRef<(() => void) | null>(null);
  const [handoffAttemptNonce, setHandoffAttemptNonce] = useState(0);
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
  return (
    <div
      className="game-container"
      style={{ background: 'transparent', overflow: 'hidden' }}
    >
      <ActivityRoomRuntime
        key={`${activityId}:${roomId}`}
        activityId={activityId}
        roomId={roomId}
        leaveRef={leaveRef}
        handoffAttemptNonce={handoffAttemptNonce}
      />
      <ActivityHandoffRecovery
        leaveRef={leaveRef}
        onRetry={() => setHandoffAttemptNonce((value) => value + 1)}
      />
    </div>
  );
}

function ActivityRoomRuntime({
  activityId,
  roomId,
  leaveRef,
  handoffAttemptNonce,
}: ActivityRouteParams & {
  leaveRef: MutableRefObject<(() => void) | null>;
  handoffAttemptNonce: number;
}) {
  // Next.js 15+ async params — use React.use() inside a Client Component.
  const router = useRouter();
  const searchParams = useSearchParams();
  const navigateOut = useCallback(
    (to: WorldStageHref) => {
      const requested = requestWorldStageNavigation({
        to,
        onExpired: () => {
          if (typeof window === 'undefined') return;
          if (
            sceneIdForPathname(window.location.pathname) !==
            ACTIVITY_SCENE_ID
          ) {
            return;
          }
          router.push(to);
        },
      });
      if (!requested) router.push(to);
    },
    [router],
  );

  const [shortCode, setShortCode] = useState<string | null>(
    searchParams?.get('shortCode') ?? null,
  );
  const [shortCodeError, setShortCodeError] = useState<string | null>(null);
  const roomKey = `${activityId}:${roomId}`;
  const [paintedRoomKey, setPaintedRoomKey] = useState<string | null>(null);
  const [canvasElement, setCanvasElement] =
    useState<HTMLCanvasElement | null>(null);
  const [terminalOverride, setTerminalOverride] =
    useState<ActivityTerminalBranch | null>(null);
  const [ackedKey, setAckedKey] = useState<string | null>(null);
  const [attemptNonce, setAttemptNonce] = useState(0);
  const [sceneAttempt, setSceneAttempt] = useState(0);
  const readinessAttemptNonce = attemptNonce + handoffAttemptNonce;
  const SceneComponent = useMemo(
    () =>
      dynamic<ActivitySceneProps>(
        () => {
          const loader =
            activityId === 'reef-race'
              ? import(
                  '@/lib/three/activities/reef-race/ReefRaceScene'
                )
              : import(
                  '@/lib/three/activities/bumper-shells/BumperShellsScene'
                );
          return loader
            .then(
              (module) =>
                module.default as ComponentType<ActivitySceneProps>,
            )
            .catch((error: unknown) => {
              console.error('[activity] scene chunk failed', error);
              throw error;
            });
        },
        {
          ssr: false,
          loading: () => (
            <div className="absolute inset-0 flex items-center justify-center bg-[#061020] font-mono text-xs tracking-[0.2em] text-cyan-300">
              ENTERING ACTIVITYâ€¦
            </div>
          ),
        },
      ),
    [activityId, sceneAttempt],
  );
  const pendingGeneration = useStageStore((state) =>
    state.pendingRequest?.sceneId === ACTIVITY_SCENE_ID
      ? state.pendingRequest.generation
      : null,
  );
  const recoveryCount = useStageStore((state) => state.recovery.count);
  const targetRoomKey = useStageStore(
    (state) => state.activityTarget?.roomKey ?? null,
  );
  const handlePainted = useCallback(
    (paintedKey: string) => {
      if (paintedKey === roomKey) setPaintedRoomKey(paintedKey);
    },
    [roomKey],
  );
  const handleCanvas = useCallback(
    (element: HTMLCanvasElement | null) => setCanvasElement(element),
    [],
  );

  useEffect(() => {
    if (!canvasElement) return;
    const onContextLost = (event: Event) => {
      event.preventDefault();
      setPaintedRoomKey(null);
      setTerminalOverride('canvas-lost');
    };
    canvasElement.addEventListener('webglcontextlost', onContextLost);
    return () =>
      canvasElement.removeEventListener('webglcontextlost', onContextLost);
  }, [canvasElement]);

  useEffect(() => {
    setPaintedRoomKey(null);
    setTerminalOverride(null);
  }, [handoffAttemptNonce]);

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
      navigateOut('/game');
    },
    [navigateOut],
  );

  const { data: avatar, isLoading: avatarLoading } = useAvatar();
  const avatarId = avatar?.id ?? null;

  // Reset store on mount and whenever roomId changes (room teardown safety).
  useEffect(() => {
    useActivityStore.getState().reset(roomId);
    return () => {
      useActivityStore.getState().reset(null);
    };
  }, [roomId]);

  // Push selfAvatarId into the store the moment we know it (might land after
  // the WS opens; the store re-renders the scene then for self-highlight).
  useEffect(() => {
    if (avatarId) useActivityStore.getState().setSelfAvatarId(avatarId);
  }, [avatarId, roomId]);

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
  const { send, ping, status, leaveAndClose } = useActivityWs({
    activityId,
    roomId,
    shortCode: shortCode ?? '',
    enabled: wsEnabled,
  });

  useEffect(() => {
    leaveRef.current = leaveAndClose;
    return () => {
      if (leaveRef.current === leaveAndClose) leaveRef.current = null;
    };
  }, [leaveAndClose, leaveRef]);

  // Gate input: only when scene is in play AND self is alive AND WS is open.
  const matchPhase = useActivityStore((s) => s.matchPhase);
  const selfAlive = useActivityStore(selectSelfAlive);
  const selfWipedOut = useActivityStore((s) =>
    avatarId ? s.entities.get(avatarId)?.wipedOut === true : false,
  );
  const inputEnabled =
    wsEnabled &&
    status === 'connected' &&
    matchPhase === 'live' &&
    selfAlive &&
    !selfWipedOut;

  useActivityInput({ send, enabled: inputEnabled, activityId });

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
    navigateOut('/game');
  }

  /**
   * Chunk #9 — Play Again. Until chunk #8 ships the full lobby, deep-link
   * back to /game with `?quickQueue=bumper-shells`. The sidebar reads that
   * param and auto-fires its existing Quick Queue button (one-shot — strips
   * the param after firing).
   */
  function handlePlayAgain() {
    navigateOut('/game?quickQueue=bumper-shells');
  }

  const handleSceneTryAgain = useCallback(() => {
    setSceneAttempt((value) => value + 1);
    setAttemptNonce((value) => value + 1);
    setPaintedRoomKey(null);
    setTerminalOverride(null);
  }, []);

  let terminalBranch: ActivityTerminalBranch | null = terminalOverride;
  if (!terminalBranch) {
    if (avatarLoading) terminalBranch = 'avatar-loading';
    else if (!avatar) terminalBranch = 'no-avatar';
    else if (!activityIsLive || !activityDef) terminalBranch = 'not-live';
    else if (!isSupportedActivity) terminalBranch = 'unsupported';
    else if (shortCodeError) terminalBranch = 'room-error';
    else if (!shortCode) terminalBranch = 'resolving-room';
    else if (status === 'closed') terminalBranch = 'closed';
    else if (lobbyGate !== 'in-game') terminalBranch = 'lobby';
  }
  const terminalRoomKey = terminalBranch ? roomKey : null;

  useEffect(() => {
    const decision = decideActivityReadiness({
      roomKey,
      targetRoomKey,
      pendingGeneration,
      recoveryCount,
      attemptNonce: readinessAttemptNonce,
      paintedRoomKey,
      terminalBranch,
      terminalRoomKey,
      ackedKey,
    });
    if (
      process.env.NEXT_PUBLIC_ENABLE_STAGE_PROBE === '1' &&
      typeof window !== 'undefined'
    ) {
      const probeWindow = window as typeof window & {
        __ACTIVITY_READINESS_PROBE__?: Array<{
          at: number;
          roomKey: string;
          targetRoomKey: string | null;
          pendingGeneration: number | null;
          decision: typeof decision;
        }>;
      };
      const log =
        probeWindow.__ACTIVITY_READINESS_PROBE__ ??
        (probeWindow.__ACTIVITY_READINESS_PROBE__ = []);
      log.push({
        at: performance.now(),
        roomKey,
        targetRoomKey,
        pendingGeneration,
        decision,
      });
      if (log.length > 200) log.splice(0, log.length - 200);
    }
    if (decision.kind !== 'ACK') return;
    setAckedKey(decision.ackKey);
    useStageStore
      .getState()
      .ackReady(ACTIVITY_SCENE_ID, decision.generation);
  }, [
    ackedKey,
    readinessAttemptNonce,
    paintedRoomKey,
    pendingGeneration,
    recoveryCount,
    roomKey,
    targetRoomKey,
    terminalBranch,
    terminalRoomKey,
  ]);

  // ── Render ────────────────────────────────────────────────────────────

  if (terminalOverride === 'canvas-lost') {
    return (
      <FullScreenStatus
        message="ACTIVITY CANVAS LOST"
        tone="danger"
        action={{ label: 'TRY AGAIN', onClick: handleSceneTryAgain }}
      />
    );
  }

  if (avatarLoading) {
    return <FullScreenStatus message="LOADING AVATAR…" tone="neutral" />;
  }

  if (!avatar) {
    return (
      <FullScreenStatus
        message="No avatar found — return to ClawVille and create one"
        tone="warning"
        action={{ label: 'BACK TO LOBBY', onClick: () => navigateOut('/game') }}
      />
    );
  }

  if (!activityIsLive || !activityDef) {
    return (
      <FullScreenStatus
        message={`Activity "${activityId}" is not live yet`}
        tone="warning"
        action={{ label: 'BACK TO LOBBY', onClick: () => navigateOut('/game') }}
      />
    );
  }

  if (!isSupportedActivity) {
    return (
      <FullScreenStatus
        message={`${activityDef.title} ships in a later chunk`}
        tone="warning"
        action={{ label: 'BACK TO LOBBY', onClick: () => navigateOut('/game') }}
      />
    );
  }

  if (shortCodeError) {
    return (
      <FullScreenStatus
        message={`Couldn't load room: ${shortCodeError}`}
        tone="danger"
        action={{ label: 'BACK TO LOBBY', onClick: () => navigateOut('/game') }}
      />
    );
  }

  if (!shortCode) {
    return <FullScreenStatus message="RESOLVING ROOM…" tone="neutral" />;
  }

  if (status === 'closed') {
    return (
      <FullScreenStatus
        message="MATCH EXPIRED — THIS ROOM IS NO LONGER AVAILABLE"
        tone="danger"
        action={{
          label: 'REQUEUE',
          onClick: () =>
            navigateOut(
              `/game?quickQueue=${encodeURIComponent(activityId)}` as WorldStageHref,
            ),
        }}
      />
    );
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
          position: 'absolute',
          inset: 0,
          background: 'transparent',
          overflow: 'hidden',
        }}
      >
        <div style={{ position: 'absolute', inset: 0 }}>
          <ActivitySceneErrorBoundary
            resetKey={`${roomKey}:${sceneAttempt}`}
            onFailed={setTerminalOverride}
            onTryAgain={handleSceneTryAgain}
            onReload={() => window.location.reload()}
          >
            <SceneComponent
              key={sceneAttempt}
              roomId={roomId}
              selfAvatarId={avatarId}
              roomKey={roomKey}
              onPainted={handlePainted}
              onCanvas={handleCanvas}
            />
          </ActivitySceneErrorBoundary>
        </div>
        <ReefRaceSurgeDriver roomId={roomId} />
        <ReefRaceSpeedLinesOverlay />
        <ReefRaceHud
          onLeave={handleLeave}
          onPlayAgain={() => navigateOut('/game?quickQueue=reef-race')}
          activityId={activityId}
          roomId={roomId}
        />
        {/* Shared mobile A/B thumb buttons. Reef maps A=jump/B=item;
            Bumper preserves A=boost/B=power-up. */}
        <ActivityMobileControls active={inputEnabled} activityId={activityId} />
      </main>
    );
  }

  // Bumper Shells (default)
  return (
    <main
      style={{
        position: 'absolute',
        inset: 0,
        background: 'transparent',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        <ActivitySceneErrorBoundary
          resetKey={`${roomKey}:${sceneAttempt}`}
          onFailed={setTerminalOverride}
          onTryAgain={handleSceneTryAgain}
          onReload={() => window.location.reload()}
        >
          <SceneComponent
            key={sceneAttempt}
            roomId={roomId}
            selfAvatarId={avatarId}
            spectatorCamMode={sceneSpectatorCamMode}
            spectatorTargetAvatarId={sceneSpectatorTargetAvatarId}
            roomKey={roomKey}
            onPainted={handlePainted}
            onCanvas={handleCanvas}
          />
        </ActivitySceneErrorBoundary>
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
      {/* Chunk #12 — activity-specific mobile A/B actions. Only renders on
          touch devices; replaces the open-world E button on this route. */}
      <ActivityMobileControls active={inputEnabled} activityId={activityId} />
    </main>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ActivityHandoffRecovery({
  leaveRef,
  onRetry,
}: {
  leaveRef: MutableRefObject<(() => void) | null>;
  onRetry: () => void;
}) {
  const outgoingOverlay = useStageStore((state) => state.outgoingOverlay);
  if (!outgoingOverlay || outgoingOverlay.status !== 'timed-out') return null;
  return (
    <div className="pointer-events-auto absolute inset-0 z-[10000] flex items-center justify-center bg-black/80 p-6">
      <div className="max-w-lg rounded-xl border border-cyan-300/60 bg-[#07131d] p-6 text-center font-mono text-cyan-100">
        <p className="mb-5">
          The route change is taking longer than expected. Your match is still
          running behind this cover.
        </p>
        <button
          type="button"
          onClick={() => {
            leaveRef.current?.();
            window.location.assign(outgoingOverlay.href);
          }}
        >
          Hard navigate
        </button>
        <button
          type="button"
          onClick={() => {
            onRetry();
            requestWorldStageNavigation({
              to: outgoingOverlay.href as WorldStageHref,
            });
          }}
        >
          Retry navigation
        </button>
      </div>
    </div>
  );
}

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
