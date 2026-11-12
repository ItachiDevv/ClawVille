import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
// Relative source import: the constants file has no imports, and this keeps the test independent of the package build.
import { FLOOR_ARENA_CONTEST, FLOOR_ARENA_PAPER_COSTS } from '../../../../packages/shared/src/constants/floor-arena';
import {
  CONTEST_WINDOW, DEEP_LOW_OF_MARK, RESCORE_REASON, SELL_HAIRCUT_PCT, closingExit, exitEventPatch, formatMult, isShallowLow, parseArgs,
  positionRescorePayload, quoteOfMark, quoteProceedsUsd, rescorePosition, rescoredExitSummary, round6, round9, rowAllowed,
  rowFlags, selectRescoreQuote, tokenLabel, applyRows, checkPlan, loadRows, planHash, planLines,
  type Exec, type ExitEvent, type IncludableFlag, type PositionInput, type RefusalEvent, type RescoreRow,
} from './rescore-mark-over-low-quote';

const T0 = Date.parse('2026-11-02T12:00:00Z');

// FEAR, house:late-bloomer, position 2c4259d7-...: the prod row and its events (read 2026-11-12). Booked +4005.12 at the
// 204.84x mark; the last refusal (event 253304, stamped 1.2 s after closed_at, id below the exit event 253305) quoted 0.9213274x.
const FEAR_TOKENS = 378283.96474407;
const FEAR_ENTRY = 0.00005287033515557844;
const FEAR_CLOSED = Date.parse('2026-11-02T22:23:47.562Z');
const FEAR_OLD_SUMMARY = 'Sold 100% of FEAR at 204.84x (time cap) for $4025.12 via mark fallback (no usable sell quote). Closed: P&L +$4005.12 (+20025.6%).';
const FEAR: PositionInput = {
  id: '2c4259d7-4ba2-45d2-b95e-414bc80caa87', agentId: 'house:late-bloomer', agentKind: 'house', symbol: 'FEAR', mint: 'FEARmint',
  openedAtMs: Date.parse('2026-11-02T22:13:36.927Z'), closedAtMs: FEAR_CLOSED, sizeUsd: 20, tokens: FEAR_TOKENS, entryPriceUsd: FEAR_ENTRY,
  realisedUsd: 4025.12107, pnlUsd: 4005.12107,
};
const FEAR_EXIT: ExitEvent = {
  id: 253305, atMs: Date.parse('2026-11-02T22:23:48.789Z'), fraction: 1, proceedsUsd: 4025.1210697601578, fillSource: 'mark_fallback', closed: true,
  archived: false, summary: FEAR_OLD_SUMMARY, reason: 'time', leg: null, stopKind: null, fillPriceUsd: 0.01083, pnlUsd: 4005.12107, pnlMult: 201.2560535,
};
const FEAR_QUOTE: RefusalEvent = { id: 253304, atMs: Date.parse('2026-11-02T22:23:48.788Z'), refusal: 'quote_far_below_mark', quoteMult: 0.9213274, markMult: 204.8407669089139 };
const refusal = (id: number, atMs: number, quoteMult: number | null, r = 'quote_far_below_mark', markMult: number | null = 10): RefusalEvent =>
  ({ id, atMs, refusal: r, quoteMult, markMult });

describe('constants mirror the shared contract', () => {
  it('sell haircut and contest window', () => {
    expect(SELL_HAIRCUT_PCT).toBe(FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct);
    expect<string>(CONTEST_WINDOW.startsAt).toBe(FLOOR_ARENA_CONTEST.startsAt);
    expect<string>(CONTEST_WINDOW.endsAt).toBe(FLOOR_ARENA_CONTEST.endsAt);
    expect(DEEP_LOW_OF_MARK).toBe(0.2);
  });
});

