'use client';

/**
 * ReefRaceBuildSummary — Phase 3 HUD chip showing the SELF pet's racing
 * class + level + headline mults. Rendered as a small badge in the top-left
 * of the Reef Race HUD, above PlacementTile / BestLapTile.
 *
 * Subscribes to PRIMITIVES only — `selfRacingClass` and `selfLevel` —
 * populated once on `snapshot.init` from the server's
 * `RoomMeta.reefRacingProfiles[selfPetId]`. Maps are NOT subscribed
 * per-tick, conforming to the audit-verified primitive-only pattern.
 *
 * Visibility: shown during pregame-countdown + the first 3 seconds of LIVE,
 * then fades out. Hidden entirely when no profile is known (non-Reef room
 * or missing data).
 *
 * Spec: `.claude/plans/reef-race-phase3-detailed.md` §7.
 */

import { useEffect, useState } from 'react';
import { useActivityStore } from '@/stores/activity';

type RacingClass = 'agility' | 'strength' | 'intelligence' | 'balanced';

interface ClassPresentation {
  label: string;
  glyph: string;
  color: string;
  headline: string;
}

const CLASS_PRESENTATION: Record<RacingClass, ClassPresentation> = {
  agility: {
    label: 'AGI',
    glyph: '\u{1F300}',
    color: '#5cd2ff',
    headline: 'Tighter turn, +60% slipstream grace',
  },
  strength: {
    label: 'STR',
    glyph: '\u{2694}',
    color: '#ff7a4a',
    headline: 'Sparks 40% faster, 40% knockback resist',
  },
  intelligence: {
    label: 'INT',
    glyph: '\u{1F9E0}',
    color: '#b186ff',
    headline: 'Powerups +20% duration, ribbons +30% wider',
  },
  balanced: {
    label: 'BAL',
    glyph: '\u{2696}',
    color: '#cccccc',
    headline: 'Neutral handling — skill > stats',
  },
};

export default function ReefRaceBuildSummary() {
  const cls = useActivityStore((s) => s.selfRacingClass);
  const level = useActivityStore((s) => s.selfLevel);
  const matchPhase = useActivityStore((s) => s.matchPhase);

  // Show during pregame-countdown + the first 3s of live, then fade.
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (matchPhase === 'pregame-countdown') {
      setVisible(true);
      return;
    }
    if (matchPhase === 'live') {
      setVisible(true);
      const id = setTimeout(() => setVisible(false), 3_000);
      return () => clearTimeout(id);
    }
    setVisible(false);
  }, [matchPhase]);

  if (!cls) return null;

  const pres = CLASS_PRESENTATION[cls];

  return (
    <div
      style={{
        background: 'rgba(0, 0, 0, 0.65)',
        border: `1px solid ${pres.color}55`,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 160,
        opacity: visible ? 1 : 0,
        transition: 'opacity 600ms ease',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          letterSpacing: '0.15em',
          color: pres.color,
        }}
      >
        <span style={{ fontSize: 14 }}>{pres.glyph}</span>
        <span style={{ fontWeight: 700 }}>L{level} {pres.label}</span>
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 11,
          lineHeight: 1.25,
          color: '#ffffffcc',
        }}
      >
        {pres.headline}
      </div>
    </div>
  );
}
