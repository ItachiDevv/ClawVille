import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FLOOR_ARENA_TEMPLATES } from '@clawville/shared';
import type { ArenaTunerCheck } from '../floor-arena/analysis';

/**
 * Real-SQL checks of `rejectPendingReport` (floor-arena/analysis-store.ts),
 * both branches. The D33 branch patches `stats.suggestionCheck.reason` AND
 * `stats.suggestionCheck.tuner` in ONE UPDATE; the branch without a tuner
 * patches the reason only. Same opt-in as floor-arena-queries.db.test.ts:
 * DATABASE_URL AND (CI === 'true' or ARENA_DB_TEST=1). Fresh ids; deleting the
 * user cascades to the arena agent and its reports.
 */
const optedIn = process.env.CI === 'true' || process.env.ARENA_DB_TEST === '1';
const describeIfDb = process.env.DATABASE_URL && optedIn ? describe : describe.skip;

type ReportStats = Record<string, unknown> & { suggestionCheck: Record<string, unknown> };

describeIfDb('floor arena analysis store SQL on Postgres', () => {
  const userId = crypto.randomUUID();
  const agentId = `arena-store-db-${userId}`;
  const suggestion = { path: 'filters.age_min_s', from: 1_800, to: 3_000, reason: 'Code tuner: keeps 12 closed trades and excludes 12.' };
  const best = { path: 'filters.age_min_s', from: 1_800, to: 3_000, kept: 12, excluded: 12, edge: 0.6 };
  /** The tuner a report was inserted with (decision `changed`). */
  const insertedTuner: ArenaTunerCheck = { decision: 'changed', reason: 'changed', n: 24, needed: 20, best, p: 0.0005 };
  /** The final decision the tick passes after a refused apply. */
  const finalTuner: ArenaTunerCheck = { decision: 'none', reason: 'params_changed', n: 24, needed: 20, best, p: 0.0005 };
  const evidence = {
    method: 'filter_split',
    confirmed: true,
    kept: { n: 12, meanMult: 1.1, deaths: 0 },
    excluded: { n: 12, meanMult: 0.5, deaths: 12 },
    edge: 0.6,
  };

  /** Report stats with every other key the analysis writes, so a lost key shows. */
  function statsWith(check: Record<string, unknown>): ReportStats {
    return {
      version: 1,
      periodMinutes: 30,
      status: 'active',
      seated: true,
      openPositions: 1,
      paramsVersion: 3,
      period: { trades: 3, wins: 2, entries: 2, paramsVersions: [3] },
      currentParams: { trades: 24, meanMult: 0.8 },
      lifetime: { trades: 40, truncated: false },
      observations: ['first note', 'second note'],
      suggestionCheck: check,
    };
  }

  async function insertReport(stats: ReportStats, state: 'pending' | 'auto_applied'): Promise<string> {
    const { db, sql } = await import('@clawville/database');
    const { rowsOf } = await import('../floor-arena/queries');
    const rows = rowsOf<{ id: string }>(await db.execute(sql`
      INSERT INTO floor_arena_reports (agent_id, period_start, period_end, stats, summary, suggestion, suggestion_state)
      VALUES (${agentId}, now() - interval '30 minutes', now(), ${JSON.stringify(stats)}::jsonb, 'summary',
              ${JSON.stringify(suggestion)}::jsonb, ${state})
      RETURNING id
    `));
    return rows[0]!.id;
  }

  /** The row as text, parsed here, so the driver's jsonb parser cannot hide a double-encoded value. */
  async function readReport(id: string) {
    const { db, sql } = await import('@clawville/database');
    const { rowsOf } = await import('../floor-arena/queries');
    const rows = rowsOf<{ state: string; suggestion: string | null; stats: string; tuner_type: string | null }>(await db.execute(sql`
      SELECT suggestion_state AS state, suggestion::text AS suggestion, stats::text AS stats,
             jsonb_typeof(stats -> 'suggestionCheck' -> 'tuner') AS tuner_type
      FROM floor_arena_reports WHERE id = ${id}::uuid
    `));
    const row = rows[0]!;
    return {
      state: row.state,
      suggestion: row.suggestion === null ? null : JSON.parse(row.suggestion),
      stats: JSON.parse(row.stats) as ReportStats,
      tunerType: row.tuner_type,
    };
  }

  beforeAll(async () => {
    const { db, sql } = await import('@clawville/database');
    const params = JSON.stringify(FLOOR_ARENA_TEMPLATES[0]!.params);
    // users_has_auth_method needs email + password_hash (the CI schema restores that CHECK).
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, name)
      VALUES (${userId}::uuid, ${`arena-store-${userId}@clawville-test.invalid`}, ${`disabled-${userId}`}, 'Arena Store DB Test')
    `);
    await db.execute(sql`
      INSERT INTO floor_arena_agents (id, kind, owner_user_id, name, template_id, params, params_version)
      VALUES (${agentId}, 'user', ${userId}::uuid, 'Store Test', 'genesis', ${params}::jsonb, 3)
    `);
  });

  afterAll(async () => {
    const { db, sql } = await import('@clawville/database');
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}::uuid`);
  });

  test('D33 branch: one UPDATE sets the reason AND replaces the tuner with the passed object; other keys stay', async () => {
    const { createArenaAnalysisStore } = await import('../floor-arena/analysis-store');
    const check = { llm: 'ok', evidence, tuner: insertedTuner };
    const id = await insertReport(statsWith(check), 'pending');

    await createArenaAnalysisStore().rejectPendingReport(id, agentId, 'params_changed', finalTuner);

    const row = await readReport(id);
    expect(row.state).toBe('rejected');
    expect(row.suggestion).toBeNull();
    // Every other stats key and every other suggestionCheck key is unchanged.
    expect(row.stats).toEqual(statsWith({ llm: 'ok', evidence, tuner: finalTuner, reason: 'params_changed' }));
    expect(row.stats.suggestionCheck.tuner).toEqual(finalTuner);
    // Stored as a jsonb object, not a JSON string.
    expect(row.tunerType).toBe('object');
  });

  test('D33 branch on a report without a tuner key adds it', async () => {
    const { createArenaAnalysisStore } = await import('../floor-arena/analysis-store');
    const id = await insertReport(statsWith({ llm: 'failed', reason: 'llm_failed: timeout' }), 'pending');

    await createArenaAnalysisStore().rejectPendingReport(id, agentId, 'params_changed', finalTuner);

    const row = await readReport(id);
    expect(row.state).toBe('rejected');
    expect(row.stats).toEqual(statsWith({ llm: 'failed', reason: 'params_changed', tuner: finalTuner }));
    expect(row.tunerType).toBe('object');
  });

  test('branch without a tuner: sets the reason only; an existing tuner stays as it was, a missing one stays missing', async () => {
    const { createArenaAnalysisStore } = await import('../floor-arena/analysis-store');
    const store = createArenaAnalysisStore();
    const withTuner = await insertReport(statsWith({ llm: 'ok', evidence, tuner: insertedTuner }), 'pending');
    const withoutTuner = await insertReport(statsWith({ llm: 'skipped' }), 'pending');

    await store.rejectPendingReport(withTuner, agentId, 'params_changed');
    await store.rejectPendingReport(withoutTuner, agentId, 'params_changed');

    const a = await readReport(withTuner);
    expect(a.state).toBe('rejected');
    expect(a.suggestion).toBeNull();
    expect(a.stats).toEqual(statsWith({ llm: 'ok', evidence, tuner: insertedTuner, reason: 'params_changed' }));
    const b = await readReport(withoutTuner);
    expect(b.state).toBe('rejected');
    expect(b.stats).toEqual(statsWith({ llm: 'skipped', reason: 'params_changed' }));
    expect('tuner' in b.stats.suggestionCheck).toBe(false);
    expect(b.tunerType).toBeNull();
  });

  test('both branches touch only a PENDING report of that agent', async () => {
    const { createArenaAnalysisStore } = await import('../floor-arena/analysis-store');
    const store = createArenaAnalysisStore();
    const applied = await insertReport(statsWith({ llm: 'ok', tuner: insertedTuner }), 'auto_applied');
    const pending = await insertReport(statsWith({ llm: 'ok', tuner: insertedTuner }), 'pending');

    await store.rejectPendingReport(applied, agentId, 'params_changed', finalTuner);
    await store.rejectPendingReport(applied, agentId, 'params_changed');
    await store.rejectPendingReport(pending, `${agentId}-other`, 'params_changed', finalTuner);
    await store.rejectPendingReport(pending, `${agentId}-other`, 'params_changed');

    const a = await readReport(applied);
    expect(a.state).toBe('auto_applied');
    expect(a.suggestion).toEqual(suggestion);
    expect(a.stats).toEqual(statsWith({ llm: 'ok', tuner: insertedTuner }));
    const p = await readReport(pending);
    expect(p.state).toBe('pending');
    expect(p.suggestion).toEqual(suggestion);
    expect(p.stats).toEqual(statsWith({ llm: 'ok', tuner: insertedTuner }));
  });
});
