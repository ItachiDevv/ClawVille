/**
 * Import an existing Solana keypair JSON file into the treasury_wallets
 * table. Unlike generate-treasury-keypair.ts (which mints a fresh keypair),
 * this script takes a path to a file in the standard Solana CLI format
 * — a JSON array of 64 bytes representing the raw secret key — encrypts
 * the bytes with VANITY_ENCRYPTION_KEY, and inserts the record.
 *
 * Usage:
 *   bun run scripts/import-treasury-wallet.ts <path-to-json> [purpose] [notes]
 *
 * Examples:
 *   bun run scripts/import-treasury-wallet.ts scripts/deploy/treasury-wallet.json
 *   bun run scripts/import-treasury-wallet.ts ~/.config/solana/id.json x402-merchant "Phase 4 prod"
 *
 * Security:
 *   - The file is read into a Uint8Array, encrypted immediately with
 *     AES-256-GCM, and the encrypted form is written to Supabase.
 *   - Only the base58 public key + DB id are printed.
 *   - The secret key bytes are NEVER logged or echoed to stdout.
 *   - The source JSON file is left on disk untouched — delete it yourself
 *     once you're satisfied the import worked, or move it to cold storage.
 */

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { config } from 'dotenv';
config({ path: resolvePath(__dirname, '../.env.local') });

import { Keypair } from '@solana/web3.js';
import { db, treasuryWallets, eq } from '@clawville/database';
import { encryptSecretKey } from '../apps/api/src/services/keypair-vault';

type TreasuryPurpose = 'x402-merchant' | 'fee-collector' | 'escrow';

function isValidPurpose(v: string): v is TreasuryPurpose {
  return v === 'x402-merchant' || v === 'fee-collector' || v === 'escrow';
}

function parseSolanaKeyFile(filePath: string): Uint8Array {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err: any) {
    console.error(`[treasury] Could not read file "${filePath}": ${err.message}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    console.error(`[treasury] File "${filePath}" is not valid JSON. Expected a byte array like [237,158,...]`);
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    console.error(`[treasury] File must contain a JSON array of numbers, got ${typeof parsed}`);
    process.exit(1);
  }

  if (parsed.length !== 64) {
    console.error(`[treasury] Expected 64 bytes (Solana secret key length), got ${parsed.length}`);
    console.error(`[treasury] If your file has a different format (mnemonic, base58, etc.) it must be converted first.`);
    process.exit(1);
  }

  for (const b of parsed) {
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
      console.error(`[treasury] Byte array contains invalid value "${b}" — each element must be an integer in [0, 255]`);
      process.exit(1);
    }
  }

  return new Uint8Array(parsed as number[]);
}

async function main() {
  const [, , filePathArg, purposeArg = 'x402-merchant', notesArg = null] = process.argv;

  if (!filePathArg) {
    console.error('Usage: bun run scripts/import-treasury-wallet.ts <path-to-json> [purpose] [notes]');
    console.error('  purpose: x402-merchant (default) | fee-collector | escrow');
    process.exit(1);
  }

  if (!isValidPurpose(purposeArg)) {
    console.error(`[treasury] Invalid purpose "${purposeArg}". Must be one of: x402-merchant, fee-collector, escrow`);
    process.exit(1);
  }

  if (!process.env.VANITY_ENCRYPTION_KEY) {
    console.error('[treasury] VANITY_ENCRYPTION_KEY env var is not set. Check .env.local.');
    process.exit(1);
  }

  // 1. Read + validate the keypair file in memory
  const filePath = resolvePath(filePathArg);
  const secretKey = parseSolanaKeyFile(filePath);

  // 2. Derive the public key (this also validates the secret is a real ed25519 key)
  let publicKey: string;
  try {
    publicKey = Keypair.fromSecretKey(secretKey).publicKey.toBase58();
  } catch (err: any) {
    console.error(`[treasury] Bytes are not a valid Solana secret key: ${err.message}`);
    process.exit(1);
  }

  // 3. Check for an existing row with the same pubkey — treasury_wallets has
  //    a UNIQUE constraint on public_key, so re-importing the same wallet
  //    would throw. Detect and short-circuit with a clear message instead.
  const existing = await db
    .select({ id: treasuryWallets.id, purpose: treasuryWallets.purpose })
    .from(treasuryWallets)
    .where(eq(treasuryWallets.publicKey, publicKey))
    .limit(1);

  if (existing.length > 0) {
    console.log('[treasury] This wallet is already imported.');
    console.log(`  ID:         ${existing[0].id}`);
    console.log(`  Purpose:    ${existing[0].purpose}`);
    console.log(`  Public key: ${publicKey}`);
    console.log('');
    console.log('No changes made. Delete the row in Supabase first if you want to re-import.');
    process.exit(0);
  }

  // 4. Encrypt secret immediately — the raw bytes never leave this scope
  const encrypted = encryptSecretKey(secretKey);

  // 5. Insert into DB
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

  // 6. Print ONLY the public key and DB id — never the secret
  console.log('[treasury] Imported existing treasury wallet');
  console.log(`  ID:         ${row.id}`);
  console.log(`  Purpose:    ${purposeArg}`);
  console.log(`  Public key: ${row.publicKey}`);
  if (notesArg) console.log(`  Notes:      ${notesArg}`);
  console.log('');
  console.log('Secret key encrypted at rest with VANITY_ENCRYPTION_KEY.');
  console.log('Next step: set CLAWVILLE_MERCHANT_WALLET_PUBKEY on Coolify api app to this public key.');
  console.log('');
  console.log(`Source file "${filePath}" was NOT deleted — do that yourself once you've verified the import.`);

  process.exit(0);
}

main().catch((err) => {
  console.error('[treasury] Fatal error:', err);
  process.exit(1);
});
