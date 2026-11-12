/**
 * One-shot rescore of Trading Floor arena paper exits that booked the DexScreener mark (exit_fill_source
 * 'mark_fallback') while the sell quote was refused as 'quote_far_below_mark'. A row is a candidate when its LAST
 * logged 'quote_far_below_mark' refusal before the close is a DEEP low: quote / mark <= DEEP_LOW_OF_MARK (0.2), the
 * same predicate as the engine rule. A shallow low (quote / mark > 0.2) is not a candidate; it is listed as
 * 'shallow_low'. A candidate is rebooked at that quote: final-leg proceeds = tokens sold x quoteMult x entry price x
 * (1 - 0.5%) (the paper quote sell cost, FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct; docs/trading-floor-arena.md D3).
 *
 *   bun run rescore-mark-over-low-quote.ts                                   # dry run (read-only transaction)
 *   bun run rescore-mark-over-low-quote.ts --apply --confirm=<rows> --plan=<hash>   # rescore, one transaction
 *   bun run rescore-mark-over-low-quote.ts --include=contest,user                   # dry run with flags included
 *
 * The dry run prints the plan hash (sha256 of the rows it would change). --apply recomputes the plan inside its
 * transaction and aborts before any write unless both the row count (--confirm) and the hash (--plan) match.
 *
 * The file is self-contained (imports only `postgres`) so it can be copied alone into the api container.
 * A flagged row is never changed unless --include names every flag it carries. Blocking flags (no_quote,
 * no_exit_event, exit_event_archived, closing_leg_not_mark_fallback, realised_mismatch) can never be included.
 * Apply, one transaction, CAS on every write: (a) the position row (status closed, exit_fill_source mark_fallback, old
 * pnl_usd / realised_usd unchanged) gets the new P&L and the durable audit key entry_features.rescore; (b) the closing
 * exit event (floor_arena_events, kept forever by the prune) gets the new pnlUsd / pnlMult / proceedsUsd / fillSource /
 * fillPriceUsd, the old values in data.rescoredFrom, and a rewritten summary. No separate event row is written (a
 * 'status' row is public and pruned after 7 days).
 * A second run finds nothing to change: a changed row gets exit_fill_source 'quote_confirmed', and the selection
 * reads only 'mark_fallback' rows.
 */
import { createHash } from 'node:crypto';
import postgres from 'postgres';

/** Mirrors FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct (asserted by the test). */
export const SELL_HAIRCUT_PCT = 0.5;
/** Mirrors FLOOR_ARENA_CONTEST arena-week-1 (asserted by the test). The contest is settled and paid. */
export const CONTEST_WINDOW = { startsAt: '2026-09-30T22:00:00Z', endsAt: '2026-10-05T03:59:59Z' } as const;
/** A refused quote at or under this share of the mark is a deep low (glitch-check 2026-11-12: no transient glitch was ever <= 0.1x). */
export const DEEP_LOW_OF_MARK = 0.2;
export const STALE_QUOTE_MS = 5 * 60_000;
/** A refusal event of the closing tick carries the DB time, which can be a few seconds after closed_at (the tick time). */
export const CLOSE_GRACE_MS = 120_000;
export const RESCORE_REASON = 'rescore_mark_over_low_quote';
const MATCH_EPS_USD = 0.000002;
const SUMMARY_MAX = 280;

export const INCLUDABLE_FLAGS = ['contest', 'user', 'multi_leg', 'stale_quote'] as const;
export const BLOCKING_FLAGS = ['no_quote', 'no_exit_event', 'exit_event_archived', 'closing_leg_not_mark_fallback', 'realised_mismatch'] as const;
export type IncludableFlag = (typeof INCLUDABLE_FLAGS)[number];
export type BlockingFlag = (typeof BLOCKING_FLAGS)[number];
export type RowFlag = IncludableFlag | BlockingFlag;

