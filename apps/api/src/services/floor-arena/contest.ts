import { FLOOR_ARENA_CONTEST } from '@clawville/shared';
import { readArenaLeaderboard, type ArenaLeaderboardRow } from './leaderboard';

/**
 * "Trading Arena Week 1" (docs/trading-floor-arena.md D6). Prizes are paid by
 * the team by hand after review; nothing here moves money.
 */

export type ArenaContestStatus = 'upcoming' | 'live' | 'ended';

export interface ArenaContestView {
  contest: typeof FLOOR_ARENA_CONTEST;
  status: ArenaContestStatus;
  /** Seconds until the start (upcoming) or the end (live); 0 once ended. */
  secondsLeft: number;
  /** Top 10 eligible user agents on the contest window. */
  top: ArenaLeaderboardRow[];
  /** House agents on the same window, shown for comparison, never eligible. */
  house: ArenaLeaderboardRow[];
  generatedAt: string;
}

export function arenaContestStatus(
  now: Date,
  contest: { startsAt: string; endsAt: string } = FLOOR_ARENA_CONTEST,
): { status: ArenaContestStatus; secondsLeft: number } {
  const start = new Date(contest.startsAt).getTime();
  const end = new Date(contest.endsAt).getTime();
  const at = now.getTime();
  if (at < start) return { status: 'upcoming', secondsLeft: Math.ceil((start - at) / 1000) };
  if (at <= end) return { status: 'live', secondsLeft: Math.ceil((end - at) / 1000) };
  return { status: 'ended', secondsLeft: 0 };
}

/** Top 10 is re-ranked among eligible rows only, so a house agent never takes a prize place. */
export function contestTop(rows: readonly ArenaLeaderboardRow[], limit = 10): ArenaLeaderboardRow[] {
  return rows.filter((row) => row.eligible).slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
}

export async function readArenaContest(now: Date = new Date()): Promise<ArenaContestView> {
  const rows = await readArenaLeaderboard('contest', now);
  return {
    contest: FLOOR_ARENA_CONTEST,
    ...arenaContestStatus(now),
    top: contestTop(rows),
    house: rows.filter((row) => row.kind === 'house'),
    generatedAt: now.toISOString(),
  };
}
