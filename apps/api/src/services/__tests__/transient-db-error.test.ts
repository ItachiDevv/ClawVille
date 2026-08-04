import { describe, expect, it } from 'bun:test';
import { isTransientDbConnectionError } from '../transient-db-error';

describe('isTransientDbConnectionError', () => {
  for (const code of [
    'CONNECTION_CLOSED',
    'CONNECTION_ENDED',
    'CONNECTION_DESTROYED',
    'CONNECT_TIMEOUT',
  ]) {
    it(`classifies ${code} code properties`, () => {
      expect(isTransientDbConnectionError({ code })).toBe(true);
    });
  }

  it('classifies stringified postgres.js connection errors', () => {
    expect(
      isTransientDbConnectionError(
        new Error('write CONNECTION_CLOSED aws-1-us-east-1.pooler.supabase.com:6543'),
      ),
    ).toBe(true);
  });

  it('classifies write ECONNRESET errors', () => {
    expect(isTransientDbConnectionError(new Error('write ECONNRESET'))).toBe(true);
  });

  it('does not classify a plain Error', () => {
    expect(isTransientDbConnectionError(new Error('query failed'))).toBe(false);
  });

  it('does not classify Postgres constraint violations', () => {
    expect(isTransientDbConnectionError({ code: '23505' })).toBe(false);
  });

  it('does not classify HTTPException-like errors', () => {
    expect(
      isTransientDbConnectionError({
        name: 'HTTPException',
        status: 503,
        message: 'Service unavailable',
      }),
    ).toBe(false);
  });

  it('does not classify connection-token near misses', () => {
    expect(isTransientDbConnectionError('CONNECTION_POLICY')).toBe(false);
  });
});