export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
export function round9(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

export interface RefusalEvent {
  id: number;
  atMs: number;
  refusal: string | null;
  /** quote price / entry price */
  quoteMult: number | null;
  /** mark price / entry price at the refusal */
  markMult: number | null;
  /** Computed in PostgreSQL at full precision: at <= closed_at + interval '120 seconds' (the loader sets it). */
  inGrace?: boolean;
  /** Computed in PostgreSQL at full precision: at <= closed_at (the loader sets it). */
  beforeClose?: boolean;
}

export interface ExitEvent {
  id: number;
  atMs: number;
  fraction: number;
  proceedsUsd: number;
  fillSource: string | null;
  closed: boolean;
  /** Found in floor_arena_events_archive instead of floor_arena_events (the apply UPDATE could not reach it). */
  archived?: boolean;
  summary?: string;
  reason?: string | null;
  leg?: number | null;
  stopKind?: string | null;
  fillPriceUsd?: number | null;
  pnlUsd?: number | null;
  pnlMult?: number | null;
}

export interface PositionInput {
  id: string;
  agentId: string;
  agentKind: string;
  symbol: string | null;
  mint: string;
  openedAtMs: number;
  closedAtMs: number;
  sizeUsd: number;
  tokens: number;
  entryPriceUsd: number;
  realisedUsd: number;
  pnlUsd: number;
}

/**
 * The rescore quote: the last 'quote_far_below_mark' refusal logged before the close. "Before" means an id lower
 * than the closing exit event (both tables share one id sequence) and a time no later than closed_at + grace;
 * without an exit event, a time no later than closed_at. The loader computes both time tests in PostgreSQL at full
 * (microsecond) precision (inGrace / beforeClose); the millisecond compare is only the fallback for rows without them.
 */
export function selectRescoreQuote(refusals: readonly RefusalEvent[], closedAtMs: number, closingExitId: number | null): RefusalEvent | null {
  let best: RefusalEvent | null = null;
  for (const r of refusals) {
    if (r.refusal !== 'quote_far_below_mark') continue;
    const inGrace = r.inGrace ?? r.atMs <= closedAtMs + CLOSE_GRACE_MS;
    const beforeClose = r.beforeClose ?? r.atMs <= closedAtMs;
    if (closingExitId !== null ? (r.id >= closingExitId || !inGrace) : !beforeClose) continue;
    if (best === null || r.id > best.id) best = r;
  }
  return best;
}

/** quote / mark of a refusal; null when either multiple is missing or not positive. */
export function quoteOfMark(q: RefusalEvent): number | null {
  if (q.quoteMult === null || q.markMult === null || !(q.quoteMult > 0) || !(q.markMult > 0)) return null;
  return q.quoteMult / q.markMult;
}

/** The shared predicate: the quote is a deep low (quote / mark <= 0.2). A missing ratio is not shallow (it blocks as no_quote). */
export function isShallowLow(q: RefusalEvent | null): boolean {
  if (q === null) return false;
  const ratio = quoteOfMark(q);
  return ratio !== null && ratio > DEEP_LOW_OF_MARK;
}

/** Final-leg proceeds at the quote: tokens x fraction x quoteMult x entry price x (1 - sell haircut). */
export function quoteProceedsUsd(tokens: number, fraction: number, quoteMult: number, entryPriceUsd: number): number {
  const proceeds = tokens * fraction * quoteMult * entryPriceUsd * (1 - SELL_HAIRCUT_PCT / 100);
  return Number.isFinite(proceeds) && proceeds > 0 ? proceeds : 0;
}

export interface Rescore {
  newFinalProceedsUsd: number;
  newRealisedUsd: number;
  newPnlUsd: number;
  newPnlMult: number;
}

/** The engine's applyExitFill math with the final leg replaced: realised is rounded to 6, mult to 9 places. */
export function rescorePosition(p: PositionInput, finalLeg: ExitEvent, quoteMult: number): Rescore {
  const newFinalProceedsUsd = quoteProceedsUsd(p.tokens, finalLeg.fraction, quoteMult, p.entryPriceUsd);
  const newRealisedUsd = round6(p.realisedUsd - finalLeg.proceedsUsd + newFinalProceedsUsd);
  return {
    newFinalProceedsUsd,
    newRealisedUsd,
    newPnlUsd: round6(newRealisedUsd - p.sizeUsd),
    newPnlMult: round9(newRealisedUsd / p.sizeUsd),
  };
}

/** The exit event that closed the position: the newest one marked closed, else the newest one. */
export function closingExit(exits: readonly ExitEvent[]): ExitEvent | null {
  let best: ExitEvent | null = null;
  for (const e of exits) {
    if (best === null || (e.closed && !best.closed) || (e.closed === best.closed && e.id > best.id)) best = e;
  }
  return best;
}

export function rowFlags(p: PositionInput, exits: readonly ExitEvent[], quote: RefusalEvent | null): RowFlag[] {
  const flags: RowFlag[] = [];
  const closing = closingExit(exits);
  if (closing === null) flags.push('no_exit_event');
  else {
    if (closing.archived) flags.push('exit_event_archived');
    if (closing.fillSource !== 'mark_fallback') flags.push('closing_leg_not_mark_fallback');
  }
  const exitSum = exits.reduce((sum, e) => sum + e.proceedsUsd, 0);
  if (exits.length > 0 && Math.abs(exitSum - p.realisedUsd) > MATCH_EPS_USD * Math.max(1, exits.length)) flags.push('realised_mismatch');
  if (quote === null || quoteOfMark(quote) === null) flags.push('no_quote');
  else if (p.closedAtMs - quote.atMs > STALE_QUOTE_MS) flags.push('stale_quote');
  if (p.openedAtMs >= Date.parse(CONTEST_WINDOW.startsAt) && p.openedAtMs <= Date.parse(CONTEST_WINDOW.endsAt)) flags.push('contest');
  if (p.agentKind !== 'house') flags.push('user');
  if (exits.length > 1) flags.push('multi_leg');
  return flags;
}

/** True when apply mode may change the row: no blocking flag, and every other flag named by --include. */
export function rowAllowed(flags: readonly RowFlag[], include: ReadonlySet<IncludableFlag>): boolean {
  return flags.every((f) => (INCLUDABLE_FLAGS as readonly string[]).includes(f) && include.has(f as IncludableFlag));
}

const REASON_WORDS: Record<string, string> = { tp: 'take profit', stop: 'stop', trail: 'trailing stop', time: 'time cap' };
const STOP_KIND_WORDS: Record<string, string> = { breakeven: 'breakeven stop', liq_drop: 'liquidity drop' };

/** Mirrors events.ts tokenLabel. */
export function tokenLabel(symbol: string | null | undefined, mint: string): string {
  const clean = (symbol ?? '').replace(/[^\p{L}\p{N}$._-]/gu, '').slice(0, 16);
  return clean || `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

/** A multiple for the summary: 2 decimals at or above 0.1x, else 2 significant digits (0.0037x, never 0.00x). */
export function formatMult(mult: number): string {
  if (!Number.isFinite(mult) || mult <= 0 || mult >= 0.1) return mult.toFixed(2);
  return mult.toFixed(Math.min(20, 1 - Math.floor(Math.log10(mult))));
}

function signedUsd(value: number): string {
  return `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;
}

/**
 * The rewritten exit summary, in the wording of engine.ts exitSummary with the rescored numbers, plus the rescore
 * note. The TP leg count comes from the old summary ("TP 1 of 3"), since the event data does not carry it.
 */
export function rescoredExitSummary(input: {
  label: string; exit: ExitEvent; quoteMult: number; proceedsUsd: number; pnlUsd: number; sizeUsd: number; rescoredOn: string;
}): string {
  const { label, exit, quoteMult, proceedsUsd, pnlUsd, sizeUsd, rescoredOn } = input;
  const pct = Math.round(exit.fraction * 100);
  let why: string;
  if (exit.reason === 'tp') {
    const legs = /\(TP \d+ of (\d+)\)/.exec(exit.summary ?? '')?.[1];
    why = legs ? `TP ${exit.leg ?? 1} of ${legs}` : `TP ${exit.leg ?? 1}`;
  } else if (exit.reason === 'stop' && exit.stopKind && STOP_KIND_WORDS[exit.stopKind]) {
    why = STOP_KIND_WORDS[exit.stopKind]!;
  } else {
    why = REASON_WORDS[exit.reason ?? ''] ?? (exit.reason ?? 'exit');
  }
  const pnlPct = (100 * pnlUsd) / sizeUsd;
  const text = `Sold ${pct}% of ${label} at ${formatMult(quoteMult)}x (${why}) for $${proceedsUsd.toFixed(2)} via the last logged sell quote. `
    + `Closed: P&L ${signedUsd(pnlUsd)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%). `
    + `Rescored on ${rescoredOn}: the mark was far above every sell quote.`;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= SUMMARY_MAX ? flat : `${flat.slice(0, SUMMARY_MAX - 3)}...`;
}

export interface OldPositionText {
  pnlUsd: string;
  pnlMult: string | null;
  realisedUsd: string;
}

/** The value merged into entry_features under the key `rescore` (the durable audit on the position row). */
export function positionRescorePayload(input: {
  atIso: string; old: OldPositionText; rescore: Rescore; quote: RefusalEvent; exitEventId: number; flags: readonly RowFlag[];
}): Record<string, unknown> {
  const { atIso, old, rescore, quote, exitEventId, flags } = input;
  return {
    reason: RESCORE_REASON,
    at: atIso,
    old: { pnl_usd: old.pnlUsd, pnl_mult: old.pnlMult, realised_usd: old.realisedUsd, exit_fill_source: 'mark_fallback' },
    new: {
      pnl_usd: String(rescore.newPnlUsd), pnl_mult: String(rescore.newPnlMult), realised_usd: String(rescore.newRealisedUsd),
      exit_fill_source: 'quote_confirmed',
    },
    quoteEventId: quote.id,
    quoteMult: quote.quoteMult,
    markMult: quote.markMult,
    quoteAt: new Date(quote.atMs).toISOString(),
    exitEventId,
    flags: [...flags],
  };
}

/** The jsonb merged into the closing exit event's data: the new fill and P&L, the old values under rescoredFrom. */
export function exitEventPatch(input: {
  exit: ExitEvent; rescore: Rescore; quoteMult: number; entryPriceUsd: number; atIso: string; quoteEventId: number;
}): Record<string, unknown> {
  const { exit, rescore, quoteMult, entryPriceUsd, atIso, quoteEventId } = input;
  return {
    pnlUsd: rescore.newPnlUsd,
    pnlMult: rescore.newPnlMult,
    proceedsUsd: rescore.newFinalProceedsUsd,
    fillSource: 'quote_confirmed',
    fillPriceUsd: quoteMult * entryPriceUsd,
    rescoredFrom: {
      reason: RESCORE_REASON, at: atIso, quoteEventId,
      pnlUsd: exit.pnlUsd ?? null, pnlMult: exit.pnlMult ?? null, proceedsUsd: exit.proceedsUsd,
      fillSource: exit.fillSource, fillPriceUsd: exit.fillPriceUsd ?? null, summary: exit.summary ?? null,
    },
  };
}

export interface CliArgs {
  apply: boolean;
  confirm: number | null;
  plan: string | null;
  include: Set<IncludableFlag>;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { apply: false, confirm: null, plan: null, include: new Set() };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--confirm=')) {
      const raw = arg.slice('--confirm='.length);
      if (!/^\d+$/.test(raw)) throw new Error(`--confirm needs a whole number, got "${raw}"`);
      args.confirm = Number(raw);
    } else if (arg.startsWith('--plan=')) {
      const raw = arg.slice('--plan='.length);
      if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error(`--plan needs the 64-hex plan hash the dry run prints, got "${raw}"`);
      args.plan = raw;
    } else if (arg.startsWith('--include=')) {
      for (const name of arg.slice('--include='.length).split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!(INCLUDABLE_FLAGS as readonly string[]).includes(name)) throw new Error(`--include: unknown or blocking flag "${name}" (allowed: ${INCLUDABLE_FLAGS.join(', ')})`);
        args.include.add(name as IncludableFlag);
      }
    } else throw new Error(`unknown argument "${arg}"`);
  }
  if (args.apply && args.confirm === null) throw new Error('--apply needs --confirm=<row count>');
  if (args.apply && args.plan === null) throw new Error('--apply needs --plan=<hash> from the dry run');
  if (!args.apply && (args.confirm !== null || args.plan !== null)) throw new Error('--confirm and --plan are only valid with --apply');
  return args;
}

