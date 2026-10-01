import { db, sql } from '@clawville/database';
import { floorArenaEvents } from '@clawville/database';

/**
 * The arena decision stream (`floor_arena_events`, docs/trading-floor-arena.md §4).
 * Summaries are human readable and at most 280 chars. Retention: rows older than 7 days are pruned except
 * entry / exit / param_change / report, which are the permanent record.
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

/** Deletes pruneable rows in bounded batches so one pass never holds a long lock. Returns rows deleted. */
export async function pruneArenaEvents(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ARENA_EVENT_RETENTION_DAYS * 86_400_000);
  const keep = JSON.stringify(ARENA_EVENT_KEEP_TYPES);
  let total = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
    const result = await db.execute(sql`
      DELETE FROM floor_arena_events
      WHERE id IN (
        SELECT id FROM floor_arena_events
        WHERE at < ${cutoff.toISOString()}::timestamptz
          AND type NOT IN (SELECT jsonb_array_elements_text(${keep}::jsonb))
        LIMIT ${PRUNE_BATCH}
      )
      RETURNING id
    `);
    const deleted = Array.isArray(result) ? result.length : ((result as { rows?: unknown[] }).rows?.length ?? 0);
    total += deleted;
    if (deleted < PRUNE_BATCH) break;
  }
  return total;
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
