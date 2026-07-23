'use client';

/**
 * reef-race-event-toasts.tsx
 *
 * Brief on-screen flash indicators for apex verdict + hazard hit events.
 *
 * Components:
 *   - <ReefRaceApexToast> — "PERFECT LINE +5%" (green) or "WIDE LINE -5%"
 *     (amber) centered below the placement tile. Visible for 1 500ms.
 *   - <ReefRaceHazardToast> — "URCHIN FIELD -40%" (red). Visible for 1 000ms.
 *   - <ReefRaceRibbonToast> — "BOOST +30%" (cyan). Visible for 800ms.
 *     (Optional — ribbon collection is already visible from the ribbon mesh
 *      flash but a text confirmation helps new players understand the mechanic.)
 *   - <ReefRaceBoostPadToast> — "BOOST PAD +45%" (cyan).
 *     Visible for 800ms. Self-only (filters `lastBoostPadEvent.avatarId`
 *     against `selfAvatarId` — the store field is unfiltered/all-avatars so
 *     `ReefRacePlayer` can burst-FX any visible rider's pad hit).
 *
 * Subscriptions (all primitive):
 *   - `s.lastApexVerdict` — object reference (new ref on each event)
 *   - `s.lastHazardHitAt` — number (ms)
 *   - `s.lastRibbonCollectedAt` — number (ms)
 *   - `s.lastBoostPadEvent` — object reference,
 *     unfiltered by avatarId (self-filter happens in this file)
 *   - `s.matchPhase` — string
 *
 * Expiry: each component checks `Date.now() - at > DURATION` inside a
 * `useState` + `setInterval` at 200ms tick rate so the toast auto-disappears.
 * No animation library required — CSS opacity transition suffices.
 *
 * Constraints:
 *   - NO drei Text/Billboard (Iris Xe ban).
 *   - All DOM, no Three.js.
 *   - pointerEvents: none — click-through to 3D canvas.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import {
  reefRaceCreatureMotionAt,
  type ReefRaceCreatureMotion,
  type ReefRaceCreatureObstacle,
  type ReefPowerUpKind,
} from '@clawville/shared';
import {
  useActivityStore,
  type ActivityState,
  type ReefPresentationVfxEvent,
} from '@/stores/activity';
import { playActivitySynthCue } from '@/lib/activity-audio';
import { clientSpline } from '@/lib/three/activities/reef-race/reef-race-spline-instance';

// ─── Durations ────────────────────────────────────────────────────────────────

const APEX_DURATION_MS   = 1_500;
const HAZARD_DURATION_MS = 1_000;
const RIBBON_DURATION_MS = 800;
const WALL_SLAM_DURATION_MS = 1_000;
const WIPEOUT_DURATION_MS = 1_200;

const CREATURE_RADAR_MOTION: ReefRaceCreatureMotion = {
  position: { x: 0, y: 0 },
  telegraph: false,
  crossing: false,
  crossingProgress: 0,
};

type ReefItemHitVfxEvent = ReefPresentationVfxEvent & {
  type: 'item-hit';
  itemKind: ReefPowerUpKind;
  attackerAvatarId: string;
  victimAvatarId: string;
};

function latestSelfAttackEvent(state: ActivityState): ReefItemHitVfxEvent | null {
  const selfAvatarId = state.selfAvatarId;
  if (!selfAvatarId) return null;
  for (let i = state.reefPresentationVfxEvents.length - 1; i >= 0; i--) {
    const candidate = state.reefPresentationVfxEvents[i];
    if (
      candidate.type === 'item-hit'
      && candidate.itemKind
      && candidate.attackerAvatarId === selfAvatarId
      && candidate.victimAvatarId
    ) {
      return candidate as ReefItemHitVfxEvent;
    }
  }
  return null;
}

// ─── Shared toast wrapper ─────────────────────────────────────────────────────

interface ToastBoxProps {
  visible: boolean;
  color: string;
  glowColor: string;
  children: React.ReactNode;
  /** Vertical offset from centre — stagger multiple toasts so they don't overlap. */
  topOffset?: number | string;
}

