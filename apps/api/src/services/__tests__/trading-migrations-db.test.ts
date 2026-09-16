import { describe, expect, test } from 'bun:test';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const expectedChecks = [
  'clawpump_agent_links_objective_valid',
  'clawpump_agent_links_float_nonneg',
  'clawpump_agent_links_armed_needs_baseline',
  'clawpump_agent_links_armed_needs_evidence',
  'trading_decisions_origin_valid',
  'trading_decisions_status_valid',
  'trading_decisions_amount_positive',
  'trading_decisions_local_confirm_valid',
  'trading_halts_scope_valid',
  'trading_halts_clear_stamp',
  'trading_usdc_reservations_amount_positive',
  'trading_usdc_reservations_status_valid',
  'trading_usdc_reservations_release_stamp',
] as const;

const expectedPartialIndexes = [
  'trading_decisions_avatar_spend_idx',
  'trading_decisions_signature_uniq',
  'trading_decisions_directive_uniq',
  'trading_halts_active_fleet_uniq',
  'trading_halts_active_agent_uniq',
  'trading_usdc_reservations_liability_idx',
] as const;

describeIfDb('Trading Floor migrated database constraints', () => {
  test('0064 and 0065 checks and partial indexes exist', async () => {
    const { db, sql } = await import('@clawville/database');
    // A JS array interpolated into `sql\`\`` becomes a Postgres record (tuple),
    // which cannot be cast to text[] ("cannot cast type record to text[]" on
    // the CI lane). Bind each name as its own parameter inside IN (...).
    const inList = (names: readonly string[]) => sql.join(names.map((name) => sql`${name}`), sql`, `);
    const checks = await db.execute<{ conname: string }>(sql`
      SELECT conname
      FROM pg_constraint
      WHERE contype = 'c'
        AND conname IN (${inList(expectedChecks)})
    `);
    const checkNames = new Set(Array.from(checks).map((row) => row.conname));
    expect([...expectedChecks].filter((name) => !checkNames.has(name))).toEqual([]);

    const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (${inList(expectedPartialIndexes)})
    `);
    const partialNames = new Set(
      Array.from(indexes).filter((row) => /\bWHERE\b/i.test(row.indexdef)).map((row) => row.indexname),
    );
    expect([...expectedPartialIndexes].filter((name) => !partialNames.has(name))).toEqual([]);
  });
});
