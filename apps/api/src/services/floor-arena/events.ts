import { db, sql } from '@clawville/database';
import { floorArenaEvents } from '@clawville/database';

/**
 * The arena decision stream (`floor_arena_events`, docs/trading-floor-arena.md §4).
 * Summaries are human readable and at most 280 chars. Retention: rows older than 7 days are pruned except
 * entry / exit / param_change / report, which are the permanent record; pruned pass / skip rows move to
 * floor_arena_events_archive (research, read by no route), the other pruned types are deleted.
 */

export type ArenaEventType = 'scan' | 'pass' | 'skip' | 'entry' | 'exit' | 'param_change' | 'report' | 'status' | 'addon';

export interface ArenaEventInput {
  agentId: string;
  type: ArenaEventType;
  mint?: string | null;
  summary: string;
  data?: Record<string, unknown> | null;
  at?: Date;
}

export const ARENA_EVENT_SUMMARY_MAX = 280;
export const ARENA_EVENT_RETENTION_DAYS = 7;
export const ARENA_EVENT_KEEP_TYPES: readonly ArenaEventType[] = ['entry', 'exit', 'param_change', 'report'];
const PRUNE_BATCH = 5_000;
const PRUNE_MAX_BATCHES = 40;

export function clampSummary(summary: string): string {
  const flat = summary.replace(/\s+/g, ' ').trim();
  return flat.length <= ARENA_EVENT_SUMMARY_MAX ? flat : `${flat.slice(0, ARENA_EVENT_SUMMARY_MAX - 3)}...`;
}

export function toEventRow(event: ArenaEventInput) {
  return {
    agentId: event.agentId,
    type: event.type,
    mint: event.mint ?? null,
    summary: clampSummary(event.summary),
    data: event.data ?? null,
    ...(event.at ? { at: event.at } : {}),
  };
}

type EventWriter = Pick<typeof db, 'insert'>;

/** Batch insert; `executor` lets a caller write the event inside its own transaction. */
export async function writeArenaEvents(events: readonly ArenaEventInput[], executor: EventWriter = db): Promise<void> {
  if (events.length === 0) return;
  for (let offset = 0; offset < events.length; offset += 500) {
    await executor.insert(floorArenaEvents).values(events.slice(offset, offset + 500).map(toEventRow));
  }
}

export async function writeArenaEvent(event: ArenaEventInput, executor: EventWriter = db): Promise<void> {
  await writeArenaEvents([event], executor);
}

/**
 * Research recording (AR-1, migration 0080): pruned rows of these types are MOVED to floor_arena_events_archive
 * (same id) instead of deleted. The other pruned types (scan, status, addon, withdraw) are still deleted.
 */
export const ARENA_EVENT_ARCHIVE_TYPES: readonly ArenaEventType[] = ['pass', 'skip'];

/**
 * Deletes pruneable rows in bounded batches so one pass never holds a long lock, and archives the pass and skip
 * rows of each batch in the SAME statement (an archive failure rolls the delete back, so no row is lost). Returns
 * rows removed from floor_arena_events.
 */
export async function pruneArenaEvents(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ARENA_EVENT_RETENTION_DAYS * 86_400_000);
  const keep = JSON.stringify(ARENA_EVENT_KEEP_TYPES);
  const archive = JSON.stringify(ARENA_EVENT_ARCHIVE_TYPES);
  let total = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
    const result = await db.execute(sql`
      WITH removed AS (
        DELETE FROM floor_arena_events
        WHERE id IN (
          SELECT id FROM floor_arena_events
          WHERE at < ${cutoff.toISOString()}::timestamptz
            AND type NOT IN (SELECT jsonb_array_elements_text(${keep}::jsonb))
          LIMIT ${PRUNE_BATCH}
        )
        RETURNING id, agent_id, at, type, mint, summary, data
      ), archived AS (
        INSERT INTO floor_arena_events_archive (id, agent_id, at, type, mint, summary, data)
        SELECT id, agent_id, at, type, mint, summary, data FROM removed
        WHERE type IN (SELECT jsonb_array_elements_text(${archive}::jsonb))
        RETURNING id
      )
      SELECT (SELECT count(*) FROM removed)::int AS removed, (SELECT count(*) FROM archived)::int AS archived
    `);
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    const deleted = Number((rows[0] as { removed?: unknown } | undefined)?.removed ?? 0);
    total += deleted;
    if (deleted < PRUNE_BATCH) break;
  }
  // AR-1 research retention, same hourly job. Its failure never undoes or blocks the event prune above.
  try {
    await pruneArenaResearch(now);
  } catch (error) {
    console.warn('[floor-arena] research retention failed (no trading effect)', error instanceof Error ? error.message.slice(0, 200) : 'error');
  }
  return total;
}

