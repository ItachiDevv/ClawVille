'use client';

/**
 * BumperShellsHud — composes the HUD atoms into the in-match overlay
 * for Bumper Shells. Spec: frontend-spec.md §3.2 (desktop), §3.3 (mobile),
 * §3.5 ("Game-specific wrappers").
 *
 * The overall containers are pointer-events:none so 3D click-through
 * works; individual interactive bits set `pointer-events: auto` via
 * `data-hud-interactive="true"` (see PowerUpBar).
 *
 * Chunk #11 — spectator mode wiring:
 *   - When self is eliminated mid-match, render the upgraded
 *     <EliminatedOverlay> with prev/next/free-cam controls, a separate
 *     spectator chat channel, and cheer/taunt emotes.
 *   - Spectator state (target avatarId, cam mode, emote cooldowns) is held
 *     LOCALLY here — these are per-spectator UI choices, not match state.
 *   - The page wires `sendChat` + `sendEmote` callbacks so we can post
 *     `chat` / `emote` WS frames without the HUD owning the WS hook.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useActivityStore,
  selectLeaderboard,
  selectSelfAlive,
  selectSpectatorChat,
  selectAliveEntities,
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
  type SpectatorCamMode,
} from './activity';
import ActivityResultsModal from './activity-results-modal';
import { playActivitySound } from '@/lib/activity-audio';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Spectator emote cooldown — chunk #11 ships client-side rate-limit only.
 * Server-side enforcement (per spec §7.4 "1 per 15s per spectator") will
 * mirror this constant in a future chunk.
 */
const EMOTE_COOLDOWN_MS = 15_000;

const CHEER_EMOTE_ID = 'cheer-clap';
const TAUNT_EMOTE_ID = 'taunt-laugh';

const EMOTE_GLYPHS: Record<string, string> = {
  [CHEER_EMOTE_ID]: '👏 Cheer',
  [TAUNT_EMOTE_ID]: '😈 Taunt',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Public API ─────────────────────────────────────────────────────────────

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
  /**
   * Chunk #11 — spectator chat send. Returns true on successful WS send.
   * When omitted (legacy callers), the spectator chat input is rendered
   * but submissions silently fail-then-error to the user.
   */
  sendChat?: (text: string, opts: { spectator: boolean }) => boolean;
  /**
   * Chunk #11 — emote send (cheers + taunts). Returns true on successful
   * WS send. When omitted, emote buttons still cooldown locally so the
   * UX feels responsive even without a wire.
   */
  sendEmote?: (emoteId: string, opts: { spectator: boolean }) => boolean;
  /**
   * Chunk #12 — when set, the HUD reports its spectator state (cam mode +
   * target avatarId) up to the parent so the parent can pass it to the 3D
   * scene as spectator camera props. Optional — when omitted, the HUD
   * keeps state local and the scene falls back to the static camera.
   */
  onSpectatorStateChange?: (state: {
    camMode: SpectatorCamMode;
    targetPetId: string | null;
  }) => void;
}