describe('selectRescoreQuote', () => {
  it('takes the last far-below-mark refusal before the closing exit event', () => {
    const picked = selectRescoreQuote([
      refusal(900, T0 - 240_000, 0.95), refusal(950, T0 - 120_000, 0.92), refusal(960, T0 - 60_000, 1.4, 'drift'),
      refusal(1001, T0 + 1_000, 0.5), // after the exit event id: ignored
    ], T0, 1000);
    expect(picked?.id).toBe(950);
  });
  it('accepts a closing-tick refusal stamped a few seconds after closed_at (FEAR)', () => {
    expect(selectRescoreQuote([refusal(253000, FEAR_CLOSED - 120_000, 0.95), FEAR_QUOTE], FEAR.closedAtMs, FEAR_EXIT.id)).toEqual(FEAR_QUOTE);
  });
  it('rejects a refusal past the grace window even with a lower id', () => {
    expect(selectRescoreQuote([refusal(999, T0 + 200_000, 0.9)], T0, 1000)).toBeNull();
  });
  it('without an exit event, uses closed_at as the bound', () => {
    expect(selectRescoreQuote([refusal(5, T0 - 1, 0.8), refusal(6, T0 + 1, 0.7)], T0, null)?.id).toBe(5);
  });
  it('returns null when no far-below-mark refusal exists', () => {
    expect(selectRescoreQuote([refusal(5, T0 - 1, 1.5, 'drift')], T0, 1000)).toBeNull();
  });
});

describe('deep-low predicate (quote / mark <= 0.2)', () => {
  it('FEAR is deep (0.0045 of the mark)', () => {
    expect(quoteOfMark(FEAR_QUOTE)).toBeCloseTo(0.0044977736, 9);
    expect(isShallowLow(FEAR_QUOTE)).toBe(false);
  });
  it('exactly 0.2 is deep, above 0.2 is shallow', () => {
    expect(isShallowLow(refusal(1, 0, 2, undefined, 10))).toBe(false);
    expect(isShallowLow(refusal(1, 0, 2.1, undefined, 10))).toBe(true);
  });
  it('a missing quote or mark is not shallow (the row blocks as no_quote instead)', () => {
    expect(isShallowLow(null)).toBe(false);
    expect(isShallowLow(refusal(1, 0, null))).toBe(false);
    expect(isShallowLow(refusal(1, 0, 0.5, undefined, null))).toBe(false);
    expect(quoteOfMark(refusal(1, 0, 0.5, undefined, 0))).toBeNull();
  });
});

describe('rescore math', () => {
  it('FEAR: the 0.92x quote turns +4005.12 into -1.67', () => {
    const expectedProceeds = FEAR_TOKENS * 1 * 0.9213274 * FEAR_ENTRY * (1 - 0.005);
    expect(quoteProceedsUsd(FEAR.tokens, 1, 0.9213274, FEAR.entryPriceUsd)).toBeCloseTo(expectedProceeds, 12);
    const r = rescorePosition(FEAR, FEAR_EXIT, 0.9213274);
    const expectedRealised = round6(4025.12107 - 4025.1210697601578 + expectedProceeds);
    expect(r.newRealisedUsd).toBe(expectedRealised);
    expect(r.newRealisedUsd).toBe(18.334415);
    expect(r.newPnlUsd).toBe(round6(expectedRealised - 20));
    expect(r.newPnlUsd).toBe(-1.665585);
    expect(r.newPnlMult).toBe(round9(expectedRealised / 20));
  });
  it('multi-leg: keeps the earlier legs and replaces only the final one', () => {
    const p: PositionInput = { ...FEAR, realisedUsd: 30 + 500, pnlUsd: 510 };
    const final: ExitEvent = { id: 2, atMs: T0, fraction: 0.5, proceedsUsd: 500, fillSource: 'mark_fallback', closed: true };
    const r = rescorePosition(p, final, 1.2);
    const leg = FEAR_TOKENS * 0.5 * 1.2 * FEAR_ENTRY * 0.995;
    expect(r.newRealisedUsd).toBe(round6(30 + leg));
    expect(r.newPnlUsd).toBe(round6(round6(30 + leg) - 20));
  });
  it('a non-positive or non-finite quote books zero proceeds', () => {
    expect(quoteProceedsUsd(1, 1, Number.NaN, 1)).toBe(0);
    expect(quoteProceedsUsd(1, 1, -1, 1)).toBe(0);
  });
});

