import { FLOOR_ARENA_CONTEST } from '@clawville/shared';
import { readArenaBoard, type ArenaLeaderboardRow } from './leaderboard';

/**
 * "Trading Arena Week 1" (docs/trading-floor-arena.md D6). Prizes are paid by
 * the team by hand after review; nothing here moves money.
 */

export type ArenaContestStatus = 'upcoming' | 'live' | 'ended';

/** D30: after the end, 'provisional' while a position opened inside the window can still change the score. */
export type ArenaContestStandings = 'provisional' | 'final';

export interface ArenaContestView {
  contest: typeof FLOOR_ARENA_CONTEST;
  status: ArenaContestStatus;
  /** Seconds until the start (upcoming) or the end (live); 0 once ended. */
  secondsLeft: number;
  /** null until the contest ends; then 'final' or 'provisional' (D30, `arenaContestStandings`). */
  standings: ArenaContestStandings | null;
  /** Positions opened inside the window that are still open; null until the contest ends. */
  openWindowPositions: number | null;
  /** Top 10 eligible user agents on the contest window. */
  top: ArenaLeaderboardRow[];
  /** House agents on the same window, shown for comparison, never eligible. */
  house: ArenaLeaderboardRow[];
  generatedAt: string;
}

/**
 * D30: the standings stay provisional this long after the end even when no window position is
 * open. The entry engine stamps `opened_at` with the wall clock read inside the entry
 * transaction right before the INSERT (engine.ts openPosition `insertMs`), and the database
 * bounds that transaction (engine.ts ENTRY_TX_TIMEOUT_MS = 60 s `transaction_timeout`, plus a
 * 30 s `statement_timeout` per statement): a position stamped at or before the end commits within
 * 60 s of its clock read or rolls back. 5 minutes is above that bound and the 10 s board and
 * contest caches, so after 'final' no window position can appear.
 */
export const ARENA_CONTEST_FINAL_GRACE_MS = 5 * 60_000;

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

/**
 * D30: before the end nothing is reported (null, null). After it the standings are 'final' only
 * when no position opened inside the window is still open AND the grace above has passed;
 * otherwise 'provisional' with the count of window positions still open.
 */
export function arenaContestStandings(
  now: Date,
  openWindowPositions: number,
  contest: { startsAt: string; endsAt: string } = FLOOR_ARENA_CONTEST,
): { standings: ArenaContestStandings | null; openWindowPositions: number | null } {
  if (arenaContestStatus(now, contest).status !== 'ended') return { standings: null, openWindowPositions: null };
  const settled = now.getTime() >= new Date(contest.endsAt).getTime() + ARENA_CONTEST_FINAL_GRACE_MS;
  return { standings: openWindowPositions === 0 && settled ? 'final' : 'provisional', openWindowPositions };
}

/** Top 10 is re-ranked among eligible rows only, so a house agent never takes a prize place. */
export function contestTop(rows: readonly ArenaLeaderboardRow[], limit = 10): ArenaLeaderboardRow[] {
  return rows.filter((row) => row.eligible).slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
}

export async function readArenaContest(now: Date = new Date()): Promise<ArenaContestView> {
  const board = await readArenaBoard('contest', now);
  return {
    contest: FLOOR_ARENA_CONTEST,
    ...arenaContestStatus(now),
    ...arenaContestStandings(now, board.windowOpenPositions),
    top: contestTop(board.rows),
    house: board.rows.filter((row) => row.kind === 'house'),
    generatedAt: now.toISOString(),
  };
}
