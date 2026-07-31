/**
 * Unified wallet service for custodial avatar settlement wallets.
 *
 * The `wallets` table is canonical. Avatar mirrors are compatibility reads
 * only: provisioning may fill a null mirror, but it never repoints one.
 *
 * Called from:
 *   - POST /api/avatars (interactive first-mint disclosure)
 *   - POST /api/agent/connect (interactive first-mint disclosure)
 *   - POST /api/partner/hatcher/agents (no-disclosure provisioning)
 *   - apps/api/scripts/wallet-unification/promote-avatar-wallets.ts
 *
 * ⚠️  CUSTODIAL — ClawVille holds the secret. Intended use in v1 is as a
 *     payment source for Phase 4 x402 pings (~$0.001 each). Do not load
 *     meaningful value until legal review. No export/withdrawal flow
 *     except the one-time first-creation disclosure via
 *     `ensureWalletWithFirstTimeSecret()` (see that function's JSDoc).
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  db,
  avatars,
  agentBots,
  wallets,
  eq,
  and,
  isNull,
  type WalletSubjectType,
} from '@clawville/database';
import {
  decryptSecretKeyEnveloped,
  decryptWalletRow,
  encryptSecretKey,
  encryptSecretKeyEnveloped,
} from './keypair-vault';
import {
  reconcileAvatarWallet,
  type AvatarWalletMatrixBranch,
  type AvatarWalletReconciliationAdapter,
  type AvatarWalletReconciliationResult,
  type CanonicalAvatarWallet,
} from './avatar-wallet-reconciliation';
import {
  resolveAvatarSettlementAddressFromCanonical,
  type AvatarSettlementResolution,
} from './avatar-settlement';
export {
  avatarSettlementAddressFields,
  resolveAvatarSettlementAddressFromCanonical,
  type AvatarSettlementAddressFields,
  type AvatarSettlementResolution,
} from './avatar-settlement';

export interface GeneratedWallet {
  subjectType: WalletSubjectType;
  subjectId: string;
  publicKey: string;
  alreadyExisted: boolean;
}

export interface ProvisionAvatarWalletOptions {
  disclose: boolean;
}

export type ProvisionAvatarWalletResult = AvatarWalletReconciliationResult;

/**
 * Pure settlement read. This reads only the canonical avatar-subject row and
 * never decrypts, mints, repairs a mirror, or writes.
 */
export async function resolveAvatarSettlementAddress(
  avatarId: string,
): Promise<AvatarSettlementResolution> {
  const row = await db.query.wallets.findFirst({
    where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
    columns: { publicKey: true, custodyVerified: true },
  });
  return resolveAvatarSettlementAddressFromCanonical(row);
}