function ToastBox({ visible, color, glowColor, children, topOffset = '38%' }: ToastBoxProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
      style={{
        position: 'absolute',
        top: topOffset,
        left: '50%',
        transform: 'translateX(-50%)',
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transition: 'opacity 150ms ease-out',
        background: 'rgba(0,0,0,0.72)',
        border: `1.5px solid ${color}`,
        borderRadius: 7,
        padding: '6px 18px',
        boxShadow: `0 0 14px ${glowColor}`,
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      {children}
    </div>
  );
}

// ─── Apex toast ───────────────────────────────────────────────────────────────

function ReefRaceApexToast() {
  const lastApexVerdict = useActivityStore((s) => s.lastApexVerdict);
  const matchPhase      = useActivityStore((s) => s.matchPhase);
  const [visible, setVisible] = useState(false);

  // Use a ref to track the current verdict's `at` timestamp so the interval
  // can safely check freshness without closing over a stale reference.
  const atRef = useRef<number>(0);

  useEffect(() => {
    if (!lastApexVerdict || matchPhase !== 'live') {
      setVisible(false);
      return;
    }
    atRef.current = lastApexVerdict.at;
    setVisible(true);

    // Auto-clear after APEX_DURATION_MS.
    const id = setInterval(() => {
      if (Date.now() - atRef.current >= APEX_DURATION_MS) {
        setVisible(false);
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
  }, [lastApexVerdict, matchPhase]);

  if (!lastApexVerdict) return null;

  const isClean = lastApexVerdict.kind === 'clean';
  const color     = isClean ? '#00e676' : '#ff9800';
  const glowColor = isClean ? '#00e67666' : '#ff980066';
  const label     = isClean ? 'PERFECT LINE  +5%' : 'WIDE LINE  −5%';

  return (
    <ToastBox visible={visible} color={color} glowColor={glowColor} topOffset="36%">
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.12em',
          color,
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        }}
      >
        {label}
      </span>
    </ToastBox>
  );
}

// ─── Hazard toast ─────────────────────────────────────────────────────────────

function ReefRaceHazardToast() {
  const lastHazardHitAt = useActivityStore((s) => s.lastHazardHitAt);
  const matchPhase      = useActivityStore((s) => s.matchPhase);
  const [visible, setVisible] = useState(false);
  const atRef = useRef<number>(0);

  useEffect(() => {
    if (!lastHazardHitAt || matchPhase !== 'live') {
      setVisible(false);
      return;
    }
    atRef.current = lastHazardHitAt;
    setVisible(true);

    const id = setInterval(() => {
      if (Date.now() - atRef.current >= HAZARD_DURATION_MS) {
        setVisible(false);
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
  }, [lastHazardHitAt, matchPhase]);

  return (
    <ToastBox visible={visible} color="#f44336" glowColor="#f4433666" topOffset="42%">
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.12em',
          color: '#f44336',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        }}
      >
        URCHIN FIELD  −40%
      </span>
    </ToastBox>
  );
}

// ─── Ribbon toast ─────────────────────────────────────────────────────────────

function ReefRaceRibbonToast() {
  const lastRibbonCollectedAt = useActivityStore((s) => s.lastRibbonCollectedAt);
  const matchPhase            = useActivityStore((s) => s.matchPhase);
  const [visible, setVisible] = useState(false);
  const atRef = useRef<number>(0);

  useEffect(() => {
    if (!lastRibbonCollectedAt || matchPhase !== 'live') {
      setVisible(false);
      return;
    }
    atRef.current = lastRibbonCollectedAt;
    setVisible(true);

    const id = setInterval(() => {
      if (Date.now() - atRef.current >= RIBBON_DURATION_MS) {
        setVisible(false);
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
  }, [lastRibbonCollectedAt, matchPhase]);

  return (
    <ToastBox visible={visible} color="#00e5ff" glowColor="#00e5ff55" topOffset="30%">
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.14em',
          color: '#00e5ff',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        }}
      >
        BOOST  +30%
      </span>
    </ToastBox>
  );
}

// ─── Boost-pad toast (v2 mechanics, 2026-07-10) ───────────────────────────────

const BOOST_PAD_DURATION_MS = 800;

function ReefRaceBoostPadToast() {
  const lastBoostPadEvent = useActivityStore((s) => s.lastBoostPadEvent);
  const selfAvatarId      = useActivityStore((s) => s.selfAvatarId);
  const matchPhase        = useActivityStore((s) => s.matchPhase);
  const [visible, setVisible] = useState(false);
  const atRef = useRef<number>(0);

  // Self-only: the store field is unfiltered (all avatars) so ReefRacePlayer
  // can burst-FX any visible rider's hit; the HUD toast only cares about self.
  const isSelfEvent =
    !!lastBoostPadEvent && !!selfAvatarId && lastBoostPadEvent.avatarId === selfAvatarId;

  useEffect(() => {
    if (!isSelfEvent || matchPhase !== 'live') {
      setVisible(false);
      return;
    }
    atRef.current = lastBoostPadEvent!.at;
    setVisible(true);

    const id = setInterval(() => {
      if (Date.now() - atRef.current >= BOOST_PAD_DURATION_MS) {
        setVisible(false);
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
  }, [isSelfEvent, lastBoostPadEvent, matchPhase]);

  return (
    <ToastBox visible={visible} color="#00e5ff" glowColor="#00e5ff55" topOffset="20%">
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.14em',
          color: '#00e5ff',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        }}
      >
        BOOST PAD  +45%
      </span>
    </ToastBox>
  );
}

function ReefRaceTrickToast() {
  const event = useActivityStore((s) => s.lastSelfTrickLandingEvent);
  const matchPhase = useActivityStore((s) => s.matchPhase);
  const [visible, setVisible] = useState(false);
  const isSelfLanding = event !== null;

  useEffect(() => {
    if (!isSelfLanding || matchPhase !== 'live') {
      setVisible(false);
      return;
    }
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), 1_000);
    return () => window.clearTimeout(id);
  }, [event, isSelfLanding, matchPhase]);

  return (
    <ToastBox visible={visible} color="#ff72e1" glowColor="#ff72e166" topOffset="29%">
      <span
        style={{
          fontSize: 15,
          fontWeight: 850,
          letterSpacing: '0.14em',
          color: '#ff9bea',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        }}
      >
        TRICK! +25%
      </span>
    </ToastBox>
  );
}

function ReefRaceWallSlamToast() {
  const event = useActivityStore((s) => s.lastWallSlamEvent);
  const obstacleEvent = useActivityStore((s) => s.lastObstacleHitEvent);
  const itemEvent = useActivityStore((s) => s.lastSelfItemHitEvent);
  const selfAvatarId = useActivityStore((s) => s.selfAvatarId);
  const matchPhase = useActivityStore((s) => s.matchPhase);
  const [visible, setVisible] = useState(false);
  const isSelfEvent = event?.avatarId === selfAvatarId && selfAvatarId !== null;
  const matchingObstacle = obstacleEvent?.at === event?.at ? obstacleEvent : null;
  const matchingItem = itemEvent?.at === event?.at ? itemEvent : null;
  const label = matchingItem
    ? matchingItem.itemKind === 'rr-whirlpool'
      ? 'WHIRLPOOL SPINOUT!'
      : 'TIDE WAVE SLAM!'
    : matchingObstacle
    ? matchingObstacle.kind === 'driftwood'
      ? 'DRIFTWOOD BUMP'
      : matchingObstacle.kind === 'creature'
        ? 'CREATURE SPINOUT  -40%'
        : 'URCHIN SPINOUT  -40%'
    : 'REEF SLAM  -40%';

  useEffect(() => {
    if (!isSelfEvent || matchPhase !== 'live') {
      setVisible(false);
      return;
    }
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), WALL_SLAM_DURATION_MS);
    return () => window.clearTimeout(id);
  }, [event, isSelfEvent, matchPhase]);

  return (
    <ToastBox visible={visible} color="#ff6b6b" glowColor="#ff6b6b66" topOffset="42%">
      <span
        style={{
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: '0.12em',
          color: '#ff6b6b',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        }}
      >
        {label}
      </span>
    </ToastBox>
  );
}

function ReefRaceWipeoutToast() {
  const event = useActivityStore((s) => s.lastWipeoutEvent);
  const selfAvatarId = useActivityStore((s) => s.selfAvatarId);
  const matchPhase = useActivityStore((s) => s.matchPhase);
  const [visible, setVisible] = useState(false);
  const isSelfEvent = event?.avatarId === selfAvatarId && selfAvatarId !== null;

  useEffect(() => {
    if (!isSelfEvent || matchPhase !== 'live') {
      setVisible(false);
      return;
    }
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), WIPEOUT_DURATION_MS);
    return () => window.clearTimeout(id);
  }, [event, isSelfEvent, matchPhase]);

  return (
    <ToastBox visible={visible} color="#ff5252" glowColor="#ff174466" topOffset="34%">
      <span
        style={{
          fontSize: 18,
          fontWeight: 900,
          letterSpacing: '0.14em',
          color: '#ff8a80',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        }}
      >
        WIPED OUT!
      </span>
    </ToastBox>
  );
}

