/**
 * One-shot rescore of Trading Floor arena paper exits that booked the DexScreener mark (exit_fill_source
 * 'mark_fallback') while the sell quote was refused as 'quote_far_below_mark'. A row is a candidate when its LAST
 * logged 'quote_far_below_mark' refusal before the close is a DEEP low: quote / mark <= DEEP_LOW_OF_MARK (0.2), the
 * same predicate as the engine rule. A shallow low (quote / mark > 0.2) is not a candidate; it is listed as
 * 'shallow_low'. A candidate is rebooked at that quote: final-leg proceeds = tokens sold x quoteMult x entry price x
 * (1 - 0.5%) (the paper quote sell cost, FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct; docs/trading-floor-arena.md D3).
 *
 *   bun run rescore-mark-over-low-quote.ts                                   # dry run (read-only transaction)
 *   bun run rescore-mark-over-low-quote.ts --apply --confirm=<rows>          # rescore, one transaction
 *   bun run rescore-mark-over-low-quote.ts --apply --confirm=<rows> --include=contest,user
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
 * without an exit event, a time no later than closed_at.
 */
export function selectRescoreQuote(refusals: readonly RefusalEvent[], closedAtMs: number, closingExitId: number | null): RefusalEvent | null {
  let best: RefusalEvent | null = null;
  for (const r of refusals) {
    if (r.refusal !== 'quote_far_below_mark') continue;
    if (closingExitId !== null ? (r.id >= closingExitId || r.atMs > closedAtMs + CLOSE_GRACE_MS) : r.atMs > closedAtMs) continue;
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
  include: Set<IncludableFlag>;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { apply: false, confirm: null, include: new Set() };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--confirm=')) {
      const raw = arg.slice('--confirm='.length);
      if (!/^\d+$/.test(raw)) throw new Error(`--confirm needs a whole number, got "${raw}"`);
      args.confirm = Number(raw);
    } else if (arg.startsWith('--include=')) {
      for (const name of arg.slice('--include='.length).split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!(INCLUDABLE_FLAGS as readonly string[]).includes(name)) throw new Error(`--include: unknown or blocking flag "${name}" (allowed: ${INCLUDABLE_FLAGS.join(', ')})`);
        args.include.add(name as IncludableFlag);
      }
    } else throw new Error(`unknown argument "${arg}"`);
  }
  if (args.apply && args.confirm === null) throw new Error('--apply needs --confirm=<row count>');
  if (!args.apply && args.confirm !== null) throw new Error('--confirm is only valid with --apply');
  return args;
}

// ---------------------------------------------------------------- DB side

type Sql = postgres.Sql | postgres.TransactionSql;

interface Row {
  input: PositionInput;
  agentName: string;
  old: OldPositionText;
  exits: ExitEvent[];
  closing: ExitEvent | null;
  quote: RefusalEvent | null;
  flags: RowFlag[];
  rescore: Rescore | null;
  allowed: boolean;
}

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