/**
 * Ensure the given subject has a wallet. Idempotent on the composite
 * (subject_type, subject_id) unique index. Safe to call multiple times.
 *
 * Flow:
 *   1. Check the mirror column on the owning table (avatars.walletAddress
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
  if (subjectType === 'avatar') {
    const result = await provisionAvatarWallet(subjectId, { disclose: false });
    if (result.status !== 'ready' || !result.address) {
      throw new Error(`[wallet] Avatar ${subjectId} settlement wallet is pending`);
    }
    return {
      subjectType,
      subjectId,
      publicKey: result.address,
      alreadyExisted: !result.inserted,
    };
  }

  // Step 1: fast path via mirror column
  if (subjectType === 'agent') {
    const [row] = await db
      .select({ walletAddress: agentBots.walletAddress })
      .from(agentBots)
      .where(eq(agentBots.id, subjectId))
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

  try {
    await db.insert(wallets).values({
      subjectType,
      subjectId,
      publicKey,
      encryptedSecretKey: encrypted.encryptedSecretKey,
      encryptionIv: encrypted.encryptionIv,
      encryptionTag: encrypted.encryptionTag,
    });
  } catch (err) {
    // Race-safe recovery: two concurrent ensureWallet calls for the same
    // (subject_type, subject_id) both pass the mirror + wallets-table
    // checks, both try to INSERT. `wallets_subject_uniq` UNIQUE index
    // serialises them; the loser catches 23505 and re-reads the winner's
    // pubkey. Without this, the loser bubbles a 500 to the caller on
    // what should be a deterministic "use my existing wallet" path.
    const code =
      (err as { code?: string; cause?: { code?: string } } | null)?.code
      ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
    if (code !== '23505') throw err;
    const raced = await db
      .select({ publicKey: wallets.publicKey })
      .from(wallets)
      .where(and(eq(wallets.subjectType, subjectType), eq(wallets.subjectId, subjectId)))
      .limit(1);
    if (!raced[0]) {
      throw new Error(
        `[wallet] unique-violation on insert but no existing row found for ${subjectType}:${subjectId}`,
      );
    }
    await writeMirror(subjectType, subjectId, raced[0].publicKey);
    return {
      subjectType,
      subjectId,
      publicKey: raced[0].publicKey,
      alreadyExisted: true,
    };
  }

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
  if (subjectType === 'avatar') {
    const [row] = await db
      .select({ walletAddress: avatars.walletAddress })
      .from(avatars)
      .where(eq(avatars.id, subjectId))
      .limit(1);
    return row?.walletAddress ?? null;
  }
  if (subjectType === 'agent') {
    const [row] = await db
      .select({ walletAddress: agentBots.walletAddress })
      .from(agentBots)
      .where(eq(agentBots.id, subjectId))
      .limit(1);
    return row?.walletAddress ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 5.1 — first-time secret disclosure
// ---------------------------------------------------------------------------
// Same idempotent semantics as ensureWallet() but when the wallet is
// *newly created*, the plaintext base58 secret is returned alongside.
// Callers use it for the one-time in-chat disclosure to the human
// (the ONE approved export channel — see `wallets.ts` JSDoc).
//
// On subsequent calls for the same subject, `firstTimeSecretKeyBase58`
// is undefined. The server never re-exports a secret.
//
// Write path is always envelope-encryption (version 2). Requires the
// Cloudflare Worker to be reachable (see `encryptSecretKeyEnveloped`).
// ---------------------------------------------------------------------------

export interface GeneratedWalletWithSecret extends GeneratedWallet {
  /**
   * Base58 64-byte Solana secret key. ONLY populated when
   * `alreadyExisted === false` — i.e. the row was just inserted. Caller
   * MUST relay this to the human exactly once, then drop it in-memory.
   * Never persist, never log.
   */
  firstTimeSecretKeyBase58?: string;
}

/**
 * Ensure a wallet exists for (subjectType, subjectId). On first-time
 * creation, additionally returns the plaintext secret so the caller can
 * show it to the human for self-custody backup. On returning calls,
 * behaves identically to `ensureWallet()` and omits the secret field.
 *
 * See plan §5.1 (first-connect response shape) and §9.1 (flow).
 */