/**
 * Research retention (AR-1, migration 0080): rows of the research tables are deleted 90 days after their own time:
 * `floor_arena_position_marks.bucket_at`, `floor_arena_position_troughs.updated_at`, `floor_arena_events_archive.at`
 * (each column indexed). A position is never open for more than about a day, so the cut never touches an open
 * position's path. Bounded: at most `batch` rows per statement and `maxBatches` statements per table per run. These
 * tables are research-only: the deletes take no lock on any trading row (no foreign keys, no trading table touched).
 */
export const ARENA_RESEARCH_RETENTION_DAYS = 90;
export const ARENA_RESEARCH_PRUNE_BATCH = 5_000;
export const ARENA_RESEARCH_PRUNE_MAX_BATCHES = 20;

export async function pruneArenaResearch(
  now: Date = new Date(),
  options: { batch?: number; maxBatches?: number } = {},
): Promise<{ marks: number; troughs: number; archive: number }> {
  const batch = options.batch ?? ARENA_RESEARCH_PRUNE_BATCH;
  const maxBatches = options.maxBatches ?? ARENA_RESEARCH_PRUNE_MAX_BATCHES;
  const cutoff = new Date(now.getTime() - ARENA_RESEARCH_RETENTION_DAYS * 86_400_000).toISOString();
  const count = (result: unknown) => (Array.isArray(result) ? result.length : ((result as { rows?: unknown[] }).rows?.length ?? 0));
  const loop = async (statement: () => Promise<unknown>): Promise<number> => {
    let total = 0;
    for (let i = 0; i < maxBatches; i += 1) {
      const deleted = count(await statement());
      total += deleted;
      if (deleted < batch) break;
    }
    return total;
  };
  const marks = await loop(() => db.execute(sql`
    DELETE FROM floor_arena_position_marks
    WHERE (position_id, phase, bucket_at) IN (
      SELECT position_id, phase, bucket_at FROM floor_arena_position_marks
      WHERE bucket_at < ${cutoff}::timestamptz LIMIT ${batch}
    )
    RETURNING 1
  `));
  const troughs = await loop(() => db.execute(sql`
    DELETE FROM floor_arena_position_troughs
    WHERE position_id IN (
      SELECT position_id FROM floor_arena_position_troughs WHERE updated_at < ${cutoff}::timestamptz LIMIT ${batch}
    )
    RETURNING 1
  `));
  const archive = await loop(() => db.execute(sql`
    DELETE FROM floor_arena_events_archive
    WHERE id IN (SELECT id FROM floor_arena_events_archive WHERE at < ${cutoff}::timestamptz LIMIT ${batch})
    RETURNING 1
  `));
  return { marks, troughs, archive };
}

// ---------------------------------------------------------------- formatting for summaries

export function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return 'n/a';
  if (value >= 1) return `$${value.toFixed(4)}`;
  return `$${value.toPrecision(3)}`;
}

export function formatSignedUsd(value: number): string {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return 'age n/a';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

export function tokenLabel(symbol: string | null | undefined, mint: string): string {
  const clean = (symbol ?? '').replace(/[^\p{L}\p{N}$._-]/gu, '').slice(0, 16);
  return clean || `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}
