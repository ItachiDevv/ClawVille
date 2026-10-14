/**
 * jev-decide-shadow-report.ts — READ-ONLY report for the Jev decide SHADOW
 * (FEATURE_GATE jev_decide_shadow, service `src/services/jev-decide-shadow.ts`,
 * table `jev_decide_shadow`, migration 0081).
 *
 * Run inside the api container (DATABASE_URL already set there):
 *   bun apps/api/scripts/jev-decide-shadow-report.ts
 *
 * SELECT statements only. Prints no secrets: no key, no DB URL, no prompt or
 * reply text (the table does not store them).
 */

import { db, sql } from '@clawville/database';
import { jevSpendCaps } from '../src/services/jev-decide-shadow';

type Row = Record<string, unknown>;

async function q(query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute<Row>(query)) as unknown as Row[];
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function pct(a: number, b: number): string {
  return b > 0 ? `${((100 * a) / b).toFixed(1)}%` : 'n/a';
}

function table(rows: Row[]): void {
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const r of rows) {
    console.log(`  ${Object.entries(r).map(([k, v]) => `${k}=${v ?? 'null'}`).join('  ')}`);
  }
}

async function main(): Promise<void> {
  const env = process.env.CLAWVILLE_ENV ?? '(unset)';
  const caps = jevSpendCaps(process.env.CLAWVILLE_ENV);
  console.log(`=== Jev decide shadow report (CLAWVILLE_ENV=${env}) ===`);

  console.log('\nRows by status:');
  table(await q(sql`
    SELECT status, COUNT(*)::int AS n, MIN(created_at) AS first, MAX(created_at) AS last
    FROM jev_decide_shadow GROUP BY status ORDER BY n DESC`));

  const [spend] = await q(sql`
    SELECT COALESCE(SUM(usd), 0)::text AS total,
           COALESCE(SUM(usd) FILTER (
             WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
           ), 0)::text AS today,
           COALESCE(SUM(input_tokens), 0)::bigint::text AS tokens
    FROM jev_decide_shadow`);
  console.log('\nSpend (usd column; reserved/error/timeout rows keep their estimate):');
  console.log(`  total  $${num(spend?.total).toFixed(6)} of cap $${caps.totalUsd.toFixed(2)}`);
  console.log(`  today  $${num(spend?.today).toFixed(6)} of cap $${caps.dailyUsd.toFixed(2)} (UTC day)`);
  console.log(`  billed input tokens ${num(spend?.tokens)}`);

  const [agree] = await q(sql`
    SELECT COUNT(*)::int AS compared,
           COUNT(*) FILTER (WHERE jev_verb = local_verb)::int AS agreed
    FROM jev_decide_shadow
    WHERE status = 'ok' AND NOT local_empty AND local_verb IS NOT NULL`);
  console.log('\nAgreement (Jev ok, local non-empty with a parsed verb):');
  console.log(`  ${num(agree?.agreed)} / ${num(agree?.compared)} = ${pct(num(agree?.agreed), num(agree?.compared))}`);

  const [unparsed] = await q(sql`
    SELECT COUNT(*)::int AS n FROM jev_decide_shadow
    WHERE status = 'ok' AND NOT local_empty AND local_verb IS NULL`);
  console.log(`  (local replied but no whitelisted [ACTION:] parsed: ${num(unparsed?.n)} rows, excluded)`);

  console.log('\nAgreement by local_verb:');
  table(await q(sql`
    SELECT local_verb, COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE jev_verb = local_verb)::int AS agreed,
           ROUND(100.0 * COUNT(*) FILTER (WHERE jev_verb = local_verb) / COUNT(*), 1) AS pct
    FROM jev_decide_shadow
    WHERE status = 'ok' AND NOT local_empty AND local_verb IS NOT NULL
    GROUP BY local_verb ORDER BY n DESC`));

  console.log('\nJev pick distribution (status ok):');
  table(await q(sql`
    SELECT jev_verb, COUNT(*)::int AS n, ROUND(AVG(jev_top_prob)::numeric, 3) AS avg_top_prob
    FROM jev_decide_shadow WHERE status = 'ok'
    GROUP BY jev_verb ORDER BY n DESC`));

  const [emptyLocal] = await q(sql`
    SELECT COUNT(*)::int AS local_empty,
           COUNT(*) FILTER (WHERE status = 'ok')::int AS jev_answered
    FROM jev_decide_shadow WHERE local_empty AND status <> 'skipped_cap'`);
  console.log('\nLocal empty reply (timeout/error) — did Jev have an answer?');
  console.log(`  ${num(emptyLocal?.jev_answered)} / ${num(emptyLocal?.local_empty)} = ${pct(num(emptyLocal?.jev_answered), num(emptyLocal?.local_empty))}`);

  console.log('\nLatency ms (p50 / p95):');
  table(await q(sql`
    SELECT 'local' AS model, COUNT(local_ms)::int AS n,
           ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY local_ms)::numeric) AS p50,
           ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY local_ms)::numeric) AS p95
    FROM jev_decide_shadow WHERE status <> 'skipped_cap' AND local_ms IS NOT NULL
    UNION ALL
    SELECT 'jev' AS model, COUNT(jev_ms)::int AS n,
           ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY jev_ms)::numeric) AS p50,
           ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY jev_ms)::numeric) AS p95
    FROM jev_decide_shadow WHERE status IN ('ok', 'error', 'timeout') AND jev_ms IS NOT NULL`));
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // A server SQL error (has `severity`) carries no credentials; a connection
    // error can name the host, so print only its code.
    const e = err as { code?: unknown; severity?: unknown; message?: unknown };
    const detail = e && typeof e === 'object' && e.severity ? String(e.message) : `code=${String(e?.code ?? 'unknown')}`;
    console.error(`[jev-shadow-report] failed: ${detail}`);
    process.exit(1);
  });