export async function ensureWalletWithFirstTimeSecret(
  subjectType: WalletSubjectType,
  subjectId: string,
): Promise<GeneratedWalletWithSecret> {
  if (subjectType === 'avatar') {
    const result = await provisionAvatarWallet(subjectId, { disclose: true });
    if (result.status !== 'ready' || !result.address) {
      throw new Error(`[wallet] Avatar ${subjectId} settlement wallet is pending`);
    }
    return {
      subjectType,
      subjectId,
      publicKey: result.address,
      alreadyExisted: !result.inserted,
      ...(result.firstTimeSecretKeyBase58
        ? { firstTimeSecretKeyBase58: result.firstTimeSecretKeyBase58 }
        : {}),
    };
  }

  // Fast path via mirror column, identical to ensureWallet(). Treasury
  // is still a no-op (managed by separate scripts).
  if (subjectType === 'agent') {
    const [row] = await db
      .select({ walletAddress: agentBots.walletAddress })
      .from(agentBots)
      .where(eq(agentBots.id, subjectId))
      .limit(1);
    if (!row) throw new Error(`[wallet] Bot ${subjectId} not found`);
    if (row.walletAddress) {
      return { subjectType, subjectId, publicKey: row.walletAddress, alreadyExisted: true };
    }
  } else if (subjectType === 'treasury') {
    throw new Error(
      '[wallet] Treasury wallets are managed by scripts/generate-treasury-keypair.ts, not ensureWalletWithFirstTimeSecret()',
    );
  }

  // Double-check the wallets table in case the mirror is stale.
  const [existingWallet] = await db
    .select({ publicKey: wallets.publicKey })
    .from(wallets)
    .where(and(eq(wallets.subjectType, subjectType), eq(wallets.subjectId, subjectId)))
    .limit(1);

  if (existingWallet) {
    await writeMirror(subjectType, subjectId, existingWallet.publicKey);
    return {
      subjectType,
      subjectId,
      publicKey: existingWallet.publicKey,
      alreadyExisted: true,
    };
  }

  // New wallet — envelope-encrypt under the v2 scheme and insert.
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const enc = await encryptSecretKeyEnveloped(keypair.secretKey);

  try {
    await db.insert(wallets).values({
      subjectType,
      subjectId,
      publicKey,
      encryptedSecretKey: enc.encryptedSecretKey,
      encryptionIv: enc.encryptionIv,
      encryptionTag: enc.encryptionTag,
      dekWrapped: enc.dekWrapped,
      encryptionVersion: enc.encryptionVersion,
    });
  } catch (err) {
    // Race-safe recovery: two concurrent callers for the same subject.
    // Loser catches the `wallets_subject_uniq` violation (23505) and
    // re-reads the winner's pubkey. IMPORTANT: the loser does NOT get
    // `firstTimeSecretKeyBase58` — the winner's secret was already
    // disclosed to the caller that won the race, and disclosing the
    // same secret twice would violate the "one approved export
    // channel" doctrine in wallets.ts JSDoc. The loser's return value
    // looks identical to a normal "already existed" return.
    const code =
      (err as { code?: string; cause?: { code?: string } } | null)?.code
      ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
    if (code !== '23505') throw err;
    const raced = await db
      .select({ publicKey: wallets.publicKey })
      .from(wallets)
      .where(and(eq(wallets.subjectType, subjectType), eq(wallets.subjectId, subjectId)))
      .limit(1);
    if (!raced[0]) {
      throw new Error(
        `[wallet] unique-violation on insert but no existing row found for ${subjectType}:${subjectId}`,
      );
    }
    await writeMirror(subjectType, subjectId, raced[0].publicKey);
    return {
      subjectType,
      subjectId,
      publicKey: raced[0].publicKey,
      alreadyExisted: true,
    };
  }

  await writeMirror(subjectType, subjectId, publicKey);

  return {
    subjectType,
    subjectId,
    publicKey,
    alreadyExisted: false,
    // ONE-TIME disclosure. Solana secret keys are 64 bytes; base58 out
    // is what every Solana wallet tool expects for import.
    firstTimeSecretKeyBase58: bs58.encode(keypair.secretKey),
  };
}

function uniqueViolationCode(err: unknown): string | undefined {
  return (
    (err as { code?: string; cause?: { code?: string } } | null)?.code
    ?? (err as { cause?: { code?: string } } | null)?.cause?.code
  );
}

async function loadCanonicalAvatarWallet(
  avatarId: string,
): Promise<CanonicalAvatarWallet | null> {
  const row = await db.query.wallets.findFirst({
    where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
    columns: {
      id: true,
      publicKey: true,
      custodyVerified: true,
    },
  });
  return row ?? null;
}

