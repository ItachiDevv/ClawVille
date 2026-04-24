'use client';

/**
 * BumperShellsHud — composes the HUD atoms into the in-match overlay
 * for Bumper Shells. Spec: frontend-spec.md §3.2 (desktop), §3.3 (mobile),
 * §3.5 ("Game-specific wrappers").
 *
 * The overall containers are pointer-events:none so 3D click-through
 * works; individual interactive bits set `pointer-events: auto` via
 * `data-hud-interactive="true"` (see PowerUpBar).
 */

import { useEffect, useState } from 'react';
import {
  useActivityStore,
  selectLeaderboard,
  selectSelfAlive,
  type ActivityState,
} from '@/stores/activity';
import {
  HudTile,
  HudPlacement,
  HudMiniLeaderboard,
  PowerUpBar,
  RoundCountdown,
  EliminatedOverlay,
  PingIndicator,
} from './activity';
import ActivityResultsModal from './activity-results-modal';

function formatTime(secondsRemaining: number): string {
  const s = Math.max(0, Math.round(secondsRemaining));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function useTickClock(intervalMs = 250) {
  const [, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((x) => x + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

export interface BumperShellsHudProps {
  /** Optional callback to leave the match — page wires to navigate back. */
  onLeave?: () => void;
  /**
   * Chunk #9 — required for the results modal to fetch authoritative results
   * from `GET /api/activities/:activityId/rooms/:roomId/results`.
   */
  activityId?: string;
  roomId?: string;
  /**
   * Optional Play Again handler — when omitted the modal hides the button.
   * Page wires this to navigate back to /game with `?quickQueue=bumper-shells`.
   */
  onPlayAgain?: () => void;
}

export default function BumperShellsHud({
  onLeave,
  activityId,
  roomId,
  onPlayAgain,
}: BumperShellsHudProps) {
  // Re-render every 250ms so the round timer counts down smoothly without
  // requiring server frames.
  useTickClock(250);

  const ping = useActivityStore((s) => s.ping);
  const placement = useActivityStore((s) => s.placement);
  const total = useActivityStore((s) => s.total);
  const alive = useActivityStore((s) => s.alive);
  const matchPhase = useActivityStore((s) => s.matchPhase);
  const countdownSecondsRemaining = useActivityStore((s) => s.countdownSecondsRemaining);
  const roundEndsAt = useActivityStore((s) => s.roundEndsAt);
  const room = useActivityStore((s) => s.room);
  const errorBanner = useActivityStore((s) => s.errorBanner);
  const connectionStatus = useActivityStore((s) => s.connectionStatus);
  // `winners`, `rewardPreview`, `matchEndReason` formerly powered the inline
  // ended-card; chunk #9 hands those reads to <ActivityResultsModal> instead.
  const powerUpInventory = useActivityStore((s) => s.powerUpInventory);
  const eliminations = useActivityStore((s) => s.events.eliminations);
  const selfAvatarId = useActivityStore((s) => s.selfAvatarId);

  const leaderboard = useActivityStore((s: ActivityState) => selectLeaderboard(s, 5));
  const selfAlive = useActivityStore(selectSelfAlive);

  // Derive round seconds remaining — server emits `endsAt` in `snapshot.init`.
  // During pregame we show the countdown; during live we show the timer.
  const liveSecondsRemaining = roundEndsAt ? Math.max(0, (roundEndsAt - Date.now()) / 1000) : null;

  const eliminatedSelfEvent =
    selfAvatarId && !selfAlive
      ? eliminations.find((e) => e.avatarId === selfAvatarId) ?? null
      : null;

  return (
    <>
      {/* Top-left — ping + status pills */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
          zIndex: 20,
        }}
      >
        <PingIndicator ms={ping} />
        {connectionStatus === 'reconnecting' && (
          <HudTile label="Network" value="Reconnecting…" tone="warning" icon="🔄" />
        )}
        {connectionStatus === 'closed' && (
          <HudTile label="Network" value="Disconnected" tone="danger" icon="⚠" />
        )}
      </div>

      {/* Top-center — round timer */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          pointerEvents: 'none',
          zIndex: 20,
        }}
      >
        {matchPhase === 'live' && liveSecondsRemaining !== null && (
          <HudTile
            label="Round"
            value={formatTime(liveSecondsRemaining)}
            tone={liveSecondsRemaining < 15 ? 'danger' : liveSecondsRemaining < 30 ? 'warning' : 'neutral'}
            icon="⏱"
          />
        )}
        {matchPhase === 'pregame-countdown' && (
          <HudTile label="Match" value="Starting…" tone="gold" icon="✨" />
        )}
        {matchPhase === 'ended' && (
          <HudTile label="Match" value="Complete" tone="success" icon="🏁" />
        )}
      </div>

      {/* Top-right — placement + mini-leaderboard + alive counter */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          alignItems: 'flex-end',
          pointerEvents: 'none',
          zIndex: 20,
          maxWidth: 280,
        }}
      >
        <HudPlacement rank={placement} total={total} highlight={placement === 1 && matchPhase === 'live'} />
        <HudTile
          label="Alive"
          value={`${alive}/${total}`}
          tone={alive <= 2 ? 'danger' : alive <= 4 ? 'warning' : 'neutral'}
          icon="🦞"
        />
        <HudMiniLeaderboard entries={leaderboard} selfId={selfAvatarId} max={5} />
      </div>

      {/* Bottom-center — power-up bar + control hint */}
      <div
        style={{
          position: 'absolute',
          bottom: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          pointerEvents: 'none',
          zIndex: 20,
        }}
      >
        <PowerUpBar slots={powerUpInventory} />
        <div
          className="claw-panel"
          style={{
            padding: '4px 10px',
            fontSize: 10,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            letterSpacing: '0.1em',
            color: 'rgba(226, 232, 240, 0.85)',
            pointerEvents: 'none',
          }}
        >
          WASD · SPACE boost · Q power-up · ESC leave
        </div>
      </div>

      {/* Top-left below network — leave button (pointer-events:auto) */}
      {onLeave && (
        <button
          type="button"
          data-hud-interactive="true"
          onClick={onLeave}
          style={{
            position: 'absolute',
            bottom: 16,
            left: 16,
            zIndex: 21,
            padding: '8px 14px',
            background: 'linear-gradient(180deg, rgba(15, 31, 58, 0.95), rgba(6, 13, 23, 0.95))',
            border: '1px solid rgba(255, 82, 82, 0.5)',
            borderRadius: 8,
            color: '#fca5a5',
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.1em',
            cursor: 'pointer',
            pointerEvents: 'auto',
            boxShadow: '0 0 14px rgba(255, 82, 82, 0.18)',
          }}
          aria-label="Leave match and return to ClawVille"
        >
          ← LEAVE MATCH
        </button>
      )}

      {/* Pregame countdown overlay */}
      {matchPhase === 'pregame-countdown' && countdownSecondsRemaining > 0 && (
        <RoundCountdown secondsRemaining={countdownSecondsRemaining} />
      )}

      {/* Eliminated overlay */}
      {matchPhase === 'live' && eliminatedSelfEvent && (
        <EliminatedOverlay
          eliminatedAt={eliminatedSelfEvent.at}
          placement={placement}
        />
      )}

      {/*
       * Match-ended Diablo-style results reveal — chunk #9.
       * Replaces the minimal scaffolding card with a full reveal modal that
       * reads fast-paint data from the store + replaces with authoritative
       * data from GET /api/activities/:id/rooms/:roomId/results.
       *
       * Falls back to a minimal card if activityId/roomId aren't passed
       * (e.g. legacy callers). The page wires both, so prod always uses
       * the modal.
       */}
      {matchPhase === 'ended' && activityId && roomId && (
        <ActivityResultsModal
          activityId={activityId}
          roomId={roomId}
          onPlayAgain={onPlayAgain ?? (() => onLeave?.())}
          onBackToLobby={onLeave ?? (() => undefined)}
        />
      )}

      {/* Inline error banner */}
      {errorBanner && (
        <div
          style={{
            position: 'absolute',
            top: 60,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(255, 82, 82, 0.92)',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 700,
            zIndex: 25,
            pointerEvents: 'none',
            boxShadow: '0 4px 16px rgba(255, 82, 82, 0.4)',
          }}
        >
          {errorBanner.message}
        </div>
      )}

      {/* Room shortcode (debugging — small bottom-right) */}
      {room && (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            right: 16,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 10,
            color: 'rgba(148, 163, 184, 0.6)',
            letterSpacing: '0.12em',
            pointerEvents: 'none',
            zIndex: 20,
          }}
        >
          ROOM {room.shortCode}
        </div>
      )}
    </>
  );
}
