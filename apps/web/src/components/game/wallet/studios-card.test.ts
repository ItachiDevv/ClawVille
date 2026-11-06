import { describe, expect, test } from 'bun:test';
import { ApiError } from '@/lib/api';
import type { StudiosRequestView } from '@/lib/api';
import { keepsRequestKey, studiosErrorText, studiosPayerNotice, studiosRequestFor, studiosRequestOutcome } from './studios-card';

describe('a request that waits or runs keeps its key (no second charge from a second click)', () => {
  let n = 0;
  const newKey = () => `web-k${++n}`;
  const view = (status: StudiosRequestView['status'], extra: Partial<StudiosRequestView> = {}): StudiosRequestView => ({
    requestId: 'r1', operation: 'image', status, mode: 'signin', mediaPath: null, media: [], code: null, ...extra,
  });

  test('after a 202 running, the same prompt reuses the key and the request id', () => {
    const first = studiosRequestFor(null, 'image', 'a crab', newKey);
    const running = { ...first, requestId: 'r1' };
    const again = studiosRequestFor(running, 'image', 'a crab', newKey);
    expect(again).toBe(running);
    expect(again.key).toBe(first.key);
  });

  test('a changed prompt, or no open request (it ended), gets a new key', () => {
    const open = { ...studiosRequestFor(null, 'image', 'a crab', newKey), requestId: 'r1' };
    expect(studiosRequestFor(open, 'image', 'a fish', newKey).key).not.toBe(open.key);
    expect(studiosRequestFor(null, 'image', 'a crab', newKey).key).not.toBe(open.key);
  });

  test('waiting, pending and running are not an end: keep polling, keep the button off', () => {
    for (const status of ['awaiting_approval', 'pending', 'running'] as const) expect(studiosRequestOutcome(view(status))).toBeNull();
    expect(studiosRequestOutcome(undefined)).toBeNull();
  });

  test('every terminal state ends the request', () => {
    expect(studiosRequestOutcome(view('done', { media: [{ slot: 'image', mediaId: 'm1', mediaPath: '/api/media/m1' }] })))
      .toEqual({ kind: 'done', mediaPath: '/api/media/m1', note: 'Made with your Studios account.' });
    expect(studiosRequestOutcome(view('done', { mode: 'wallet', mediaPath: '/api/media/m2' })))
      .toEqual({ kind: 'done', mediaPath: '/api/media/m2', note: 'Paid from your agent wallet.' });
    expect(studiosRequestOutcome(view('declined'))).toEqual({ kind: 'failed', code: 'approval_declined', blockPrompt: false });
    expect(studiosRequestOutcome(view('expired'))).toEqual({ kind: 'failed', code: 'approval_expired', blockPrompt: false });
    expect(studiosRequestOutcome(view('ambiguous'))).toEqual({ kind: 'failed', code: 'payment_ambiguous', blockPrompt: true });
    // Charged nothing: the same prompt may go again with a new key.
    expect(studiosRequestOutcome(view('failed', { code: 'studios_signin_broken' }))).toEqual({ kind: 'failed', code: 'studios_signin_broken', blockPrompt: false });
    // May have charged (the outcome is not known): the same prompt is blocked.
    expect(studiosRequestOutcome(view('failed', { code: 'outcome_unknown' }))).toEqual({ kind: 'failed', code: 'outcome_unknown', blockPrompt: true });
  });
});

describe('studiosPayerNotice', () => {
  const key = { linked: true, last4: 'ab12' };
  const none = { linked: false, last4: null };
  test('follows the chosen pay mode, not only whether a key is saved', () => {
    expect(studiosPayerNotice('signin', key)).toContain('Studios sign-in');
    expect(studiosPayerNotice('wallet', key)).toContain('agent wallet');
    expect(studiosPayerNotice('key', key)).toContain('key ending ab12');
    expect(studiosPayerNotice('key', none)).toContain('no key is saved');
  });
  test('not chosen: the saved key if any, else the wallet', () => {
    expect(studiosPayerNotice(null, key)).toContain('key ending ab12');
    expect(studiosPayerNotice(null, none)).toContain('agent wallet');
    expect(studiosPayerNotice(undefined, undefined)).toContain('agent wallet');
  });
});

describe('keepsRequestKey', () => {
  test('keeps the request key after an uncertain outcome, so a retry cannot pay twice', () => {
    for (const code of ['duplicate_request', 'rate_limited', 'payment_ambiguous', 'image_missing', 'invalid_request']) {
      expect(keepsRequestKey(new ApiError(code, 409, code))).toBe(true);
    }
    expect(keepsRequestKey(new Error('network'))).toBe(true);
    expect(keepsRequestKey(new ApiError('Bad gateway', 502))).toBe(true);
  });

  test('drops the key only after a final refusal that charged nothing', () => {
    for (const code of ['spend_rules_not_set', 'over_daily_cap', 'studios_account_refused', 'daily_limit', 'vendor_refused']) {
      expect(keepsRequestKey(new ApiError(code, 403, code))).toBe(false);
    }
  });
});

// The Studios card shows plain text for every refusal; never a raw API code.

describe('studiosErrorText', () => {
  test('points to the spend caps when no rules are set', () => {
    expect(studiosErrorText(new ApiError('x', 403, 'spend_rules_not_set'))).toContain('spend caps');
  });

  test('warns that an ambiguous payment counts toward the cap', () => {
    expect(studiosErrorText(new ApiError('x', 502, 'payment_ambiguous'))).toContain('counts toward your daily cap');
  });

  test('says nothing was paid on a cap refusal', () => {
    expect(studiosErrorText(new ApiError('x', 403, 'over_daily_cap'))).toContain('Nothing was paid');
  });

  test('never shows a raw code', () => {
    const codes = [
      'spend_rules_not_set', 'vendor_not_allowed', 'over_per_call_cap', 'over_daily_cap', 'payment_ambiguous',
      'studios_key_invalid', 'studios_account_refused', 'rate_limited', 'invalid_studios_key',
      'studios_key_needs_human_login', 'studios_key_human_only', 'wallet_missing', 'payment_prepare_failed',
      'vendor_unreachable', 'vendor_refused', 'vendor_quote_invalid', 'vendor_pay_to_changed',
      'duplicate_request', 'payload_too_large', 'daily_limit', 'image_missing', 'studios_key_needs_wallet_link',
      'studios_key_needs_wallet_proof', 'studios_key_invalid_wallet_proof', 'some_new_code',
    ];
    for (const code of codes) {
      expect(studiosErrorText(new ApiError(code, 403, code))).not.toMatch(/[a-z]+_[a-z_]+/);
    }
    expect(studiosErrorText(new ApiError('Invalid request', 400))).not.toMatch(/[a-z]+_[a-z_]+/);
    expect(studiosErrorText(new Error('network'))).not.toMatch(/[a-z]+_[a-z_]+/);
  });
});
