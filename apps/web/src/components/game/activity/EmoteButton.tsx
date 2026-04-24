'use client';

/**
 * EmoteButton — single cheer/taunt emote with a per-emote cooldown ring.
 * Spec: frontend-spec.md §7.4 (rate-limited 1/15s per spectator).
 *
 * Stateless cooldown — the parent owns "last fired at" timestamps so two
 * EmoteButton instances (cheer + taunt) don't share a single timer ref.
 * Render math is purely derived from `cooldownUntil - Date.now()`.
 */

import { useEffect, useState } from 'react';

export interface EmoteButtonProps {
  /** Emoji glyph rendered inside the button. */
  glyph: string;
  /** Short label below the glyph. */
  label: string;
  /** Wall-clock millis when the cooldown ends; null/0 = ready. */
  cooldownUntil: number | null;
  /** Total cooldown window in ms (used to compute the ring fill ratio). */
  cooldownMs: number;
  /** Tint — 'positive' for cheers, 'danger' for taunts. */
  tone: 'positive' | 'danger';
  /** Click handler. Parent enforces the cooldown — we just disable while ticking. */
  onClick: () => void;
  /** Accessible label for screen readers. */
  ariaLabel: string;
}

export default function EmoteButton({
  glyph,
  label,
  cooldownUntil,
  cooldownMs,
  tone,
  onClick,
  ariaLabel,
}: EmoteButtonProps) {
  // Force a re-render at 100ms intervals while a cooldown is pending so
  // the ring + countdown text update smoothly. Stops ticking when ready.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!cooldownUntil || cooldownUntil <= Date.now()) return;
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const now = Date.now();
  const remaining = cooldownUntil ? Math.max(0, cooldownUntil - now) : 0;
  const ready = remaining <= 0;
  const ratio = ready ? 0 : Math.min(1, remaining / cooldownMs);

  const accent = tone === 'positive' ? 'rgba(0, 230, 118, 0.85)' : 'rgba(255, 82, 82, 0.85)';
  const accentDim = tone === 'positive' ? 'rgba(0, 230, 118, 0.18)' : 'rgba(255, 82, 82, 0.2)';

  return (
    <button
      type="button"
      data-hud-interactive="true"
      onClick={ready ? onClick : undefined}
      disabled={!ready}
      aria-label={ariaLabel}
      style={{
        position: 'relative',
        width: 60,
        height: 60,
        borderRadius: 12,
        border: `1px solid ${ready ? accent : 'rgba(148, 163, 184, 0.25)'}`,
        background: 'linear-gradient(180deg, rgba(15, 31, 58, 0.95), rgba(6, 13, 23, 0.95))',
        boxShadow: ready ? `0 0 14px ${accentDim}` : 'none',
        cursor: ready ? 'pointer' : 'not-allowed',
        opacity: ready ? 1 : 0.55,
        padding: 0,
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        transition: 'transform 80ms ease-out, box-shadow 200ms',
      }}
      onMouseDown={(e) => {
        if (ready) (e.currentTarget as HTMLButtonElement).style.transform = 'scale(0.94)';
      }}
      onMouseUp={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.0)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.0)';
      }}
    >
      <span aria-hidden style={{ fontSize: 22, lineHeight: 1 }}>
        {glyph}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: ready ? '#e2e8f0' : 'rgba(148, 163, 184, 0.7)',
        }}
      >
        {label}
      </span>
      {!ready && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            bottom: 2,
            right: 4,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 9,
            color: 'rgba(226, 232, 240, 0.85)',
            background: 'rgba(0, 0, 0, 0.55)',
            borderRadius: 4,
            padding: '1px 4px',
          }}
        >
          {Math.ceil(remaining / 1000)}s
        </span>
      )}
      {/*
       * Cooldown ring (SVG arc) — scales the stroke-dashoffset from full
       * circumference to 0 as the cooldown elapses. Rendered above the
       * button content so the visual cue is always on top.
       */}
      {!ready && (
        <svg
          width={60}
          height={60}
          viewBox="0 0 60 60"
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
          }}
        >
          <circle
            cx={30}
            cy={30}
            r={26}
            fill="none"
            stroke={accent}
            strokeWidth={2}
            strokeOpacity={0.85}
            strokeLinecap="round"
            strokeDasharray={2 * Math.PI * 26}
            strokeDashoffset={2 * Math.PI * 26 * (1 - ratio)}
            transform="rotate(-90 30 30)"
          />
        </svg>
      )}
    </button>
  );
}