/** Exact DB text of every value the math reads or the audit records, compared by the position CAS. */
export interface PositionCasText {
  sizeUsd: string;
  tokens: string;
  entryPriceUsd: string;
  remainingFraction: string;
  /** closed_at::text (full precision; the selection of the quote depends on it). */
  closedAtText: string;
}

/**
 * The exit event values the patch replaces, read as data->>'key' (numeric text, NULL for a JSON null or a missing key)
 * and compared by the exit-event CAS as numeric. Staging apply 2026-11-12 (event 211119): a postgres.js string bound
 * as `$n::jsonb` arrives as a JSON STRING ("22.17..."), never equal to the stored JSON number, so a jsonb compare
 * can never match.
 */
export interface ExitCasJson {
  proceedsUsd: string | null;
  fraction: string | null;
  pnlUsd: string | null;
  pnlMult: string | null;
  fillPriceUsd: string | null;
}

/** The selected refusal event as stored (->> texts, at::text), re-read FOR SHARE and re-checked inside the apply. */
export interface QuoteCasText {
  id: number;
  atText: string;
  quoteMult: string | null;
  markMult: string | null;
}

export interface RescoreRow {
  input: PositionInput;
  agentName: string;
  old: OldPositionText;
  cas: PositionCasText;
  exits: ExitEvent[];
  closing: ExitEvent | null;
  closingJson: ExitCasJson | null;
  quote: RefusalEvent | null;
  quoteCas: QuoteCasText | null;
  /** Every exit_quote_refused event of the position the loader read (for the dry-run report). */
  refusals: RefusalEvent[];
  flags: RowFlag[];
  rescore: Rescore | null;
  allowed: boolean;
}
type Row = RescoreRow;

