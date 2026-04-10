/**
 * One-time backfill: generate a custodial Solana wallet for every pet that
 * doesn't have one yet. Safe to run multiple times — ensurePetWallet() is
 * idempotent per pet_id.
 *
 * Usage:
 *   bun run scripts/backfill-pet-wallets.ts         # dry run, shows count
 *   bun run scripts/backfill-pet-wallets.ts --apply # actually generates
 *
 * ⚠️  Requires VANITY_ENCRYPTION_KEY in .env.local (same hex key used for
 *     treasury_wallets + vanity_keypairs). Without it, encryption throws
 *     and the backfill aborts cleanly.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, pets } from '@clawville/database';
import { isNull } from 'drizzle-orm';
import { ensurePetWallet } from '../apps/api/src/services/pet-wallet-service';

async function main() {
  const apply = process.argv.includes('--apply');

  if (!process.env.VANITY_ENCRYPTION_KEY) {
    console.error('[backfill] VANITY_ENCRYPTION_KEY not set — aborting.');
    process.exit(1);
  }

  const targets = await db
    .select({ id: pets.id, name: pets.name })
    .from(pets)
    .where(isNull(pets.walletAddress));

  console.log(`[backfill] Found ${targets.length} pets without a wallet.`);

  if (!apply) {
    console.log('[backfill] Dry run — pass --apply to actually generate.');
    for (const p of targets.slice(0, 10)) {
      console.log(`  - ${p.id}  ${p.name}`);
    }
    if (targets.length > 10) console.log(`  … and ${targets.length - 10} more`);
    process.exit(0);
  }

  let generated = 0;
  let alreadyHad = 0;
  let failed = 0;

  for (const p of targets) {
    try {
      const result = await ensurePetWallet(p.id);
      if (result.alreadyExisted) {
        alreadyHad += 1;
      } else {
        generated += 1;
        console.log(`  ✓ ${p.id}  ${p.name}  → ${result.publicKey}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${p.id}  ${p.name}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log('');
  console.log(`[backfill] Done. generated=${generated} already=${alreadyHad} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