describe('flags', () => {
  const q = (mult: number | null, ageMs = 60_000): RefusalEvent => refusal(253000, FEAR_CLOSED - ageMs, mult, undefined, 100);
  it('FEAR has no flag (its quote is 1.2 s newer than closed_at: negative age is not stale)', () => {
    expect(rowFlags(FEAR, [FEAR_EXIT], FEAR_QUOTE)).toEqual([]);
  });
  it('a low quote of the entry price is no longer a flag', () => {
    expect(rowFlags(FEAR, [FEAR_EXIT], q(0.03))).toEqual([]);
  });
  it('stale quote, user agent, contest window, multi-leg', () => {
    const contestOpen = Date.parse('2026-10-01T00:00:00Z');
    const p: PositionInput = { ...FEAR, agentKind: 'user', openedAtMs: contestOpen, closedAtMs: contestOpen + 3_600_000, realisedUsd: 530 };
    const exits: ExitEvent[] = [
      { id: 1, atMs: 0, fraction: 0.5, proceedsUsd: 30, fillSource: 'quote', closed: false },
      { id: 2, atMs: 0, fraction: 0.5, proceedsUsd: 500, fillSource: 'mark_fallback', closed: true },
    ];
    const quote = refusal(1, p.closedAtMs - 6 * 60_000, 0.3);
    expect(rowFlags(p, exits, quote).sort()).toEqual(['contest', 'multi_leg', 'stale_quote', 'user']);
  });
  it('blocking flags: no quote, no mark, no exit event, archived exit, closing leg not mark_fallback, realised mismatch', () => {
    expect(rowFlags(FEAR, [FEAR_EXIT], q(null))).toEqual(['no_quote']);
    expect(rowFlags(FEAR, [FEAR_EXIT], { ...FEAR_QUOTE, markMult: null })).toEqual(['no_quote']);
    expect(rowFlags(FEAR, [FEAR_EXIT], null)).toEqual(['no_quote']);
    expect(rowFlags(FEAR, [], q(0.92))).toEqual(['no_exit_event']);
    expect(rowFlags(FEAR, [{ ...FEAR_EXIT, archived: true }], q(0.92))).toEqual(['exit_event_archived']);
    expect(rowFlags(FEAR, [{ ...FEAR_EXIT, fillSource: 'quote' }], q(0.92))).toEqual(['closing_leg_not_mark_fallback']);
    expect(rowFlags(FEAR, [{ ...FEAR_EXIT, proceedsUsd: 4000 }], q(0.92))).toEqual(['realised_mismatch']);
  });
  it('closingExit prefers the closed event', () => {
    const a: ExitEvent = { id: 5, atMs: 0, fraction: 0.5, proceedsUsd: 1, fillSource: 'quote', closed: false };
    const b: ExitEvent = { id: 4, atMs: 0, fraction: 0.5, proceedsUsd: 1, fillSource: 'mark_fallback', closed: true };
    expect(closingExit([a, b])?.id).toBe(4);
    expect(closingExit([])).toBeNull();
  });
  it('rowAllowed needs every includable flag named and refuses blocking flags', () => {
    const inc = (...f: IncludableFlag[]) => new Set<IncludableFlag>(f);
    expect(rowAllowed([], inc())).toBe(true);
    expect(rowAllowed(['user'], inc())).toBe(false);
    expect(rowAllowed(['user'], inc('user'))).toBe(true);
    expect(rowAllowed(['user', 'contest'], inc('user'))).toBe(false);
    expect(rowAllowed(['exit_event_archived'], inc('contest', 'user', 'multi_leg', 'stale_quote'))).toBe(false);
    expect(rowAllowed(['no_quote'], inc('contest', 'user', 'multi_leg', 'stale_quote'))).toBe(false);
  });
});