export default function BumperShellsHud({
  onLeave,
  activityId,
  roomId,
  onPlayAgain,
  sendChat,
  sendEmote,
  onSpectatorStateChange,
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
  const scores = useActivityStore((s) => s.scores);
  const pushChatLocal = useActivityStore((s) => s.pushChatLocal);

  const leaderboard = useActivityStore((s: ActivityState) => selectLeaderboard(s, 5));
  const selfAlive = useActivityStore(selectSelfAlive);
  const aliveEntities = useActivityStore(selectAliveEntities);
  const spectatorChat = useActivityStore(selectSpectatorChat);

  // Derive round seconds remaining — server emits `endsAt` in `snapshot.init`.
  // During pregame we show the countdown; during live we show the timer.
  const liveSecondsRemaining = roundEndsAt ? Math.max(0, (roundEndsAt - Date.now()) / 1000) : null;

  const eliminatedSelfEvent =
    selfAvatarId && !selfAlive
      ? eliminations.find((e) => e.avatarId === selfAvatarId) ?? null
      : null;

  // ── Spectator local state (chunk #11) ──────────────────────────────────
  const [spectatorCamMode, setSpectatorCamMode] = useState<SpectatorCamMode>('action');
  const [spectatorTargetPetId, setSpectatorTargetPetId] = useState<string | null>(null);
  const [cheerCooldownUntil, setCheerCooldownUntil] = useState<number | null>(null);
  const [tauntCooldownUntil, setTauntCooldownUntil] = useState<number | null>(null);

  // Bridge spectator state to parent (chunk #12) so the scene can swap to
  // the perspective camera. Fires only when a spectator is active OR
  // returns to alive — parent decides whether to actually pass props.
  useEffect(() => {
    if (!onSpectatorStateChange) return;
    onSpectatorStateChange({
      camMode: spectatorCamMode,
      targetPetId: spectatorTargetPetId,
    });
  }, [spectatorCamMode, spectatorTargetPetId, onSpectatorStateChange]);

  // ── SFX: knockout sound when self is eliminated (chunk #12) ────────────
  const lastElimAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!selfAvatarId) return;
    if (eliminations.length === 0) return;
    const latest = eliminations[eliminations.length - 1];
    if (latest.avatarId !== selfAvatarId) return;
    if (lastElimAtRef.current === latest.at) return;
    lastElimAtRef.current = latest.at;
    playActivitySound('knockout');
  }, [eliminations, selfAvatarId]);

  // ── SFX: power-up pickup / use chimes on inventory delta (chunk #12) ────
  // Inventory grows after a pickup, shrinks after a successful use; we fire
  // the matching SFX on the next render. First mount establishes baseline
  // (no sound) so re-entering a match doesn't blip on hydration.
  const prevInventorySizeRef = useRef<number | null>(null);
  useEffect(() => {
    const size = powerUpInventory.length;
    const prev = prevInventorySizeRef.current;
    if (prev !== null) {
      if (size > prev) playActivitySound('item-pickup');
      else if (size < prev) playActivitySound('item-use');
    }
    prevInventorySizeRef.current = size;
  }, [powerUpInventory]);

  // Auto-pick an initial spectator target when we first become a spectator
  // (action-cam mode picks server-side per spec §7.3, but we still hold a
  // current target so swapping to follow mode has a sane default).
  useEffect(() => {
    if (selfAlive) {
      // Reset spectator state when the user is alive again (e.g. next match).
      if (spectatorTargetPetId !== null) setSpectatorTargetPetId(null);
      return;
    }
    if (aliveEntities.length === 0) return;
    if (spectatorTargetPetId && aliveEntities.some((e) => e.avatarId === spectatorTargetPetId)) {
      return;
    }
    // Action-cam heuristic — pick the most recently-credited eliminator,
    // falling back to the highest-score alive avatar, then to the first alive.
    const recentElim = [...eliminations].reverse().find(
      (e) => e.avatarId !== selfAvatarId && aliveEntities.some((a) => a.avatarId === e.avatarId),
    );
    if (recentElim) {
      setSpectatorTargetPetId(recentElim.avatarId);
      return;
    }
    type BestRef = { avatarId: string; score: number } | null;
    let best: BestRef = null;
    for (const e of aliveEntities) {
      const s = scores.get(e.avatarId);
      const score = s?.score ?? 0;
      if (best === null || score > best.score) {
        best = { avatarId: e.avatarId, score };
      }
    }
    setSpectatorTargetPetId((best as BestRef)?.avatarId ?? aliveEntities[0].avatarId);
  }, [selfAlive, aliveEntities, eliminations, scores, selfAvatarId, spectatorTargetPetId]);

  // ── Spectator action callbacks ─────────────────────────────────────────
  const cycleTarget = useCallback(
    (direction: 1 | -1) => {
      if (aliveEntities.length === 0) return;
      const currentIdx = spectatorTargetPetId
        ? aliveEntities.findIndex((e) => e.avatarId === spectatorTargetPetId)
        : -1;
      const baseIdx = currentIdx >= 0 ? currentIdx : 0;
      const nextIdx = (baseIdx + direction + aliveEntities.length) % aliveEntities.length;
      setSpectatorTargetPetId(aliveEntities[nextIdx].avatarId);
      setSpectatorCamMode('follow');
    },
    [aliveEntities, spectatorTargetPetId],
  );

  const handleSelectPrev = useCallback(() => cycleTarget(-1), [cycleTarget]);
  const handleSelectNext = useCallback(() => cycleTarget(1), [cycleTarget]);
  const handleSelectFree = useCallback(() => {
    setSpectatorCamMode('free');
  }, []);

  const handleSendChat = useCallback(
    (text: string): boolean => {
      // Always echo locally so the spectator sees their own line even if
      // the server doesn't yet fan out a separate spectator channel.
      pushChatLocal({
        avatarId: selfAvatarId ?? 'you',
        text,
        spectator: true,
      });
      if (!sendChat) return true;
      const ok = sendChat(text, { spectator: true });
      // If the wire dropped, the local echo still stands — caller sees a
      // disconnected banner via the network status pill.
      return ok;
    },
    [pushChatLocal, selfAvatarId, sendChat],
  );

  const fireEmote = useCallback(
    (emoteId: string, isCheer: boolean) => {
      const now = Date.now();
      // Rate-limit guard — UI also disables the button via cooldownUntil,
      // but we double-check here in case both buttons are clicked rapidly
      // through the keyboard.
      if (isCheer) {
        if (cheerCooldownUntil && cheerCooldownUntil > now) return;
        setCheerCooldownUntil(now + EMOTE_COOLDOWN_MS);
      } else {
        if (tauntCooldownUntil && tauntCooldownUntil > now) return;
        setTauntCooldownUntil(now + EMOTE_COOLDOWN_MS);
      }
      // Local echo into the spectator chat as a system-style row so the
      // player gets immediate confirmation the emote fired.
      pushChatLocal({
        avatarId: selfAvatarId ?? 'you',
        text: EMOTE_GLYPHS[emoteId] ?? emoteId,
        spectator: true,
        emoteId,
      });
      sendEmote?.(emoteId, { spectator: true });
    },
    [cheerCooldownUntil, tauntCooldownUntil, pushChatLocal, selfAvatarId, sendEmote],
  );

  const handleCheer = useCallback(() => fireEmote(CHEER_EMOTE_ID, true), [fireEmote]);
  const handleTaunt = useCallback(() => fireEmote(TAUNT_EMOTE_ID, false), [fireEmote]);

  const scoreLookup = useMemo(() => scores, [scores]);

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

      {/*
       * Top-right — placement + mini-leaderboard + alive counter.
       * Hidden while the spectator overlay is active because it owns the
       * right rail real estate (its own leaderboard atom + cam controls).
       */}
      {!eliminatedSelfEvent && (
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
      )}

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

      {/* Eliminated/spectator overlay — chunk #11 upgrade. */}
      {matchPhase === 'live' && eliminatedSelfEvent && (
        <EliminatedOverlay
          eliminatedAt={eliminatedSelfEvent.at}
          placement={placement}
          selfAvatarId={selfAvatarId}
          leaderboard={leaderboard}
          scoreLookup={scoreLookup}
          aliveEntities={aliveEntities}
          spectatorChat={spectatorChat}
          roundEndsAt={roundEndsAt}
          spectatorTargetPetId={spectatorTargetPetId}
          spectatorCamMode={spectatorCamMode}
          cheerCooldownUntil={cheerCooldownUntil}
          tauntCooldownUntil={tauntCooldownUntil}
          emoteCooldownMs={EMOTE_COOLDOWN_MS}
          onSelectPrev={handleSelectPrev}
          onSelectNext={handleSelectNext}
          onSelectFree={handleSelectFree}
          onCamModeChange={setSpectatorCamMode}
          onSendChat={handleSendChat}
          onCheer={handleCheer}
          onTaunt={handleTaunt}
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
