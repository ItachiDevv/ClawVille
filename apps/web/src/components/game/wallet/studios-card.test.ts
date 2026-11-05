import { describe, expect, test } from 'bun:test';
import { ApiError } from '@/lib/api';
import { studiosErrorText } from './studios-card';

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
