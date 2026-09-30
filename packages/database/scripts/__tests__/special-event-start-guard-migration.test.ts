import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { pokerTournaments, specialEvents } from '../../src/schema';

// Security M4 (2026-09-30) migration invariants. Located by suffix, not number,
// because the integration step may renumber the file.
const migrationsDir = join(import.meta.dir, '..', '..', 'migrations');
const file = readdirSync(migrationsDir).find((name) => name.endsWith('_special_event_start_guard.sql'));
const migration = file ? readFileSync(join(migrationsDir, file), 'utf8') : '';

const statusValues = (text: string): string[] =>
  [...text.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!).sort();

describe('special-event start guard migration (security M3/M4/H2)', () => {
  it('exists exactly once', () => {
    expect(file).toBeDefined();
  });

  it('states the status CHECK unconditionally (added where it is absent, e.g. the CI replay)', () => {
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS "special_events_status_check"');
    expect(migration).toContain('ADD CONSTRAINT "special_events_status_check"');
    expect(migration).not.toMatch(/IF EXISTS \(\s*SELECT 1 FROM pg_constraint/);
  });

  it('allows the same statuses as the Drizzle schema CHECK, including starting', () => {
    const addLine = migration
      .split('\n')
      .find((line) => line.includes('CHECK (status = ANY'));
    expect(addLine).toBeDefined();
    const check = getTableConfig(specialEvents).checks.find(
      (c) => c.name === 'special_events_status_check',
    );
    expect(check).toBeDefined();
    const drizzleSql = new PgDialect().sqlToQuery(check!.value).sql;
    expect(statusValues(addLine!)).toEqual(statusValues(drizzleSql));
    expect(statusValues(drizzleSql)).toContain('starting');
  });

  it('adds every column the schema declares for the start claim and the treasury seed', () => {
    const eventColumns = getTableConfig(specialEvents).columns.map((c) => c.name);
    const tournamentColumns = getTableConfig(pokerTournaments).columns.map((c) => c.name);
    for (const name of ['start_claim_id', 'start_claimed_at']) {
      expect(eventColumns).toContain(name);
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS "${name}"`);
    }
    expect(tournamentColumns).toContain('seed_prize_pool_ct');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "seed_prize_pool_ct"');
  });

  it('creates the two unique indexes the schema declares', () => {
    const indexNames = [
      ...getTableConfig(pokerTournaments).indexes,
      ...getTableConfig(specialEvents).indexes,
    ].map((index) => index.config.name);
    for (const name of [
      'poker_tournaments_special_event_active_unique',
      'poker_results_tournament_placement_unique',
    ]) {
      expect(migration).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "${name}"`);
    }
    expect(indexNames).toContain('poker_tournaments_special_event_active_unique');
  });
});
