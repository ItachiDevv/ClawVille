import { describe, expect, it } from 'bun:test';
import { acceptsStagingMarkerRow, acceptsStagingTarget } from '../staging-db';

const STAGING_REF = 'mtpixvtclsjqjguouxes';
const PROD_REF = 'wheuidgiyyccqyoppxoa';
const TUNNEL = 'postgresql://clawville:secret@127.0.0.1:15432/clawville';
const LEGACY_POOLER = `postgresql://postgres.${STAGING_REF}:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
const LEGACY_DIRECT = `postgresql://postgres:secret@db.${STAGING_REF}.supabase.co:5432/postgres`;

describe('parity harness staging guard', () => {
  it('accepts a self-hosted database only when it is marked exactly staging', () => {
    expect(acceptsStagingTarget('staging', TUNNEL)).toBe(true);
    for (const marker of [null, '', 'production', 'Staging', 'staging ']) {
      expect(acceptsStagingTarget(marker, TUNNEL)).toBe(false);
    }
  });

  it('accepts the legacy staging Supabase identity only when no marker is set', () => {
    for (const url of [LEGACY_POOLER, LEGACY_DIRECT]) {
      expect(acceptsStagingTarget(null, url)).toBe(true);
      expect(acceptsStagingTarget('production', url)).toBe(false);
    }
  });

  it('decides from the database-level marker and refuses a spoofed session value', () => {
    const row = (database: string[] | null, session: string | null) => ({ database_markers: database, session_marker: session });
    expect(acceptsStagingMarkerRow(row(['clawville.env=staging'], 'staging'), TUNNEL)).toBe(true);
    expect(acceptsStagingMarkerRow(row(null, null), LEGACY_POOLER)).toBe(true);
    expect(acceptsStagingMarkerRow(row(null, 'staging'), TUNNEL)).toBe(false);
    expect(acceptsStagingMarkerRow(row(null, 'staging'), LEGACY_POOLER)).toBe(false);
    expect(acceptsStagingMarkerRow(row(['clawville.env=production'], 'staging'), TUNNEL)).toBe(false);
    expect(acceptsStagingMarkerRow(row(['clawville.env=staging', 'clawville.env=staging'], 'staging'), TUNNEL)).toBe(false);
    expect(acceptsStagingMarkerRow(undefined, TUNNEL)).toBe(false);
  });

  it('refuses a URL that only mentions the staging ref outside the identity', () => {
    expect(acceptsStagingTarget(null, `postgresql://postgres.${PROD_REF}:${STAGING_REF}@aws-0-us-west-1.pooler.supabase.com:5432/postgres`)).toBe(false);
    expect(acceptsStagingTarget(null, `postgresql://u:p@db.${STAGING_REF}.supabase.co.evil.example:5432/postgres`)).toBe(false);
    expect(acceptsStagingTarget(null, 'not-a-url')).toBe(false);
    // the right pooler user on a host that is not a Supabase pooler
    expect(acceptsStagingTarget(null, `postgresql://postgres.${STAGING_REF}:p@127.0.0.1:15432/clawville`)).toBe(false);
  });
});