describe('exit summary text', () => {
  it('FEAR: engine wording with the rescored numbers and the rescore note', () => {
    const r = rescorePosition(FEAR, FEAR_EXIT, 0.9213274);
    const text = rescoredExitSummary({
      label: tokenLabel(FEAR.symbol, FEAR.mint), exit: FEAR_EXIT, quoteMult: 0.9213274, proceedsUsd: r.newFinalProceedsUsd,
      pnlUsd: r.newPnlUsd, sizeUsd: 20, rescoredOn: '2026-11-12',
    });
    expect(text).toBe('Sold 100% of FEAR at 0.92x (time cap) for $18.33 via the last logged sell quote. Closed: P&L -$1.67 (-8.3%). '
      + 'Rescored on 2026-11-12: the mark was far above every sell quote.');
    expect(text.length).toBeLessThanOrEqual(280);
  });
  it('TP keeps the leg count of the old summary; a stop names its kind', () => {
    const base = { label: 'X', quoteMult: 0.1, proceedsUsd: 1, pnlUsd: -19, sizeUsd: 20, rescoredOn: '2026-11-12' };
    const tp = rescoredExitSummary({ ...base, exit: { ...FEAR_EXIT, reason: 'tp', leg: 2, fraction: 0.5, summary: 'Sold 50% of X at 3.00x (TP 2 of 3) for $30.00 via mark fallback.' } });
    expect(tp.startsWith('Sold 50% of X at 0.10x (TP 2 of 3) for $1.00 via the last logged sell quote.')).toBe(true);
    const tpNoLegs = rescoredExitSummary({ ...base, exit: { ...FEAR_EXIT, reason: 'tp', leg: 1, summary: '' } });
    expect(tpNoLegs).toContain('(TP 1)');
    const stop = rescoredExitSummary({ ...base, exit: { ...FEAR_EXIT, reason: 'stop', stopKind: 'liq_drop' } });
    expect(stop).toContain('(liquidity drop)');
    expect(rescoredExitSummary({ ...base, exit: { ...FEAR_EXIT, reason: 'stop', stopKind: null } })).toContain('(stop)');
    expect(rescoredExitSummary({ ...base, exit: { ...FEAR_EXIT, reason: 'trail' } })).toContain('(trailing stop)');
  });
  it('formatMult: 2 decimals at or above 0.1x, 2 significant digits below', () => {
    expect(formatMult(204.8407669089139)).toBe('204.84');
    expect(formatMult(0.9213274)).toBe('0.92');
    expect(formatMult(0.1)).toBe('0.10');
    expect(formatMult(0.0566)).toBe('0.057');
    expect(formatMult(0.05)).toBe('0.050');
    expect(formatMult(0.0037)).toBe('0.0037');
    expect(formatMult(0.00371849)).toBe('0.0037');
    expect(formatMult(0.0000001234)).toBe('0.00000012');
    expect(formatMult(0)).toBe('0.00');
  });
  it('MAYA: the 0.0037x quote reads as 0.0037x, not 0.00x', () => {
    // MAYA HqZZhb (Mid-Cap Climber, prod 2026-11-09): last logged quote 0.0037x of entry (dry run 2026-11-12, 4 decimals).
    const text = rescoredExitSummary({
      label: 'MAYA', exit: { ...FEAR_EXIT, reason: 'time' }, quoteMult: 0.0037, proceedsUsd: 0.08, pnlUsd: -19.92, sizeUsd: 20, rescoredOn: '2026-11-12',
    });
    expect(text).toBe('Sold 100% of MAYA at 0.0037x (time cap) for $0.08 via the last logged sell quote. Closed: P&L -$19.92 (-99.6%). '
      + 'Rescored on 2026-11-12: the mark was far above every sell quote.');
  });
  it('a long label stays within 280 characters', () => {
    const text = rescoredExitSummary({ label: 'L'.repeat(400), exit: FEAR_EXIT, quoteMult: 1, proceedsUsd: 1, pnlUsd: 1, sizeUsd: 20, rescoredOn: '2026-11-12' });
    expect(text.length).toBe(280);
    expect(text.endsWith('...')).toBe(true);
  });
});

