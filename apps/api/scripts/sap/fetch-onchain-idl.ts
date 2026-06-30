/**
 * Throwaway: fetch the DEPLOYED SAP program's on-chain IDL from devnet and save
 * it next to the vendored repo IDL. The deployed program is the AUTHORITATIVE
 * shape we must build against — the vendored `synapse_agent_sap.idl.json` is the
 * 0.25.0 repo IDL, ahead of what is actually deployed on devnet (0.18.0 per the
 * audit). This proves it and freezes the deployed IDL for the client to load.
 *
 * Run: cd apps/api && bunx tsx scripts/sap/fetch-onchain-idl.ts
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  Connection,
  Keypair,
  PublicKey,
  type Commitment,
} from '@solana/web3.js';
import { AnchorProvider, Program } from '@coral-xyz/anchor';

const PROGRAM_ID = new PublicKey('SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ');
const RPC = process.env.SAP_RPC_URL ?? 'https://api.devnet.solana.com';
const COMMITMENT: Commitment = 'confirmed';

async function main() {
  console.log(`Fetching on-chain IDL for ${PROGRAM_ID.toBase58()} from ${RPC} ...`);
  const connection = new Connection(RPC, COMMITMENT);
  const kp = Keypair.generate();
  const provider = new AnchorProvider(
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      publicKey: kp.publicKey,
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any) => txs,
      payer: kp,
    } as any,
    { commitment: COMMITMENT },
  );

  const idl = await Program.fetchIdl(PROGRAM_ID, provider);
  if (!idl) {
    console.error('No on-chain IDL found for this program on devnet.');
    process.exit(2);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (idl as any).metadata ?? {};
  console.log(`on-chain IDL metadata.version = ${meta.version ?? '(none)'}`);
  console.log(`on-chain IDL metadata.name    = ${meta.name ?? '(none)'}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ixNames = ((idl as any).instructions ?? []).map((i: any) => i.name);
  console.log(`on-chain instructions (${ixNames.length}): ${ixNames.join(', ')}`);

  const out = join(
    __dirname,
    '..',
    '..',
    'src',
    'services',
    'sap',
    'synapse_agent_sap.onchain.idl.json',
  );
  writeFileSync(out, JSON.stringify(idl, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${out}`);
}

main().catch((err) => {
  console.error('fetch-onchain-idl crashed:', err);
  process.exit(1);
});
