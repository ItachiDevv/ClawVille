import { describe, expect, it, mock } from 'bun:test';
import * as realDatabase from '@clawville/database';

let policyCap: bigint | null = null;
const sponsorshipRows: Array<Record<string, unknown>> = [];
let scenario: 'distinct' | 'historical' = 'distinct';
let existingSponsorship: Record<string, unknown> | null = null;
let historicalPolicyCap: bigint | null = null;
let currentPolicyCap: bigint | null = null;

const fakeDb = {
  async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    let executeCount = 0;
    let policySelectCount = 0;
    const tx = {
      execute: async () => {
        executeCount += 1;
        return executeCount === 1
          ? []
          : [{ used_lamports: '0', exceeds_cap: false }];
      },
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === realDatabase.bountyGasCapPolicies) {
                if (scenario === 'historical') {
                  policySelectCount += 1;
                  return policySelectCount === 1
                    ? [{ capDay: '2026-08-09', capLamports: historicalPolicyCap }]
                    : [{ capDay: '2026-08-10', capLamports: currentPolicyCap }];
                }
                return policyCap == null
                  ? []
                  : [{ capDay: '2026-08-10', capLamports: policyCap }];
              }
              if (table === realDatabase.bountyGasSponsorships) {
                return existingSponsorship ? [{ ...existingSponsorship }] : [];
              }
              return [];
            },
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          if (table === realDatabase.bountyGasCapPolicies) {
            return {
              onConflictDoNothing: async () => {
                if (scenario === 'historical') {
                  if (currentPolicyCap == null) currentPolicyCap = values.capLamports as bigint;
                } else if (policyCap == null) {
                  policyCap = values.capLamports as bigint;
                }
              },
            };
          }
          return Promise.resolve().then(() => {
            sponsorshipRows.push(values);
          });
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              if (!existingSponsorship) return [];
              Object.assign(existingSponsorship, values);
              return [{ id: existingSponsorship.id }];
            },
          }),
        }),
      }),
    };
    return fn(tx);
  },
};

mock.module('@clawville/database', () => ({ ...realDatabase, db: fakeDb }));

const {
  _authorizeBroadcastForTest,
  _reserveSponsorshipForTest,
} = await import('../sap-gas-sponsor');

describe('database-owned bounty gas cap policy', () => {
  it('first distinct dedupe key owns the UTC-day cap and a second pod with a different cap is refused', async () => {
    scenario = 'distinct';
    policyCap = null;
    existingSponsorship = null;
    sponsorshipRows.length = 0;
    const transfer = (suffix: string) => ({
      signature: `signature-${suffix}`,
      serializedTransaction: `bytes-${suffix}`,
      blockhash: `blockhash-${suffix}`,
      lastValidBlockHeight: 123,
    });

    const first = await _reserveSponsorshipForTest({
      context: {
        bountyId: '550e8400-e29b-41d4-a716-446655440000',
        leg: 'settle',
      },
      workerWallet: 'worker-a',
      lamports: 5_000_000n,
      capLamports: 150_000_000n,
      transfer: transfer('a'),
      claimId: '11111111-1111-4111-8111-111111111111',
    });
    const second = await _reserveSponsorshipForTest({
      context: {
        bountyId: '660f9500-f30c-42e5-b827-557766551111',
        leg: 'finalize',
      },
      workerWallet: 'worker-b',
      lamports: 5_000_000n,
      capLamports: 200_000_000n,
      transfer: transfer('b'),
      claimId: '22222222-2222-4222-8222-222222222222',
    });

    expect(first).toMatchObject({ kind: 'pending', replay: false });
    expect(second).toEqual({
      kind: 'cap_mismatch',
      recordedCapLamports: 150_000_000n,
      callCapLamports: 200_000_000n,
    });
    expect(String(policyCap)).toBe('150000000');
    expect(sponsorshipRows).toHaveLength(1);
  });

  it('M2 — verifies the historical row policy, then re-homes onto today\'s DB policy', async () => {
    scenario = 'historical';
    historicalPolicyCap = 150_000_000n;
    currentPolicyCap = null;
    existingSponsorship = {
      id: 'gas-existing',
      status: 'pending',
      signature: 'historical-signature',
      serializedTransaction: 'historical-bytes',
      blockhash: 'historical-blockhash',
      lastValidBlockHeight: 123n,
      lamports: 5_000_000n,
      capDay: '2026-08-09',
      capLamports: 150_000_000n,
      workerWallet: 'worker-a',
      claimId: null,
      claimedAt: null,
      dedupeKey: 'bounty:550e8400-e29b-41d4-a716-446655440000:gas:settle',
    };

    const reservation = await _reserveSponsorshipForTest({
      context: {
        bountyId: '550e8400-e29b-41d4-a716-446655440000',
        leg: 'settle',
      },
      workerWallet: 'worker-a',
      lamports: 5_000_000n,
      capLamports: 200_000_000n,
      transfer: null,
      claimId: '33333333-3333-4333-8333-333333333333',
    });

    expect(reservation).toMatchObject({ kind: 'pending', replay: true });
    const authorization = await _authorizeBroadcastForTest({
      dedupeKey: 'bounty:550e8400-e29b-41d4-a716-446655440000:gas:settle',
      claimId: '33333333-3333-4333-8333-333333333333',
      capLamports: 200_000_000n,
    });

    expect(authorization).toEqual({ kind: 'authorized' });
    expect(existingSponsorship).toMatchObject({
      capDay: '2026-08-10',
      capLamports: 200_000_000n,
    });
    expect(String(currentPolicyCap)).toBe('200000000');
  });

  it('an expired-missing quarantine remains cap-owned and refuses replacement bytes', async () => {
    scenario = 'historical';
    historicalPolicyCap = 150_000_000n;
    currentPolicyCap = 150_000_000n;
    sponsorshipRows.length = 0;
    existingSponsorship = {
      id: 'gas-quarantined',
      status: 'quarantined',
      signature: 'quarantined-signature',
      serializedTransaction: 'quarantined-bytes',
      blockhash: 'expired-blockhash',
      lastValidBlockHeight: 123n,
      lamports: 5_000_000n,
      capDay: '2026-08-09',
      capLamports: 150_000_000n,
      workerWallet: 'worker-a',
      claimId: null,
      claimedAt: null,
      dedupeKey: 'bounty:550e8400-e29b-41d4-a716-446655440000:gas:settle',
    };

    const reservation = await _reserveSponsorshipForTest({
      context: {
        bountyId: '550e8400-e29b-41d4-a716-446655440000',
        leg: 'settle',
      },
      workerWallet: 'worker-a',
      lamports: 6_000_000n,
      capLamports: 150_000_000n,
      transfer: {
        signature: 'replacement-forbidden',
        serializedTransaction: 'replacement-bytes-forbidden',
        blockhash: 'replacement-blockhash',
        lastValidBlockHeight: 456,
      },
      claimId: '44444444-4444-4444-8444-444444444444',
    });

    expect(reservation).toEqual({
      kind: 'quarantined',
      signature: 'quarantined-signature',
    });
    expect(existingSponsorship).toMatchObject({
      signature: 'quarantined-signature',
      status: 'quarantined',
    });
    expect(sponsorshipRows).toHaveLength(0);
  });
});
