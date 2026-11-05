import { describe, expect, test } from 'bun:test';
import { ApiError } from '@/lib/api';
import { saveErrorText } from './spending-card';

// A human whose session predates migration 0089 gets 403
// spend_policy_needs_human_login on the first save. The card must show a plain
// next step, never the raw API code.

describe('saveErrorText', () => {
  test('tells a pre-0089 session to sign in again', () => {
    const err = new ApiError('spend_policy_needs_human_login', 403, 'spend_policy_needs_human_login');
    expect(saveErrorText(err)).toContain('sign in again');
  });

  test('explains the human-only refusal', () => {
    const err = new ApiError('spend_policy_human_only', 403, 'spend_policy_human_only');
    expect(saveErrorText(err)).toContain('Only you can change spend rules');
  });

  test('never shows a raw code', () => {
    for (const err of [
      new ApiError('spend_policy_needs_human_login', 403, 'spend_policy_needs_human_login'),
      new ApiError('some_new_code', 403, 'some_new_code'),
      new ApiError('Invalid request', 400),
      new Error('network'),
      null,
    ]) {
      expect(saveErrorText(err)).not.toMatch(/[a-z]+_[a-z_]+/);
    }
  });
});
