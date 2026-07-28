/**
 * Operator-only one-shot CLV live tick.
 *
 * This script never prints custody material. It emits the current oracle and
 * Jupiter route first, runs exactly one live tick, then prints each row's full
 * sweep/execute outcome plus public transaction signatures.
 */
import { db, clvBuyQueue, eq } from '@clawville/database';
import {
  getClvPrice,
  startClvPriceOracle,
  stopClvPriceOracle,
} from '../../src/services/clv-price-oracle';
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

type ClvPrice = ReturnType<typeof getClvPrice>;

function isOracleReady(price: ClvPrice): boolean {
  return (
    price.available &&
    typeof price.quoteUsd === 'number' &&
    Number.isFinite(price.quoteUsd) &&
    price.quoteUsd > 0
  );
}

async function waitForOracleReady(): Promise<ClvPrice> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const price = getClvPrice();
    if (isOracleReady(price)) return price;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    'CLV oracle did not expose a fresh positive finite price within 30 seconds; live tick was not run',
  );
}

async function main(): Promise<void> {
  console.log('[clv-swap-live-once] getClvPrice():');
  const initialPrice = getClvPrice();
  console.log(JSON.stringify(initialPrice, null, 2));
  console.log('[clv-swap-live-once] resolveJupiterBaseUrl():');
  console.log(resolveJupiterBaseUrl());

  // Require a fresh price before any funding sweep. Pool depth is deliberately
  // not a readiness dependency: the live executor gates each exact bounded
  // Jupiter candidate by its own priceImpactPct before signing.
  let startedOracle = false;
  try {
    if (!isOracleReady(initialPrice)) {
      startClvPriceOracle();
      startedOracle = true;
      const readyPrice = await waitForOracleReady();
      console.log('[clv-swap-live-once] warmed getClvPrice():');
      console.log(JSON.stringify(readyPrice, null, 2));
    }

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
  } finally {
    if (startedOracle) stopClvPriceOracle();
  }
}

main().catch((error: unknown) => {
  console.error('[clv-swap-live-once] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
