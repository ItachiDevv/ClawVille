/**
 * Avatar wallet service — auto-generates a custodial Solana keypair for every
 * avatar, stores the encrypted secret in `avatar_wallet`, and mirrors the public
 * key to `avatars.walletAddress`.
 *
 * Called from:
 *   - POST /api/avatars              (human users creating a avatar)
 *   - POST /api/agent/connect     (Milady / OpenClaw / nanoclaw agents)
 *   - scripts/backfill-avatar-wallets.ts (one-time backfill for existing avatars)
 *
 * ⚠️  CUSTODIAL — ClawVille holds the secret. Intended use in v1 is as a
 *     payment source for Phase 4 x402 pings (~$0.001 each). Do not load
 *     meaningful value until legal review. No export/withdrawal flow.
 */

import { Keypair } from '@solana/web3.js';
import { db, avatars, petWallets, eq } from '@clawville/database';
import { encryptSecretKey } from './keypair-vault';

export interface GeneratedPetWallet {
  avatarId: string;
  publicKey: string;
  alreadyExisted: boolean;
}

/**
 * Ensure the given avatar has a wallet. If one already exists (either a
 * `avatars.walletAddress` mirror or a `avatar_wallet` row), return it unchanged.
 * Otherwise generate a fresh keypair, encrypt the secret, insert into
 * `avatar_wallet`, and mirror the pubkey to `avatars.walletAddress`.
 *
 * Safe to call multiple times — idempotent on the avatar_id unique constraint.
 */
export async function ensurePetWallet(avatarId: string): Promise<GeneratedPetWallet> {
  // Fast path: check the mirror column first (no join needed)
  const [petRow] = await db
    .select({ id: avatars.id, walletAddress: avatars.walletAddress })
    .from(avatars)
    .where(eq(avatars.id, avatarId))
    .limit(1);

  if (!petRow) {
    throw new Error(`[avatar-wallet] Avatar ${avatarId} not found`);
  }

  if (petRow.walletAddress) {
    return {
      avatarId,
      publicKey: petRow.walletAddress,
      alreadyExisted: true,
    };
  }

  // Mirror was empty but double-check avatar_wallet in case it's out of sync
  const [existingWallet] = await db
    .select({ publicKey: petWallets.publicKey })
    .from(petWallets)
    .where(eq(petWallets.avatarId, avatarId))
    .limit(1);

  if (existingWallet) {
    // Heal the mirror
    await db
      .update(avatars)
      .set({ walletAddress: existingWallet.publicKey, updatedAt: new Date() })
      .where(eq(avatars.id, avatarId));
    return {
      avatarId,
      publicKey: existingWallet.publicKey,
      alreadyExisted: true,
    };
  }

  // Generate + encrypt + insert
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const encrypted = encryptSecretKey(keypair.secretKey);

  await db.insert(petWallets).values({
    avatarId,
    publicKey,
    encryptedSecretKey: encrypted.encryptedSecretKey,
    encryptionIv: encrypted.encryptionIv,
    encryptionTag: encrypted.encryptionTag,
  });

  await db
    .update(avatars)
    .set({ walletAddress: publicKey, updatedAt: new Date() })
    .where(eq(avatars.id, avatarId));

  return { avatarId, publicKey, alreadyExisted: false };
}

/**
 * Look up the pubkey for a avatar without generating one if it doesn't exist.
 * Returns null if the avatar has no wallet yet. Cheap — uses the mirror column.
 */
export async function getPetWalletAddress(avatarId: string): Promise<string | null> {
  const [row] = await db
    .select({ walletAddress: avatars.walletAddress })
    .from(avatars)
    .where(eq(avatars.id, avatarId))
    .limit(1);
  return row?.walletAddress ?? null;
}
