/**
 * floor-arena-jev-report.ts — READ-ONLY report for the Jev ENTRY SHADOW on the Trading Floor arena paper bots
 * (FEATURE_GATE jev_arena_entry_shadow, service `src/services/floor-arena/jev-entry.ts`, table
 * `floor_arena_jev_entry`, migration 0082).
 *
 * Run inside the api container (DATABASE_URL already set there):
 *   bun apps/api/scripts/floor-arena-jev-report.ts
 *
 * Join: each `ok` row -> the earliest `floor_arena_positions` row with the same agent_id + mint and
 * opened_at in [decided_at, decided_at + 30 s] (quote timeout 15 s; Codex r1: a wide window could join a refused attempt's verdict to a later trade), closed with a non-null pnl_usd.
 * ACTUAL = every closed paper trade with pnl since the first Jev row. VIRTUAL TWIN = ACTUAL minus the trades joined to
 * a `veto` row (a trade with no Jev answer is kept: no answer never vetoes). SELECT statements only; prints no
 * secrets (no key, no DB URL; the table stores no prompt text).
 */

import { db, sql } from '@clawville/database';
import { jevArenaCaps } from '../src/services/floor-arena/jev-entry';

type Row = Record<string, unknown>;

async function q(query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute<Row>(query)) as unknown as Row[];
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function table(rows: Row[]): void {
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const r of rows) console.log(`  ${Object.entries(r).map(([k, v]) => `${k}=${v ?? 'null'}`).join('  ')}`);
}

interface Trade {
  positionId: string;
  agentId: string;
  pnlUsd: number;
  pnlMult: number | null;
  /** null = no joined ok Jev row. */
  jev: {
    verdict: string | null;
    hitsTp: number | null;
    dumps: number | null;
    exitRoom: number | null;
    demand: number | null;
    momentum: string | null;
    holderRisk: number | null;
  } | null;
}

function metrics(trades: Trade[]): string {
  const n = trades.length;
  if (n === 0) return 'n=0';
  const wins = trades.filter((t) => t.pnlUsd > 0).length;
  const sum = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const mults = trades.map((t) => t.pnlMult).filter((m): m is number => m !== null);
  const meanMult = mults.length ? mults.reduce((s, m) => s + m, 0) / mults.length : null;
  return `n=${n}  win=${((100 * wins) / n).toFixed(1)}%  sum_pnl=$${sum.toFixed(2)}  mean_pnl=$${(sum / n).toFixed(3)}`
    + `  mean_mult=${meanMult === null ? 'n/a' : meanMult.toFixed(3)}`;
}

function band01(v: number | null): string {
  if (v === null) return 'null';
  const lo = Math.min(9, Math.floor(v * 10)) / 10;
  return `${lo.toFixed(1)}-${(lo + 0.1).toFixed(1)}`;
}

