import { afterEach, describe, expect, it } from 'bun:test';
import {
  isTier1BountySweeperRunning,
  resolveTier1BountySweepMs,
  startTier1BountySweeper,
  stopTier1BountySweeper,
} from '../bounty-tier1-sweeper';

afterEach(() => {
  stopTier1BountySweeper();
  delete process.env.BOUNTY_TIER1_SWEEP_MS;
});

describe('Tier-1 bounty expiry sweeper', () => {
  it('resolves the independent cadence default and one-minute floor', () => {
    delete process.env.BOUNTY_TIER1_SWEEP_MS;
    expect(resolveTier1BountySweepMs()).toBe(300_000);
    process.env.BOUNTY_TIER1_SWEEP_MS = '59999';
    expect(resolveTier1BountySweepMs()).toBe(300_000);
    process.env.BOUNTY_TIER1_SWEEP_MS = '60000';
    expect(resolveTier1BountySweepMs()).toBe(60_000);
    process.env.BOUNTY_TIER1_SWEEP_MS = 'not-a-duration';
    expect(resolveTier1BountySweepMs()).toBe(300_000);
  });

  it('starts and stops idempotently', () => {
    expect(isTier1BountySweeperRunning()).toBe(false);
    startTier1BountySweeper();
    startTier1BountySweeper();
    expect(isTier1BountySweeperRunning()).toBe(true);
    stopTier1BountySweeper();
    stopTier1BountySweeper();
    expect(isTier1BountySweeperRunning()).toBe(false);
  });
});
