import { sql, type SQL } from 'drizzle-orm';
import { db } from '@clawville/database';
import type { FloorArenaPeriod } from '@clawville/shared';

/**
 * Trading Floor Arena P&L periods (table `floor_arena_periods`, migration 0122; founder 2026-11-12).
 *
 * A P&L reset inserts a period row and deletes nothing. The ACTIVE period is the row with the greatest
 * `starts_at` at or before now. The `period` board window (leaderboard.ts resolveLeaderboardBounds) counts only
 * positions opened at or after its start; with no row there is no period, the `period` window counts every
 * position and every public `period` field is null. `starts_at` is the DB now() of the insert.
 *
 * Read path: `readActiveArenaPeriod`, cached 10 s in process. The reset write path (admin route) inserts with
 * `insertArenaPeriod` and calls `invalidateArenaPeriodCache` after its transaction commits. Another API container
 * sees the new period within the 10 s cache.
 */

export type ArenaPeriodRecord = {
  id: string;
  name: string;
  startsAt: Date;
  reason: string;
  createdBy: string;
  createdAt: Date;
};

type PeriodRow = Record<string, unknown>;
type Executor = Pick<typeof db, 'execute'>;
type ReadRows = (query: SQL) => Promise<PeriodRow[]>;

export const ARENA_PERIOD_CACHE_MS = 10_000;

function rowsOf(result: unknown): PeriodRow[] {
  if (Array.isArray(result)) return result as PeriodRow[];
  const inner = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(inner) ? (inner as PeriodRow[]) : [];
}

const defaultReadRows: ReadRows = async (query) => rowsOf(await db.execute<PeriodRow>(query));

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A DB row to a record; null when a field is missing or unreadable (never a half-read period). */
export function mapArenaPeriodRow(row: PeriodRow | undefined): ArenaPeriodRecord | null {
  if (!row) return null;
  const startsAt = toDate(row.starts_at);
  const createdAt = toDate(row.created_at);
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.reason !== 'string'
    || typeof row.created_by !== 'string' || !startsAt || !createdAt) return null;
  return { id: row.id, name: row.name, startsAt, reason: row.reason, createdBy: row.created_by, createdAt };
}

let cache: { expiresAt: number; period: ArenaPeriodRecord | null } | null = null;

/** The active period at `now` (null when none), cached 10 s in process. */
export async function readActiveArenaPeriod(
  now: Date = new Date(),
  readRows: ReadRows = defaultReadRows,
): Promise<ArenaPeriodRecord | null> {
  if (cache && cache.expiresAt > now.getTime()) return cache.period;
  const list = await readRows(sql`
    SELECT id, name, starts_at, reason, created_by, created_at
    FROM floor_arena_periods
    WHERE starts_at <= ${now.toISOString()}::timestamptz
    ORDER BY starts_at DESC
    LIMIT 1
  `);
  const period = mapArenaPeriodRow(list[0]);
  cache = { expiresAt: now.getTime() + ARENA_PERIOD_CACHE_MS, period };
  return period;
}

/**
 * Inserts a period that starts at the DB now() and returns the row. Pass `tx` to insert inside the caller's
 * transaction. It does NOT clear the cache: the caller calls `invalidateArenaPeriodCache()` after the commit.
 */
export async function insertArenaPeriod(
  input: { id: string; name: string; reason: string; createdBy: string },
  tx: Executor = db,
): Promise<ArenaPeriodRecord> {
  const list = rowsOf(await tx.execute<PeriodRow>(sql`
    INSERT INTO floor_arena_periods (id, name, starts_at, reason, created_by)
    VALUES (${input.id}, ${input.name}, now(), ${input.reason}, ${input.createdBy})
    RETURNING id, name, starts_at, reason, created_by, created_at
  `));
  const period = mapArenaPeriodRow(list[0]);
  if (!period) throw new Error('floor_arena_periods insert returned no readable row');
  return period;
}

export function invalidateArenaPeriodCache(): void {
  cache = null;
}

/** The public shape (`period` field of every windowed arena response). */
export function toPublicPeriod(p: ArenaPeriodRecord | null): FloorArenaPeriod | null {
  return p ? { id: p.id, name: p.name, startsAt: p.startsAt.toISOString() } : null;
}