function ReefRaceCreatureRadar() {
  const room = useActivityStore((state) => state.room);
  const selfAvatarId = useActivityStore((state) => state.selfAvatarId);
  const selfProgress = useActivityStore((state) =>
    state.selfAvatarId
      ? state.entities.get(state.selfAvatarId)?.progress ?? 0
      : 0,
  );
  const serverClockOffsetMs = useActivityStore((state) => state.serverClockOffsetMs);
  const matchPhase = useActivityStore((state) => state.matchPhase);
  const activeWave = useActivityStore((state) => state.activeWave);
  const itemHit = useActivityStore(latestSelfAttackEvent);
  const creatures = useMemo(
    () => (room?.reefSplineZones?.obstacles ?? []).filter(
      (obstacle): obstacle is ReefRaceCreatureObstacle => obstacle.kind === 'creature',
    ),
    [room],
  );
  const [activeCreatureProgress, setActiveCreatureProgress] = useState<number[]>([]);
  const [waveProgress, setWaveProgress] = useState<number | null>(null);
  const [hitPingVisible, setHitPingVisible] = useState(false);
  const hitProgress = useMemo(() => {
    if (!itemHit || itemHit.attackerAvatarId !== selfAvatarId) return null;
    const closest = clientSpline.closestPointOnSpline({
      x: itemHit.position.x,
      z: itemHit.position.y,
    });
    return clientSpline.arclengthFromT(closest.t) / clientSpline.totalArcLength;
  }, [itemHit, selfAvatarId]);

  useEffect(() => {
    if (!itemHit || itemHit.attackerAvatarId !== selfAvatarId) return;
    setHitPingVisible(true);
    const id = window.setTimeout(() => setHitPingVisible(false), 1_400);
    return () => window.clearTimeout(id);
  }, [itemHit, selfAvatarId]);

  useEffect(() => {
    if (!selfAvatarId || matchPhase !== 'live') {
      setActiveCreatureProgress([]);
      setWaveProgress(null);
      return;
    }
    const update = () => {
      const serverNowMs = Date.now() - (serverClockOffsetMs ?? 0);
      const next: number[] = [];
      for (const creature of creatures) {
        const motion = reefRaceCreatureMotionAt(creature, serverNowMs, CREATURE_RADAR_MOTION);
        if (motion.telegraph || motion.crossing) next.push(creature.progress);
      }
      setActiveCreatureProgress((previous) => (
        previous.length === next.length &&
        previous.every((value, index) => value === next[index])
          ? previous
          : next
      ));
      if (!activeWave || serverNowMs >= activeWave.endsAtMs) {
        setWaveProgress(null);
      } else {
        const elapsedMs = Math.max(0, serverNowMs - activeWave.startsAtMs);
        const progress = activeWave.phase === 'active'
          ? activeWave.startProgress
            + elapsedMs * .001 * activeWave.sweepSpeedWuPerSec / clientSpline.totalArcLength
          : activeWave.startProgress;
        setWaveProgress(progress - Math.floor(progress));
      }
    };
    update();
    const id = window.setInterval(update, 100);
    return () => window.clearInterval(id);
  }, [activeWave, creatures, matchPhase, selfAvatarId, serverClockOffsetMs]);

  if (!selfAvatarId || matchPhase !== 'live') return null;
  return (
    <div
      role="img"
      aria-label="Reef Race course radar"
      style={{
        position: 'absolute', top: 62, left: '50%', transform: 'translateX(-50%)',
        width: 230, height: 18, borderRadius: 9, pointerEvents: 'none',
        border: '1px solid rgba(114,229,255,.7)', background: 'rgba(0,20,34,.72)',
        boxShadow: '0 0 10px rgba(0,229,255,.22)',
      }}
    >
      <div style={{ position: 'absolute', left: 8, right: 8, top: 8, height: 2, background: 'rgba(114,229,255,.35)' }} />
      <div
        title="Your lap position"
        style={{
          position: 'absolute', left: `calc(4px + ${Math.max(0, Math.min(1, selfProgress)) * 218}px)`,
          top: 4, width: 9, height: 9, borderRadius: '50%', background: '#ffffff',
          boxShadow: '0 0 7px #72e5ff', transform: 'translateX(-50%)',
        }}
      />
      {activeCreatureProgress.map((progress) => (
        <div
          key={progress}
          title="Surfacing creature"
          style={{
            position: 'absolute', left: `calc(4px + ${progress * 218}px)`, top: 5,
            width: 7, height: 7, transform: 'translateX(-50%) rotate(45deg)',
            background: '#ffb74d', boxShadow: '0 0 8px #ff6d00',
          }}
        />
      ))}
      {waveProgress !== null && (
        <div
          title="Wave sweep"
          style={{
            position: 'absolute', left: `calc(4px + ${waveProgress * 218}px)`,
            top: 2, width: 13, height: 14, borderRadius: 7,
            transform: 'translateX(-50%)', background: 'rgba(121,246,255,.7)',
            boxShadow: '0 0 10px 3px #6ff7ff',
          }}
        />
      )}
      {hitPingVisible && hitProgress !== null && (
        <div
          title="Item hit"
          style={{
            position: 'absolute', left: `calc(4px + ${hitProgress * 218}px)`,
            top: 3, width: 11, height: 11, borderRadius: '50%',
            transform: 'translateX(-50%)', border: '2px solid #ffeb3b',
            boxShadow: '0 0 12px 3px #ff5f36',
          }}
        />
      )}
    </div>
  );
}