describe('jsonb payloads', () => {
  const r = rescorePosition(FEAR, FEAR_EXIT, 0.9213274);
  const atIso = '2026-11-12T05:00:00.000Z';
  it('entry_features.rescore holds old text values, new values, the quote and the exit event', () => {
    const payload = positionRescorePayload({
      atIso, old: { pnlUsd: '4005.12107', pnlMult: '201.2560535', realisedUsd: '4025.12107' }, rescore: r, quote: FEAR_QUOTE,
      exitEventId: 253305, flags: [],
    });
    expect(payload).toEqual({
      reason: RESCORE_REASON,
      at: atIso,
      old: { pnl_usd: '4005.12107', pnl_mult: '201.2560535', realised_usd: '4025.12107', exit_fill_source: 'mark_fallback' },
      new: { pnl_usd: '-1.665585', pnl_mult: String(r.newPnlMult), realised_usd: '18.334415', exit_fill_source: 'quote_confirmed' },
      quoteEventId: 253304,
      quoteMult: 0.9213274,
      markMult: 204.8407669089139,
      quoteAt: '2026-11-02T22:23:48.788Z',
      exitEventId: 253305,
      flags: [],
    });
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
  it('the exit event patch carries the new fill and the old values under rescoredFrom', () => {
    const patch = exitEventPatch({ exit: FEAR_EXIT, rescore: r, quoteMult: 0.9213274, entryPriceUsd: FEAR_ENTRY, atIso, quoteEventId: 253304 });
    expect(patch).toEqual({
      pnlUsd: -1.665585,
      pnlMult: r.newPnlMult,
      proceedsUsd: r.newFinalProceedsUsd,
      fillSource: 'quote_confirmed',
      fillPriceUsd: 0.9213274 * FEAR_ENTRY,
      rescoredFrom: {
        reason: RESCORE_REASON, at: atIso, quoteEventId: 253304,
        pnlUsd: 4005.12107, pnlMult: 201.2560535, proceedsUsd: 4025.1210697601578,
        fillSource: 'mark_fallback', fillPriceUsd: 0.01083, summary: FEAR_OLD_SUMMARY,
      },
    });
    // The patch never touches the event's identity keys (positionId, reason, leg, fraction, closed).
    for (const key of ['positionId', 'reason', 'leg', 'fraction', 'closed']) expect(Object.keys(patch)).not.toContain(key);
  });
});

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ apply: false, confirm: null, plan: null, include: new Set() });
  });
  it('apply needs a confirm count', () => {
    expect(() => parseArgs(['--apply'])).toThrow('--confirm');
    expect(() => parseArgs(['--apply', '--confirm=12'])).toThrow('--plan');
    const plan = 'ab'.repeat(32);
    expect(parseArgs(['--apply', '--confirm=12', `--plan=${plan}`, '--include=contest,user'])).toMatchObject({ apply: true, confirm: 12, plan });
  });
  it('rejects bad input', () => {
    expect(() => parseArgs(['--confirm=3'])).toThrow('only valid with --apply');
    expect(() => parseArgs([`--plan=${'ab'.repeat(32)}`])).toThrow('only valid with --apply');
    expect(() => parseArgs(['--apply', '--confirm=1', '--plan=xyz'])).toThrow('64-hex');
    expect(() => parseArgs(['--apply', '--confirm=x'])).toThrow('whole number');
    expect(() => parseArgs(['--include=no_quote'])).toThrow('unknown or blocking');
    expect(() => parseArgs(['--include=low_quote'])).toThrow('unknown or blocking');
    expect(() => parseArgs(['--yes'])).toThrow('unknown argument');
  });
});

// ---------------------------------------------------------------- plan hash and CAS (Codex review of c3c960b69)

function fearRow(over: Partial<RescoreRow> = {}): RescoreRow {
  return {
    input: FEAR, agentName: 'Late Bloomer',
    old: { pnlUsd: '4005.12107', pnlMult: '201.2560535', realisedUsd: '4025.12107' },
    cas: {
      sizeUsd: '20', tokens: '378283.96474407', entryPriceUsd: '0.00005287033515557844', remainingFraction: '0',
      closedAtText: '2026-11-02 22:23:47.562+00',
    },
    exits: [FEAR_EXIT], closing: FEAR_EXIT,
    closingJson: { proceedsUsd: '4025.1210697601578', fraction: '1', pnlUsd: '4005.12107', pnlMult: '201.2560535', fillPriceUsd: '0.01083' },
    quote: FEAR_QUOTE,
    quoteCas: { id: 253304, atText: '2026-11-02 22:23:48.788+00', quoteMult: '0.9213274', markMult: '204.8407669089139' },
    flags: [], rescore: rescorePosition(FEAR, FEAR_EXIT, 0.9213274), allowed: true,
    ...over,
  };
}

interface Call { text: string; values: unknown[] }
/** A fake postgres.js transaction: records every statement and returns the queued row lists in order. */
function fakeExec(results: unknown[][]): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('$'), values });
    return Promise.resolve(results.shift() ?? []);
  }) as unknown as Exec;
  fn.json = (value: unknown) => ({ json: value });
  return { exec: fn, calls };
}