function bucketReport(label: string, trades: Trade[], key: (t: Trade) => string): void {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = key(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  console.log(`\n  ${label}:`);
  if (groups.size === 0) console.log('    (none)');
  for (const k of [...groups.keys()].sort()) console.log(`    ${k.padEnd(10)} ${metrics(groups.get(k)!)}`);
}

async function main(): Promise<void> {
  const env = process.env.CLAWVILLE_ENV ?? '(unset)';
  const caps = jevArenaCaps(process.env.CLAWVILLE_ENV);
  console.log(`=== Jev arena entry shadow report (CLAWVILLE_ENV=${env}) ===`);
  console.log('WARNING: one day of data is too small to set final thresholds; treat every number below as a first look.');

  console.log('\nCoverage: rows by status');
  table(await q(sql`
    SELECT status, COUNT(*)::int AS n, MIN(created_at) AS first, MAX(created_at) AS last
    FROM floor_arena_jev_entry GROUP BY status ORDER BY n DESC`));

  const [spend] = await q(sql`
    SELECT COALESCE(SUM(usd), 0)::text AS total,
           COALESCE(SUM(usd) FILTER (
             WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
           ), 0)::text AS today,
           COALESCE(SUM(input_tokens), 0)::bigint::text AS tokens,
           MIN(decided_at) AS since
    FROM floor_arena_jev_entry`);
  console.log('\nSpend (usd column; reserved/error/timeout rows keep their upper-bound estimate):');
  console.log(`  total  $${num(spend?.total).toFixed(6)} of cap $${caps.totalUsd.toFixed(2)}`);
  console.log(`  today  $${num(spend?.today).toFixed(6)} of cap $${caps.dailyUsd.toFixed(2)} (UTC day)`);
  console.log(`  billed input tokens ${num(spend?.tokens)}`);

  console.log('\nJev latency (ms, ok/error/timeout rows):');
  table(await q(sql`
    SELECT COUNT(jev_ms)::int AS n,
           ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY jev_ms)::numeric) AS p50,
           ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY jev_ms)::numeric) AS p95
    FROM floor_arena_jev_entry WHERE status IN ('ok', 'error', 'timeout') AND jev_ms IS NOT NULL`));

  const since = spend?.since ? new Date(String(spend.since)) : null;
  if (!since || !Number.isFinite(since.getTime())) {
    console.log('\nNo Jev rows yet: nothing to join.');
    return;
  }

  // Each ok row -> the earliest matching closed position. Positions joined by 2+ rows keep the latest decision.
  const joined = await q(sql`
    SELECT DISTINCT ON (p.id) p.id AS position_id, j.verdict, j.hits_tp, j.dumps, j.exit_room, j.demand, j.momentum,
           j.holder_risk
    FROM floor_arena_jev_entry j
    CROSS JOIN LATERAL (
      SELECT fp.id FROM floor_arena_positions fp
      WHERE fp.agent_id = j.agent_id AND fp.mint = j.mint AND fp.status = 'closed' AND fp.pnl_usd IS NOT NULL
        AND fp.opened_at >= j.decided_at AND fp.opened_at <= j.decided_at + interval '30 seconds'
      ORDER BY fp.opened_at ASC LIMIT 1
    ) p
    WHERE j.status = 'ok'
    ORDER BY p.id, j.decided_at DESC`);
  const [okCount] = await q(sql`SELECT COUNT(*)::int AS n FROM floor_arena_jev_entry WHERE status = 'ok'`);
  console.log(`\nJoin: ${joined.length} closed positions joined to an ok row; ok rows ${num(okCount?.n)}`
    + ` (an unjoined ok row = the quote/insert refused, the position is still open, or no pnl yet).`);

  const positions = await q(sql`
    SELECT id, agent_id, pnl_usd::text AS pnl_usd, pnl_mult::text AS pnl_mult
    FROM floor_arena_positions
    WHERE status = 'closed' AND pnl_usd IS NOT NULL AND opened_at >= ${since.toISOString()}::timestamptz`);
  const jevByPosition = new Map(joined.map((r) => [String(r.position_id), r]));
  const trades: Trade[] = positions.map((p) => {
    const j = jevByPosition.get(String(p.id));
    return {
      positionId: String(p.id),
      agentId: String(p.agent_id),
      pnlUsd: num(p.pnl_usd),
      pnlMult: numOrNull(p.pnl_mult),
      jev: j ? {
        verdict: j.verdict === null || j.verdict === undefined ? null : String(j.verdict),
        hitsTp: numOrNull(j.hits_tp),
        dumps: numOrNull(j.dumps),
        exitRoom: numOrNull(j.exit_room),
        demand: numOrNull(j.demand),
        momentum: j.momentum === null || j.momentum === undefined ? null : String(j.momentum),
        holderRisk: numOrNull(j.holder_risk),
      } : null,
    };
  });
  const withJev = trades.filter((t) => t.jev !== null);
  console.log(`Actual closed trades since ${since.toISOString()}: ${trades.length}; with a Jev answer ${withJev.length};`
    + ` without (kept in the twin) ${trades.length - withJev.length}.`);

  console.log('\nPer bot (ACTUAL / VIRTUAL TWIN = actual minus v0 vetoes / VETOED):');
  const agents = [...new Set(trades.map((t) => t.agentId))].sort();
  const all = { actual: [] as Trade[], twin: [] as Trade[], vetoed: [] as Trade[] };
  for (const agentId of agents) {
    const actual = trades.filter((t) => t.agentId === agentId);
    const vetoed = actual.filter((t) => t.jev?.verdict === 'veto');
    const twin = actual.filter((t) => t.jev?.verdict !== 'veto');
    all.actual.push(...actual);
    all.twin.push(...twin);
    all.vetoed.push(...vetoed);
    console.log(`  ${agentId}`);
    console.log(`    actual  ${metrics(actual)}`);
    console.log(`    twin    ${metrics(twin)}`);
    console.log(`    vetoed  ${metrics(vetoed)}`);
  }
  console.log('  ALL BOTS');
  console.log(`    actual  ${metrics(all.actual)}`);
  console.log(`    twin    ${metrics(all.twin)}`);
  console.log(`    vetoed  ${metrics(all.vetoed)}`);

  console.log('\nPer answer bucket (trades with a Jev answer, all bots):');
  bucketReport('hits_tp', withJev, (t) => band01(t.jev!.hitsTp));
  bucketReport('dumps', withJev, (t) => band01(t.jev!.dumps));
  bucketReport('exit_room (0 No .. 3 Easily)', withJev, (t) => String(t.jev!.exitRoom ?? 'null'));
  bucketReport('demand (0 Inorganic .. 3 Broad)', withJev, (t) => String(t.jev!.demand ?? 'null'));
  bucketReport('holder_risk (0 Low .. 3 Severe)', withJev, (t) => String(t.jev!.holderRisk ?? 'null'));
  bucketReport('momentum', withJev, (t) => t.jev!.momentum ?? 'null');

  console.log('\nThreshold sweep (trades with a Jev answer; keep = hits_tp >= floor AND dumps < ceiling; null keeps):');
  for (const floor of [0.2, 0.3, 0.4, 0.5, 0.6]) {
    for (const ceiling of [0.4, 0.5, 0.6, 0.7]) {
      const keep = (t: Trade) => (t.jev!.hitsTp === null || t.jev!.hitsTp >= floor) && (t.jev!.dumps === null || t.jev!.dumps < ceiling);
      const kept = withJev.filter(keep);
      const cut = withJev.filter((t) => !keep(t));
      const sum = (ts: Trade[]) => ts.reduce((s, t) => s + t.pnlUsd, 0).toFixed(2);
      console.log(`  hits_tp>=${floor.toFixed(1)} dumps<${ceiling.toFixed(1)}  kept n=${kept.length} sum=$${sum(kept)}`
        + `  vetoed n=${cut.length} sum=$${sum(cut)}`);
    }
  }
  console.log('\nWARNING: one day of data is too small to set final thresholds.');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // A server SQL error (has `severity`) carries no credentials; a connection error can name the host, so print
    // only its code.
    const e = err as { code?: unknown; severity?: unknown; message?: unknown };
    const detail = e && typeof e === 'object' && e.severity ? String(e.message) : `code=${String(e?.code ?? 'unknown')}`;
    console.error(`[floor-arena-jev-report] failed: ${detail}`);
    process.exit(1);
  });
