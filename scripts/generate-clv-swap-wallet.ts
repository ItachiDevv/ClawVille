/**
 * Generate the ONE dedicated CLV swap treasury wallet (purpose='clv-swap') and
 * store it AES-256-GCM-encrypted in `treasury_wallets` (Tokenomics C3).
 *
 * Usage:
 *   bun run scripts/generate-clv-swap-wallet.ts [notes]
 *
 * Reuses the exact `scripts/generate-treasury-keypair.ts` flow (local keygen →
 * immediate encrypt under VANITY_ENCRYPTION_KEY → insert), fixed to the
 * 'clv-swap' purpose, PLUS an idempotency guard: the swap wallet is a
 * SINGLETON — if a purpose='clv-swap' row already exists the script prints its
 * pubkey and exits WITHOUT inserting a second one (rotation is a deliberate
 * manual act, not a re-run).
 *
 * Security:
 *   - Only the base58 PUBLIC KEY is ever printed. The secret is encrypted
 *     before it leaves scope and MUST NEVER be logged, echoed, or read back.
 *   - The dry-run swap executor only READS the pubkey
 *     (`getClvSwapWalletPubkey()`); decrypt/sign is a Codex-review-gated seam.
 *   - Requires the 'clv-swap' enum value — apply migration
 *     `packages/database/migrations/0014_clv_swap_queue.sql` first.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { Keypair } from '@solana/web3.js';
import { db, treasuryWallets, eq } from '@clawville/database';
import { encryptSecretKey } from '../apps/api/src/services/keypair-vault';

async function main() {
  const notesArg = process.argv[2] ?? 'Tokenomics C3 — dedicated CLV buy-side swap wallet (dry-run only)';

  if (!process.env.VANITY_ENCRYPTION_KEY) {
    console.error('[clv-swap] VANITY_ENCRYPTION_KEY env var is not set. Set it before running.');
    process.exit(1);
  }

  // Idempotency: ONE clv-swap wallet. A re-run reports the existing row.
  const [existing] = await db
    .select({ id: treasuryWallets.id, publicKey: treasuryWallets.publicKey })
    .from(treasuryWallets)
    .where(eq(treasuryWallets.purpose, 'clv-swap'))
    .limit(1);
  if (existing) {
    console.log('[clv-swap] A clv-swap treasury wallet already exists — NOT creating another.');
    console.log(`  ID:         ${existing.id}`);
    console.log(`  Public key: ${existing.publicKey}`);
    console.log('Rotation is a deliberate manual act (new row + ops runbook), not a script re-run.');
    process.exit(0);
  }

  // 1. Generate fresh keypair in memory.
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();

  // 2. Encrypt the secret immediately — the raw bytes never leave this scope.
  const encrypted = encryptSecretKey(keypair.secretKey);

  // 3. Insert.
  const [row] = await db
    .insert(treasuryWallets)
    .values({
      purpose: 'clv-swap',
      publicKey,
      encryptedSecretKey: encrypted.encryptedSecretKey,
      encryptionIv: encrypted.encryptionIv,
      encryptionTag: encrypted.encryptionTag,
      notes: notesArg,
    })
    .returning({ id: treasuryWallets.id, publicKey: treasuryWallets.publicKey });

  // 4. Print ONLY the public key and DB id — never the secret.
  console.log('[clv-swap] Generated the CLV swap treasury wallet');
  console.log(`  ID:         ${row.id}`);
  console.log(`  Purpose:    clv-swap`);
  console.log(`  Public key: ${row.publicKey}`);
  console.log('');
  console.log('Secret key encrypted at rest. Do not attempt to recover or print it.');
  console.log('The dry-run executor reads ONLY this pubkey; live signing is Codex-review-gated.');

  process.exit(0);
}

main().catch((err) => {
  console.error('[clv-swap] Failed to generate swap wallet:', err);
  process.exit(1);
});
