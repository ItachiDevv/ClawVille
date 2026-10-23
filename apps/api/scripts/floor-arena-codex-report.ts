/**
 * floor-arena-codex-report.ts - READ-ONLY money report for the Codex DECIDER SHADOW on the Trading Floor arena paper
 * bots (FEATURE_GATE codex_arena_entry_shadow, service `src/services/floor-arena/codex-entry.ts`, table
 * `floor_arena_codex_entry`, migration 0085, host sidecar `infra/codex-decider`).
 *
 * Run inside the api container (DATABASE_URL already set there):
 *   bun apps/api/scripts/floor-arena-codex-report.ts
 *
 * Join: each `ok` row -> the earliest `floor_arena_positions` row with the same agent_id +
 * mint and opened_at in [decided_at, decided_at + 30 s], closed with a non-null pnl_usd. ACTUAL = every closed paper
 * trade with pnl since the first Codex row. CODEX TWIN = ACTUAL minus the trades joined to a `skip` row (a trade with
 * no ok Codex answer is kept). CODEX-SKIPPED = the trades the twin removed. SELECT statements only; prints no secrets.
 */

import { db, sql } from '@clawville/database';

type Row = Record<string, unknown>;

async function q(query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute<Row>(query)) as unknown as Row[];
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function table(rows: Row[]): void {
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const r of rows) console.log(`  ${Object.entries(r).map(([k, v]) => `${k}=${v ?? 'null'}`).join('  ')}`);
}

interface Trade {
  agentId: string;
  pnlUsd: number;
  /** null = no joined ok Codex row. */
  decision: string | null;
  confidence: number | null;
}

/** Money view: net $, expectancy (mean $ per trade), avg win, avg loss, profit factor (gross win / gross loss). */
export function moneyMetrics(trades: Pick<Trade, 'pnlUsd'>[]): string {
  const n = trades.length;
  if (n === 0) return 'n=0';
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const net = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnlUsd, 0);
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : grossWin > 0 ? 'inf' : 'n/a';
  return `n=${n}  win=${((100 * wins.length) / n).toFixed(1)}%  net=$${net.toFixed(2)}  exp=$${(net / n).toFixed(3)}/trade`
    + `  avg_win=$${wins.length ? (grossWin / wins.length).toFixed(3) : 'n/a'}`
    + `  avg_loss=$${losses.length ? (-grossLoss / losses.length).toFixed(3) : 'n/a'}  pf=${pf}`;
}