// ─── Power-up collect/use confirmation (self inventory, Round 8) ─────────────

const POWER_UP_TOAST_DURATION_MS = 900;
const POWER_UP_LABELS: Readonly<Record<string, string>> = {
  'rr-turbo-bubble': 'TURBO BUBBLE',
  'rr-bubble-shield': 'BUBBLE SHIELD',
  'rr-ink-slick': 'INK SLICK',
  'rr-seeker-jelly': 'SEEKER JELLY',
  'rr-tide-wave': 'TIDE WAVE',
  'rr-whirlpool': 'WHIRLPOOL',
  'rr-puffer-mine': 'PUFFER MINE',
  'rr-bubble-beam': 'BUBBLE BEAM',
  'rr-remora-rocket': 'REMORA ROCKET',
  'rr-current-swap': 'CURRENT SWAP',
};

interface InventoryToastState {
  label: string;
  color: string;
}

function ReefRacePowerUpToast() {
  const inventory = useActivityStore((s) => s.powerUpInventory);
  const matchPhase = useActivityStore((s) => s.matchPhase);
  const previousRef = useRef<Array<{ kind: string | null; charges: number }>>([]);
  const [toast, setToast] = useState<InventoryToastState | null>(null);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = inventory.map((slot) => ({
      kind: slot.kind,
      charges: slot.charges,
    }));

    if (matchPhase !== 'live') {
      setToast(null);
      return;
    }

    // Compare whole-inventory charge totals by kind. Slot-by-slot inference
    // breaks when [used, queued] becomes [queued, empty]: that transition must
    // report the used kind, not claim the queued item fired or was collected.
    const beforeCharges = new Map<string, number>();
    const afterCharges = new Map<string, number>();
    for (const slot of previous) {
      if (slot.kind) {
        beforeCharges.set(
          slot.kind,
          (beforeCharges.get(slot.kind) ?? 0) + slot.charges,
        );
      }
    }
    for (const slot of inventory) {
      if (slot.kind) {
        afterCharges.set(
          slot.kind,
          (afterCharges.get(slot.kind) ?? 0) + slot.charges,
        );
      }
    }

    let nextToast: InventoryToastState | null = null;
    for (const [kind, charges] of beforeCharges) {
      if ((afterCharges.get(kind) ?? 0) < charges) {
        nextToast = {
          label: `${POWER_UP_LABELS[kind] ?? kind.toUpperCase()} FIRED`,
          color: '#ffd24a',
        };
        break;
      }
    }
    if (!nextToast) {
      for (const [kind, charges] of afterCharges) {
        if ((beforeCharges.get(kind) ?? 0) < charges) {
          nextToast = {
            label: `+ ${POWER_UP_LABELS[kind] ?? kind.toUpperCase()}`,
            color: '#6ee7b7',
          };
          break;
        }
      }
    }

    if (!nextToast) return;
    setToast(nextToast);
  }, [inventory, matchPhase]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), POWER_UP_TOAST_DURATION_MS);
    return () => window.clearTimeout(id);
  }, [toast]);

  return (
    <ToastBox
      visible={toast !== null}
      color={toast?.color ?? '#6ee7b7'}
      glowColor={toast?.color ? `${toast.color}66` : '#6ee7b766'}
      topOffset="25%"
    >
      <span
        style={{
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: '0.1em',
          color: toast?.color ?? '#6ee7b7',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        }}
      >
        {toast?.label ?? ''}
      </span>
    </ToastBox>
  );
}

