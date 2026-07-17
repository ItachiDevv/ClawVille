'use client';

/**
 * reef-race-event-toasts.tsx
 *
 * Brief on-screen flash indicators for apex verdict + hazard hit events.
 *
 * Components:
 *   - <ReefRaceApexToast> — "PERFECT LINE +5%" (green) or "DRIFT WIDE -5%"
 *     (amber) centered below the placement tile. Visible for 1 500ms.
 *   - <ReefRaceHazardToast> — "URCHIN FIELD -40%" (red). Visible for 1 000ms.
 *   - <ReefRaceRibbonToast> — "BOOST +30%" (cyan). Visible for 800ms.
 *     (Optional — ribbon collection is already visible from the ribbon mesh
 *      flash but a text confirmation helps new players understand the mechanic.)
 *   - <ReefRaceBoostPadToast> — NEW (2026-07-10) — "BOOST PAD +30%" (cyan).
 *     Visible for 800ms. Self-only (filters `lastBoostPadEvent.avatarId`
 *     against `selfAvatarId` — the store field is unfiltered/all-avatars so
 *     `ReefRacePlayer` can burst-FX any visible rider's pad hit).
 *   - <ReefRaceMiniTurboToast> — NEW (2026-07-10) — "MINI-TURBO!" (cyan,
 *     tier 1) or "SUPER MINI-TURBO!!" (orange, tier 2). Visible for 900ms.
 *     Self-only, same filter pattern as the boost-pad toast.
 *
 * Subscriptions (all primitive):
 *   - `s.lastApexVerdict` — object reference (new ref on each event)
 *   - `s.lastHazardHitAt` — number (ms)
 *   - `s.lastRibbonCollectedAt` — number (ms)
 *   - `s.lastBoostPadEvent` / `s.lastMiniTurboFireEvent` — object reference,
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
  const label     = isClean ? 'PERFECT LINE  +5%' : 'DRIFT WIDE  −5%';

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
        BOOST PAD  +30%
      </span>
    </ToastBox>
  );
}

// ─── Mini-turbo toast (v2 mechanics, 2026-07-10) ──────────────────────────────

const MINI_TURBO_DURATION_MS = 900;

function ReefRaceMiniTurboToast() {
  const lastMiniTurboFireEvent = useActivityStore((s) => s.lastMiniTurboFireEvent);
  const selfAvatarId           = useActivityStore((s) => s.selfAvatarId);
  const matchPhase             = useActivityStore((s) => s.matchPhase);
  const [visible, setVisible] = useState(false);
  const atRef = useRef<number>(0);

  const isSelfEvent =
    !!lastMiniTurboFireEvent && !!selfAvatarId && lastMiniTurboFireEvent.avatarId === selfAvatarId;

  useEffect(() => {
    if (!isSelfEvent || matchPhase !== 'live') {
      setVisible(false);
      return;
    }
    atRef.current = lastMiniTurboFireEvent!.at;
    setVisible(true);

    const id = setInterval(() => {
      if (Date.now() - atRef.current >= MINI_TURBO_DURATION_MS) {
        setVisible(false);
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
  }, [isSelfEvent, lastMiniTurboFireEvent, matchPhase]);

  if (!lastMiniTurboFireEvent) return null;

  const isTier2 = lastMiniTurboFireEvent.level === 2;
  const color     = isTier2 ? '#ff5e2b' : '#5ce1ff';
  const glowColor = isTier2 ? '#ff5e2b66' : '#5ce1ff55';
  const label     = isTier2 ? 'SUPER MINI-TURBO!!' : 'MINI-TURBO!';

  return (
    <ToastBox visible={visible} color={color} glowColor={glowColor} topOffset="15%">
      <span
        style={{
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: '0.1em',
          color,
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        }}
      >
        {label}
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
      <ReefRaceMiniTurboToast />
    </>
  );
}