async function main(): Promise<void> {
  console.log(`=== Codex decider shadow report (CLAWVILLE_ENV=${process.env.CLAWVILLE_ENV ?? '(unset)'}) ===`);
  console.log('WARNING: one day of data is too small to judge the decider; treat every number below as a first look.');

  console.log('\nRows by status:');
  table(await q(sql`
    SELECT status, COUNT(*)::int AS n, MIN(created_at) AS first, MAX(created_at) AS last
    FROM floor_arena_codex_entry GROUP BY status ORDER BY n DESC`));

  console.log('\nok rows by decision:');
  table(await q(sql`
    SELECT decision, COUNT(*)::int AS n, ROUND(AVG(confidence)::numeric, 3) AS avg_conf
    FROM floor_arena_codex_entry WHERE status = 'ok' GROUP BY decision ORDER BY decision`));

  console.log('\nLatency (ms, round trip seen by the API):');
  table(await q(sql`
    SELECT status, COUNT(ms)::int AS n,
           ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::numeric) AS p50,
           ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY ms)::numeric) AS p90
    FROM floor_arena_codex_entry WHERE ms IS NOT NULL GROUP BY status ORDER BY status`));

  const [first] = await q(sql`SELECT MIN(decided_at) AS since FROM floor_arena_codex_entry`);
  const since = first?.since ? new Date(String(first.since)) : null;
  if (!since || !Number.isFinite(since.getTime())) {
    console.log('\nNo Codex rows yet: nothing to join.');
    return;
  }

  // Each ok row -> the earliest matching closed position. A position joined by 2+ rows keeps the latest decision.
  const joined = await q(sql`
    SELECT DISTINCT ON (p.id) p.id AS position_id, c.decision, c.confidence
    FROM floor_arena_codex_entry c
    CROSS JOIN LATERAL (
      SELECT fp.id FROM floor_arena_positions fp
      WHERE fp.agent_id = c.agent_id AND fp.mint = c.mint AND fp.status = 'closed' AND fp.pnl_usd IS NOT NULL
        AND fp.opened_at >= c.decided_at AND fp.opened_at <= c.decided_at + interval '30 seconds'
      ORDER BY fp.opened_at ASC LIMIT 1
    ) p
    WHERE c.status = 'ok'
    ORDER BY p.id, c.decided_at DESC`);
  const byPosition = new Map(joined.map((r) => [String(r.position_id), r]));
  const positions = await q(sql`
    SELECT id, agent_id, pnl_usd::text AS pnl_usd
    FROM floor_arena_positions
    WHERE status = 'closed' AND pnl_usd IS NOT NULL AND opened_at >= ${since.toISOString()}::timestamptz`);
  const trades: Trade[] = positions.map((p) => {
    const j = byPosition.get(String(p.id));
    return {
      agentId: String(p.agent_id),
      pnlUsd: num(p.pnl_usd),
      decision: j && typeof j.decision === 'string' ? j.decision : null,
      confidence: j && j.confidence !== null && j.confidence !== undefined ? num(j.confidence) : null,
    };
  });
  const withCodex = trades.filter((t) => t.decision !== null);
  console.log(`\nJoin: ${joined.length} closed positions joined to an ok row. Actual closed trades since`
    + ` ${since.toISOString()}: ${trades.length}; with a Codex answer ${withCodex.length}; without (kept) ${trades.length - withCodex.length}.`);

  console.log('\nPer bot (ACTUAL / CODEX TWIN = actual minus skip / CODEX-SKIPPED):');
  const all = { actual: [] as Trade[], twin: [] as Trade[], skipped: [] as Trade[] };
  for (const agentId of [...new Set(trades.map((t) => t.agentId))].sort()) {
    const actual = trades.filter((t) => t.agentId === agentId);
    const skipped = actual.filter((t) => t.decision === 'skip');
    const twin = actual.filter((t) => t.decision !== 'skip');
    all.actual.push(...actual);
    all.twin.push(...twin);
    all.skipped.push(...skipped);
    console.log(`  ${agentId}`);
    console.log(`    actual   ${moneyMetrics(actual)}`);
    console.log(`    twin     ${moneyMetrics(twin)}`);
    console.log(`    skipped  ${moneyMetrics(skipped)}`);
  }
  console.log('  ALL BOTS');
  console.log(`    actual   ${moneyMetrics(all.actual)}`);
  console.log(`    twin     ${moneyMetrics(all.twin)}`);
  console.log(`    skipped  ${moneyMetrics(all.skipped)}`);

  console.log('\nBy decision + confidence (trades with a Codex answer):');
  for (const decision of ['enter', 'skip']) {
    for (const [lo, hi] of [[0, 0.5], [0.5, 0.7], [0.7, 1.01]] as const) {
      const g = withCodex.filter((t) => t.decision === decision && t.confidence !== null && t.confidence >= lo && t.confidence < hi);
      console.log(`  ${decision.padEnd(5)} conf ${lo.toFixed(1)}-${Math.min(hi, 1).toFixed(1)}  ${moneyMetrics(g)}`);
    }
  }
  console.log('\nWARNING: one day of data is too small to judge the decider.');
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      // A server SQL error (has `severity`) carries no credentials; a connection error can name the host: code only.
      const e = err as { code?: unknown; severity?: unknown; message?: unknown };
      const detail = e && typeof e === 'object' && e.severity ? String(e.message) : `code=${String(e?.code ?? 'unknown')}`;
      console.error(`[floor-arena-codex-report] failed: ${detail}`);
      process.exit(1);
    });
}
