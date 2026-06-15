'use client';

/**
 * Poker MTT room page — `/cove/poker/[tournamentId]`.
 *
 * Why a dedicated ROUTE (not a cove modal): the live multi-table tournament
 * runs over a long-lived WebSocket and must survive `poker.moved` table swaps
 * (close the old room's socket, open the new one) with a clean teardown. That
 * is the same isolation reasoning the activity-room route uses for the WebGPU
 * scenes — a full-screen, route-keyed surface with deterministic unmount. The
 * cove MODALS (`HoldemModal`, `BlackjackModal`, …) are single-shot REST games
 * with no socket lifecycle; an MTT does not fit that shell.
 *
 * Surface composition:
 *   - Avatar gate (self-avatar required — a CT buy-in has no guest tier).
 *   - <PokerTournamentLobby> until seating completes (POST /register → POLL
 *     /connection). On `onSeated` it hands up `{ roomId, shortCode, seatIndex }`.
 *   - Then mount the live felt: <PokerTable> + <PokerActionBar> on
 *     `useActivityWs(activityId='texas-holdem-mtt', roomId, shortCode)`. The WS
 *     hook routes `poker.*` frames through the activity store → the poker store.
 *   - `poker.moved` handling: the poker store stashes `pendingMove`; an effect
 *     here swaps the active room (which re-keys `useActivityWs` → fresh socket)
 *     and shows a "moved to a new table" toast.
 *
 * Iris Xe safe: the felt is pure DOM/CSS. No WebGPU on this route.
 */

