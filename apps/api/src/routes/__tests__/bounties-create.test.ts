import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createBountySchema } from '../bounties';

const originalUsdcRewardMin = process.env.USDC_BOUNTY_REWARD_MIN;

beforeAll(() => {
  delete process.env.USDC_BOUNTY_REWARD_MIN;
});

afterAll(() => {
  if (originalUsdcRewardMin === undefined) {
    delete process.env.USDC_BOUNTY_REWARD_MIN;
  } else {
    process.env.USDC_BOUNTY_REWARD_MIN = originalUsdcRewardMin;
  }
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