const FEAR_PLAN_LINE = '2c4259d7-4ba2-45d2-b95e-414bc80caa87|253305|4005.12107|4025.12107|-1.665585|253304|0.9213274|204.8407669089139';
/** Queue for one fully matching row: refusal re-read (live), position UPDATE, exit-event UPDATE. */
const OK = (): unknown[][] => [[{ id: 253304 }], [{ id: FEAR.id }], [{ id: 253305 }]];

describe('plan hash', () => {
  it('one line per changed row: position | exit event | old pnl | old realised | new pnl | refusal id | quoteMult | markMult', () => {
    expect(planLines([fearRow()])).toEqual([FEAR_PLAN_LINE]);
    expect(planHash([fearRow()])).toBe(createHash('sha256').update(FEAR_PLAN_LINE).digest('hex'));
  });
  it('ignores rows the run does not change and the row order', () => {
    const other = fearRow({ input: { ...FEAR, id: '00000000-0000-0000-0000-000000000001' } });
    const skipped = fearRow({ input: { ...FEAR, id: 'ffffffff-0000-0000-0000-000000000000' }, allowed: false });
    expect(planHash([fearRow(), other, skipped])).toBe(planHash([other, fearRow()]));
  });
  it('checkPlan passes on the dry-run plan and aborts on a count or hash mismatch', () => {
    const rows = [fearRow()];
    const hash = planHash(rows);
    expect(() => checkPlan(rows, 1, hash)).not.toThrow();
    expect(() => checkPlan(rows, 2, hash)).toThrow('--confirm=2 but 1 rows would change');
    expect(() => checkPlan(rows, 1, 'a'.repeat(64))).toThrow('but the current plan is');
    // A row whose old P&L changed since the dry run makes a different plan.
    const moved = [fearRow({ old: { pnlUsd: '4005.2', pnlMult: '201.26', realisedUsd: '4025.2' } })];
    expect(() => checkPlan(moved, 1, hash)).toThrow('but the current plan is');
    expect(() => checkPlan([], 1, hash)).toThrow('--confirm=1 but 0 rows');
  });
  it('a different selected refusal (id, quoteMult or markMult) makes a different plan', () => {
    const hash = planHash([fearRow()]);
    const qc = fearRow().quoteCas!;
    for (const quoteCas of [{ ...qc, id: 253303 }, { ...qc, quoteMult: '0.92' }, { ...qc, markMult: '204.84' }]) {
      expect(() => checkPlan([fearRow({ quoteCas })], 1, hash)).toThrow('but the current plan is');
    }
  });
});