/**
 * One plan line per row the run changes: position id | exit event id | old pnl_usd | old realised_usd | new pnl_usd |
 * refusal event id | its quoteMult | its markMult (the stored ->> texts).
 */
export function planLines(rows: readonly RescoreRow[]): string[] {
  return rows.filter((r) => r.allowed)
    .map((r) => [
      r.input.id, String(r.closing?.id ?? ''), r.old.pnlUsd, r.old.realisedUsd, String(r.rescore?.newPnlUsd ?? ''),
      String(r.quoteCas?.id ?? ''), r.quoteCas?.quoteMult ?? '', r.quoteCas?.markMult ?? '',
    ].join('|'))
    .sort();
}

/** sha256 over the sorted plan lines (newline-joined). The dry run prints it; --apply must name it. */
export function planHash(rows: readonly RescoreRow[]): string {
  return createHash('sha256').update(planLines(rows).join('\n')).digest('hex');
}

/** Throws unless the plan recomputed inside the apply transaction matches --confirm and --plan exactly. */
export function checkPlan(rows: readonly RescoreRow[], confirm: number | null, plan: string | null): void {
  const count = rows.filter((r) => r.allowed).length;
  if (confirm !== count) throw new Error(`--confirm=${confirm} but ${count} rows would change; nothing written`);
  const hash = planHash(rows);
  if (plan !== hash) throw new Error(`--plan=${plan} but the current plan is ${hash}; nothing written`);
}

/** The subset of a postgres.js transaction the apply step uses (a fake in the tests). */
export interface Exec {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<readonly unknown[]>;
  json(value: unknown): unknown;
}

/**
 * Writes the rescore of every allowed row. Each UPDATE is a CAS on every input of the math and every old value the
 * audit records; a CAS miss throws, which rolls back the caller's transaction (nothing partial is kept).
 */
