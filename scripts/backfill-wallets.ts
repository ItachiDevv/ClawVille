#!/usr/bin/env bun
/**
 * Compatibility entrypoint for the avatar-only wallet unification reconciler.
 * Agent wallet minting is permanently disabled.
 */
import { runWalletUnificationBackfill } from '../apps/api/scripts/wallet-unification/promote-avatar-wallets';

const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith('--only='));
if (only && only !== '--only=avatar') {
  console.error('[wallet-unification] Agent wallet backfill is disabled. Use avatar settlement wallets.');
  process.exit(2);
}

runWalletUnificationBackfill(args.filter((arg) => arg !== '--only=avatar')).catch((err) => {
  console.error('[wallet-unification] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
