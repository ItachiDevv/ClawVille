import { beforeEach, describe, expect, it } from 'bun:test';
import type { AutonomyStatusResponse } from '@clawville/shared';
import {
  readAutonomyWalletCached,
  readAutonomyWalletUncached,
  resetAutonomyWalletCacheForTest,
  resolveAutonomyStatusForOwner,
} from '../world';

const OWNER_ID = 'wallet-owner';
const ENROLLED_STATUS: AutonomyStatusResponse = {
  enrolled: true,
  phase: 'deciding',
  targetBuildingId: null,
  targetLabel: null,
  bodyId: 'public-body',
  phaseSince: 123,
  thoughts: [],
  wallet: null,
};

beforeEach(() => resetAutonomyWalletCacheForTest());

describe('GET /api/world/autonomy/status wallet contract', () => {
  it('attaches balance and signed-ledger UTC-day sums to an enrolled response', async () => {
    let receivedMidnight = '';
    const wallet = await readAutonomyWalletUncached(
      OWNER_ID,
      Date.parse('2026-08-19T18:42:00.000Z'),
      {
        findAvatar: async (ownerUserId) => {
          expect(ownerUserId).toBe(OWNER_ID);
          return { id: 'avatar-1', clawTokens: 9_876 };
        },
        readDailyTotals: async (avatarId, utcMidnightIso) => {
          expect(avatarId).toBe('avatar-1');
          receivedMidnight = utcMidnightIso;
          return { earnedToday: '135', spentToday: '42' };
        },
      },
    );

    const response = await resolveAutonomyStatusForOwner(
      OWNER_ID,
      () => ENROLLED_STATUS,
      async () => wallet,
    );

    expect(receivedMidnight).toBe('2026-08-19T00:00:00.000Z');
    expect(response).toEqual({
      ...ENROLLED_STATUS,
      wallet: { balance: 9_876, earnedToday: 135, spentToday: 42 },
    });
  });

  it('returns wallet null when any wallet read fails', async () => {
    const response = await resolveAutonomyStatusForOwner(
      OWNER_ID,
      () => ENROLLED_STATUS,
      async () => {
        throw new Error('database unavailable');
      },
    );

    expect(response).toEqual({ ...ENROLLED_STATUS, wallet: null });
  });

  it('does not read the wallet for an unenrolled owner', async () => {
    let walletReads = 0;
    const response = await resolveAutonomyStatusForOwner(
      OWNER_ID,
      () => ({ enrolled: false }),
      async () => {
        walletReads += 1;
        return { balance: 1, earnedToday: 1, spentToday: 1 };
      },
    );

    expect(response).toEqual({ enrolled: false });
    expect(walletReads).toBe(0);
  });

  it('caches successes and failures per owner for 30 seconds', async () => {
    let reads = 0;
    const reader = async () => {
      reads += 1;
      if (reads === 2) throw new Error('temporary failure');
      return { balance: 10, earnedToday: 2, spentToday: 1 };
    };

    expect(await readAutonomyWalletCached(OWNER_ID, 1_000, reader)).toEqual({
      balance: 10,
      earnedToday: 2,
      spentToday: 1,
    });
    await readAutonomyWalletCached(OWNER_ID, 30_999, reader);
    expect(reads).toBe(1);

    expect(await readAutonomyWalletCached(OWNER_ID, 31_000, reader)).toBeNull();
    expect(await readAutonomyWalletCached(OWNER_ID, 60_999, reader)).toBeNull();
    expect(reads).toBe(2);
  });
});