describe('applyRows CAS', () => {
  const at = '2026-11-12T07:00:00.000Z';
  it('re-reads the selected refusal FOR SHARE and checks reason, refusal, position, quoteMult, markMult and at', async () => {
    const { exec, calls } = fakeExec(OK());
    expect(await applyRows(exec, [fearRow()], at, '2026-11-12')).toBe(1);
    const q = calls[0]!;
    for (const part of ['FROM floor_arena_events\n', "type = 'skip'", 'at = $::text::timestamptz', "data->>'reason' = 'exit_quote_refused'",
      "data->>'refusal' = 'quote_far_below_mark'", "data->>'positionId' = $", "(data->>'quoteMult')::numeric IS NOT DISTINCT FROM $::numeric",
      "(data->>'markMult')::numeric IS NOT DISTINCT FROM $::numeric", 'FOR SHARE']) expect(q.text).toContain(part);
    for (const v of [253304, '2026-11-02 22:23:48.788+00', FEAR.id, '0.9213274', '204.8407669089139']) expect(q.values).toContain(v);
  });
  it('binds microsecond timestamps as text, never as a bare $::timestamptz (postgres.js would truncate them to ms)', async () => {
    const row = fearRow({ quoteCas: { ...fearRow().quoteCas!, atText: '2026-10-11 21:42:46.754843+00' } });
    const { exec, calls } = fakeExec(OK());
    await applyRows(exec, [row], at, '2026-11-12');
    for (const c of calls) expect(c.text).not.toMatch(/\$::timestamptz/);
    expect(calls[0]!.values).toContain('2026-10-11 21:42:46.754843+00');
  });
  it('a refusal moved to the archive still matches there', async () => {
    const { exec, calls } = fakeExec([[], [{ id: 253304 }], [{ id: FEAR.id }], [{ id: 253305 }]]);
    expect(await applyRows(exec, [fearRow()], at, '2026-11-12')).toBe(1);
    expect(calls[1]!.text).toContain('FROM floor_arena_events_archive');
    expect(calls[1]!.text).toContain('FOR SHARE');
  });
  it('a changed or missing refusal aborts before any UPDATE', async () => {
    const { exec, calls } = fakeExec([[], []]);
    await expect(applyRows(exec, [fearRow()], at, '2026-11-12')).rejects.toThrow('refusal event 253304 of position');
    expect(calls.length).toBe(2);
    expect(calls.some((c) => c.text.includes('UPDATE'))).toBe(false);
  });
  it('compares every math input and old value on the position, closed_at included', async () => {
    const { exec, calls } = fakeExec(OK());
    await applyRows(exec, [fearRow()], at, '2026-11-12');
    const pos = calls[1]!;
    for (const part of ["status = 'closed'", "exit_fill_source = 'mark_fallback'", 'pnl_usd = $::numeric', 'pnl_mult IS NOT DISTINCT FROM $::numeric',
      'realised_usd = $::numeric', 'size_usd = $::numeric', 'tokens = $::numeric', 'entry_price_usd = $::numeric',
      'remaining_fraction = $::numeric', 'closed_at = $::text::timestamptz', "NOT (COALESCE(entry_features, '{}'::jsonb) ? 'rescore')"]) expect(pos.text).toContain(part);
    for (const v of [FEAR.id, '4005.12107', '201.2560535', '4025.12107', '20', '378283.96474407', '0.00005287033515557844', '0',
      '2026-11-02 22:23:47.562+00']) expect(pos.values).toContain(v);
  });
  it('the exit-event CAS covers every key the patch writes (derived from the patch object)', async () => {
    const { exec, calls } = fakeExec(OK());
    await applyRows(exec, [fearRow()], at, '2026-11-12');
    const ex = calls[2]!;
    const patchKeys = Object.keys(exitEventPatch({
      exit: FEAR_EXIT, rescore: fearRow().rescore!, quoteMult: 0.9213274, entryPriceUsd: FEAR_ENTRY, atIso: at, quoteEventId: 253304,
    }));
    expect(patchKeys.length).toBeGreaterThan(0);
    for (const key of patchKeys) {
      const numeric = `(data->>'${key}')::numeric IS NOT DISTINCT FROM $::numeric`;
      const covered = ex.text.includes(numeric) || ex.text.includes(`data->>'${key}' = 'mark_fallback'`) || ex.text.includes(`NOT (data ? '${key}')`);
      expect({ key, covered }).toEqual({ key, covered: true });
    }
    for (const part of ["type = 'exit'", "data->>'positionId' = $", "(data->>'fraction')::numeric IS NOT DISTINCT FROM $::numeric", 'summary = $']) {
      expect(ex.text).toContain(part);
    }
    // No bound value is compared as jsonb (a postgres.js string bound as $n::jsonb is a JSON string, never a number).
    expect(ex.text).not.toMatch(/\$::jsonb\s*(AND|$)/);
    for (const v of [253305, FEAR.id, '4025.1210697601578', '1', '4005.12107', '201.2560535', '0.01083', FEAR_OLD_SUMMARY]) expect(ex.values).toContain(v);
  });
  it('a changed position row (CAS miss) aborts before the exit event is touched', async () => {
    const { exec, calls } = fakeExec([[{ id: 253304 }], []]);
    await expect(applyRows(exec, [fearRow()], at, '2026-11-12')).rejects.toThrow('CAS failed on position');
    expect(calls.length).toBe(2);
  });
  it('a changed exit event (CAS miss) aborts', async () => {
    const { exec } = fakeExec([[{ id: 253304 }], [{ id: FEAR.id }], []]);
    await expect(applyRows(exec, [fearRow()], at, '2026-11-12')).rejects.toThrow('CAS failed on exit event 253305');
  });
  it('rows the run does not change are never written', async () => {
    const { exec, calls } = fakeExec([]);
    expect(await applyRows(exec, [fearRow({ allowed: false })], at, '2026-11-12')).toBe(0);
    expect(calls.length).toBe(0);
  });
});

