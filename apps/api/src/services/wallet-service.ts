/**
 * Unified wallet service — auto-generates a custodial Solana keypair for any
 * subject (pet, agent, future subject types) and mirrors the pubkey onto the
 * owning table's `wallet_address` column for O(1) lookups.
 *
 * Single source of truth: the `wallets` table keyed on
 * (subject_type, subject_id). Replaces the previous split where pets had
 * `pet_wallets` and agents had nothing.
 *
 * Called from:
 *   - POST /api/pets              (human users → ensureWallet('pet', petId))
 *   - POST /api/agent/connect     (external agents → ensureWallet('agent', botId))
 *   - scripts/backfill-wallets.ts (one-time backfill for existing subjects)
 *
 * ⚠️  CUSTODIAL — ClawVille holds the secret. Intended use in v1 is as a
 *     payment source for Phase 4 x402 pings (~$0.001 each). Do not load
 *     meaningful value until legal review. No export/withdrawal flow.
 */

import { Keypair } from '@solana/web3.js';
import {
  db,
  pets,
  openclawBots,
  wallets,
  eq,
  and,
  type WalletSubjectType,
} from '@clawville/database';
import { encryptSecretKey } from './keypair-vault';

export interface GeneratedWallet {
  subjectType: WalletSubjectType;
  subjectId: string;
  publicKey: string;
  alreadyExisted: boolean;
}

/**
 * Ensure the given subject has a wallet. Idempotent on the composite
 * (subject_type, subject_id) unique index. Safe to call multiple times.
 *
 * Flow:
 *   1. Check the mirror column on the owning table (pets.walletAddress
 *      or openclaw_bots.walletAddress) — fast path, no joins.
 *   2. If no mirror, check the `wallets` table in case the mirror is
 *      stale (e.g., migration left it empty).
 *   3. If nothing exists, generate a fresh keypair, encrypt the secret,
 *      insert into `wallets`, and update the mirror.
 *
 * Returns the public key and whether it already existed.
 */
export async function ensureWallet(
  subjectType: WalletSubjectType,
  subjectId: string,
): Promise<GeneratedWallet> {
  // Step 1: fast path via mirror column
  if (subjectType === 'pet') {
    const [row] = await db
      .select({ walletAddress: pets.walletAddress })
      .from(pets)
      .where(eq(pets.id, subjectId))
      .limit(1);
    if (!row) throw new Error(`[wallet] Pet ${subjectId} not found`);
    if (row.walletAddress) {
      return { subjectType, subjectId, publicKey: row.walletAddress, alreadyExisted: true };
    }
  } else if (subjectType === 'agent') {
    const [row] = await db
      .select({ walletAddress: openclawBots.walletAddress })
      .from(openclawBots)
      .where(eq(openclawBots.id, subjectId))
      .limit(1);
    if (!row) throw new Error(`[wallet] Bot ${subjectId} not found`);
    if (row.walletAddress) {
      return { subjectType, subjectId, publicKey: row.walletAddress, alreadyExisted: true };
    }
  } else if (subjectType === 'treasury') {
    // Treasury wallets have their own authoritative table. ensureWallet()
    // is intentionally a no-op for this subject type — callers must use
    // scripts/generate-treasury-keypair.ts or scripts/import-treasury-wallet.ts.
    throw new Error(
      '[wallet] Treasury wallets are managed by scripts/generate-treasury-keypair.ts, not ensureWallet()',
    );
  }

  // Step 2: mirror was empty — double-check the wallets table in case
  // it's stale (migration, partial write, race condition)
  const [existingWallet] = await db
    .select({ publicKey: wallets.publicKey })
    .from(wallets)
    .where(and(eq(wallets.subjectType, subjectType), eq(wallets.subjectId, subjectId)))
    .limit(1);

  if (existingWallet) {
    // Heal the mirror
    await writeMirror(subjectType, subjectId, existingWallet.publicKey);
    return {
      subjectType,
      subjectId,
      publicKey: existingWallet.publicKey,
      alreadyExisted: true,
    };
  }

  // Step 3: generate + encrypt + insert
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const encrypted = encryptSecretKey(keypair.secretKey);

  await db.insert(wallets).values({
    subjectType,
    subjectId,
    publicKey,
    encryptedSecretKey: encrypted.encryptedSecretKey,
    encryptionIv: encrypted.encryptionIv,
    encryptionTag: encrypted.encryptionTag,
  });

  await writeMirror(subjectType, subjectId, publicKey);

  return { subjectType, subjectId, publicKey, alreadyExisted: false };
}

/**
 * Look up a subject's wallet address without generating one. Returns null
 * if no wallet exists. Uses the mirror column — O(1) lookup.
 */
export async function getWalletAddress(
  subjectType: WalletSubjectType,
  subjectId: string,
): Promise<string | null> {
  if (subjectType === 'pet') {
    const [row] = await db
      .select({ walletAddress: pets.walletAddress })
      .from(pets)
      .where(eq(pets.id, subjectId))
      .limit(1);
    return row?.walletAddress ?? null;
  }
  if (subjectType === 'agent') {
    const [row] = await db
      .select({ walletAddress: openclawBots.walletAddress })
      .from(openclawBots)
      .where(eq(openclawBots.id, subjectId))
      .limit(1);
    return row?.walletAddress ?? null;
  }
  return null;
}

async function writeMirror(
  subjectType: WalletSubjectType,
  subjectId: string,
  publicKey: string,
): Promise<void> {
  if (subjectType === 'pet') {
    await db
      .update(pets)
      .set({ walletAddress: publicKey, updatedAt: new Date() })
      .where(eq(pets.id, subjectId));
  } else if (subjectType === 'agent') {
    await db
      .update(openclawBots)
      .set({ walletAddress: publicKey, updatedAt: new Date() })
      .where(eq(openclawBots.id, subjectId));
  }
}
