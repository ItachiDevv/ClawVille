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

import { useEffect, useRef, useState, useMemo } from 'react';
import {
  useActivityStore,
  selectLeaderboard,
  selectSelfAlive,
  type ActivityState,
} from '@/stores/activity';
import type { ReefPowerUpKind } from '@clawville/shared';
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

function LapCounter({ selfAvatarId }: { selfAvatarId: string | null }) {
  const lap = useActivityStore((s) => {
    if (!selfAvatarId) return 1;
    const e = s.entities.get(selfAvatarId) as any;
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

function PlacementTile({ selfAvatarId }: { selfAvatarId: string | null }) {
  const placement = useActivityStore((s) => s.placement);
  const total     = useActivityStore((s) => s.total);

  if (!placement) return null;

  const rarity = rarityChipForPlacement(placement);
  void selfAvatarId;

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

function BestLapTile({ selfAvatarId }: { selfAvatarId: string | null }) {
  const bestLap = useActivityStore((s) => {
    if (!selfAvatarId) return null;
    const laps = s.reefRace?.laps?.get(selfAvatarId);
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

// Display metadata for each Reef Race power-up kind. Mirrors REEF_POWERUP_DEFS
// (apps/api/src/services/activity/sim/reef-race-config.ts) — must be kept in
// sync if a new kind is added on the server (the protocol type fence will
// prevent silent drift but the player would see "?" until this map updates).
const POWER_UP_META: Record<
  ReefPowerUpKind,
  {
    icon: string;
    name: string;
    desc: string;
    color: string;
    /** Active effect duration ms — 0 means instant-cast (no on-screen timer). */
    effectMs: number;
  }
> = {
  'rr-turbo-bubble':  { icon: '⚡', name: 'Turbo Bubble', desc: '+40% speed for 2.5s', color: '#ffd24a', effectMs: 2_500 },
  'rr-bubble-shield': { icon: '🛡',  name: 'Bubble Shield', desc: 'Block 1 hit · 4s', color: '#5cd2ff', effectMs: 4_000 },
  'rr-ink-slick':     { icon: '🟣', name: 'Ink Slick',  desc: 'Drop slick · 6s slow', color: '#a26bff', effectMs: 6_000 },
  'rr-seeker-jelly':  { icon: '🪼', name: 'Seeker Jelly', desc: 'Homing hit on rival', color: '#ff7aa8', effectMs: 0 },
  'rr-tide-wave':     { icon: '🌊', name: 'Tide Wave', desc: 'Push back nearby avatars', color: '#4dffea', effectMs: 0 },
  'rr-whirlpool':     { icon: '🌀', name: 'Whirlpool', desc: 'Spin nearby rivals · 3s', color: '#ff5e8a', effectMs: 3_000 },
};

function getPowerUpMeta(kind: string) {
  return (POWER_UP_META as Record<string, typeof POWER_UP_META[ReefPowerUpKind]>)[kind] ?? {
    icon: '?', name: kind, desc: '', color: '#888', effectMs: 0,
  };
}

/**
 * Single power-up slot — icon + name + USE-key prompt + charge count, with a
 * pickup-pulse on transitions empty→filled and an active-effect bar after use.
 */
function PowerUpSlotCard({
  slot,
  useKey,
  slotIndex,
}: {
  slot: { kind: string; charges: number; cooldownUntil?: number } | null;
  useKey: string;
  slotIndex: number;
}) {
  // Track previous slot state so we can detect pickup vs use transitions and
  // run a local-only effect timer (server doesn't broadcast active duration).
  const prevKindRef = useRef<string | null>(null);
  const [pickupFlash, setPickupFlash] = useState(false);
  const [activeEffect, setActiveEffect] = useState<{
    kind: string;
    until: number;
  } | null>(null);

  useEffect(() => {
    const cur = slot?.kind ?? null;
    const prev = prevKindRef.current;

    // empty → filled = pickup
    if (!prev && cur) {
      setPickupFlash(true);
      const t = window.setTimeout(() => setPickupFlash(false), 600);
      // also clear any lingering "active" pip from prior round
      setActiveEffect(null);
      prevKindRef.current = cur;
      return () => window.clearTimeout(t);
    }
    // filled → empty = use (or wipeout consume — close enough for HUD)
    if (prev && !cur) {
      const meta = getPowerUpMeta(prev);
      if (meta.effectMs > 0) {
        setActiveEffect({ kind: prev, until: performance.now() + meta.effectMs });
      }
      prevKindRef.current = null;
      return;
    }
    prevKindRef.current = cur;
  }, [slot?.kind]);

  // Tick the active-effect timer at 30 Hz so the countdown bar animates.
  const [, force] = useState(0);
  useEffect(() => {
    if (!activeEffect) return;
    const tick = () => {
      if (performance.now() >= activeEffect.until) {
        setActiveEffect(null);
      } else {
        force((n) => (n + 1) & 0xff);
      }
    };
    const id = window.setInterval(tick, 33);
    return () => window.clearInterval(id);
  }, [activeEffect]);

  const meta = slot ? getPowerUpMeta(slot.kind) : null;
  const filled = !!slot;

  // Active-effect overlay
  let activePct = 0;
  let activeMeta = null;
  if (activeEffect) {
    activeMeta = getPowerUpMeta(activeEffect.kind);
    const remaining = Math.max(0, activeEffect.until - performance.now());
    activePct = Math.min(1, remaining / activeMeta.effectMs);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 110 }}>
      {/* USE-KEY chip — always visible so players learn the binding */}
      <div
        style={{
          fontSize: 9,
          letterSpacing: '0.18em',
          fontWeight: 900,
          padding: '2px 8px',
          borderRadius: 4,
          background: filled ? `${meta!.color}33` : 'rgba(255,255,255,0.08)',
          border: `1px solid ${filled ? meta!.color : '#ffffff22'}`,
          color: filled ? meta!.color : '#ffffff66',
          transition: 'all 200ms ease',
        }}
      >
        {useKey}
      </div>

      {/* Slot card */}
      <div
        style={{
          width: 80,
          height: 80,
          borderRadius: 12,
          border: `2px solid ${filled ? meta!.color : '#ffffff15'}`,
          background: filled
            ? `radial-gradient(circle at 50% 30%, ${meta!.color}55 0%, ${meta!.color}11 60%, rgba(0,0,0,0.7) 100%)`
            : 'rgba(0,0,0,0.55)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 36,
          position: 'relative',
          transition: 'all 250ms ease',
          boxShadow: pickupFlash
            ? `0 0 24px 4px ${meta?.color ?? '#fff'}, 0 0 8px 2px #fff inset`
            : filled
            ? `0 0 12px ${meta!.color}55`
            : 'none',
          animation: pickupFlash ? 'reef-power-pulse 600ms ease-out' : undefined,
        }}
      >
        {filled ? meta!.icon : <span style={{ color: '#ffffff22', fontSize: 24 }}>—</span>}

        {/* Charge pip (only when > 1) */}
        {filled && slot!.charges > 1 && (
          <div
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              fontSize: 10,
              fontWeight: 800,
              padding: '2px 6px',
              borderRadius: 999,
              background: meta!.color,
              color: '#000',
            }}
          >
            ×{slot!.charges}
          </div>
        )}

        {/* Active-effect countdown ring */}
        {activeMeta && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: -3,
              height: 4,
              background: 'rgba(255,255,255,0.1)',
              borderRadius: 2,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${activePct * 100}%`,
                height: '100%',
                background: activeMeta.color,
                transition: 'width 33ms linear',
              }}
            />
          </div>
        )}
      </div>

      {/* Name + description */}
      <div style={{ height: 26, textAlign: 'center' }}>
        {filled ? (
          <>
            <div style={{ fontSize: 10, fontWeight: 800, color: meta!.color, letterSpacing: '0.04em' }}>
              {meta!.name}
            </div>
            <div style={{ fontSize: 8, color: '#ffffff88', marginTop: 1 }}>
              {meta!.desc}
            </div>
          </>
        ) : activeMeta ? (
          <div style={{ fontSize: 9, color: activeMeta.color, fontWeight: 800, letterSpacing: '0.05em' }}>
            ACTIVE · {activeMeta.name}
          </div>
        ) : (
          <div style={{ fontSize: 9, color: '#ffffff44', letterSpacing: '0.08em' }}>
            EMPTY · DRIVE THROUGH PICKUP
          </div>
        )}
      </div>
      {/* Slot index dev hint suppressed in prod; readable here for debug */}
      <span style={{ display: 'none' }}>{slotIndex}</span>
    </div>
  );
}

function PowerUpBar({ selfAvatarId: _selfPetId }: { selfAvatarId: string | null }) {
  const inventory = useActivityStore((s) => s.powerUpInventory);
  // Pad to REEF_MAX_POWER_UP_SLOTS (= 2) so empty slots stay visible — the
  // whole point of this HUD is "you can SEE you have nothing yet" instead of
  // wondering whether your pickup landed.
  const slots: Array<{ kind: string; charges: number; cooldownUntil?: number } | null> = [
    inventory[0] ?? null,
    inventory[1] ?? null,
  ];
  const useKeys = ['SPACE', 'Q'];

  return (
    <>
      <style>{`@keyframes reef-power-pulse { 0% { transform: scale(1); } 35% { transform: scale(1.18); } 100% { transform: scale(1); } }`}</style>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          background: 'rgba(0, 0, 0, 0.55)',
          border: '1px solid #00e5ff33',
          borderRadius: 12,
          padding: '10px 16px 12px',
          backdropFilter: 'blur(6px)',
        }}
      >
        <div style={{ display: 'flex', gap: 14 }}>
          {slots.map((slot, i) => (
            <PowerUpSlotCard key={i} slot={slot} useKey={useKeys[i]} slotIndex={i} />
          ))}
        </div>
        {/* Controls hint strip — Mario-Kart-feel parity. Shift = JUMP in v2.
            Live ellipse sim still consumes the same bit as DRIFT, but the
            Shift binding doesn't change between sims — only the chip label
            and the server-side semantic do. See
            `.claude/plans/reef-race-v2.md` "Jump Mechanic — NEW". */}
        <div
          style={{
            display: 'flex',
            gap: 14,
            fontSize: 9,
            color: '#ffffff66',
            letterSpacing: '0.14em',
            fontWeight: 700,
            paddingTop: 2,
          }}
        >
          <span><b style={{ color: '#ffd24a' }}>SHIFT</b> · JUMP</span>
          <span style={{ color: '#ffffff22' }}>·</span>
          <span><b style={{ color: '#ffffff99' }}>SPACE/Q</b> · USE ITEM</span>
        </div>
      </div>
    </>
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
  const selfAvatarId  = useActivityStore((s) => s.selfAvatarId);
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
        <LapCounter selfAvatarId={selfAvatarId} />
        <PlacementTile selfAvatarId={selfAvatarId} />
        {/* Phase 4 — clean-checkpoint streak chip (C-IMPL-3 fix). Only
            renders mid-match; auto-dismisses on streak=0. Tier glow tracks
            the shared `streakMilestoneKind` enum so it stays in lock-step
            with the server's edge-trigger broadcast. */}
        <ReefRaceStreakCounter />
        <BestLapTile selfAvatarId={selfAvatarId} />
        {/* Phase 3 — racing-class build summary chip */}
        <ReefRaceBuildSummary />
      </div>

      {/* Top-center: Draft (slipstream) badge — Phase 2 */}
      <ReefRaceDraftBadge />

      {/* Center: Apex verdict + hazard hit + ribbon boost toasts — Phase 2 */}
      <ReefRaceEventToasts />

      {/* Bottom-center: Drift charge sparks (above PowerUpBar).
          TODO(reef-race-v2): retire <ReefRaceDriftSparks /> when the spline
          sim ships — drift mechanic is replaced by JUMP and the sparks bar
          becomes dead UI. Tracked in `.claude/plans/reef-race-v2.md`
          "Drift Mechanic — RETIRED". Live ellipse sim still drives sparks. */}
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
        <PowerUpBar selfAvatarId={selfAvatarId} />
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
