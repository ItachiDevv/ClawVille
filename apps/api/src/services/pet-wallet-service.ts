/**
 * Pet wallet service — auto-generates a custodial Solana keypair for every
 * pet, stores the encrypted secret in `pet_wallets`, and mirrors the public
 * key to `pets.walletAddress`.
 *
 * Called from:
 *   - POST /api/pets              (human users creating a pet)
 *   - POST /api/agent/connect     (Milady / OpenClaw / nanoclaw agents)
 *   - scripts/backfill-pet-wallets.ts (one-time backfill for existing pets)
 *
 * ⚠️  CUSTODIAL — ClawVille holds the secret. Intended use in v1 is as a
 *     payment source for Phase 4 x402 pings (~$0.001 each). Do not load
 *     meaningful value until legal review. No export/withdrawal flow.
 */

import { Keypair } from '@solana/web3.js';
import { db, pets, petWallets, eq } from '@clawville/database';
import { encryptSecretKey } from './keypair-vault';

export interface GeneratedPetWallet {
  petId: string;
  publicKey: string;
  alreadyExisted: boolean;
}

/**
 * Ensure the given pet has a wallet. If one already exists (either a
 * `pets.walletAddress` mirror or a `pet_wallets` row), return it unchanged.
 * Otherwise generate a fresh keypair, encrypt the secret, insert into
 * `pet_wallets`, and mirror the pubkey to `pets.walletAddress`.
 *
 * Safe to call multiple times — idempotent on the pet_id unique constraint.
 */
export async function ensurePetWallet(petId: string): Promise<GeneratedPetWallet> {
  // Fast path: check the mirror column first (no join needed)
  const [petRow] = await db
    .select({ id: pets.id, walletAddress: pets.walletAddress })
    .from(pets)
    .where(eq(pets.id, petId))
    .limit(1);

  if (!petRow) {
    throw new Error(`[pet-wallet] Pet ${petId} not found`);
  }

  if (petRow.walletAddress) {
    return {
      petId,
      publicKey: petRow.walletAddress,
      alreadyExisted: true,
    };
  }

  // Mirror was empty but double-check pet_wallets in case it's out of sync
  const [existingWallet] = await db
    .select({ publicKey: petWallets.publicKey })
    .from(petWallets)
    .where(eq(petWallets.petId, petId))
    .limit(1);

  if (existingWallet) {
    // Heal the mirror
    await db
      .update(pets)
      .set({ walletAddress: existingWallet.publicKey, updatedAt: new Date() })
      .where(eq(pets.id, petId));
    return {
      petId,
      publicKey: existingWallet.publicKey,
      alreadyExisted: true,
    };
  }

  // Generate + encrypt + insert
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const encrypted = encryptSecretKey(keypair.secretKey);

  await db.insert(petWallets).values({
    petId,
    publicKey,
    encryptedSecretKey: encrypted.encryptedSecretKey,
    encryptionIv: encrypted.encryptionIv,
    encryptionTag: encrypted.encryptionTag,
  });

  await db
    .update(pets)
    .set({ walletAddress: publicKey, updatedAt: new Date() })
    .where(eq(pets.id, petId));

  return { petId, publicKey, alreadyExisted: false };
}

/**
 * Look up the pubkey for a pet without generating one if it doesn't exist.
 * Returns null if the pet has no wallet yet. Cheap — uses the mirror column.
 */
export async function getPetWalletAddress(petId: string): Promise<string | null> {
  const [row] = await db
    .select({ walletAddress: pets.walletAddress })
    .from(pets)
    .where(eq(pets.id, petId))
    .limit(1);
  return row?.walletAddress ?? null;
}
