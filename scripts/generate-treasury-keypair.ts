/**
 * Generate a new Solana treasury keypair and store it encrypted.
 *
 * Usage:
 *   bun run scripts/generate-treasury-keypair.ts [purpose] [notes]
 *
 * Examples:
 *   bun run scripts/generate-treasury-keypair.ts x402-merchant "Phase 4 production merchant wallet"
 *   bun run scripts/generate-treasury-keypair.ts fee-collector
 *
 * Security:
 *   - The secret key is generated locally, encrypted immediately with AES-256-GCM
 *     (via the same VANITY_ENCRYPTION_KEY as vanity keypairs), and inserted into
 *     the treasury_wallets table
 *   - Only the base58 PUBLIC KEY is ever printed to stdout
 *   - The raw secret key bytes are zeroed from the Buffer after encryption where
 *     possible, but Node's crypto APIs make full zeroization impossible — treat
 *     the process memory as potentially-leaky
 *   - NEVER log, echo, cat, or paste the decrypted secret key anywhere
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { Keypair } from '@solana/web3.js';
import { db, treasuryWallets } from '@clawville/database';
import { encryptSecretKey } from '../apps/api/src/services/keypair-vault';

type TreasuryPurpose = 'x402-merchant' | 'fee-collector' | 'escrow';

function isValidPurpose(value: string): value is TreasuryPurpose {
  return value === 'x402-merchant' || value === 'fee-collector' || value === 'escrow';
}

async function main() {
  const purposeArg = process.argv[2] ?? 'x402-merchant';
  const notesArg = process.argv[3] ?? null;

  if (!isValidPurpose(purposeArg)) {
    console.error(
      `[treasury] Invalid purpose "${purposeArg}". Must be one of: x402-merchant, fee-collector, escrow`,
    );
    process.exit(1);
  }

  if (!process.env.VANITY_ENCRYPTION_KEY) {
    console.error('[treasury] VANITY_ENCRYPTION_KEY env var is not set. Set it before running.');
    process.exit(1);
  }

  // 1. Generate fresh keypair in memory
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();

  // 2. Encrypt secret immediately — the raw bytes never leave this scope
  const encrypted = encryptSecretKey(keypair.secretKey);

  // 3. Insert into DB
  const [row] = await db
    .insert(treasuryWallets)
    .values({
      purpose: purposeArg,
      publicKey,
      encryptedSecretKey: encrypted.encryptedSecretKey,
      encryptionIv: encrypted.encryptionIv,
      encryptionTag: encrypted.encryptionTag,
      notes: notesArg,
    })
    .returning({ id: treasuryWallets.id, publicKey: treasuryWallets.publicKey });

  // 4. Print ONLY the public key and DB id — never the secret
  console.log('[treasury] Generated new treasury wallet');
  console.log(`  ID:        ${row.id}`);
  console.log(`  Purpose:   ${purposeArg}`);
  console.log(`  Public key: ${row.publicKey}`);
  if (notesArg) console.log(`  Notes:     ${notesArg}`);
  console.log('');
  console.log('Secret key encrypted at rest. Do not attempt to recover or print it.');

  process.exit(0);
}

main().catch((err) => {
  console.error('[treasury] Failed to generate keypair:', err);
  process.exit(1);
});
