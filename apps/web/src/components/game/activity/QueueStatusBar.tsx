'use client';

/**
 * QueueStatusBar — the "{N} in queue · ~{ETA}s" + "{R} rooms active"
 * row used at the top of the activity lobby (idle state).
 *
 * Pure-presentation atom; the parent owns the polling cadence and feeds
 * counts in via props. Two StatusChips side-by-side; collapses to a
 * single column on narrow viewports.
 *
 * Spec: `.claude/plans/q2-research/frontend-spec.md` §2.2.
 */

import { StatusChip } from '@/components/rpg';

export interface QueueStatusBarProps {
  /** Players currently waiting in the queue for THIS activity. */
  inQueue: number;
  /** Estimated wait in seconds; null = "computing" (dash). */
  estimatedSec: number | null;
  /** Active rooms currently in-flight for THIS activity. */
  roomsActive: number;
  /** Optional className on the outer wrapper. */
  className?: string;
}

function formatEta(sec: number | null): string {
  if (sec === null || sec < 0) return '—';
  if (sec < 60) return `~${Math.max(1, Math.round(sec))}s`;
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem === 0 ? `~${mins}m` : `~${mins}m ${rem}s`;
}

export default function QueueStatusBar({
  inQueue,
  estimatedSec,
  roomsActive,
  className,
}: QueueStatusBarProps) {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
      }}
    >
      <StatusChip
        tone="positive"
        size="md"
        label={`${inQueue} in queue · ${formatEta(estimatedSec)}`}
      />
      <StatusChip
        tone="info"
        size="md"
        label={`${roomsActive} room${roomsActive === 1 ? '' : 's'} active`}
      />
    </div>
  );
}
