'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FLOOR_ARENA_HARD_RULES } from '@clawville/shared';

import { useIsMobile } from '@/hooks/use-is-mobile';
import { FLOOR_TEXT } from '../tokens';

// Shared look for the arena panels. Same card, button and pill language as the
// rest of the Trading Floor tab, and every tap target is at least 44 px.

export const arenaCardStyle = {
  border: '1px solid rgba(125,211,252,0.18)',
  borderRadius: 12,
  background: 'rgba(2,8,23,0.80)',
  padding: 14,
  color: FLOOR_TEXT.primary,
} as const;

export const arenaInnerCardStyle = {
  border: '1px solid rgba(125,211,252,0.14)',
  borderRadius: 8,
  padding: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
} as const;

export const arenaButtonStyle = {
  minHeight: 44,
  borderRadius: 8,
  border: '1px solid rgba(125,211,252,0.28)',
  background: 'rgba(14,116,144,0.20)',
  color: FLOOR_TEXT.primary,
  padding: '8px 12px',
  cursor: 'pointer',
  fontSize: 13,
} as const;

export const arenaPrimaryButtonStyle = {
  ...arenaButtonStyle,
  border: '1px solid rgba(125,211,252,0.60)',
  background: 'rgba(14,116,144,0.55)',
  color: FLOOR_TEXT.value,
  fontWeight: 700,
} as const;

/** 16 px text: iOS Safari zooms the page into any smaller focused input. */
export const arenaInputStyle = {
  minHeight: 44,
  width: '100%',
  borderRadius: 8,
  border: '1px solid rgba(125,211,252,0.24)',
  background: 'rgba(2,8,23,0.90)',
  color: FLOOR_TEXT.value,
  padding: '8px 10px',
  fontSize: 16,
  boxSizing: 'border-box',
} as const;

export function arenaPillStyle(colour: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    alignSelf: 'flex-start',
    border: `1px solid ${colour}`,
    borderRadius: 999,
    padding: '2px 8px',
    color: colour,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.3,
    whiteSpace: 'nowrap',
  };
}

export function ArenaPill({ colour, children, testId }: { colour: string; children: ReactNode; testId?: string }) {
  return (
    <span style={arenaPillStyle(colour)} data-testid={testId}>
      {children}
    </span>
  );
}

export function ArenaCardTitle({ children }: { children: ReactNode }) {
  return <h3 style={{ margin: '0 0 8px', color: FLOOR_TEXT.value, fontSize: 14 }}>{children}</h3>;
}

export function ArenaMuted({ children, size = 12 }: { children: ReactNode; size?: number }) {
  return <p style={{ margin: 0, color: FLOOR_TEXT.muted, fontSize: size }}>{children}</p>;
}

export function ArenaBackButton({ onClick, label = 'Back to the arena' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}>
      {label}
    </button>
  );
}

/**
 * Sticky action row at the bottom of the modal's scroll area. The safe-area
 * padding keeps the buttons clear of the iPhone home bar when the modal
 * reaches the screen edge.
 */
export function ArenaStickyFooter({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: 8,
        padding: '10px 0',
        paddingBottom: 'max(10px, env(safe-area-inset-bottom))',
        background: 'rgba(2,8,23,0.96)',
        borderTop: '1px solid rgba(125,211,252,0.14)',
      }}
    >
      {children}
    </div>
  );
}

/** The six hard rules, read-only, on every form and in the rules panel. */
export function ArenaHardRules() {
  return (
    <div
      data-testid="arena-hard-rules"
      style={{ ...arenaInnerCardStyle, border: '1px solid rgba(251,191,36,0.35)' }}
    >
      <div style={{ color: FLOOR_TEXT.warning, fontWeight: 700, fontSize: 12 }}>
        Every arena agent follows these rules
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: FLOOR_TEXT.primary }}>
        {FLOOR_ARENA_HARD_RULES.map((rule) => (
          <li key={rule.id}>{rule.label}</li>
        ))}
      </ul>
      <ArenaMuted size={11}>No one can turn these off, and they apply before your own rules.</ArenaMuted>
      <ArenaMuted size={11}>Coins seen only by GeckoTerminal are shown in the feed but are not traded.</ArenaMuted>
    </div>
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A wallet address with a copy button. A browser that blocks the clipboard
 * gets the text selected in a read-only field instead, so it still reaches
 * the player.
 */
export function ArenaCopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [reveal, setReveal] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (reveal) inputRef.current?.select();
  }, [reveal]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <input
          ref={inputRef}
          readOnly
          value={value}
          aria-label={label}
          style={{ ...arenaInputStyle, flex: '1 1 220px', fontSize: 13, fontFamily: 'monospace' }}
        />
        <button
          type="button"
          style={arenaButtonStyle}
          onClick={() => {
            void writeClipboard(value).then((ok) => {
              setCopied(ok);
              setReveal(!ok);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {reveal ? (
        <div style={{ color: FLOOR_TEXT.warning, fontSize: 11 }}>
          This browser blocked the clipboard. The address is selected above; copy it by hand.
        </div>
      ) : null}
    </div>
  );
}

/** A clock for countdowns and "3m ago" labels. Ticks only while `active`. */
export function useArenaNow(active: boolean, intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/**
 * The repo's touch gate (`useIsMobile`, never a width query), resolved after
 * mount like the rest of the tab so the first paint is the desktop layout.
 */
export function useArenaCompact(): boolean {
  const isMobile = useIsMobile();
  const [resolved, setResolved] = useState(false);
  useEffect(() => setResolved(true), []);
  return resolved && isMobile;
}
