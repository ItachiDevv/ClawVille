/**
 * SAP — SPL-token + ATA primitives, hand-rolled on `@solana/web3.js` only.
 *
 * `@solana/spl-token` is NOT a dependency of this app (and we do not add one for
 * a build-only, gated-OFF layer), so this module derives Associated Token
 * Accounts and builds the `createAssociatedTokenAccountIdempotent` instruction
 * from first principles. Every constant + layout here is a long-stable,
 * well-known SPL value (verified against the OOBE USDC spec
 * `oobe-usdc-selfreport-spec.md`).
 *
 * Pure + deterministic — no network, no DB, no secrets.
 */

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

// ── well-known program ids (base58, long-stable) ──────────────────────────────

/** SPL Token program. */
export const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
/** SPL Associated-Token-Account program. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
/** SPL Token-2022 (NOT used by USDC — present only to assert we never pass it). */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

// (adversary nit, mainnet-enablement review 2026-07-10) The hardcoded-mainnet
// `USDC_MINT` export that used to live here was DELETED — zero importers, and a
// future edit importing it into a mint-derivation site would hardcode mainnet
// regardless of cluster (wrong-mint ATAs on devnet). The ONLY mint source for
// money paths is the cluster-pinned `cfg.usdcMint` (sap-config.ts).
export const USDC_DECIMALS = 6;

/**
 * Derive the Associated Token Account for (mint, owner).
 *
 * `allowOwnerOffCurve` MUST be true when the owner is a PDA (the escrow vault's
 * owner is the escrow PDA, which is off-curve). For a normal wallet owner it is
 * false (the default). Mirrors `getAssociatedTokenAddressSync`.
 *
 * ATA = findProgramAddress([owner, TOKEN_PROGRAM, mint], ASSOCIATED_TOKEN_PROGRAM).
 */
export function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
): PublicKey {
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBuffer())) {
    throw new Error(
      'getAssociatedTokenAddress: owner is off-curve (a PDA) but ' +
        'allowOwnerOffCurve=false — pass allowOwnerOffCurve=true for a PDA owner.',
    );
  }
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/**
 * Build a `createAssociatedTokenAccountIdempotent` instruction.
 *
 * The ATA program's idempotent-create instruction is selected by a SINGLE
 * instruction-tag byte = `1` (the plain create is tag `0`; idempotent is `1`).
 * Idempotent = a no-op (does not error) if the ATA already exists, which is
 * exactly what the OOBE spec requires for the vault ATA ("program does NOT init
 * it; createAssociatedTokenAccountIdempotent first").
 *
 * Account order (fixed by the ATA program):
 *   0 payer            (signer, writable)  — funds the rent
 *   1 ata              (writable)          — the account being created
 *   2 owner            (readonly)          — the ATA owner (wallet or PDA)
 *   3 mint             (readonly)
 *   4 system_program   (readonly)
 *   5 token_program    (readonly)
 */
export function createAssociatedTokenAccountIdempotentInstruction(params: {
  payer: PublicKey;
  ata: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  const { payer, ata, owner, mint } = params;
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    // Idempotent-create instruction tag.
    data: Buffer.from([1]),
  });
}
