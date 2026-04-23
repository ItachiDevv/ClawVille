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
}

export default function BumperShellsHud({ onLeave }: BumperShellsHudProps) {
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
  const winners = useActivityStore((s) => s.winners);
  const rewardPreview = useActivityStore((s) => s.rewardPreview);
  const matchEndReason = useActivityStore((s) => s.matchEndReason);
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

      {/* Match-ended summary card (chunk #8 will swap for the full RPG modal) */}
      {matchPhase === 'ended' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.55)',
            pointerEvents: 'auto',
            zIndex: 28,
          }}
          data-hud-interactive="true"
        >
          <div
            className="claw-panel"
            style={{
              padding: 28,
              minWidth: 340,
              maxWidth: 460,
              textAlign: 'center',
              borderColor: 'rgba(255, 215, 0, 0.7)',
              boxShadow: '0 0 36px rgba(255, 215, 0, 0.32)',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                fontSize: 22,
                fontWeight: 900,
                color: '#facc15',
                letterSpacing: '0.12em',
                marginBottom: 6,
              }}
            >
              MATCH COMPLETE
            </div>
            <div
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 11,
                color: 'rgba(148, 163, 184, 0.85)',
                marginBottom: 16,
                letterSpacing: '0.08em',
              }}
            >
              {matchEndReason === 'forfeit'
                ? 'By forfeit'
                : matchEndReason === 'aborted'
                  ? 'Round aborted'
                  : 'Last shell standing'}
            </div>

            {winners.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {winners.slice(0, 3).map((w) => (
                  <div
                    key={w.avatarId}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '4px 12px',
                      fontSize: 13,
                      fontWeight: w.avatarId === selfAvatarId ? 700 : 500,
                      color: w.avatarId === selfAvatarId ? '#86efac' : '#e2e8f0',
                    }}
                  >
                    <span>
                      {w.placement === 1 ? '🥇' : w.placement === 2 ? '🥈' : '🥉'} #{w.placement}
                    </span>
                    <span
                      style={{
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: 11,
                      }}
                    >
                      {w.avatarId.length > 16 ? `…${w.avatarId.slice(-12)}` : w.avatarId}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {rewardPreview && (
              <div
                style={{
                  display: 'inline-flex',
                  flexDirection: 'column',
                  gap: 4,
                  alignItems: 'center',
                  padding: '10px 16px',
                  background: 'rgba(0, 230, 118, 0.1)',
                  border: '1px solid rgba(0, 230, 118, 0.4)',
                  borderRadius: 6,
                  marginBottom: 16,
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                    fontSize: 18,
                    fontWeight: 800,
                    color: '#facc15',
                  }}
                >
                  +{rewardPreview.tokens} 🪙 ClawTokens
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: 'rgba(226, 232, 240, 0.85)',
                  }}
                >
                  +{rewardPreview.leaderboardPoints} leaderboard pts · placement #{rewardPreview.placement}
                </span>
                {rewardPreview.firstPlayOfDayBonus && (
                  <span style={{ fontSize: 10, color: '#86efac' }}>
                    +15 first-play-of-day bonus
                  </span>
                )}
                {rewardPreview.focusBonus && (
                  <span style={{ fontSize: 10, color: '#86efac' }}>+25% focus bonus</span>
                )}
              </div>
            )}

            {onLeave && (
              <button
                type="button"
                onClick={onLeave}
                style={{
                  padding: '10px 24px',
                  background: 'linear-gradient(180deg, #00E5FF 0%, #0288D1 100%)',
                  border: 'none',
                  borderRadius: 8,
                  color: '#0A1628',
                  fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
                  fontWeight: 800,
                  letterSpacing: '0.08em',
                  cursor: 'pointer',
                  fontSize: 12,
                  boxShadow: '0 4px 14px rgba(0, 229, 255, 0.4)',
                }}
              >
                BACK TO LOBBY
              </button>
            )}
          </div>
        </div>
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
