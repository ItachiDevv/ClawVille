/**
 * The raw-sql Date-param gate used by the special-event and tournament manager
 * fake dbs (security batch 2). It must catch a Date at any depth and pass the
 * ISO-string + `::timestamptz` form.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  assertNoDateParams,
  findDateParams,
  takeDateParamViolations,
} from './helpers/sql-date-param-guard';

const events = pgTable('special_events', {
  id: uuid('id'),
  startClaimedAt: timestamp('start_claimed_at', { withTimezone: true }),
});

afterEach(() => {
  takeDateParamViolations();
});

describe('sql Date-param guard', () => {
  it('flags a bare Date param', () => {
    const q = sql`UPDATE special_events SET start_claimed_at = ${new Date(0)} WHERE id = ${'e1'}`;
    expect(findDateParams(q)).toHaveLength(1);
    expect(() => assertNoDateParams(q)).toThrow(/binds a JS Date/);
    expect(takeDateParamViolations()).toHaveLength(1);
    expect(takeDateParamViolations()).toHaveLength(0);
  });

  it('flags a Date inside a nested fragment, an array, and sql.param()', () => {
    const inner = sql`start_claimed_at < ${new Date(0)}`;
    const q = sql`SELECT id FROM special_events WHERE ${inner}
                  AND x IN ${[1, new Date(1)]} AND y = ${sql.param(new Date(2))}`;
    expect(findDateParams(q)).toHaveLength(3);
  });

  it('passes the ISO-string form, nulls, columns, and other primitives', () => {
    const q = sql`UPDATE special_events
                  SET start_claimed_at = ${new Date(0).toISOString()}::timestamptz,
                      x = ${null}, y = ${5}, z = ${'s'}, w = ${[1, 'a']}
                  WHERE ${events.startClaimedAt} < now() AND ${events.id} = ${'e1'}`;
    expect(findDateParams(q)).toEqual([]);
    expect(() => assertNoDateParams(q)).not.toThrow();
  });
});