function ReefRaceHitConfirmToast() {
  const event = useActivityStore(latestSelfAttackEvent);
  const victimName = useActivityStore((s) => event
    ? s.scores.get(event.victimAvatarId)?.displayName ?? event.victimAvatarId.slice(-8)
    : 'rival');
  const [visible, setVisible] = useState(false);
  const lastSoundSeqRef = useRef(0);
  const isSelfHit = !!event;
  useEffect(() => {
    if (!isSelfHit) {
      setVisible(false);
      return;
    }
    if (
      event
      && event.seq !== lastSoundSeqRef.current
      && Date.now() - event.at <= 2_000
    ) {
      lastSoundSeqRef.current = event.seq;
      playActivitySynthCue('item-hit');
    }
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), 1_650);
    return () => window.clearTimeout(id);
  }, [event, isSelfHit]);
  return (
    <ToastBox visible={visible} color="#ffeb3b" glowColor="#ff572266" topOffset="18%">
      <span style={{ fontSize: 14, fontWeight: 900, color: '#fff59d', letterSpacing: '.06em' }}>
        💥 {event ? (POWER_UP_LABELS[event.itemKind] ?? event.itemKind) : 'ITEM'} got {victimName}!
      </span>
    </ToastBox>
  );
}

function ReefRaceBoxDramaToast() {
  const collected = useActivityStore((s) => s.lastPowerUpCollectedEvent);
  const dud = useActivityStore((s) => s.lastGambleDudEvent);
  const selfAvatarId = useActivityStore((s) => s.selfAvatarId);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (
      !collected ||
      collected.collectorAvatarId !== selfAvatarId ||
      collected.variant === 'standard' ||
      (collected.variant === 'gamble' && !collected.kind)
    ) return;
    setMessage(collected.variant === 'double' ? 'DOUBLE BOX!  TWO ITEMS' : 'GAMBLE BOX!  LEGENDARY');
    const id = window.setTimeout(() => setMessage(null), 1_250);
    return () => window.clearTimeout(id);
  }, [collected, selfAvatarId]);
  useEffect(() => {
    if (!dud || dud.avatarId !== selfAvatarId) return;
    setMessage('DUD!  -SPEED');
    const id = window.setTimeout(() => setMessage(null), Math.max(1_000, dud.durationMs));
    return () => window.clearTimeout(id);
  }, [dud, selfAvatarId]);
  const isDud = message?.startsWith('DUD');
  return (
    <ToastBox visible={message !== null} color={isDud ? '#ff5252' : '#ffd740'} glowColor={isDud ? '#ff174466' : '#ffea0066'} topOffset="31%">
      <span style={{ fontSize: 17, fontWeight: 950, color: isDud ? '#ff8a80' : '#fff59d', letterSpacing: '.12em' }}>
        {message ?? ''}
      </span>
    </ToastBox>
  );
}

