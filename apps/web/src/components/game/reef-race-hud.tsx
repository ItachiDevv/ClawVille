'use client';

/**
 * ReefRaceHud — minimal lap counter + position + power-up bar for Reef Race.
 *
 * Spec: 3d-spec §2 + frontend-spec §3 (full polish in chunk #8).
 * This is a minimal version: lap counter, current placement, power-up bar.
 * Full HUD (split timer, ghost delta, next-checkpoint arrow) ships in chunk #8.
 *
 * Layout: pointer-events:none outer container (click-through to 3D canvas).
 * Interactive elements (leave button) use pointer-events:auto.
 */

import { useEffect, useState, useMemo } from 'react';
import {
  useActivityStore,
  selectLeaderboard,
  selectSelfAlive,
  type ActivityState,
} from '@/stores/activity';
import { TOTAL_LAPS } from '@/lib/three/activities/reef-race/reef-race-config';
import ActivityResultsModal from './activity-results-modal';
import ReefRaceInstructions from './reef-race-instructions';
import { RoundCountdown } from './activity';
import ReefRaceDriftSparks   from './reef-race-drift-sparks';
import ReefRaceDraftBadge    from './reef-race-draft-badge';
import ReefRaceEventToasts   from './reef-race-event-toasts';
import ReefRaceBuildSummary  from './reef-race-build-summary';
import ReefRaceStreakCounter from './reef-race-streak-counter';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const hundredths = Math.floor((ms % 1000) / 10);
  return `${min}:${sec.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LapCounter({ selfPetId }: { selfPetId: string | null }) {
  const lap = useActivityStore((s) => {
    if (!selfPetId) return 1;
    const e = s.entities.get(selfPetId) as any;
    return e?.lap ?? 1;
  });

  return (
    <div
      style={{
        background: 'rgba(0, 0, 0, 0.65)',
        border: '1px solid #00e5ff44',
        borderRadius: 8,
        padding: '8px 16px',
        textAlign: 'center',
        minWidth: 100,
      }}
    >
      <div style={{ fontSize: 10, letterSpacing: '0.15em', color: '#00e5ff99' }}>
        LAP
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '0.05em', color: '#ffffff' }}>
        {Math.min(lap, TOTAL_LAPS)}/{TOTAL_LAPS}
      </div>
    </div>
  );
}

/**
 * Phase 2 — placement-weighted power-up rarity hint.
 * Mirrors the server's `getPlacementItemTable` bias:
 *   - 1st       → defensive-only roll (shield / turbo)
 *   - 2nd–3rd   → neutral-leaning blend
 *   - 4th–6th   → balanced
 *   - 7th–8th+  → aggressive-only roll (whirlpool / ink-slick / seeker)
 * Without this hint, the rubber-band feels like RNG noise to players.
 */
function rarityChipForPlacement(
  placement: number,
): { glyph: string; tone: string; color: string; label: string } {
  if (placement <= 1) {
    return { glyph: '\u{1F6E1} DEF', tone: 'def', color: '#5cd2ff', label: 'Defensive items only' };
  }
  if (placement <= 3) {
    return { glyph: '\u{2696} BAL', tone: 'bal', color: '#cccccc', label: 'Balanced — slight defense bias' };
  }
  if (placement <= 6) {
    return { glyph: '\u{2696} BAL', tone: 'bal', color: '#cccccc', label: 'Balanced item roll' };
  }
  return { glyph: '\u{2694} AGG', tone: 'agg', color: '#ff7a4a', label: 'Aggressive items only' };
}

function PlacementTile({ selfPetId }: { selfPetId: string | null }) {
  const placement = useActivityStore((s) => s.placement);
  const total     = useActivityStore((s) => s.total);

  if (!placement) return null;

  const rarity = rarityChipForPlacement(placement);
  void selfPetId;

  return (
    <div
      style={{
        background: 'rgba(0, 0, 0, 0.65)',
        border: '1px solid #00e5ff44',
        borderRadius: 8,
        padding: '8px 16px',
        textAlign: 'center',
        minWidth: 80,
      }}
    >
      <div style={{ fontSize: 10, letterSpacing: '0.15em', color: '#00e5ff99' }}>
        POSITION
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#ffd600' }}>
        {ordinal(placement)}
      </div>
      <div style={{ fontSize: 10, color: '#ffffff66' }}>
        of {total}
      </div>
      {/* Phase 2 — rarity-tier hint chip. Surfaces placement-weighted item bias. */}
      <div
        title={rarity.label}
        aria-label={rarity.label}
        data-rarity-tone={rarity.tone}
        style={{
          marginTop: 4,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          padding: '2px 6px',
          borderRadius: 4,
          background: 'rgba(0, 0, 0, 0.45)',
          border: `1px solid ${rarity.color}66`,
          color: rarity.color,
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {rarity.glyph}
      </div>
    </div>
  );
}

function BestLapTile({ selfPetId }: { selfPetId: string | null }) {
  const bestLap = useActivityStore((s) => {
    if (!selfPetId) return null;
    const laps = s.reefRace?.laps?.get(selfPetId);
    if (!laps || laps.length === 0) return null;
    return Math.min(...laps.map((l) => l.splitMs));
  });

  if (!bestLap) return null;

  return (
    <div
      style={{
        background: 'rgba(0, 0, 0, 0.55)',
        border: '1px solid #ffd60033',
        borderRadius: 6,
        padding: '6px 12px',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 9, letterSpacing: '0.15em', color: '#ffd60099' }}>
        BEST LAP
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#ffd600', fontVariantNumeric: 'tabular-nums' }}>
        {formatMs(bestLap)}
      </div>
    </div>
  );
}

function PowerUpBar({ selfPetId }: { selfPetId: string | null }) {
  const inventory = useActivityStore((s) => s.powerUpInventory);

  if (!inventory.length) return null;

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        background: 'rgba(0, 0, 0, 0.6)',
        border: '1px solid #00e5ff33',
        borderRadius: 8,
        padding: '6px 12px',
      }}
    >
      {inventory.map((slot, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              background: '#00e5ff22',
              border: '1px solid #00e5ff55',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
            }}
          >
            {slot.kind === 'boost' ? '⚡' : slot.kind === 'shield' ? '🛡' : '?'}
          </div>
          <div style={{ fontSize: 9, color: '#ffffff99' }}>
            ×{slot.charges}
          </div>
        </div>
      ))}
    </div>
  );
}

function LeaveButton({ onLeave }: { onLeave?: () => void }) {
  if (!onLeave) return null;
  return (
    <button
      type="button"
      onClick={onLeave}
      style={{
        pointerEvents: 'auto',
        background: 'rgba(0, 0, 0, 0.7)',
        border: '1px solid #ff444488',
        borderRadius: 6,
        color: '#ff4444',
        fontFamily: 'inherit',
        fontWeight: 700,
        letterSpacing: '0.12em',
        fontSize: 10,
        padding: '6px 14px',
        cursor: 'pointer',
      }}
    >
      LEAVE
    </button>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export interface ReefRaceHudProps {
  onLeave?: () => void;
  onPlayAgain?: () => void;
  activityId?: string;
  roomId?: string;
}

export default function ReefRaceHud({
  onLeave,
  onPlayAgain,
  activityId,
  roomId,
}: ReefRaceHudProps) {
  const selfPetId  = useActivityStore((s) => s.selfPetId);
  const matchPhase = useActivityStore((s) => s.matchPhase);
  const countdownSecondsRemaining = useActivityStore(
    (s) => s.countdownSecondsRemaining,
  );
  // Phase 1 (audit S9) — HUD launch glow ring computes seconds-remaining
  // locally from `room.countdownStartedAt` because the server only emits
  // a single one-shot `event.countdown` at COUNTDOWN entry. Without this,
  // the ring would never trip mid-countdown.
  const countdownStartedAt = useActivityStore(
    (s) => s.room?.countdownStartedAt ?? null,
  );
  const [localSecondsRemaining, setLocalSecondsRemaining] = useState(5);
  useEffect(() => {
    if (!countdownStartedAt) return;
    const tick = () => {
      const elapsed = (Date.now() - countdownStartedAt) / 1000;
      setLocalSecondsRemaining(Math.max(0, Math.ceil(5 - elapsed)));
    };
    tick();
    const id = setInterval(tick, 200); // 5Hz is plenty for a 1s countdown
    return () => clearInterval(id);
  }, [countdownStartedAt]);

  const baseStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
    color: '#ffffff',
  };

  return (
    <div style={baseStyle}>
      {/* Top-left: Lap counter + position */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <LapCounter selfPetId={selfPetId} />
        <PlacementTile selfPetId={selfPetId} />
        {/* Phase 4 — clean-checkpoint streak chip (C-IMPL-3 fix). Only
            renders mid-match; auto-dismisses on streak=0. Tier glow tracks
            the shared `streakMilestoneKind` enum so it stays in lock-step
            with the server's edge-trigger broadcast. */}
        <ReefRaceStreakCounter />
        <BestLapTile selfPetId={selfPetId} />
        {/* Phase 3 — racing-class build summary chip */}
        <ReefRaceBuildSummary />
      </div>

      {/* Top-center: Draft (slipstream) badge — Phase 2 */}
      <ReefRaceDraftBadge />

      {/* Center: Apex verdict + hazard hit + ribbon boost toasts — Phase 2 */}
      <ReefRaceEventToasts />

      {/* Bottom-center: Drift charge sparks (above PowerUpBar) */}
      <ReefRaceDriftSparks />

      {/* Bottom-center: Power-up bar */}
      <div
        style={{
          position: 'absolute',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
        }}
      >
        <PowerUpBar selfPetId={selfPetId} />
      </div>

      {/* Top-right: Leave button */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          pointerEvents: 'auto',
        }}
      >
        <LeaveButton onLeave={onLeave} />
      </div>

      {/* Pregame countdown overlay + how-to-play card. Both auto-dismiss
          when the match goes live (parent conditional). */}
      {matchPhase === 'pregame-countdown' && countdownSecondsRemaining > 0 && (
        <>
          <RoundCountdown secondsRemaining={countdownSecondsRemaining} />
          <ReefRaceInstructions
            countdownSecondsRemaining={countdownSecondsRemaining}
          />
        </>
      )}

      {/* Phase 1 launch-glow ring — overlaid at the very last second of the
          countdown so a player priming a launch press sees a clear "go now"
          cue. Local-countdown-driven (audit S9). */}
      {matchPhase === 'pregame-countdown' && localSecondsRemaining === 1 && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: 240,
            height: 240,
            marginLeft: -120,
            marginTop: -120,
            borderRadius: '50%',
            border: '4px solid #00e676',
            boxShadow: '0 0 32px #00e67688, inset 0 0 24px #00e67644',
            animation: 'reefLaunchPulse 0.4s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        />
      )}
      <style jsx>{`
        @keyframes reefLaunchPulse {
          0%, 100% { transform: scale(1); opacity: 0.85; }
          50%      { transform: scale(1.08); opacity: 1; }
        }
      `}</style>

      {/* Results modal — same as BumperShells, reused */}
      {matchPhase === 'ended' && activityId && roomId && onLeave && onPlayAgain && (
        <ActivityResultsModal
          onBackToLobby={onLeave}
          onPlayAgain={onPlayAgain}
          activityId={activityId}
          roomId={roomId}
        />
      )}
    </div>
  );
}
