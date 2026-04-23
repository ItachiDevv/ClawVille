'use client';

/**
 * HudMiniLeaderboard — top-N + self row, top-right stack under
 * `<HudPlacement>`. Spec: frontend-spec.md §3.4.
 */

import type { ActivityScoreEntry } from '@/stores/activity';

export interface HudMiniLeaderboardProps {
  entries: ActivityScoreEntry[];
  selfId: string | null;
  max?: number;
}

export default function HudMiniLeaderboard({ entries, selfId, max = 5 }: HudMiniLeaderboardProps) {
  if (entries.length === 0) return null;

  const visible = entries.slice(0, max);
  // Always include self even if rank > max (spec §3.2 "3. You ◀")
  const selfIncluded = visible.find((e) => e.petId === selfId);
  const selfEntry =
    selfId && !selfIncluded ? entries.find((e) => e.petId === selfId) ?? null : null;

  return (
    <div
      className="claw-panel"
      style={{
        padding: '10px 12px',
        minWidth: 200,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          fontSize: 9,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'rgba(0, 229, 255, 0.7)',
          fontWeight: 700,
          marginBottom: 4,
          borderBottom: '1px solid rgba(0, 229, 255, 0.15)',
          paddingBottom: 4,
        }}
      >
        Standings
      </div>
      {visible.map((e, i) => (
        <Row key={e.petId} rank={i + 1} entry={e} isSelf={e.petId === selfId} />
      ))}
      {selfEntry && (
        <>
          <div
            style={{
              borderTop: '1px dashed rgba(0, 229, 255, 0.25)',
              margin: '4px 0 2px',
            }}
          />
          <Row
            rank={entries.findIndex((x) => x.petId === selfEntry.petId) + 1}
            entry={selfEntry}
            isSelf
          />
        </>
      )}
    </div>
  );
}

function Row({
  rank,
  entry,
  isSelf,
}: {
  rank: number;
  entry: ActivityScoreEntry;
  isSelf: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 4px',
        borderRadius: 4,
        background: isSelf ? 'rgba(0, 230, 118, 0.12)' : 'transparent',
        border: isSelf ? '1px solid rgba(0, 230, 118, 0.4)' : '1px solid transparent',
      }}
    >
      <span
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 11,
          fontWeight: 700,
          width: 22,
          color: isSelf ? '#86efac' : 'rgba(148, 163, 184, 0.8)',
        }}
      >
        #{rank}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 11,
          fontWeight: 600,
          color: isSelf ? '#f0fdf4' : '#e2e8f0',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {entry.displayName}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          fontSize: 11,
          fontWeight: 700,
          color: isSelf ? '#86efac' : '#fde68a',
        }}
      >
        {entry.score}
      </span>
      {isSelf && (
        <span aria-hidden style={{ fontSize: 10, color: '#86efac' }}>
          ◀
        </span>
      )}
    </div>
  );
}
