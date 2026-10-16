/**
 * floor-arena-label-report.ts - READ-ONLY report: do a house bot's filters block winners or losers?
 * Table `floor_arena_coin_labels` (migration 0083, writer src/services/floor-arena/coin-labels.ts).
 *
 * Run inside the api container (DATABASE_URL already set there):
 *   bun apps/api/scripts/floor-arena-label-report.ts [--days 7] [--include-open]
 *
 * For each house bot and each labelled coin (anchored in the window; `done` rows only unless --include-open):
 *   entered            = the bot opened a position on the mint within [anchor - 5 min, anchor + 24 h];
 *   pass, not entered  = a `pass` event (live or archived) in that window but no position;
 *   replay pass        = no pass event, but the bot's CURRENT params pass the coin at the anchor (filter replay);
 *   fail:<code>        = no pass event and the replay fails <code> (a coin with several fails counts in each);
 *   sole fail:<code>   = <code> is the ONLY replay fail (that filter alone blocked the coin).
 * The replay uses evaluateAgentCandidates (engine.ts) with the anchor features, the first resolved chain verdict
 * (chain_status, else the verdict at the anchor) and nowMs = anchor time. Pass / fail events record only passes per
 * mint (fails are aggregated in scan events), so the per-coin fail code comes from the replay, and the replay judges
 * the coin once, at the anchor, with today's params.
 * Per group: n, fate counts, mean markouts, and the common exit (one fixed $20 exit applied to every coin): net $,
 * expectancy, profit factor, wins. SELECT statements only; prints no secrets.
 */

import { db, sql } from '@clawville/database';
import type { FloorArenaParams } from '@clawville/shared';
import type { EntryVerdict } from '../src/services/floor-arena/chain-checks';
import { evaluateAgentCandidates, type ArenaCandidate } from '../src/services/floor-arena/engine';
import type { FloorArenaFeatures } from '../src/services/floor-arena/filters';

type Row = Record<string, unknown>;

async function q(query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute<Row>(query)) as unknown as Row[];
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function msOf(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  const parsed = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return null; } })() : v;
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
}

interface Label {
  mint: string;
  anchorMs: number;
  features: Record<string, unknown>;
  chainStatus: Record<string, unknown> | null;
  fate: string;
  marks: Record<'m5' | 'm15' | 'm30' | 'm60' | 'h6' | 'h24', number | null>;
  pnl: number | null;
}

const MARK_KEYS = ['m5', 'm15', 'm30', 'm60', 'h6', 'h24'] as const;
const FATES = ['rug', 'runner', 'bleed', 'flat', 'unknown'] as const;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function replay(label: Label, params: FloorArenaParams): string[] {
  const f = label.features;
  const verdict = (label.chainStatus?.verdict ?? f.chainVerdict ?? 'pending') as EntryVerdict;
  const top10 = numOrNull(label.chainStatus?.top10Pct ?? f.top10Pct);
  const firstSeenAtMs = msOf(f.firstSeenAt) ?? label.anchorMs;
  const c: ArenaCandidate = {
    mint: label.mint, source: String(f.source ?? ''), symbol: typeof f.symbol === 'string' ? f.symbol : null,
    firstSeenAtMs, features: { ...(f as unknown as FloorArenaFeatures), top10Pct: top10 }, verdict, chainCheckedAtMs: null,
    isPrivate: false, tradeable: true,
    // The episode key is the first tradeable sighting; the anchor features keep the hub's first sighting.
    tradeableFirstSeenAtMs: msOf(f.episodeAt) ?? firstSeenAtMs,
    tradeableSource: typeof f.tradeableSource === 'string' ? f.tradeableSource : null,
  };
  const ev = evaluateAgentCandidates(params, [c], new Set(), new Map(), label.anchorMs);
  return ev.passed.length === 1 ? [] : Object.keys(ev.failCounts).sort();
}

function summarize(name: string, labels: Label[]): Row {
  const fates: Record<string, number> = {};
  for (const fate of FATES) fates[fate] = 0;
  for (const l of labels) fates[l.fate] = (fates[l.fate] ?? 0) + 1;
  const mean = (key: (typeof MARK_KEYS)[number]) => {
    const xs = labels.map((l) => l.marks[key]).filter((x): x is number => x !== null);
    return xs.length === 0 ? '-' : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3);
  };
  const pnls = labels.map((l) => l.pnl).filter((x): x is number => x !== null);
  const net = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((x) => x > 0);
  const lossSum = -pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const winSum = wins.reduce((a, b) => a + b, 0);
  return {
    group: name, n: labels.length,
    fates: FATES.map((f) => `${f}:${fates[f]}`).join(','),
    ...Object.fromEntries(MARK_KEYS.map((k) => [`avg_${k}`, mean(k)])),
    exit_n: pnls.length, net_usd: net.toFixed(2), exp_usd: pnls.length ? (net / pnls.length).toFixed(3) : '-',
    pf: lossSum > 0 ? (winSum / lossSum).toFixed(2) : (winSum > 0 ? 'inf' : '-'), wins: wins.length,
  };
}

function print(rows: Row[]): void {
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const r of rows) console.log(`  ${Object.entries(r).map(([k, v]) => `${k}=${v ?? 'null'}`).join('  ')}`);
}

