import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createBountySchema } from '../bounties';

const originalUsdcRewardMin = process.env.USDC_BOUNTY_REWARD_MIN;
const originalTier1Max = process.env.TIER1_BOUNTY_MAX_USD_CENTS;
const originalSapUsdcEscrow = process.env.SAP_USDC_ESCROW_ENABLED;

beforeAll(() => {
  delete process.env.USDC_BOUNTY_REWARD_MIN;
  delete process.env.TIER1_BOUNTY_MAX_USD_CENTS;
  process.env.SAP_USDC_ESCROW_ENABLED = 'false';
});

afterAll(() => {
  if (originalUsdcRewardMin === undefined) {
    delete process.env.USDC_BOUNTY_REWARD_MIN;
  } else {
    process.env.USDC_BOUNTY_REWARD_MIN = originalUsdcRewardMin;
  }
  if (originalTier1Max === undefined) delete process.env.TIER1_BOUNTY_MAX_USD_CENTS;
  else process.env.TIER1_BOUNTY_MAX_USD_CENTS = originalTier1Max;
  if (originalSapUsdcEscrow === undefined) delete process.env.SAP_USDC_ESCROW_ENABLED;
  else process.env.SAP_USDC_ESCROW_ENABLED = originalSapUsdcEscrow;
});

const baseBounty = {
  title: 'Small bounty',
  description: 'A precise bounty used to verify the minimum reward.',
  difficulty: 'beginner' as const,
};

const usdcBounty = {
  ...baseBounty,
  paymentRail: 'usdc' as const,
  acceptanceCriteria: 'The submitted result satisfies the stated requirement.',
  expiresAt: '2030-01-01T00:00:00.000Z',
};

describe('bounty create reward floors', () => {
  it('accepts a USDC-funded bounty at 5 vCLAW', () => {
    expect(createBountySchema.safeParse({ ...usdcBounty, tokenReward: 5 }).success).toBe(true);
  });

  it('rejects a USDC-funded bounty below 5 vCLAW', () => {
    expect(createBountySchema.safeParse({ ...usdcBounty, tokenReward: 4 }).success).toBe(false);
  });

  it('accepts the Tier-1 $20 cap and rejects one cent above while SAP is paused', () => {
    expect(createBountySchema.safeParse({ ...usdcBounty, tokenReward: 2_000 }).success).toBe(true);
    expect(createBountySchema.safeParse({ ...usdcBounty, tokenReward: 2_001 }).success).toBe(false);
  });

  it('does not let env raise the founder-frozen $20 ceiling', () => {
    process.env.TIER1_BOUNTY_MAX_USD_CENTS = '999999';
    try {
      expect(createBountySchema.safeParse({ ...usdcBounty, tokenReward: 2_000 }).success).toBe(true);
      expect(createBountySchema.safeParse({ ...usdcBounty, tokenReward: 2_001 }).success).toBe(false);
    } finally {
      delete process.env.TIER1_BOUNTY_MAX_USD_CENTS;
    }
  });

  it('accepts an in-game bounty at 5 vCLAW and defaults its rail to vclaw', () => {
    const parsed = createBountySchema.safeParse({ ...baseBounty, tokenReward: 5 });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.paymentRail).toBe('vclaw');
  });

  it('rejects an in-game bounty below 5 vCLAW', () => {
    expect(
      createBountySchema.safeParse({
        ...baseBounty,
        paymentRail: 'vclaw',
        tokenReward: 4,
      }).success,
    ).toBe(false);
  });
});
