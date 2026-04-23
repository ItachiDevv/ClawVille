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

import { useEffect, useMemo, useState, use } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { isActivityLive, getActivityDefinition } from '@clawville/shared';
import { usePet } from '@/hooks/use-pet';
import { useActivityStore, selectSelfAlive } from '@/stores/activity';
import { useActivityWs } from '@/hooks/useActivityWs';
import { useActivityInput } from '@/hooks/useActivityInput';
import BumperShellsHud from '@/components/game/bumper-shells-hud';

// 3da-owned scene — dynamic-imported so the WebGPU context only initializes
// after the page mounts (avoids bundling Three.js WebGPU into the entry chunk
// of every other route).
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

  const { data: pet, isLoading: petLoading } = usePet();
  const petId = pet?.id ?? null;

  // Reset store on mount and whenever roomId changes (room teardown safety).
  useEffect(() => {
    useActivityStore.getState().reset(roomId);
    if (petId) useActivityStore.getState().setSelfPetId(petId);
    return () => {
      useActivityStore.getState().reset(null);
    };
  }, [roomId, petId]);

  // Push selfPetId into the store the moment we know it (might land after
  // the WS opens; the store re-renders the scene then for self-highlight).
  useEffect(() => {
    if (petId) useActivityStore.getState().setSelfPetId(petId);
  }, [petId]);

  // If the lobby didn't pass shortCode, fetch room state to recover it.
  // This also acts as the participant gate — `/state` returns 403 if the
  // pet isn't in `room.participants`.
  useEffect(() => {
    if (shortCode || !petId || !activityId || !roomId) return;
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
  }, [shortCode, petId, activityId, roomId]);

  // Activity gate — only `bumper-shells` is wired this chunk.
  const activityIsLive = useMemo(() => isActivityLive(activityId), [activityId]);
  const activityDef = useMemo(() => getActivityDefinition(activityId), [activityId]);

  // Open WS as soon as we have everything.
  const wsEnabled = !!petId && !!shortCode && activityIsLive && activityId === 'bumper-shells';
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

  // Surface ping into local state already — no extra wiring needed
  // (BumperShellsHud reads from the store).
  void ping;

  function handleLeave() {
    // Best-effort `leave` frame goes out via the WS hook's unmount cleanup.
    router.push('/game');
  }

  // ── Render ────────────────────────────────────────────────────────────

  if (petLoading) {
    return <FullScreenStatus message="LOADING PET…" tone="neutral" />;
  }

  if (!pet) {
    return (
      <FullScreenStatus
        message="No pet found — return to ClawVille and create one"
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

  if (activityId !== 'bumper-shells') {
    return (
      <FullScreenStatus
        message={`${activityDef.title} ships in a later chunk — only Bumper Shells is wired today`}
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
        <BumperShellsScene roomId={roomId} selfPetId={petId} />
      </div>
      <BumperShellsHud onLeave={handleLeave} />
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
