/**
 * floor-arena-exit-replay.ts - READ-ONLY exit-rule replay for the Trading Floor Arena paper bots (phase 3a).
 *
 * Replays exit rules PER BOT on each closed position's own recorded mark path (floor_arena_position_marks:
 * 'hold' marks, then the 30-min post-exit 'tail' marks). It never invents a mark: a rule that is still holding
 * when a position's data ends is "beyond data" for that trade and takes the recorded P&L.
 *
 * Modes (SELECT statements only; one connection; prints no secret):
 *   bun x.ts --dump [--days 7]        query prod, print the compact dataset as JSON on stdout
 *   bun x.ts --input data.json        replay offline from a dump
 *   bun x.ts [--days 7]               query + replay in one run
 *   --model per-trade|hybrid|calibrated|spec   cost model of the rule tables (default per-trade)
 *
 * Cost model (FLOOR_ARENA_PAPER_COSTS in packages/shared/src/constants/floor-arena.ts, read 2026-10-15):
 *   entry_price_usd already holds the 1.0 % buy haircut (pricing.ts: tokens = quoted x 0.99), so mark_mult = mark /
 *   entry price is net of the buy cost. The engine books a sell at the QUOTE x (1 - 0.5 %), and a take-profit leg
 *   needs the quote to confirm it (engine.ts tpConfirmedByQuote). The replay has no quote at most marks, so it
 *   estimates the quote from the mark. Four models, all printed in the reproduction table:
 *     spec        quote = mark x (1 - 1.25 %) (pool fee); a fill books mark x (1 - 1.75 %) (markFallbackProceeds)
 *     calibrated  per bot, from its recorded exits (booked multiple / last hold mark) and quote / mark pairs
 *     hybrid      spec TP confirm + calibrated fill factors
 *     per-trade   quote = mark x the trade's OWN median recorded quote / mark ratio (fallback: bot median); every
 *                 fill books that quote x (1 - 0.5 %). Best per-trade fit on the 10-08..10-15 data (default).
 *   Every simulated fill of every rule uses the one chosen model; rules also report a cross-check model.
 * Exit order mirrors engine.ts decideExitTrigger: next TP leg, stop, trail, time; one trigger per mark; an
 * unconfirmed TP falls through to stop / trail / time as runExitTick does.
 * Granularity: a mark row is the newest DexScreener mark of a 10 s bucket (first 30 min) or 60 s bucket (to 6 h);
 * a move inside a bucket is invisible, so a stop fills at the first mark at or under it (the gap is included).
 */

import { readFileSync } from 'node:fs';

const SELL_HAIRCUT_PCT = 0.5;
const POOL_FEE_PCT = 1.25;
const MARK_FILL = 1 - (SELL_HAIRCUT_PCT + POOL_FEE_PCT) / 100;
const QUOTE_PROXY = 1 - POOL_FEE_PCT / 100;
/** Breakeven stop level: the mark at which a fill returns the entry cost (proceeds = size). */
const BE_LEVEL = 1 / MARK_FILL;
/** Time exit: use the first mark after the cap if it is at most this late, else the last mark before the cap. */
const TIME_FILL_MAX_LAG_S = 60;
const TRAIN_SHARE = 0.6;

const TEMPLATE_EXITS: Record<string, Exits> = {
  'house:genesis': { tp: [[1.1, 1]], stop_mult: null, trail_from_peak: null, trail_arm_mult: null, max_hold_s: 900 },
  'house:runner': { tp: [[1.2, 1]], stop_mult: null, trail_from_peak: null, trail_arm_mult: null, max_hold_s: 900 },
  'house:dip-hunter': { tp: [[1.08, 1]], stop_mult: 0.9, trail_from_peak: null, trail_arm_mult: null, max_hold_s: 7200 },
  'house:midcap-climber': { tp: [[1.1, 1]], stop_mult: null, trail_from_peak: null, trail_arm_mult: null, max_hold_s: 3600 },
  'house:late-bloomer': { tp: [[1.1, 1]], stop_mult: null, trail_from_peak: null, trail_arm_mult: null, max_hold_s: 1800 },
};

