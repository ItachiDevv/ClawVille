import { describe, expect, test } from 'bun:test';
import {
  avatarSettlementAddressFields,
  resolveAvatarSettlementAddressFromCanonical,
} from '../avatar-settlement';

describe('avatar settlement resolver and fail-closed advertisement', () => {
  test('verified canonical row is ready', () => {
    const result = resolveAvatarSettlementAddressFromCanonical({
      publicKey: 'settlement-address',
      custodyVerified: true,
    });
    expect(result).toEqual({ status: 'ready', address: 'settlement-address' });
    expect(avatarSettlementAddressFields(result)).toEqual({
      walletAddress: 'settlement-address',
      walletPending: false,
    });
  });

  test('missing canonical row is pending and omits a fundable field', () => {
    const result = resolveAvatarSettlementAddressFromCanonical(null);
    expect(result).toEqual({ status: 'pending' });
    expect(avatarSettlementAddressFields(result)).toEqual({ walletPending: true });
  });

  test('unverified row, including a reconciliation exception, remains pending', () => {
    const result = resolveAvatarSettlementAddressFromCanonical({
      publicKey: 'must-not-advertise',
      custodyVerified: false,
    });
    expect(result).toEqual({ status: 'pending' });
    expect(avatarSettlementAddressFields(result)).not.toHaveProperty('walletAddress');
  });
});
