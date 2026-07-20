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

import { useState, useEffect, useRef } from 'react';
import { useActivityStore } from '@/stores/activity';

// ─── Durations ────────────────────────────────────────────────────────────────

const APEX_DURATION_MS   = 1_500;
const HAZARD_DURATION_MS = 1_000;
const RIBBON_DURATION_MS = 800;

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

// ─── Power-up collect/use confirmation (self inventory, Round 8) ─────────────

const POWER_UP_TOAST_DURATION_MS = 900;
const POWER_UP_LABELS: Readonly<Record<string, string>> = {
  'rr-turbo-bubble': 'TURBO BUBBLE',
  'rr-bubble-shield': 'BUBBLE SHIELD',
  'rr-ink-slick': 'INK SLICK',
  'rr-seeker-jelly': 'SEEKER JELLY',
  'rr-tide-wave': 'TIDE WAVE',
  'rr-whirlpool': 'WHIRLPOOL',
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
      <ReefRacePowerUpToast />
    </>
  );
}
