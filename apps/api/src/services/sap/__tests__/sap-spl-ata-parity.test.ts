import { describe, expect, it } from 'bun:test';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID as SPL_ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { deriveUsdcAta } from '../../x402-chain-verifier';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress as getSapAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '../sap-spl';

const MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const OWNER = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 7)).publicKey;
const [PDA_OWNER] = PublicKey.findProgramAddressSync(
  [Buffer.from('ata-parity-owner')],
  Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 8)).publicKey,
);

describe('SAP ATA helper parity with @solana/spl-token', () => {
  it('matches the synchronous library helper and its default program ids', () => {
    const sapAta = getSapAssociatedTokenAddress(MINT, OWNER);
    const libraryAta = getAssociatedTokenAddressSync(
      MINT,
      OWNER,
      false,
      SPL_TOKEN_PROGRAM_ID,
      SPL_ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    expect(TOKEN_PROGRAM_ID.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ASSOCIATED_TOKEN_PROGRAM_ID.equals(SPL_ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(libraryAta.equals(sapAta)).toBe(true);
    expect(deriveUsdcAta(OWNER.toBase58(), MINT.toBase58())).toBe(sapAta.toBase58());
  });

  it('keeps allowOwnerOffCurve=false by default and matches when explicitly enabled', () => {
    expect(() => getSapAssociatedTokenAddress(MINT, PDA_OWNER)).toThrow();
    expect(() => getAssociatedTokenAddressSync(MINT, PDA_OWNER)).toThrow();

    const sapAta = getSapAssociatedTokenAddress(MINT, PDA_OWNER, true);
    const libraryAta = getAssociatedTokenAddressSync(MINT, PDA_OWNER, true);
    expect(libraryAta.equals(sapAta)).toBe(true);
  });
});
