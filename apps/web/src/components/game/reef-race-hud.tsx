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
 *
 * ─── v2 (spline sim) HUD swap, gated by `NEXT_PUBLIC_REEF_RACE_USE_SPLINE` ──
 *
 * When `process.env.NEXT_PUBLIC_REEF_RACE_USE_SPLINE === 'true'` the HUD
 * renders the spline-sim variants:
 *
 *   - <ProgressBar> replaces <LapCounter> (top-left). Linear river layout
 *     has no laps; we show the local avatar's `entity.progress` (0..1 fraction
 *     of spline arclength) as "RACE 47%".
 *   - <ReefRaceDriftSparks /> is HIDDEN — drift mechanic retired in v2 (see
 *     `.claude/plans/reef-race-v2.md` "Drift Mechanic — RETIRED"). The
 *     sparks component remains in the tree under the OLD path so the live
 *     ellipse sim keeps its UX while the spline sim rolls out behind a flag.
 *     DELETE the sparks import + component entirely once the flag is removed
 *     post-Phase 1 graduation.
 *   - <WaitAtFinishOverlay> is rendered once the local avatar crosses the
 *     finish line. Server emits `event.crossed_finish` (single racer) and
 *     `event.finish_wait_started` (per-match countdown). Both are wired in
 *     `apps/web/src/stores/activity.ts` to populate
 *     `selfFinished`, `selfPlacement`, `selfTotalMs`, `finishWaitDeadlineAt`,
 *     and `finishedRacers`. The overlay only renders during `matchPhase==='live'`
 *     so it disappears the moment the results modal arrives.
 *   - <PowerUpBar> is unchanged — power-ups are Phase 1 carry-over.
 *
 * The chip strip in <PowerUpBar> already says "SHIFT · JUMP" — no change here.
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
import ReefRaceMiniTurboMeter from './reef-race-miniturbo-meter';

// ─── v2 spline-sim feature flag ──────────────────────────────────────────────
//
// Module-scope read so Next.js's build-time env replacement statically inlines
// `'true'` / `'false'` into the bundle. Live ellipse sim ships unchanged when
// this is unset; spline sim turns on once Wave 2 server work merges.
//
// FEATURE_GATE: reef_race_v2_spline_hud
// Status: HUD wiring landed Wave 2; sim + bots + WS-hub follow in Wave 3.
// Metric to graduate: spline sim runs full match end-to-end without WS errors
// and lap counter/drift sparks confirmed dead (no remaining call sites).
// Current reading: to fill (env flag never enabled in prod yet)
// Review deadline: 2026-05-15
// On deadline: if spline sim hasn't replaced ellipse, delete the v2 branches
// and revert to lap-counter-only HUD.
// Reference: .claude/plans/reef-race-v2.md
const USE_SPLINE = process.env.NEXT_PUBLIC_REEF_RACE_USE_SPLINE === 'true';

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
  // `e.lap` is 0-based (completed laps). Display = lap+1 (current lap number).
  // `e.totalLaps` from server delta; fall back to TOTAL_LAPS constant.
  const { lapDisplay, totalLaps } = useActivityStore((s) => {
    if (!selfAvatarId) return { lapDisplay: 1, totalLaps: TOTAL_LAPS };
    const e = s.entities.get(selfAvatarId) as any;
    const rawLap    = typeof e?.lap       === 'number' ? e.lap       : 0;
    const rawTotal  = typeof e?.totalLaps === 'number' ? e.totalLaps : TOTAL_LAPS;
    // Clamp display: lap 0 = "1/2", lap 1 = "2/2"; never exceed totalLaps.
    const display = Math.min(rawLap + 1, rawTotal);
    return { lapDisplay: display, totalLaps: rawTotal };
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
        {lapDisplay}/{totalLaps}
      </div>
    </div>
  );
}

/**
 * v2 — horizontal arclength progress bar. Replaces <LapCounter> when the
 * spline sim is enabled. Reads `entity.progress` (0..1 fraction of the
 * river spline arclength) emitted on every snapshot.delta tick.
 *
 * Sits in the same top-left slot the lap counter used (200×14 wu wide /
 * tall) so the surrounding HUD column doesn't reflow when the flag flips.
 */