async function main(): Promise<void> {
  const days = Math.max(1, Math.min(90, Number(arg('--days') ?? 7) || 7));
  const includeOpen = process.argv.includes('--include-open');
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const raw = await q(sql`
    SELECT mint, episode_at, anchor_at, anchor_features, chain_status, fate_24h, mult_5m, mult_15m, mult_30m, mult_60m,
      mult_6h, mult_24h, common_exit_pnl_usd
    FROM floor_arena_coin_labels
    WHERE anchor_at >= ${since}::timestamptz AND (state = 'done' OR ${includeOpen}::boolean)
    ORDER BY anchor_at
  `);
  const labels: Label[] = raw.map((r) => ({
    mint: String(r.mint),
    anchorMs: msOf(r.anchor_at) ?? 0,
    features: { ...(obj(r.anchor_features) ?? {}), episodeAt: r.episode_at instanceof Date ? r.episode_at.toISOString() : r.episode_at },
    chainStatus: obj(r.chain_status),
    fate: String(r.fate_24h),
    marks: {
      m5: numOrNull(r.mult_5m), m15: numOrNull(r.mult_15m), m30: numOrNull(r.mult_30m), m60: numOrNull(r.mult_60m),
      h6: numOrNull(r.mult_6h), h24: numOrNull(r.mult_24h),
    },
    pnl: numOrNull(r.common_exit_pnl_usd),
  }));
  console.log(`floor arena coin labels: ${labels.length} labels anchored since ${since} (${includeOpen ? 'open + done' : 'done only'})`);
  console.log('common exit = $20, TP +20 %, stop -20 %, 60 min, engine paper costs (coin-labels.ts COMMON_EXIT)');
  console.log('NOTE: fail:<code> groups are a REPLAY of each bot\'s CURRENT params at the anchor time (pass events are per coin,');
  console.log('      fail events are not), so a coin that would have passed later counts as a fail here.');
  console.log('\nALL LABELS');
  print([summarize('all', labels)]);
  if (labels.length === 0) return;

  const agents = await q(sql`SELECT id, name, params FROM floor_arena_agents WHERE kind = 'house' ORDER BY id`);
  const minAt = new Date(Math.min(...labels.map((l) => l.anchorMs)) - 5 * 60_000).toISOString();
  const passes = await q(sql`
    SELECT agent_id, mint, min(at) AS at FROM (
      SELECT agent_id, mint, at FROM floor_arena_events WHERE type = 'pass' AND at >= ${minAt}::timestamptz AND mint IS NOT NULL
      UNION ALL
      SELECT agent_id, mint, at FROM floor_arena_events_archive WHERE type = 'pass' AND at >= ${minAt}::timestamptz AND mint IS NOT NULL
    ) x GROUP BY agent_id, mint, date_trunc('hour', at)
  `);
  const positions = await q(sql`
    SELECT agent_id, mint, opened_at, pnl_usd FROM floor_arena_positions WHERE opened_at >= ${minAt}::timestamptz
  `);
  const index = (rows: Row[], atKey: string) => {
    const m = new Map<string, Array<{ at: number; pnl: number | null }>>();
    for (const r of rows) {
      const key = `${r.agent_id}|${r.mint}`;
      const list = m.get(key) ?? [];
      list.push({ at: msOf(r[atKey]) ?? 0, pnl: numOrNull(r.pnl_usd) });
      m.set(key, list);
    }
    return m;
  };
  const passIdx = index(passes, 'at');
  const posIdx = index(positions, 'opened_at');
  const inEpisode = <T extends { at: number }>(list: T[] | undefined, anchorMs: number): T[] =>
    (list ?? []).filter((x) => x.at >= anchorMs - 5 * 60_000 && x.at <= anchorMs + 86_400_000);

  for (const agent of agents) {
    const params = obj(agent.params) as unknown as FloorArenaParams | null;
    if (!params) continue;
    const groups = new Map<string, Label[]>();
    const add = (g: string, l: Label) => { const list = groups.get(g) ?? []; list.push(l); groups.set(g, list); };
    let botNet = 0;
    let botN = 0;
    for (const l of labels) {
      const key = `${agent.id}|${l.mint}`;
      const pos = inEpisode(posIdx.get(key), l.anchorMs);
      if (pos.length > 0) {
        add('entered', l);
        for (const p of pos) if (p.pnl !== null) { botNet += p.pnl; botN += 1; }
        continue;
      }
      if (inEpisode(passIdx.get(key), l.anchorMs).length > 0) { add('pass, not entered', l); continue; }
      const fails = replay(l, params);
      if (fails.length === 0) { add('replay pass, no pass event', l); continue; }
      add('never passed (any fail)', l);
      for (const code of fails) add(`fail:${code}`, l);
      if (fails.length === 1) add(`sole fail:${fails[0]}`, l);
    }
    console.log(`\n${agent.id} (${agent.name})  actual closed P&L of the entered labels: n=${botN} net_usd=${botNet.toFixed(2)}`);
    const order = (g: string) => (g === 'entered' ? 0 : g.startsWith('pass') ? 1 : g.startsWith('replay') ? 2 : g.startsWith('never') ? 3 : g.startsWith('fail') ? 4 : 5);
    print([...groups.entries()].sort((a, b) => order(a[0]) - order(b[0]) || (a[0] < b[0] ? -1 : 1)).map(([g, ls]) => summarize(g, ls)));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('label report failed:', error instanceof Error ? error.message.slice(0, 200) : 'error');
    process.exit(1);
  });
