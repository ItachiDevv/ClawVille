import { describe, expect, it } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { bounties, bountyAttempts } from '@clawville/database';
import {
  MY_BOUNTY_ATTEMPTS_PER_BOUNTY,
  MY_LIST_DEFAULT_LIMIT,
  MY_LIST_MAX_LIMIT,
  parseBeforeCursor,
  parseMyListQuery,
} from '../bounties';

const BOUNTY_STATUSES = bounties.status.enumValues;
const ATTEMPT_STATUSES = bountyAttempts.status.enumValues;

function statusOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof HTTPException ? err.status : -1;
  }
}

describe('my-bounties / my-attempts query bounds', () => {
  it('defaults to no status filter and the default limit', () => {
    expect(parseMyListQuery(undefined, undefined, BOUNTY_STATUSES)).toEqual({
      statuses: null,
      limit: MY_LIST_DEFAULT_LIMIT,
    });
    expect(parseMyListQuery('', '', BOUNTY_STATUSES)).toEqual({
      statuses: null,
      limit: MY_LIST_DEFAULT_LIMIT,
    });
  });

  it('accepts the exact params the idex fleet sends', () => {
    expect(parseMyListQuery('open,in_progress', '50', BOUNTY_STATUSES)).toEqual({
      statuses: ['open', 'in_progress'],
      limit: 50,
    });
  });

  it('trims, dedupes and drops empty status parts', () => {
    expect(parseMyListQuery(' open , open ,', undefined, BOUNTY_STATUSES).statuses).toEqual(['open']);
    expect(parseMyListQuery(',,', undefined, BOUNTY_STATUSES).statuses).toBeNull();
  });

  it('rejects an unknown status with 400', () => {
    expect(statusOf(() => parseMyListQuery('bogus', undefined, BOUNTY_STATUSES))).toBe(400);
    expect(statusOf(() => parseMyListQuery('open,bogus', undefined, BOUNTY_STATUSES))).toBe(400);
    expect(statusOf(() => parseMyListQuery('OPEN', undefined, BOUNTY_STATUSES))).toBe(400);
  });

  it('validates attempt statuses against the attempt enum, not the bounty enum', () => {
    expect(parseMyListQuery('submitted,claimed', undefined, ATTEMPT_STATUSES).statuses).toEqual([
      'submitted',
      'claimed',
    ]);
    expect(statusOf(() => parseMyListQuery('completed', undefined, ATTEMPT_STATUSES))).toBe(400);
    expect(statusOf(() => parseMyListQuery('submitted', undefined, BOUNTY_STATUSES))).toBe(400);
  });

  it('clamps limit to 1..MAX', () => {
    expect(parseMyListQuery(undefined, '0', BOUNTY_STATUSES).limit).toBe(1);
    expect(parseMyListQuery(undefined, '-5', BOUNTY_STATUSES).limit).toBe(1);
    expect(parseMyListQuery(undefined, '9999', BOUNTY_STATUSES).limit).toBe(MY_LIST_MAX_LIMIT);
    expect(parseMyListQuery(undefined, String(MY_LIST_MAX_LIMIT), BOUNTY_STATUSES).limit).toBe(
      MY_LIST_MAX_LIMIT,
    );
  });

  it('rejects a non-integer limit with 400', () => {
    expect(statusOf(() => parseMyListQuery(undefined, 'abc', BOUNTY_STATUSES))).toBe(400);
    expect(statusOf(() => parseMyListQuery(undefined, '12.5', BOUNTY_STATUSES))).toBe(400);
    expect(statusOf(() => parseMyListQuery(undefined, '50abc', BOUNTY_STATUSES))).toBe(400);
  });

  it('accepts only plain decimal limits (no hex, exponent, or Infinity)', () => {
    expect(statusOf(() => parseMyListQuery(undefined, '0x10', BOUNTY_STATUSES))).toBe(400);
    expect(statusOf(() => parseMyListQuery(undefined, '1e3', BOUNTY_STATUSES))).toBe(400);
    expect(statusOf(() => parseMyListQuery(undefined, 'Infinity', BOUNTY_STATUSES))).toBe(400);
    expect(parseMyListQuery(undefined, '1000000000', BOUNTY_STATUSES).limit).toBe(MY_LIST_MAX_LIMIT);
    expect(parseMyListQuery(undefined, '9'.repeat(400), BOUNTY_STATUSES).limit).toBe(MY_LIST_MAX_LIMIT);
    expect(parseMyListQuery(undefined, '-' + '9'.repeat(400), BOUNTY_STATUSES).limit).toBe(1);
    expect(parseMyListQuery(undefined, ' 50 ', BOUNTY_STATUSES).limit).toBe(50);
    expect(parseMyListQuery(undefined, '-0', BOUNTY_STATUSES).limit).toBe(1);
  });

  it('parses the optional before cursor and rejects garbage with 400', () => {
    expect(parseBeforeCursor(undefined)).toBeNull();
    expect(parseBeforeCursor('  ')).toBeNull();
    expect(parseBeforeCursor('2026-09-25T21:41:06.760Z')?.toISOString()).toBe('2026-09-25T21:41:06.760Z');
    expect(statusOf(() => parseBeforeCursor('yesterday'))).toBe(400);
  });

  it('keeps the default and max inside a sane egress budget', () => {
    expect(MY_LIST_DEFAULT_LIMIT).toBe(200);
    expect(MY_LIST_MAX_LIMIT).toBe(500);
    expect(MY_BOUNTY_ATTEMPTS_PER_BOUNTY).toBe(20);
  });
});