import { useCallback, useEffect, useRef, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { useAvatar } from '@/hooks/use-avatar';
import { useActivityStore } from '@/stores/activity';
import { usePokerStore } from '@/stores/poker';
import { useActivityWs } from '@/hooks/useActivityWs';
import { useIsMobile } from '@/hooks/use-is-mobile';
import PokerTournamentLobby, {
  type PokerConnectionTicket,
} from '@/components/cove/poker/PokerTournamentLobby';
import PokerTable from '@/components/cove/poker/PokerTable';
import PokerActionBar from '@/components/cove/poker/PokerActionBar';

const MTT_ACTIVITY_ID = 'texas-holdem-mtt';

interface PokerRouteParams {
  tournamentId: string;
}

interface PokerPageProps {
  params: Promise<PokerRouteParams>;
}

export default function PokerTournamentPage({ params }: PokerPageProps) {
  const { tournamentId } = use(params);
  const router = useRouter();
  const isMobile = useIsMobile();

  const { data: avatar, isLoading: avatarLoading } = useAvatar();
  const avatarId = avatar?.id ?? null;

  // Active WS connection target — null until seated, then driven by the
  // connection ticket and updated on `poker.moved` so `useActivityWs` re-keys.
  const [conn, setConn] = useState<PokerConnectionTicket | null>(null);
  const [moveToast, setMoveToast] = useState<string | null>(null);
  const [eliminated, setEliminated] = useState(false);

  // ── Store lifecycle: reset on the ACTIVE room id, set self avatar ────────
  useEffect(() => {
    if (!conn) return;
    useActivityStore.getState().reset(conn.roomId);
    usePokerStore.getState().reset(conn.roomId);
    if (avatarId) {
      useActivityStore.getState().setSelfAvatarId(avatarId);
      usePokerStore.getState().setSelfAvatarId(avatarId);
    }
    return () => {
      useActivityStore.getState().reset(null);
      usePokerStore.getState().reset(null);
    };
  }, [conn?.roomId, avatarId]);

  // Keep selfAvatarId fresh if the avatar lands after seating.
  useEffect(() => {
    if (avatarId) {
      useActivityStore.getState().setSelfAvatarId(avatarId);
      usePokerStore.getState().setSelfAvatarId(avatarId);
    }
  }, [avatarId]);

  // ── Open the live WS once seated ─────────────────────────────────────────
  const wsEnabled = !!avatarId && !!conn;
  const { send, status } = useActivityWs({
    activityId: MTT_ACTIVITY_ID,
    roomId: conn?.roomId ?? '',
    shortCode: conn?.shortCode ?? '',
    enabled: wsEnabled,
  });

  // ── poker.moved → swap room + toast ──────────────────────────────────────
  // The poker store stashes `pendingMove` when the engine moves us. We read it,
  // update `conn` (which re-keys useActivityWs → new socket), and clear it so
  // the effect doesn't loop. The store's reset() (room-change effect above)
  // wipes stale hand state for the new table.
  const pendingMove = usePokerStore((s) => s.pendingMove);
  const lastMoveRoomRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingMove) return;
    if (lastMoveRoomRef.current === pendingMove.toRoomId) return;
    lastMoveRoomRef.current = pendingMove.toRoomId;
    const reasonLabel =
      pendingMove.reason === 'final_table'
        ? 'the FINAL TABLE'
        : pendingMove.reason === 'table_break'
          ? 'a new table (your table broke)'
          : 'a new table (rebalance)';
    setMoveToast(`Moved to ${reasonLabel}`);
    setConn((prev) =>
      prev
        ? {
            ...prev,
            roomId: pendingMove.toRoomId,
            shortCode: pendingMove.toShortCode,
            seatIndex: pendingMove.seatIndex,
          }
        : prev,
    );
    // Clear the store signal so we don't re-trigger.
    usePokerStore.setState({ pendingMove: null });
    const tid = setTimeout(() => setMoveToast(null), 4000);
    return () => clearTimeout(tid);
  }, [pendingMove]);

  // ── Detect our own elimination (busted seat in the latest hand result) ───
  const lastHandResult = usePokerStore((s) => s.lastHandResult);
  useEffect(() => {
    if (!lastHandResult || !avatarId) return;
    const mine = lastHandResult.perSeat.find((p) => p.avatarId === avatarId);
    if (mine && mine.status === 'busted') setEliminated(true);
  }, [lastHandResult, avatarId]);

  const handleSeated = useCallback((ticket: PokerConnectionTicket) => {
    setConn(ticket);
  }, []);

  const handleLeave = useCallback(() => {
    router.push('/cove');
  }, [router]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (avatarLoading) {
    return <FullScreen message="LOADING AVATAR…" />;
  }

  if (!avatar) {
    return (
      <FullScreen
        message="No avatar found — create one to enter the tournament"
        action={{ label: 'BACK TO COVE', onClick: handleLeave }}
      />
    );
  }

  // Pre-seat: the lobby owns registration + the seating poll.
  if (!conn) {
    return (
      <PokerTournamentLobby
        tournamentId={tournamentId}
        selfAvatarId={avatarId}
        onSeated={handleSeated}
        onLeave={handleLeave}
      />
    );
  }

  // Seated: live felt.
  return (
    <main
      style={{
        position: 'fixed',
        inset: 0,
        background: '#03090a',
        overflow: 'hidden',
      }}
    >
      <PokerTable selfAvatarId={avatarId} />
      <PokerActionBar send={send} isMobile={isMobile} />

      {/* Connection status pill (top-right). */}
      <div
        style={{
          position: 'absolute',
          top: 'calc(12px + env(safe-area-inset-top, 0px))',
          right: 12,
          zIndex: 30,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <ConnPill status={status} />
        <button
          type="button"
          onClick={handleLeave}
          style={{
            padding: '7px 14px',
            background: 'rgba(6,24,18,0.85)',
            border: '1px solid rgba(124,255,203,0.3)',
            borderRadius: 8,
            color: '#7cffcb',
            fontSize: 12,
            fontFamily: 'ui-monospace, monospace',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Leave
        </button>
      </div>

      {/* Moved-table toast. */}
      {moveToast && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: 'calc(60px + env(safe-area-inset-top, 0px))',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 40,
            padding: '10px 20px',
            background: 'rgba(124,255,203,0.16)',
            border: '1px solid rgba(124,255,203,0.5)',
            borderRadius: 10,
            color: '#d1fae5',
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.04em',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            backdropFilter: 'blur(6px)',
          }}
        >
          {moveToast}
        </div>
      )}

      {/* Elimination overlay. */}
      {eliminated && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            background: 'rgba(3,9,10,0.82)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div
            style={{
              color: '#fca5a5',
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: '0.12em',
              textShadow: '0 0 16px rgba(248,113,113,0.5)',
            }}
          >
            ELIMINATED
          </div>
          <div style={{ color: 'rgba(226,232,240,0.85)', fontSize: 13, textAlign: 'center', maxWidth: 320 }}>
            Your finishing place is locked in. Any prize + leaderboard points
            credit to your avatar automatically.
          </div>
          <button
            type="button"
            onClick={handleLeave}
            style={{
              padding: '12px 28px',
              background: 'transparent',
              border: '1px solid #7cffcb',
              borderRadius: 8,
              color: '#7cffcb',
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontWeight: 700,
              letterSpacing: '0.1em',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            BACK TO COVE
          </button>
        </div>
      )}
    </main>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ConnPill({ status }: { status: string }) {
  const ok = status === 'connected';
  const color = ok ? '#7cffcb' : status === 'reconnecting' ? '#fbbf24' : '#fca5a5';
  const label =
    status === 'connected'
      ? 'LIVE'
      : status === 'reconnecting'
        ? 'RECONNECTING'
        : status === 'connecting'
          ? 'CONNECTING'
          : 'OFFLINE';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '7px 12px',
        background: 'rgba(6,24,18,0.85)',
        border: `1px solid ${color}55`,
        borderRadius: 8,
        color,
        fontSize: 11,
        fontFamily: 'ui-monospace, monospace',
        fontWeight: 700,
        letterSpacing: '0.08em',
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 6px ${color}`,
        }}
      />
      {label}
    </div>
  );
}

function FullScreen({
  message,
  action,
}: {
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <main
      style={{
        position: 'fixed',
        inset: 0,
        background: '#03090a',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        color: '#7cffcb',
        fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        letterSpacing: '0.16em',
        fontSize: 14,
        textShadow: '0 0 12px rgba(124,255,203,0.4)',
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
            border: '1px solid #7cffcb',
            borderRadius: 6,
            color: '#7cffcb',
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