interface Exits { tp: [number, number][]; stop_mult: number | null; trail_from_peak: number | null; trail_arm_mult: number | null; max_hold_s: number }

/** Dump row: [phase 0 hold / 1 tail, mark t (s since open) | null, mark mult | null, quote t | null, quote mult | null]. */
type PathRow = [number, number | null, number | null, number | null, number | null];
interface DumpPosition {
  id: string; agent: string; openedMs: number; closedMs: number; size: number; peak: number;
  reason: string; fill: string | null; pnl: number | null; exits: Exits | null; path: PathRow[];
}
interface Dump { generatedAt: string; days: number; positions: DumpPosition[] }

// ------------------------------------------------------------------ data

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

async function loadFromDb(days: number): Promise<Dump> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, ssl: false });
  try {
    const rows = await sql`
      SELECT p.id, p.agent_id, (extract(epoch FROM p.opened_at) * 1000)::float8 AS opened_ms,
             (extract(epoch FROM p.closed_at) * 1000)::float8 AS closed_ms, p.size_usd::float8 AS size,
             p.peak_mult::float8 AS peak, p.exit_reason, p.exit_fill_source, p.pnl_usd::float8 AS pnl,
             p.entry_features -> 'exits' AS exits
      FROM floor_arena_positions p
      WHERE p.status = 'closed' AND p.opened_at >= now() - make_interval(days => ${days})
      ORDER BY p.opened_at`;
    const positions: DumpPosition[] = rows.map((r) => ({
      id: r.id as string, agent: r.agent_id as string, openedMs: Number(r.opened_ms), closedMs: Number(r.closed_ms),
      size: Number(r.size), peak: Number(r.peak), reason: r.exit_reason as string, fill: (r.exit_fill_source as string | null) ?? null,
      pnl: r.pnl === null ? null : Number(r.pnl), exits: (r.exits as Exits | null) ?? null, path: [],
    }));
    const byId = new Map(positions.map((p) => [p.id, p]));
    const BATCH = 150;
    for (let i = 0; i < positions.length; i += BATCH) {
      const ids = positions.slice(i, i + BATCH).map((p) => p.id);
      const marks = await sql`
        SELECT m.position_id, m.phase, (extract(epoch FROM m.mark_at) * 1000)::float8 AS mt, m.mark_mult,
               (extract(epoch FROM m.quote_at) * 1000)::float8 AS qt, m.quote_mult
        FROM floor_arena_position_marks m
        WHERE m.position_id IN ${sql(ids)}
        ORDER BY m.position_id, m.phase, m.bucket_at`;
      for (const m of marks) {
        const p = byId.get(m.position_id as string);
        if (!p) continue;
        const rel = (v: unknown) => (v === null ? null : Math.round((Number(v) - p.openedMs) / 100) / 10);
        p.path.push([m.phase === 'tail' ? 1 : 0, rel(m.mt), m.mark_mult === null ? null : Number(m.mark_mult),
          rel(m.qt), m.quote_mult === null ? null : Number(m.quote_mult)]);
      }
    }
    return { generatedAt: new Date().toISOString(), days, positions };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ------------------------------------------------------------------ replay model

interface P {
  id: string; agent: string; openedMs: number; closedMs: number; size: number; reason: string; pnl: number;
  exits: Exits; t: Float64Array; m: Float64Array; holdEndT: number; lastHoldMark: number; holdMin: number; holdMax: number;
  /** quote / mark ratios of this trade's recorded sell quotes; k = their median (NaN when none). */
  quotePairs: number[]; k: number; train: boolean;
}

interface Rule { tp: [number, number][]; stop: number; be: number; trail: number; trailArm: number; hold: number }
interface SimOut { pnl: number; exitMs: number; beyond: boolean; reason: string }
/**
 * conf: quote / mark ratio a TP needs (mark x conf >= TP); tpFill / other: booked multiple per unit of mark.
 * perTrade: the quote estimate is mark x the trade's own k (fallback conf), and EVERY fill books quote x (1 - 0.5 %),
 * which is the engine's quote fill (pricing.ts quoteSell proceeds); tpFill / other are then unused.
 */
interface Cost { conf: number; tpFill: number; other: number; label: string; perTrade?: boolean }

const SPEC_COST: Cost = { conf: QUOTE_PROXY, tpFill: MARK_FILL, other: MARK_FILL, label: 'spec' };

function prepare(d: DumpPosition): Omit<P, 'train'> | null {
  if (d.pnl === null || !Number.isFinite(d.pnl)) return null;
  const exits = d.exits && Array.isArray(d.exits.tp) ? d.exits : TEMPLATE_EXITS[d.agent];
  if (!exits) return null;
  const pts: [number, number][] = [];
  let holdEndT = -1;
  let lastHoldMark = NaN;
  let holdMin = Infinity;
  let holdMax = -Infinity;
  const quotePairs: number[] = [];
  const quotes: [number, number][] = [];
  for (const [ph, mt, mm, qt, qm] of d.path) {
    if (mt !== null && mm !== null && mt >= 0 && mm > 0) {
      pts.push([mt, mm]);
      if (ph === 0) {
        if (mt > holdEndT) { holdEndT = mt; lastHoldMark = mm; }
        holdMin = Math.min(holdMin, mm);
        holdMax = Math.max(holdMax, mm);
      }
    }
    if (ph === 0 && qt !== null && qm !== null && qm > 0) quotes.push([qt, qm]);
  }
  if (pts.length === 0) return null;
  pts.sort((a, b) => a[0] - b[0]);
  // Each recorded sell quote vs the newest mark at most 60 s older (the engine's fresh-mark window).
  const holdPts = pts.filter(([pt]) => pt <= holdEndT);
  for (const [qt, qm] of quotes) {
    let best: number | null = null;
    for (const [pt, pm] of holdPts) if (pt <= qt && qt - pt <= 60) best = pm;
    if (best !== null) quotePairs.push(qm / best);
  }
  const t = new Float64Array(pts.length);
  const m = new Float64Array(pts.length);
  pts.forEach(([pt, pm], i) => { t[i] = pt; m[i] = pm; });
  return {
    id: d.id, agent: d.agent, openedMs: d.openedMs, closedMs: d.closedMs, size: d.size, reason: d.reason, pnl: d.pnl,
    exits, t, m, holdEndT, lastHoldMark, holdMin, holdMax, quotePairs, k: quotePairs.length ? quantile(quotePairs, 0.5) : NaN,
  };
}

/**
 * Per-bot fill calibration from the bot's own recorded exits (a cost fit, not a rule fit): booked exit multiple
 * (1 + pnl / size) over the last hold mark before the close, ratio of sums, for TP exits and for the other exits.
 * conf = median quote / mark ratio of same-bucket pairs. Falls back to the spec value under 20 samples.
 */
function calibrate(bp: P[]): Cost & { nTp: number; nOther: number; nPairs: number } {
  const ratio = (xs: P[]) => {
    const ok = xs.filter((p) => Number.isFinite(p.lastHoldMark) && p.holdEndT >= (p.closedMs - p.openedMs) / 1000 - 60);
    const num = ok.reduce((s, p) => s + 1 + p.pnl / p.size, 0);
    const den = ok.reduce((s, p) => s + p.lastHoldMark, 0);
    return { r: den > 0 ? num / den : NaN, n: ok.length };
  };
  const tp = ratio(bp.filter((p) => p.reason === 'tp'));
  const other = ratio(bp.filter((p) => p.reason === 'time' || p.reason === 'stop' || p.reason === 'trail'));
  const pairs = bp.flatMap((p) => p.quotePairs);
  return {
    conf: pairs.length >= 20 ? quantile(pairs, 0.5) : QUOTE_PROXY,
    tpFill: tp.n >= 20 ? tp.r : MARK_FILL,
    other: other.n >= 20 ? other.r : MARK_FILL,
    label: 'calibrated', nTp: tp.n, nOther: other.n, nPairs: pairs.length,
  };
}

function ruleFromExits(e: Exits): Rule {
  return {
    tp: e.tp.map(([a, b]) => [a, b] as [number, number]), stop: e.stop_mult ?? 0, be: Infinity,
    trail: e.trail_from_peak ?? 0, trailArm: e.trail_arm_mult ?? 1, hold: e.max_hold_s,
  };
}

function simulate(p: P, r: Rule, c: Cost): SimOut {
  let remaining = 1;
  let realised = 0;
  let peak = 1;
  let leg = 0;
  let lastM = NaN;
  const kq = c.perTrade ? (Number.isFinite(p.k) ? p.k : c.conf) : c.conf;
  const conf = kq;
  const tpFill = c.perTrade ? kq * (1 - SELL_HAIRCUT_PCT / 100) : c.tpFill;
  const other = c.perTrade ? kq * (1 - SELL_HAIRCUT_PCT / 100) : c.other;
  const beLevel = 1 / other;
  const n = p.t.length;
  const done = (reason: string, tSec: number): SimOut => ({ pnl: (realised - 1) * p.size, exitMs: p.openedMs + tSec * 1000, beyond: false, reason });
  for (let i = 0; i < n; i++) {
    const t = p.t[i]!;
    const m = p.m[i]!;
    const pastCap = t >= r.hold;
    // Time cap passed between marks: book the last mark before the cap unless the next mark is at most 60 s late.
    if (pastCap && t - r.hold > TIME_FILL_MAX_LAG_S && !Number.isNaN(lastM)) {
      realised += remaining * lastM * other;
      return done('time', r.hold);
    }
    if (m > peak) peak = m;
    lastM = m;
    if (leg < r.tp.length && m >= r.tp[leg]![0] && m * conf >= r.tp[leg]![0]) {
      const fr = Math.min(r.tp[leg]![1], remaining);
      realised += fr * m * tpFill;
      remaining -= fr;
      leg += 1;
      if (remaining <= 1e-9) return done('tp', t);
    } else {
      const stopLevel = peak >= r.be ? Math.max(r.stop, beLevel) : r.stop;
      if (m <= stopLevel) {
        realised += remaining * m * other;
        return done(stopLevel === r.stop ? 'stop' : 'be', t);
      }
      if (r.trail > 0 && peak >= r.trailArm && m <= peak * (1 - r.trail)) {
        realised += remaining * m * other;
        return done('trail', t);
      }
    }
    if (pastCap) {
      realised += remaining * m * other;
      return done('time', t);
    }
  }
  return { pnl: p.pnl, exitMs: p.closedMs, beyond: true, reason: 'beyond' };
}

interface Stats { n: number; beyond: number; net: number; exp: number; pf: number; dd: number }

function stats(outs: SimOut[]): Stats {
  let net = 0;
  let gw = 0;
  let gl = 0;
  let beyond = 0;
  for (const o of outs) {
    net += o.pnl;
    if (o.pnl > 0) gw += o.pnl; else gl -= o.pnl;
    if (o.beyond) beyond += 1;
  }
  const seq = [...outs].sort((a, b) => a.exitMs - b.exitMs);
  let cum = 0;
  let hi = 0;
  let dd = 0;
  for (const o of seq) {
    cum += o.pnl;
    hi = Math.max(hi, cum);
    dd = Math.max(dd, hi - cum);
  }
  return { n: outs.length, beyond, net, exp: outs.length ? net / outs.length : 0, pf: gl > 0 ? gw / gl : Infinity, dd };
}

interface Eval { name: string; outs: SimOut[]; all: Stats; train: Stats; test: Stats }

function evaluate(ps: P[], name: string, ruleOf: (p: P) => Rule, c: Cost): Eval {
  const outs = ps.map((p) => simulate(p, ruleOf(p), c));
  return {
    name, outs,
    all: stats(outs),
    train: stats(outs.filter((_, i) => ps[i]!.train)),
    test: stats(outs.filter((_, i) => !ps[i]!.train)),
  };
}

/**
 * Rule minus base on the trades where NEITHER is beyond data, per half, with a paired z (sum of the per-trade
 * deltas / (their standard deviation x sqrt(n))): |z| < 2 is within trade-to-trade noise.
 */
function inData(ps: P[], e: Eval, base: Eval): { train: number; test: number; zTrain: number; zTest: number } {
  const dTrain: number[] = [];
  const dTest: number[] = [];
  e.outs.forEach((o, i) => {
    const b = base.outs[i]!;
    if (o.beyond || b.beyond) return;
    (ps[i]!.train ? dTrain : dTest).push(o.pnl - b.pnl);
  });
  const z = (xs: number[]) => {
    const s = xs.reduce((a, v) => a + v, 0);
    if (xs.length < 2) return 0;
    const mean = s / xs.length;
    const sd = Math.sqrt(xs.reduce((a, v) => a + (v - mean) ** 2, 0) / (xs.length - 1));
    return sd > 0 ? s / (sd * Math.sqrt(xs.length)) : 0;
  };
  const sum = (xs: number[]) => xs.reduce((a, v) => a + v, 0);
  return { train: sum(dTrain), test: sum(dTest), zTrain: z(dTrain), zTest: z(dTest) };
}

// ------------------------------------------------------------------ report helpers

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : 'inf');
const usd = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(0)}`;
const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
}

function beats(ps: P[], e: Eval, base: Eval): boolean {
  const d = inData(ps, e, base);
  return e.train.net > base.train.net && e.test.net > base.test.net && d.train > 0 && d.test > 0;
}

function row(ps: P[], e: Eval, base: Eval, tag: string): string {
  const d = inData(ps, e, base);
  return `| ${e.name} | ${e.all.beyond} | ${usd(e.all.net)} | ${f2(e.all.exp)} | ${f2(e.all.pf)} | ${usd(e.all.dd)} | `
    + `${usd(e.train.net)} / ${f2(e.train.pf)} / ${f2(e.train.exp)} | ${usd(e.test.net)} / ${f2(e.test.pf)} / ${f2(e.test.exp)} | `
    + `${usd(e.train.net - base.train.net)} / ${usd(e.test.net - base.test.net)} | ${usd(d.train)} / ${usd(d.test)} | ${f2(d.zTrain)} / ${f2(d.zTest)} | ${tag} |`;
}
const HEADER = '| rule | beyond | net | exp | PF | maxDD | TRAIN net / PF / exp | TEST net / PF / exp | d vs live: train / test | d in-data: train / test | z in-data: train / test | beats both |\n'
  + '|---|---|---|---|---|---|---|---|---|---|---|---|';

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const days = Number(argValue('--days') ?? 7);
  const input = argValue('--input');
  const dump: Dump = input ? (JSON.parse(readFileSync(input, 'utf8')) as Dump) : await loadFromDb(days);
  if (process.argv.includes('--dump')) {
    process.stdout.write(JSON.stringify(dump));
    return;
  }
  const model = argValue('--model') ?? 'per-trade';

  const total = dump.positions.length;
  const covered = dump.positions.map(prepare).filter((p): p is Omit<P, 'train'> => p !== null);
  const minOpen = Math.min(...covered.map((p) => p.openedMs));
  const maxOpen = Math.max(...covered.map((p) => p.openedMs));
  const splitMs = minOpen + TRAIN_SHARE * (maxOpen - minOpen);
  const ps: P[] = covered.map((p) => ({ ...p, train: p.openedMs < splitMs }));

  console.log(`# Floor Arena exit replay (generated ${dump.generatedAt}, window ${dump.days} d, costs: ${model})`);
  console.log(`positions closed in window: ${total}; with pnl + marks (replayed): ${ps.length}`);
  console.log(`opened range of replayed: ${new Date(minOpen).toISOString()} .. ${new Date(maxOpen).toISOString()}; TRAIN = opened before ${new Date(splitMs).toISOString()}`);

  console.log('\n## Coverage and exit params seen\n| bot | closed | no pnl | no marks | replayed | recorded net (all) | recorded net (replayed) |\n|---|---|---|---|---|---|---|');
  for (const a of [...new Set(dump.positions.map((p) => p.agent))].sort()) {
    const all = dump.positions.filter((p) => p.agent === a);
    const rep = ps.filter((p) => p.agent === a);
    const repIds = new Set(rep.map((p) => p.id));
    console.log(`| ${a} | ${all.length} | ${all.filter((p) => p.pnl === null).length} | ${all.filter((p) => p.pnl !== null && !repIds.has(p.id)).length} | ${rep.length} | `
      + `${usd(all.reduce((s, p) => s + (p.pnl ?? 0), 0))} | ${usd(rep.reduce((s, p) => s + p.pnl, 0))} |`);
  }
  const regimes = new Map<string, { n: number; from: number; to: number }>();
  for (const p of ps) {
    const k = `${p.agent} ${JSON.stringify({ tp: p.exits.tp, stop: p.exits.stop_mult, hold_s: p.exits.max_hold_s })}`;
    const v = regimes.get(k) ?? { n: 0, from: Infinity, to: 0 };
    v.n += 1; v.from = Math.min(v.from, p.openedMs); v.to = Math.max(v.to, p.openedMs);
    regimes.set(k, v);
  }
  console.log('\n| exit params (per position, entry_features.exits) | n | first open | last open |\n|---|---|---|---|');
  for (const [k, v] of [...regimes].sort()) console.log(`| ${k} | ${v.n} | ${new Date(v.from).toISOString().slice(0, 16)} | ${new Date(v.to).toISOString().slice(0, 16)} |`);

  const agents = [...new Set(ps.map((p) => p.agent))].filter((a) => ps.filter((p) => p.agent === a).length >= 30).sort();
  for (const a of agents) {
    const bp = ps.filter((p) => p.agent === a);
    const cal = calibrate(bp);
    // hybrid: the engine's TP confirm proxy (pool fee only) + this bot's calibrated fill factors.
    // per-trade (default): each trade's own median quote / mark ratio drives TP confirm and every fill.
    const hybrid: Cost = { conf: QUOTE_PROXY, tpFill: cal.tpFill, other: cal.other, label: 'hybrid' };
    const perTrade: Cost = { conf: cal.conf, tpFill: 0, other: 0, label: 'per-trade', perTrade: true };
    const cost: Cost = model === 'spec' ? SPEC_COST : model === 'hybrid' ? hybrid : model === 'calibrated' ? cal : perTrade;
    const live = bp.reduce((x, y) => (y.openedMs > x.openedMs ? y : x)).exits;
    const liveRule = ruleFromExits(live);
    console.log(`\n# ${a} (n=${bp.length}: train ${bp.filter((p) => p.train).length}, test ${bp.filter((p) => !p.train).length}; LIVE exits = newest trade: TP ${JSON.stringify(live.tp)}, stop ${live.stop_mult}, hold ${live.max_hold_s} s)`);
    console.log(`calibration: TP confirm needs mark x ${f2(cal.conf)} (median quote/mark, ${cal.nPairs} pairs); TP books mark x ${cal.tpFill.toFixed(4)} (${cal.nTp} exits); stop/time books mark x ${cal.other.toFixed(4)} (${cal.nOther} exits); spec: ${QUOTE_PROXY} / ${MARK_FILL} / ${MARK_FILL}`);

    // Reproduction: each trade's OWN recorded exits, under every cost model.
    console.log('\n## Current-rule reproduction (each trade replayed with its own recorded exit params)');
    console.log('| cost model | recorded net | replay net | gap | gap % | mean abs per-trade diff | same exit reason | beyond |\n|---|---|---|---|---|---|---|---|');
    const recNet = bp.reduce((s, p) => s + p.pnl, 0);
    const reprod: Record<string, SimOut[]> = {};
    for (const c of [SPEC_COST, cal, hybrid, perTrade]) {
      const outs = bp.map((p) => simulate(p, ruleFromExits(p.exits), c));
      reprod[c.label] = outs;
      const simNet = outs.reduce((s, o) => s + o.pnl, 0);
      const absDiff = outs.reduce((s, o, i) => s + Math.abs(o.pnl - bp[i]!.pnl), 0) / bp.length;
      const match = outs.filter((o, i) => o.reason === bp[i]!.reason || o.beyond).length;
      console.log(`| ${c.label} | ${usd(recNet)} | ${usd(simNet)} | ${usd(simNet - recNet)} | ${pct(Math.abs(simNet - recNet), Math.abs(recNet))} | $${absDiff.toFixed(2)} | ${pct(match, bp.length)} | ${outs.filter((o) => o.beyond).length} |`);
    }
    console.log('| recorded reason | n | recorded net | replay net (spec) | replay net (calibrated) | replay net (hybrid) | replay net (per-trade) | per-trade replay reasons |\n|---|---|---|---|---|---|---|---|');
    for (const reason of [...new Set(bp.map((p) => p.reason))].sort()) {
      const idx = bp.map((p, i) => (p.reason === reason ? i : -1)).filter((i) => i >= 0);
      const reasons = new Map<string, number>();
      for (const i of idx) reasons.set(reprod['per-trade']![i]!.reason, (reasons.get(reprod['per-trade']![i]!.reason) ?? 0) + 1);
      const sum = (k: string) => usd(idx.reduce((s, i) => s + reprod[k]![i]!.pnl, 0));
      console.log(`| ${reason} | ${idx.length} | ${usd(idx.reduce((s, i) => s + bp[i]!.pnl, 0))} | ${sum('spec')} | ${sum('calibrated')} | ${sum('hybrid')} | ${sum('per-trade')} | `
        + `${[...reasons].map(([k, v]) => `${k}:${v}`).join(' ')} |`);
    }

    // Money left on the table + winners' drawdown (recorded trades, hold marks only).
    const lostTime = bp.filter((p) => p.reason === 'time' && p.pnl < 0);
    const lt5 = lostTime.filter((p) => p.holdMax >= 1.05);
    const lt10 = lostTime.filter((p) => p.holdMax >= 1.1);
    console.log(`\n## Losing time exits: n=${lostTime.length}, net ${usd(lostTime.reduce((s, p) => s + p.pnl, 0))}; a hold mark touched >= 1.05: ${lt5.length} (${pct(lt5.length, lostTime.length)}, net ${usd(lt5.reduce((s, p) => s + p.pnl, 0))}); >= 1.10: ${lt10.length} (${pct(lt10.length, lostTime.length)}, net ${usd(lt10.reduce((s, p) => s + p.pnl, 0))})`);
    const winners = bp.filter((p) => p.pnl > 0 && Number.isFinite(p.holdMin));
    const wMin = winners.map((p) => p.holdMin);
    const share = (lvl: number) => pct(wMin.filter((v) => v <= lvl).length, wMin.length);
    console.log(`## Winners' lowest hold mark (n=${winners.length}): p10 ${f2(quantile(wMin, 0.1))} p25 ${f2(quantile(wMin, 0.25))} median ${f2(quantile(wMin, 0.5))}; share <= 0.95: ${share(0.95)}, <= 0.92: ${share(0.92)}, <= 0.90: ${share(0.9)}, <= 0.85: ${share(0.85)}, <= 0.80: ${share(0.8)}, <= 0.70: ${share(0.7)}`);

    // Rules, under the primary cost model AND a cross-check model; a rule counts as robust only if it beats LIVE
    // on both halves (net and in-data) under BOTH models.
    const crossCost = cost.label === 'per-trade' ? hybrid : perTrade;
    const primary = runRules(bp, live, cost);
    const cross = runRules(bp, live, crossCost);
    const crossWins = new Set([...cross.evals, ...cross.grid].filter((e) => beats(bp, e, cross.base)).map((e) => e.name));
    const tag = (e: Eval, base: Eval) => (beats(bp, e, base) ? (crossWins.has(e.name) ? 'YES (robust)' : 'YES (only this model)') : '');
    console.log(`\n## Single rules on top of the LIVE exits, cost model ${cost.label} (sorted by net $; cross-check model ${crossCost.label})\n${HEADER}`);
    for (const e of [...primary.evals].sort((x, y) => y.all.net - x.all.net)) console.log(row(bp, e, primary.base, tag(e, primary.base)));

    const { base, grid } = primary;
    const byTrain = [...grid].sort((x, y) => y.train.net - x.train.net);
    const winnersBoth = grid.filter((e) => beats(bp, e, base));
    console.log(`\n## Combination grid: ${grid.length} absolute combos; top 3 by TRAIN net (TEST is out of sample)\n${HEADER}`);
    for (const e of byTrain.slice(0, 3)) console.log(row(bp, e, base, tag(e, base)));
    console.log(`train-selected #1: TEST ${usd(byTrain[0]!.test.net)} vs LIVE TEST ${usd(base.test.net)} -> ${byTrain[0]!.test.net > base.test.net ? 'holds out of sample' : 'FAILS out of sample'}`);
    const robust = winnersBoth.filter((e) => crossWins.has(e.name));
    console.log(`combos that beat LIVE on both halves (net and in-data): ${winnersBoth.length} of ${grid.length} under ${cost.label}; ${robust.length} also under ${crossCost.label}. Top 3 robust by the smaller half gain:`);
    console.log(HEADER);
    const minGain = (e: Eval) => Math.min(e.train.net - base.train.net, e.test.net - base.test.net);
    for (const e of [...robust].sort((x, y) => minGain(y) - minGain(x)).slice(0, 3)) console.log(row(bp, e, base, tag(e, base)));
  }
}

