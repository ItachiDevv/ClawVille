/**
 * Operator-only one-shot CLV live tick.
 *
 * This script never prints custody material. It emits the pinned Jupiter base,
 * runs exactly one live tick, then prints each row's full sweep/execute outcome
 * plus public transaction signatures. The live buy path deliberately has no
 * DexScreener/oracle availability gate; Jupiter's quote, on-chain ExactIn
 * minimum, price-impact cap, and pre-sign simulation are the safety boundary.
 */
import { db, clvBuyQueue, eq } from '@clawville/database';
import {
  resolveJupiterBaseUrl,
  runLiveClvSwapTick,
} from '../../src/services/clv-swap-live';

if (process.env.CLV_SWAP_EXECUTE !== 'true') {
  throw new Error('Refusing live tick: CLV_SWAP_EXECUTE must be the literal string "true"');
}

interface PersistedClipSignature {
  signature?: unknown;
}

async function main(): Promise<void> {
  console.log('[clv-swap-live-once] resolveJupiterBaseUrl():');
  console.log(resolveJupiterBaseUrl());

  const results = await runLiveClvSwapTick();
  console.log(`[clv-swap-live-once] tick rows: ${results.length}`);

  for (const result of results) {
    const [persisted] = await db
      .select({ txSignatures: clvBuyQueue.txSignatures })
      .from(clvBuyQueue)
      .where(eq(clvBuyQueue.id, result.queueId))
      .limit(1);
    const clipSignatures = Array.isArray(persisted?.txSignatures)
      ? (persisted.txSignatures as PersistedClipSignature[])
          .map((fill) => fill.signature)
          .filter((signature): signature is string => typeof signature === 'string')
      : [];

    console.log(
      JSON.stringify(
        {
          queueId: result.queueId,
          sweep: result.sweep,
          execute: result.execute,
          signatures: {
            sweep: result.sweep.ok ? result.sweep.sweepTxSignature : null,
            clips: clipSignatures,
          },
        },
        null,
        2,
      ),
    );
  }
}

main().catch((error: unknown) => {
  console.error('[clv-swap-live-once] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
