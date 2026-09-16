import { describe, expect, test } from 'bun:test';

import { ApiError } from '@/lib/api';

describe('ApiError code normalisation', () => {
  test('keeps a string code', () => {
    const error = new ApiError('blocked', 403, 'guest_not_allowed');

    expect(error.code).toBe('guest_not_allowed');
    expect(error.status).toBe(403);
  });

  test.each([
    ['numeric', 403],
    ['null', null],
    ['object', { value: 'guest_not_allowed' }],
    ['array', ['guest_not_allowed']],
  ] as const)('drops a %s code', (_label, code) => {
    const error = new ApiError('blocked', 403, code);

    expect(error.code).toBeUndefined();
    expect(error.status).toBe(403);
  });
});