describe('loadRows binds timestamps as ISO text', () => {
  it('passes the event time window as `${iso}::timestamptz`, never a bare Date', async () => {
    const position = {
      id: FEAR.id, agent_id: FEAR.agentId, kind: 'house', name: 'Late Bloomer', symbol: 'FEAR', mint: FEAR.mint,
      opened_at: new Date(FEAR.openedAtMs), closed_at: new Date(FEAR.closedAtMs), size_usd: '20', tokens: '378283.96474407',
      entry_price_usd: '0.00005287033515557844', realised_usd: '4025.12107', pnl_usd: '4005.12107', pnl_mult: '201.2560535',
      remaining_fraction: '0', closed_at_text: '2026-11-02 22:23:47.562+00',
    };
    const { exec, calls } = fakeExec([[position], [], []]);
    const out = await loadRows(exec as unknown as Parameters<typeof loadRows>[0], new Set());
    expect(out.candidates).toEqual([]);
    expect(calls.length).toBe(3);
    for (const c of calls) for (const v of c.values) expect(v instanceof Date).toBe(false);
    for (const c of calls.slice(1)) {
      expect(c.text).toContain('at BETWEEN $::timestamptz AND $::timestamptz');
      expect(c.values).toContain(new Date(FEAR.openedAtMs).toISOString());
      expect(c.values).toContain(new Date(FEAR.closedAtMs + 120_000).toISOString());
    }
  });
});

describe('exit-event CAS on the real stored shape (staging event 211119)', () => {
  // Staging 2026-11-12: event 211119 (ZCYBERLEEK, position 1e847886-...) as stored. The first staging apply failed its
  // exit CAS because `$n::jsonb` bound "22.170298402581356" as a JSON string while the stored value is a JSON number.
  const STORED_DATA = {
    leg: null, holdS: 958, closed: true, pnlUsd: 2.170298, reason: 'time', pnlMult: 1.1085149, fraction: 1, markMult: 1.119712040534412,
    fillSource: 'mark_fallback', positionId: '1e847886-bf6f-4458-bb40-5a77e9dc67ba', proceedsUsd: 22.170298402581356, fillPriceUsd: 0.00004524,
    remainingFraction: 0,
  };
  // What `data->>'key'` returns for those values (read on staging): numeric text.
  const ARROW_TEXT = { proceedsUsd: '22.170298402581356', fraction: '1', pnlUsd: '2.170298', pnlMult: '1.1085149', fillPriceUsd: '0.00004524' };
  it('binds the ->> numeric texts and compares them as numeric', async () => {
    const exit: ExitEvent = {
      id: 211119, atMs: 0, fraction: STORED_DATA.fraction, proceedsUsd: STORED_DATA.proceedsUsd, fillSource: 'mark_fallback', closed: true,
      summary: 'Sold 100% of ZCYBERLEEK at 1.12x (time cap) for $22.17 via mark fallback (no usable sell quote). Closed: P&L +$2.17 (+10.9%).',
      reason: 'time', leg: null, stopKind: null, fillPriceUsd: STORED_DATA.fillPriceUsd, pnlUsd: STORED_DATA.pnlUsd, pnlMult: STORED_DATA.pnlMult,
    };
    const input: PositionInput = { ...FEAR, id: STORED_DATA.positionId, symbol: 'ZCYBERLEEK', realisedUsd: 22.170298, pnlUsd: 2.170298 };
    const row = fearRow({
      input, exits: [exit], closing: exit, closingJson: ARROW_TEXT,
      old: { pnlUsd: '2.170298', pnlMult: '1.1085149', realisedUsd: '22.170298' },
      rescore: rescorePosition(input, exit, 0.1158),
    });
    const { exec, calls } = fakeExec([[{ id: 1 }], [{ id: input.id }], [{ id: 211119 }]]);
    expect(await applyRows(exec, [row], '2026-11-12T07:00:00.000Z', '2026-11-12')).toBe(1);
    const ex = calls[2]!;
    for (const v of Object.values(ARROW_TEXT)) expect(ex.values).toContain(v);
    // Each bound text is numerically equal to the stored JSON number (the numeric compare in SQL is exact).
    for (const [key, text] of Object.entries(ARROW_TEXT)) expect(Number(text)).toBe(STORED_DATA[key as keyof typeof ARROW_TEXT]);
  });
});