export async function applyRows(exec: Exec, rows: readonly RescoreRow[], atIso: string, rescoredOn: string): Promise<number> {
  let written = 0;
  for (const c of rows) {
    if (!c.allowed) continue;
    const r = c.rescore!;
    const closing = c.closing!;
    const j = c.closingJson!;
    const quote = c.quote!;
    const qc = c.quoteCas!;
    // The selected refusal must be unchanged (live table, else archive), and stays locked until the commit.
    // Timestamps bind as ::text::timestamptz: postgres.js serializes a $n inferred as timestamptz through a JS Date,
    // which drops the microseconds (staging 2026-11-12: refusal 211099 at .754843 was bound as .754 and never matched).
    const refusalMatch = (table: 'live' | 'archive') => table === 'live'
      ? exec`
        SELECT id FROM floor_arena_events
        WHERE id = ${qc.id} AND type = 'skip' AND at = ${qc.atText}::text::timestamptz
          AND data->>'reason' = 'exit_quote_refused' AND data->>'refusal' = 'quote_far_below_mark'
          AND data->>'positionId' = ${c.input.id}
          AND (data->>'quoteMult')::numeric IS NOT DISTINCT FROM ${qc.quoteMult}::numeric
          AND (data->>'markMult')::numeric IS NOT DISTINCT FROM ${qc.markMult}::numeric
        FOR SHARE`
      : exec`
        SELECT id FROM floor_arena_events_archive
        WHERE id = ${qc.id} AND type = 'skip' AND at = ${qc.atText}::text::timestamptz
          AND data->>'reason' = 'exit_quote_refused' AND data->>'refusal' = 'quote_far_below_mark'
          AND data->>'positionId' = ${c.input.id}
          AND (data->>'quoteMult')::numeric IS NOT DISTINCT FROM ${qc.quoteMult}::numeric
          AND (data->>'markMult')::numeric IS NOT DISTINCT FROM ${qc.markMult}::numeric
        FOR SHARE`;
    if ((await refusalMatch('live')).length !== 1 && (await refusalMatch('archive')).length !== 1) {
      throw new Error(`refusal event ${qc.id} of position ${c.input.id} changed or is gone; transaction rolled back`);
    }
    // No refusal of this position may sit between the selected one and the closing exit event (same cutoff as the
    // selection). Closed positions never receive new refusal events (the engine writes them only in executeExit, for
    // status='open' rows), so this check plus the in-transaction plan recompute covers a selection that would change.
    const later = await exec`
      SELECT id FROM floor_arena_events
      WHERE type = 'skip' AND data->>'reason' = 'exit_quote_refused' AND data->>'positionId' = ${c.input.id}
        AND id > ${qc.id} AND id < ${closing.id}
        AND at <= ${c.cas.closedAtText}::text::timestamptz + interval '120 seconds'
      UNION ALL
      SELECT id FROM floor_arena_events_archive
      WHERE type = 'skip' AND data->>'reason' = 'exit_quote_refused' AND data->>'positionId' = ${c.input.id}
        AND id > ${qc.id} AND id < ${closing.id}
        AND at <= ${c.cas.closedAtText}::text::timestamptz + interval '120 seconds'
      LIMIT 1`;
    if (later.length !== 0) {
      throw new Error(`position ${c.input.id} has a refusal newer than ${qc.id} before exit event ${closing.id}; transaction rolled back`);
    }
    const summary = newSummary(c, rescoredOn);
    if (summary === null || closing.summary === undefined) throw new Error(`position ${c.input.id}: no summary to rewrite; nothing written`);
    const audit = positionRescorePayload({ atIso, old: c.old, rescore: r, quote, exitEventId: closing.id, flags: c.flags });
    const updated = await exec`
      UPDATE floor_arena_positions
      SET realised_usd = ${String(r.newRealisedUsd)}::numeric, pnl_usd = ${String(r.newPnlUsd)}::numeric,
          pnl_mult = ${String(r.newPnlMult)}::numeric, exit_fill_source = 'quote_confirmed',
          entry_features = COALESCE(entry_features, '{}'::jsonb) || jsonb_build_object('rescore', ${exec.json(audit)}::jsonb)
      WHERE id = ${c.input.id} AND status = 'closed' AND exit_fill_source = 'mark_fallback'
        AND pnl_usd = ${c.old.pnlUsd}::numeric AND pnl_mult IS NOT DISTINCT FROM ${c.old.pnlMult}::numeric
        AND realised_usd = ${c.old.realisedUsd}::numeric AND size_usd = ${c.cas.sizeUsd}::numeric
        AND tokens = ${c.cas.tokens}::numeric AND entry_price_usd = ${c.cas.entryPriceUsd}::numeric
        AND remaining_fraction = ${c.cas.remainingFraction}::numeric
        AND closed_at = ${c.cas.closedAtText}::text::timestamptz
        AND NOT (COALESCE(entry_features, '{}'::jsonb) ? 'rescore')
      RETURNING id`;
    if (updated.length !== 1) throw new Error(`CAS failed on position ${c.input.id}; transaction rolled back`);
    const patch = exitEventPatch({ exit: closing, rescore: r, quoteMult: quote.quoteMult!, entryPriceUsd: c.input.entryPriceUsd, atIso, quoteEventId: quote.id });
    const exitUpdated = await exec`
      UPDATE floor_arena_events
      SET data = data || ${exec.json(patch)}::jsonb, summary = ${summary}
      WHERE id = ${closing.id} AND type = 'exit' AND data->>'positionId' = ${c.input.id}
        AND data->>'fillSource' = 'mark_fallback'
        AND (data->>'proceedsUsd')::numeric IS NOT DISTINCT FROM ${j.proceedsUsd}::numeric
        AND (data->>'fraction')::numeric IS NOT DISTINCT FROM ${j.fraction}::numeric
        AND (data->>'pnlUsd')::numeric IS NOT DISTINCT FROM ${j.pnlUsd}::numeric
        AND (data->>'pnlMult')::numeric IS NOT DISTINCT FROM ${j.pnlMult}::numeric
        AND (data->>'fillPriceUsd')::numeric IS NOT DISTINCT FROM ${j.fillPriceUsd}::numeric
        AND summary = ${closing.summary}
        AND NOT (data ? 'rescoredFrom')
      RETURNING id`;
    if (exitUpdated.length !== 1) throw new Error(`CAS failed on exit event ${closing.id} of position ${c.input.id}; transaction rolled back`);
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------- DB side

type Sql = postgres.Sql | postgres.TransactionSql;

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export async function loadRows(sql: Sql, include: ReadonlySet<IncludableFlag>): Promise<{ candidates: Row[]; shallow: Row[] }> {
  const positions = await sql<{
    id: string; agent_id: string; kind: string; name: string; symbol: string | null; mint: string;
    opened_at: Date; closed_at: Date; size_usd: string; tokens: string; entry_price_usd: string;
    realised_usd: string; pnl_usd: string; pnl_mult: string | null; remaining_fraction: string; closed_at_text: string;
  }[]>`
    SELECT p.id, p.agent_id, a.kind, a.name, p.symbol, p.mint, p.opened_at, p.closed_at, p.size_usd::text, p.tokens::text,
           p.entry_price_usd::text, p.realised_usd::text, p.pnl_usd::text, p.pnl_mult::text, p.remaining_fraction::text,
           p.closed_at::text AS closed_at_text
    FROM floor_arena_positions p JOIN floor_arena_agents a ON a.id = p.agent_id
    WHERE p.status = 'closed' AND p.exit_fill_source = 'mark_fallback' AND p.pnl_usd IS NOT NULL
    ORDER BY p.closed_at`;
  if (positions.length === 0) return { candidates: [], shallow: [] };
  const ids = positions.map((p) => p.id);
  const fromAt = new Date(Math.min(...positions.map((p) => p.opened_at.getTime())));
  // The window only narrows the scan (index on at); +1 s covers the millisecond Date. The exact cutoff is in SQL below.
  const toAt = new Date(Math.max(...positions.map((p) => p.closed_at.getTime())) + CLOSE_GRACE_MS + 1_000);
  // The archive CHECK allows only pass / skip, so its half returns nothing today; it is read so a change that archives
  // exit rows makes the row refuse (exit_event_archived) instead of failing the apply UPDATE.
  const exitRows = await sql<{
    id: string; at: Date; summary: string; data: Record<string, unknown>; src: string;
    j_proceeds: string | null; j_fraction: string | null; j_pnl: string | null; j_pnl_mult: string | null; j_fill_price: string | null;
  }[]>`
    SELECT id::text, at, summary, data, 'live' AS src,
           data->>'proceedsUsd' AS j_proceeds, data->>'fraction' AS j_fraction, data->>'pnlUsd' AS j_pnl,
           data->>'pnlMult' AS j_pnl_mult, data->>'fillPriceUsd' AS j_fill_price
    FROM floor_arena_events
    WHERE type = 'exit' AND data->>'positionId' = ANY(${ids}::text[])
    UNION ALL
    SELECT id::text, at, summary, data, 'archive' AS src,
           data->>'proceedsUsd', data->>'fraction', data->>'pnlUsd', data->>'pnlMult', data->>'fillPriceUsd'
    FROM floor_arena_events_archive
    WHERE type = 'exit' AND at BETWEEN ${fromAt.toISOString()}::timestamptz AND ${toAt.toISOString()}::timestamptz AND data->>'positionId' = ANY(${ids}::text[])`;
  const refusalRows = await sql<{
    id: string; at: Date; at_text: string; q_text: string | null; m_text: string | null; data: Record<string, unknown>;
    in_grace: boolean; before_close: boolean;
  }[]>`
    SELECT e.id::text, e.at, e.at::text AS at_text, e.data->>'quoteMult' AS q_text, e.data->>'markMult' AS m_text, e.data,
           (e.at <= p.closed_at + interval '120 seconds') AS in_grace, (e.at <= p.closed_at) AS before_close
    FROM floor_arena_events e JOIN floor_arena_positions p ON p.id::text = e.data->>'positionId'
    WHERE e.type = 'skip' AND e.at BETWEEN ${fromAt.toISOString()}::timestamptz AND ${toAt.toISOString()}::timestamptz
      AND e.data->>'reason' = 'exit_quote_refused' AND e.data->>'positionId' = ANY(${ids}::text[])
    UNION ALL
    SELECT a.id::text, a.at, a.at::text, a.data->>'quoteMult', a.data->>'markMult', a.data,
           (a.at <= p.closed_at + interval '120 seconds'), (a.at <= p.closed_at)
    FROM floor_arena_events_archive a JOIN floor_arena_positions p ON p.id::text = a.data->>'positionId'
    WHERE a.type = 'skip' AND a.at BETWEEN ${fromAt.toISOString()}::timestamptz AND ${toAt.toISOString()}::timestamptz
      AND a.data->>'reason' = 'exit_quote_refused' AND a.data->>'positionId' = ANY(${ids}::text[])`;
  const exitsBy = new Map<string, ExitEvent[]>();
  const exitJson = new Map<number, ExitCasJson>();
  for (const r of exitRows) {
    const pid = String(r.data.positionId);
    const list = exitsBy.get(pid) ?? [];
    list.push({
      id: num(r.id), atMs: r.at.getTime(), fraction: num(r.data.fraction), proceedsUsd: num(r.data.proceedsUsd),
      fillSource: strOrNull(r.data.fillSource), closed: r.data.closed === true, archived: r.src === 'archive',
      summary: r.summary, reason: strOrNull(r.data.reason), leg: numOrNull(r.data.leg), stopKind: strOrNull(r.data.stopKind),
      fillPriceUsd: numOrNull(r.data.fillPriceUsd), pnlUsd: numOrNull(r.data.pnlUsd), pnlMult: numOrNull(r.data.pnlMult),
    });
    exitsBy.set(pid, list);
    exitJson.set(num(r.id), { proceedsUsd: r.j_proceeds, fraction: r.j_fraction, pnlUsd: r.j_pnl, pnlMult: r.j_pnl_mult, fillPriceUsd: r.j_fill_price });
  }
  const refusalsBy = new Map<string, RefusalEvent[]>();
  const refusalCas = new Map<number, QuoteCasText>();
  const seen = new Set<string>();
  for (const r of refusalRows) {
    if (seen.has(r.id)) continue; // a row mid-prune can sit in both tables for one statement
    seen.add(r.id);
    const pid = String(r.data.positionId);
    const list = refusalsBy.get(pid) ?? [];
    list.push({
      id: num(r.id), atMs: r.at.getTime(), refusal: strOrNull(r.data.refusal), quoteMult: numOrNull(r.data.quoteMult),
      markMult: numOrNull(r.data.markMult), inGrace: r.in_grace === true, beforeClose: r.before_close === true,
    });
    refusalCas.set(num(r.id), {
      id: num(r.id), atText: r.at_text,
      quoteMult: r.q_text, markMult: r.m_text,
    });
    refusalsBy.set(pid, list);
  }
  const candidates: Row[] = [];
  const shallow: Row[] = [];
  for (const p of positions) {
    const refusals = refusalsBy.get(p.id) ?? [];
    if (!refusals.some((r) => r.refusal === 'quote_far_below_mark')) continue;
    const input: PositionInput = {
      id: p.id, agentId: p.agent_id, agentKind: p.kind, symbol: p.symbol, mint: p.mint,
      openedAtMs: p.opened_at.getTime(), closedAtMs: p.closed_at.getTime(), sizeUsd: num(p.size_usd), tokens: num(p.tokens),
      entryPriceUsd: num(p.entry_price_usd), realisedUsd: num(p.realised_usd), pnlUsd: num(p.pnl_usd),
    };
    const exits = (exitsBy.get(p.id) ?? []).sort((a, b) => a.id - b.id);
    const closing = closingExit(exits);
    const quote = selectRescoreQuote(refusals, input.closedAtMs, closing?.id ?? null);
    const flags = rowFlags(input, exits, quote);
    const rescore = closing && quote && quote.quoteMult !== null && quote.quoteMult > 0 ? rescorePosition(input, closing, quote.quoteMult) : null;
    const row: Row = {
      input, agentName: p.name, old: { pnlUsd: p.pnl_usd, pnlMult: p.pnl_mult, realisedUsd: p.realised_usd },
      cas: { sizeUsd: p.size_usd, tokens: p.tokens, entryPriceUsd: p.entry_price_usd, remainingFraction: p.remaining_fraction, closedAtText: p.closed_at_text },
      exits, closing, closingJson: closing ? exitJson.get(closing.id) ?? null : null,
      quote, quoteCas: quote ? refusalCas.get(quote.id) ?? null : null, refusals, flags, rescore,
      allowed: rescore !== null && closing !== null && exitJson.has(closing.id) && quote !== null && refusalCas.has(quote.id)
        && rowAllowed(flags, include),
    };
    if (isShallowLow(quote)) shallow.push({ ...row, allowed: false });
    else candidates.push(row);
  }
  return { candidates, shallow };
}

async function agentAllTime(sql: Sql, agentIds: readonly string[]): Promise<Map<string, { name: string; pnl: number }>> {
  const rows = await sql<{ agent_id: string; name: string; pnl: string }[]>`
    SELECT p.agent_id, a.name, COALESCE(SUM(p.pnl_usd), 0)::text AS pnl
    FROM floor_arena_positions p JOIN floor_arena_agents a ON a.id = p.agent_id
    WHERE p.status = 'closed' AND p.pnl_usd IS NOT NULL AND p.agent_id = ANY(${agentIds as string[]}::text[])
    GROUP BY p.agent_id, a.name`;
  return new Map(rows.map((r) => [r.agent_id, { name: r.name, pnl: num(r.pnl) }]));
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}
function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function newSummary(r: Row, rescoredOn: string): string | null {
  if (!r.rescore || !r.closing || !r.quote || r.quote.quoteMult === null) return null;
  return rescoredExitSummary({
    label: tokenLabel(r.input.symbol, r.input.mint), exit: r.closing, quoteMult: r.quote.quoteMult,
    proceedsUsd: r.rescore.newFinalProceedsUsd, pnlUsd: r.rescore.newPnlUsd, sizeUsd: r.input.sizeUsd, rescoredOn,
  });
}

function printTable(title: string, list: readonly Row[], showApply: boolean): void {
  console.log(`\n${title} (${list.length})`);
  const cols = [20, 12, 16, 16, 11, 11, 11, 9, 9, 7, 6];
  console.log(['agent', 'symbol', 'opened (UTC)', 'closed (UTC)', 'old pnl', 'new pnl', 'delta', 'quoteMult', 'q/mark', 'age s', showApply ? 'apply' : ''].map((h, i) => pad(h, cols[i]!)).join(' ') + ' flags');
  for (const c of list) {
    const age = c.quote ? Math.round((c.input.closedAtMs - c.quote.atMs) / 1000) : null;
    const ratio = c.quote ? quoteOfMark(c.quote) : null;
    const cells = [
      c.agentName.slice(0, 20), tokenLabel(c.input.symbol, c.input.mint).slice(0, 12), iso(c.input.openedAtMs), iso(c.input.closedAtMs),
      signedUsd(c.input.pnlUsd), c.rescore ? signedUsd(c.rescore.newPnlUsd) : 'n/a', c.rescore ? signedUsd(c.rescore.newPnlUsd - c.input.pnlUsd) : 'n/a',
      c.quote?.quoteMult != null ? c.quote.quoteMult.toFixed(4) : 'none', ratio === null ? 'n/a' : ratio.toFixed(4),
      age === null ? 'n/a' : String(age), showApply ? (c.allowed ? 'yes' : 'NO') : '',
    ];
    console.log(cells.map((s, i) => pad(s, cols[i]!)).join(' ') + ' ' + (c.flags.join(',') || '-') + `  pos=${c.input.id} mint=${c.input.mint.slice(0, 6)}`);
  }
}

function printReport(cands: readonly Row[], shallow: readonly Row[], totals: Map<string, { name: string; pnl: number }>, mode: string, rescoredOn: string): void {
  console.log(`rescore-mark-over-low-quote: ${mode}`);
  console.log(`closed mark_fallback rows with >=1 quote_far_below_mark refusal: ${cands.length + shallow.length}; candidates (last low quote/mark <= ${DEEP_LOW_OF_MARK}): ${cands.length}; shallow_low: ${shallow.length}`);
  printTable('CANDIDATES', cands, true);
  printTable('NOT CANDIDATES: shallow_low (last low quote/mark > 0.2)', shallow, false);
  const flagCounts = new Map<string, number>();
  for (const c of cands) for (const f of c.flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
  console.log('\ncandidate rows per flag:');
  for (const f of [...INCLUDABLE_FLAGS, ...BLOCKING_FLAGS]) console.log(`  ${pad(f, 30)} ${flagCounts.get(f) ?? 0}`);
  console.log(`  ${pad('(no flag)', 30)} ${cands.filter((c) => c.flags.length === 0).length}`);
  const allowed = cands.filter((c) => c.allowed);
  const sum = (list: readonly Row[]) => list.reduce((s, c) => s + (c.rescore ? c.rescore.newPnlUsd - c.input.pnlUsd : 0), 0);
  console.log(`\nrows this run changes: ${allowed.length} (old ${signedUsd(allowed.reduce((s, c) => s + c.input.pnlUsd, 0))}, delta ${signedUsd(sum(allowed))}); blocked or not included: ${cands.length - allowed.length}`);
  console.log(`plan: rows=${allowed.length} hash=${planHash(cands)}`);
  const laterHits = allowed.filter((c) => c.refusals.some((r) => r.id > c.quote!.id && r.id < c.closing!.id && (r.inGrace ?? true)));
  console.log(`rows with a refusal (any kind) after the selected one and before the exit, the apply would abort on: ${laterHits.length}`
    + (laterHits.length ? ` (${laterHits.map((c) => c.input.id).join(', ')})` : ''));
  console.log('\nexit events rewritten (id, current summary, new summary):');
  for (const c of allowed) {
    console.log(`  ${tokenLabel(c.input.symbol, c.input.mint)} pos=${c.input.id} exit_event=${c.closing!.id}`);
    console.log(`    now: ${c.closing!.summary ?? ''}`);
    console.log(`    new: ${newSummary(c, rescoredOn) ?? ''}`);
  }
  console.log('\nper-agent all-time closed pnl (old -> new, rows this run changes):');
  console.log([pad('agent', 30), pad('old all-time', 14), pad('new all-time', 14), pad('delta', 12), 'rows'].join(' '));
  const agentIds = [...new Set(cands.map((c) => c.input.agentId))].sort();
  for (const id of agentIds) {
    const old = totals.get(id)?.pnl ?? 0;
    const mine = allowed.filter((c) => c.input.agentId === id);
    const d = sum(mine);
    console.log([pad((totals.get(id)?.name ?? id).slice(0, 30), 30), pad(signedUsd(old), 14), pad(signedUsd(old + d), 14), pad(signedUsd(d), 12), String(mine.length)].join(' '));
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 1, prepare: false });
  const now = new Date();
  const atIso = now.toISOString();
  const rescoredOn = atIso.slice(0, 10);
  const includeText = args.include.size ? `, include=${[...args.include].join(',')}` : '';
  try {
    if (!args.apply) {
      await sql.begin('read only', async (tx) => {
        const { candidates, shallow } = await loadRows(tx, args.include);
        const totals = await agentAllTime(tx, [...new Set(candidates.map((c) => c.input.agentId))]);
        printReport(candidates, shallow, totals, `DRY RUN (read-only)${includeText}`, rescoredOn);
      });
      return;
    }
    await sql.begin(async (tx) => {
      const { candidates, shallow } = await loadRows(tx, args.include);
      const totals = await agentAllTime(tx, [...new Set(candidates.map((c) => c.input.agentId))]);
      try {
        checkPlan(candidates, args.confirm, args.plan);
      } catch (error) {
        printReport(candidates, shallow, totals, 'APPLY ABORTED (plan mismatch)', rescoredOn);
        throw error;
      }
      const toChange = candidates.filter((c) => c.allowed);
      const written = await applyRows(tx as unknown as Exec, candidates, atIso, rescoredOn);
      if (written !== toChange.length) throw new Error(`wrote ${written} of ${toChange.length} rows; transaction rolled back`);
      printReport(candidates, shallow, totals, `APPLIED ${toChange.length} rows${includeText}`, rescoredOn);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
