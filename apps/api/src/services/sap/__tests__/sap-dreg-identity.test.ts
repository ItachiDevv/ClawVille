/**
 * Wire-parity pins for the deployed mpl-agent-014 RegisterIdentityV1 path.
 * Pure builders only: no RPC, signer, or DATABASE_URL access.
 */

import { describe, expect, it } from 'bun:test';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  DREG_IDENTITY_PROGRAM_ID,
  MPL_CORE_PROGRAM_ID,
  buildRegisterIdentityV1Instruction,
  encodeRegisterIdentityV1Data,
  findDregIdentityPda,
} from '../sap-dreg-identity';

const GENESIS_ASSET = new PublicKey('8pv2wEMMzhxN51JSsjB4jJM1bjgm8kxZpnA9c2qX3fNX');
const GENESIS_IDENTITY = '5XYgD16jLKWawfxms9NmLguebphQ7oy6uPE2xnm2cLvn';
const GENESIS_OWNER = new PublicKey('24i43XkDyJAJJBi7X3ARRCt3WBh16uJuSfVRLKXVEYBQ');
const GENESIS_URL =
  'https://api.clawville.world/agents/Ep7dD7biX7rZ6NSVzy8uEpgEEYipVfQ8ofwHzZmRM8dF/eip-8004.json';
const GENESIS_DATA_HEX =
  '00000000000000005d00000068747470733a2f2f6170692e636c617776696c6c652e776f726c642f6167656e74732f45703764443762695837725a364e53567a7938754570674545596970566651386f6677487a5a6d524d3864462f6569702d383030342e6a736f6e';

describe('1DREG RegisterIdentityV1 builder', () => {
  it('derives the identity registration PDA pinned by the landed genesis pair', () => {
    expect(findDregIdentityPda(GENESIS_ASSET).toBase58()).toBe(GENESIS_IDENTITY);
  });

  it('pins the genesis 8-zero discriminator plus Borsh string encoding', () => {
    const data = encodeRegisterIdentityV1Data(GENESIS_URL);

    expect(Buffer.byteLength(GENESIS_URL, 'utf8')).toBe(93);
    expect(data.length).toBe(105);
    expect(data.subarray(0, 8)).toEqual(Buffer.alloc(8));
    expect(data.readUInt32LE(8)).toBe(93);
    expect(data.subarray(12).toString('utf8')).toBe(GENESIS_URL);
    expect(data.toString('hex')).toBe(GENESIS_DATA_HEX);
  });

  it('pins account order plus signer and writable flags', () => {
    const { instruction, identityPda } = buildRegisterIdentityV1Instruction({
      asset: GENESIS_ASSET,
      owner: GENESIS_OWNER,
      registrationUrl: GENESIS_URL,
    });

    expect(instruction.programId.equals(DREG_IDENTITY_PROGRAM_ID)).toBe(true);
    expect(instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({
      pubkey: pubkey.toBase58(),
      isSigner,
      isWritable,
    }))).toEqual([
      { pubkey: identityPda.toBase58(), isSigner: false, isWritable: true },
      { pubkey: GENESIS_ASSET.toBase58(), isSigner: true, isWritable: true },
      { pubkey: DREG_IDENTITY_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
      { pubkey: GENESIS_OWNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: DREG_IDENTITY_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    ]);
  });
});