function ReefRaceWaveBanner() {
  const wave = useActivityStore((s) => s.activeWave);
  if (!wave || wave.phase !== 'telegraph') return null;
  return (
    <div role="alert" aria-live="assertive" style={{
      position: 'absolute', top: '14%', left: '50%', transform: 'translateX(-50%)',
      pointerEvents: 'none', padding: '10px 24px', borderRadius: 10,
      color: '#d8ffff', background: 'rgba(0,45,67,.86)', border: '2px solid #72f6ff',
      boxShadow: '0 0 28px #31ddff88', fontSize: 18, fontWeight: 950,
      letterSpacing: '.1em', whiteSpace: 'nowrap',
    }}>
      WAVE INCOMING ▶ SECTOR {wave.sector}
    </div>
  );
}

function ReefRaceFinalLapBanner() {
  const event = useActivityStore((s) => s.lastFinalLapEvent);
  const selfAvatarId = useActivityStore((s) => s.selfAvatarId);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!event || event.avatarId !== selfAvatarId) return;
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), 2_200);
    return () => window.clearTimeout(id);
  }, [event, selfAvatarId]);
  return (
    <ToastBox visible={visible} color="#ff3d71" glowColor="#ff174488" topOffset="11%">
      <span style={{ fontSize: 24, fontWeight: 1000, color: '#fff', letterSpacing: '.16em' }}>FINAL LAP — CHAOS UP!</span>
    </ToastBox>
  );
}