/** Single-dimension rules on top of the LIVE exits + the absolute combination grid, under one cost model. */
function runRules(bp: P[], live: Exits, cost: Cost): { base: Eval; evals: Eval[]; grid: Eval[] } {
  const liveRule = ruleFromExits(live);
  const base = evaluate(bp, 'LIVE exits on every trade', () => ruleFromExits(live), cost);
  const evals: Eval[] = [base, evaluate(bp, 'as recorded (each trade its own params)', (p) => ruleFromExits(p.exits), cost)];
  const mod = (name: string, f: (r: Rule) => void) => {
    const r: Rule = { ...liveRule, tp: liveRule.tp.map((l) => [...l] as [number, number]) };
    f(r);
    evals.push(evaluate(bp, name, () => r, cost));
  };
  for (const s of [5, 8, 10, 15, 20, 25, 30, 40]) mod(`stop -${s}%`, (r) => { r.stop = 1 - s / 100; });
  if (liveRule.stop > 0) mod('no stop', (r) => { r.stop = 0; });
  for (const arm of [1.03, 1.05, 1.08, 1.1, 1.15]) mod(`breakeven armed ${arm}`, (r) => { r.be = arm; });
  for (const d of [10, 15, 20, 30]) for (const arm of [1.05, 1.1]) mod(`trail ${d}% armed ${arm}`, (r) => { r.trail = d / 100; r.trailArm = arm; });
  for (const min of [2, 3, 5, 10, 15, 20, 30, 45, 60, 90]) {
    if (min * 60 === live.max_hold_s || min * 60 > live.max_hold_s + 1800) continue;
    mod(`time ${min} min`, (r) => { r.hold = min * 60; });
  }
  for (const tp of [1.05, 1.08, 1.1, 1.15, 1.2, 1.3]) if (tp !== live.tp[0]?.[0]) mod(`TP ${tp}`, (r) => { r.tp = [[tp, 1]]; });
  for (const tp1 of [1.05, 1.08, 1.1, 1.15]) for (const d of [10, 15, 20]) {
    mod(`2-leg: half at ${tp1}, rest trail ${d}% armed ${tp1}`, (r) => { r.tp = [[tp1, 0.5]]; r.trail = d / 100; r.trailArm = tp1; });
  }
  const grid: Eval[] = [];
  const holds = [...new Set([0.5, 1, 2, 3].map((k) => Math.round(live.max_hold_s * k)).filter((h) => h <= live.max_hold_s + 1800))];
  const trails: [number, number][] = [[0, 1], [0.1, 1.05], [0.15, 1.05], [0.2, 1.1], [0.3, 1.1]];
  for (const tp of [1.05, 1.08, 1.1, 1.15, 1.2, 1.3]) for (const st of [0, 0.95, 0.92, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6])
    for (const be of [Infinity, 1.03, 1.05, 1.08]) for (const [tr, arm] of trails) for (const h of holds) {
      const name = `TP ${tp}, stop ${st ? st : 'none'}, BE ${Number.isFinite(be) ? be : 'none'}, trail ${tr ? `${tr * 100}%@${arm}` : 'none'}, time ${h / 60}m`;
      const r: Rule = { tp: [[tp, 1]], stop: st, be, trail: tr, trailArm: arm, hold: h };
      grid.push(evaluate(bp, name, () => r, cost));
    }
  return { base, evals, grid };
}

main().catch((error) => {
  console.error('replay failed:', error instanceof Error ? error.message : 'error');
  process.exit(1);
});
