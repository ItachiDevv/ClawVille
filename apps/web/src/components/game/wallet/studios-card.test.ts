import { describe, expect, test } from 'bun:test';
import { ApiError } from '@/lib/api';
import type { StudiosRequestView } from '@/lib/api';
import {
  effectiveStudiosPayMode,
  keepsRequestKey,
  operationAllowed,
  studiosErrorText,
  studiosInputFingerprint,
  studiosPayerNotice,
  studiosRequestFor,
  studiosRequestOutcome,
} from './studios-card';

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
      .toEqual({ kind: 'done', media: [{ mediaPath: '/api/media/m1', video: false }], note: 'Made with your Studios account.' });
    expect(studiosRequestOutcome(view('done', { mode: 'wallet', mediaPath: '/api/media/m2' })))
      .toEqual({ kind: 'done', media: [{ mediaPath: '/api/media/m2', video: false }], note: 'Paid from your agent wallet.' });
    // A video or recast result is a video; a done request with nothing copied says where the result is.
    expect(studiosRequestOutcome(view('done', { operation: 'video', mode: 'wallet', mediaPath: '/api/media/m3' })))
      .toEqual({ kind: 'done', media: [{ mediaPath: '/api/media/m3', video: true }], note: 'Paid from your agent wallet.' });
    const notCopied = studiosRequestOutcome(view('done', { operation: 'recast', mode: 'account', vendorMediaId: 'v1' }));
    expect(notCopied).toMatchObject({ kind: 'done', media: [] });
    expect((notCopied as { note: string }).note).toContain('Studios My Media');
    expect(studiosRequestOutcome(view('declined'))).toEqual({ kind: 'failed', code: 'approval_declined', blockInput: false });
    expect(studiosRequestOutcome(view('expired'))).toEqual({ kind: 'failed', code: 'approval_expired', blockInput: false });
    expect(studiosRequestOutcome(view('ambiguous'))).toEqual({ kind: 'failed', code: 'payment_ambiguous', blockInput: true });
    // Charged nothing: the same prompt may go again with a new key.
    expect(studiosRequestOutcome(view('failed', { code: 'studios_signin_broken' }))).toEqual({ kind: 'failed', code: 'studios_signin_broken', blockInput: false });
    // May have charged (the outcome is not known): the same prompt is blocked.
    expect(studiosRequestOutcome(view('failed', { code: 'outcome_unknown' }))).toEqual({ kind: 'failed', code: 'outcome_unknown', blockInput: true });
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
    for (const code of [
      'spend_rules_not_set', 'over_daily_cap', 'studios_account_refused', 'daily_limit', 'vendor_refused',
      // The rest of the server's not-charged set (studios-images.ts NOT_CHARGED_FAILURES).
      'studios_key_changed', 'studios_signin_changed', 'signin_option_unsupported', 'operation_needs_studios_key',
      'interrupted_not_paid', 'job_failed', 'media_quota_full', 'hosted_daily_cap',
    ]) {
      expect(keepsRequestKey(new ApiError(code, 403, code))).toBe(false);
    }
  });
});

// The Studios card shows plain text for every refusal; never a raw API code.

describe('outcomes that may have charged', () => {
  test('each has its own text: may have charged, do not try again, check My Media, credits and the wallet history', () => {
    const texts = ['outcome_unknown', 'job_timeout', 'result_lost', 'media_missing'].map((code) => {
      const text = studiosErrorText(new ApiError(code, 200, code));
      expect(text).toContain('may have charged');
      expect(text).toContain('Do not try it again');
      expect(text).toContain('My Media and credits');
      expect(text).toContain('wallet history');
      expect(text).not.toBe('That did not work. Try again later.');
      return text;
    });
    expect(new Set(texts).size).toBe(4);
  });

  test('the same prompt stays blocked after each of them', () => {
    for (const code of ['outcome_unknown', 'job_timeout', 'result_lost', 'media_missing']) {
      expect(studiosRequestOutcome({ requestId: 'r1', operation: 'image', status: 'failed', mode: 'signin', mediaPath: null, media: [], code }))
        .toEqual({ kind: 'failed', code, blockInput: true });
    }
  });
});

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
      'studios_key_changed', 'studios_signin_changed', 'signin_option_unsupported', 'operation_needs_studios_key',
      'interrupted_not_paid', 'job_failed', 'media_quota_full', 'hosted_daily_cap', 'invalid_request', 'request_not_found',
      'vendor_reply_unreadable', 'studios_signin_needs_wallet_link', 'studios_signin_needs_wallet_proof',
      'studios_signin_invalid_wallet_proof', 'studios_signin_human_only', 'studios_signin_needs_human_login',
      'studios_signin_bad_redirect', 'media_delete_needs_wallet_link', 'media_delete_needs_wallet_proof',
      'media_delete_invalid_wallet_proof', 'media_delete_human_only', 'media_delete_needs_human_login', 'not_found',
      'awaiting_approval', 'running', 'approval_pending_limit', 'studios_signin_missing', 'studios_signin_broken',
    ];
    for (const code of codes) {
      expect(studiosErrorText(new ApiError(code, 403, code))).not.toMatch(/[a-z]+_[a-z_]+/);
    }
    expect(studiosErrorText(new ApiError('Invalid request', 400))).not.toMatch(/[a-z]+_[a-z_]+/);
    expect(studiosErrorText(new Error('network'))).not.toMatch(/[a-z]+_[a-z_]+/);
  });
});

describe('the request key follows the whole input, not only the prompt', () => {
  test('the fingerprint ignores key order and changes with any field', () => {
    const a = studiosInputFingerprint({ prompt: 'a crab', model: 'm1', durationSeconds: 5 });
    expect(studiosInputFingerprint({ durationSeconds: 5, model: 'm1', prompt: 'a crab' })).toBe(a);
    expect(studiosInputFingerprint({ prompt: 'a crab', model: 'm1', durationSeconds: 6 })).not.toBe(a);
    expect(studiosInputFingerprint({ prompt: 'a crab', model: 'm2', durationSeconds: 5 })).not.toBe(a);
    expect(studiosInputFingerprint({ preset: 'p', imageUrls: ['x', 'y'] })).not.toBe(studiosInputFingerprint({ preset: 'p', imageUrls: ['y', 'x'] }));
  });

  test('the same input in another operation gets its own key', () => {
    let n = 0;
    const open = { ...studiosRequestFor(null, 'video', '{"prompt":"x"}', () => `k${++n}`), requestId: 'r1' };
    expect(studiosRequestFor(open, 'image', '{"prompt":"x"}', () => `k${++n}`).key).not.toBe(open.key);
  });
});

describe('pay mode gating', () => {
  test('wallet mode makes images and videos only; key and sign-in make everything', () => {
    expect(operationAllowed('wallet', 'image')).toBe(true);
    expect(operationAllowed('wallet', 'video')).toBe(true);
    expect(operationAllowed('wallet', 'character_shots')).toBe(false);
    expect(operationAllowed('wallet', 'recast')).toBe(false);
    for (const mode of ['key', 'signin'] as const) {
      for (const op of ['image', 'video', 'character_shots', 'recast'] as const) expect(operationAllowed(mode, op)).toBe(true);
    }
  });

  test('not chosen: the saved key if any, else the wallet (the server rule)', () => {
    expect(effectiveStudiosPayMode(null, { linked: true })).toBe('key');
    expect(effectiveStudiosPayMode(null, { linked: false })).toBe('wallet');
    expect(effectiveStudiosPayMode('signin', { linked: true })).toBe('signin');
  });
});
