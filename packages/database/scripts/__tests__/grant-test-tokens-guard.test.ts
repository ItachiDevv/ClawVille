import { describe, expect, it } from 'bun:test';
import {
  GRANT_TARGET_MARKER_SQL,
  isDedicatedStagingDatabaseUrl,
  isStagingGrantTarget,
  resolveGrantTargetMarker,
  writeTargetMatchesPreCheck,
} from '../grant-test-tokens';
import { DATABASE_ENV_MARKER_SQL } from '../../../../apps/api/scripts/db-env-marker';

describe('grant-test-tokens marker source (catalog, not session)', () => {
  const row = (database: string[] | null, session: string | null) => ({ database_markers: database, session_marker: session });

  it('keeps its SQL identical to the shared apps/api reader', () => {
    expect(GRANT_TARGET_MARKER_SQL).toBe(DATABASE_ENV_MARKER_SQL);
  });

  it('returns the database-level marker when the session agrees', () => {
    expect(resolveGrantTargetMarker(row(['clawville.env=staging'], 'staging'))).toBe('staging');
    expect(resolveGrantTargetMarker(row(null, null))).toBeNull();
    expect(resolveGrantTargetMarker(row(['clawville.env='], ''))).toBeNull();
  });

  it('refuses a spoofed session value, two markers, or no row', () => {
    for (const refused of [
      row(null, 'staging'),
      row(['clawville.env=production'], 'staging'),
      row(['clawville.env=staging'], null),
      row(['clawville.env=staging', 'clawville.env=staging'], 'staging'),
    ]) {
      expect(resolveGrantTargetMarker(refused)).toBeUndefined();
    }
    expect(resolveGrantTargetMarker(undefined)).toBeUndefined();
  });

  it('writes only when the in-transaction marker equals the pre-check', () => {
    expect(writeTargetMatchesPreCheck('staging', row(['clawville.env=staging'], 'staging'))).toBe(true);
    expect(writeTargetMatchesPreCheck(null, row(null, null))).toBe(true);
    expect(writeTargetMatchesPreCheck('staging', row(['clawville.env=production'], 'production'))).toBe(false);
    expect(writeTargetMatchesPreCheck('staging', row(null, null))).toBe(false);
    expect(writeTargetMatchesPreCheck('staging', row(null, 'staging'))).toBe(false); // spoof on the write connection
    expect(writeTargetMatchesPreCheck('staging', undefined)).toBe(false);
  });
});

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

describe('grant-test-tokens target decision (URL + live clawville.env marker)', () => {
  const TUNNEL = 'postgresql://clawville:secret@127.0.0.1:15432/clawville';
  const LEGACY_DIRECT = `postgresql://postgres:secret@db.${STAGING_REF}.supabase.co:5432/postgres`;
  const LEGACY_POOLER = `postgresql://postgres.${STAGING_REF}:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;

  it('accepts a self-hosted database only when it is marked exactly staging', () => {
    expect(isStagingGrantTarget(TUNNEL, 'staging')).toBe(true);
    for (const marker of [null, '', 'production', 'Staging', 'staging ', 'dev']) {
      expect(isStagingGrantTarget(TUNNEL, marker)).toBe(false);
    }
  });

  it('accepts the legacy staging Supabase identities only when no other marker is set', () => {
    for (const url of [LEGACY_DIRECT, LEGACY_POOLER]) {
      expect(isStagingGrantTarget(url, null)).toBe(true);
      expect(isStagingGrantTarget(url, 'staging')).toBe(true);
      expect(isStagingGrantTarget(url, 'production')).toBe(false);
      expect(isStagingGrantTarget(url, 'dev')).toBe(false);
    }
  });

  it('refuses the known production project even when the database claims staging', () => {
    for (const url of [
      `postgresql://postgres:secret@db.${PROD_REF}.supabase.co:5432/postgres`,
      `postgresql://postgres.${PROD_REF}:secret@aws-0-us-west-1.pooler.supabase.com:6543/postgres`,
    ]) {
      expect(isStagingGrantTarget(url, 'staging')).toBe(false);
      expect(isStagingGrantTarget(url, null)).toBe(false);
    }
  });

  it('refuses non-Postgres and unparseable targets whatever the marker', () => {
    for (const url of ['https://127.0.0.1:15432/clawville', 'not-a-url', '']) {
      expect(isStagingGrantTarget(url, 'staging')).toBe(false);
    }
  });
});
