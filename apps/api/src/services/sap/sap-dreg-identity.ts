/**
 * Empirically pinned mpl-agent-014 RegisterIdentityV1 wire builder.
 *
 * The deployed MPL Core program rejects a direct AgentIdentity external-adapter
 * add from the owner. The 1DREG registry must own that call and CPI into Core.
 * This account/data shape is pinned to the landed ClawVille genesis devnet tx.
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';

export const DREG_IDENTITY_PROGRAM_ID = new PublicKey(
  '1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p',
);
export const MPL_CORE_PROGRAM_ID = new PublicKey(
  'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
);

const AGENT_IDENTITY_SEED = Buffer.from('agent_identity');
const REGISTER_IDENTITY_V1_DISCRIMINATOR_BYTES = 8;

export function findDregIdentityPda(asset: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [AGENT_IDENTITY_SEED, asset.toBuffer()],
    DREG_IDENTITY_PROGRAM_ID,
  )[0];
}

export function encodeRegisterIdentityV1Data(registrationUrl: string): Buffer {
  const url = Buffer.from(registrationUrl, 'utf8');
  const data = Buffer.alloc(REGISTER_IDENTITY_V1_DISCRIMINATOR_BYTES + 4 + url.length);
  data.writeUInt32LE(url.length, REGISTER_IDENTITY_V1_DISCRIMINATOR_BYTES);
  url.copy(data, REGISTER_IDENTITY_V1_DISCRIMINATOR_BYTES + 4);
  return data;
}

export function buildRegisterIdentityV1Instruction(args: {
  asset: PublicKey;
  owner: PublicKey;
  registrationUrl: string;
}): { instruction: TransactionInstruction; identityPda: PublicKey } {
  const identityPda = findDregIdentityPda(args.asset);
  return {
    identityPda,
    instruction: new TransactionInstruction({
      programId: DREG_IDENTITY_PROGRAM_ID,
      keys: [
        { pubkey: identityPda, isSigner: false, isWritable: true },
        { pubkey: args.asset, isSigner: true, isWritable: true },
        { pubkey: DREG_IDENTITY_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: args.owner, isSigner: true, isWritable: true },
        { pubkey: DREG_IDENTITY_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeRegisterIdentityV1Data(args.registrationUrl),
    }),
  };
}