function createAvatarWalletAdapter(avatarId: string): AvatarWalletReconciliationAdapter {
  return {
    async loadSnapshot() {
      const [avatarRow, canonical] = await Promise.all([
        db.query.avatars.findFirst({
          where: eq(avatars.id, avatarId),
          columns: { id: true, walletAddress: true },
        }),
        loadCanonicalAvatarWallet(avatarId),
      ]);
      return {
        avatarExists: avatarRow != null,
        mirrorAddress: avatarRow?.walletAddress ?? null,
        canonical,
      };
    },

    async validateCanonical(canonical) {
      const row = await db.query.wallets.findFirst({
        where: and(
          eq(wallets.id, canonical.id),
          eq(wallets.subjectType, 'avatar'),
          eq(wallets.subjectId, avatarId),
        ),
      });
      if (!row) return false;
      const keypair = await decryptWalletRow(row);
      return keypair.publicKey.toBase58() === row.publicKey;
    },

    async createValidatedCanonical(disclose) {
      const keypair = Keypair.generate();
      const publicKey = keypair.publicKey.toBase58();
      const encrypted = await encryptSecretKeyEnveloped(keypair.secretKey);

      const reproduced = await decryptSecretKeyEnveloped(encrypted);
      if (reproduced.publicKey.toBase58() !== publicKey) {
        throw new Error('[wallet] envelope round-trip did not reproduce public_key');
      }

      try {
        const [inserted] = await db
          .insert(wallets)
          .values({
            subjectType: 'avatar',
            subjectId: avatarId,
            publicKey,
            encryptedSecretKey: encrypted.encryptedSecretKey,
            encryptionIv: encrypted.encryptionIv,
            encryptionTag: encrypted.encryptionTag,
            dekWrapped: encrypted.dekWrapped,
            encryptionVersion: encrypted.encryptionVersion,
            custodyVerified: true,
          })
          .returning({
            id: wallets.id,
            publicKey: wallets.publicKey,
            custodyVerified: wallets.custodyVerified,
          });
        if (!inserted) {
          throw new Error(`[wallet] avatar wallet insert returned no row for ${avatarId}`);
        }
        return {
          canonical: inserted,
          inserted: true,
          ...(disclose
            ? { firstTimeSecretKeyBase58: bs58.encode(keypair.secretKey) }
            : {}),
        };
      } catch (err) {
        if (uniqueViolationCode(err) !== '23505') throw err;
        const winner = await loadCanonicalAvatarWallet(avatarId);
        if (!winner) {
          throw new Error(
            `[wallet] unique-violation on avatar insert but no winner exists for ${avatarId}`,
          );
        }
        return { canonical: winner, inserted: false };
      }
    },

    async setCustodyVerified(walletId, verified) {
      await db
        .update(wallets)
        .set({ custodyVerified: verified })
        .where(
          and(
            eq(wallets.id, walletId),
            eq(wallets.subjectType, 'avatar'),
            eq(wallets.subjectId, avatarId),
          ),
        );
    },

    async fillMirrorIfNull(address) {
      const updated = await db
        .update(avatars)
        .set({ walletAddress: address, updatedAt: new Date() })
        .where(and(eq(avatars.id, avatarId), isNull(avatars.walletAddress)))
        .returning({ walletAddress: avatars.walletAddress });
      if (updated[0]?.walletAddress === address) return 'equal';

      const current = await db.query.avatars.findFirst({
        where: eq(avatars.id, avatarId),
        columns: { walletAddress: true },
      });
      if (!current) return 'missing';
      return current.walletAddress === address ? 'equal' : 'mismatch';
    },

    trackException(branch: AvatarWalletMatrixBranch, detail: string) {
      console.error(
        `[wallet] avatar settlement exception avatar=${avatarId} branch=${branch}: ${detail}`,
      );
    },
  };
}

/**
 * Mutating avatar settlement provisioner. New rows are envelope-encrypted v2,
 * validated before insert, and disclosed only to the unique insert winner.
 */
export async function provisionAvatarWallet(
  avatarId: string,
  options: ProvisionAvatarWalletOptions,
): Promise<ProvisionAvatarWalletResult> {
  return reconcileAvatarWallet(createAvatarWalletAdapter(avatarId), {
    apply: true,
    disclose: options.disclose,
  });
}

/** Read/decrypt classification for the controlled backfill dry-run only. */
export async function inspectAvatarWalletProvision(
  avatarId: string,
): Promise<ProvisionAvatarWalletResult> {
  return reconcileAvatarWallet(createAvatarWalletAdapter(avatarId), {
    apply: false,
    disclose: false,
  });
}

async function writeMirror(
  subjectType: WalletSubjectType,
  subjectId: string,
  publicKey: string,
): Promise<void> {
  if (subjectType === 'agent') {
    await db
      .update(agentBots)
      .set({ walletAddress: publicKey, updatedAt: new Date() })
      .where(eq(agentBots.id, subjectId));
  }
}