async function loadRows(sql: Sql, include: ReadonlySet<IncludableFlag>): Promise<{ candidates: Row[]; shallow: Row[] }> {
  const positions = await sql<{
    id: string; agent_id: string; kind: string; name: string; symbol: string | null; mint: string;
    opened_at: Date; closed_at: Date; size_usd: string; tokens: string; entry_price_usd: string;
    realised_usd: string; pnl_usd: string; pnl_mult: string | null;
  }[]>`
    SELECT p.id, p.agent_id, a.kind, a.name, p.symbol, p.mint, p.opened_at, p.closed_at, p.size_usd::text, p.tokens::text,
           p.entry_price_usd::text, p.realised_usd::text, p.pnl_usd::text, p.pnl_mult::text
    FROM floor_arena_positions p JOIN floor_arena_agents a ON a.id = p.agent_id
    WHERE p.status = 'closed' AND p.exit_fill_source = 'mark_fallback' AND p.pnl_usd IS NOT NULL
    ORDER BY p.closed_at`;
  if (positions.length === 0) return { candidates: [], shallow: [] };
  const ids = positions.map((p) => p.id);
  const fromAt = new Date(Math.min(...positions.map((p) => p.opened_at.getTime())));
  const toAt = new Date(Math.max(...positions.map((p) => p.closed_at.getTime())) + CLOSE_GRACE_MS);
  // The archive CHECK allows only pass / skip, so its half returns nothing today; it is read so a change that archives
  // exit rows makes the row refuse (exit_event_archived) instead of failing the apply UPDATE.
  const exitRows = await sql<{ id: string; at: Date; summary: string; data: Record<string, unknown>; src: string }[]>`
    SELECT id::text, at, summary, data, 'live' AS src FROM floor_arena_events
    WHERE type = 'exit' AND data->>'positionId' = ANY(${ids}::text[])
    UNION ALL
    SELECT id::text, at, summary, data, 'archive' AS src FROM floor_arena_events_archive
    WHERE type = 'exit' AND at BETWEEN ${fromAt} AND ${toAt} AND data->>'positionId' = ANY(${ids}::text[])`;
  const refusalRows = await sql<{ id: string; at: Date; data: Record<string, unknown> }[]>`
    SELECT id::text, at, data FROM floor_arena_events
    WHERE type = 'skip' AND at BETWEEN ${fromAt} AND ${toAt}
      AND data->>'reason' = 'exit_quote_refused' AND data->>'positionId' = ANY(${ids}::text[])
    UNION ALL
    SELECT id::text, at, data FROM floor_arena_events_archive
    WHERE type = 'skip' AND at BETWEEN ${fromAt} AND ${toAt}
      AND data->>'reason' = 'exit_quote_refused' AND data->>'positionId' = ANY(${ids}::text[])`;
  const exitsBy = new Map<string, ExitEvent[]>();
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
  }
  const refusalsBy = new Map<string, RefusalEvent[]>();
  const seen = new Set<string>();
  for (const r of refusalRows) {
    if (seen.has(r.id)) continue; // a row mid-prune can sit in both tables for one statement
    seen.add(r.id);
    const pid = String(r.data.positionId);
    const list = refusalsBy.get(pid) ?? [];
    list.push({ id: num(r.id), atMs: r.at.getTime(), refusal: strOrNull(r.data.refusal), quoteMult: numOrNull(r.data.quoteMult), markMult: numOrNull(r.data.markMult) });
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
      exits, closing, quote, flags, rescore, allowed: rescore !== null && rowAllowed(flags, include),
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
      const toChange = candidates.filter((c) => c.allowed);
      if (toChange.length !== args.confirm) {
        printReport(candidates, shallow, totals, 'APPLY ABORTED (count mismatch)', rescoredOn);
        throw new Error(`--confirm=${args.confirm} but ${toChange.length} rows would change; nothing written`);
      }
      for (const c of toChange) {
        const r = c.rescore!;
        const closing = c.closing!;
        const quote = c.quote!;
        const audit = positionRescorePayload({ atIso, old: c.old, rescore: r, quote, exitEventId: closing.id, flags: c.flags });
        const updated = await tx`
          UPDATE floor_arena_positions
          SET realised_usd = ${String(r.newRealisedUsd)}::numeric, pnl_usd = ${String(r.newPnlUsd)}::numeric,
              pnl_mult = ${String(r.newPnlMult)}::numeric, exit_fill_source = 'quote_confirmed',
              entry_features = COALESCE(entry_features, '{}'::jsonb) || jsonb_build_object('rescore', ${tx.json(audit as postgres.JSONValue)}::jsonb)
          WHERE id = ${c.input.id} AND status = 'closed' AND exit_fill_source = 'mark_fallback'
            AND pnl_usd = ${c.old.pnlUsd}::numeric AND realised_usd = ${c.old.realisedUsd}::numeric
          RETURNING id`;
        if (updated.length !== 1) throw new Error(`CAS failed on position ${c.input.id}; transaction rolled back`);
        const patch = exitEventPatch({ exit: closing, rescore: r, quoteMult: quote.quoteMult!, entryPriceUsd: c.input.entryPriceUsd, atIso, quoteEventId: quote.id });
        const exitUpdated = await tx`
          UPDATE floor_arena_events
          SET data = data || ${tx.json(patch as postgres.JSONValue)}::jsonb, summary = ${newSummary(c, rescoredOn)!}
          WHERE id = ${closing.id} AND type = 'exit' AND data->>'positionId' = ${c.input.id}
            AND data->>'fillSource' = 'mark_fallback' AND NOT (data ? 'rescoredFrom')
          RETURNING id`;
        if (exitUpdated.length !== 1) throw new Error(`CAS failed on exit event ${closing.id} of position ${c.input.id}; transaction rolled back`);
      }
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
