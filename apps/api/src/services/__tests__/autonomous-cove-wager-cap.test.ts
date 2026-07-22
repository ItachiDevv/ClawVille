import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { autonomousCoveDailyUsageQuery } from '../autonomous-cove-wager-cap';

describe('autonomous cove daily wager usage', () => {
  it('derives UTC midnight from the same PostgreSQL transaction clock as ledger created_at', () => {
    const compiled = new PgDialect().sqlToQuery(
      autonomousCoveDailyUsageQuery('avatar-boundary-test'),
    );

    // PostgreSQL now() is fixed at transaction start, just like defaultNow()
    // on the admitted debit. If that timestamp is just before UTC midnight,
    // both the debit and this lower bound therefore remain in the old UTC day
    // even when the waiting Node process crosses midnight before this query.
    expect(compiled.sql).toContain(
      "created_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'",
    );
    expect(compiled.params).toEqual(['avatar-boundary-test']);
    expect(compiled.sql).toContain('amount < 0');
    expect(compiled.sql).toContain("metadata ->> 'autonomousCove' = 'true'");
  });
});
