import { describe, expect, it } from 'bun:test';
import { isDedicatedStagingDatabaseUrl } from '../grant-test-tokens';

const STAGING_REF = 'mtpixvtclsjqjguouxes';
const PROD_REF = 'wheuidgiyyccqyoppxoa';

describe('grant-test-tokens database target guard', () => {
  it('accepts the exact staging direct and official pooler identities', () => {
    expect(
      isDedicatedStagingDatabaseUrl(
        `postgresql://postgres:secret@db.${STAGING_REF}.supabase.co:5432/postgres`,
      ),
    ).toBe(true);
    expect(
      isDedicatedStagingDatabaseUrl(
        `postgresql://postgres.${STAGING_REF}:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
      ),
    ).toBe(true);
  });

  it('rejects lookalike, custom-proxy, production, and non-Postgres targets', () => {
    const refused = [
      `postgresql://postgres:secret@db.${STAGING_REF}.supabase.co.evil.example:5432/postgres`,
      `postgresql://postgres.${STAGING_REF}:secret@database.internal.example:5432/postgres`,
      `postgresql://postgres:secret@db.${PROD_REF}.supabase.co:5432/postgres`,
      `postgresql://postgres.${PROD_REF}:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
      `postgresql://postgres:${STAGING_REF}@db.${PROD_REF}.supabase.co:5432/postgres`,
      `https://db.${STAGING_REF}.supabase.co/postgres`,
      'not-a-url',
    ];

    for (const url of refused) {
      expect(isDedicatedStagingDatabaseUrl(url)).toBe(false);
    }
  });
});
