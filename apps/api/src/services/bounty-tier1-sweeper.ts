/**
 * Tier-1 bounty expiry crank.
 *
 * Tier-1 holds are a kept, database-only USDC rail. Their expiry lifecycle is
 * intentionally independent from SAP composition settlement so retiring SAP
 * cannot strand an expired poster hold.
 */

import { sweepExpiredTier1Bounties } from './bounty-tier1';

const TIER1_SWEEP_MS_DEFAULT = 300_000; // 5 min
const TIER1_SWEEP_MS_FLOOR = 60_000; // 1 min

export function resolveTier1BountySweepMs(): number {
  const raw = process.env.BOUNTY_TIER1_SWEEP_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= TIER1_SWEEP_MS_FLOOR ? n : TIER1_SWEEP_MS_DEFAULT;
}

/** Run one off-chain Tier-1 expiry pass. */
export async function runTier1BountySweepPass(): Promise<void> {
  await sweepExpiredTier1Bounties();
}

let tier1SweepInterval: ReturnType<typeof setInterval> | null = null;

/** True while the Tier-1 expiry interval is live (tests + ops introspection). */
export function isTier1BountySweeperRunning(): boolean {
  return tier1SweepInterval !== null;
}

/** Start the Tier-1 expiry crank. Idempotent; the first pass runs after one interval. */
export function startTier1BountySweeper(): void {
  if (tier1SweepInterval) return;
  const periodMs = resolveTier1BountySweepMs();
  tier1SweepInterval = setInterval(() => {
    runTier1BountySweepPass().catch((err) => {
      console.error('[bounty-tier1] expiry sweep failed (non-fatal):', err);
    });
  }, periodMs);
  console.log(
    `[bounty-tier1] expiry sweeper started, releasing expired DB holds every ` +
      `${Math.round(periodMs / 60_000)}min`,
  );
}

/** Stop the Tier-1 expiry interval. Idempotent. */
export function stopTier1BountySweeper(): void {
  if (tier1SweepInterval) {
    clearInterval(tier1SweepInterval);
    tier1SweepInterval = null;
  }
}