function ProgressBar({ selfAvatarId }: { selfAvatarId: string | null }) {
  const progress = useActivityStore((s) => {
    if (!selfAvatarId) return 0;
    const e = s.entities.get(selfAvatarId) as any;
    const p = typeof e?.progress === 'number' ? e.progress : 0;
    // Clamp defensively — server may briefly tick 1.001 between
    // crossed_finish and the next delta. Avoids "RACE 100%" → "RACE 100%"
    // with a fill-bar overrun visual.
    return Math.max(0, Math.min(1, p));
  });

  const pct = Math.round(progress * 100);
  // Inline-bar layout: dark backdrop, cyan fill, percentage label centered
  // on top of the fill so it stays readable at 0% (label sits on bg) and
  // 100% (label sits on fill). pointer-events handled by the outer HUD.
  return (
    <div
      style={{
        position: 'relative',
        width: 200,
        height: 14,
        background: 'rgba(0, 0, 0, 0.65)',
        border: '1px solid #00e5ff44',
        borderRadius: 8,
        overflow: 'hidden',
      }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={`Race progress ${pct}%`}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: `${pct}%`,
          background:
            'linear-gradient(90deg, #00e5ff 0%, #00b8d4 60%, #00838f 100%)',
          // Cheap easing on the fill so jitter from 15Hz snapshot interp
          // doesn't strobe the bar; cap short so we don't "lag" the racer.
          transition: 'width 120ms linear',
          boxShadow: 'inset 0 0 6px rgba(0, 229, 255, 0.5)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: '0.18em',
          color: '#ffffff',
          textShadow: '0 1px 2px rgba(0, 0, 0, 0.85)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        RACE {pct}%
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

function PowerUpBar({ selfAvatarId: _selfAvatarId }: { selfAvatarId: string | null }) {
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

/**
 * v2 — wait-at-finish centered overlay shown when the local avatar has crossed
 * the finish line but the match is still LIVE (other racers haven't all
 * finished yet, and the per-match timeout hasn't fired). Cosmetic only —
 * pointer-events disabled. Reads:
 *
 *   - `selfPlacement` / `selfTotalMs` (set on `event.crossed_finish` for self)
 *   - `finishWaitDeadlineAt` wall-clock ms (set on `event.finish_wait_started`)
 *   - `finishedRacers[]` (running list — appended on each crossing)
 *
 * Countdown ticks via a 5Hz local interval that just bumps a render counter;
 * the deadline math runs at render time so we never drift from server truth.
 */
function WaitAtFinishOverlay() {
  const matchPhase = useActivityStore((s) => s.matchPhase);
  const selfFinished = useActivityStore((s) => s.selfFinished);
  const selfPlacement = useActivityStore((s) => s.selfPlacement);
  const selfTotalMs = useActivityStore((s) => s.selfTotalMs);
  const finishWaitDeadlineAt = useActivityStore(
    (s) => s.finishWaitDeadlineAt,
  );
  const finishedRacers = useActivityStore((s) => s.finishedRacers);
  const scores = useActivityStore((s) => s.scores);
  const selfAvatarId = useActivityStore((s) => s.selfAvatarId);

  // Render-time deadline recompute — cheap, drift-proof, no interval cleanup.
  // Bump a tick counter at 5Hz so the displayed countdown updates.
  const [, force] = useState(0);
  useEffect(() => {
    if (!selfFinished || matchPhase !== 'live') return;
    const id = window.setInterval(() => force((n) => (n + 1) & 0xff), 200);
    return () => window.clearInterval(id);
  }, [selfFinished, matchPhase]);

  if (!selfFinished || matchPhase !== 'live' || selfPlacement == null) {
    return null;
  }

  const remainingMs =
    finishWaitDeadlineAt != null
      ? Math.max(0, finishWaitDeadlineAt - Date.now())
      : null;
  // Mario-Kart-style mm:ss for the wait countdown — short string fits the
  // overlay footprint and matches the rest of the HUD's typography.
  const countdownLabel =
    remainingMs != null
      ? (() => {
          const totalSec = Math.ceil(remainingMs / 1000);
          const min = Math.floor(totalSec / 60);
          const sec = totalSec % 60;
          return `${min}:${sec.toString().padStart(2, '0')}`;
        })()
      : null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
      aria-live="polite"
    >
      <div
        style={{
          minWidth: 360,
          maxWidth: 480,
          background: 'rgba(0, 0, 0, 0.78)',
          border: '2px solid #ffd60088',
          borderRadius: 16,
          padding: '24px 32px',
          textAlign: 'center',
          boxShadow:
            '0 0 32px rgba(255, 214, 0, 0.35), inset 0 0 16px rgba(255, 214, 0, 0.15)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <div
          style={{
            fontSize: 12,
            letterSpacing: '0.3em',
            color: '#ffd60099',
            fontWeight: 700,
          }}
        >
          FINISHED
        </div>
        <div
          style={{
            fontSize: 44,
            fontWeight: 900,
            color: '#ffd600',
            letterSpacing: '0.05em',
            marginTop: 4,
            lineHeight: 1.05,
          }}
        >
          {ordinal(selfPlacement)}!
        </div>
        {selfTotalMs != null && (
          <div
            style={{
              fontSize: 14,
              color: '#ffffffcc',
              marginTop: 6,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '0.05em',
            }}
          >
            {formatMs(selfTotalMs)}
          </div>
        )}

        <div
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: '1px solid #ffffff22',
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: '0.18em',
              color: '#ffffff88',
              fontWeight: 600,
            }}
          >
            WAITING FOR OTHER RACERS
          </div>
          {countdownLabel && (
            <div
              style={{
                fontSize: 28,
                fontWeight: 800,
                color: '#00e5ff',
                marginTop: 4,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '0.08em',
              }}
            >
              {countdownLabel}
            </div>
          )}
        </div>

        {finishedRacers.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div
              style={{
                fontSize: 9,
                letterSpacing: '0.2em',
                color: '#ffffff66',
                fontWeight: 700,
                marginBottom: 6,
              }}
            >
              FINISHERS ({finishedRacers.length})
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                maxHeight: 140,
                overflow: 'hidden',
              }}
            >
              {finishedRacers
                .slice()
                .sort((a, b) => a.placement - b.placement)
                .map((r) => {
                  const isSelf = selfAvatarId && r.avatarId === selfAvatarId;
                  const name =
                    scores.get(r.avatarId)?.displayName ??
                    (r.avatarId.length > 8 ? `…${r.avatarId.slice(-6)}` : r.avatarId);
                  return (
                    <div
                      key={r.avatarId}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        gap: 12,
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: isSelf
                          ? 'rgba(255, 214, 0, 0.15)'
                          : 'rgba(255, 255, 255, 0.04)',
                        fontSize: 12,
                        color: isSelf ? '#ffd600' : '#ffffffcc',
                      }}
                    >
                      <span
                        style={{
                          fontWeight: isSelf ? 800 : 600,
                          letterSpacing: '0.04em',
                        }}
                      >
                        {ordinal(r.placement)}{' '}
                        <span style={{ opacity: 0.85 }}>{name}</span>
                        {isSelf && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 9,
                              letterSpacing: '0.16em',
                              opacity: 0.85,
                            }}
                          >
                            YOU
                          </span>
                        )}
                      </span>
                      <span
                        style={{
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: 600,
                          color: isSelf ? '#ffd600' : '#ffffff99',
                        }}
                      >
                        {formatMs(r.totalMs)}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </div>
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
        {/* Closed-loop lap circuit (v2 spline + v1 ellipse): both show lap counter.
            The old ProgressBar showed "RACE 47%" which made no sense for a lap
            circuit — replaced by the lap counter that reads `e.lap` (0-based,
            displays lap+1) and `e.totalLaps` from the server delta. */}
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
          TODO(reef-race-v2): DELETE <ReefRaceDriftSparks /> + its import +
          the entire `apps/web/src/components/game/reef-race-drift-sparks.tsx`
          file once `NEXT_PUBLIC_REEF_RACE_USE_SPLINE` graduates from gated
          to default-on — drift mechanic is replaced by JUMP in v2 and the
          sparks bar becomes dead UI. Tracked in `.claude/plans/reef-race-v2.md`
          "Drift Mechanic — RETIRED". Live ellipse sim still drives sparks
          while the flag is off. */}
      {!USE_SPLINE && <ReefRaceDriftSparks />}

      {/* Bottom-center: mini-turbo meter (self-only, hidden until the server
          sends charge data — see reef-race-miniturbo-meter.tsx) stacked
          directly above the power-up bar, both centered together so neither
          hardcodes a `bottom` offset that could drift out of sync. */}
      <div
        style={{
          position: 'absolute',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <ReefRaceMiniTurboMeter />
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

      {/* v2 — wait-at-finish overlay. Internal gates ensure it only renders
          when the local avatar has crossed the finish line AND the match is
          still LIVE. Safe to mount on the ellipse sim too — the gates fail
          closed when `selfFinished` never flips (event.crossed_finish never
          fires on ellipse sim). */}
      {USE_SPLINE && <WaitAtFinishOverlay />}

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