function ReefRaceOvertakeTicker() {
  const placement = useActivityStore((s) => s.placement);
  const phase = useActivityStore((s) => s.matchPhase);
  const previousRef = useRef<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (phase !== 'live' || placement === null) {
      previousRef.current = placement;
      setMessage(null);
      return;
    }
    const previous = previousRef.current;
    previousRef.current = placement;
    if (previous === null || previous === placement) return;
    setMessage(`${placement < previous ? '▲' : '▼'} P${placement}`);
    const id = window.setTimeout(() => setMessage(null), 1_050);
    return () => window.clearTimeout(id);
  }, [phase, placement]);
  return (
    <ToastBox visible={message !== null} color={message?.startsWith('▲') ? '#69f0ae' : '#ff8a80'} glowColor="#00e67655" topOffset="23%">
      <span style={{ fontSize: 19, fontWeight: 950, color: message?.startsWith('▲') ? '#69f0ae' : '#ff8a80' }}>{message ?? ''}</span>
    </ToastBox>
  );
}

function ReefRaceCurrentSwapWarning() {
  const event = useActivityStore((s) => s.lastCurrentSwapEvent);
  const selfAvatarId = useActivityStore((s) => s.selfAvatarId);
  const lastSoundAtRef = useRef(0);
  const active = event?.phase === 'telegraph'
    && event.victimAvatarId === selfAvatarId;
  useEffect(() => {
    if (
      !active
      || !event
      || event.at === lastSoundAtRef.current
      || Date.now() - event.at > 2_000
    ) return;
    lastSoundAtRef.current = event.at;
    playActivitySynthCue('swap-warning');
  }, [active, event]);
  if (!active) return null;
  return (
    <div role="alert" aria-live="assertive" style={{
      position: 'absolute', inset: 0, pointerEvents: 'none',
      border: '12px solid rgba(255,47,226,.78)',
      boxShadow: 'inset 0 0 100px 25px rgba(255,0,204,.58)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ padding: '12px 22px', borderRadius: 10, background: 'rgba(35,0,40,.86)', color: '#ffb3f6', fontSize: 22, fontWeight: 1000, letterSpacing: '.12em' }}>
        CURRENT SWAP LOCK — JUMP!
      </div>
    </div>
  );
}

function ReefRaceVictimItemOverlay() {
  const event = useActivityStore((s) => s.lastSelfItemHitEvent);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!event) {
      setVisible(false);
      return;
    }
    const duration = event.itemKind === 'rr-ink-slick' ? 2_600 : 950;
    const remaining = duration - (Date.now() - event.at);
    if (remaining <= 0) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), remaining);
    return () => window.clearTimeout(id);
  }, [event]);
  if (!visible || !event) return null;
  const ink = event.itemKind === 'rr-ink-slick';
  const whirl = event.itemKind === 'rr-whirlpool';
  return (
    <div aria-hidden style={{
      position: 'absolute', inset: 0, pointerEvents: 'none',
      background: ink
        ? 'radial-gradient(circle at 8% 18%, #08000d 0 8%, transparent 16%), radial-gradient(circle at 24% 30%, #27003b 0 13%, transparent 23%), radial-gradient(circle at 77% 22%, #4b1267 0 12%, transparent 22%), radial-gradient(circle at 92% 66%, #13001d 0 10%, transparent 20%), radial-gradient(circle at 52% 82%, #08000d 0 17%, transparent 29%), radial-gradient(circle at 47% 48%, rgba(37,0,54,.82) 0 19%, transparent 46%), rgba(16,0,24,.64)'
        : whirl
          ? 'repeating-conic-gradient(from 0deg at 50% 50%, rgba(255,45,147,.28) 0 12deg, transparent 12deg 34deg)'
          : 'radial-gradient(circle, transparent 35%, rgba(47,220,255,.55) 100%)',
      boxShadow: ink ? 'inset 0 0 150px 35px #050009' : 'inset 0 0 90px rgba(39,218,255,.75)',
      opacity: ink ? .96 : .78,
    }} />
  );
}

// ─── Public composite component ───────────────────────────────────────────────

/**
 * Mount all Reef Race event toasts together.
 * Placed inside `<ReefRaceHud>` as a single import.
 */
export default function ReefRaceEventToasts() {
  return (
    <>
      <ReefRaceApexToast />
      <ReefRaceHazardToast />
      <ReefRaceRibbonToast />
      <ReefRaceBoostPadToast />
      <ReefRaceTrickToast />
      <ReefRaceWallSlamToast />
      <ReefRaceWipeoutToast />
      <ReefRaceCreatureRadar />
      <ReefRacePowerUpToast />
      <ReefRaceHitConfirmToast />
      <ReefRaceBoxDramaToast />
      <ReefRaceWaveBanner />
      <ReefRaceFinalLapBanner />
      <ReefRaceOvertakeTicker />
      <ReefRaceCurrentSwapWarning />
      <ReefRaceVictimItemOverlay />
    </>
  );
}
