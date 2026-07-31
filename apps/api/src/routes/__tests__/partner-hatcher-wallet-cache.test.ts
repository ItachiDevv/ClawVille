import { describe, expect, test } from 'bun:test';
import { avatarSettlementAddressFields } from '../../services/avatar-settlement';
import { mergeHatcherStatsSettlement } from '../../services/hatcher-wallet-advertisement';

describe('Hatcher settlement wallet advertisement', () => {
  test('stats merge replaces any cached wallet with the current resolver result', () => {
    const cached = {
      registration: {
        agentId: 'partner-agent',
        walletAddress: 'stale-wallet',
        walletPending: false,
      },
      leaderboard: { score: 10 },
    };
    expect(mergeHatcherStatsSettlement(cached, { status: 'pending' })).toEqual({
      registration: {
        agentId: 'partner-agent',
        walletPending: true,
      },
      leaderboard: { score: 10 },
    });
    expect(mergeHatcherStatsSettlement(cached, {
      status: 'ready',
      address: 'current-avatar-wallet',
    })).toMatchObject({
      registration: {
        walletAddress: 'current-avatar-wallet',
        walletPending: false,
      },
    });
  });

  test('pending public fields omit every fundable address', () => {
    const out = avatarSettlementAddressFields({ status: 'pending' });
    expect(out).toEqual({ walletPending: true });
    expect(out).not.toHaveProperty('walletAddress');
  });
});
